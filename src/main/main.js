'use strict';
// RoMadeThat Interview Studio - main process.
// Serves the UI over app://, project media over media:// (with range support for seeking),
// owns all file IO, ffmpeg work and the local Whisper worker.
const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, net, screen, systemPreferences, utilityProcess } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const media = require('./media');

const RENDERER = path.join(__dirname, '..', 'renderer');
const isMac = process.platform === 'darwin';
let win = null;
let guestWin = null;

// Test hooks: keep test runs out of the real profile and Documents folder.
if (process.env.RMT_USER_DATA) app.setPath('userData', process.env.RMT_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }
]);

// ---------- allowed roots for media:// and file writes ----------
const allowedRoots = new Set();
function allowRoot(dir) { if (dir) allowedRoots.add(path.resolve(dir)); }
function insideAllowed(p) {
  const abs = path.resolve(p);
  for (const root of allowedRoots) {
    const rel = path.relative(root, abs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}
function guard(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Expected an absolute path');
  if (!insideAllowed(p)) throw new Error('Path is outside the open project: ' + p);
  return path.resolve(p);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.peaks': 'application/octet-stream', '.ico': 'image/x-icon' };

async function serveFile(file, request) {
  const stat = await fsp.stat(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (!m || !m[1]) { start = Math.max(0, stat.size - (m && m[2] ? Number(m[2]) : stat.size)); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    const stream = fs.createReadStream(file, { start, end });
    return new Response(require('node:stream').Readable.toWeb(stream), { status: 206, headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
  }
  const stream = fs.createReadStream(file);
  return new Response(require('node:stream').Readable.toWeb(stream), { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } });
}

function registerProtocols() {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(RENDERER, rel);
    if (!file.startsWith(path.resolve(RENDERER))) return new Response('Forbidden', { status: 403 });
    try { return await serveFile(file, request); } catch { return new Response('Not found', { status: 404 }); }
  });
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url);
      const file = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      const abs = guard(isMac || process.platform === 'linux' ? '/' + file.replace(/^\/+/, '') : file);
      return await serveFile(abs, request);
    } catch (e) { return new Response(String(e.message || e), { status: 404 }); }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 980, minWidth: 1180, minHeight: 720, backgroundColor: '#09090b', show: false,
    title: 'RoMadeThat Interview Studio', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
  });
  win.loadURL('app://studio/index.html');
  win.once('ready-to-show', () => { win.show(); if (process.env.RMT_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' }); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (win && !win.__allowClose) {
      e.preventDefault();
      win.webContents.send('studio:before-close');
      setTimeout(() => { if (win && !win.isDestroyed()) { win.__allowClose = true; win.close(); } }, 2500);
    }
  });
  win.on('closed', () => { win = null; if (guestWin && !guestWin.isDestroyed()) guestWin.close(); });
}

app.whenReady().then(async () => {
  registerProtocols();
  const allowPerm = new Set(['media', 'mediaKeySystem', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowPerm.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowPerm.has(permission));
  if (isMac) {
    try { await systemPreferences.askForMediaAccess('camera'); await systemPreferences.askForMediaAccess('microphone'); } catch {}
  }
  allowRoot(app.getPath('temp'));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (!isMac) app.quit(); });

// ---------- helpers ----------
const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => fn(...args));
const defaultProjectsDir = () => process.env.RMT_PROJECTS_DIR || path.join(app.getPath('documents'), 'RoMadeThat Interviews');
function safeName(s) { return String(s || 'Interview').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Interview'; }
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');
async function readRecent() { try { return JSON.parse(await fsp.readFile(recentFile(), 'utf8')).filter((r) => r && r.dir); } catch { return []; } }
async function pushRecent(dir, title) {
  const list = (await readRecent()).filter((r) => path.resolve(r.dir) !== path.resolve(dir));
  list.unshift({ dir, title, at: Date.now() });
  await fsp.mkdir(path.dirname(recentFile()), { recursive: true });
  await fsp.writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 1));
}
async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8');
  await fsp.rename(tmp, file);
}

// ---------- app info ----------
handle('studio:info', async () => ({
  platform: process.platform, arch: process.arch, version: app.getVersion(), packaged: app.isPackaged,
  projectsDir: defaultProjectsDir(), electron: process.versions.electron
}));

