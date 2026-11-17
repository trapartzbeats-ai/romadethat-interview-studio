// RoMadeThat Interview Studio — renderer orchestration.
import { $, $$, uid, clamp, pad2, fmtTime, esc, mediaUrl, store, prefs, savePrefs, toast, newProject, newQuestion, parseScript } from './store.js';
import { STYLES, accentOf, drawCard, drawCamera, drawFrameBg, drawMask, drawLowerThird, drawBug, drawCaption, drawGuides, camRect, captionGeo, canvasPng, logoReady, fontRatios } from './draw.js';
import { dev, connect, listDevices, openMic, sample, isSpeaking, readiness } from './devices.js';
import { DiskRecorder, pickAudioMime, pickVideoMime } from './recorder.js';
import { keptRanges, rangesDuration, mapTime, outputWords, isFiller, fillerCuts, pauseCuts, autoTrim, mergeRanges, buildProgram, buildAss, programDocs, voiceLen, takeBounds } from './timeline.js';

const S = window.studio;
let INFO = { platform: 'win32' };
const ASPECTS = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
const PREVIEW = { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [960, 960] };
const ui = { qi: 0, view: 'live', cardKind: null, sel: null, anchor: null, dirtyStrip: true, guestOpen: false, freeBytes: null, prompterOffset: 0, lastSpeak: 0 };
const sess = { phase: 'idle', qi: 0, rec: null, t0: 0, askUntil: 0, countEnd: 0, goUntil: 0, countLen: 0, recStartAt: 0 };
const screen = $('#screen');
const sctx = screen.getContext('2d');
const camVideo = $('#camVideo'), takeVideo = $('#takeVideo'), voiceAudio = $('#voiceAudio'), musicAudio = $('#musicAudio');
const guest = new BroadcastChannel('rmt-guest');
const P = () => store.data;
const curQ = () => P()?.questions[ui.qi];

// ============================================================ boot
(async function boot() {
  try { INFO = await S.info(); } catch {}
  document.body.classList.add('os-' + INFO.platform);
  await Promise.all(['64px Anton', '600 20px Inter', '800 20px Inter', '600 12px "JetBrains Mono"', '500 40px "Playfair Display"'].map((f) => document.fonts.load(f).catch(() => {})));
  renderRecent();
  $('#newBtn').onclick = () => { $('#nTitle').value = ''; $('#newDlg').showModal(); $('#nTitle').focus(); };
  $('#openBtn').onclick = () => openProject();
  $('#newForm').addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'ok') return;
    const title = $('#nTitle').value.trim() || 'Untitled Interview';
    const data = newProject({ title, guest: $('#nGuest').value.trim(), role: $('#nRole').value.trim(), sample: $('#nSample').checked });
    try { const dir = await S.project.create(title, data); await openProject(dir); } catch (err) { toast('Could not create the project: ' + err.message, 'error'); }
  });
  S.onBeforeClose(async () => { try { if (sess.rec) await sess.rec.abort(); await store.save(); } finally { S.closeReady(); } });
  S.guest.onClosed(() => { ui.guestOpen = false; renderTop(); });
  S.onTranscribeProgress(onTranscribeProgress);
  S.exporter.onProgress(onExportProgress);
  requestAnimationFrame(loop);
})();

async function renderRecent() {
  const host = $('#recentList');
  let list = [];
  try { list = await S.project.recent(); } catch {}
  host.innerHTML = list.length ? '<div class="rh">RECENT</div>' + list.slice(0, 6).map((r, i) => `<button class="rc" data-i="${i}"><b>${esc(r.title)}</b><small>${new Date(r.at).toLocaleDateString()}</small></button>`).join('') : '';
  $$('.rc', host).forEach((b) => (b.onclick = () => openProject(list[b.dataset.i].dir)));
}

async function openProject(dir) {
  try {
    const r = await S.project.open(dir);
    if (!r) return;
    store.load(r.dir, r.data);
    ui.qi = 0; ui.view = 'live'; ui.sel = null;
    $('#start').hidden = true; $('#studio').hidden = false;
    $('#projDir').textContent = r.dir;
    if (P().look.logo) P().look.logoUrl = mediaUrl(store.abs(P().look.logo));
    await logoReady(P().look.logoUrl);
    renderAll();
    setPanel(prefs.panel || 'questions');
    setDock(prefs.dock || 'prompter');
    connectDevices(true);
    refreshDisk();
  } catch (e) { toast(e.message, 'error'); }
}

function renderAll() {
  renderTop(); renderQuestions(); renderEditor(); renderVoiceList(); renderDevicesPanel(); renderLook(); renderCaptionsPanel(); renderMusic(); renderStrip(); renderTransport(); renderDock(); sizeMonitor();
}
store.on((what) => {
  if (what === 'load') return;
  renderTop(); renderStrip();
  if (what === 'takes' || what === 'all') { renderDock(); renderQuestions(); renderVoiceList(); }
});

// ============================================================ top bar
function renderTop() {
  const p = P(); if (!p) return;
  if (document.activeElement !== $('#projTitle')) $('#projTitle').value = p.title;
  $$('#aspectSeg button').forEach((b) => b.classList.toggle('on', b.dataset.aspect === p.aspect));
  const prog = buildProgram();
  $('#runtime').textContent = fmtTime(prog.duration);
  $('#guestBtn').textContent = ui.guestOpen ? 'Close guest screen' : 'Guest screen';
  $('#guestBtn').classList.toggle('on', ui.guestOpen);
  renderReady();
}
$('#projTitle').addEventListener('input', (e) => { P().title = e.target.value; if (P().intro.title === '' || !P().intro.title) P().intro.title = e.target.value; store.change('meta'); });
$$('#aspectSeg button').forEach((b) => (b.onclick = () => { P().aspect = b.dataset.aspect; sizeMonitor(); store.change('look'); renderLookThumbs(); }));
$('#exportBtn').onclick = () => openExport();
$('#playProgramBtn').onclick = () => (ui.view === 'program' ? stopProgram() : startProgram());
$('#guestBtn').onclick = async () => {
  if (ui.guestOpen) { await S.guest.close(); ui.guestOpen = false; renderTop(); return; }
  try { await S.guest.open({ displayId: prefs.guestDisplay }); ui.guestOpen = true; renderTop(); toast('Guest screen open. It shows the question, countdown and prompter — never the controls.'); }
  catch (e) { toast(e.message, 'error'); }
};
$('#readyPill').onclick = () => setPanel('devices');

// ============================================================ rail / panels
$$('#rail button[data-panel]').forEach((b) => (b.onclick = () => setPanel(b.dataset.panel)));
$('#rail [data-action=home]').onclick = async () => { if (sess.phase !== 'idle') return toast('Stop recording first.', 'warn'); await store.save(); stopProgram(); $('#studio').hidden = true; $('#start').hidden = false; renderRecent(); };
$('#rail [data-action=help]').onclick = () => $('#helpDlg').showModal();
$('#helpClose').onclick = () => $('#helpDlg').close();
function setPanel(name) {
  prefs.panel = name; savePrefs();
  $$('#rail button[data-panel]').forEach((b) => b.classList.toggle('on', b.dataset.panel === name));
  $$('#panel > section').forEach((s) => s.classList.toggle('on', s.dataset.panel === name));
  if (name === 'look') renderLookThumbs();
  if (name === 'devices') renderReady();
}

