'use strict';
// ffmpeg work: finalize recordings, analyse audio (peaks, speech bounds, levels), and render exports.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function ffmpegPath() {
  let p = require('ffmpeg-static');
  if (p && p.includes('app.asar') && !p.includes('app.asar.unpacked')) p = p.replace('app.asar', 'app.asar.unpacked');
  return p;
}

function run(args, { cwd, onProgress, signal, maxOut = 1 << 30, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { cwd, windowsHide: true });
    const out = [];
    let outLen = 0;
    let err = '';
    let progressBuf = '';
    if (signal) signal.child = child;
    child.stdout.on('data', (d) => {
      if (onProgress) {
        progressBuf += d.toString();
        let i;
        while ((i = progressBuf.indexOf('\n')) >= 0) {
          const line = progressBuf.slice(0, i).trim();
          progressBuf = progressBuf.slice(i + 1);
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
          if (m) onProgress(Number(m[1]) / 1e6);
        }
      } else if (outLen < maxOut) { out.push(d); outLen += d.length; }
    });
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 400000) err = err.slice(-200000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (signal) signal.child = null;
      if (signal?.cancelled) return reject(new Error('Export cancelled'));
      if (code === 0) resolve({ stdout: binary ? Buffer.concat(out) : Buffer.concat(out).toString(), stderr: err });
      else reject(new Error(`ffmpeg failed (${code}): ${err.trim().split('\n').slice(-6).join('\n')}`));
    });
  });
}

function parseProbe(stderr) {
  const info = { duration: 0, video: null, audio: null };
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (d) info.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const v = /Stream #\S+.*?: Video: (\w+)[^\n]*?, (\d{2,5})x(\d{2,5})/.exec(stderr);
  if (v) info.video = { codec: v[1], width: Number(v[2]), height: Number(v[3]) };
  const a = /Stream #\S+.*?: Audio: (\w+)/.exec(stderr);
  if (a) info.audio = { codec: a[1] };
  return info;
}

async function probe(file) {
  // ffmpeg exits 1 with no output file; we only need the header dump.
  const stderr = await new Promise((resolve) => {
    const c = spawn(ffmpegPath(), ['-hide_banner', '-i', file], { windowsHide: true });
    let e = '';
    c.stderr.on('data', (d) => { e += d; });
    c.on('close', () => resolve(e));
    c.on('error', () => resolve(''));
  });
  return parseProbe(stderr);
}

