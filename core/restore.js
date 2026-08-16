'use strict';
/* OmniOCR — image restoration and variant synthesis.
 *
 * The engine does not bet on one "best" enhancement. It synthesises a set of
 * restoration variants chosen from the degradation profile, OCRs several of
 * them, and fuses the results (see ensemble.js). This is what makes faint,
 * smudged, speckled and pixellated pages recoverable without hurting clean ones.
 */
(function (scope) {
  const { odd } = scope.CVB;

  /* ---------------- primitive operations ---------------- */

  /**
   * Illumination flattening: divide the page by its own low-frequency
   * background. Removes shadows, coffee stains, show-through and uneven
   * scanner lighting while leaving stroke contrast intact.
   */
  /**
   * @param span  background kernel as a fraction of the image's long edge.
   *              Small spans (default) flatten local staining; large spans
   *              remove only broad lighting gradients while preserving
   *              page-sized structures such as the sheet's own border.
   */
  function flattenIllumination(cv, gray, strength = 1, span = 0.13) {
    // The background estimate is by definition low-frequency, so it is computed
    // on a small copy and scaled back up. A direct large-kernel blur on a
    // 300 dpi page costs seconds; this costs milliseconds and is equivalent.
    const bg = new cv.Mat();
    const target = 160;
    const s = Math.min(1, target / Math.max(gray.cols, gray.rows));
    if (s < 0.9) {
      const small = new cv.Mat();
      cv.resize(gray, small, new cv.Size(0, 0), s, s, cv.INTER_AREA);
      const blurred = new cv.Mat();
      const k = odd(Math.max(3, Math.round(Math.max(small.cols, small.rows) * span)));
      cv.GaussianBlur(small, blurred, new cv.Size(k, k), 0, 0, cv.BORDER_REPLICATE);
      cv.resize(blurred, bg, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_CUBIC);
      small.delete(); blurred.delete();
    } else {
      const k = odd(Math.max(15, Math.min(gray.cols, gray.rows) / 8));
      cv.GaussianBlur(gray, bg, new cv.Size(k, k), 0, 0, cv.BORDER_REPLICATE);
    }
    const f32 = new cv.Mat(); const bg32 = new cv.Mat();
    gray.convertTo(f32, cv.CV_32F);
    bg.convertTo(bg32, cv.CV_32F, 1, 1);        // +1 guards against divide-by-zero
    const div = new cv.Mat();
    cv.divide(f32, bg32, div, 255 * 0.85);
    const out = new cv.Mat();
    div.convertTo(out, cv.CV_8U);
    if (strength < 1) cv.addWeighted(gray, 1 - strength, out, strength, 0, out);
    bg.delete(); f32.delete(); bg32.delete(); div.delete();
    return out;
  }

  /** Local contrast boost — the main lever for faint / washed-out text. */
  function clahe(cv, gray, clip = 2.5, tiles = 8) {
    const out = new cv.Mat();
    const c = new cv.CLAHE(clip, new cv.Size(tiles, tiles));
    c.apply(gray, out);
    c.delete();
    return out;
  }

  /** Stretch the ink/paper range to full scale using robust percentiles. */
  function normalizeLevels(cv, gray, lowP = 0.02, highP = 0.98) {
    const hist = scope.CVB.histogram(gray);
    const total = gray.rows * gray.cols;
    let lo = scope.CVB.percentileFromHist(hist, total, lowP);
    let hi = scope.CVB.percentileFromHist(hist, total, highP);
    if (hi - lo < 12) { lo = Math.max(0, lo - 10); hi = Math.min(255, hi + 10); }
    const out = new cv.Mat();
    const alpha = 255 / Math.max(1, hi - lo);
    gray.convertTo(out, cv.CV_8U, alpha, -lo * alpha);
    return out;
  }

  function unsharp(cv, gray, amount = 1.0, radius = 3) {
    const blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(odd(radius), odd(radius)), 0);
    const out = new cv.Mat();
    cv.addWeighted(gray, 1 + amount, blur, -amount, 0, out);
    blur.delete();
    return out;
  }

  /**
   * @param speckRatio fraction of ink components that are single specks.
   *        Dust and toner spatter are impulsive noise: they barely move the
   *        Gaussian sigma estimate, yet a median filter removes them outright
   *        while a bilateral filter preserves them faithfully.
   */
  function denoise(cv, gray, sigma, speckRatio = 0) {
    const out = new cv.Mat();
    if (speckRatio > 0.3 && sigma <= 8) {
      const med = new cv.Mat();
      cv.medianBlur(gray, med, 3);
      cv.bilateralFilter(med, out, 5, 25, 25);
      med.delete();
      return out;
    }
    if (sigma > 8) {
      const med = new cv.Mat();
      cv.medianBlur(gray, med, 3);
      cv.bilateralFilter(med, out, 5, 45, 45);
      med.delete();
    } else if (sigma > 3.5) {
      cv.medianBlur(gray, out, 3);
    } else {
      cv.bilateralFilter(gray, out, 5, 25, 25);
    }
    return out;
  }

  /**
   * Sauvola adaptive binarisation via integral images.
   * Far better than Otsu on pages with stains, gradients or faint ink.
   */
  function sauvola(cv, gray, window, k = 0.25, R = 128) {
    // Local mean and variance come from separable box filters in float32.
    // The textbook formulation uses double-precision integral images, but on a
    // 300 dpi page those are ~140 MB each and can exhaust the WASM heap on
    // heavily speckled scans; box filters give the same result in a fraction of
    // the memory and run in native code rather than a JS loop.
    const win = Math.max(7, window | 1);
    const ks = new cv.Size(win, win);
    const g32 = new cv.Mat();
    gray.convertTo(g32, cv.CV_32F);

    const mean = new cv.Mat();
    cv.boxFilter(g32, mean, cv.CV_32F, ks, new cv.Point(-1, -1), true, cv.BORDER_REPLICATE);

    const sq = new cv.Mat();
    cv.multiply(g32, g32, sq);
    const meanSq = new cv.Mat();
    cv.boxFilter(sq, meanSq, cv.CV_32F, ks, new cv.Point(-1, -1), true, cv.BORDER_REPLICATE);

    // variance = E[x²] − E[x]²  → std
    const meanPow = new cv.Mat();
    cv.multiply(mean, mean, meanPow);
    const variance = new cv.Mat();
    cv.subtract(meanSq, meanPow, variance);
    // Float rounding can push variance slightly negative; clamp before sqrt.
    cv.threshold(variance, variance, 0, 0, cv.THRESH_TOZERO);
    const std = new cv.Mat();
    cv.sqrt(variance, std);

    // threshold = mean · (1 + k·(std/R − 1)) = mean · ((k/R)·std + (1 − k))
    // Folding the affine part into convertTo avoids allocating scalar Mats,
    // which at page resolution cost ~35 MB each and exhausted the WASM heap.
    const factor = new cv.Mat();
    std.convertTo(factor, cv.CV_32F, k / R, 1 - k);
    const thresh = new cv.Mat();
    cv.multiply(mean, factor, thresh);

    const out = new cv.Mat();
    cv.compare(g32, thresh, out, cv.CMP_GT);            // 255 where lighter than threshold

    g32.delete(); mean.delete(); sq.delete(); meanSq.delete(); meanPow.delete();
    variance.delete(); std.delete(); factor.delete(); thresh.delete();
    return out;
  }

  function otsu(cv, gray) {
    const out = new cv.Mat();
    cv.threshold(gray, out, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    return out;
  }

  function adaptiveGaussian(cv, gray, block, C = 12) {
    const out = new cv.Mat();
    cv.adaptiveThreshold(gray, out, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, odd(block), C);
    return out;
  }

  /**
   * Remove speckle and foreign marks: drop connected components that are far
   * too small (dust, scanner noise) or far too large/dense (staples, punch
   * holes, ink blots, stamp edges) to be text — but never touch anything that
   * overlaps the dominant text-size band.
   */
  function despeckle(cv, binary, prof, aggressive = false) {
    const inv = new cv.Mat();
    cv.bitwise_not(binary, inv);                       // ink = white for CC analysis
    const labels = new cv.Mat(); const stats = new cv.Mat(); const cent = new cv.Mat();
    const n = cv.connectedComponentsWithStats(inv, labels, stats, cent, 8, cv.CV_32S);
    const charH = Math.max(6, prof.componentHeight || 14);

    // Dust, toner spatter and scanner grain overlap in size with legitimate
    // punctuation, so size alone cannot separate them. What does separate them
    // is company: a full stop sits on a text line beside letter-sized
    // neighbours, while a speck sits alone in the middle of nowhere.
    const smallArea = (charH * charH) * (aggressive ? 0.16 : 0.10);
    const tinyArea = Math.max(2, (charH * charH) * 0.008);
    const maxH = charH * 6;
    const maxArea = charH * charH * 45;

    const boxes = new Array(n);
    const anchors = new Map();                          // row band → anchor x positions
    const band = Math.max(4, charH * 0.9);
    for (let i = 1; i < n; i++) {
      const x = stats.intAt(i, cv.CC_STAT_LEFT);
      const y = stats.intAt(i, cv.CC_STAT_TOP);
      const w = stats.intAt(i, cv.CC_STAT_WIDTH);
      const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      const a = stats.intAt(i, cv.CC_STAT_AREA);
      boxes[i] = { x, y, w, h, a, cx: x + w / 2, cy: y + h / 2 };
      // "Anchor" = something clearly letter-shaped, used to locate real text.
      if (h >= charH * 0.45 && h <= charH * 2.2 && a >= charH * charH * 0.12 && w <= charH * 3) {
        const key = Math.round(boxes[i].cy / band);
        if (!anchors.has(key)) anchors.set(key, []);
        anchors.get(key).push(boxes[i].cx);
      }
    }
    for (const list of anchors.values()) list.sort((a, b) => a - b);

    const nearAnchor = (b) => {
      const key = Math.round(b.cy / band);
      const reach = charH * 3.5;
      for (let k = key - 1; k <= key + 1; k++) {
        const list = anchors.get(k);
        if (!list || !list.length) continue;
        // binary search for the closest anchor on this row band
        let lo = 0; let hi = list.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < b.cx) lo = mid + 1; else hi = mid; }
        for (const idx of [lo - 1, lo, lo + 1]) {
          if (idx >= 0 && idx < list.length && Math.abs(list[idx] - b.cx) <= reach) return true;
        }
      }
      return false;
    };

    const kill = new Uint8Array(n);
    for (let i = 1; i < n; i++) {
      const b = boxes[i];
      if (b.a <= tinyArea) { kill[i] = 1; continue; }               // always noise
      if (b.a < smallArea && !nearAnchor(b)) { kill[i] = 1; continue; }  // isolated speck
      const fill = b.a / Math.max(1, b.w * b.h);
      // Big, solid blobs are blots/stains; big sparse ones may be rules → keep.
      if ((b.h > maxH || b.a > maxArea) && fill > 0.55 && Math.min(b.w, b.h) > charH * 1.5) kill[i] = 1;
    }
    const lab = labels.data32S;
    const dst = binary.clone();
    const d = dst.data;
    for (let i = 0; i < lab.length; i++) if (kill[lab[i]]) d[i] = 255;
    inv.delete(); labels.delete(); stats.delete(); cent.delete();
    return dst;
  }

  /** Close 1-2px gaps in broken/faint strokes without merging characters. */
  function repairStrokes(cv, binary, charH) {
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2, 2));
    const inv = new cv.Mat();
    cv.bitwise_not(binary, inv);
    const closed = new cv.Mat();
    cv.morphologyEx(inv, closed, cv.MORPH_CLOSE, k);
    const out = new cv.Mat();
    cv.bitwise_not(closed, out);
    k.delete(); inv.delete(); closed.delete();
    return out;
  }

  /** Thin over-inked / smudged bold strokes so characters separate again. */
  function thinStrokes(cv, binary) {
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2, 2));
    const inv = new cv.Mat();
    cv.bitwise_not(binary, inv);
    const er = new cv.Mat();
    cv.erode(inv, er, k);
    const out = new cv.Mat();
    cv.bitwise_not(er, out);
    k.delete(); inv.delete(); er.delete();
    return out;
  }

  function upscale(cv, gray, factor) {
    if (factor <= 1.001) return gray.clone();
    const out = new cv.Mat();
    cv.resize(gray, out, new cv.Size(0, 0), factor, factor, cv.INTER_CUBIC);
    return out;
  }

  /* ---------------- variant planning ---------------- */

  /**
   * Choose a working scale for the recogniser.
   *
   * Tesseract's LSTM wants glyphs of a certain pixel size: below roughly 14px
   * median component height accuracy falls away quickly, while above ~40px it
   * gains nothing and costs time quadratically. So we upscale only genuinely
   * small text, and downscale oversampled scans (600 dpi archival material)
   * instead of paying for pixels the recogniser cannot use.
   */
  const TARGET_H = 21;

  function plannedScale(prof, maxScale = 4) {
    const h = prof.componentHeight || 0;
    if (!h) return 1;
    if (h < 14) return Math.min(maxScale, Math.round((TARGET_H / h) * 2) / 2);
    // Oversampled scans cost recognition time quadratically and buy nothing:
    // bring anything above ~24px median glyph height back down to the target.
    if (h > 24) return Math.max(0.5, Math.round((TARGET_H / h) * 20) / 20);
    return 1;
  }

  /**
   * Decide which variants to build for this page. `level` escalates when
   * confidence is unsatisfactory (see pipeline.js).
   */
  function planVariants(prof, level = 0) {
    const tier = prof.tier;
    const plan = [];
    let scale = plannedScale(prof);

    // A page carrying tens of thousands of ink fragments is a speckle field.
    // Upscaling it multiplies the fragments and drives Tesseract's layout
    // analysis into pathological cost, so such pages get harder cleaning at
    // native scale instead of more pixels.
    const speckled = (prof.componentCount || 0) > 12000;
    if (speckled) scale = Math.min(scale, 1);

    // Absolute ceiling on what any single recognition pass may process. Beyond
    // roughly 12 MP the recogniser gains nothing and memory/time costs rise
    // steeply, so oversized pages are worked at a reduced scale.
    const pagePixels = (prof.width || 0) * (prof.height || 0);
    const MAX_PIXELS = 12e6;
    if (pagePixels * scale * scale > MAX_PIXELS) {
      scale = Math.max(0.35, Math.sqrt(MAX_PIXELS / Math.max(1, pagePixels)));
      scale = Math.round(scale * 20) / 20;
    }

    plan.push({ id: 'gray', scale, ops: ['flatten', 'levels'] });               // LSTM likes greyscale
    if (tier !== 'clean' || level > 0) {
      plan.push({ id: 'clahe-sauvola', scale, ops: ['flatten', 'clahe', 'denoise', 'sauvola', 'despeckle'] });
    }
    if (tier === 'clean' && level === 0) {
      plan.push({ id: 'otsu', scale, ops: ['flatten', 'otsu'] });
    }
    if (tier === 'moderate' || tier === 'degraded' || tier === 'severe' || level > 0) {
      plan.push({ id: 'sharp-adaptive', scale, ops: ['flatten', 'denoise', 'unsharp', 'adaptive', 'despeckle'] });
    }
    // Faint or soft pages get the aggressive recipe immediately rather than
    // after a failed round: on washed-out originals it is usually the only
    // variant that recovers anything, and discovering that late costs a full
    // escalation cycle.
    const needsBoost = tier === 'degraded' || tier === 'severe' || level > 0
      || prof.contrast < 90 || prof.sharpness < 60;
    if (needsBoost) {
      plan.push({ id: 'boost', scale: Math.min(4, speckled ? scale : scale * 1.5), ops: ['flatten', 'clahe-strong', 'denoise', 'unsharp', 'sauvola-tight', 'despeckle-hard', 'repair'] });
    }
    if (level > 0) {
      plan.push({ id: 'gray-soft', scale: Math.min(4, scale * 1.5), ops: ['flatten', 'clahe', 'denoise'] });
    }
    if (level > 1) {
      plan.push({ id: 'thin', scale, ops: ['flatten', 'clahe', 'sauvola', 'thin', 'despeckle'] });
      plan.push({ id: 'raw', scale: 1, ops: [] });
    }
    if (prof.inverted) plan.forEach((p) => { p.invert = true; });
    if (speckled) {
      // Escalate every despeckle to its aggressive form and add a repair pass,
      // since broken strokes are the usual side effect of hard cleaning.
      for (const v of plan) {
        v.ops = v.ops.map((o) => (o === 'despeckle' ? 'despeckle-hard' : o));
        if (v.ops.includes('despeckle-hard') && !v.ops.includes('repair')) v.ops.push('repair');
      }
    }
    return plan;
  }

  /** Build one variant image from the canonical greyscale page. */
  function buildVariant(cv, canonical, prof, variant) {
    let cur = canonical.clone();
    const swap = (next) => { cur.delete(); cur = next; };

    if (variant.invert) { const t = new cv.Mat(); cv.bitwise_not(cur, t); swap(t); }
    if (variant.scale > 1.001) swap(upscale(cv, cur, variant.scale));
    else if (variant.scale < 0.999) {
      const down = new cv.Mat();
      cv.resize(cur, down, new cv.Size(0, 0), variant.scale, variant.scale, cv.INTER_AREA);
      swap(down);
    }
    const charH = Math.max(6, (prof.componentHeight || 14) * variant.scale);

    for (const op of variant.ops) {
      switch (op) {
        case 'flatten': swap(flattenIllumination(cv, cur)); break;
        case 'levels': swap(normalizeLevels(cv, cur)); break;
        case 'clahe': swap(clahe(cv, cur, 2.5, 8)); break;
        case 'clahe-strong': swap(clahe(cv, cur, 4.0, 6)); break;
        case 'denoise': swap(denoise(cv, cur, prof.noiseSigma, prof.speckRatio)); break;
        case 'unsharp': swap(unsharp(cv, cur, prof.sharpness < 80 ? 1.4 : 0.7, 3)); break;
        case 'otsu': swap(otsu(cv, cur)); break;
        case 'sauvola': swap(sauvola(cv, cur, Math.max(15, charH * 1.6), 0.22)); break;
        case 'sauvola-tight': swap(sauvola(cv, cur, Math.max(11, charH * 1.1), 0.12)); break;
        case 'adaptive': swap(adaptiveGaussian(cv, cur, Math.max(15, charH * 2), 10)); break;
        case 'despeckle': swap(despeckle(cv, cur, prof, false)); break;
        case 'despeckle-hard': swap(despeckle(cv, cur, prof, true)); break;
        case 'repair': swap(repairStrokes(cv, cur, charH)); break;
        case 'thin': swap(thinStrokes(cv, cur)); break;
        default: break;
      }
    }
    return cur;
  }

  scope.Restore = {
    flattenIllumination, clahe, normalizeLevels, unsharp, denoise, sauvola, otsu,
    adaptiveGaussian, despeckle, repairStrokes, thinStrokes, upscale,
    planVariants, buildVariant, plannedScale,
  };
})(self);