// ============================================================ questions panel
function renderQuestions() {
  const p = P(); if (!p) return;
  const host = $('#qList');
  host.innerHTML = p.questions.map((q, i) => {
    const takes = q.takes.length;
    return `<li class="q-item ${i === ui.qi ? 'on' : ''} ${q.include ? '' : 'off'}" data-i="${i}">
      <span class="n">${pad2(i + 1)}</span><span class="t" title="${esc(q.question)}">${esc(q.title || q.question || 'Untitled')}</span>
      <span class="st"><span class="mv"><button data-mv="-1" title="Move up">↑</button><button data-mv="1" title="Move down">↓</button><button data-del title="Delete">✕</button></span>${q.voice ? '<span class="ic v" title="Voice recorded">VO</span>' : ''}${takes ? `<span class="ic k" title="Takes">${takes}T</span>` : ''}</span></li>`;
  }).join('');
  $$('.q-item', host).forEach((li) => {
    li.onclick = (e) => {
      const i = Number(li.dataset.i);
      if (e.target.dataset.mv) return moveQuestion(i, Number(e.target.dataset.mv));
      if (e.target.hasAttribute('data-del')) return deleteQuestion(i);
      selectQuestion(i);
    };
  });
}
function selectQuestion(i, view) {
  if (sess.phase !== 'idle') return;
  const p = P();
  ui.qi = clamp(i, 0, p.questions.length - 1);
  ui.sel = null; ui.prompterOffset = 0;
  const q = curQ();
  if (view) ui.view = view;
  else if (ui.view !== 'program') ui.view = store.take(q) && dev.cam == null ? 'take' : ui.view === 'take' && store.take(q) ? 'take' : 'live';
  if (ui.view === 'take') loadTakeVideo();
  renderQuestions(); renderEditor(); renderVoiceList(); renderStrip(); renderTransport(); renderDock();
}
function moveQuestion(i, d) {
  const qs = P().questions, j = i + d;
  if (j < 0 || j >= qs.length) return;
  [qs[i], qs[j]] = [qs[j], qs[i]];
  if (ui.qi === i) ui.qi = j; else if (ui.qi === j) ui.qi = i;
  store.change('all');
}
async function deleteQuestion(i) {
  const q = P().questions[i];
  if (P().questions.length === 1) return toast('An interview needs at least one question.', 'warn');
  if ((q.takes.length || q.voice) && !confirm(`Delete "${q.title}" and its ${q.takes.length} take(s)? The files stay in the project folder.`)) return;
  P().questions.splice(i, 1);
  ui.qi = clamp(ui.qi >= i ? ui.qi - 1 : ui.qi, 0, P().questions.length - 1);
  store.change('all'); renderEditor();
}
$('#addQBtn').onclick = () => { P().questions.splice(ui.qi + 1, 0, newQuestion(`Question ${P().questions.length + 1}`, '', '')); ui.qi += 1; store.change('all'); renderEditor(); $('#qText').focus(); };
function renderEditor() {
  const q = curQ(); if (!q) return;
  $('#qTitle').value = q.title; $('#qText').value = q.question;
  $('#qBody').value = q.mode === 'points' ? q.notes : q.script;
  $('#qBodyLbl').textContent = q.mode === 'points' ? 'Talking points (one per line)' : 'Answer script (for the prompter)';
  $$('#qMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === q.mode));
  $('#qTarget').value = String([0, 20, 30, 45, 60, 90, 120, 180].includes(q.target) ? q.target : 60);
  $('#qInclude').checked = q.include;
  renderPrompter();
}
$('#qTitle').oninput = (e) => { curQ().title = e.target.value; store.change('q'); renderQuestionsLite(); };
$('#qText').oninput = (e) => { curQ().question = e.target.value; store.change('q'); renderPrompter(); };
$('#qBody').oninput = (e) => { const q = curQ(); if (q.mode === 'points') q.notes = e.target.value; else q.script = e.target.value; store.change('q'); renderPrompter(); };
$$('#qMode button').forEach((b) => (b.onclick = () => { curQ().mode = b.dataset.mode; store.change('q'); renderEditor(); }));
$('#qTarget').onchange = (e) => { curQ().target = Number(e.target.value); store.change('q'); };
$('#qInclude').onchange = (e) => { curQ().include = e.target.checked; store.change('all'); };
let liteT = 0;
function renderQuestionsLite() { clearTimeout(liteT); liteT = setTimeout(renderQuestions, 250); }
$('#importScriptBtn').onclick = async () => {
  const f = await S.project.importScript(); if (!f) return;
  const qs = parseScript(f.text);
  if (!qs.length) return toast('No questions found in that file.', 'warn');
  const replace = P().questions.every((q) => !q.takes.length && !q.voice) || confirm(`Add ${qs.length} questions after the current list? (Cancel keeps things as they are.)`);
  if (!replace) return;
  if (P().questions.length === 1 && !P().questions[0].takes.length && !P().questions[0].question.trim()) P().questions = qs; else P().questions.push(...qs);
  store.change('all'); renderEditor(); toast(`Imported ${qs.length} questions.`);
};
$('#exportScriptBtn').onclick = async () => {
  const data = { title: P().title, guest: P().guest, questions: P().questions.map((q) => ({ title: q.title, question: q.question, script: q.script, notes: q.notes, mode: q.mode, target: q.target })) };
  const f = await S.project.exportScript(`${P().title} questions.json`, JSON.stringify(data, null, 2));
  if (f) toast('Questions exported.');
};

// ============================================================ voice panel
let voiceMicStream = null;
async function voiceStream() {
  if (!prefs.voiceMic || prefs.voiceMic === prefs.mic) {
    if (dev.mic) return dev.mic;
    return (voiceMicStream ||= await openMic(prefs.mic));
  }
  if (voiceMicStream && voiceMicStream.__id === prefs.voiceMic && voiceMicStream.active) return voiceMicStream;
  voiceMicStream?.getTracks().forEach((t) => t.stop());
  voiceMicStream = await openMic(prefs.voiceMic);
  voiceMicStream.__id = prefs.voiceMic;
  return voiceMicStream;
}
const peaksCache = new Map();
async function loadPeaks(rel) {
  if (!rel) return null;
  if (peaksCache.has(rel)) return peaksCache.get(rel);
  try { const r = await fetch(mediaUrl(store.abs(rel))); const a = new Uint8Array(await r.arrayBuffer()); peaksCache.set(rel, a); return a; } catch { return null; }
}
function drawPeaks(canvas, peaks, { from = 0, to = null, inT = null, outT = null, cuts = [], color = '#c8ff2e', dim = '#3a3a44', play = null } = {}) {
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio), h = (canvas.height = canvas.clientHeight * devicePixelRatio);
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, w, h);
  if (!peaks) return;
  const total = peaks.length / 100;
  to = to ?? total;
  const span = Math.max(0.01, to - from);
  const x = (t) => ((t - from) / span) * w;
  for (let px = 0; px < w; px += 2 * devicePixelRatio) {
    const t0 = from + (px / w) * span, t1 = from + ((px + 2 * devicePixelRatio) / w) * span;
    let m = 0;
    for (let i = Math.floor(t0 * 100); i < Math.min(peaks.length, Math.ceil(t1 * 100)); i++) m = Math.max(m, peaks[i]);
    const tm = (t0 + t1) / 2;
    const inside = (inT == null || tm >= inT) && (outT == null || tm <= outT) && !cuts.some(([a, b]) => tm >= a && tm <= b);
    c.fillStyle = inside ? color : dim;
    const bh = Math.max(1, (m / 255) * h * 0.92);
    c.fillRect(px, (h - bh) / 2, Math.max(1, 1.4 * devicePixelRatio), bh);
  }
  c.fillStyle = 'rgba(255,59,59,0.16)';
  for (const [a, b] of cuts) c.fillRect(x(a), 0, Math.max(1, x(b) - x(a)), h);
  if (inT != null) { c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(0, 0, x(inT), h); c.fillRect(x(outT), 0, w - x(outT), h); c.fillStyle = '#c8ff2e'; c.fillRect(x(inT) - 1, 0, 3, h); c.fillRect(x(outT) - 1, 0, 3, h); }
  if (play != null) { c.fillStyle = '#fff'; c.fillRect(x(play), 0, 2, h); }
}
async function renderVoiceList() {
  const p = P(); if (!p) return;
  const host = $('#vList');
  host.innerHTML = p.questions.map((q, i) => `<li class="v-item ${i === ui.qi ? 'on' : ''}" data-i="${i}"><span class="n">${pad2(i + 1)}</span><span class="t">${esc(q.question || q.title)}</span>
    <div class="vrow">${q.voice ? `<canvas data-peaks="${i}"></canvas><span class="dur">${voiceLen(q.voice).toFixed(1)}s</span><button class="mini" data-play>▶</button><button class="mini" data-rec>Redo</button><button class="mini danger" data-del title="Remove">✕</button>` : `<span class="none">no voice yet</span><button class="mini" data-rec>● Record</button><button class="mini" data-import>Import…</button>`}</div></li>`).join('');
  for (const li of $$('.v-item', host)) {
    const i = Number(li.dataset.i), q = p.questions[i];
    li.onclick = (e) => {
      if (e.target.closest('[data-play]')) return playVoice(q);
      if (e.target.closest('[data-rec]')) { ui.qi = i; return openBatch(i, true); }
      if (e.target.closest('[data-del]')) { removeVoice(q); return; }
      if (e.target.closest('[data-import]')) return importVoice(q);
      selectQuestion(i);
    };
    const cv = $('canvas', li);
    if (cv && q.voice) loadPeaks(q.voice.peaks).then((pk) => drawPeaks(cv, pk, { inT: q.voice.in, outT: q.voice.out }));
  }
  const { mics } = await listDevices();
  const sel = $('#voiceMicSel');
  sel.innerHTML = `<option value="">Same as answer mic</option>` + mics.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('');
  sel.value = prefs.voiceMic || '';
}
$('#voiceMicSel').onchange = (e) => { prefs.voiceMic = e.target.value; savePrefs(); };
$('#voiceBatchBtn').onclick = () => openBatch(ui.qi);
function playVoice(q = curQ()) {
  if (!q?.voice) return toast('No question voice recorded yet.', 'warn');
  voiceAudio.src = mediaUrl(store.abs(q.voice.file));
  voiceAudio.currentTime = q.voice.in || 0;
  voiceAudio.__stopAt = q.voice.out;
  voiceAudio.play().catch(() => {});
}
voiceAudio.addEventListener('timeupdate', () => { if (voiceAudio.__stopAt && voiceAudio.currentTime >= voiceAudio.__stopAt) { voiceAudio.pause(); voiceAudio.dispatchEvent(new Event('voicedone')); } });
voiceAudio.addEventListener('ended', () => voiceAudio.dispatchEvent(new Event('voicedone')));
async function removeVoice(q) {
  if (!q.voice) return;
  const old = q.voice; q.voice = null;
  store.change('all');
  for (const f of [old.file, old.peaks]) if (f) S.file.remove(store.abs(f)).catch(() => {});
}
async function importVoice(q) {
  const abs = await S.file.pickImport(store.dir, 'audio'); if (!abs) return;
  try {
    const a = await S.media.analyze(abs);
    setVoice(q, { file: abs, ...a });
    toast('Voice imported and trimmed to the speech.');
  } catch (e) { toast('Could not read that audio: ' + e.message, 'error'); }
}
function setVoice(q, r) {
  const old = q.voice;
  q.voice = { file: store.rel(r.file), peaks: store.rel(r.peaksFile), duration: r.duration, in: Math.max(0, r.speechStart - 0.12), out: Math.min(r.duration, r.speechEnd + 0.3), at: Date.now() };
  if (q.voice.out - q.voice.in < 0.4) { q.voice.in = 0; q.voice.out = r.duration; }
  store.change('all');
  if (old) for (const f of [old.file, old.peaks]) if (f && f !== q.voice.file) S.file.remove(store.abs(f)).catch(() => {});
}

// ---- batch voice recorder (overlay on the monitor)
const batch = { on: false, i: 0, rec: null, state: 'ready', t0: 0 };
function openBatch(i = ui.qi, single = false) {
  if (sess.phase !== 'idle') return toast('Finish the answer take first.', 'warn');
  stopProgram();
  batch.on = true; batch.i = i; batch.single = single; batch.state = 'ready';
  $('#batch').hidden = false;
  renderBatch(); renderTransport();
}
function renderBatch() {
  const q = P().questions[batch.i];
  $('#batchStep').textContent = `QUESTION ${batch.i + 1} / ${P().questions.length}${q.voice ? ' · HAS VOICE' : ''}`;
  $('#batchQ').textContent = q.question || q.title;
  const st = $('#batchState');
  st.className = batch.state === 'rec' ? 'rec' : batch.state === 'saved' ? 'done' : '';
  st.textContent = batch.state === 'rec' ? '● RECORDING — SPACE TO SAVE' : batch.state === 'saving' ? 'SAVING…' : batch.state === 'saved' ? 'SAVED ✓ — SPACE FOR NEXT' : 'READY — PRESS SPACE AND ASK IT';
}
async function batchKey(key) {
  if (batch.state === 'saving') return;
  const q = P().questions[batch.i];
  if (key === 'Escape') { if (batch.rec) { await batch.rec.abort(); batch.rec = null; } batch.on = false; $('#batch').hidden = true; renderVoiceList(); renderTransport(); return; }
  if (key === 'p') return playVoice(q);
  if (key === 'r' && batch.rec) { await batch.rec.abort(); batch.rec = null; batch.state = 'ready'; }
  if (key === ' ' || key === 'r') {
    if (batch.state === 'rec') {
      batch.state = 'saving'; renderBatch();
      try { const r = await batch.rec.stop(); setVoice(q, r); batch.state = 'saved'; }
      catch (e) { toast('Voice save failed: ' + e.message, 'error'); batch.state = 'ready'; }
      batch.rec = null; renderBatch(); renderVoiceList();
      if (batch.single) setTimeout(() => batchKey('Escape'), 500);
      return;
    }
    if (batch.state === 'saved' && key === ' ') {
      if (batch.i >= P().questions.length - 1) return batchKey('Escape');
      batch.i++; batch.state = 'ready'; renderBatch(); return;
    }
    try {
      const stream = await voiceStream();
      const r = new DiskRecorder(new MediaStream(stream.getAudioTracks()), store.abs(`voice/${q.id}-${Date.now().toString(36)}.part.webm`), { mime: pickAudioMime(), audioBps: 160000, kind: 'voice' });
      await r.start();
      batch.rec = r; batch.state = 'rec'; renderBatch();
    } catch (e) { toast('Microphone problem: ' + e.message, 'error'); }
  }
}

