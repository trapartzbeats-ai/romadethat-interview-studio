// Every pixel of the look: cards, framed backgrounds, camera placement, lower third, logo bug,
// captions and guides. The monitor preview and the export PNGs use these same functions,
// so what you see is what you export.
import { captionLines, CAPTION_STYLES } from './timeline.js';
import { pad2 } from './store.js';

export const STYLES = {
  street: { label: 'Street Editorial', bg: '#0A0A0B', ink: '#FFFFFF', sub: '#8B8B94', head: 'Anton', upper: true },
  cinematic: { label: 'Cinematic Gold', bg: '#0A0E18', ink: '#F7F0E3', sub: '#9EA6B8', head: 'Playfair Display', upper: false, fixedAccent: '#E2B867' },
  clean: { label: 'Clean Studio', bg: '#F1EEE7', ink: '#111113', sub: '#6E6E74', head: 'Inter', upper: false },
  neon: { label: 'Neon Gradient', bg: '#0C0620', ink: '#FFFFFF', sub: '#BDB5EA', head: 'Inter', upper: false }
};
export const accentOf = (p) => STYLES[p.look.style]?.fixedAccent || p.look.accent || '#C8FF2E';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const unit = (W, H) => Math.min(W, H) / 1080;

export function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ---------------------------------------------------------------- text helpers
export function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const trial = line ? line + ' ' + word : word;
      if (ctx.measureText(trial).width > maxW && line) { out.push(line); line = word; } else line = trial;
    }
    if (line) out.push(line);
  }
  return out;
}
function fit(ctx, text, fontFn, maxW, maxLines, maxSize, minSize, maxH = Infinity, lh = 1.05) {
  let size = maxSize, lines;
  for (;;) {
    ctx.font = fontFn(size);
    lines = wrap(ctx, text, maxW);
    const widest = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    if ((lines.length <= maxLines && lines.length * size * lh <= maxH && widest <= maxW) || size <= minSize) break;
    size = Math.max(minSize, size * 0.92);
  }
  return { lines: lines.slice(0, Math.max(maxLines, 1)), size };
}

// ---------------------------------------------------------------- backgrounds
function paintBg(ctx, W, H, p) {
  const st = STYLES[p.look.style] || STYLES.street;
  const acc = accentOf(p);
  ctx.fillStyle = st.bg;
  ctx.fillRect(0, 0, W, H);
  if (p.look.style === 'street') {
    // accent slab: a right-hand wedge in landscape/square, a top band in portrait (text never crosses its edge)
    const [a, b] = H > W ? [[0, H * 0.36], [W, H * 0.2]] : [[W * 0.78, 0], [W * 0.6, H]];
    ctx.fillStyle = hexA(acc, 0.06);
    ctx.beginPath();
    if (H > W) { ctx.moveTo(0, 0); ctx.lineTo(W, 0); ctx.lineTo(b[0], b[1]); ctx.lineTo(a[0], a[1]); }
    else { ctx.moveTo(a[0], a[1]); ctx.lineTo(W, 0); ctx.lineTo(W, H); ctx.lineTo(b[0], b[1]); }
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = hexA(acc, 0.45); ctx.lineWidth = Math.max(1, 3 * unit(W, H));
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    // fine grain lines
    ctx.strokeStyle = 'rgba(255,255,255,0.025)'; ctx.lineWidth = 1;
    for (let y = 0; y < H; y += Math.max(3, 4 * unit(W, H))) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  } else if (p.look.style === 'cinematic') {
    const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    g.addColorStop(0, '#1C2640'); g.addColorStop(0.55, '#0D1322'); g.addColorStop(1, '#05070C');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const u = unit(W, H);
    ctx.strokeStyle = hexA(acc, 0.32); ctx.lineWidth = Math.max(1, 1.5 * u);
    ctx.strokeRect(36 * u, 36 * u, W - 72 * u, H - 72 * u);
  } else if (p.look.style === 'neon') {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0C0620'); g.addColorStop(1, '#140B3A');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const blob = (x, y, r, c) => { const b = ctx.createRadialGradient(x, y, 0, x, y, r); b.addColorStop(0, c); b.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = b; ctx.fillRect(0, 0, W, H); };
    blob(W * 0.86, H * 0.12, Math.max(W, H) * 0.6, 'rgba(132,64,255,0.55)');
    blob(W * 0.1, H * 1.0, Math.max(W, H) * 0.55, 'rgba(46,107,255,0.45)');
    blob(W * 0.55, H * 0.6, Math.max(W, H) * 0.3, hexA(acc, 0.10));
  } else if (p.look.style === 'clean') {
    const u = unit(W, H);
    ctx.fillStyle = 'rgba(17,17,19,0.06)';
    ctx.fillRect(0, H - 120 * u, W, 1.5 * u);
  }
}