// ---------- projects ----------
handle('project:recent', async () => {
  const list = await readRecent();
  return list.filter((r) => fs.existsSync(path.join(r.dir, 'project.json')));
});
handle('project:create', async (title, data) => {
  const base = defaultProjectsDir();
  await fsp.mkdir(base, { recursive: true });
  let dir = path.join(base, safeName(title));
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base, `${safeName(title)} ${n}`);
  for (const sub of ['takes', 'voice', 'assets', 'exports']) await fsp.mkdir(path.join(dir, sub), { recursive: true });
  allowRoot(dir);
  await writeJsonAtomic(path.join(dir, 'project.json'), data);
  await pushRecent(dir, title);
  return dir;
});
handle('project:open', async (dir) => {
  if (!dir) {
    const r = await dialog.showOpenDialog(win, { title: 'Open interview project', defaultPath: defaultProjectsDir(), properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    dir = r.filePaths[0];
  }
  const file = path.join(dir, 'project.json');
  if (!fs.existsSync(file)) throw new Error('That folder has no project.json');
  allowRoot(dir);
  const data = JSON.parse(await fsp.readFile(file, 'utf8'));
  for (const sub of ['takes', 'voice', 'assets', 'exports']) await fsp.mkdir(path.join(dir, sub), { recursive: true });
  await pushRecent(dir, data.title || path.basename(dir));
  return { dir, data };
});
handle('project:save', async (dir, data) => {
  guard(dir);
  await writeJsonAtomic(path.join(dir, 'project.json'), data);
  await pushRecent(dir, data.title || path.basename(dir));
  return true;
});
handle('project:importScript', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import questions', filters: [{ name: 'Script', extensions: ['json', 'txt', 'md'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { name: path.basename(r.filePaths[0]), text: await fsp.readFile(r.filePaths[0], 'utf8') };
});
handle('project:exportScript', async (suggested, text) => {
  const r = await dialog.showSaveDialog(win, { title: 'Export script', defaultPath: path.join(app.getPath('documents'), suggested), filters: [{ name: 'Script', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  await fsp.writeFile(r.filePath, text, 'utf8');
  return r.filePath;
});

// ---------- files inside the project ----------
handle('file:write', async (absPath, bytes) => {
  const p = guard(absPath);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, typeof bytes === 'string' ? bytes : Buffer.from(bytes));
  return p;
});
handle('file:delete', async (absPath) => { const p = guard(absPath); await fsp.rm(p, { force: true }); return true; });
handle('file:exists', async (absPath) => { try { return fs.existsSync(guard(absPath)); } catch { return false; } });
handle('file:pickImport', async (projectDir, kind) => {
  guard(projectDir);
  const filters = kind === 'image' ? [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg'] }] : [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'] }];
  const r = await dialog.showOpenDialog(win, { title: kind === 'image' ? 'Choose an image' : 'Choose an audio file', filters, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const src = r.filePaths[0];
  const dst = path.join(projectDir, 'assets', `${Date.now().toString(36)}-${safeName(path.basename(src, path.extname(src)))}${path.extname(src).toLowerCase()}`);
  await fsp.copyFile(src, dst);
  return dst;
});
handle('file:show', async (p) => { if (typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p); });
handle('file:open', async (p) => { if (typeof p === 'string' && fs.existsSync(p)) return shell.openPath(p); });
handle('disk:free', async (dir) => {
  try { const s = await fsp.statfs(dir || defaultProjectsDir()); return s.bavail * s.bsize; }
  catch { try { const s = await fsp.statfs(app.getPath('documents')); return s.bavail * s.bsize; } catch { return null; } }
});

// ---------- streaming recordings to disk ----------
const streams = new Map();
let streamSeq = 0;
handle('rec:start', async (absPath) => {
  const p = guard(absPath);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const id = ++streamSeq;
  const ws = fs.createWriteStream(p);
  const entry = { path: p, ws, error: null, bytes: 0 };
  ws.on('error', (e) => { entry.error = e; });
  streams.set(id, entry);
  return id;
});
handle('rec:chunk', async (id, bytes) => {
  const s = streams.get(id);
  if (!s) throw new Error('Recording stream is closed');
  if (s.error) throw s.error;
  const b = Buffer.from(bytes);
  s.bytes += b.length;
  if (!s.ws.write(b)) await new Promise((r) => s.ws.once('drain', r));
  return s.bytes;
});
handle('rec:finish', async (id, options = {}) => {
  const s = streams.get(id);
  if (!s) throw new Error('Recording stream is closed');
  streams.delete(id);
  await new Promise((resolve, reject) => s.ws.end((err) => (err ? reject(err) : resolve())));
  if (s.error) throw s.error;
  if (!s.bytes) { await fsp.rm(s.path, { force: true }); throw new Error('The recorder returned no data'); }
  // Remux so the file gets a duration + seek index, then analyse it.
  const out = await media.finalizeRecording(s.path, options);
  return out;
});
handle('rec:abort', async (id) => {
  const s = streams.get(id);
  if (!s) return;
  streams.delete(id);
  await new Promise((r) => s.ws.end(r));
  await fsp.rm(s.path, { force: true });
});

// ---------- media analysis ----------
handle('media:analyze', async (absPath) => media.analyze(guard(absPath)));
handle('media:probe', async (absPath) => media.probe(guard(absPath)));

// ---------- transcription (local Whisper in a utility process) ----------
let worker = null;
let jobSeq = 0;
const jobs = new Map();
function getWorker() {
  if (worker) return worker;
  worker = utilityProcess.fork(path.join(__dirname, 'transcribe-worker.mjs'), [], {
    serviceName: 'RMT Whisper', stdio: 'pipe',
    env: { ...process.env, RMT_MODEL_DIR: path.join(app.getPath('userData'), 'models'), RMT_FFMPEG: media.ffmpegPath() }
  });
  worker.stdout?.on('data', (d) => process.stdout.write('[whisper] ' + d));
  worker.stderr?.on('data', (d) => process.stderr.write('[whisper] ' + d));
  worker.on('message', (msg) => {
    const job = jobs.get(msg.id);
    if (!job) return;
    if (msg.type === 'progress') { win?.webContents.send('transcribe:progress', { id: msg.id, ...msg.progress, file: job.file }); return; }
    jobs.delete(msg.id);
    if (msg.type === 'done') job.resolve(msg.result); else job.reject(new Error(msg.error || 'Transcription failed'));
  });
  worker.on('exit', (code) => {
    worker = null;
    for (const [id, job] of jobs) { job.reject(new Error('Caption engine stopped (code ' + code + ')')); jobs.delete(id); }
  });
  return worker;
}
handle('transcribe:run', async (absPath, model) => {
  const file = guard(absPath);
  const id = ++jobSeq;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject, file });
    getWorker().postMessage({ id, file, model: model || 'Xenova/whisper-base.en' });
  });
});