// ============================================================ devices panel
async function connectDevices(quiet = false) {
  try {
    await connect();
    $('#monitorEmpty').hidden = true;
    await renderDevicesPanel();
    if (!quiet) toast(`Camera ${dev.camInfo.width}×${dev.camInfo.height} and mic connected.`);
  } catch (e) {
    $('#monitorEmpty').hidden = false;
    if (!quiet) toast('Could not open camera/mic: ' + e.message, 'error');
  }
  renderTransport(); renderReady();
}
$('#connectBtn').onclick = () => connectDevices();
$('#connectBtn2').onclick = () => connectDevices();
async function renderDevicesPanel() {
  const { cams, mics } = await listDevices();
  $('#camSel').innerHTML = `<option value="">Default camera</option>` + cams.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  $('#micSel').innerHTML = `<option value="">Default microphone</option>` + mics.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join('');
  $('#camSel').value = prefs.camera || ''; $('#micSel').value = prefs.mic || '';
  $('#qualitySel').value = prefs.quality; $('#nsChk').checked = prefs.noiseSuppression; $('#agcChk').checked = prefs.autoGain;
  const r = P().record;
  $('#countSel').value = String(r.countdown); $('#cardSecSel').value = String(r.cardSeconds);
  $('#playVoiceChk').checked = r.playVoice; $('#runAllChk').checked = r.runAll; $('#autoScrollChk').checked = r.autoScroll; $('#voicePaceChk').checked = r.voicePace;
  $('#guidesChk').checked = prefs.guides; $('#mirrorPrevChk').checked = !!prefs.mirrorPreview;
  for (const id of ['#camSel', '#micSel', '#qualitySel', '#connectBtn']) $(id).disabled = sess.phase !== 'idle';
}
for (const [id, key] of [['#camSel', 'camera'], ['#micSel', 'mic'], ['#qualitySel', 'quality']]) $(id).onchange = (e) => { prefs[key] = e.target.value; savePrefs(); connectDevices(); };
$('#nsChk').onchange = (e) => { prefs.noiseSuppression = e.target.checked; savePrefs(); connectDevices(true); };
$('#agcChk').onchange = (e) => { prefs.autoGain = e.target.checked; savePrefs(); connectDevices(true); };
$('#countSel').onchange = (e) => { P().record.countdown = Number(e.target.value); store.change('rec'); };
$('#cardSecSel').onchange = (e) => { P().record.cardSeconds = Number(e.target.value); store.change('rec'); };
for (const [id, key] of [['#playVoiceChk', 'playVoice'], ['#runAllChk', 'runAll'], ['#autoScrollChk', 'autoScroll'], ['#voicePaceChk', 'voicePace']]) $(id).onchange = (e) => { P().record[key] = e.target.checked; store.change('rec'); renderTransport(); };
$('#guidesChk').onchange = (e) => { prefs.guides = e.target.checked; savePrefs(); };
$('#mirrorPrevChk').onchange = (e) => { prefs.mirrorPreview = e.target.checked; savePrefs(); };
navigator.mediaDevices?.addEventListener?.('devicechange', () => { if (store.data && sess.phase === 'idle') { renderDevicesPanel(); renderVoiceList(); } });

async function refreshDisk() { try { ui.freeBytes = await S.file.diskFree(store.dir); } catch {} }
setInterval(() => { if (store.dir) refreshDisk(); }, 20000);
function readyRows() {
  const p = P();
  return readiness({ freeBytes: ui.freeBytes, voiceCount: p.questions.filter((q) => q.include && q.voice).length, questionCount: p.questions.filter((q) => q.include).length, guestOpen: ui.guestOpen });
}
function renderReady() {
  if (!P()) return;
  const rows = readyRows();
  $('#readyDots').innerHTML = rows.map((r) => `<i class="${r.state}" title="${esc(r.label)}"></i>`).join('');
  const bad = rows.filter((r) => r.state === 'bad').length, warn = rows.filter((r) => r.state === 'warn').length;
  $('#readyText').textContent = bad ? `${bad} to fix` : warn ? `${warn} to check` : 'Ready';
  if ($('[data-panel=devices].on')) $('#readyList').innerHTML = rows.map((r) => `<li class="${r.state}"><i></i><b>${esc(r.label)}</b><span>${esc(r.detail)}</span></li>`).join('');
}
setInterval(() => { if (store.data && !$('#studio').hidden) renderReady(); }, 1000);

// ============================================================ look panel
const SWATCHES = ['#C8FF2E', '#FF5A1F', '#FF3B3B', '#2E7BFF', '#8B6CFF', '#00E0C6', '#FFD23F', '#FFFFFF'];
function renderLook() {
  const L = P().look;
  $('#styleGrid').innerHTML = Object.entries(STYLES).map(([k, s]) => `<button data-style="${k}" class="${L.style === k ? 'on' : ''}"><canvas width="320" height="180"></canvas>${esc(s.label)}</button>`).join('');
  $$('#styleGrid button').forEach((b) => (b.onclick = () => { L.style = b.dataset.style; store.change('look'); renderLook(); renderLookThumbs(); }));
  $('#swatches').innerHTML = SWATCHES.map((c) => `<button data-c="${c}" style="background:${c}" class="${L.accent.toUpperCase() === c ? 'on' : ''}" title="${c}"></button>`).join('') + `<input type="color" id="accentPick" value="${L.accent}">`;
  $$('#swatches button').forEach((b) => (b.onclick = () => { L.accent = b.dataset.c; store.change('look'); renderLook(); renderLookThumbs(); }));
  $('#accentPick').oninput = (e) => { L.accent = e.target.value.toUpperCase(); store.change('look'); renderLookThumbs(); };
  $$('#layoutSeg button').forEach((b) => b.classList.toggle('on', b.dataset.layout === L.layout));
  $('#cropX').value = L.cropX; $('#cropY').value = L.cropY; $('#mirrorOutChk').checked = L.mirror;
  $('#guestName').value = P().guest.name; $('#guestRole').value = P().guest.role;
  $('#ltChk').checked = L.lowerThird; $('#ltEveryChk').checked = L.lowerThirdEvery; $('#bugChk').checked = L.bug;
  $('#introChk').checked = P().intro.enabled; $('#introTitle').value = P().intro.title; $('#introKicker').value = P().intro.kicker;
  $('#outroChk').checked = P().outro.enabled; $('#outroTitle').value = P().outro.title; $('#outroLine').value = P().outro.line;
  renderLookThumbs();
}
function renderLookThumbs() {
  const p = P(); if (!p) return;
  $$('#styleGrid button').forEach((b) => {
    const c = $('canvas', b); const ctx = c.getContext('2d');
    const save = p.look.style; p.look.style = b.dataset.style;
    ctx.save(); ctx.scale(320 / 1920, 180 / 1080); drawCard(ctx, 1920, 1080, p, { kind: 'question', qi: ui.qi }); ctx.restore();
    p.look.style = save;
  });
  ui.dirtyStrip = true; renderStrip();
}
$$('#layoutSeg button').forEach((b) => (b.onclick = () => { P().look.layout = b.dataset.layout; store.change('look'); renderLook(); }));
$('#cropX').oninput = (e) => { P().look.cropX = Number(e.target.value); store.change('look'); };
$('#cropY').oninput = (e) => { P().look.cropY = Number(e.target.value); store.change('look'); };
$('#mirrorOutChk').onchange = (e) => { P().look.mirror = e.target.checked; store.change('look'); };
$('#guestName').oninput = (e) => { P().guest.name = e.target.value; store.change('look'); };
$('#guestRole').oninput = (e) => { P().guest.role = e.target.value; store.change('look'); };
$('#ltChk').onchange = (e) => { P().look.lowerThird = e.target.checked; store.change('look'); };
$('#ltEveryChk').onchange = (e) => { P().look.lowerThirdEvery = e.target.checked; if (e.target.checked) P().look.lowerThird = true; store.change('look'); renderLook(); };
$('#bugChk').onchange = (e) => { P().look.bug = e.target.checked; store.change('look'); };
$('#introChk').onchange = (e) => { P().intro.enabled = e.target.checked; store.change('look'); };
$('#outroChk').onchange = (e) => { P().outro.enabled = e.target.checked; store.change('look'); };
for (const [id, obj, key] of [['#introTitle', 'intro', 'title'], ['#introKicker', 'intro', 'kicker'], ['#outroTitle', 'outro', 'title'], ['#outroLine', 'outro', 'line']]) $(id).oninput = (e) => { P()[obj][key] = e.target.value; store.change('look'); };
$('#logoBtn').onclick = async () => { const abs = await S.file.pickImport(store.dir, 'image'); if (!abs) return; P().look.logo = store.rel(abs); P().look.logoUrl = mediaUrl(abs); P().look.bug = true; await logoReady(P().look.logoUrl); store.change('look'); renderLook(); };
$('#logoClear').onclick = () => { P().look.logo = null; P().look.logoUrl = null; store.change('look'); renderLook(); };

// ============================================================ captions panel
function renderCaptionsPanel() {
  const c = P().captions;
  $('#capAutoChk').checked = c.auto; $('#capBurnChk').checked = c.burn; $('#modelSel').value = c.model;
  $$('#capStyleSeg button').forEach((b) => b.classList.toggle('on', b.dataset.cap === c.style));
}
$('#capAutoChk').onchange = (e) => { P().captions.auto = e.target.checked; store.change('cap'); };
$('#capBurnChk').onchange = (e) => { P().captions.burn = e.target.checked; store.change('cap'); };
$('#modelSel').onchange = (e) => { P().captions.model = e.target.value; store.change('cap'); };
$$('#capStyleSeg button').forEach((b) => (b.onclick = () => { P().captions.style = b.dataset.cap; store.change('cap'); renderCaptionsPanel(); }));
$('#transcribeAllBtn').onclick = () => {
  let n = 0;
  for (const q of P().questions) { const t = store.take(q); if (q.include && t && !t.transcript) { enqueueTranscribe(q, t); n++; } }
  toast(n ? `Transcribing ${n} take(s) on this computer.` : 'Every selected take already has captions.');
};

