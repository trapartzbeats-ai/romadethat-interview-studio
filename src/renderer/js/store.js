// Project model, persistence and small shared helpers.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const uid = (p = '') => p + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const pad2 = (n) => String(n).padStart(2, '0');
export function fmtTime(t, tenths = false) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${pad2(s)}${tenths ? '.' + Math.floor((t % 1) * 10) : ''}`;
}
export function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function mediaUrl(abs) { return abs ? 'media://file/' + encodeURIComponent(abs) : ''; }

const SAMPLE = [
  ['Starting RoMadeThat', 'What inspired you to start RoMadeThat?', `What's going on? I'm Ro, the creator behind RoMadeThat.\n\nI do a little bit of everything when it comes to technology and creative work. Software development, audio engineering, graphic design, stuff like that.\n\nRoMadeThat really started because I was already doing all these different things, and I wanted one name that could represent all of it.\n\nPlus, the name just made sense. Somebody sees something I built or hears something I worked on, and it's like, "Oh, Ro made that." Simple as that.`],
  ['Who Notebooks Was For', 'Who did you have in mind when you designed Notebooks to work offline?', `One of the projects I've worked on is an app called Notebooks.\n\nThe whole idea was to make reading digital books feel more like having your own personal library.\n\nI wanted people to be able to open their books, read offline, and pick up wherever they left off without having to deal with a bunch of unnecessary stuff.`],
  ['A Difficult Project', 'Can you tell us about a project that turned out to be harder than you expected?', `But I'll tell you, that project taught me something.\n\nWhen you're building software, it's easy to get carried away with features.\n\nYou start thinking of all the things you can add instead of what actually needs to be there.\n\nThat's pretty much what happened with Notebooks.\n\nAt one point, I had so much going on that even I was looking at it like, "Man, I'm just trying to read a book."`],
  ['Moving Forward', 'How did you work through those challenges?', `So I had to rethink some things.\n\nInstead of looking at it like the developer, I started looking at it like somebody who was actually going to use it.\n\nCan I find my book? Can I get back to where I stopped reading? Is everything where it needs to be?\n\nThat helped me figure out what was important and what wasn't.`],
  ['Software & Sound', 'How does your experience with audio influence the way you develop software?', `And that's actually something I carry over from working with music.\n\nWhen you're mixing a song, everything doesn't need to be front and center.\n\nYou have to know what should stand out, what needs to sit in the background, and what might not even need to be there.\n\nSoftware is kind of the same way.\n\nJust because you can add something doesn't mean you should.`],
  ['Showing Your Projects', 'When you show somebody a new project, what do you usually show them first?', `That's also why, when I show somebody something I've built, I don't really start by explaining all the technical stuff.\n\nMost people don't care about all that. They want to know what it does and whether it's useful to them.\n\nSo I'd rather show somebody how something works first.\n\nThen, if they want to know how I built it, we can get into all that.`],
  ['Making an Impact', 'What kind of impact do you want RoMadeThat to have?', `As far as RoMadeThat goes, I really just want to keep building things that people can actually use.\n\nWhether that's software, music tools, or something creative, the goal is to make somebody's process easier or give them more room to create.`],
  ['Advice for Beginners', 'What advice would you give somebody who is just getting started?', `And if I had to give advice to somebody just getting started, I'd say don't get so caught up trying to build the biggest or greatest thing right out the gate.\n\nStart with something small.\n\nMake something that actually works.\n\nLet somebody use it, see what they like, see what they don't, and build from there.\n\nBecause one thing I've learned is that building something and building something people actually want to use are two different things.\n\nAnd that's really what I try to keep in mind with everything I make.`]
];

export function newQuestion(title = 'New question', question = '', script = '') {
  return { id: uid('q'), title, question, script, notes: '', mode: script ? 'script' : 'points', target: 60, include: true, voice: null, takes: [], selectedTake: null };
}