// Decode audio to 8 kHz mono and derive everything the UI needs.
async function analyze(file) {
  const rate = 8000;
  const { stdout } = await run(['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { binary: true });
  const samples = new Int16Array(stdout.buffer, stdout.byteOffset, Math.floor(stdout.length / 2));
  const win = rate / 100; // 10 ms windows -> 100 peaks per second
  const n = Math.ceil(samples.length / win);
  const peaks = new Uint8Array(n);
  const rmsDb = new Float32Array(n);
  let globalPeak = 0;
  for (let i = 0; i < n; i++) {
    let max = 0, sum = 0;
    const s0 = i * win, s1 = Math.min(samples.length, s0 + win);
    for (let j = s0; j < s1; j++) { const v = Math.abs(samples[j]); if (v > max) max = v; sum += samples[j] * samples[j]; }
    const len = Math.max(1, s1 - s0);
    if (max > globalPeak) globalPeak = max;
    peaks[i] = Math.min(255, Math.round(Math.sqrt(max / 32768) * 255));
    rmsDb[i] = 20 * Math.log10(Math.sqrt(sum / len) / 32768 + 1e-9);
  }
  const sorted = Array.from(rmsDb).sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : -90);
  const noiseDb = pct(0.1);
  const speechDb = pct(0.9);
  const threshold = Math.max(-48, Math.min(noiseDb + 12, speechDb - 18));
  // speech bounds: require 60 ms of sustained level to ignore clicks
  let speechStart = null, speechEnd = null, run6 = 0;
  for (let i = 0; i < n; i++) { if (rmsDb[i] > threshold) { if (++run6 >= 6) { speechStart = (i - 5) / 100; break; } } else run6 = 0; }
  run6 = 0;
  for (let i = n - 1; i >= 0; i--) { if (rmsDb[i] > threshold) { if (++run6 >= 6) { speechEnd = (i + 6) / 100; break; } } else run6 = 0; }
  const peaksFile = file + '.peaks';
  await fsp.writeFile(peaksFile, Buffer.from(peaks.buffer));
  const info = await probe(file);
  const duration = info.duration || samples.length / rate;
  return {
    duration, peaksFile, video: info.video, audio: info.audio,
    speechStart: speechStart == null ? 0 : Math.max(0, speechStart),
    speechEnd: speechEnd == null ? duration : Math.min(duration, speechEnd),
    peakDb: 20 * Math.log10(globalPeak / 32768 + 1e-9), noiseDb, speechDb
  };
}

async function finalizeRecording(partPath, options = {}) {
  const info = await probe(partPath);
  const base = partPath.replace(/\.part\.\w+$/, '').replace(/\.\w+$/, '');
  const ext = info.video ? (/h264|avc/i.test(info.video.codec) ? '.mp4' : '.webm') : '.webm';
  const out = base + ext;
  const args = ['-y', '-v', 'error', '-fflags', '+genpts', '-i', partPath, '-c', 'copy'];
  if (ext === '.mp4') args.push('-movflags', '+faststart');
  args.push(out);
  try {
    await run(args);
    await fsp.rm(partPath, { force: true });
  } catch (e) {
    // Remux failed: keep the raw file so nothing is lost.
    await fsp.rename(partPath, out).catch(() => {});
  }
  const analysis = await analyze(out);
  return { file: out, ...analysis, kind: options.kind || 'take' };
}

// ---------------------------------------------------------------- export
const n3 = (x) => Number(x).toFixed(3);

async function measureLoudness(file, start, end, signal) {
  const args = ['-hide_banner', '-nostats'];
  if (start > 0) args.push('-ss', n3(start));
  if (end) args.push('-to', n3(end));
  args.push('-i', file, '-vn', '-af', 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-');
  try {
    const { stderr } = await run(args, { signal });
    const j = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
    if (!isFinite(Number(j.input_i)) || Number(j.input_i) < -70) return null;
    return j;
  } catch (e) { if (signal?.cancelled) throw e; return null; }
}

function cleanChain(audio, m) {
  const parts = ['highpass=f=80'];
  if (audio.denoise) parts.push('afftdn=nr=10:nf=-42');
  if (audio.normalize !== false) {
    if (m) parts.push(`loudnorm=I=${audio.lufs || -16}:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`);
    else parts.push(`loudnorm=I=${audio.lufs || -16}:TP=-1.5:LRA=11`);
  }
  parts.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');
  return parts.join(',');
}

const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart'];

async function cardSegment(seg, plan, out, signal, prog) {
  const D = seg.duration;
  const args = ['-y', '-hide_banner', '-progress', 'pipe:1', '-nostats', '-loop', '1', '-framerate', '30', '-t', n3(D), '-i', seg.png];
  let afilter;
  if (seg.voice && seg.voice.file) {
    const v = seg.voice;
    const m = plan.audio.normalize !== false ? await measureLoudness(v.file, v.start, v.end, signal) : null;
    if (v.start > 0) args.push('-ss', n3(v.start));
    if (v.end) args.push('-to', n3(v.end));
    args.push('-i', v.file);
    const delay = Math.round((v.delay || 0) * 1000);
    afilter = `[1:a]${cleanChain(plan.audio, m)},afade=t=in:d=0.03,adelay=${delay}|${delay},apad,atrim=0:${n3(D)}[a]`;
  } else {
    args.push('-f', 'lavfi', '-t', n3(D), '-i', 'anullsrc=r=48000:cl=stereo');
    afilter = `[1:a]atrim=0:${n3(D)}[a]`;
  }
  const fi = seg.fadeIn ?? 0.25, fo = seg.fadeOut ?? 0.25;
  const vf = `[0:v]format=yuv420p${fi ? `,fade=t=in:st=0:d=${fi}` : ''}${fo ? `,fade=t=out:st=${n3(Math.max(0, D - fo))}:d=${fo}` : ''}[v]`;
  args.push('-filter_complex', `${vf};${afilter}`, '-map', '[v]', '-map', '[a]', '-t', n3(D), ...ENC, out);
  await run(args, { cwd: plan.buildDir, signal, onProgress: prog });
}

async function answerSegment(seg, plan, out, signal, prog) {
  const W = plan.width, H = plan.height;
  const ranges = seg.ranges.filter((r) => r[1] - r[0] > 0.04);
  if (!ranges.length) throw new Error(`"${seg.label}" has nothing left after trimming`);
  const D = ranges.reduce((s, r) => s + (r[1] - r[0]), 0);
  const ss = Math.max(0, ranges[0][0] - 1.5);
  const to = ranges[ranges.length - 1][1] + 0.5;
  const m = plan.audio.normalize !== false ? await measureLoudness(seg.file, ranges[0][0], ranges[ranges.length - 1][1], signal) : null;
  const args = ['-y', '-hide_banner', '-progress', 'pipe:1', '-nostats'];
  if (ss > 0) args.push('-ss', n3(ss));
  args.push('-to', n3(to), '-i', seg.file);
  let idx = 1;
  const loopIn = (png) => { args.push('-loop', '1', '-framerate', '30', '-t', n3(D), '-i', png); return idx++; };
  const f = [];
  // cut + join ranges (text-based edits remove words by leaving gaps between ranges)
  const N = ranges.length;
  f.push(`[0:v]fps=30,split=${N}${ranges.map((_, i) => `[vs${i}]`).join('')}`);
  f.push(`[0:a]aresample=48000,asplit=${N}${ranges.map((_, i) => `[as${i}]`).join('')}`);
  ranges.forEach((r, i) => {
    const a = r[0] - ss, b = r[1] - ss, len = b - a;
    const fd = Math.min(0.015, len / 4);
    f.push(`[vs${i}]trim=start=${n3(a)}:end=${n3(b)},setpts=PTS-STARTPTS[vt${i}]`);
    f.push(`[as${i}]atrim=start=${n3(a)}:end=${n3(b)},asetpts=PTS-STARTPTS,afade=t=in:d=${n3(fd)},afade=t=out:st=${n3(Math.max(0, len - fd))}:d=${n3(fd)}[at${i}]`);
  });
  f.push(`${ranges.map((_, i) => `[vt${i}][at${i}]`).join('')}concat=n=${N}:v=1:a=1[cv][ca]`);
  const c = seg.cam;
  const cw = Math.round(c.w / 2) * 2, ch = Math.round(c.h / 2) * 2;
  const crop = `scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}:(iw-ow)*${n3(c.cropX ?? 0.5)}:(ih-oh)*${n3(c.cropY ?? 0.5)},setsar=1`;
  const flip = seg.mirror ? 'hflip,' : '';
  if (seg.bg) {
    const bgI = loopIn(seg.bg);
    f.push(`[cv]${flip}${crop},format=rgba[cam0]`);
    if (seg.mask) {
      const mI = loopIn(seg.mask);
      f.push(`[${mI}:v]format=gray,scale=${cw}:${ch}[mask]`, `[cam0][mask]alphamerge[cam]`);
    } else f.push('[cam0]null[cam]');
    f.push(`[${bgI}:v]format=rgba,scale=${W}:${H}[bg]`, `[bg][cam]overlay=${Math.round(c.x)}:${Math.round(c.y)}:format=auto[base0]`);
  } else {
    f.push(`[cv]${flip}${crop},format=rgba[base0]`);
  }
  let base = 'base0';
  (seg.overlays || []).forEach((o, i) => {
    const oI = loopIn(o.png);
    const fades = [];
    if (o.fade && o.start != null) fades.push(`fade=t=in:st=${n3(o.start)}:d=${o.fade}:alpha=1`);
    if (o.fade && o.end != null) fades.push(`fade=t=out:st=${n3(Math.max(0, o.end - o.fade))}:d=${o.fade}:alpha=1`);
    f.push(`[${oI}:v]format=rgba${fades.length ? ',' + fades.join(',') : ''}[ov${i}]`);
    const en = !o.fade && o.start != null ? `:enable='between(t,${n3(o.start)},${n3(o.end ?? D)})'` : '';
    f.push(`[${base}][ov${i}]overlay=0:0:format=auto${en}[b${i}]`);
    base = `b${i}`;
  });
  const fi = seg.fadeIn ?? 0.2, fo = seg.fadeOut ?? 0.2;
  const ass = seg.ass ? `,ass=${seg.ass}:fontsdir=fonts` : '';
  f.push(`[${base}]format=yuv420p${ass}${fi ? `,fade=t=in:st=0:d=${fi}` : ''}${fo ? `,fade=t=out:st=${n3(Math.max(0, D - fo))}:d=${fo}` : ''}[v]`);
  f.push(`[ca]${cleanChain(plan.audio, m)},apad,atrim=0:${n3(D)}[a]`);
  args.push('-filter_complex', f.join(';'), '-map', '[v]', '-map', '[a]', '-t', n3(D), ...ENC, out);
  await run(args, { cwd: plan.buildDir, signal, onProgress: prog });
  return D;
}

async function concatFiles(files, out, cwd, signal) {
  const list = path.join(cwd, `concat-${Date.now()}.txt`);
  await fsp.writeFile(list, files.map((f) => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  try { await run(['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], { cwd, signal }); }
  finally { await fsp.rm(list, { force: true }); }
}

function musicExpr(windows, cardsVol, answersVol) {
  const r = 0.5;
  if (!windows.length) return String(answersVol);
  const terms = windows.map(([a, b]) => `clip(min((t-${n3(a - r)})/${r},(${n3(b + r)}-t)/${r}),0,1)`);
  return `${answersVol}+(${cardsVol}-${answersVol})*clip(${terms.join('+')},0,1)`;
}

function runExport(plan, report) {
  const signal = { cancelled: false, child: null };
  const promise = (async () => {
    await fsp.mkdir(plan.buildDir, { recursive: true });
    await fsp.mkdir(path.dirname(plan.outFile), { recursive: true });
    if (plan.fontsDir) {
      await fsp.mkdir(path.join(plan.buildDir, 'fonts'), { recursive: true });
      for (const f of await fsp.readdir(plan.fontsDir)) if (/\.(ttf|otf)$/i.test(f)) await fsp.writeFile(path.join(plan.buildDir, 'fonts', f), await fsp.readFile(path.join(plan.fontsDir, f)));
    }
    const total = plan.segments.reduce((s, x) => s + x.duration, 0) || 1;
    let done = 0;
    const files = [];
    const segFiles = {};
    for (let i = 0; i < plan.segments.length; i++) {
      if (signal.cancelled) throw new Error('Export cancelled');
      const seg = plan.segments[i];
      const out = path.join(plan.buildDir, `seg-${String(i).padStart(3, '0')}.mp4`);
      report({ stage: 'segment', label: seg.label, index: i, count: plan.segments.length, progress: done / total });
      const prog = (t) => report({ stage: 'segment', label: seg.label, index: i, count: plan.segments.length, progress: Math.min(1, (done + Math.min(t, seg.duration)) / total) });
      if (seg.kind === 'card') await cardSegment(seg, plan, out, signal, prog);
      else await answerSegment(seg, plan, out, signal, prog);
      done += seg.duration;
      files.push(out);
      segFiles[seg.id] = out;
    }
    report({ stage: 'join', label: 'Joining the program', progress: 0.97 });
    const joined = plan.music?.file ? path.join(plan.buildDir, 'program-nomusic.mp4') : plan.outFile;
    await concatFiles(files, joined, plan.buildDir, signal);
    if (plan.music?.file) {
      report({ stage: 'music', label: 'Mixing music bed', progress: 0.985 });
      const T = total;
      const expr = musicExpr(plan.music.windows || [], plan.music.cardsVol, plan.music.answersVol);
      const fo = Math.min(3, T / 4);
      await run(['-y', '-v', 'error', '-i', joined, '-stream_loop', '-1', '-i', plan.music.file, '-filter_complex',
        `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume='${expr}':eval=frame,afade=t=in:d=1.2,afade=t=out:st=${n3(T - fo)}:d=${n3(fo)},atrim=0:${n3(T)}[m];[0:a][m]amix=inputs=2:duration=first:normalize=0:dropout_transition=0,alimiter=limit=0.95[a]`,
        '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', n3(T), '-movflags', '+faststart', plan.outFile], { cwd: plan.buildDir, signal });
    }
    const clips = [];
    if (plan.clips?.length && plan.clipsDir) {
      await fsp.mkdir(plan.clipsDir, { recursive: true });
      for (const c of plan.clips) {
        if (signal.cancelled) throw new Error('Export cancelled');
        const parts = c.segmentIds.map((id) => segFiles[id]).filter(Boolean);
        if (!parts.length) continue;
        const out = path.join(plan.clipsDir, c.name);
        report({ stage: 'clips', label: 'Clip ' + c.name, progress: 0.99 });
        await concatFiles(parts, out, plan.buildDir, signal);
        clips.push(out);
      }
    }
    if (!plan.keepBuild) await fsp.rm(plan.buildDir, { recursive: true, force: true }).catch(() => {});
    report({ stage: 'done', label: 'Done', progress: 1 });
    return { outFile: plan.outFile, clips, duration: total };
  })();
  return { promise, cancel: () => { signal.cancelled = true; try { signal.child?.kill(); } catch {} } };
}

module.exports = { ffmpegPath, probe, analyze, finalizeRecording, runExport, musicExpr };
