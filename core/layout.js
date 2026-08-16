'use strict';
/* OmniOCR — layout reconstruction.
 *
 * Turns a flat list of recognised lines back into the document's actual
 * structure: columns and reading order, paragraphs, headings, lists, captions
 * and running headers/footers. This is what "retains the original structure"
 * means in practice — the exports are built from this tree, not from raw text.
 */
(function (scope) {
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const BULLET = /^\s*([•▪◦‣·*\-–—o])\s+/;
  const NUMBERED = /^\s*(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxlcdm]{1,6}[.)])\s+/;

  /* ---------------- columns ---------------- */

  /**
   * Find vertical gutters: x positions crossed by very few lines while text
   * exists on both sides over most of the page height.
   */
  function detectColumns(lines, pageW, pageH) {
    if (lines.length < 8) return [{ x0: 0, x1: pageW }];
    const bins = 200;
    const cover = new Float64Array(bins);
    // Project words, not lines. A line box is a hull: one noisy line that the
    // recogniser merged across the gutter paints the whole width and erases the
    // gap, which is why faint, shadowed and speckled two-column pages lost
    // their columns entirely. Words stay on their own side of the gutter.
    const units = lines.flatMap((l) => (l.words && l.words.length ? l.words : [l]));
    for (const u of units) {
      const a = Math.max(0, Math.floor((u.bbox.x0 / pageW) * bins));
      const b = Math.min(bins - 1, Math.ceil((u.bbox.x1 / pageW) * bins));
      const h = u.bbox.y1 - u.bbox.y0;
      for (let i = a; i <= b; i++) cover[i] += h;
    }
    const maxCover = Math.max(...cover);
    if (maxCover <= 0) return [{ x0: 0, x1: pageW }];

    const gutters = [];
    let runStart = -1;
    const threshold = maxCover * 0.04;
    for (let i = 0; i < bins; i++) {
      if (cover[i] <= threshold) { if (runStart < 0) runStart = i; }
      else {
        if (runStart >= 0 && i - runStart >= 5) gutters.push([runStart, i - 1]);
        runStart = -1;
      }
    }
    if (runStart >= 0 && bins - runStart >= 5) gutters.push([runStart, bins - 1]);

    // Keep only interior gutters with substantial text on both sides.
    const interior = gutters.filter(([a, b]) => a > bins * 0.12 && b < bins * 0.88);
    if (!interior.length) return [{ x0: 0, x1: pageW }];

    // A real column gutter is never crossed by a line of text. Whitespace that
    // happens to line up — the space between an invoice's description and its
    // amounts, say — is crossed constantly, and treating it as a column turns
    // row-major reading order into column-major, scrambling the document.
    const margin = pageW * 0.004;
    const crossable = interior.filter(([a, b]) => {
      const x = ((a + b) / 2 / bins) * pageW;
      const crossing = units.filter((u) => u.bbox.x0 < x - margin && u.bbox.x1 > x + margin).length;
      return crossing / units.length <= 0.02;
    });
    if (!crossable.length) return [{ x0: 0, x1: pageW }];

    const cuts = crossable.map(([a, b]) => ((a + b) / 2 / bins) * pageW);
    const bounds = [0, ...cuts, pageW];
    const cols = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const x0 = bounds[i]; const x1 = bounds[i + 1];
      const inCol = units.filter((u) => (u.bbox.x0 + u.bbox.x1) / 2 >= x0 && (u.bbox.x0 + u.bbox.x1) / 2 < x1);
      if (inCol.length >= 8) {
        cols.push({
          x0,
          x1,
          top: Math.min(...inCol.map((l) => l.bbox.y0)),
          bottom: Math.max(...inCol.map((l) => l.bbox.y1)),
          count: inCol.length,
        });
      }
    }
    if (cols.length < 2) return [{ x0: 0, x1: pageW }];

    // Parallel columns run down the page together. A table's numeric column
    // occupies only the rows of the table, while the text beside it runs the
    // full height — so comparing vertical extents separates a real two-column
    // layout from a table that merely has a gap down the middle.
    const extents = cols.map((c) => c.bottom - c.top);
    const contentTop = Math.min(...cols.map((c) => c.top));
    const contentBottom = Math.max(...cols.map((c) => c.bottom));
    const contentHeight = Math.max(1, contentBottom - contentTop);
    if (Math.min(...extents) / Math.max(...extents) < 0.6) return [{ x0: 0, x1: pageW }];
    if (Math.min(...extents) / contentHeight < 0.45) return [{ x0: 0, x1: pageW }];

    // A "column" that holds only full-width lines is really a spanning block;
    // require each detected column to hold mostly narrow lines.
    const avgW = median(lines.map((l) => l.bbox.x1 - l.bbox.x0));
    if (avgW > pageW * 0.75) return [{ x0: 0, x1: pageW }];

    // Text columns are siblings: a two-column article splits the page into
    // roughly equal halves. A table's columns are nothing of the sort — a wide
    // description beside narrow amounts — and reading such a page column-major
    // would interleave every row. Lopsided splits are therefore not columns.
    const widths = cols.map((c) => c.x1 - c.x0);
    if (Math.max(...widths) / Math.max(1, Math.min(...widths)) > 2.2) return [{ x0: 0, x1: pageW }];
    return cols;
  }

  /**
   * Order lines as a reader would.
   *
   * Sorting by top edge is wrong whenever two pieces of text share a baseline
   * but not a font size: a form's bold value has a taller glyph box than its
   * label, so a naive sort emits "Sarah Immaculate Given names:" — the answer
   * before the question. Lines are therefore banded into rows by vertical
   * centre first, and ordered left-to-right within each row.
   */
  function readingOrder(lines, medianH) {
    if (lines.length < 2) return [...lines];

    const tol = Math.max(4, (medianH || 14) * 0.6);
    const sorted = [...lines].sort((a, b) => ((a.bbox.y0 + a.bbox.y1) / 2) - ((b.bbox.y0 + b.bbox.y1) / 2));
    const rows = [];
    for (const l of sorted) {
      const centre = (l.bbox.y0 + l.bbox.y1) / 2;
      const row = rows[rows.length - 1];
      if (row && Math.abs(centre - row.centre) <= tol) {
        row.items.push(l);
        row.centre = row.items.reduce((s, x) => s + (x.bbox.y0 + x.bbox.y1) / 2, 0) / row.items.length;
      } else {
        rows.push({ centre, items: [l] });
      }
    }
    return rows.flatMap((r) => r.items.sort((a, b) => a.bbox.x0 - b.bbox.x0));
  }

  /* ---------------- line typing ---------------- */

  function lineHeight(l) { return l.bbox.y1 - l.bbox.y0; }

  function classifyLines(lines, stats, pageW, pageH) {
    const { medianH, medianGap } = stats;
    return lines.map((l) => {
      const h = lineHeight(l);
      const w = l.bbox.x1 - l.bbox.x0;
      const bold = l.words.length ? l.words.filter((x) => x.bold).length / l.words.length > 0.6 : false;
      const centered = Math.abs(((l.bbox.x0 + l.bbox.x1) / 2) - pageW / 2) < pageW * 0.06 && w < pageW * 0.72;
      const ratio = medianH ? h / medianH : 1;
      const upper = l.text.replace(/[^\p{L}]/gu, '');
      const allCaps = upper.length > 2 && upper === upper.toUpperCase();
      let type = 'text';
      if (BULLET.test(l.text) || NUMBERED.test(l.text)) type = 'list-item';
      else if (ratio > 1.22 || (bold && ratio > 1.05) || (allCaps && w < pageW * 0.8 && l.text.length < 90)) type = 'heading';
      const level = type === 'heading'
        ? (ratio > 1.9 ? 1 : ratio > 1.45 ? 2 : ratio > 1.18 ? 3 : 4)
        : 0;
      return { ...l, h, w, bold, centered, ratio, allCaps, type, level };
    });
  }

  /* ---------------- paragraph grouping ---------------- */

  function groupParagraphs(lines, stats, pageW) {
    const blocks = [];
    let cur = null;
    const push = () => { if (cur && cur.lines.length) blocks.push(finishBlock(cur)); cur = null; };

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const prev = lines[i - 1];
      let breakHere = !cur;

      if (cur && prev) {
        const gap = l.bbox.y0 - prev.bbox.y1;
        const gapBreak = gap > Math.max(stats.medianGap * 1.7, stats.medianH * 0.75);
        const typeBreak = l.type !== prev.type || (l.type === 'heading' && prev.type === 'heading' && l.level !== prev.level);
        const sizeBreak = Math.abs(l.ratio - prev.ratio) > 0.22;
        const indent = l.bbox.x0 - prev.bbox.x0;
        const indentBreak = indent > stats.medianH * 0.9 && gap > stats.medianGap * 0.6;
        // A short previous line that ends a sentence usually ends the paragraph.
        const shortPrevEnd = /[.!?:"'”’]\s*$/.test(prev.text) && (prev.bbox.x1 - prev.bbox.x0) < stats.bodyWidth * 0.86;
        breakHere = gapBreak || typeBreak || sizeBreak || indentBreak || (shortPrevEnd && indentBreak);
        if (l.type === 'list-item') breakHere = true;
      }
      if (breakHere) { push(); cur = { type: l.type, level: l.level, lines: [] }; }
      cur.lines.push(l);
    }
    push();
    return blocks;
  }

  /** Join a block's lines into text, undoing hyphenation across line breaks. */
  function joinLines(lines) {
    let out = '';
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].text.trim();
      if (!i) { out = t; continue; }
      const hyphen = /(\p{L})[-‐‑–]$/u.exec(out);
      if (hyphen && /^\p{Ll}/u.test(t)) {
        const merged = out.replace(/[-‐‑–]$/u, '');
        const head = merged.split(/\s+/).pop() || '';
        const tail = t.split(/\s+/)[0] || '';
        const joined = (head + tail).toLowerCase().replace(/[^\p{L}]/gu, '');
        // Keep the hyphen unless the joined form is a real word (e.g. "co-operate").
        out = scope.Lexicon && scope.Lexicon.has(joined) ? `${merged}${t}` : `${out}${t}`;
      } else {
        out += ` ${t}`;
      }
    }
    return out.replace(/\s+/g, ' ').trim();
  }

  function finishBlock(b) {
    const bbox = {
      x0: Math.min(...b.lines.map((l) => l.bbox.x0)),
      y0: Math.min(...b.lines.map((l) => l.bbox.y0)),
      x1: Math.max(...b.lines.map((l) => l.bbox.x1)),
      y1: Math.max(...b.lines.map((l) => l.bbox.y1)),
    };
    const words = b.lines.flatMap((l) => l.words);
    return {
      ...b,
      bbox,
      text: joinLines(b.lines),
      conf: words.length ? words.reduce((s, w) => s + w.conf, 0) / words.length : 0,
      wordCount: words.length,
    };
  }

  /* ---------------- running heads / page numbers ---------------- */

  function markRunningElements(blocks, pageH) {
    for (const b of blocks) {
      const midY = (b.bbox.y0 + b.bbox.y1) / 2;
      const short = b.text.length <= 90 && b.lines.length === 1;
      if (!short) continue;
      if (midY < pageH * 0.075) b.type = 'header';
      else if (midY > pageH * 0.925) b.type = /^\s*[-–—]?\s*(page\s*)?\d{1,4}\s*[-–—]?\s*$/i.test(b.text) ? 'page-number' : 'footer';
    }
    return blocks;
  }

  /* ---------------- entry point ---------------- */

  /**
   * @param lines  fused lines in canonical page coordinates
   * @returns { blocks, columns, stats } in reading order
   */
  function analyze(lines, pageW, pageH, opts = {}) {
    if (!lines.length) return { blocks: [], columns: [], stats: {} };

    const heights = lines.map(lineHeight).filter((h) => h > 0);
    const medianH = median(heights) || 12;
    const gaps = [];
    const byY = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
    for (let i = 1; i < byY.length; i++) {
      const g = byY[i].bbox.y0 - byY[i - 1].bbox.y1;
      if (g > -medianH && g < medianH * 4) gaps.push(g);
    }
    const stats = {
      medianH,
      medianGap: median(gaps.filter((g) => g >= 0)) || medianH * 0.35,
      bodyWidth: median(lines.map((l) => l.bbox.x1 - l.bbox.x0)) || pageW * 0.7,
    };

    const columns = opts.singleColumn ? [{ x0: 0, x1: pageW }] : detectColumns(lines, pageW, pageH);
    const typed = classifyLines(lines, stats, pageW, pageH);

    const blocks = [];
    columns.forEach((col, ci) => {
      const inCol = readingOrder(
        typed.filter((l) => {
          const cx = (l.bbox.x0 + l.bbox.x1) / 2;
          return cx >= col.x0 && cx < col.x1;
        }),
        stats.medianH,
      );
      groupParagraphs(inCol, stats, pageW).forEach((b) => blocks.push({ ...b, column: ci }));
    });

    // Lines that span multiple columns (titles, full-width rules) belong to the
    // flow at their vertical position, ahead of the columns they precede.
    markRunningElements(blocks, pageH);
    blocks.sort((a, b) => (a.column - b.column) || (a.bbox.y0 - b.bbox.y0));

    return { blocks, columns, stats };
  }

  scope.Layout = { analyze, detectColumns, joinLines, classifyLines, readingOrder, BULLET, NUMBERED };
})(self);
