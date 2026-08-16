'use strict';
/* OmniOCR — Tesseract worker pool.
 *
 * A small pool of LSTM workers handles recognition; one optional legacy worker
 * provides orientation/script detection (OSD), with a confidence-vote fallback
 * when the legacy core is unavailable.
 */
(function (scope) {
  const PSM = {
    AUTO_OSD: '1', AUTO: '3', SINGLE_COLUMN: '4', SINGLE_BLOCK: '6',
    SINGLE_LINE: '7', SPARSE_TEXT: '11', SPARSE_TEXT_OSD: '12', RAW_LINE: '13',
  };

  const BASE_PARAMS = {
    preserve_interword_spaces: '1',
    tessedit_do_invert: '0',
    // Keep Tesseract's own thresholding out of the way — restore.js already
    // produced the binarisation we want it to see.
    thresholding_method: '0',
  };

  class Pool {
    constructor(opts) {
      this.opts = opts;
      this.workers = [];
      this.queue = [];
      this.idle = [];
      this.osdWorker = null;
      this.ready = null;
    }

    async init() {
      if (this.ready) return this.ready;
      this.ready = (async () => {
        const { size, langs, corePath, workerPath, langPath } = this.opts;
        const make = async () => {
          const w = await scope.Tesseract.createWorker(langs, 1 /* LSTM_ONLY */, {
            corePath, workerPath, langPath, gzip: false, cacheMethod: 'none', logger: () => {},
          });
          await w.setParameters(BASE_PARAMS);
          return w;
        };
        this.workers = await Promise.all(Array.from({ length: size }, make));
        this.idle = [...this.workers];
      })();
      return this.ready;
    }

    async acquire() {
      await this.init();
      if (this.idle.length) return this.idle.pop();
      return new Promise((res) => this.queue.push(res));
    }

    release(w) {
      const next = this.queue.shift();
      if (next) next(w); else this.idle.push(w);
    }

    /** Replace a worker that has become unusable (hung or errored). */
    async _replace(dead) {
      const i = this.workers.indexOf(dead);
      try { await dead.terminate(); } catch (_) { /* already gone */ }
      const { langs, corePath, workerPath, langPath } = this.opts;
      const fresh = await scope.Tesseract.createWorker(langs, 1, {
        corePath, workerPath, langPath, gzip: false, cacheMethod: 'none', logger: () => {},
      });
      await fresh.setParameters(BASE_PARAMS);
      if (i >= 0) this.workers[i] = fresh; else this.workers.push(fresh);
      return fresh;
    }

    /**
     * @param image  Uint8Array of an encoded image (BMP/PNG) or an OffscreenCanvas
     * @param cfg    { psm, dpi, params, output, timeoutMs }
     *
     * A timeout is essential rather than defensive: Tesseract's layout analysis
     * degrades badly on images with very large blob counts (heavy speckle), and
     * a single pathological variant would otherwise stall the whole document.
     * On timeout the worker is discarded and replaced, and the variant is
     * simply dropped from the ensemble.
     */
    async recognize(image, cfg = {}) {
      const w = await this.acquire();
      const timeoutMs = cfg.timeoutMs ?? 90000;
      let timer = null;
      let timedOut = false;
      try {
        const params = {
          ...BASE_PARAMS,
          tessedit_pageseg_mode: cfg.psm || PSM.AUTO,
          ...(cfg.dpi ? { user_defined_dpi: String(Math.round(cfg.dpi)) } : {}),
          ...(cfg.params || {}),
        };
        await w.setParameters(params);
        const out = cfg.output || { blocks: true, text: true, hocr: false, tsv: false };
        const job = w.recognize(image, { rotateAuto: false }, out);
        const guard = new Promise((_, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error(`recognition timed out after ${timeoutMs}ms`)); }, timeoutMs);
        });
        const res = await Promise.race([job, guard]);
        return res.data;
      } catch (err) {
        if (timedOut) {
          const fresh = await this._replace(w);
          this.release(fresh);
          throw err;
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        if (!timedOut) this.release(w);
      }
    }

    async initOsd() {
      if (this.osdWorker !== null) return this.osdWorker;
      try {
        const { corePath, workerPath, langPath } = this.opts;
        this.osdWorker = await scope.Tesseract.createWorker('osd', 0 /* TESSERACT_ONLY */, {
          corePath, workerPath, langPath, gzip: false, cacheMethod: 'none', logger: () => {}, legacyCore: true, legacyLang: true,
        });
      } catch (err) {
        this.osdWorker = false;   // legacy core unavailable → fall back to voting
      }
      return this.osdWorker;
    }

    /** @returns { degrees, confidence, method } — degrees to rotate to upright. */
    async detectOrientation(image) {
      const osd = await this.initOsd();
      if (osd) {
        try {
          const { data } = await osd.detect(image);
          // Tesseract reports how far the page is rotated; we return the correction.
          const deg = ((360 - (data.orientation_degrees || 0)) % 360);
          return { degrees: deg, confidence: data.orientation_confidence || 0, method: 'osd' };
        } catch (_) { /* fall through to voting */ }
      }
      return { degrees: 0, confidence: 0, method: 'none' };
    }

    async terminate() {
      await Promise.all(this.workers.map((w) => w.terminate().catch(() => {})));
      if (this.osdWorker) await this.osdWorker.terminate().catch(() => {});
      this.workers = []; this.idle = []; this.osdWorker = null; this.ready = null;
    }
  }

  /* ---------------- result normalisation ---------------- */

  /**
   * Flatten Tesseract's block tree into a line/word structure with the fields
   * the rest of the pipeline needs, dropping empty artefacts.
   */
  function normalizeResult(data, meta = {}) {
    const lines = [];
    const blocks = data.blocks || [];
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const words = (line.words || [])
            .filter((w) => w.text && w.text.trim().length)
            .map((w) => ({
              text: w.text,
              conf: w.confidence,
              bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
              bold: !!(w.font_attributes && w.font_attributes.bold),
              italic: !!(w.font_attributes && w.font_attributes.italic),
              fontSize: w.font_size || 0,
            }));
          if (!words.length) continue;
          const text = words.map((w) => w.text).join(' ');
          const conf = words.reduce((s, w) => s + w.conf, 0) / words.length;
          lines.push({
            text,
            conf,
            words,
            bbox: { x0: line.bbox.x0, y0: line.bbox.y0, x1: line.bbox.x1, y1: line.bbox.y1 },
            blockIndex: bi,
            blockType: block.blocktype,
            paraIndex: para.paragraph_index,
            baseline: line.baseline || null,
            source: meta.variant || null,
          });
        }
      }
    }
    const allWords = lines.flatMap((l) => l.words);
    return {
      lines,
      text: lines.map((l) => l.text).join('\n'),
      confidence: allWords.length ? allWords.reduce((s, w) => s + w.conf, 0) / allWords.length : 0,
      wordCount: allWords.length,
      meta,
    };
  }

  scope.OCR = { Pool, PSM, normalizeResult, BASE_PARAMS };
})(self);
