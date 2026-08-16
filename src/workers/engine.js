'use strict';
/* OmniOCR — engine worker.
 *
 * Owns the heavy lifting: OpenCV restoration, the Tesseract pool, fusion,
 * structure analysis. The renderer only feeds it decoded page bitmaps and
 * receives structured results, which keeps the UI responsive on every platform.
 */

importScripts('omni://node/@techstark/opencv-js/dist/opencv.js');
importScripts('omni://node/tesseract.js/dist/tesseract.min.js');
importScripts('omni://app/core/cvbridge.js');
importScripts('omni://app/core/lexicon.js');
importScripts('omni://app/core/quality.js');
importScripts('omni://app/core/geometry.js');
importScripts('omni://app/core/restore.js');
importScripts('omni://app/core/depth.js');
importScripts('omni://app/core/ocr.js');
importScripts('omni://app/core/ensemble.js');
importScripts('omni://app/core/layout.js');
importScripts('omni://app/core/tables.js');
importScripts('omni://app/core/postprocess.js');
importScripts('omni://app/core/pipeline.js');

const state = { cv: null, pool: null, config: null, busy: false };

/** OpenCV's embind bindings throw raw pointers; turn those into real messages. */
function describeError(err) {
  if (typeof err === 'number' && state.cv && state.cv.exceptionFromPtr) {
    try { return `OpenCV: ${state.cv.exceptionFromPtr(err).msg}`; } catch (_) { return `OpenCV error ${err}`; }
  }
  return String((err && err.stack) || err);
}

const send = (msg, transfer) => self.postMessage(msg, transfer || []);
const log = (m) => send({ type: 'log', message: String(m) });

async function init(config) {
  state.config = config;
  state.cv = await self.CVB.ready();
  await self.Lexicon.load(config.lexiconPath || 'omni://app/vendor/lexicon');
  state.pool = new self.OCR.Pool({
    size: config.workers || 3,
    langs: config.langs || 'eng',
    corePath: config.corePath || 'omni://node/tesseract.js-core/',
    workerPath: config.workerPath || 'omni://node/tesseract.js/dist/worker.min.js',
    langPath: config.langPath || 'omni://app/vendor/tessdata/best',
  });
  await state.pool.init();
  return {
    opencv: true,
    lexicon: self.Lexicon.state.words.size,
    workers: config.workers || 3,
    langs: config.langs || 'eng',
  };
}

async function reconfigureLanguages(langs, langPath) {
  if (state.pool) await state.pool.terminate();
  state.pool = new self.OCR.Pool({
    size: state.config.workers || 3,
    langs,
    corePath: state.config.corePath || 'omni://node/tesseract.js-core/',
    workerPath: state.config.workerPath || 'omni://node/tesseract.js/dist/worker.min.js',
    langPath: langPath || state.config.langPath || 'omni://app/vendor/tessdata/best',
  });
  await state.pool.init();
  state.config.langs = langs;
  return { langs };
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data;
  try {
    switch (type) {
      case 'init': {
        const info = await init(payload);
        send({ id, type: 'ready', payload: info });
        break;
      }
      case 'languages': {
        const info = await reconfigureLanguages(payload.langs, payload.langPath);
        send({ id, type: 'result', payload: info });
        break;
      }
      case 'depth-parse': {
        const depth = await self.Depth.acquire(new Uint8Array(payload.bytes), payload.native);
        send({ id, type: 'result', payload: depth ? { width: depth.width, height: depth.height, kind: depth.kind, source: depth.source } : null });
        if (depth) state.lastDepth = depth;
        break;
      }
      case 'page': {
        state.busy = true;
        const page = {
          index: payload.index,
          name: payload.name,
          dpi: payload.dpi,
          imageData: new ImageData(new Uint8ClampedArray(payload.buffer), payload.width, payload.height),
          depth: payload.depth ? { ...payload.depth, data: new Float32Array(payload.depth.data) } : null,
        };
        const ctx = {
          cv: state.cv,
          pool: state.pool,
          log,
          onProgress: (p) => send({ id, type: 'progress', payload: p }),
        };
        const result = await self.Pipeline.processPage(ctx, page, payload.opts || {});
        state.busy = false;
        const transfer = result.image ? [result.image.bytes.buffer] : [];
        send({ id, type: 'result', payload: result }, transfer);
        break;
      }
      case 'terminate': {
        if (state.pool) await state.pool.terminate();
        send({ id, type: 'result', payload: { ok: true } });
        break;
      }
      default:
        send({ id, type: 'error', error: `unknown message: ${type}` });
    }
  } catch (err) {
    state.busy = false;
    send({ id, type: 'error', error: describeError(err) });
  }
};
