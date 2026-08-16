/* OmniOCR — promise-based RPC wrapper around the engine worker. */

export class Engine {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.onLog = () => {};
    this.onProgress = () => {};
  }

  async start(config = {}) {
    this.worker = new Worker('omni://app/src/workers/engine.js');
    this.worker.onmessage = (e) => this._dispatch(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(`engine worker error: ${e.message}`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.onLog(`worker error: ${e.message}`);
    };
    return this._call('init', config);
  }

  _dispatch(msg) {
    if (msg.type === 'log') { this.onLog(msg.message); return; }
    if (msg.type === 'progress') { this.onProgress(msg.payload); return; }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'error') { this.pending.delete(msg.id); p.reject(new Error(msg.error)); return; }
    this.pending.delete(msg.id);
    p.resolve(msg.payload);
  }

  _call(type, payload, transfer = []) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload }, transfer);
    });
  }

  /** Recognise one page. The bitmap buffer is transferred (zero copy). */
  async page(pageInput, opts) {
    const { imageData, index, name, dpi, depth } = pageInput;
    // Send a copy: the caller keeps its bitmap for previews and re-runs, and the
    // copy is transferred so the worker still receives it without a structured
    // clone of 30+ MB.
    const buffer = imageData.data.buffer.slice(0);
    return this._call('page', {
      index, name, dpi, buffer, width: imageData.width, height: imageData.height,
      depth: depth ? { width: depth.width, height: depth.height, data: depth.data, kind: depth.kind, source: depth.source } : null,
      opts,
    }, [buffer]);
  }

  setLanguages(langs, langPath) { return this._call('languages', { langs, langPath }); }

  async stop() {
    if (!this.worker) return;
    try { await this._call('terminate', {}); } catch (_) { /* worker already gone */ }
    this.worker.terminate();
    this.worker = null;
  }
}