// ---------------------------------------------------------------- cards
export function drawCard(ctx, W, H, p, card, opts = {}) {
  const st = STYLES[p.look.style] || STYLES.street;
  const acc = accentOf(p);
  const u = unit(W, H);
  const portrait = H > W;
  paintBg(ctx, W, H, p);
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const x0 = portrait ? W * 0.08 : W * 0.07;
  const street = p.look.style === 'street';
  const textW = portrait ? W * 0.84 : street ? W * 0.5 : W * 0.78;
  const wideW = portrait ? W * 0.84 : street ? W * 0.5 : W * 0.8;
  const headFont = (s) => (st.head === 'Anton' ? `${s}px Anton` : st.head === 'Playfair Display' ? `500 ${s}px "Playfair Display"` : `800 ${s}px Inter`);
  const total = (opts.total ?? p.questions.filter((q) => q.include).length) || p.questions.length;
  const guest = p.guest.name || '';
  const role = p.guest.role || '';
  const centered = p.look.style === 'cinematic';
  ctx.textAlign = centered ? 'center' : 'left';
  const cx = centered ? W / 2 : x0;
  const labelInk = p.look.style === 'clean' ? st.ink : acc;
  const label = (txt, y, color = labelInk, size = 22) => { ctx.font = `600 ${size * u}px ${MONO}`; ctx.fillStyle = color; ctx.letterSpacing = `${3 * u}px`; ctx.fillText(txt, cx, y); ctx.letterSpacing = '0px'; };

  if (card.kind === 'question') {
    const q = p.questions[card.qi];
    const n = (opts.number ?? card.qi + 1);
    if (p.look.style === 'street') {
      ctx.save();
      ctx.textAlign = 'right';
      ctx.font = `${(portrait ? 0.17 : H === W ? 0.42 : 0.66) * H}px Anton`;
      ctx.strokeStyle = hexA(acc, 0.32); ctx.lineWidth = Math.max(1, 3 * u);
      ctx.strokeText(pad2(n), W - W * (portrait ? 0.06 : 0.04), portrait ? H * 0.175 : H * 0.9);
      ctx.restore();
    }
    label(`QUESTION ${pad2(n)} / ${pad2(total)}`, portrait ? H * 0.12 : H * 0.15);
    const text = st.upper ? (q?.question || '').toUpperCase() : q?.question || '';
    const lh = st.head === 'Anton' ? 1.04 : 1.14;
    const f = fit(ctx, text, headFont, textW, portrait ? 7 : street ? 6 : 5, (st.head === 'Anton' ? 128 : 92) * u, 44 * u, (portrait ? H * (street ? 0.42 : 0.5) : H * 0.6), lh);
    ctx.font = headFont(f.size);
    ctx.fillStyle = st.ink;
    const blockH = f.lines.length * f.size * lh;
    let y = (portrait ? H * (street ? 0.6 : 0.5) : H * 0.53) - blockH / 2 + f.size * 0.86;
    for (const line of f.lines) { ctx.fillText(line, cx, y); y += f.size * lh; }
    ctx.fillStyle = acc;
    const barW = (centered ? 120 : 140) * u;
    ctx.fillRect(centered ? cx - barW / 2 : cx, y - f.size * lh + f.size * 0.45 + 30 * u, barW, (centered ? 2 : 8) * u);
    if (guest) { ctx.font = `600 ${26 * u}px Inter`; ctx.fillStyle = st.sub; ctx.fillText(guest + (role ? '  ·  ' + role : ''), cx, H - (portrait ? 0.08 : 0.09) * H); }
  } else if (card.kind === 'intro') {
    const iy = portrait ? H * (street ? 0.44 : 0.3) : H * 0.26;
    label((p.intro.kicker || 'An RMT Interview').toUpperCase(), iy);
    const t = st.upper ? (p.intro.title || p.title).toUpperCase() : p.intro.title || p.title;
    const lh = st.head === 'Anton' ? 1.0 : 1.1;
    const f = fit(ctx, t, headFont, wideW, street && !portrait ? 4 : 3, (st.head === 'Anton' ? 200 : 128) * u, 64 * u, H * (portrait && street ? 0.34 : 0.46), lh);
    ctx.font = headFont(f.size); ctx.fillStyle = st.ink;
    let y = iy + 40 * u + f.size * 0.95;
    for (const line of f.lines) { ctx.fillText(line, cx, y); y += f.size * lh; }
    if (guest) {
      ctx.font = `700 ${40 * u}px Inter`; ctx.fillStyle = st.ink;
      ctx.fillText(`with ${guest}`, cx, y + 40 * u);
      if (role) { ctx.font = `500 ${24 * u}px ${MONO}`; ctx.fillStyle = st.sub; ctx.fillText(role.toUpperCase(), cx, y + 84 * u); }
    }
    ctx.fillStyle = acc; ctx.fillRect(centered ? W / 2 - 60 * u : cx, iy - 54 * u, 120 * u, 8 * u);
  } else {
    const t = st.upper ? (p.outro.title || 'Thank you').toUpperCase() : p.outro.title || 'Thank you';
    const f = fit(ctx, t, headFont, wideW, 2, (st.head === 'Anton' ? 220 : 140) * u, 64 * u, H * 0.4, 1.02);
    ctx.font = headFont(f.size); ctx.fillStyle = st.ink;
    let y = H * (portrait && street ? 0.56 : 0.44);
    for (const line of f.lines) { ctx.fillText(line, cx, y); y += f.size * 1.02; }
    if (guest) { ctx.font = `700 ${38 * u}px Inter`; ctx.fillStyle = st.ink; ctx.fillText(guest, cx, y + 30 * u); }
    if (p.outro.line) label(p.outro.line.toUpperCase(), y + (guest ? 92 : 40) * u, labelInk, 24);
  }
  ctx.restore();
  drawBug(ctx, W, H, p, { x: 0, y: 0, w: W, h: H }, true);
}