// ---------- export ----------
let exportJob = null;
handle('export:run', async (plan) => {
  guard(plan.projectDir);
  if (exportJob) throw new Error('An export is already running');
  if (plan.fontsDir === 'builtin') plan.fontsDir = path.join(RENDERER, 'fonts');
  guard(plan.buildDir); guard(plan.outFile);
  exportJob = media.runExport(plan, (p) => win?.webContents.send('export:progress', p));
  try { return await exportJob.promise; } finally { exportJob = null; }
});
handle('export:cancel', async () => { exportJob?.cancel(); return true; });

// ---------- guest / prompter screen ----------
handle('guest:displays', async () => {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({ id: d.id, label: `${d.label || 'Display ' + (i + 1)} · ${d.size.width}×${d.size.height}${d.id === primary ? ' (main)' : ''}`, primary: d.id === primary }));
});
handle('guest:open', async (opts = {}) => {
  const displays = screen.getAllDisplays();
  const target = displays.find((d) => d.id === opts.displayId) || displays.find((d) => d.id !== screen.getPrimaryDisplay().id) || screen.getPrimaryDisplay();
  if (guestWin && !guestWin.isDestroyed()) { guestWin.close(); guestWin = null; }
  const b = target.bounds;
  const full = opts.fullscreen !== false && target.id !== screen.getPrimaryDisplay().id;
  guestWin = new BrowserWindow({
    x: b.x + (full ? 0 : 80), y: b.y + (full ? 0 : 80), width: full ? b.width : 960, height: full ? b.height : 600,
    backgroundColor: '#000000', autoHideMenuBar: true, title: 'Guest screen · RoMadeThat Interview Studio', fullscreen: full,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false }
  });
  guestWin.loadURL('app://studio/guest.html');
  guestWin.on('closed', () => { guestWin = null; win?.webContents.send('guest:closed'); });
  return { fullscreen: full, display: target.id };
});
handle('guest:close', async () => { if (guestWin && !guestWin.isDestroyed()) guestWin.close(); guestWin = null; return true; });
handle('guest:isOpen', async () => !!(guestWin && !guestWin.isDestroyed()));

ipcMain.on('studio:close-ready', () => { if (win && !win.isDestroyed()) { win.__allowClose = true; win.close(); } });
