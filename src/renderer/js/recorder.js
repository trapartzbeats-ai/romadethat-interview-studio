// MediaRecorder -> chunks streamed straight to disk through the main process.
export function pickVideoMime() {
  for (const m of ['video/webm;codecs=h264,opus', 'video/x-matroska;codecs=avc1,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}
export function pickAudioMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export class DiskRecorder {
  constructor(stream, path, { mime, videoBps, audioBps = 192000, kind = 'take' } = {}) {
    this.stream = stream; this.path = path; this.kind = kind;
    this.mime = mime || pickVideoMime();
    this.opts = { mimeType: this.mime, audioBitsPerSecond: audioBps };
    if (videoBps) this.opts.videoBitsPerSecond = videoBps;
    this.queue = Promise.resolve();
    this.error = null;
    this.startedAt = 0;
  }
  async start() {
    this.id = await window.studio.rec.start(this.path);
    this.rec = new MediaRecorder(this.stream, this.opts);
    this.rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      this.queue = this.queue.then(async () => { if (this.error) return; const ab = await e.data.arrayBuffer(); await window.studio.rec.chunk(this.id, new Uint8Array(ab)); }).catch((err) => { this.error = err; });
    };
    this.stopped = new Promise((r) => { this.rec.onstop = r; });
    this.rec.start(1000);
    this.startedAt = performance.now();
  }
  elapsed() { return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0; }
  async stop() {
    if (this.rec && this.rec.state !== 'inactive') { this.rec.stop(); await this.stopped; }
    await this.queue;
    if (this.error) { await window.studio.rec.abort(this.id).catch(() => {}); throw this.error; }
    return window.studio.rec.finish(this.id, { kind: this.kind });
  }
  async abort() {
    try { if (this.rec && this.rec.state !== 'inactive') { this.rec.stop(); await this.stopped; } await this.queue; } catch {}
    await window.studio.rec.abort(this.id).catch(() => {});
  }
}