// ---------------------------------------------------------------- layout geometry
export function camRect(p, W, H) {
  const u = unit(W, H);
  if (p.look.layout !== 'framed') return { x: 0, y: 0, w: W, h: H, r: 0 };
  if (H > W) { const w = W * 0.88, h = Math.min(H * 0.56, w * 1.18); return { x: (W - w) / 2, y: H * 0.15, w, h, r: 30 * u }; }
  if (H === W) { const w = W * 0.86, h = H * 0.68; return { x: (W - w) / 2, y: H * 0.17, w, h, r: 26 * u }; }
  const h = H * 0.78, w = (h * 16) / 9; return { x: (W - w) / 2, y: H * 0.15, w, h, r: 22 * u };
}
export function captionGeo(p, W, H) {
  const r = camRect(p, W, H);
  const st = CAPTION_STYLES[p.captions.style] || CAPTION_STYLES.bold;
  const portrait = H > W;
  const full = p.look.layout !== 'framed';
  return { x: r.x + r.w / 2, y: r.y + r.h * (portrait && full ? 0.74 : 0.93), size: st.size * unit(W, H) * (portrait ? 1.12 : 1), maxW: r.w * 0.86 };
}

function roundRectPath(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

// Framed layout: everything behind the camera (style bg + header + question text in portrait).
export function drawFrameBg(ctx, W, H, p, qi) {
  paintBg(ctx, W, H, p);
  const st = STYLES[p.look.style] || STYLES.street;
  const acc = accentOf(p);
  const u = unit(W, H);
  const r = camRect(p, W, H);
  const q = p.questions[qi];
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  const top = r.y - 34 * u;
  ctx.font = `600 ${20 * u}px ${MONO}`; ctx.letterSpacing = `${3 * u}px`;
  ctx.fillStyle = acc; ctx.textAlign = 'left';
  const n = qi != null ? `Q${pad2(qi + 1)}` : '';
  ctx.fillText(n, r.x, top);
  const nW = ctx.measureText(n + '  ').width;
  ctx.fillStyle = st.sub;
  const head = (q?.title || '').toUpperCase();
  const maxHead = r.w - nW - 260 * u;
  let h = head;
  while (h.length > 3 && ctx.measureText(h).width > maxHead) h = h.slice(0, -2);
  ctx.fillText(h === head ? h : h + '…', r.x + nW, top);
  ctx.textAlign = 'right';
  ctx.fillText((p.guest.name || 'RMT INTERVIEW').toUpperCase(), r.x + r.w, top);
  ctx.letterSpacing = '0px';
  if (H > W && q) {
    const headFont = (s) => (st.head === 'Anton' ? `${s}px Anton` : st.head === 'Playfair Display' ? `500 ${s}px "Playfair Display"` : `800 ${s}px Inter`);
    const text = st.upper ? q.question.toUpperCase() : q.question;
    const y0 = r.y + r.h + 70 * u, avail = H * 0.9 - y0;
    const lh = st.head === 'Anton' ? 1.04 : 1.14;
    const f = fit(ctx, text, headFont, r.w, 5, 84 * u, 36 * u, avail, lh);
    ctx.font = headFont(f.size); ctx.fillStyle = st.ink; ctx.textAlign = 'left';
    let y = y0 + f.size * 0.86;
    for (const line of f.lines) { ctx.fillText(line, r.x, y); y += f.size * lh; }
    ctx.fillStyle = acc; ctx.fillRect(r.x, y - f.size * lh + 34 * u, 110 * u, 7 * u);
  }
  // soft shadow under the camera window
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 50 * u; ctx.shadowOffsetY = 18 * u;
  ctx.fillStyle = '#000'; roundRectPath(ctx, r.x, r.y, r.w, r.h, r.r); ctx.fill();
  ctx.restore();
}

export function drawMask(ctx, w, h, radius) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#fff'; roundRectPath(ctx, 0, 0, w, h, radius); ctx.fill();
}

