// Local Whisper (transformers.js + onnxruntime-node) running in an Electron utility process.
// Input: a recording path. Output: word list [{w, s, e}] in seconds. No Python, no cloud.
import { spawn } from 'node:child_process';

const port = process.parentPort;
let transformers = null;
const pipes = new Map();

async function lib() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = process.env.RMT_MODEL_DIR;
    transformers.env.allowLocalModels = false;
  }
  return transformers;
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.env.RMT_FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { windowsHide: true });
    const chunks = [];
    let err = '';
    c.stdout.on('data', (d) => chunks.push(d));
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => {
      if (code !== 0) return reject(new Error('Could not read audio: ' + err.slice(-400)));
      const buf = Buffer.concat(chunks);
      const copy = new Float32Array(buf.length / 4);
      Buffer.from(copy.buffer).set(buf.subarray(0, copy.length * 4));
      resolve(copy);
    });
  });
}

async function getPipe(model, id) {
  if (pipes.has(model)) return pipes.get(model);
  const { pipeline } = await lib();
  const files = {};
  const p = await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8', device: 'cpu',
    progress_callback: (ev) => {
      if (ev.status === 'progress' && ev.file) {
        files[ev.file] = { loaded: ev.loaded || 0, total: ev.total || 0 };
        const all = Object.values(files);
        const loaded = all.reduce((s, f) => s + f.loaded, 0), total = all.reduce((s, f) => s + f.total, 0);
        port.postMessage({ id, type: 'progress', progress: { stage: 'download', loaded, total } });
      }
    }
  });
  pipes.set(model, p);
  return p;
}

port.on('message', async (e) => {
  const { id, file, model } = e.data;
  try {
    port.postMessage({ id, type: 'progress', progress: { stage: 'decode' } });
    const pcm = await decode(file);
    const duration = pcm.length / 16000;
    if (duration < 0.3) { port.postMessage({ id, type: 'done', result: { words: [], text: '', duration } }); return; }
    port.postMessage({ id, type: 'progress', progress: { stage: 'load' } });
    const asr = await getPipe(model, id);
    port.postMessage({ id, type: 'progress', progress: { stage: 'transcribe', duration } });
    const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
    if (!/\.en$/.test(model)) { opts.language = 'english'; opts.task = 'transcribe'; }
    const out = await asr(pcm, opts);
    const words = (out.chunks || [])
      .map((c) => ({ w: String(c.text || '').trim(), s: Number(c.timestamp?.[0] ?? 0), e: Number(c.timestamp?.[1] ?? c.timestamp?.[0] ?? 0) }))
      .filter((x) => x.w && isFinite(x.s))
      .map((x) => ({ ...x, e: isFinite(x.e) && x.e > x.s ? x.e : x.s + 0.25 }));
    port.postMessage({ id, type: 'done', result: { words, text: String(out.text || '').trim(), duration, model } });
  } catch (err) {
    port.postMessage({ id, type: 'error', error: String(err?.message || err) });
  }
});
