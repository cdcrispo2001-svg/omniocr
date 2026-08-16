/* OmniOCR — document ingest.
 *
 * Decodes anything the user throws at the app into page rasters, and — for PDFs
 * that already carry a real text layer — extracts that text directly instead of
 * re-recognising it. Re-OCRing a born-digital PDF can only lose information.
 */

import * as pdfjs from 'omni://node/pdfjs-dist/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = 'omni://node/pdfjs-dist/build/pdf.worker.mjs';

const IMAGE_EXT = /\.(png|jpe?g|bmp|webp|gif|avif)$/i;
const TIFF_EXT = /\.tiff?$/i;
const HEIC_EXT = /\.(heic|heif)$/i;
const PDF_EXT = /\.pdf$/i;

/** Render an ImageBitmap (or canvas source) to ImageData. */
function toImageData(source, width, height) {
  const c = new OffscreenCanvas(width, height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/* ---------------- PDF ---------------- */

/**
 * Decide whether a PDF page's own text layer is usable.
 * Scanned PDFs typically expose either nothing or a handful of junk glyphs.
 */
function textLayerQuality(textContent, viewport) {
  const items = textContent.items.filter((i) => i.str && i.str.trim());
  if (items.length < 4) return { usable: false, items: [], chars: 0 };
  const chars = items.reduce((s, i) => s + i.str.trim().length, 0);
  const area = viewport.width * viewport.height;
  const density = chars / (area / 10000);       // chars per 100x100 px block
  return { usable: chars >= 40 && density > 0.4, items, chars };
}

/** Convert pdf.js text items into OmniOCR line objects (viewport pixel space). */
function linesFromTextLayer(items, viewport) {
  const raw = items.map((it) => {
    const t = it.transform;
    const x = t[4];
    const y = t[5];
    const h = Math.hypot(t[2], t[3]) || it.height || 10;
    const w = it.width || (it.str.length * h * 0.5);
    return {
      text: it.str,
      x0: x,
      y0: viewport.height - y - h,
      x1: x + w,
      y1: viewport.height - y,
      h,
      fontName: it.fontName,
    };
  }).filter((r) => r.text.trim());

  raw.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  const lines = [];
  for (const item of raw) {
    const last = lines[lines.length - 1];
    const sameLine = last
      && Math.abs(((item.y0 + item.y1) / 2) - ((last.bbox.y0 + last.bbox.y1) / 2)) < Math.max(3, item.h * 0.55);
    if (sameLine) {
      last.items.push(item);
      last.bbox.x0 = Math.min(last.bbox.x0, item.x0);
      last.bbox.x1 = Math.max(last.bbox.x1, item.x1);
      last.bbox.y0 = Math.min(last.bbox.y0, item.y0);
      last.bbox.y1 = Math.max(last.bbox.y1, item.y1);
    } else {
      lines.push({ items: [item], bbox: { x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1 } });
    }
  }

  return lines.map((l) => {
    l.items.sort((a, b) => a.x0 - b.x0);
    const words = [];
    for (const it of l.items) {
      const parts = it.text.split(/(\s+)/).filter((p) => p.trim());
      const span = (it.x1 - it.x0) / Math.max(1, it.text.length);
      let cursor = it.x0;
      let consumed = 0;
      for (const p of parts) {
        const start = it.text.indexOf(p, consumed);
        const x0 = it.x0 + start * span;
        const x1 = x0 + p.length * span;
        consumed = start + p.length;
        cursor = x1;
        words.push({ text: p, conf: 99.5, bbox: { x0, y0: it.y0, x1, y1: it.y1 }, bold: /bold/i.test(it.fontName || ''), italic: /italic|oblique/i.test(it.fontName || ''), fontSize: it.h });
      }
      if (!parts.length) cursor = it.x1;
    }
    return {
      text: words.map((w) => w.text).join(' '),
      conf: 99.5,
      bbox: l.bbox,
      words,
    };
  }).filter((l) => l.text.trim());
}

async function ingestPdf(bytes, name, opts) {
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  const targetDpi = opts.dpi || 300;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    // PDF user units are 1/72 inch, so scale = dpi/72 for the requested density.
    let scale = targetDpi / 72;
    // Ceiling on rasterisation. Above this the recogniser gains nothing while
    // memory and time costs keep climbing; large-format pages are rendered at
    // whatever density fits instead.
    const maxPixels = opts.maxPixels || 24e6;
    if (base.width * base.height * scale * scale > maxPixels) {
      scale = Math.sqrt(maxPixels / (base.width * base.height));
    }
    const viewport = page.getViewport({ scale });
    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    let digital = null;
    if (opts.useTextLayer !== false) {
      const tc = await page.getTextContent();
      const q = textLayerQuality(tc, viewport);
      if (q.usable) digital = { lines: linesFromTextLayer(q.items, viewport), chars: q.chars };
    }
    pages.push({
      name: doc.numPages > 1 ? `${name} — page ${i}` : name,
      source: name,
      pageNumber: i,
      imageData,
      dpi: Math.round(72 * scale),
      digital,
    });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

/* ---------------- raster formats ---------------- */

async function ingestTiff(bytes, name) {
  const ifds = self.UTIF.decode(bytes);
  const pages = [];
  for (let i = 0; i < ifds.length; i++) {
    self.UTIF.decodeImage(bytes, ifds[i]);
    const rgba = self.UTIF.toRGBA8(ifds[i]);
    const w = ifds[i].width; const h = ifds[i].height;
    pages.push({
      name: ifds.length > 1 ? `${name} — page ${i + 1}` : name,
      source: name,
      pageNumber: i + 1,
      imageData: new ImageData(new Uint8ClampedArray(rgba), w, h),
      dpi: ifds[i].t282 ? Math.round(ifds[i].t282[0]) : 0,
    });
  }
  return pages;
}

async function ingestHeic(bytes, name) {
  const decoder = new self.libheif.HeifDecoder();
  const images = decoder.decode(bytes);
  const pages = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const w = img.get_width();
    const h = img.get_height();
    const imageData = new ImageData(w, h);
    await new Promise((resolve, reject) => {
      img.display(imageData, (out) => (out ? resolve(out) : reject(new Error('HEIC decode failed'))));
    });
    pages.push({ name: images.length > 1 ? `${name} — image ${i + 1}` : name, source: name, pageNumber: i + 1, imageData, dpi: 0 });
  }
  return pages;
}

async function ingestImage(bytes, name) {
  const blob = new Blob([bytes]);
  const bmp = await createImageBitmap(blob);
  const imageData = toImageData(bmp, bmp.width, bmp.height);
  bmp.close();
  return [{ name, source: name, pageNumber: 1, imageData, dpi: 0 }];
}

/* ---------------- entry point ---------------- */

/**
 * @param file { name, path, buffer }
 * @returns array of page descriptors
 */
export async function ingest(file, opts = {}) {
  const bytes = new Uint8Array(file.buffer);
  const name = file.name;
  if (PDF_EXT.test(name) || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    return ingestPdf(bytes, name, opts);
  }
  if (TIFF_EXT.test(name)) return ingestTiff(bytes, name);
  if (HEIC_EXT.test(name)) return ingestHeic(bytes, name);
  if (IMAGE_EXT.test(name)) return ingestImage(bytes, name);
  // Unknown extension: sniff, then fall back to the browser decoder.
  if (bytes[0] === 0x49 && bytes[1] === 0x49) return ingestTiff(bytes, name);
  if (bytes[0] === 0x4d && bytes[1] === 0x4d) return ingestTiff(bytes, name);
  return ingestImage(bytes, name);
}

export const helpers = { textLayerQuality, linesFromTextLayer, toImageData };
