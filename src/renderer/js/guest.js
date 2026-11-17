// Guest / talent screen: big question, countdown, prompter and a gentle time bar. No controls.
const ch = new BroadcastChannel('rmt-guest');
const $ = (id) => document.getElementById(id);
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let lastHtml = '';
let lastQ = '';
let fontScale = 1;

ch.onmessage = ({ data: s }) => {
  if (s.type !== 'state') return;
  document.documentElement.style.setProperty('--acc', s.accent || '#C8FF2E');
  const g = $('g');
  g.classList.toggle('recording', s.phase === 'countdown' || s.phase === 'answer');
  g.classList.toggle('mirror', !!s.mirror);
  $('gStep').textContent = `${(s.title2 || 'INTERVIEW').toUpperCase()}  ·  QUESTION ${s.number} / ${s.total}`;
  const show = (id) => ['vIdle', 'vAsk', 'vCount', 'vProm'].forEach((v) => ($(v).hidden = v !== id));
  if (s.phase === 'ask') {
    show('vAsk');
    $('gNum').textContent = `QUESTION ${String(s.number).padStart(2, '0')}`;
    if (lastQ !== s.question) { $('gQ').textContent = s.question; lastQ = s.question; }
    $('gListen').style.visibility = s.asking ? 'visible' : 'hidden';
  } else if (s.phase === 'countdown' || s.go) {
    show('vCount');
    const c = $('vCount');
    c.className = 'count' + (s.go ? ' go' : '');
    c.textContent = s.go ? 'GO' : String(s.count);
  } else if (s.phase === 'answer' || s.phase === 'saving') {
    show('vProm');
    if (lastHtml !== s.html) { $('gText').innerHTML = s.html; lastHtml = s.html; }
    fontScale = window.innerHeight / 700;
    const t = $('gText');
    t.style.fontSize = Math.round((s.font || 44) * fontScale) + 'px';
    const box = t.parentElement;
    const max = Math.max(1, t.scrollHeight - box.clientHeight * 0.3);
    t.style.transform = `translateY(${(box.clientHeight * 0.3 - (s.progress || 0) * max).toFixed(1)}px)`;
  } else {
    show('vIdle');
    $('gTitle').textContent = s.guestName ? `Ready, ${s.guestName.split(' ')[0]}?` : 'Get comfortable.';
  }
  const b = $('gBottom');
  const on = s.phase === 'answer' && s.target;
  b.style.visibility = s.phase === 'answer' ? 'visible' : 'hidden';
  $('gTime').textContent = fmt(s.elapsed || 0);
  $('gTarget').textContent = on ? (s.elapsed > s.target ? 'WRAP IT UP' : fmt(s.target)) : '';
  $('gBar').style.width = on ? Math.min(100, (s.elapsed / s.target) * 100) + '%' : '0';
  b.className = 'g-bottom' + (on && s.elapsed > s.target ? ' over' : on && s.elapsed > s.target * 0.85 ? ' near' : '');
};
document.addEventListener('dblclick', () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})));