// ---- transcription queue
const tq = { list: [], busy: false, current: null };
function enqueueTranscribe(q, take, force = false) {
  if (!force && (take.transcript || tq.list.some((j) => j.take.id === take.id) || tq.current?.take.id === take.id)) return;
  tq.list.push({ q, take });
  runTranscribe();
}
async function runTranscribe() {
  if (tq.busy) return;
  const job = tq.list.shift();
  if (!job) { $('#capJob').innerHTML = ''; return; }
  tq.busy = true; tq.current = job;
  setJob(`Transcribing Q${P().questions.indexOf(job.q) + 1} take ${job.take.n}…`, null);
  try {
    const res = await S.transcribe(store.abs(job.take.file), P().captions.model);
    job.take.transcript = { words: res.words, model: res.model, at: Date.now() };
    if (!job.take.userTrim && res.words.length) { const [a, b] = autoTrim(job.take); job.take.in = a; job.take.out = b; }
    store.change('takes');
    const f = res.words.filter((w) => isFiller(w.w)).length;
    toast(`Captions ready for Q${P().questions.indexOf(job.q) + 1} · ${res.words.length} words${f ? ` · ${f} filler${f > 1 ? 's' : ''} found` : ''}.`);
  } catch (e) {
    toast('Captions failed: ' + e.message, 'error', 7000);
  }
  tq.busy = false; tq.current = null;
  runTranscribe();
}
function setJob(text, frac) { $('#capJob').innerHTML = `${esc(text)}${frac != null ? `<div class="bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></div>` : ''}`; }
function onTranscribeProgress(p) {
  if (p.stage === 'download') setJob(`Downloading speech model (first time only) ${(p.loaded / 1e6).toFixed(0)} / ${(p.total / 1e6).toFixed(0)} MB`, p.total ? p.loaded / p.total : null);
  else if (p.stage === 'load') setJob('Loading speech model…', null);
  else if (p.stage === 'transcribe') setJob(`Transcribing ${fmtTime(p.duration)} of audio…`, null);
}

// ============================================================ music
function renderMusic() {
  const m = P().music;
  $('#musicFile').textContent = m.file ? m.file.split('/').pop() : 'No music';
  $('#mCards').value = m.cardsVol; $('#mAns').value = m.answersVol;
  $('#mCardsOut').textContent = Math.round(m.cardsVol * 100) + '%'; $('#mAnsOut').textContent = Math.round(m.answersVol * 100) + '%';
  $('#normChk').checked = P().audio.normalize; $('#denoiseChk').checked = P().audio.denoise;
}
$('#musicBtn').onclick = async () => { const abs = await S.file.pickImport(store.dir, 'audio'); if (!abs) return; P().music.file = store.rel(abs); store.change('music'); renderMusic(); };
$('#musicClear').onclick = () => { P().music.file = null; musicAudio.pause(); store.change('music'); renderMusic(); };
$('#musicPlay').onclick = () => { if (!P().music.file) return; if (!musicAudio.paused) { musicAudio.pause(); $('#musicPlay').textContent = 'Play'; return; } musicAudio.src = mediaUrl(store.abs(P().music.file)); musicAudio.volume = P().music.cardsVol; musicAudio.play(); $('#musicPlay').textContent = 'Stop'; };
$('#mCards').oninput = (e) => { P().music.cardsVol = Number(e.target.value); musicAudio.volume = P().music.cardsVol; store.change('music'); renderMusic(); };
$('#mAns').oninput = (e) => { P().music.answersVol = Number(e.target.value); store.change('music'); renderMusic(); };
$('#normChk').onchange = (e) => { P().audio.normalize = e.target.checked; store.change('audio'); };
$('#denoiseChk').onchange = (e) => { P().audio.denoise = e.target.checked; store.change('audio'); };

// ============================================================ scene strip
function renderStrip() {
  const p = P(); if (!p) return;
  const host = $('#strip');
  const tiles = [];
  if (p.intro.enabled) tiles.push(`<button class="tile card-tile ${ui.view === 'card' && ui.cardKind === 'intro' ? 'on' : ''}" data-card="intro"><canvas width="256" height="144"></canvas><span class="tl-n">INTRO</span><span class="tl-b"><span></span><span>${p.intro.seconds}s</span></span></button>`);
  tiles.push('<span class="sep"></span>');
  p.questions.forEach((q, i) => {
    const t = store.take(q);
    const poster = t?.poster ? `<img src="${mediaUrl(store.abs(t.poster))}" alt="">` : '<canvas width="256" height="144"></canvas>';
    const dur = t ? fmtTime(rangesDuration(keptRanges(t))) : '';
    tiles.push(`<button class="tile ${i === ui.qi && ui.view !== 'card' ? 'on' : ''} ${q.include ? '' : 'off'}" data-q="${i}" title="${esc(q.question)}">${poster}<span class="tl-n">Q${pad2(i + 1)}</span><span class="tl-b"><span class="${q.voice ? 'vo' : ''}">${q.voice ? 'VO' : ''}</span><span class="${t ? '' : 'no'}">${t ? `${q.takes.length > 1 ? q.takes.length + 'T · ' : ''}${dur}` : 'NO TAKE'}</span></span></button>`);
  });
  tiles.push('<span class="sep"></span>');
  if (p.outro.enabled) tiles.push(`<button class="tile card-tile ${ui.view === 'card' && ui.cardKind === 'outro' ? 'on' : ''}" data-card="outro"><canvas width="256" height="144"></canvas><span class="tl-n">OUTRO</span><span class="tl-b"><span></span><span>${p.outro.seconds}s</span></span></button>`);
  tiles.push(`<button class="tile add" id="stripAdd" title="Add question">+</button>`);
  host.innerHTML = tiles.join('');
  $$('.tile', host).forEach((b) => {
    const c = $('canvas', b);
    if (c) {
      const ctx = c.getContext('2d');
      ctx.save(); ctx.scale(256 / 1920, 144 / 1080);
      if (b.dataset.card) drawCard(ctx, 1920, 1080, p, { kind: b.dataset.card });
      else drawCard(ctx, 1920, 1080, p, { kind: 'question', qi: Number(b.dataset.q) });
      ctx.restore();
    }
    b.onclick = () => {
      if (b.id === 'stripAdd') return $('#addQBtn').click();
      if (sess.phase !== 'idle') return;
      stopProgram();
      if (b.dataset.card) { ui.view = 'card'; ui.cardKind = b.dataset.card; renderStrip(); renderTransport(); return; }
      const i = Number(b.dataset.q);
      selectQuestion(i, store.take(p.questions[i]) ? 'take' : 'live');
    };
  });
}

// ============================================================ monitor sizing
function sizeMonitor() {
  const p = P(); if (!p) return;
  const [w, h] = PREVIEW[p.aspect];
  screen.width = w; screen.height = h;
  $('#monitor').style.aspectRatio = `${w} / ${h}`;
  fitMonitor();
}
function fitMonitor() {
  const wrap = $('#monitorWrap'), mon = $('#monitor');
  const [w, h] = PREVIEW[P()?.aspect || '16:9'];
  const W = wrap.clientWidth - 28, H = wrap.clientHeight - 28;
  const s = Math.min(W / w, H / h);
  mon.style.width = Math.floor(w * s) + 'px'; mon.style.height = Math.floor(h * s) + 'px';
}
new ResizeObserver(() => { if (P()) { fitMonitor(); drawEditWave(); } }).observe($('#monitorWrap'));

// ============================================================ transport
function renderTransport() {
  const p = P(); if (!p) return;
  const q = curQ();
  $('#tQ').innerHTML = `<b>Q${pad2(ui.qi + 1)}</b>${esc(q?.question || '')}`;
  const mid = $('#tMid'), right = $('#tRight');
  const hasCam = !!dev.cam;
  if (batch.on) {
    mid.innerHTML = `<span class="hint">Recording question voices — <kbd>Space</kbd> record / next · <kbd>Esc</kbd> done</span>`;
  } else if (sess.phase === 'ask') {
    mid.innerHTML = `<button class="btn" id="tSkip">Skip to answer <kbd>Space</kbd></button><button class="btn ghost" id="tCancel">Cancel <kbd>Esc</kbd></button>`;
  } else if (sess.phase === 'countdown' || sess.phase === 'answer') {
    mid.innerHTML = `<button class="recbtn stop" id="tFinish"><i></i>${p.record.runAll ? 'Next question' : 'Finish answer'} <kbd>Space</kbd></button><button class="btn" id="tRetake">↻ Retake <kbd>R</kbd></button><button class="btn ghost" id="tStop">Stop <kbd>Esc</kbd></button>`;
  } else if (sess.phase === 'saving') {
    mid.innerHTML = `<span class="hint">Saving take…</span>`;
  } else if (ui.view === 'take') {
    const t = store.take(q);
    mid.innerHTML = `<button class="btn ghost" id="tLive">◉ Live</button><button class="btn" id="tPlay">${takeVideo.paused ? '▶' : '❚❚'}</button><div class="scrub"><span id="tTime">0:00</span><input type="range" id="tScrub" min="0" max="${t?.duration || 1}" step="0.01"><span>${fmtTime(t?.duration)}</span></div><button class="recbtn" id="tRecord" ${hasCam ? '' : 'disabled'}><i></i>Retake Q${ui.qi + 1}</button>`;
  } else if (ui.view === 'program') {
    mid.innerHTML = `<button class="btn" id="tProgStop">■ Stop preview</button><span class="scrub"><span id="tTime">0:00</span> / ${fmtTime(buildProgram().duration)}</span>`;
  } else {
    mid.innerHTML = `<button class="recbtn" id="tRecord" ${hasCam ? '' : 'disabled'}><i></i>Ask &amp; record Q${ui.qi + 1} <kbd>Space</kbd></button>${q?.voice ? '<button class="btn" id="tHear" title="Play the recorded question (P)">▶ Hear question</button>' : '<button class="btn ghost" id="tVoice">● Record question voice</button>'}${store.take(q) ? '<button class="btn ghost" id="tReview">Review take</button>' : ''}`;
  }
  right.innerHTML = sess.phase === 'idle' ? `<button class="btn ghost" id="tPrev" title="Previous (←)">‹</button><button class="btn ghost" id="tNext" title="Next (→)">›</button>` : '';
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('tRecord', () => beginQuestion(ui.qi));
  on('tSkip', () => onAskDone());
  on('tCancel', () => cancelAsk());
  on('tFinish', () => finishTake(p.record.runAll ? 'next' : 'stay'));
  on('tRetake', () => finishTake('retake'));
  on('tStop', () => finishTake('stop'));
  on('tHear', () => playVoice());
  on('tVoice', () => openBatch(ui.qi, true));
  on('tReview', () => { ui.view = 'take'; loadTakeVideo(); renderTransport(); setDock('edit'); });
  on('tLive', () => { takeVideo.pause(); ui.view = 'live'; renderTransport(); renderStrip(); });
  on('tPlay', () => toggleTakePlay());
  on('tProgStop', () => stopProgram());
  on('tPrev', () => selectQuestion(ui.qi - 1));
  on('tNext', () => selectQuestion(ui.qi + 1));
  const scrub = $('#tScrub');
  if (scrub) scrub.oninput = (e) => { takeVideo.currentTime = Number(e.target.value); };
  $('#monitor').classList.toggle('recording', sess.phase === 'countdown' || sess.phase === 'answer');
  for (const id of ['#camSel', '#micSel', '#qualitySel', '#connectBtn']) { const el = $(id); if (el) el.disabled = sess.phase !== 'idle'; }
}

// ============================================================ recording session
async function beginQuestion(qi) {
  if (sess.phase !== 'idle' || batch.on) return;
  if (!dev.cam || !dev.dest) return toast('Connect the camera and mic first.', 'warn');
  stopProgram(); takeVideo.pause();
  ui.qi = qi; ui.view = 'live'; ui.prompterOffset = 0;
  const p = P(), q = curQ();
  sess.qi = qi; sess.phase = 'ask'; sess.t0 = performance.now();
  renderQuestions(); renderEditor(); renderStrip();
  if (p.record.playVoice && q.voice) {
    sess.askUntil = Infinity;
    playVoice(q);
    const done = () => { voiceAudio.removeEventListener('voicedone', done); setTimeout(() => { if (sess.phase === 'ask' && sess.qi === qi) onAskDone(); }, 450); };
    voiceAudio.addEventListener('voicedone', done);
  } else sess.askUntil = performance.now() + p.record.cardSeconds * 1000;
  renderTransport();
}
function cancelAsk() { voiceAudio.pause(); sess.phase = 'idle'; renderTransport(); }
async function onAskDone() {
  if (sess.phase !== 'ask') return;
  voiceAudio.pause();
  const p = P(), q = curQ();
  sess.phase = 'countdown';
  const id = uid('t');
  const vt = dev.cam.getVideoTracks()[0], at = dev.dest.stream.getAudioTracks()[0];
  const bps = prefs.quality === '2160' ? 35e6 : prefs.quality === '720' ? 6e6 : 12e6;
  const mime = pickVideoMime();
  const ext = /h264|avc1/.test(mime) ? 'mkv' : 'webm';
  sess.rec = new DiskRecorder(new MediaStream([vt, at]), store.abs(`takes/${q.id}-${id}.part.${ext}`), { mime, videoBps: bps, audioBps: 192000 });
  sess.takeId = id;
  try { await sess.rec.start(); } catch (e) { sess.rec = null; sess.phase = 'idle'; renderTransport(); return toast('Recorder could not start: ' + e.message, 'error'); }
  sess.recStartAt = performance.now();
  sess.countLen = p.record.countdown;
  sess.countEnd = performance.now() + sess.countLen * 1000;
  if (!sess.countLen) startAnswer();
  renderTransport();
}
function startAnswer() { sess.phase = 'answer'; sess.answerAt = performance.now(); sess.goUntil = performance.now() + 700; ui.prompterOffset = 0; renderTransport(); }
async function finishTake(mode) {
  if (sess.phase === 'ask') { if (mode === 'retake') return; cancelAsk(); return; }
  if (sess.phase !== 'countdown' && sess.phase !== 'answer') return;
  const p = P(), q = P().questions[sess.qi];
  const countLen = sess.countLen;
  const rec = sess.rec;
  // grab a poster frame now, while the camera shows the answer
  const poster = document.createElement('canvas'); poster.width = 384; poster.height = 216;
  drawCamera(poster.getContext('2d'), 384, 216, { look: { ...p.look, layout: 'full' } }, camVideo, { mirror: p.look.mirror });
  sess.phase = 'saving'; sess.rec = null; renderTransport();
  try {
    const r = await rec.stop();
    const n = Math.max(0, ...q.takes.map((t) => t.n || 0)) + 1;
    const take = { id: sess.takeId, n, file: store.rel(r.file), peaks: store.rel(r.peaksFile), duration: r.duration, width: r.video?.width, height: r.video?.height, codec: r.video?.codec, createdAt: Date.now(), starred: false, cuts: [], speechStart: r.speechStart, speechEnd: r.speechEnd, noiseDb: r.noiseDb, peakDb: r.peakDb };
    take.in = clamp(Math.max(countLen - 0.15, r.speechStart - 0.3), 0, r.duration);
    take.out = clamp(r.speechEnd + 0.5, take.in + 0.5, r.duration);
    if (take.out - take.in < 0.6) { take.in = Math.max(0, countLen - 0.15); take.out = r.duration; }
    try {
      const blob = await new Promise((res) => poster.toBlob(res, 'image/jpeg', 0.82));
      const posterAbs = store.abs(`takes/${q.id}-${take.id}.jpg`);
      await S.file.write(posterAbs, new Uint8Array(await blob.arrayBuffer()));
      take.poster = store.rel(posterAbs);
    } catch {}
    q.takes.push(take);
    q.selectedTake = take.id;
    store.change('takes');
    await store.save();
    if (r.peakDb > -1) toast(`Q${sess.qi + 1} take ${n} clipped — turn the mic gain down a little.`, 'warn', 6000);
    else toast(`Q${sess.qi + 1} take ${n} saved · ${fmtTime(take.out - take.in)}`);
    if (p.captions.auto) enqueueTranscribe(q, take);
  } catch (e) {
    toast('Take could not be saved: ' + e.message, 'error', 8000);
  }
  sess.phase = 'idle';
  const nextIdx = P().questions.findIndex((x, i) => i > sess.qi && x.include);
  if (mode === 'retake') { renderTransport(); setTimeout(() => beginQuestion(sess.qi), 350); return; }
  if (mode === 'next' && nextIdx >= 0) { ui.qi = nextIdx; renderTransport(); setTimeout(() => beginQuestion(nextIdx), 500); return; }
  if (mode === 'next' || mode === 'stay') { if (nextIdx >= 0) ui.qi = nextIdx; else toast('That was the last question. Review the takes, then Export.'); }
  renderQuestions(); renderEditor(); renderStrip(); renderTransport(); renderDock();
}

// ============================================================ prompter
function prompterHtml(q) {
  if (!q) return '';
  const head = `<span class="pq">Q${pad2(P().questions.indexOf(q) + 1)} · ${esc(q.question)}</span>`;
  if (q.mode === 'points') {
    const pts = (q.notes || '').split('\n').map((s) => s.replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
    return head + (pts.length ? `<ul>${pts.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : `<span style="opacity:.5">No talking points — answer freely.</span>`);
  }
  return head + esc(q.script || 'No script — answer freely.');
}
function renderPrompter() {
  const el = $('#pText');
  el.innerHTML = prompterHtml(curQ());
  el.style.fontSize = prefs.font + 'px';
  placePrompter();
}
function prompterMax() { const el = $('#pText'); return Math.max(1, el.scrollHeight - el.parentElement.clientHeight * 0.3); }
function placePrompter() {
  const el = $('#pText'), box = el.parentElement;
  ui.prompterOffset = clamp(ui.prompterOffset, 0, prompterMax());
  el.style.transform = `translateY(${(box.clientHeight * 0.34 - ui.prompterOffset).toFixed(1)}px)${prefs.mirrorPrompter ? ' scaleX(-1)' : ''}`;
}
$('#prompter').addEventListener('wheel', (e) => { ui.prompterOffset += e.deltaY * 0.6; placePrompter(); e.preventDefault(); }, { passive: false });

// ============================================================ dock
$$('#dockTabs > button').forEach((b) => (b.onclick = () => setDock(b.dataset.dock)));
function setDock(name) {
  prefs.dock = name; savePrefs();
  $$('#dockTabs > button').forEach((b) => b.classList.toggle('on', b.dataset.dock === name));
  $$('.dock-body > div').forEach((d) => d.classList.toggle('on', d.dataset.dock === name));
  if (name === 'edit' && ui.view !== 'take' && store.take(curQ()) && sess.phase === 'idle') { ui.view = 'take'; loadTakeVideo(); renderTransport(); }
  renderDock();
}
function renderDock() {
  const q = curQ(); if (!q) return;
  $('#takeCount').textContent = q.takes.length || '';
  const tools = $('#dockTools');
  if (prefs.dock === 'prompter') {
    tools.innerHTML = `<label>Speed <input type="range" id="pSpeed" min="8" max="120" value="${prefs.speed}"></label><label>Size <input type="range" id="pSize" min="22" max="80" value="${prefs.font}"></label><button class="mini ${prefs.mirrorPrompter ? 'on' : ''}" id="pMirror">Mirror</button><button class="mini" id="pTop">⤒ Top</button>`;
    $('#pSpeed').oninput = (e) => { prefs.speed = Number(e.target.value); savePrefs(); };
    $('#pSize').oninput = (e) => { prefs.font = Number(e.target.value); savePrefs(); renderPrompter(); };
    $('#pMirror').onclick = () => { prefs.mirrorPrompter = !prefs.mirrorPrompter; savePrefs(); renderDock(); placePrompter(); };
    $('#pTop').onclick = () => { ui.prompterOffset = 0; placePrompter(); };
    renderPrompter();
  } else if (prefs.dock === 'edit') {
    const t = store.take(q);
    const fillers = t?.transcript ? fillerCuts(t).length : 0;
    tools.innerHTML = t ? (t.transcript
      ? `<button class="mini" id="eCut" title="Delete / Backspace">Cut words</button><button class="mini" id="eRestore">Restore</button><button class="mini" id="eFill" ${fillers ? '' : 'disabled'}>Remove ums (${fillers})</button><button class="mini" id="ePause">Tighten pauses</button><button class="mini" id="eTrim">Trim ends</button><button class="mini danger" id="eReset">Reset edits</button>`
      : `<button class="mini" id="eTrans">Transcribe this take</button><button class="mini" id="eTrim">Trim to speech</button>`) : '';
    const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
    on('eCut', () => cutSelection());
    on('eRestore', () => restoreSelection());
    on('eFill', () => { t.cuts = mergeRanges([...(t.cuts || []), ...fillerCuts(t)]); store.change('takes'); toast(`Removed ${fillers} filler word${fillers > 1 ? 's' : ''}.`); });
    on('ePause', () => { const c = pauseCuts(t); t.cuts = mergeRanges([...(t.cuts || []), ...c]); store.change('takes'); toast(c.length ? `Shortened ${c.length} long pause${c.length > 1 ? 's' : ''}.` : 'No long pauses found.'); });
    on('eTrim', () => { const [a, b] = autoTrim(t); t.in = a; t.out = b; store.change('takes'); });
    on('eReset', () => { t.cuts = []; const [a, b] = autoTrim(t); t.in = a; t.out = b; store.change('takes'); });
    on('eTrans', () => { enqueueTranscribe(q, t, true); toast('Transcribing this take…'); });
    renderWords(); drawEditWave();
  } else {
    tools.innerHTML = '';
    renderTakes();
  }
}

// ---- takes tab
function renderTakes() {
  const q = curQ();
  const host = $('#takes');
  if (!q.takes.length) { host.innerHTML = `<p class="hint" style="padding:6px">No takes yet. Press <kbd>Space</kbd> to ask Q${ui.qi + 1} and record the answer.</p>`; return; }
  const sel = store.take(q);
  host.innerHTML = q.takes.slice().reverse().map((t) => {
    const r = keptRanges(t);
    const f = t.transcript ? t.transcript.words.filter((w) => isFiller(w.w)).length : null;
    const text = t.transcript ? outputWords(t, r).map((w) => w.w).join(' ') : '';
    return `<div class="take ${t === sel ? 'on' : ''}" data-id="${t.id}"><div class="poster" style="background-image:url('${t.poster ? mediaUrl(store.abs(t.poster)) : ''}')"><b>TAKE ${t.n}</b><button class="star ${t.starred ? 'on' : ''}" data-star title="Mark as a keeper">★</button></div>
      <div class="meta"><div class="r"><span>${fmtTime(rangesDuration(r))} used · ${fmtTime(t.duration)} rec</span>${f != null ? `<span class="${f ? 'f' : ''}">${f} um${f === 1 ? '' : 's'}</span>` : '<span>no captions</span>'}</div><p>${esc(text.slice(0, 140)) || '<i style="opacity:.5">Not transcribed</i>'}</p></div>
      <div class="acts"><button class="mini ${t === sel ? 'on' : ''}" data-use>${t === sel ? 'In edit ✓' : 'Use take'}</button><button class="mini" data-show>Show file</button><button class="mini danger" data-del>Delete</button></div></div>`;
  }).join('');
  $$('.take', host).forEach((el) => {
    const t = q.takes.find((x) => x.id === el.dataset.id);
    el.onclick = (e) => {
      if (e.target.closest('[data-star]')) { t.starred = !t.starred; store.change('takes'); return; }
      if (e.target.closest('[data-show]')) return S.file.show(store.abs(t.file));
      if (e.target.closest('[data-del]')) return deleteTake(q, t);
      q.selectedTake = t.id; store.change('takes');
      ui.view = 'take'; loadTakeVideo(); renderTransport();
    };
  });
}
async function deleteTake(q, t) {
  if (!confirm(`Delete take ${t.n}? The video file will be removed.`)) return;
  q.takes = q.takes.filter((x) => x !== t);
  if (q.selectedTake === t.id) q.selectedTake = q.takes[q.takes.length - 1]?.id || null;
  for (const f of [t.file, t.peaks, t.poster]) if (f) S.file.remove(store.abs(f)).catch(() => {});
  if (!q.takes.length) ui.view = 'live';
  store.change('takes'); renderTransport();
}

// ---- edit tab: waveform + words
function loadTakeVideo() {
  const t = store.take(curQ());
  if (!t) return;
  const src = mediaUrl(store.abs(t.file));
  if (takeVideo.__src !== src) { takeVideo.__src = src; takeVideo.src = src; takeVideo.load(); }
  takeVideo.addEventListener('loadedmetadata', () => { if (takeVideo.currentTime < (t.in || 0)) takeVideo.currentTime = t.in || 0; }, { once: true });
  if (takeVideo.readyState >= 1) takeVideo.currentTime = t.in || 0;
}
function toggleTakePlay() {
  const t = store.take(curQ()); if (!t) return;
  if (takeVideo.paused) { const [a, b] = takeBounds(t); if (takeVideo.currentTime >= b - 0.05 || takeVideo.currentTime < a) takeVideo.currentTime = a; takeVideo.play(); } else takeVideo.pause();
  renderTransport();
}
takeVideo.addEventListener('pause', () => { if (ui.view === 'take') renderTransport(); });
async function drawEditWave() {
  if (prefs.dock !== 'edit') return;
  const t = store.take(curQ());
  const cv = $('#wave');
  if (!t) { drawPeaks(cv, null); return; }
  const pk = await loadPeaks(t.peaks);
  drawPeaks(cv, pk, { inT: t.in, outT: t.out, cuts: t.cuts || [], play: ui.view === 'take' ? takeVideo.currentTime : null });
}
(() => {
  const cv = $('#wave');
  let drag = null;
  const timeAt = (e) => { const t = store.take(curQ()); const r = cv.getBoundingClientRect(); return clamp(((e.clientX - r.left) / r.width) * (t.duration || 0), 0, t.duration || 0); };
  cv.addEventListener('mousedown', (e) => {
    const t = store.take(curQ()); if (!t) return;
    const r = cv.getBoundingClientRect();
    const px = (x) => (x / t.duration) * r.width + r.left;
    if (Math.abs(e.clientX - px(t.in)) < 8) drag = 'in';
    else if (Math.abs(e.clientX - px(t.out)) < 8) drag = 'out';
    else { drag = 'seek'; ui.view = 'take'; loadTakeVideo(); takeVideo.currentTime = timeAt(e); renderTransport(); }
  });
  window.addEventListener('mousemove', (e) => {
    const t = store.take(curQ()); if (!drag || !t) { if (t && prefs.dock === 'edit') { const r = cv.getBoundingClientRect(); const near = [t.in, t.out].some((x) => Math.abs(e.clientX - ((x / t.duration) * r.width + r.left)) < 8); cv.style.cursor = near ? 'ew-resize' : 'crosshair'; } return; }
    const x = timeAt(e);
    if (drag === 'in') t.in = Math.min(x, t.out - 0.2);
    else if (drag === 'out') t.out = Math.max(x, t.in + 0.2);
    else takeVideo.currentTime = x;
    if (drag !== 'seek') { takeVideo.currentTime = drag === 'in' ? t.in : t.out; drawEditWave(); renderWordsLite(); }
  });
  window.addEventListener('mouseup', () => { if (drag && drag !== 'seek') { store.take(curQ()).userTrim = true; store.change('takes'); } drag = null; });
})();
let wordsT = 0;
function renderWordsLite() { clearTimeout(wordsT); wordsT = setTimeout(renderWords, 120); }
function renderWords() {
  const host = $('#words');
  const q = curQ(), t = store.take(q);
  if (!t) { host.innerHTML = `<p class="empty-msg">No take for this question yet.</p>`; return; }
  if (!t.transcript) {
    const pending = tq.current?.take.id === t.id || tq.list.some((j) => j.take.id === t.id);
    host.innerHTML = `<p class="empty-msg">${pending ? 'Transcribing… the words appear here when it finishes.' : 'Not transcribed yet. Transcribe it to edit by text: click a word to jump there, select words and press Delete to cut them, double-click a word to fix its spelling.'}</p>`;
    return;
  }
  const words = t.transcript.words;
  const cuts = mergeRanges(t.cuts || []);
  const [a, b] = takeBounds(t);
  const parts = [];
  words.forEach((w, i) => {
    if (i > 0 && w.s - words[i - 1].e > 1.0) parts.push(`<span class="gap">${(w.s - words[i - 1].e).toFixed(1)}s</span>`);
    const mid = (w.s + w.e) / 2;
    const cut = cuts.some(([s, e]) => mid >= s && mid <= e);
    const out = mid < a || mid > b;
    const sel = ui.sel && i >= ui.sel[0] && i <= ui.sel[1];
    parts.push(`<span class="w ${isFiller(w.w) ? 'f' : ''} ${cut ? 'cut' : ''} ${out ? 'out' : ''} ${sel ? 'sel' : ''}" data-i="${i}">${esc(w.w)}</span>`);
  });
  host.innerHTML = parts.join(' ');
}
$('#words').addEventListener('click', (e) => {
  const el = e.target.closest('.w'); if (!el) return;
  const i = Number(el.dataset.i);
  const t = store.take(curQ());
  if (e.shiftKey && ui.anchor != null) ui.sel = [Math.min(ui.anchor, i), Math.max(ui.anchor, i)];
  else { ui.sel = [i, i]; ui.anchor = i; }
  ui.view = 'take'; loadTakeVideo();
  takeVideo.currentTime = t.transcript.words[i].s;
  renderWords(); renderTransport();
});
$('#words').addEventListener('dblclick', (e) => {
  const el = e.target.closest('.w'); if (!el) return;
  const t = store.take(curQ()), w = t.transcript.words[Number(el.dataset.i)];
  const inp = document.createElement('input');
  inp.className = 'inp'; inp.value = w.w; inp.style.cssText = `width:${Math.max(60, el.offsetWidth + 30)}px;display:inline-block;padding:1px 4px`;
  el.replaceWith(inp); inp.focus(); inp.select();
  const done = (save) => { if (save && inp.value.trim()) { w.w = inp.value.trim(); store.change('takes'); } renderWords(); };
  inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
  inp.onblur = () => done(true);
});
function selRange(t) {
  const w = t.transcript.words, [i, j] = ui.sel;
  const prev = w[i - 1], next = w[j + 1];
  const s = prev ? Math.max((prev.e + w[i].s) / 2, w[i].s - 0.15) : w[i].s - 0.1;
  const e = next ? Math.min((w[j].e + next.s) / 2, w[j].e + 0.15) : w[j].e + 0.1;
  return [Math.max(0, s), Math.min(t.duration, e)];
}
function cutSelection() {
  const t = store.take(curQ()); if (!t?.transcript || !ui.sel) return toast('Select words first (click, shift-click).', 'warn');
  t.cuts = mergeRanges([...(t.cuts || []), selRange(t)]);
  ui.sel = null; store.change('takes');
}
function restoreSelection() {
  const t = store.take(curQ()); if (!t?.transcript || !ui.sel) return toast('Select the struck-out words to bring back.', 'warn');
  const [s, e] = selRange(t);
  const out = [];
  for (const [a, b] of t.cuts || []) { if (b <= s || a >= e) out.push([a, b]); else { if (a < s) out.push([a, s]); if (b > e) out.push([e, b]); } }
  t.cuts = out; ui.sel = null; store.change('takes');
}

// ============================================================ program preview
const prog = { on: false, segs: [], i: -1, segT0: 0, ri: 0, t: 0 };
function startProgram() {
  if (sess.phase !== 'idle') return;
  const pr = buildProgram();
  if (!pr.segs.length) return toast('Nothing to preview yet — record some answers.', 'warn');
  prog.on = true; prog.segs = pr.segs; prog.i = -1;
  ui.view = 'program';
  if (P().music.file) { musicAudio.src = mediaUrl(store.abs(P().music.file)); musicAudio.currentTime = 0; musicAudio.play().catch(() => {}); }
  nextSeg();
  renderTransport();
  $('#playProgramBtn').textContent = '■ Stop';
}
function stopProgram() {
  if (!prog.on) return;
  prog.on = false; takeVideo.pause(); voiceAudio.pause(); musicAudio.pause();
  ui.view = 'live';
  $('#playProgramBtn').textContent = '▶ Preview';
  renderTransport(); renderStrip();
}
function nextSeg() {
  prog.i++;
  voiceAudio.pause();
  if (prog.i >= prog.segs.length) { stopProgram(); return; }
  const s = prog.segs[prog.i];
  prog.segT0 = performance.now();
  if (s.kind === 'card') {
    takeVideo.pause();
    if (s.voice) {
      const q = s.q;
      setTimeout(() => { if (prog.on && prog.segs[prog.i] === s) playVoice(q); }, s.voice.delay * 1000);
    }
  } else {
    prog.ri = 0;
    const src = mediaUrl(store.abs(s.take.file));
    if (takeVideo.__src !== src) { takeVideo.__src = src; takeVideo.src = src; }
    takeVideo.currentTime = s.ranges[0][0];
    takeVideo.play().catch(() => {});
    if (!musicAudio.paused) musicAudio.volume = P().music.answersVol;
  }
  if (s.kind === 'card' && !musicAudio.paused) musicAudio.volume = P().music.cardsVol;
}
function tickProgram(now) {
  const s = prog.segs[prog.i]; if (!s) return 0;
  if (s.kind === 'card') {
    const el = (now - prog.segT0) / 1000;
    if (el >= s.duration) nextSeg();
    return s.start + Math.min(el, s.duration);
  }
  const ct = takeVideo.currentTime;
  const r = s.ranges[prog.ri];
  if (ct >= r[1] - 0.02 || takeVideo.ended) {
    prog.ri++;
    if (prog.ri >= s.ranges.length) { nextSeg(); return s.start + s.duration; }
    takeVideo.currentTime = s.ranges[prog.ri][0];
  }
  return s.start + (mapTime(Math.min(ct, r[1]), s.ranges) ?? 0);
}

// ============================================================ monitor loop
function lowerThirdAlpha(p, qi, t, D) {
  if (!p.look.lowerThird || !p.guest.name) return 0;
  const first = p.questions.findIndex((q) => q.include && store.take(q));
  if (!p.look.lowerThirdEvery && qi !== first) return 0;
  const a = 0.6, b = Math.min(D - 0.3, 5.6);
  if (t < a || t > b) return 0;
  return Math.min(1, (t - a) / 0.35, (b - t) / 0.35);
}
function composeAnswer(ctx, W, H, p, qi, src, { mirror, t = null, D = 0, words = null, guides = false }) {
  if (p.look.layout === 'framed') drawFrameBg(ctx, W, H, p, qi);
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  drawCamera(ctx, W, H, p, src, { mirror });
  if (guides) drawGuides(ctx, W, H, p);
  if (t != null) drawLowerThird(ctx, W, H, p, lowerThirdAlpha(p, qi, t, D));
  drawBug(ctx, W, H, p);
  if (words && p.captions.burn && t != null) drawCaption(ctx, W, H, p, words, t);
}
let lastTick = 0, lastGuest = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = lastTick ? Math.min(0.1, (now - lastTick) / 1000) : 0; lastTick = now;
  sample(now);
  const p = P();
  if (!p || $('#studio').hidden) return;
  const W = screen.width, H = screen.height, ctx = sctx;
  // meters
  $('#meterBar').style.width = (dev.level * 100).toFixed(1) + '%';
  $('#meterPeak').style.left = clamp(((dev.peakHoldDb + 60) / 60) * 100, 0, 100).toFixed(1) + '%';
  if (batch.on) $('#batchMeter').style.width = (dev.level * 100).toFixed(1) + '%';
  // session timing
  if (sess.phase === 'ask' && now >= sess.askUntil) onAskDone();
  if (sess.phase === 'countdown' && now >= sess.countEnd) startAnswer();
  const q = curQ();
  let tag = 'LIVE', tagClass = 'live';
  const countEl = $('#countBig');
  countEl.hidden = true;
  if (sess.phase === 'ask') {
    drawCard(ctx, W, H, p, { kind: 'question', qi: sess.qi });
    tag = voiceAudio.paused ? 'QUESTION CARD' : 'ASKING ▸ VOICE'; tagClass = '';
  } else if (sess.phase === 'countdown' || sess.phase === 'answer' || sess.phase === 'saving' || (ui.view === 'live' && sess.phase === 'idle')) {
    const recT = sess.phase === 'answer' ? (now - sess.answerAt) / 1000 : 0;
    composeAnswer(ctx, W, H, p, ui.qi, camVideo, { mirror: !!p.look.mirror !== !!prefs.mirrorPreview, t: sess.phase === 'answer' ? recT : null, D: 999, guides: prefs.guides && sess.phase === 'idle' });
    if (sess.phase === 'countdown') { const n = Math.ceil((sess.countEnd - now) / 1000); countEl.hidden = false; countEl.className = 'count'; countEl.textContent = String(Math.max(1, n)); }
    if (sess.phase === 'answer' && now < sess.goUntil) { countEl.hidden = false; countEl.className = 'count go'; countEl.textContent = 'GO'; }
    tag = sess.phase === 'idle' ? 'LIVE' : 'RECORDING';
    if (!dev.cam) { tag = 'NO CAMERA'; }
  } else if (ui.view === 'take') {
    const t = store.take(q);
    if (t) {
      const ranges = keptRanges(t);
      const ct = takeVideo.currentTime;
      if (!takeVideo.paused) {
        const [a, b] = takeBounds(t);
        if (ct < a - 0.05) takeVideo.currentTime = a;
        else if (ct >= b) { takeVideo.pause(); takeVideo.currentTime = b; }
        else { const cut = mergeRanges(t.cuts || []).find(([s, e]) => ct >= s && ct < e - 0.02); if (cut) takeVideo.currentTime = cut[1]; }
      }
      const ot = mapTime(ct, ranges);
      composeAnswer(ctx, W, H, p, ui.qi, takeVideo, { mirror: p.look.mirror, t: ot ?? 0, D: rangesDuration(ranges), words: t.transcript ? outputWords(t, ranges) : null });
      const sc = $('#tScrub'); if (sc && document.activeElement !== sc) sc.value = ct;
      const tt = $('#tTime'); if (tt) tt.textContent = fmtTime(ct, true);
      const [ta, tb] = takeBounds(t);
      tag = `TAKE ${t.n}${ct < ta || ct > tb ? ' · OUTSIDE TRIM' : ot == null ? ' · CUT' : ''}`; tagClass = '';
      if (prefs.dock === 'edit' && (!takeVideo.paused || now - (ui.lastWave || 0) > 250)) { ui.lastWave = now; drawEditWave(); highlightWord(ct); }
    } else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  } else if (ui.view === 'program' && prog.on) {
    const pt = tickProgram(now);
    const s = prog.segs[prog.i];
    if (s?.kind === 'card') drawCard(ctx, W, H, p, s.card);
    else if (s) { const lt = pt - s.start; composeAnswer(ctx, W, H, p, s.qi, takeVideo, { mirror: p.look.mirror, t: lt, D: s.duration, words: s.take.transcript ? outputWords(s.take, s.ranges) : null }); }
    const tt = $('#tTime'); if (tt) tt.textContent = fmtTime(pt);
    tag = 'PROGRAM PREVIEW'; tagClass = '';
  } else if (ui.view === 'card') {
    drawCard(ctx, W, H, p, { kind: ui.cardKind });
    tag = ui.cardKind.toUpperCase() + ' CARD'; tagClass = '';
  }
  $('#modeTag').textContent = tag; $('#modeTag').className = 'tag ' + tagClass;
  $('#qTag').textContent = ui.view === 'program' ? '' : `Q${pad2((sess.phase !== 'idle' ? sess.qi : ui.qi) + 1)}`;
  // record HUD
  const recOn = sess.phase === 'countdown' || sess.phase === 'answer';
  $('#recTag').hidden = !recOn;
  const ans = sess.phase === 'answer' ? (now - sess.answerAt) / 1000 : 0;
  if (recOn) $('#recTime').textContent = fmtTime(ans);
  const target = P().questions[sess.qi]?.target || 0;
  const tEl = $('#targetTag');
  tEl.hidden = !(sess.phase === 'answer' && target);
  if (!tEl.hidden) { tEl.textContent = `TARGET ${fmtTime(target)}`; tEl.className = 'target ' + (ans > target ? 'over' : ans > target * 0.85 ? 'near' : ''); if (ans > target) tEl.textContent = 'WRAP IT UP'; }
  // prompter
  if (sess.phase === 'answer' && p.record.autoScroll && q?.mode === 'script') {
    if (isSpeaking()) ui.lastSpeak = now;
    const moving = !p.record.voicePace || now - ui.lastSpeak < 650;
    if (moving) { ui.prompterOffset += prefs.speed * dt * (prefs.font / 44); placePrompter(); }
  }
  // guest screen
  if (ui.guestOpen && now - lastGuest > 50) { lastGuest = now; sendGuest(now, ans, target); }
}
function highlightWord(ct) {
  const host = $('#words');
  const prev = $('.w.now', host); if (prev) prev.classList.remove('now');
  const t = store.take(curQ()); if (!t?.transcript) return;
  const i = t.transcript.words.findIndex((w) => ct >= w.s && ct < w.e + 0.05);
  if (i >= 0) { const el = $(`.w[data-i="${i}"]`, host); if (el) { el.classList.add('now'); if (!takeVideo.paused) el.scrollIntoView({ block: 'nearest' }); } }
}

// ============================================================ guest broadcast
function sendGuest(now, ans, target) {
  const p = P();
  const qi = sess.phase !== 'idle' ? sess.qi : ui.qi;
  const q = p.questions[qi];
  guest.postMessage({
    type: 'state', phase: sess.phase, qi, total: p.questions.filter((x) => x.include).length, number: qi + 1,
    question: q?.question || '', title: q?.title || '', mode: q?.mode, html: prompterHtml(q),
    progress: ui.prompterOffset / prompterMax(), count: sess.phase === 'countdown' ? Math.max(1, Math.ceil((sess.countEnd - now) / 1000)) : 0,
    go: sess.phase === 'answer' && now < sess.goUntil, elapsed: ans, target, font: prefs.font,
    accent: accentOf(p), style: p.look.style, guestName: p.guest.name, title2: p.title, mirror: !!prefs.guestMirror, asking: !voiceAudio.paused
  });
}

// ============================================================ export
function openExport() {
  if (sess.phase !== 'idle') return toast('Stop recording first.', 'warn');
  stopProgram();
  const p = P();
  const pr = buildProgram();
  $$('[data-fmt]').forEach((c) => (c.checked = c.dataset.fmt === p.aspect));
  $('#xBurn').checked = p.captions.burn;
  $('#xMusic').checked = !!p.music.file; $('#xMusic').disabled = !p.music.file;
  const noCap = pr.segs.filter((s) => s.kind === 'answer' && !s.take.transcript).length;
  $('#expList').innerHTML = pr.segs.map((s) => `<li><span class="k">${s.kind === 'card' ? (s.card.kind === 'question' ? `Q${pad2(s.qi + 1)} ASK` : s.card.kind.toUpperCase()) : `Q${pad2(s.qi + 1)} ANS`}</span><span>${esc(s.kind === 'card' ? (s.card.kind === 'question' ? (s.voice ? '🎙 ' : '') + s.q.question : s.card.kind === 'intro' ? p.intro.title || p.title : p.outro.title) : `Take ${s.take.n}${s.take.cuts?.length ? ` · ${s.take.cuts.length} cut${s.take.cuts.length > 1 ? 's' : ''}` : ''}${s.take.transcript ? '' : ' · no captions'}`)}</span><span class="d">${fmtTime(s.duration)}</span></li>`).join('')
    + pr.missing.map((q) => `<li class="warn"><span class="k">Q${pad2(p.questions.indexOf(q) + 1)}</span><span>No take — skipped</span><span class="d">—</span></li>`).join('')
    + (noCap ? `<li class="warn"><span class="k">CAPTIONS</span><span>${noCap} answer(s) not transcribed — they'll have no captions. <button class="mini" id="xTransAll">Transcribe now</button></span><span></span></li>` : '')
    + `<li class="total"><span class="k">TOTAL</span><span>${pr.segs.length} segments</span><span class="d">${fmtTime(pr.duration)}</span></li>`;
  const ta = $('#xTransAll'); if (ta) ta.onclick = () => { $('#transcribeAllBtn').click(); $('#exportDlg').close(); setPanel('captions'); };
  $('#expProgress').hidden = true; $('#expDone').hidden = true; $('#expGo').disabled = !pr.segs.some((s) => s.kind === 'answer');
  $('#expCancel').textContent = 'Close';
  $('#exportDlg').showModal();
}
$('#exportClose').onclick = () => $('#expCancel').click();
let exporting = false;
$('#expCancel').onclick = async () => { if (exporting) { await S.exporter.cancel(); return; } $('#exportDlg').close(); };
$('#exportDlg').addEventListener('cancel', (e) => { if (exporting) e.preventDefault(); });
let expCtx = { fmt: '', fi: 0, fn: 1 };
function onExportProgress(pg) {
  const overall = (expCtx.fi + (pg.progress || 0)) / expCtx.fn;
  $('#expBar').style.width = (overall * 100).toFixed(1) + '%';
  $('#expLabel').textContent = `${expCtx.fmt} · ${pg.label}${pg.count ? ` (${pg.index + 1}/${pg.count})` : ''} · ${Math.round(overall * 100)}%`;
}
const fileSafe = (s) => String(s || 'Interview').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70);
$('#expGo').onclick = async () => {
  const p = P();
  const fmts = $$('[data-fmt]').filter((c) => c.checked).map((c) => c.dataset.fmt);
  if (!fmts.length) return toast('Pick at least one format.', 'warn');
  const opts = { clips: $('#xClips').checked, burn: $('#xBurn').checked, docs: $('#xDocs').checked, music: $('#xMusic').checked && !!p.music.file };
  exporting = true;
  $('#expGo').disabled = true; $('#expCancel').textContent = 'Cancel export';
  $('#expProgress').hidden = false; $('#expDone').hidden = true;
  const results = [];
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
  const base = fileSafe(p.title);
  try {
    await store.save();
    const program = buildProgram();
    for (let fi = 0; fi < fmts.length; fi++) {
      expCtx = { fmt: fmts[fi], fi, fn: fmts.length };
      onExportProgress({ label: 'Rendering graphics', progress: 0 });
      const res = await exportFormat(fmts[fi], program, opts, `${base} ${fmts[fi].replace(':', 'x')}`, stamp);
      results.push(res);
    }
    if (opts.docs) {
      const d = programDocs(program);
      const dir = store.abs('exports');
      const sep = store.sep;
      await S.file.write(`${dir}${sep}${base}.srt`, d.srt);
      await S.file.write(`${dir}${sep}${base} - chapters.txt`, d.chapters);
      await S.file.write(`${dir}${sep}${base} - transcript.txt`, d.transcript);
      results.push({ outFile: `${dir}${sep}${base}.srt`, doc: true });
    }
    $('#expBar').style.width = '100%';
    $('#expLabel').textContent = 'Done.';
    $('#expDone').hidden = false;
    $('#expDone').innerHTML = results.map((r) => `<div class="f"><span>${esc(r.outFile.split(/[\\/]/).pop())}${r.clips?.length ? ` + ${r.clips.length} clips` : ''}${r.doc ? ' + chapters + transcript' : ''}</span><span><button class="mini" data-open="${esc(r.outFile)}">${r.doc ? 'Show' : 'Play'}</button> <button class="mini" data-show="${esc(r.outFile)}">Show in folder</button></span></div>`).join('');
    $$('#expDone [data-open]').forEach((b) => (b.onclick = () => (b.textContent === 'Show' ? S.file.show(b.dataset.open) : S.file.open(b.dataset.open))));
    $$('#expDone [data-show]').forEach((b) => (b.onclick = () => S.file.show(b.dataset.show)));
    toast('Export finished.');
  } catch (e) {
    $('#expLabel').textContent = /cancel/i.test(e.message) ? 'Export cancelled.' : 'Export failed: ' + e.message;
    if (!/cancel/i.test(e.message)) toast('Export failed — see the export window.', 'error');
    console.error(e);
  } finally {
    exporting = false;
    $('#expGo').disabled = false; $('#expCancel').textContent = 'Close';
  }
};

async function exportFormat(fmt, program, opts, name, stamp) {
  const p = P();
  const [W, H] = ASPECTS[fmt];
  const sep = store.sep;
  const exportsDir = store.abs('exports');
  const buildDir = `${exportsDir}${sep}.build-${fmt.replace(':', 'x')}-${Date.now().toString(36)}`;
  const view = { ...p, aspect: fmt };
  await logoReady(p.look.logoUrl);
  const write = async (file, bytes) => { await S.file.write(`${buildDir}${sep}${file}`, bytes); return `${buildDir}${sep}${file}`; };
  const segments = [];
  const firstAnswerQi = program.segs.find((s) => s.kind === 'answer')?.qi;
  const r = camRect(view, W, H);
  const bug = p.look.bug ? await write('bug.png', await canvasPng(W, H, (c) => drawBug(c, W, H, view))) : null;
  const lt = p.look.lowerThird && p.guest.name ? await write('lowerthird.png', await canvasPng(W, H, (c) => drawLowerThird(c, W, H, view, 1))) : null;
  const mask = view.look.layout === 'framed' ? await write('mask.png', await canvasPng(Math.round(r.w / 2) * 2, Math.round(r.h / 2) * 2, (c) => drawMask(c, Math.round(r.w / 2) * 2, Math.round(r.h / 2) * 2, r.r))) : null;
  for (let i = 0; i < program.segs.length; i++) {
    const s = program.segs[i];
    if (s.kind === 'card') {
      const png = await write(`card-${i}.png`, await canvasPng(W, H, (c) => drawCard(c, W, H, view, s.card)));
      segments.push({ id: s.id, kind: 'card', png, duration: s.duration, voice: s.voice, label: s.label, fadeIn: i === 0 ? 0.5 : 0.25, fadeOut: 0.25 });
    } else {
      const seg = { id: s.id, kind: 'answer', file: store.abs(s.take.file), ranges: s.ranges, duration: s.duration, label: s.label, mirror: !!p.look.mirror, overlays: [], fadeIn: 0.2, fadeOut: i === program.segs.length - 1 ? 0.6 : 0.2 };
      seg.cam = { x: r.x, y: r.y, w: r.w, h: r.h, cropX: p.look.mirror ? 1 - (p.look.cropX ?? 0.5) : p.look.cropX ?? 0.5, cropY: p.look.cropY ?? 0.5 };
      if (view.look.layout === 'framed') { seg.bg = await write(`bg-${i}.png`, await canvasPng(W, H, (c) => drawFrameBg(c, W, H, view, s.qi))); seg.mask = mask; }
      if (lt && (p.look.lowerThirdEvery || s.qi === firstAnswerQi)) seg.overlays.push({ png: lt, start: 0.6, end: Math.min(s.duration - 0.3, 5.6), fade: 0.35 });
      if (bug) seg.overlays.push({ png: bug });
      if (opts.burn && s.take.transcript?.words?.length) {
        const ass = buildAss(outputWords(s.take, s.ranges), { W, H, style: p.captions.style, accent: accentOf(p), geo: { ...captionGeo(view, W, H), fontRatio: fontRatios() } });
        await write(`cap-${i}.ass`, ass);
        seg.ass = `cap-${i}.ass`;
      }
      segments.push(seg);
    }
  }
  const plan = {
    projectDir: store.dir, buildDir, outFile: `${exportsDir}${sep}${name}.mp4`, width: W, height: H, fontsDir: 'builtin',
    segments, audio: { normalize: p.audio.normalize, denoise: p.audio.denoise, lufs: p.audio.lufs },
    music: opts.music ? { file: store.abs(p.music.file), cardsVol: p.music.cardsVol, answersVol: p.music.answersVol, windows: program.segs.filter((s) => s.kind === 'card').map((s) => [s.start, s.start + s.duration]) } : null,
    clips: opts.clips ? program.segs.filter((s) => s.kind === 'answer').map((s) => ({ name: `Q${pad2(s.qi + 1)} - ${fileSafe(s.q.title || s.q.question).slice(0, 50)}.mp4`, segmentIds: [s.q.id + '-card', s.id] })) : null,
    clipsDir: `${exportsDir}${sep}${name} - clips`
  };
  return S.exporter.run(plan);
}

// ============================================================ keyboard
window.addEventListener('keydown', (e) => {
  if ($('#studio').hidden || $('dialog[open]')) return;
  const typing = e.target.closest('input, textarea, select, [contenteditable]');
  if (typing && e.key !== 'Escape') return;
  if (typing && e.key === 'Escape') { e.target.blur(); return; }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (batch.on) { if ([' ', 'r', 'p', 'Escape'].includes(k)) { e.preventDefault(); batchKey(k); } return; }
  if (k === ' ') {
    e.preventDefault();
    if (sess.phase === 'ask') return onAskDone();
    if (sess.phase === 'countdown' || sess.phase === 'answer') return finishTake(P().record.runAll ? 'next' : 'stay');
    if (sess.phase === 'idle') { if (ui.view === 'take' && prefs.dock === 'edit') return toggleTakePlay(); if (ui.view === 'program') return stopProgram(); return beginQuestion(ui.qi); }
  }
  if (k === 'r' && (sess.phase === 'countdown' || sess.phase === 'answer')) return finishTake('retake');
  if (k === 'Escape') { if (sess.phase === 'ask') return cancelAsk(); if (sess.phase !== 'idle') return finishTake('stop'); if (ui.view === 'program') return stopProgram(); }
  if (sess.phase !== 'idle') return;
  if (k === 'ArrowRight') return selectQuestion(ui.qi + 1);
  if (k === 'ArrowLeft') return selectQuestion(ui.qi - 1);
  if (k === 'p') return playVoice();
  if (k === 'g') { prefs.guides = !prefs.guides; savePrefs(); $('#guidesChk').checked = prefs.guides; return; }
  if ((k === 'Delete' || k === 'Backspace') && prefs.dock === 'edit') { e.preventDefault(); return cutSelection(); }
});

// expose for automated self-tests
window.__rmt = { store, ui, sess, dev, prog, buildProgram, beginQuestion, finishTake, onAskDone, openBatch, batchKey, exportFormat, enqueueTranscribe, tq, selectQuestion, setDock, setPanel, startProgram, stopProgram, openProject, connectDevices };
