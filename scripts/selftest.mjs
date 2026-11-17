// End-to-end self test: launches the real app with a fake camera + mic (Chromium test devices),
// creates a project in a temp folder, records a question voice and answer takes, transcribes,
// cuts the fillers, exports 16:9 + 9:16 and checks the files. Screenshots go to <work>/shots.
//
//   node scripts/selftest.mjs <workDir> <fake-cam.y4m> <fake-audio.wav>
//
// Nothing touches your real Documents folder or app profile (RMT_USER_DATA / RMT_PROJECTS_DIR).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1')), '..');
const [work = path.join(root, '.selftest'), cam, mic] = process.argv.slice(2);
const shots = path.join(work, 'shots');
fs.mkdirSync(shots, { recursive: true });
const projects = path.join(work, 'projects');
fs.rmSync(projects, { recursive: true, force: true });
fs.mkdirSync(projects, { recursive: true });
const PORT = 9400 + Math.floor(Math.random() * 400);
const electron = require('electron');
const args = [root, `--remote-debugging-port=${PORT}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (cam) args.push(`--use-file-for-fake-video-capture=${cam}`);
if (mic) args.push(`--use-file-for-fake-audio-capture=${mic}`);
// RMT_APP_EXE=<path to the packaged app> tests a built install instead of the source tree.
if (process.env.RMT_APP_EXE) args.shift();
const child = spawn(process.env.RMT_APP_EXE || electron, args, { env: { ...process.env, RMT_USER_DATA: path.join(work, 'userdata'), RMT_PROJECTS_DIR: projects }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function target() {
  for (let i = 0; i < 60; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); const t = list.find((x) => x.type === 'page' && x.url.includes('index.html')); if (t) return t; } catch {}
    await sleep(500);
  }
  throw new Error('app did not open a debuggable window');
}
let ws, seq = 0;
const pending = new Map();
function send(method, params = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { res, rej })); }
async function ev(expr, timeout = 600000) {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, timeout });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function shot(name) { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.data, 'base64')); }
async function waitFor(expr, ms = 60000, every = 250) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(`return !!(${expr})`)) return true; await sleep(every); } return false; }

try {
  const t = await target();
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (m) => { const d = JSON.parse(m.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); } };
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 960, deviceScaleFactor: 1, mobile: false });
  await waitFor('window.__rmt', 20000);
  await sleep(800);
  await shot('01-start');

  // project
  await ev(`const {newProject}=await import('./js/store.js'); const d=newProject({title:'Selftest Interview',guest:'Ro',role:'Creator · RoMadeThat',sample:true}); const dir=await studio.project.create('Selftest Interview',d); await __rmt.openProject(dir); return dir;`);
  check('project created and opened', await waitFor('__rmt.store.dir && !document.getElementById("studio").hidden', 10000));
  check('camera + mic connected', await waitFor('__rmt.dev.cam && __rmt.dev.dest', 20000));
  await ev(`const p=__rmt.store.data; p.record.countdown=3; p.record.cardSeconds=2; p.look.layout='framed'; __rmt.store.change('all'); return 1`);
  await sleep(1500);
  await shot('02-studio-live');

  // question voice via batch recorder
  await ev(`__rmt.setPanel('voice'); __rmt.openBatch(0); await __rmt.batchKey(' '); return 1`);
  await sleep(4500);
  await shot('03-voice-batch');
  await ev(`await __rmt.batchKey(' '); return 1`);
  check('question voice saved', await waitFor('__rmt.store.data.questions[0].voice', 20000));
  const voice = await ev(`return __rmt.store.data.questions[0].voice`);
  check('voice trimmed to speech', voice && voice.out > voice.in && voice.duration > 1, JSON.stringify(voice && { d: +voice.duration.toFixed(2), in: +voice.in.toFixed(2), out: +voice.out.toFixed(2) }));
  await ev(`await __rmt.batchKey('Escape'); return 1`);

  // answer take for Q1 (card -> voice -> countdown -> answer)
  await ev(`__rmt.setPanel('questions'); __rmt.beginQuestion(0); return 1`);
  check('asks the question (card + voice)', await waitFor('__rmt.sess.phase==="ask"', 3000));
  await sleep(600);
  await shot('04-asking-card');
  // guest screen: open it and capture what the guest sees while the question plays
  await ev(`document.getElementById('guestBtn').click(); return 1`);
  await sleep(2500);
  try {
    const g = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.url.includes('guest.html'));
    check('guest screen opened', !!g);
    if (g) {
      const gws = new WebSocket(g.webSocketDebuggerUrl);
      await new Promise((r) => (gws.onopen = r));
      const r = await new Promise((res) => { gws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result); }; gws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
      fs.writeFileSync(path.join(shots, '04b-guest-screen.png'), Buffer.from(r.data, 'base64'));
      gws.close();
    }
  } catch (e) { check('guest screen opened', false, e.message); }
  check('moves to countdown after the voice', await waitFor('__rmt.sess.phase==="countdown" || __rmt.sess.phase==="answer"', 15000));
  await sleep(1200);
  await shot('05-countdown');
  check('answer phase starts', await waitFor('__rmt.sess.phase==="answer"', 8000));
  await sleep(9000);
  await shot('06-recording-answer');
  try {
    const g = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((x) => x.url.includes('guest.html'));
    const gws = new WebSocket(g.webSocketDebuggerUrl);
    await new Promise((r) => (gws.onopen = r));
    const r = await new Promise((res) => { gws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) res(d.result); }; gws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
    fs.writeFileSync(path.join(shots, '06b-guest-prompter.png'), Buffer.from(r.data, 'base64'));
    gws.close();
  } catch {}
  await ev(`await __rmt.finishTake('stay'); return 1`);
  check('take saved', await waitFor('__rmt.sess.phase==="idle" && __rmt.store.data.questions[0].takes.length===1', 30000));
  const take = await ev(`const t=__rmt.store.data.questions[0].takes[0]; return {d:t.duration,in:t.in,out:t.out,w:t.width,h:t.height,codec:t.codec,file:t.file,poster:t.poster}`);
  check('take has duration + in/out', take.d > 8 && take.out > take.in, JSON.stringify(take));

  // second question: record two takes, keep the second
  await ev(`__rmt.store.data.questions[1].voice=null; __rmt.beginQuestion(1); return 1`);
  await waitFor('__rmt.sess.phase==="answer"', 15000);
  await sleep(4000);
  await ev(`await __rmt.finishTake('retake'); return 1`);
  await waitFor('__rmt.sess.phase==="answer" && __rmt.store.data.questions[1].takes.length===1', 20000);
  await sleep(8500);
  await ev(`await __rmt.finishTake('stay'); return 1`);
  check('retake keeps both takes', await waitFor('__rmt.sess.phase==="idle" && __rmt.store.data.questions[1].takes.length===2', 30000));

  // transcription (auto on)
  const t0 = Date.now();
  const transcribed = await waitFor('__rmt.store.data.questions[0].takes[0].transcript && __rmt.store.data.questions[1].takes[1].transcript', 900000, 1000);
  const words = await ev(`return (__rmt.store.data.questions[0].takes[0].transcript?.words||[]).map(w=>w.w).join(' ')`);
  check('local Whisper transcribed the takes', transcribed && words.length > 20, `${((Date.now() - t0) / 1000).toFixed(0)}s · "${words.slice(0, 90)}…"`);

  // text edit: remove fillers
  const cut = await ev(`const {fillerCuts,mergeRanges,keptRanges,rangesDuration,isFiller}=await import('./js/timeline.js'); const t=__rmt.store.data.questions.flatMap(q=>q.takes).find(x=>x.transcript?.words.some(w=>isFiller(w.w)))||__rmt.store.data.questions[0].takes[0]; const before=rangesDuration(keptRanges(t)); const c=fillerCuts(t); t.cuts=mergeRanges([...(t.cuts||[]),...c]); __rmt.store.change('takes'); return {n:c.length,before,after:rangesDuration(keptRanges(t))}`);
  check('filler words found and cut', cut.n === 0 ? true : cut.after < cut.before, JSON.stringify(cut) + (cut.n === 0 ? ' (no fillers in these takes)' : ''));
  await ev(`__rmt.selectQuestion(0,'take'); __rmt.setDock('edit'); return 1`);
  await sleep(1500);
  await shot('07-edit-take');
  await ev(`__rmt.setDock('takes'); __rmt.selectQuestion(1,'take'); return 1`);
  await sleep(800);
  await shot('08-takes');

  // program preview
  await ev(`__rmt.startProgram(); return 1`);
  await sleep(2500);
  await shot('09-program-preview');
  await ev(`__rmt.stopProgram(); return 1`);

  // export: 16:9 framed + 9:16, captions, clips, docs, music off
  const exp = await ev(`
    const p=__rmt.store.data; p.captions.burn=true; p.questions.forEach((q,i)=>q.include=i<2);
    const prog=__rmt.buildProgram();
    const a=await __rmt.exportFormat('16:9',prog,{clips:true,burn:true,docs:true,music:false},'Selftest 16x9','x');
    p.look.layout='full';
    const b=await __rmt.exportFormat('9:16',prog,{clips:false,burn:true,docs:false,music:false},'Selftest 9x16','x');
    return {a,b,dur:prog.duration,segs:prog.segs.length};`, 1800000);
  check('16:9 export written', exp.a?.outFile && exp.a.clips?.length === 2, JSON.stringify({ file: exp.a?.outFile, clips: exp.a?.clips?.length, dur: exp.dur }));
  check('9:16 export written', !!exp.b?.outFile);
  fs.writeFileSync(path.join(work, 'export.json'), JSON.stringify(exp, null, 2));
  await shot('10-after-export');
} catch (e) {
  check('selftest crashed', false, e.stack || e.message);
} finally {
  try { ws?.close(); } catch {}
  child.kill();
  fs.writeFileSync(path.join(work, 'app.log'), log);
  fs.writeFileSync(path.join(work, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed · shots in ${shots}`);
  process.exit(failed ? 1 : 0);
}
