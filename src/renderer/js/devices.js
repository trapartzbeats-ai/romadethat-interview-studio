// Camera + microphone, level metering and the pre-flight readings (light, levels, room noise).
import { prefs } from './store.js';

export const dev = {
  cam: null, mic: null, ctx: null, analyser: null, gain: null, dest: null,
  level: 0, levelDb: -90, peakHoldDb: -90, recentPeakDb: -90, noiseDb: -90, clipAt: 0,
  luma: null, camInfo: null,
  history: [], // [time, rmsDb, peakDb]
  listeners: new Set()
};
const video = () => document.getElementById('camVideo');
const stop = (s) => s?.getTracks().forEach((t) => t.stop());

export async function listDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { cams: [], mics: [], outs: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cams: all.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` })),
    mics: all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
    outs: all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }))
  };
}

export async function connect() {
  stop(dev.cam); stop(dev.mic);
  dev.cam = dev.mic = null;
  const q = prefs.quality === '720' ? { w: 1280, h: 720 } : prefs.quality === '2160' ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 };
  const vc = { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30 } };
  if (prefs.camera) vc.deviceId = { exact: prefs.camera };
  try { dev.cam = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false }); }
  catch (e) { if (prefs.camera) { prefs.camera = ''; delete vc.deviceId; dev.cam = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false }); } else throw e; }
  dev.mic = await openMic(prefs.mic);
  const v = video();
  v.srcObject = dev.cam;
  await v.play().catch(() => {});
  const s = dev.cam.getVideoTracks()[0].getSettings();
  dev.camInfo = { width: s.width, height: s.height, fps: Math.round(s.frameRate || 30), label: dev.cam.getVideoTracks()[0].label };
  wireAudio();
  return dev;
}

export async function openMic(id) {
  const ac = { echoCancellation: false, noiseSuppression: !!prefs.noiseSuppression, autoGainControl: !!prefs.autoGain, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } };
  if (id) ac.deviceId = { exact: id };
  try { return await navigator.mediaDevices.getUserMedia({ audio: ac, video: false }); }
  catch (e) { if (id) { delete ac.deviceId; return navigator.mediaDevices.getUserMedia({ audio: ac, video: false }); } throw e; }
}

function wireAudio() {
  if (dev.ctx) dev.ctx.close().catch(() => {});
  dev.ctx = new AudioContext({ sampleRate: 48000 });
  const src = dev.ctx.createMediaStreamSource(dev.mic);
  dev.analyser = dev.ctx.createAnalyser();
  dev.analyser.fftSize = 2048;
  dev.gain = dev.ctx.createGain();
  dev.dest = dev.ctx.createMediaStreamDestination();
  src.connect(dev.analyser);
  src.connect(dev.gain);
  dev.gain.connect(dev.dest);
  dev.ctx.resume();
  dev.history = [];
}

const buf = new Float32Array(2048);
const lumaCanvas = document.createElement('canvas');
lumaCanvas.width = 32; lumaCanvas.height = 18;
const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });
let lastLuma = 0;

// Called every animation frame.
export function sample(now) {
  if (dev.analyser) {
    dev.analyser.getFloatTimeDomainData(buf);
    let sum = 0, peak = 0;
    for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
    const rms = Math.sqrt(sum / buf.length);
    dev.levelDb = 20 * Math.log10(rms + 1e-9);
    const pDb = 20 * Math.log10(peak + 1e-9);
    if (pDb > -1) dev.clipAt = now;
    dev.level = Math.max(0, Math.min(1, (dev.levelDb + 60) / 60));
    dev.peakHoldDb = Math.max(pDb, dev.peakHoldDb - 0.6);
    dev.history.push([now, dev.levelDb, pDb]);
    while (dev.history.length && now - dev.history[0][0] > 6000) dev.history.shift();
    if (dev.history.length > 30) {
      const sorted = dev.history.map((h) => h[1]).sort((a, b) => a - b);
      dev.noiseDb = sorted[Math.floor(sorted.length * 0.1)];
      dev.recentPeakDb = Math.max(...dev.history.map((h) => h[2]));
    }
  }
  const v = video();
  if (v?.readyState >= 2 && now - lastLuma > 500) {
    lastLuma = now;
    lumaCtx.drawImage(v, 0, 0, 32, 18);
    const d = lumaCtx.getImageData(0, 0, 32, 18).data;
    let l = 0;
    for (let i = 0; i < d.length; i += 4) l += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    dev.luma = l / (d.length / 4);
  }
}

export function isSpeaking() { return dev.levelDb > Math.max(-48, dev.noiseDb + 9); }

// Ready check rows: {key, label, state: ok|warn|bad|idle, detail}
export function readiness({ freeBytes, voiceCount, questionCount, guestOpen }) {
  const rows = [];
  if (!dev.cam) rows.push({ key: 'cam', label: 'Camera', state: 'bad', detail: 'Not connected' });
  else {
    const i = dev.camInfo || {};
    rows.push({ key: 'cam', label: 'Camera', state: (i.height || 0) >= 1080 ? 'ok' : (i.height || 0) >= 720 ? 'warn' : 'bad', detail: `${i.width}×${i.height} @ ${i.fps}fps` });
  }
  if (dev.luma == null) rows.push({ key: 'light', label: 'Lighting', state: 'idle', detail: 'Waiting for camera' });
  else rows.push({ key: 'light', label: 'Lighting', state: dev.luma < 55 ? 'bad' : dev.luma < 80 ? 'warn' : dev.luma > 205 ? 'warn' : 'ok', detail: dev.luma < 55 ? 'Too dark — add a key light' : dev.luma < 80 ? 'A little dark' : dev.luma > 205 ? 'Very bright — check exposure' : 'Good exposure' });
  if (!dev.mic) rows.push({ key: 'mic', label: 'Mic level', state: 'bad', detail: 'Not connected' });
  else {
    const p = dev.recentPeakDb;
    const clipped = performance.now() - dev.clipAt < 6000;
    rows.push({ key: 'mic', label: 'Mic level', state: clipped ? 'bad' : p < -40 ? 'idle' : p < -24 ? 'warn' : 'ok', detail: clipped ? 'Clipping — turn the input gain down' : p < -40 ? 'Say a few words to test' : p < -24 ? `Quiet (peaks ${p.toFixed(0)} dB) — move closer` : `Peaks ${p.toFixed(0)} dB` });
    const n = dev.noiseDb;
    rows.push({ key: 'room', label: 'Room noise', state: n < -55 ? 'ok' : n < -42 ? 'warn' : 'bad', detail: `${n.toFixed(0)} dB floor${n >= -42 ? ' — noisy, find a quieter spot' : ''}` });
  }
  if (freeBytes != null) { const gb = freeBytes / 1e9; rows.push({ key: 'disk', label: 'Disk space', state: gb > 10 ? 'ok' : gb > 3 ? 'warn' : 'bad', detail: `${gb.toFixed(1)} GB free (~${Math.floor((gb * 1e9) / (8e6 / 8) / 60)} min of 1080p)` }); }
  rows.push({ key: 'voice', label: 'Question voice', state: voiceCount >= questionCount ? 'ok' : voiceCount ? 'warn' : 'idle', detail: `${voiceCount}/${questionCount} questions recorded` });
  rows.push({ key: 'guest', label: 'Guest screen', state: guestOpen ? 'ok' : 'idle', detail: guestOpen ? 'Open' : 'Optional — show questions to your guest' });
  return rows;
}

export function disconnect() { stop(dev.cam); stop(dev.mic); dev.cam = dev.mic = null; if (dev.ctx) dev.ctx.close().catch(() => {}); dev.ctx = null; dev.analyser = null; dev.dest = null; }
