'use strict';
/* OmniOCR — table reconstruction.
 *
 * Ruled tables are recovered from their printed rules (morphological line
 * extraction → grid intersections → cells). Unruled tables are recovered from
 * the whitespace columns that the text itself forms. Either way the output is a
 * real row/column grid, so tables survive into DOCX/HTML/CSV as tables.
 */
(function (scope) {
  /* ---------------- ruled tables ---------------- */

  /** Extract long horizontal / vertical rules from a binarised page. */
  function ruleMasks(cv, binary) {
    const inv = new cv.Mat();
    cv.bitwise_not(binary, inv);                       // ink = white
    const w = binary.cols; const h = binary.rows;
    const hLen = Math.max(20, Math.round(w / 30));
    const vLen = Math.max(20, Math.round(h / 40));

    const hMask = new cv.Mat(); const vMask = new cv.Mat();
    const hk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(hLen, 1));
    const vk = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, vLen));
    cv.morphologyEx(inv, hMask, cv.MORPH_OPEN, hk);
    cv.morphologyEx(inv, vMask, cv.MORPH_OPEN, vk);
    // Bridge small breaks caused by scanner noise.
    const hk2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(3, hLen >> 1), 1));
    const vk2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, Math.max(3, vLen >> 1)));
    cv.morphologyEx(hMask, hMask, cv.MORPH_CLOSE, hk2);
    cv.morphologyEx(vMask, vMask, cv.MORPH_CLOSE, vk2);
    inv.delete(); hk.delete(); vk.delete(); hk2.delete(); vk2.delete();
    return { hMask, vMask };
  }

  /** Peak positions of a mask's row (axis=1) or column (axis=0) projection. */
  function separators(cv, mask, axis, minRun) {
    const proj = new cv.Mat();
    cv.reduce(mask, proj, axis, cv.REDUCE_SUM, cv.CV_32F);
    const d = proj.data32F;
    const max = Math.max(...d);
    const out = [];
    if (max > 0) {
      const thr = Math.max(max * 0.35, minRun * 255);
      let start = -1;
      for (let i = 0; i < d.length; i++) {
        if (d[i] >= thr) { if (start < 0) start = i; }
        else if (start >= 0) { out.push((start + i - 1) / 2); start = -1; }
      }
      if (start >= 0) out.push((start + d.length - 1) / 2);
    }
    proj.delete();
    return out;
  }

  function detectRuled(cv, binary, opts = {}) {
    const { hMask, vMask } = ruleMasks(cv, binary);
    const grid = new cv.Mat();
    cv.add(hMask, vMask, grid);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(grid, grid, k);
    k.delete();

    const contours = new cv.MatVector(); const hier = new cv.Mat();
    cv.findContours(grid, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const pageArea = binary.cols * binary.rows;
    const tables = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const r = cv.boundingRect(c);
      c.delete();
      if (r.width * r.height < pageArea * 0.012) continue;
      if (r.width < binary.cols * 0.18 || r.height < 24) continue;

      const roiRect = new cv.Rect(r.x, r.y, r.width, r.height);
      const hRoi = hMask.roi(roiRect); const vRoi = vMask.roi(roiRect);
      const rows = separators(cv, hRoi, 1, r.width * 0.5).map((y) => y + r.y);
      const cols = separators(cv, vRoi, 0, r.height * 0.5).map((x) => x + r.x);
      hRoi.delete(); vRoi.delete();

      if (rows.length >= 2 && cols.length >= 2) {
        tables.push({ bbox: { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height }, rows, cols, ruled: true });
      }
    }
    contours.delete(); hier.delete(); hMask.delete(); vMask.delete(); grid.delete();
    return tables;
  }

  /* ---------------- unruled tables ---------------- */

  /**
   * Detect column structure from repeated word-start alignment across
   * consecutive lines (typical of statements, price lists, timetables).
   */
  function detectUnruled(lines, pageW, stats) {
    if (lines.length < 4) return [];
    const tol = Math.max(6, (stats.medianH || 14) * 0.6);
    const groups = [];
    let run = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const gap = lines[i].bbox.y0 - lines[i - 1].bbox.y1;
      if (gap <= (stats.medianGap || 6) * 2.2) run.push(lines[i]);
      else { if (run.length >= 3) groups.push(run); run = [lines[i]]; }
    }
    if (run.length >= 3) groups.push(run);

    const tables = [];
    for (const g of groups) {
      const multi = g.filter((l) => l.words.length >= 2);
      if (multi.length < 3) continue;
      // Cluster word start positions across the group.
      const starts = [];
      for (const l of multi) for (const w of l.words) starts.push(w.bbox.x0);
      starts.sort((a, b) => a - b);
      const clusters = [];
      for (const s of starts) {
        const last = clusters[clusters.length - 1];
        if (last && s - last.mean <= tol) { last.items.push(s); last.mean = last.items.reduce((x, y) => x + y, 0) / last.items.length; }
        else clusters.push({ items: [s], mean: s });
      }
      const strong = clusters.filter((c) => c.items.length >= Math.max(3, multi.length * 0.6));
      if (strong.length < 2) continue;
      // Require internal whitespace gaps — otherwise it is just a paragraph.
      const gapsOk = multi.filter((l) => l.words.some((w, i) => i > 0 && w.bbox.x0 - l.words[i - 1].bbox.x1 > tol * 1.6)).length;
      if (gapsOk < multi.length * 0.6) continue;

      const bbox = {
        x0: Math.min(...multi.map((l) => l.bbox.x0)),
        y0: Math.min(...multi.map((l) => l.bbox.y0)),
        x1: Math.max(...multi.map((l) => l.bbox.x1)),
        y1: Math.max(...multi.map((l) => l.bbox.y1)),
      };
      const cols = strong.map((c) => c.mean);
      const rows = multi.map((l) => (l.bbox.y0 + l.bbox.y1) / 2);
      tables.push({ bbox, rows, cols, ruled: false, lines: multi });
    }
    return tables;
  }

  /* ---------------- cell filling ---------------- */

  const inside = (b, box) => (b.x0 + b.x1) / 2 >= box.x0 && (b.x0 + b.x1) / 2 <= box.x1
    && (b.y0 + b.y1) / 2 >= box.y0 && (b.y0 + b.y1) / 2 <= box.y1;

  /** Assign words to grid cells; returns a rows×cols text matrix. */
  function fillCells(table, lines) {
    const rowEdges = table.ruled ? table.rows : boundariesFromCenters(table.rows, table.bbox.y0, table.bbox.y1);
    const colEdges = table.ruled ? table.cols : boundariesFromCenters(table.cols, table.bbox.x0, table.bbox.x1, true);
    const nR = Math.max(1, rowEdges.length - 1);
    const nC = Math.max(1, colEdges.length - 1);
    const cells = Array.from({ length: nR }, () => Array.from({ length: nC }, () => ({ words: [], text: '', conf: 0 })));

    for (const line of lines) {
      for (const w of line.words) {
        if (!inside(w.bbox, table.bbox)) continue;
        const cx = (w.bbox.x0 + w.bbox.x1) / 2;
        const cy = (w.bbox.y0 + w.bbox.y1) / 2;
        let r = -1; let c = -1;
        for (let i = 0; i < nR; i++) if (cy >= rowEdges[i] && cy < rowEdges[i + 1]) { r = i; break; }
        for (let j = 0; j < nC; j++) if (cx >= colEdges[j] && cx < colEdges[j + 1]) { c = j; break; }
        if (r < 0 || c < 0) continue;
        cells[r][c].words.push(w);
      }
    }
    for (const row of cells) {
      for (const cell of row) {
        cell.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
        cell.text = cell.words.map((w) => w.text).join(' ').trim();
        cell.conf = cell.words.length ? cell.words.reduce((s, w) => s + w.conf, 0) / cell.words.length : 0;
      }
    }
    return { cells, rows: nR, cols: nC };
  }

  /** Turn cluster centres into cell boundaries. */
  function boundariesFromCenters(centers, min, max, isCols = false) {
    const sorted = [...centers].sort((a, b) => a - b);
    const edges = [min];
    for (let i = 1; i < sorted.length; i++) edges.push(isCols ? (sorted[i] - 2) : (sorted[i - 1] + sorted[i]) / 2);
    edges.push(max + 1);
    return edges.filter((v, i, a) => i === 0 || v > a[i - 1]);
  }

  /** Rule extraction only needs enough resolution to see the rules. Working on
   *  a downscaled copy makes detection ~10x cheaper on 300-600 dpi pages. */
  const DETECT_EDGE = 1600;

  function detectRuledScaled(cv, binary, opts) {
    const scale = Math.min(1, DETECT_EDGE / Math.max(binary.cols, binary.rows));
    if (scale > 0.999) return detectRuled(cv, binary, opts);
    const small = new cv.Mat();
    cv.resize(binary, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    cv.threshold(small, small, 127, 255, cv.THRESH_BINARY);
    try {
      return detectRuled(cv, small, opts).map((t) => ({
        ...t,
        bbox: { x0: t.bbox.x0 / scale, y0: t.bbox.y0 / scale, x1: t.bbox.x1 / scale, y1: t.bbox.y1 / scale },
        rows: t.rows.map((v) => v / scale),
        cols: t.cols.map((v) => v / scale),
      }));
    } finally { small.delete(); }
  }

  /**
   * @returns array of { bbox, rows, cols, cells, ruled, confidence }
   */
  function detect(cv, binary, lines, stats, opts = {}) {
    const found = [];
    if (opts.ruled !== false) found.push(...detectRuledScaled(cv, binary, opts));
    if (opts.unruled !== false) {
      const ruledBoxes = found.map((t) => t.bbox);
      const free = lines.filter((l) => !ruledBoxes.some((b) => inside(l.bbox, b)));
      found.push(...detectUnruled(free, binary.cols, stats));
    }
    return found.map((t) => {
      const grid = fillCells(t, lines);
      const filled = grid.cells.flat().filter((c) => c.text).length;
      const total = grid.rows * grid.cols;
      return {
        ...t,
        ...grid,
        confidence: total ? filled / total : 0,
      };
    }).filter((t) => t.rows >= 2 && t.cols >= 2 && t.confidence > 0.28);
  }

  scope.Tables = { detect, detectRuled, detectRuledScaled, detectUnruled, fillCells, ruleMasks };
})(self);