export function newProject({ title = 'Untitled Interview', guest = '', role = '', sample = false } = {}) {
  const questions = sample ? SAMPLE.map(([t, q, a]) => newQuestion(t, q, a)) : [newQuestion('Opening', 'Tell us who you are and what you do.', '')];
  return {
    version: 2, app: 'RoMadeThat Interview Studio', created: new Date().toISOString(),
    title, guest: { name: guest, role },
    aspect: '16:9',
    questions,
    intro: { enabled: true, seconds: 4, title, kicker: 'An RMT Interview' },
    outro: { enabled: true, seconds: 4, title: 'Thank you', line: 'romadethat' },
    look: { style: 'street', accent: '#C8FF2E', layout: 'full', lowerThird: true, lowerThirdEvery: false, bug: true, logo: null, cropX: 0.5, cropY: 0.4, mirror: false },
    captions: { burn: true, style: 'bold', model: 'Xenova/whisper-base.en', auto: true },
    music: { file: null, cardsVol: 0.35, answersVol: 0.06 },
    record: { countdown: 3, cardSeconds: 4, playVoice: true, runAll: false, autoScroll: true, voicePace: true },
    audio: { normalize: true, denoise: false, lufs: -16 }
  };
}

// --- store ---
const listeners = new Set();
export const store = {
  dir: null,
  data: null,
  dirty: false,
  saveTimer: 0,
  sep: '\\',
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(what = 'all') { for (const fn of listeners) fn(what); },
  load(dir, data) {
    this.dir = dir; this.sep = dir.includes('\\') ? '\\' : '/';
    const base = newProject();
    this.data = { ...base, ...data, look: { ...base.look, ...data.look }, captions: { ...base.captions, ...data.captions }, music: { ...base.music, ...data.music }, record: { ...base.record, ...data.record }, audio: { ...base.audio, ...data.audio }, intro: { ...base.intro, ...data.intro }, outro: { ...base.outro, ...data.outro }, guest: { ...base.guest, ...data.guest } };
    this.data.questions = (data.questions || []).map((q) => ({ ...newQuestion(), ...q, takes: (q.takes || []).map((t) => ({ cuts: [], ...t })) }));
    if (!this.data.questions.length) this.data.questions.push(newQuestion());
    this.emit('load');
  },
  abs(rel) { if (!rel) return null; if (/^([a-z]:[\\/]|\/)/i.test(rel)) return rel; return this.dir + this.sep + rel.replace(/[\\/]/g, this.sep); },
  rel(abs) { if (!abs) return null; const d = this.dir + this.sep; return abs.startsWith(d) ? abs.slice(d.length).replace(/\\/g, '/') : abs; },
  change(what = 'all') { this.dirty = true; clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.save(), 600); this.emit(what); },
  async save() {
    clearTimeout(this.saveTimer);
    if (!this.dir || !this.data) return;
    this.dirty = false;
    try { await window.studio.project.save(this.dir, this.data); } catch (e) { console.error('save failed', e); this.dirty = true; }
  },
  q(i) { return this.data.questions[i]; },
  take(q) { return q?.takes.find((t) => t.id === q.selectedTake) || q?.takes[q.takes.length - 1] || null; }
};

// --- prefs (per machine) ---
const PREF_KEY = 'rmt-studio-prefs-v2';
export const prefs = Object.assign({ camera: '', mic: '', voiceMic: '', quality: '1080', speed: 34, font: 44, mirrorPrompter: false, guides: true, noiseSuppression: true, autoGain: false, guestDisplay: null, guestMirror: false, panel: 'questions', dock: 'prompter' }, (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}'); } catch { return {}; } })());
export function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} }

// --- toasts ---
export function toast(msg, kind = 'info', ms = 3600) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); }, ms);
}

// Parse a script file: our JSON, the MVP's JSON, or plain text (one question per line / "Q:" "A:" blocks).
export function parseScript(text) {
  try {
    const j = JSON.parse(text);
    const list = Array.isArray(j) ? j : j.questions || j.project;
    if (Array.isArray(list)) return list.map((v, i) => newQuestion(String(v.title || `Question ${i + 1}`), String(v.question || ''), String(v.script ?? v.answer ?? '')));
  } catch {}
  const out = [];
  for (const b of text.split(/\r?\n/)) {
    const line = b.trim();
    if (!line) continue;
    const m = /^(?:Q\d*[:.)]|\d+[.)])\s*(.+)$/i.exec(line);
    if (m) out.push(newQuestion(m[1].slice(0, 40), m[1], ''));
    else if (/^A[:.)]/i.test(line) && out.length) { const q = out[out.length - 1]; q.script += (q.script ? '\n' : '') + line.replace(/^A[:.)]\s*/i, ''); q.mode = 'script'; }
    else if (out.length && out[out.length - 1].script) out[out.length - 1].script += '\n' + line;
    else if (line.endsWith('?')) out.push(newQuestion(line.slice(0, 40), line, ''));
  }
  return out;
}
