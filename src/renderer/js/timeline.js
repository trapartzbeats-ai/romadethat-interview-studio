// Edit maths: kept ranges, text-based cuts, filler detection, the program timeline,
// caption line building, ASS (burn-in) and SRT generation. One source of truth for
// preview and export.
import { store } from './store.js';

export const FILLER = /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+|uh-huh)$/i;
export const bare = (w) => String(w || '').toLowerCase().replace(/[^a-z'-]/g, '');
export const isFiller = (w) => FILLER.test(bare(w));

export function mergeRanges(list) {
  const s = list.filter((r) => r[1] > r[0]).map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of s) { const l = out[out.length - 1]; if (l && r[0] <= l[1] + 0.001) l[1] = Math.max(l[1], r[1]); else out.push(r); }
  return out;
}

export function takeBounds(take) {
  const dur = take.duration || 0;
  const a = Math.max(0, Math.min(take.in ?? 0, dur));
  const b = Math.max(a, Math.min(take.out ?? dur, dur));
  return [a, b];
}

// Source ranges that survive trims and cuts.
export function keptRanges(take) {
  const [a, b] = takeBounds(take);
  let ranges = [[a, b]];
  for (const [cs, ce] of mergeRanges(take.cuts || [])) {
    const next = [];
    for (const [s, e] of ranges) {
      if (ce <= s || cs >= e) { next.push([s, e]); continue; }
      if (cs > s) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    ranges = next;
  }
  return ranges.filter((r) => r[1] - r[0] > 0.05);
}
export const rangesDuration = (r) => r.reduce((s, x) => s + x[1] - x[0], 0);

// Map a source time into the edited (output) time; null when it was cut.
export function mapTime(t, ranges) {
  let acc = 0;
  for (const [s, e] of ranges) { if (t >= s && t <= e) return acc + (t - s); acc += e - s; }
  return null;
}
export function unmapTime(o, ranges) {
  let acc = 0;
  for (const [s, e] of ranges) { const len = e - s; if (o <= acc + len) return s + (o - acc); acc += len; }
  return ranges.length ? ranges[ranges.length - 1][1] : 0;
}

export function outputWords(take, ranges = keptRanges(take)) {
  const words = take.transcript?.words || [];
  const out = [];
  for (const w of words) {
    const mid = (w.s + w.e) / 2;
    const ms = mapTime(mid, ranges);
    if (ms == null) continue;
    const s = mapTime(w.s, ranges) ?? ms - (mid - w.s);
    const e = mapTime(w.e, ranges) ?? ms + (w.e - mid);
    out.push({ w: w.w, s: Math.max(0, s), e: Math.max(s + 0.05, e) });
  }
  return out;
}

// ---- edit helpers ----
export function fillerCuts(take) {
  const words = take.transcript?.words || [];
  const cuts = [];
  words.forEach((w, i) => {
    if (!isFiller(w.w)) return;
    const prev = words[i - 1], next = words[i + 1];
    const s = Math.max(prev ? prev.e : w.s - 0.1, w.s - 0.08);
    const e = Math.min(next ? next.s : w.e + 0.1, w.e + 0.06);
    cuts.push([s, e]);
  });
  return cuts;
}
export function pauseCuts(take, maxGap = 0.9, keep = 0.45) {
  const words = take.transcript?.words || [];
  const [a, b] = takeBounds(take);
  const cuts = [];
  for (let i = 1; i < words.length; i++) {
    const gs = words[i - 1].e, ge = words[i].s;
    if (gs < a || ge > b) continue;
    if (ge - gs > maxGap) { const half = keep / 2; cuts.push([gs + half, ge - half]); }
  }
  return cuts;
}
export function autoTrim(take) {
  const words = take.transcript?.words || [];
  const dur = take.duration || 0;
  if (words.length) {
    const first = words.find((w) => !isFiller(w.w)) || words[0];
    return [Math.max(0, first.s - 0.3), Math.min(dur, words[words.length - 1].e + 0.45)];
  }
  return [Math.max(0, (take.speechStart ?? 0) - 0.3), Math.min(dur, (take.speechEnd ?? dur) + 0.45)];
}

// ---- program ----
export function voiceLen(v) { return v ? Math.max(0, (v.out ?? v.duration) - (v.in ?? 0)) : 0; }

export function buildProgram(p = store.data) {
  const segs = [];
  const minCard = p.record.cardSeconds || 4;
  if (p.intro.enabled) segs.push({ id: 'intro', kind: 'card', card: { kind: 'intro' }, duration: Math.max(1.5, p.intro.seconds || 4), label: 'Intro' });
  const missing = [];
  p.questions.forEach((q, qi) => {
    if (!q.include) return;
    const take = store.take(q);
    if (!take) { missing.push(q); return; }
    const vlen = voiceLen(q.voice);
    const delay = 0.45;
    const cardDur = q.voice ? Math.max(2.2, vlen + delay + 0.7) : minCard;
    segs.push({ id: q.id + '-card', kind: 'card', qi, q, card: { kind: 'question', qi }, duration: cardDur, voice: q.voice ? { file: store.abs(q.voice.file), start: q.voice.in ?? 0, end: q.voice.out ?? q.voice.duration, delay } : null, label: `Q${qi + 1} card` });
    const ranges = keptRanges(take);
    segs.push({ id: q.id + '-answer', kind: 'answer', qi, q, take, ranges, duration: rangesDuration(ranges), label: `Q${qi + 1} answer` });
  });
  if (p.outro.enabled) segs.push({ id: 'outro', kind: 'card', card: { kind: 'outro' }, duration: Math.max(1.5, p.outro.seconds || 4), label: 'Outro' });
  let t = 0;
  for (const s of segs) { s.start = t; t += s.duration; }
  return { segs, duration: t, missing };
}

// ---- caption lines ----
export function captionLines(words, { maxChars = 30, maxDur = 4.2, gap = 0.65 } = {}) {
  const lines = [];
  let cur = null;
  for (const w of words) {
    const text = w.w.trim();
    if (!text) continue;
    const len = cur ? cur.words.reduce((s, x) => s + x.w.length + 1, 0) : 0;
    const prev = cur?.words[cur.words.length - 1];
    const brk = !cur || len + text.length > maxChars || w.s - prev.e > gap || w.e - cur.s > maxDur || (/[.?!]$/.test(prev.w) && cur.words.length >= 3);
    if (brk) { cur = { s: w.s, e: w.e, words: [] }; lines.push(cur); }
    cur.words.push({ w: text, s: w.s, e: w.e });
    cur.e = w.e;
  }
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    lines[i].e = next ? Math.min(Math.max(lines[i].e + 0.25, lines[i].e), next.s) : lines[i].e + 0.35;
  }
  return lines;
}

export const CAPTION_STYLES = {
  bold: { label: 'Bold pop', font: 'Anton', upper: true, size: 64, active: true, box: false, outline: 5 },
  clean: { label: 'Clean', font: 'Inter', upper: false, size: 46, active: false, box: true, outline: 0 },
  minimal: { label: 'Minimal', font: 'Inter', upper: false, size: 38, active: false, box: false, outline: 3 }
};

function assColor(hex, alpha = 0) {
  const h = hex.replace('#', '');
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
}
function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), cs = Math.floor((t % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
const assText = (s) => String(s).replace(/[{}]/g, '').replace(/\\/g, '/');

// geometry is shared with the canvas preview: {x, y(bottom), size}
export function buildAss(words, { W, H, style = 'bold', accent = '#C8FF2E', geo }) {
  const st = CAPTION_STYLES[style] || CAPTION_STYLES.bold;
  const portrait = H > W;
  const lines = captionLines(words, { maxChars: portrait ? 18 : st.upper ? 26 : 34 });
  // ASS sizes a font by its full line height (ascent + descent); canvas by its em. Convert so both match.
  const size = Math.round(geo.size * (geo.fontRatio?.[st.font] || 1));
  const outline = Math.round((st.outline * size) / st.size);
  const border = st.box ? 3 : 1;
  const back = st.box ? assColor('#000000', 0x40) : assColor('#000000', 0x80);
  const head = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Cap,${st.font},${size},&H00FFFFFF,&H00FFFFFF,${st.box ? assColor('#000000', 0x40) : '&H00000000'},${back},${st.font === 'Inter' ? -1 : 0},0,0,0,100,100,${st.upper ? 1 : 0},0,${border},${st.box ? Math.round(size * 0.28) : outline},0,2,40,40,40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const pos = `{\\pos(${Math.round(geo.x)},${Math.round(geo.y)})}`;
  const ev = [];
  for (const line of lines) {
    const toks = line.words.map((w) => assText(st.upper ? w.w.toUpperCase() : w.w));
    if (st.active) {
      line.words.forEach((w, i) => {
        const s = i === 0 ? line.s : w.s;
        const e = i === line.words.length - 1 ? line.e : line.words[i + 1].s;
        if (e - s < 0.01) return;
        const txt = toks.map((t, j) => (j === i ? `{\\c${assColor(accent)}}${t}{\\c&H00FFFFFF&}` : t)).join(' ');
        ev.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Cap,,0,0,0,,${pos}${txt}`);
      });
    } else ev.push(`Dialogue: 0,${assTime(line.s)},${assTime(line.e)},Cap,,0,0,0,,${pos}${toks.join(' ')}`);
  }
  return head + ev.join('\n') + '\n';
}

function srtTime(t) {
  const ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function buildSrt(entries) {
  return entries.map((e, i) => `${i + 1}\n${srtTime(e.s)} --> ${srtTime(Math.max(e.e, e.s + 0.3))}\n${e.text}\n`).join('\n');
}

// Program-wide caption entries (questions as text + answer lines), chapters and transcript.
export function programDocs(program, p = store.data) {
  const srt = [];
  const chapters = [];
  const transcript = [`${p.title}${p.guest.name ? ' — with ' + p.guest.name : ''}`, ''];
  for (const s of program.segs) {
    if (s.kind === 'card') {
      if (s.card.kind === 'intro') chapters.push([s.start, 'Intro']);
      if (s.card.kind === 'question') {
        chapters.push([s.start, s.q.title || s.q.question]);
        srt.push({ s: s.start + 0.2, e: s.start + s.duration - 0.2, text: s.q.question });
        transcript.push(`Q${s.qi + 1}. ${s.q.question}`, '');
      }
      if (s.card.kind === 'outro') chapters.push([s.start, 'Outro']);
    } else {
      const words = outputWords(s.take, s.ranges);
      for (const l of captionLines(words, { maxChars: 42 })) srt.push({ s: s.start + l.s, e: s.start + l.e, text: l.words.map((w) => w.w).join(' ') });
      transcript.push(words.length ? words.map((w) => w.w).join(' ').replace(/\s+([,.?!])/g, '$1') : '(not transcribed yet)', '');
    }
  }
  const fmt = (t) => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, '0')}`; };
  if (chapters.length && chapters[0][0] > 0) chapters.unshift([0, 'Start']);
  return {
    srt: buildSrt(srt),
    chapters: chapters.map(([t, n]) => `${fmt(t)} ${n}`).join('\n') + '\n',
    transcript: transcript.join('\n')
  };
}
