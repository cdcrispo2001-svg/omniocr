'use strict';
/* OmniOCR — degradation profiling.
 *
 * Everything downstream (which restoration variants to build, how far to
 * upscale, how many OCR passes to spend) is driven by this profile, so the
 * engine spends effort only where the page actually needs it.
 */
(function (scope) {
  const { M } = scope.CVB;

  /** Variance of the Laplacian — the standard focus/blur measure. */
  function sharpness(cv, gray) {
    const lap = new cv.Mat();
    cv.Laplacian(gray, lap, cv.CV_16S, 3);      // 16S is ~6x faster than 64F here
    const mean = new cv.Mat(); const std = new cv.Mat();
    cv.meanStdDev(lap, mean, std);
    const v = std.data64F[0] ** 2;
    lap.delete(); mean.delete(); std.delete();
    return v;
  }

  /** Noise sigma via median-residual (robust to text edges). */
  function noiseSigma(cv, gray) {
    const med = new cv.Mat();
    cv.medianBlur(gray, med, 3);
    const diff = new cv.Mat();
    cv.absdiff(gray, med, diff);
    const mean = new cv.Mat(); const std = new cv.Mat();
    cv.meanStdDev(diff, mean, std);
    const v = mean.data64F[0] * 1.4826;
    med.delete(); diff.delete(); mean.delete(); std.delete();
    return v;
  }

  /** Large-scale illumination spread (shadows, stains, uneven lighting). */
  function illumination(cv, gray) {
    const small = new cv.Mat();
    const k = Math.max(3, Math.round(Math.min(gray.cols, gray.rows) / 12) | 1);
    cv.GaussianBlur(gray, small, new cv.Size(k, k), 0, 0, cv.BORDER_REPLICATE);
    const mean = new cv.Mat(); const std = new cv.Mat();
    cv.meanStdDev(small, mean, std);
    const r = { std: std.data64F[0], mean: mean.data64F[0] };
    small.delete(); mean.delete(); std.delete();
    return r;
  }

  /**
   * Character-size statistics from connected components of a rough binarisation.
   * Yields x-height (px), effective DPI, ink coverage and a foreign-mark score
   * (fraction of ink belonging to blobs far larger than the text body).
   */
  function componentStats(cv, gray) {
    const bin = new cv.Mat();
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const labels = new cv.Mat(); const stats = new cv.Mat(); const cent = new cv.Mat();
    const n = cv.connectedComponentsWithStats(bin, labels, stats, cent, 8, cv.CV_32S);

    const heights = [];
    let inkArea = 0; let bigArea = 0; let specks = 0; let total = 0;
    const pageArea = gray.cols * gray.rows;
    const maxTextH = gray.rows * 0.18;
    for (let i = 1; i < n; i++) {
      const w = stats.intAt(i, cv.CC_STAT_WIDTH);
      const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
      const a = stats.intAt(i, cv.CC_STAT_AREA);
      inkArea += a; total++;
      if (a <= 3) specks++;
      const ar = w / Math.max(1, h);
      if (h >= 4 && h <= maxTextH && ar > 0.05 && ar < 12 && a > 6) heights.push(h);
      else if (a > pageArea * 0.002) bigArea += a;
    }
    heights.sort((a, b) => a - b);
    const median = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
    // Component height ≈ cap height; x-height ≈ 0.72 of it for common serif/sans faces.
    const xHeight = median * 0.72;
    bin.delete(); labels.delete(); stats.delete(); cent.delete();
    return {
      componentHeight: median,
      xHeight,
      estDpi: median ? Math.round((median / 15.5) * 300) : 0, // 15.5px cap-height ≈ 10-11pt @300dpi
      inkRatio: inkArea / pageArea,
      foreignMarkScore: inkArea ? bigArea / inkArea : 0,
      speckRatio: total ? specks / total : 0,
      componentCount: total,
    };
  }

  /** Dominant text-line angle in degrees (positive = counter-clockwise). */
  function skewAngle(cv, gray) {
    const g = scope.CVB.scopeGuard();
    try {
      const scale = Math.min(1, 1200 / Math.max(gray.cols, gray.rows));
      const small = g.new();
      cv.resize(gray, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
      const bin = g.new();
      cv.threshold(small, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      // Smear horizontally so each text line becomes one elongated blob.
      const kern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(Math.max(9, (small.cols / 40) | 0), 1));
      const smear = g.new();
      cv.morphologyEx(bin, smear, cv.MORPH_CLOSE, kern);
      kern.delete();
      const contours = new cv.MatVector(); const hier = g.new();
      cv.findContours(smear, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      const samples = [];
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const r = cv.minAreaRect(c);
        const w = Math.max(r.size.width, r.size.height);
        const h = Math.min(r.size.width, r.size.height);
        if (w > small.cols * 0.08 && w / Math.max(1, h) > 3) {
          let a = r.angle;
          if (r.size.width < r.size.height) a += 90;
          if (a > 45) a -= 90;
          if (a < -45) a += 90;
          if (Math.abs(a) <= 20) samples.push({ a, w });
        }
        c.delete();
      }
      contours.delete();
      if (!samples.length) return 0;
      samples.sort((p, q) => p.a - q.a);
      // Length-weighted median: long lines are far more reliable than short ones.
      const totalW = samples.reduce((s, x) => s + x.w, 0);
      let acc = 0;
      for (const s of samples) { acc += s.w; if (acc >= totalW / 2) return -s.a; }
      return -samples[samples.length - 1].a;
    } finally {
      g.free();
    }
  }

  /**
   * Ink-to-paper separation. A global percentile spread is useless on text
   * pages (95% of pixels are paper), so split at Otsu and measure the gap
   * between the two populations — that is what "faint" actually means.
   */
  function inkContrast(cv, gray) {
    const bin = new cv.Mat();
    const t = cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    bin.delete();
    const hist = scope.CVB.histogram(gray);
    let inkSum = 0; let inkN = 0; let paperSum = 0; let paperN = 0;
    for (let i = 0; i < 256; i++) {
      if (i <= t) { inkSum += i * hist[i]; inkN += hist[i]; }
      else { paperSum += i * hist[i]; paperN += hist[i]; }
    }
    const ink = inkN ? inkSum / inkN : 0;
    const paper = paperN ? paperSum / paperN : 255;
    return { contrast: paper - ink, ink, paper, otsu: t };
  }

  /** Light text on a dark background? */
  function isInverted(cv, gray) {
    const hist = scope.CVB.histogram(gray);
    const total = gray.rows * gray.cols;
    const median = scope.CVB.percentileFromHist(hist, total, 0.5);
    return median < 100;
  }

  function classify(p) {
    let score = 0;
    if (p.sharpness < 60) score += 2; else if (p.sharpness < 200) score += 1;
    if (p.noiseSigma > 6) score += 2; else if (p.noiseSigma > 3) score += 1;
    if (p.contrast < 60) score += 2; else if (p.contrast < 110) score += 1;
    if (p.illumStd > 22) score += 2; else if (p.illumStd > 12) score += 1;
    if (p.xHeight && p.xHeight < 9) score += 2; else if (p.xHeight && p.xHeight < 13) score += 1;
    if (Math.abs(p.skew) > 2) score += 1;
    if (p.foreignMarkScore > 0.25) score += 2; else if (p.foreignMarkScore > 0.1) score += 1;
    if (p.speckRatio > 0.35) score += 1;
    if (score >= 8) return 'severe';
    if (score >= 5) return 'degraded';
    if (score >= 2) return 'moderate';
    return 'clean';
  }

  /**
   * Profile the page.
   *
   * All measurements are taken at a fixed working resolution (long edge
   * WORK_EDGE). That keeps every threshold in classify() meaningful regardless
   * of whether the input was a 150 dpi fax or a 600 dpi archival scan, and it
   * keeps profiling cost constant instead of quadratic in scan resolution.
   * Size-dependent outputs are converted back to original pixels.
   */
  const WORK_EDGE = 1500;

  function profile(cv, gray) {
    const scale = Math.min(1, WORK_EDGE / Math.max(gray.cols, gray.rows));
    let work = gray;
    let tmp = null;
    if (scale < 1) {
      tmp = new cv.Mat();
      cv.resize(gray, tmp, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
      work = tmp;
    }
    try {
      const hist = scope.CVB.histogram(work);
      const total = work.rows * work.cols;
      const p5 = scope.CVB.percentileFromHist(hist, total, 0.05);
      const p95 = scope.CVB.percentileFromHist(hist, total, 0.95);
      const illum = illumination(cv, work);
      const comp = componentStats(cv, work);
      const ic = inkContrast(cv, work);
      const out = {
        width: gray.cols,
        height: gray.rows,
        workScale: scale,
        sharpness: sharpness(cv, work),
        noiseSigma: noiseSigma(cv, work),
        contrast: ic.contrast,
        inkLevel: ic.ink,
        paperLevel: ic.paper,
        globalSpread: p95 - p5,
        p5,
        p95,
        illumStd: illum.std,
        illumMean: illum.mean,
        skew: skewAngle(cv, work),
        inverted: isInverted(cv, work),
        ...comp,
        // back to original-image pixels
        componentHeight: comp.componentHeight / scale,
        xHeight: comp.xHeight / scale,
        estDpi: comp.componentHeight ? Math.round(((comp.componentHeight / scale) / 15.5) * 300) : 0,
      };
      out.tier = classify(out);
      return out;
    } finally {
      if (tmp) tmp.delete();
    }
  }

  scope.Quality = { profile, skewAngle, componentStats, isInverted, inkContrast };
})(self);
