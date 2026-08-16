'use strict';
/* OmniOCR — per-page orchestration with adaptive escalation.
 *
 * The engine keeps working on a page until it is satisfied: profile → geometry →
 * variants → OCR → fuse → score, and if the score is below target it escalates
 * (more variants, larger upscale, different segmentation modes) and fuses the
 * new evidence with the old. Escalation stops on target, on no improvement, or
 * at the effort ceiling — so hard pages get more compute and easy pages don't.
 */
(function (scope) {
  const { M } = scope.CVB;

  const PROFILES = {
    fast:     { targetScore: 0.80, maxLevel: 0, maxVariants: 2, psmLadder: ['3'], budgetMs: 45000 },
    balanced: { targetScore: 0.88, maxLevel: 2, maxVariants: 4, psmLadder: ['3', '6'], budgetMs: 120000 },
    maximum:  { targetScore: 0.95, maxLevel: 4, maxVariants: 8, psmLadder: ['3', '6', '4', '11'], budgetMs: 300000 },
  };

  const now = () => performance.now();

  function pageScore(fused) {
    if (!fused.lines.length) return 0;
    let num = 0; let den = 0;
    for (const l of fused.lines) {
      const w = Math.max(4, l.text.trim().length);
      num += scope.Ensemble.lineScore(l) * w;
      den += w;
    }
    return den ? num / den : 0;
  }

  /** Encode a Mat as JPEG/PNG bytes for embedding in exports. */
  async function encodeImage(cv, mat, { type = 'image/jpeg', quality = 0.86 } = {}) {
    const imgData = scope.CVB.toImageData(mat);
    const c = new OffscreenCanvas(mat.cols, mat.rows);
    c.getContext('2d').putImageData(imgData, 0, 0);
    const blob = await c.convertToBlob({ type, quality });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type, width: mat.cols, height: mat.rows };
  }

  /**
   * Page text in reading order, interleaving prose blocks and tables.
   *
   * Blocks alone are not the page: content absorbed into a table is removed
   * from `blocks`, so composing text from blocks silently drops every table.
   */
  function buildPageText(blocks, tables) {
    const items = [
      ...blocks.map((b) => ({ y: b.bbox.y0, x: b.bbox.x0, col: b.column || 0, text: b.text })),
      ...tables.map((t) => ({
        y: t.bbox.y0,
        x: t.bbox.x0,
        col: 0,
        text: t.cells.map((row) => row.map((c) => c.text).filter(Boolean).join('  ')).filter((r) => r.trim()).join('\n'),
      })),
    ];
    items.sort((a, b) => (a.col - b.col) || (a.y - b.y) || (a.x - b.x));
    return scope.PostProcess.tidyText(items.map((i) => i.text).filter((t) => t && t.trim()).join('\n\n'));
  }

  /* ---------------- orientation ---------------- */

  async function detectRotation(cv, gray, pool, log) {
    const small = new cv.Mat();
    const scale = Math.min(1, 1000 / Math.max(gray.cols, gray.rows));
    cv.resize(gray, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
    const flat = scope.Restore.flattenIllumination(cv, small);
    const bmp = scope.CVB.grayToBmp(flat, 150);
    let result = { degrees: 0, confidence: 0, method: 'none' };
    try {
      result = await pool.detectOrientation(bmp);
    } catch (err) {
      log && log(`osd failed: ${err}`);
    }
    small.delete(); flat.delete();
    if (result.confidence < 1.0) return { degrees: 0, confidence: result.confidence, method: result.method + '-lowconf' };
    return result;
  }

  /* ---------------- one recognition round ---------------- */

  /**
   * Build each variant, then recognise them concurrently.
   *
   * Construction is deliberately serial. A single Sauvola pass holds roughly
   * nine float32 buffers the size of the page — on a large scan that is
   * hundreds of megabytes — so building four variants at once exhausts the
   * WASM heap and aborts the page. Recognition, which is the expensive part,
   * still runs in parallel across the worker pool; only the image maths is
   * sequenced, and each variant's Mats are released as soon as its bitmap has
   * been extracted.
   */
  async function runVariants(ctx, canonical, prof, plan, psm, dpi, opts = {}) {
    const { cv, pool } = ctx;
    const results = [];
    const jobs = [];

    for (const variant of plan) {
      const t0 = now();
      let bmp = null;
      let mat = null;
      try {
        mat = scope.Restore.buildVariant(cv, canonical, prof, variant);
        bmp = scope.CVB.grayToBmp(mat, Math.round(dpi * variant.scale));
      } catch (err) {
        ctx.log && ctx.log(`variant ${variant.id} could not be built: ${describe(cv, err)}`);
      } finally {
        if (mat) { try { mat.delete(); } catch (_) { /* already gone */ } }
      }
      if (!bmp) continue;

      jobs.push((async () => {
        try {
          const data = await pool.recognize(bmp, { psm, dpi: dpi * variant.scale, timeoutMs: opts.variantTimeoutMs || 90000 });
          results.push({ variant, result: scope.OCR.normalizeResult(data, { variant: variant.id, psm }), ms: now() - t0 });
        } catch (err) {
          ctx.log && ctx.log(`variant ${variant.id} failed: ${describe(cv, err)}`);
        }
      })());
    }

    await Promise.all(jobs);
    return results;
  }

  /** OpenCV throws raw pointers from WASM; turn them into readable messages. */
  function describe(cv, err) {
    if (typeof err === 'number' && cv && cv.exceptionFromPtr) {
      try { return `OpenCV: ${cv.exceptionFromPtr(err).msg}`; } catch (_) { return `OpenCV error ${err}`; }
    }
    return String((err && err.message) || err);
  }

  /* ---------------- born-digital pages ---------------- */

  /** Structure analysis over an existing (exact) text layer — no OCR. */
  async function finishDigital(ctx, page, gray, opts, t0, report) {
    const { cv } = ctx;
    const lines = opts.digitalLines;
    report('structure', 60);
    const layout = scope.Layout.analyze(lines, gray.cols, gray.rows, { singleColumn: opts.singleColumn });
    let tables = [];
    if (opts.tables !== false) {
      let bin = null;
      try {
        bin = scope.Restore.otsu(cv, scope.Restore.flattenIllumination(cv, gray));
        tables = scope.Tables.detect(cv, bin, lines, layout.stats, {});
      } catch (err) { ctx.log && ctx.log(`table detection failed: ${err}`); }
      finally { if (bin) bin.delete(); }
    }
    const tableBoxes = tables.map((t) => t.bbox);
    const blocks = layout.blocks.filter((b) => !tableBoxes.some((tb) => b.bbox.x0 >= tb.x0 - 4 && b.bbox.x1 <= tb.x1 + 4 && b.bbox.y0 >= tb.y0 - 4 && b.bbox.y1 <= tb.y1 + 4));
    let image = null;
    if (opts.exportImage !== false) image = await encodeImage(cv, gray, { type: opts.imageType || 'image/jpeg', quality: opts.imageQuality ?? 0.9 });
    const words = lines.flatMap((l) => l.words);
    const identity = M.identity();
    const result = {
      index: page.index,
      name: page.name,
      width: gray.cols,
      height: gray.rows,
      originalWidth: gray.cols,
      originalHeight: gray.rows,
      dpi: page.dpi || 300,
      digital: true,
      profile: { tier: 'digital', sharpness: 0, noiseSigma: 0, contrast: 255, inkLevel: 0, paperLevel: 255, illumStd: 0, componentHeight: 0, xHeight: 0, estDpi: page.dpi || 300, skew: 0, foreignMarkScore: 0, speckRatio: 0, inkRatio: 0, componentCount: 0 },
      depth: null,
      rotation: 0,
      transform: { toCanonical: identity, toOriginal: identity },
      geometrySteps: [],
      lines: lines.map((l) => ({ ...l, bboxOriginal: l.bbox, words: l.words.map((w) => ({ ...w, bboxOriginal: w.bbox })) })),
      blocks,
      tables,
      columns: layout.columns.length,
      text: buildPageText(blocks, tables),
      confidence: 99.5,
      score: 1,
      agreement: 1,
      wordCount: words.length,
      corrections: [],
      attempts: [{ level: 0, psm: 'text-layer', variants: ['digital'], score: 1, lines: lines.length }],
      variantsRun: [],
      image,
      timings: { total: now() - t0 },
    };
    gray.delete();
    report('done', 100);
    return result;
  }

  /* ---------------- page processing ---------------- */

  /**
   * @param ctx  { cv, pool, log, onProgress }
   * @param page { imageData, index, dpi, depth, name }
   * @param opts { profile, dewarp, deskew, autoRotate, correct, tables, exportImage }
   */
  async function processPage(ctx, page, opts = {}) {
    const { cv, pool } = ctx;
    const cfg = PROFILES[opts.profile] || PROFILES.balanced;
    const timings = {};
    const t0 = now();
    const report = (stage, pct) => ctx.onProgress && ctx.onProgress({ page: page.index, stage, pct });

    const src = scope.CVB.fromImageData(page.imageData);
    let gray = scope.CVB.toGray(src);
    src.delete();

    // Bound the working image before anything else touches it.
    //
    // Broadsheet newspapers, posters and large-format scans arrive at tens of
    // megapixels. Every downstream stage allocates float buffers proportional
    // to this size, so an unbounded page exhausts the WASM heap outright — and
    // the recogniser cannot use that resolution anyway. The reduction is folded
    // into the transform, so reported coordinates still refer to the original.
    const MAX_WORK_PIXELS = 16e6;
    let preMatrix = M.identity();
    const inputPixels = gray.cols * gray.rows;
    if (inputPixels > MAX_WORK_PIXELS) {
      const s = Math.sqrt(MAX_WORK_PIXELS / inputPixels);
      const small = new cv.Mat();
      cv.resize(gray, small, new cv.Size(0, 0), s, s, cv.INTER_AREA);
      gray.delete();
      gray = small;
      preMatrix = M.scale(s, s);
      ctx.log && ctx.log(`page ${page.index}: ${(inputPixels / 1e6).toFixed(1)} MP reduced to ${(gray.cols * gray.rows / 1e6).toFixed(1)} MP for processing`);
    }

    // Born-digital page: the PDF already carries exact text. Recognising it
    // again could only lose characters, so we keep the supplied lines and spend
    // the effort on structure instead.
    if (opts.digitalLines && opts.digitalLines.length) {
      return finishDigital(ctx, page, gray, opts, t0, report);
    }

    /* --- depth assistance --- */
    let depthInfo = null;
    let quad = null;
    if (page.depth && opts.useDepth !== false) {
      const td = now();
      try {
        const mask = scope.Depth.pageMask(cv, page.depth, gray.cols, gray.rows);
        if (mask) quad = scope.Depth.quadFromMask(cv, mask);
        const flat = scope.Depth.flattenCurl(cv, gray, page.depth, mask);
        if (flat) { gray.delete(); gray = flat; }
        if (mask) mask.delete();
        depthInfo = { used: true, source: page.depth.source, kind: page.depth.kind, quad: !!quad, curl: !!flat };
      } catch (err) {
        depthInfo = { used: false, error: String(err) };
      }
      timings.depth = now() - td;
    }
    report('profiling', 5);

    /* --- profile --- */
    let tp = now();
    let prof = scope.Quality.profile(cv, gray);
    timings.profile = now() - tp;

    /* --- orientation --- */
    let rotation = 0;
    if (opts.autoRotate !== false) {
      const tr = now();
      const det = await detectRotation(cv, gray, pool, ctx.log);
      rotation = det.degrees % 360;
      timings.orientation = now() - tr;
      ctx.log && ctx.log(`page ${page.index}: osd ${JSON.stringify(det)}`);
    }
    report('geometry', 12);

    /* --- geometry --- */
    const tg = now();
    const norm = scope.Geometry.normalize(cv, gray, prof, {
      dewarp: opts.dewarp !== false,
      deskew: opts.deskew !== false,
      quad,
      rotate90: rotation,
      skew: prof.skew,
    });
    timings.geometry = now() - tg;
    const canonical = norm.mat;
    const toCanonical = M.mul(norm.matrix, preMatrix);
    const toOriginal = M.invert(toCanonical);

    // Re-profile only if geometry actually changed the image; otherwise the
    // first profile is still exactly valid and re-measuring is pure cost.
    if (norm.steps.length) {
      tp = now();
      prof = scope.Quality.profile(cv, canonical);
      timings.profile += now() - tp;
    }
    const dpi = page.dpi || (prof.estDpi > 60 ? prof.estDpi : 300);
    report('recognising', 20);

    /* --- adaptive escalation loop --- */
    let all = [];
    const debugImages = [];
    let fused = { lines: [], text: '', confidence: 0, agreement: 0, sources: [] };
    let score = 0;
    let level = 0;
    const attempts = [];

    while (level <= cfg.maxLevel) {
      const psm = cfg.psmLadder[Math.min(level, cfg.psmLadder.length - 1)];
      const plan = scope.Restore.planVariants(prof, level).slice(0, cfg.maxVariants);
      const seen = new Set(all.map((r) => `${r.variant.id}@${r.variant.scale}#${r.result.meta.psm}`));
      const fresh = plan.filter((v) => !seen.has(`${v.id}@${v.scale}#${psm}`));
      if (!fresh.length && level > 0) break;

      const t = now();
      if (opts.dumpVariants) {
        // Debug aid: emit exactly what the recogniser is being shown.
        for (const v of fresh) {
          const mat = scope.Restore.buildVariant(cv, canonical, prof, v);
          debugImages.push({ id: `${v.id}@${v.scale}x-L${level}`, ...(await encodeImage(cv, mat, { type: 'image/png' })) });
          mat.delete();
        }
      }
      const round = await runVariants(ctx, canonical, prof, fresh, psm, dpi, opts);
      timings[`ocr_l${level}`] = now() - t;
      all = all.concat(round);

      const prevScore = score;
      fused = scope.Ensemble.fuse(all);
      score = pageScore(fused);
      attempts.push({ level, psm, variants: fresh.map((v) => v.id), score: +score.toFixed(4), lines: fused.lines.length });
      ctx.log && ctx.log(`page ${page.index} L${level} psm=${psm} [${fresh.map((v) => v.id).join(',')}] score=${score.toFixed(3)} lines=${fused.lines.length}`);
      report('recognising', 20 + Math.min(60, (level + 1) * 20));

      if (score >= cfg.targetScore) break;
      if (level > 0 && score - prevScore < 0.004) break;      // escalation stopped paying
      // A page that resists every attempt must not consume the document's whole
      // processing time. Beyond the budget the engine reports what it has.
      const budget = opts.timeBudgetMs || cfg.budgetMs;
      if (now() - t0 > budget) {
        ctx.log && ctx.log(`page ${page.index}: stopping at level ${level}, time budget ${Math.round(budget / 1000)}s exhausted`);
        attempts.push({ level, psm, variants: [], score: +score.toFixed(4), lines: fused.lines.length, stopped: 'time-budget' });
        break;
      }
      level++;
    }

    /* --- reject hallucinated lines --- */
    // The worse a page was read overall, the more suspicious any given line is:
    // at very low page confidence almost everything the recogniser emits is
    // invention, so the plausibility bar rises with the evidence against it.
    const baseStrict = opts.strictness === 'loose' ? 0.30 : opts.strictness === 'strict' ? 0.48 : 0.40;
    const pageConf = fused.confidence || 0;
    const minScore = pageConf < 40 ? baseStrict + 0.14 : pageConf < 55 ? baseStrict + 0.07 : baseStrict;
    const gate = scope.Ensemble.filterGarbage(fused.lines, { minScore });
    if (gate.rejected.length) ctx.log && ctx.log(`page ${page.index}: rejected ${gate.rejected.length} implausible line(s)`);

    // Page-level abstention.
    //
    // Some pages are past the point where anything can be read from them. When
    // the recogniser's own confidence is low AND the little that survived the
    // line gate is not made of real words, the correct output is nothing at
    // all: a user is far better served by "this page could not be read" than by
    // a page of confident noise, which they might not notice is noise.
    const keptText = gate.lines.map((l) => l.text).join(' ');
    const keptLex = scope.Ensemble.strictLexScore(keptText);
    const rejectRatio = (gate.rejected.length) / Math.max(1, gate.lines.length + gate.rejected.length);
    // Thresholds calibrated against the measured suite: pages that were read
    // correctly score 72-97% confidence with 0.90-1.00 lexicality, while pages
    // whose output is noise score 28-29% with 0.68-0.74. The rule sits in that
    // gap and requires both signals to agree before discarding a page.
    const unreadable = pageConf < 50 && keptLex < 0.85 && gate.lines.length > 0;
    if (unreadable) {
      ctx.log && ctx.log(`page ${page.index}: unreadable (confidence ${pageConf.toFixed(0)}%, lexicality ${keptLex.toFixed(2)}) — abstaining`);
      gate.rejected.push(...gate.lines.map((l) => ({ text: l.text, conf: l.conf, reason: 'page-unreadable', bbox: l.bbox })));
      gate.lines = [];
    }

    /* --- post-processing --- */
    const tpp = now();
    const { lines: repaired, corrections } = scope.PostProcess.repairLines(gate.lines, {
      enabled: opts.correct !== false,
      straightQuotes: !!opts.straightQuotes,
    });
    timings.postprocess = now() - tpp;
    report('structure', 85);

    /* --- structure --- */
    const tl = now();
    const layout = scope.Layout.analyze(repaired, canonical.cols, canonical.rows, { singleColumn: opts.singleColumn });
    let tables = [];
    if (opts.tables !== false && !unreadable && repaired.length) {
      let bin = null;
      try {
        // Rules matter more than glyphs here, and rotation leaves them
        // anti-aliased to grey. A global threshold on the flattened page keeps
        // thin grey rules that adaptive thresholding discards, which is the
        // difference between a deskewed table being recognised as a table and
        // collapsing into loose text.
        const flat = scope.Restore.flattenIllumination(cv, canonical);
        bin = scope.Restore.otsu(cv, flat);
        flat.delete();
        tables = scope.Tables.detect(cv, bin, repaired, layout.stats, {});
      } catch (err) {
        ctx.log && ctx.log(`table detection failed: ${err}`);
      } finally { if (bin) bin.delete(); }
    }
    // Blocks fully inside a table are represented by the table instead.
    const tableBoxes = tables.map((t) => t.bbox);
    const blocks = layout.blocks.filter((b) => !tableBoxes.some((tb) => b.bbox.x0 >= tb.x0 - 4 && b.bbox.x1 <= tb.x1 + 4 && b.bbox.y0 >= tb.y0 - 4 && b.bbox.y1 <= tb.y1 + 4));
    timings.layout = now() - tl;

    /* --- export image --- */
    let image = null;
    if (opts.exportImage !== false) {
      const ti = now();
      const clean = opts.enhanceExport === false
        ? canonical.clone()
        : scope.Restore.normalizeLevels(cv, scope.Restore.flattenIllumination(cv, canonical));
      image = await encodeImage(cv, clean, { type: opts.imageType || 'image/jpeg', quality: opts.imageQuality ?? 0.85 });
      clean.delete();
      timings.encode = now() - ti;
    }

    const words = repaired.flatMap((l) => l.words);
    const result = {
      index: page.index,
      name: page.name,
      width: canonical.cols,
      height: canonical.rows,
      originalWidth: page.imageData.width,
      originalHeight: page.imageData.height,
      dpi,
      profile: prof,
      depth: depthInfo,
      rotation,
      transform: { toCanonical, toOriginal },
      geometrySteps: norm.steps,
      lines: repaired.map((l) => ({
        text: l.text,
        conf: l.conf,
        bbox: l.bbox,
        bboxOriginal: M.box(toOriginal, l.bbox),
        words: l.words.map((w) => ({ ...w, bboxOriginal: M.box(toOriginal, w.bbox) })),
      })),
      blocks,
      tables,
      columns: layout.columns.length,
      text: buildPageText(blocks, tables),
      confidence: words.length ? words.reduce((s, w) => s + w.conf, 0) / words.length : 0,
      score,
      agreement: fused.agreement,
      wordCount: words.length,
      corrections,
      unreadable,
      keptLexicality: +keptLex.toFixed(3),
      rejectRatio: +rejectRatio.toFixed(3),
      rejected: gate.rejected,
      attempts,
      variantsRun: all.map((r) => ({ id: r.variant.id, scale: r.variant.scale, psm: r.result.meta.psm, conf: +r.result.confidence.toFixed(1), ms: Math.round(r.ms) })),
      image,
      debugImages: opts.dumpVariants ? debugImages : undefined,
      canonicalImage: opts.dumpVariants ? await encodeImage(cv, canonical, { type: 'image/png' }) : undefined,
      timings: { ...timings, total: now() - t0 },
    };

    gray.delete(); canonical.delete();
    report('done', 100);
    return result;
  }

  scope.Pipeline = { processPage, PROFILES, pageScore, encodeImage, detectRotation, buildPageText };
})(self);
