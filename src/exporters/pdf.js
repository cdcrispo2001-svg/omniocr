/* OmniOCR — searchable PDF export.
 *
 * Each output page is the restored page image with an INVISIBLE text layer
 * (rendering mode 3) positioned word-by-word over the pixels it came from, so
 * selection, search and copy land exactly on the visible glyphs. Horizontal
 * scaling is set per word so the invisible run matches the real word width —
 * without it, selection drifts across the line.
 */

const {
  PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState,
  beginText, endText, setTextRenderingMode, TextRenderingMode,
  setFontAndSize, setTextMatrix, showText, PDFHexString, PDFName, rgb,
} = window.PDFLib;

let cachedFont = null;

async function loadUnicodeFont() {
  if (cachedFont) return cachedFont;
  const res = await fetch('omni://app/vendor/fonts/DejaVuSans.ttf');
  cachedFont = new Uint8Array(await res.arrayBuffer());
  return cachedFont;
}

/** Characters DejaVu cannot render (CJK, Indic, …) are dropped from the
 *  invisible layer only — the visible page image is untouched. */
function sanitize(text, font) {
  let out = '';
  for (const ch of text) {
    try { font.widthOfTextAtSize(ch, 10); out += ch; }
    catch (_) { out += ' '; }
  }
  return out;
}

/**
 * @param pages   OmniOCR page results
 * @param opts    { title, author, imageQuality, textLayer, unicodeFont }
 * @returns Uint8Array of the PDF
 */
export async function exportPdf(pages, opts = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(opts.title || 'OmniOCR document');
  doc.setProducer('OmniOCR');
  doc.setCreator('OmniOCR');
  if (opts.author) doc.setAuthor(opts.author);

  let font;
  if (opts.unicodeFont !== false) {
    const fontkit = window.fontkit;
    if (fontkit) doc.registerFontkit(fontkit);
    try {
      font = await doc.embedFont(await loadUnicodeFont(), { subset: true });
    } catch (_) {
      font = await doc.embedFont(StandardFonts.Helvetica);
    }
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
  }

  for (const page of pages) {
    if (!page.image) continue;
    const img = page.image.type === 'image/png'
      ? await doc.embedPng(page.image.bytes)
      : await doc.embedJpg(page.image.bytes);

    const dpi = page.dpi || 300;
    const wPt = (page.width / dpi) * 72;
    const hPt = (page.height / dpi) * 72;
    const pdfPage = doc.addPage([wPt, hPt]);
    pdfPage.drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });

    if (opts.textLayer === false) continue;

    // Registers the font in the page's resource dictionary and exposes its key.
    pdfPage.setFont(font);
    const fontKey = pdfPage.fontKey;

    const px2pt = 72 / dpi;
    const ops = [pushGraphicsState(), beginText(), setTextRenderingMode(TextRenderingMode.Invisible)];

    for (const line of page.lines) {
      for (const word of line.words) {
        const text = sanitize(word.text, font);
        if (!text.trim()) continue;
        const b = word.bbox;
        const boxW = (b.x1 - b.x0) * px2pt;
        const boxH = (b.y1 - b.y0) * px2pt;
        if (boxW <= 0.4 || boxH <= 0.4) continue;

        // Font size from the glyph box; baseline sits ~20% above the box bottom.
        const size = Math.max(1, boxH * 0.92);
        const natural = font.widthOfTextAtSize(text, size) || boxW;
        const hScale = Math.max(0.05, Math.min(6, boxW / natural));

        const x = b.x0 * px2pt;
        const yTop = b.y1 * px2pt;
        const baseline = hPt - yTop + boxH * 0.18;

        ops.push(
          setFontAndSize(fontKey, size),
          // [a b c d e f] with a = horizontal scale keeps the run inside its box.
          setTextMatrix(hScale, 0, 0, 1, x, baseline),
          showText(font.encodeText(text)),
        );
      }
    }
    ops.push(endText(), popGraphicsState());
    pdfPage.pushOperators(...ops);
  }

  return doc.save({ useObjectStreams: true });
}

/** Attach OmniOCR's structured result as an embedded JSON sidecar. */
export async function exportPdfWithSidecar(pages, opts = {}) {
  const bytes = await exportPdf(pages, opts);
  const doc = await PDFDocument.load(bytes);
  const json = new TextEncoder().encode(JSON.stringify({
    producer: 'OmniOCR',
    pages: pages.map((p) => ({ index: p.index, confidence: p.confidence, score: p.score, blocks: p.blocks, tables: p.tables })),
  }, null, 1));
  await doc.attach(json, 'omniocr-structure.json', {
    mimeType: 'application/json',
    description: 'OmniOCR structured layout data',
  });
  return doc.save({ useObjectStreams: true });
}