// Camera (or take video) into the layout rect, cover-fit with crop offsets.
export function drawCamera(ctx, W, H, p, src, { mirror = false } = {}) {
  const r = camRect(p, W, H);
  const vw = src?.videoWidth || 0, vh = src?.videoHeight || 0;
  ctx.save();
  if (r.r) { roundRectPath(ctx, r.x, r.y, r.w, r.h, r.r); ctx.clip(); }
  if (vw && vh && src.readyState >= 2) {
    const scale = Math.max(r.w / vw, r.h / vh);
    const sw = r.w / scale, sh = r.h / scale;
    const sx = (vw - sw) * (p.look.cropX ?? 0.5), sy = (vh - sh) * (p.look.cropY ?? 0.5);
    if (mirror) { ctx.translate(r.x * 2 + r.w, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
  } else {
    ctx.fillStyle = '#121216'; ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  ctx.restore();
  return r;
}

// ---------------------------------------------------------------- overlays
const logoCache = new Map();
export function getLogo(url) {
  if (!url) return null;
  let e = logoCache.get(url);
  if (!e) { e = new Image(); e.decoding = 'async'; e.src = url; logoCache.set(url, e); }
  return e.complete && e.naturalWidth ? e : null;
}
export function logoReady(url) {
  if (!url) return Promise.resolve();
  getLogo(url);
  const img = logoCache.get(url);
  return img.complete ? Promise.resolve() : new Promise((r) => { img.onload = img.onerror = () => r(); });
}

export function drawBug(ctx, W, H, p, r = camRect(p, W, H), onCard = false) {
  if (!p.look.bug) return;
  const u = unit(W, H);
  const acc = accentOf(p);
  const logo = getLogo(p.look.logoUrl);
  ctx.save();
  ctx.globalAlpha = onCard ? 0.9 : 0.82;
  const m = 34 * u;
  if (logo) {
    const h = 54 * u, w = (logo.naturalWidth / logo.naturalHeight) * h;
    ctx.drawImage(logo, r.x + r.w - m - w, r.y + m, w, h);
  } else {
    ctx.font = `${40 * u}px Anton`; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    const light = p.look.style === 'clean' && onCard;
    ctx.fillStyle = light ? '#111113' : '#FFFFFF';
    const dotW = 12 * u;
    ctx.fillText('RMT', r.x + r.w - m - dotW - 4 * u, r.y + m);
    ctx.fillStyle = acc; ctx.fillRect(r.x + r.w - m - dotW, r.y + m + 32 * u, dotW, dotW);
  }
  ctx.restore();
}

export function lowerThirdBox(ctx, W, H, p) {
  const r = camRect(p, W, H);
  const u = unit(W, H);
  const portrait = H > W;
  const full = p.look.layout !== 'framed';
  return { x: r.x + Math.max(40 * u, r.w * 0.045), bottom: r.y + r.h * (portrait && full ? 0.6 : 0.8), u };
}
export function drawLowerThird(ctx, W, H, p, alpha = 1) {
  const name = p.guest.name, role = p.guest.role;
  if (!name || alpha <= 0) return;
  const st = STYLES[p.look.style] || STYLES.street;
  const acc = accentOf(p);
  const { x, bottom, u } = lowerThirdBox(ctx, W, H, p);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const nameFont = st.head === 'Anton' ? `${58 * u}px Anton` : st.head === 'Playfair Display' ? `600 ${50 * u}px "Playfair Display"` : `800 ${46 * u}px Inter`;
  ctx.font = nameFont;
  const nameTxt = st.upper ? name.toUpperCase() : name;
  const nw = ctx.measureText(nameTxt).width;
  ctx.font = `600 ${20 * u}px ${MONO}`; ctx.letterSpacing = `${2.5 * u}px`;
  const rw = role ? ctx.measureText(role.toUpperCase()).width : 0;
  ctx.letterSpacing = '0px';
  const padX = 26 * u, h = (role ? 118 : 86) * u;
  const w = Math.max(nw, rw) + padX * 2 + 10 * u;
  const y = bottom - h;
  const light = p.look.style === 'clean';
  ctx.fillStyle = light ? 'rgba(255,255,255,0.94)' : 'rgba(8,8,10,0.78)';
  roundRectPath(ctx, x, y, w, h, (p.look.style === 'street' ? 4 : 14) * u); ctx.fill();
  ctx.fillStyle = acc; ctx.fillRect(x, y, 8 * u, h);
  ctx.font = nameFont; ctx.fillStyle = light ? '#111113' : '#FFFFFF';
  ctx.fillText(nameTxt, x + padX + 8 * u, y + (role ? 66 : 62) * u);
  if (role) { ctx.font = `600 ${20 * u}px ${MONO}`; ctx.letterSpacing = `${2.5 * u}px`; ctx.fillStyle = light ? '#555' : acc; ctx.fillText(role.toUpperCase(), x + padX + 8 * u, y + 98 * u); }
  ctx.restore();
}

// Caption preview (mirrors the ASS look)
export function drawCaption(ctx, W, H, p, words, t) {
  if (!words?.length) return;
  const geo = captionGeo(p, W, H);
  const st = CAPTION_STYLES[p.captions.style] || CAPTION_STYLES.bold;
  const lines = captionLines(words, { maxChars: H > W ? 18 : st.upper ? 26 : 34 });
  const line = lines.find((l) => t >= l.s && t < l.e);
  if (!line) return;
  const acc = accentOf(p);
  const size = geo.size;
  ctx.save();
  ctx.font = st.font === 'Anton' ? `${size}px Anton` : `700 ${size}px Inter`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const toks = line.words.map((w) => (st.upper ? w.w.toUpperCase() : w.w));
  const space = ctx.measureText(' ').width;
  // wrap into up to 2 rows
  const rows = [[]]; let rowW = 0;
  toks.forEach((tk, i) => { const w = ctx.measureText(tk).width; if (rowW + w > geo.maxW && rows[rows.length - 1].length) { rows.push([]); rowW = 0; } rows[rows.length - 1].push(i); rowW += w + space; });
  const lh = size * (st.upper ? 1.08 : 1.25);
  let y = geo.y - (rows.length - 1) * lh - size * 0.18;
  for (const row of rows) {
    const widths = row.map((i) => ctx.measureText(toks[i]).width);
    const total = widths.reduce((a, b) => a + b, 0) + space * (row.length - 1);
    let x = geo.x - total / 2;
    if (st.box) { ctx.fillStyle = 'rgba(0,0,0,0.75)'; const pad = size * 0.28; roundRectPath(ctx, x - pad, y - size * 0.92, total + pad * 2, size * 1.22, size * 0.18); ctx.fill(); }
    row.forEach((i, k) => {
      const w = line.words[i];
      const active = st.active && t >= (k === 0 && i === 0 ? line.s : w.s) && t < (line.words[i + 1]?.s ?? line.e);
      if (st.outline) { ctx.lineWidth = (st.outline * size) / st.size * 2; ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.lineJoin = 'round'; ctx.strokeText(toks[i], x, y); }
      ctx.fillStyle = active ? acc : '#FFFFFF';
      ctx.fillText(toks[i], x, y);
      x += widths[k] + space;
    });
    y += lh;
  }
  ctx.restore();
}

export function fontRatios() {
  const c = document.createElement('canvas').getContext('2d');
  const out = {};
  for (const [name, css] of [['Anton', '100px Anton'], ['Inter', '700 100px Inter']]) {
    c.font = css;
    const m = c.measureText('Hg');
    out[name] = (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100 || 1;
  }
  return out;
}

export function drawGuides(ctx, W, H, p) {
  const r = camRect(p, W, H);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
  for (const f of [1 / 3, 2 / 3]) {
    ctx.beginPath(); ctx.moveTo(r.x + r.w * f, r.y); ctx.lineTo(r.x + r.w * f, r.y + r.h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r.x, r.y + r.h * f); ctx.lineTo(r.x + r.w, r.y + r.h * f); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(200,255,46,0.07)';
  ctx.fillRect(r.x, r.y + r.h * 0.28, r.w, r.h * 0.1);
  ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '600 11px "JetBrains Mono"';
  ctx.fillText('EYE LINE', r.x + 10, r.y + r.h * 0.28 + 15);
  ctx.restore();
}

// ---------------------------------------------------------------- PNG rendering for export
export async function canvasPng(W, H, paint) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  paint(ctx);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
