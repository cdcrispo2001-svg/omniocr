'use strict';
/* OmniOCR — geometric normalisation (page detection, dewarp, rotation, deskew).
 *
 * Every operation is also accumulated into a 3x3 matrix mapping ORIGINAL page
 * pixels to CANONICAL (corrected) pixels. Inverting it puts every OCR box back
 * into the coordinate space of the untouched page, which is what lets exports
 * keep the document's original structure and geometry.
 */
(function (scope) {
  const { M } = scope.CVB;

  /* ---------------- page boundary ---------------- */

  function orderQuad(pts) {
    const byY = [...pts].sort((a, b) => a[1] - b[1]);
    const top = byY.slice(0, 2).sort((a, b) => a[0] - b[0]);
    const bot = byY.slice(2).sort((a, b) => a[0] - b[0]);
    return [top[0], top[1], bot[1], bot[0]]; // TL, TR, BR, BL
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  function quadIsSane(quad, w, h) {
    const area = Math.abs(
      (quad[0][0] * quad[1][1] - quad[1][0] * quad[0][1])
      + (quad[1][0] * quad[2][1] - quad[2][0] * quad[1][1])
      + (quad[2][0] * quad[3][1] - quad[3][0] * quad[2][1])
      + (quad[3][0] * quad[0][1] - quad[0][0] * quad[3][1]),
    ) / 2;
    if (area < w * h * 0.25) return false;                  // too small to be the page
    const sides = [dist(quad[0], quad[1]), dist(quad[1], quad[2]), dist(quad[2], quad[3]), dist(quad[3], quad[0])];
    if (Math.min(...sides) < Math.max(w, h) * 0.15) return false;
    // Reject wildly non-convex / spiky quads by checking opposite-side ratios.
    const rw = sides[0] / sides[2];
    const rh = sides[1] / sides[3];
    return rw > 0.55 && rw < 1.8 && rh > 0.55 && rh < 1.8;
  }

  /** Reduce a contour to four corners, trying progressively looser tolerances. */
  function quadFromContour(cv, contour) {
    const peri = cv.arcLength(contour, true);
    const approx = new cv.Mat();
    try {
      for (const eps of [0.015, 0.02, 0.03, 0.045, 0.06, 0.08]) {
        cv.approxPolyDP(contour, approx, eps * peri, true);
        if (approx.rows === 4) {
          const pts = [];
          for (let j = 0; j < 4; j++) pts.push([approx.intAt(j, 0), approx.intAt(j, 1)]);
          return pts;
        }
      }
      // Nothing simplified to a quadrilateral: fall back to the minimum-area
      // rectangle, which still captures rotation even if it ignores perspective.
      const r = cv.minAreaRect(contour);
      const box = cv.RotatedRect.points(r);
      return box.map((p) => [p.x, p.y]);
    } finally {
      approx.delete();
    }
  }

  /**
   * Page detection by brightness segmentation.
   *
   * A photographed page is a bright quadrilateral on a darker surface, which
   * separates far more reliably than an edge map does — Canny contours around a
   * page are routinely broken by shadow, low contrast at one corner, or the
   * page running off frame, and a broken contour never simplifies to a quad.
   */
  function detectPageQuadByBrightness(cv, gray) {
    const g = scope.CVB.scopeGuard();
    try {
      const scale = Math.min(1, 900 / Math.max(gray.cols, gray.rows));
      const small = g.new();
      cv.resize(gray, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
      // A wide-span flatten evens out lamp falloff (which otherwise pushes a
      // whole corner of the page below the threshold) while leaving the sharp
      // page-versus-surface step that detection depends on.
      const evened = g.add(scope.Restore.flattenIllumination(cv, small, 1, 0.45));
      const blur = g.new();
      cv.GaussianBlur(evened, blur, new cv.Size(9, 9), 0);
      const bin = g.new();
      cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

      // Close the text back into the page body so the sheet is one solid blob.
      const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(13, 13));
      cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k);
      cv.morphologyEx(bin, bin, cv.MORPH_OPEN, k);
      k.delete();

      const labels = g.new(); const stats = g.new(); const cent = g.new();
      const n = cv.connectedComponentsWithStats(bin, labels, stats, cent, 8, cv.CV_32S);
      const total = small.cols * small.rows;
      let best = -1; let bestArea = 0;
      for (let i = 1; i < n; i++) {
        const a = stats.intAt(i, cv.CC_STAT_AREA);
        if (a > bestArea) { bestArea = a; best = i; }
      }
      // Too small to be the page, or so large that there is no visible border
      // to rectify against — in both cases leave the image alone.
      if (best < 0 || bestArea < total * 0.25 || bestArea > total * 0.965) return null;

      const mask = g.new(small.rows, small.cols, cv.CV_8UC1);
      const lab = labels.data32S;
      const md = mask.data;
      for (let i = 0; i < lab.length; i++) md[i] = lab[i] === best ? 255 : 0;

      const contours = new cv.MatVector(); const hier = g.new();
      cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let quad = null;
      let area = 0;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const a = cv.contourArea(c);
        if (a > area) {
          area = a;
          // A sheet of paper is convex. Taking the hull restores corners that
          // fell below the threshold because a shadow darkened them — without
          // it, a shadowed corner is simply cropped off the page.
          const hull = new cv.Mat();
          cv.convexHull(c, hull, false, true);
          quad = quadFromContour(cv, hull);
          hull.delete();
        }
        c.delete();
      }
      contours.delete();
      if (!quad) return null;
      const scaled = orderQuad(quad).map(([x, y]) => [x / scale, y / scale]);
      return quadIsSane(scaled, gray.cols, gray.rows) ? scaled : null;
    } finally {
      g.free();
    }
  }

  /** Largest plausible 4-gon in the image, in ORIGINAL pixel coordinates. */
  function detectPageQuadByEdges(cv, gray) {
    const g = scope.CVB.scopeGuard();
    try {
      const scale = Math.min(1, 900 / Math.max(gray.cols, gray.rows));
      const small = g.new();
      cv.resize(gray, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
      const blur = g.new();
      cv.GaussianBlur(small, blur, new cv.Size(5, 5), 0);
      const edges = g.new();
      cv.Canny(blur, edges, 40, 120);
      const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
      const closed = g.new();
      cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, k);
      k.delete();

      const contours = new cv.MatVector(); const hier = g.new();
      cv.findContours(closed, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let best = null; let bestArea = 0;
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        const peri = cv.arcLength(c, true);
        const approx = new cv.Mat();
        cv.approxPolyDP(c, approx, 0.02 * peri, true);
        if (approx.rows === 4) {
          const a = Math.abs(cv.contourArea(approx));
          if (a > bestArea) {
            bestArea = a;
            best = [];
            for (let j = 0; j < 4; j++) best.push([approx.intAt(j, 0), approx.intAt(j, 1)]);
          }
        }
        approx.delete(); c.delete();
      }
      contours.delete();
      if (!best) return null;
      const quad = orderQuad(best).map(([x, y]) => [x / scale, y / scale]);
      return quadIsSane(quad, gray.cols, gray.rows) ? quad : null;
    } finally {
      g.free();
    }
  }

  /**
   * Would rectifying to this quad throw away text?
   *
   * A mis-detected page boundary is the most damaging thing geometry can do:
   * it silently deletes content before the recogniser ever sees it. So before
   * accepting a quad we check how much of the page's ink falls outside it, and
   * refuse any crop that would discard a meaningful amount.
   */
  function quadKeepsContent(cv, gray, quad, tolerance = 0.02) {
    const g = scope.CVB.scopeGuard();
    try {
      const scale = Math.min(1, 700 / Math.max(gray.cols, gray.rows));
      const small = g.new();
      cv.resize(gray, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
      // Flatten first: under a shadow, text and the shadow itself are equally
      // dark, and a raw threshold merges them into one giant blob that the
      // size filter then discards — hiding the very loss we are checking for.
      const flat = g.add(scope.Restore.flattenIllumination(cv, small));
      const bin = g.new();
      cv.threshold(flat, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

      // "Dark" alone is not "text": on a photograph the desk surface is darker
      // than the page and would dominate the count. Keep only text-sized
      // components so the question being asked is genuinely "is this crop
      // cutting through writing?".
      const labels = g.new(); const stats = g.new(); const cent = g.new();
      const n = cv.connectedComponentsWithStats(bin, labels, stats, cent, 8, cv.CV_32S);
      const area = small.rows * small.cols;
      const keep = new Uint8Array(n);
      for (let i = 1; i < n; i++) {
        const a = stats.intAt(i, cv.CC_STAT_AREA);
        const w = stats.intAt(i, cv.CC_STAT_WIDTH);
        const h = stats.intAt(i, cv.CC_STAT_HEIGHT);
        if (a < area * 0.02 && h < small.rows * 0.25 && w < small.cols * 0.9) keep[i] = 1;
      }
      const lab = labels.data32S;
      const bd = bin.data;
      for (let i = 0; i < lab.length; i++) if (!keep[lab[i]]) bd[i] = 0;

      const totalInk = cv.countNonZero(bin);
      if (totalInk < 50) return true;                       // nothing to lose

      const mask = g.new(small.rows, small.cols, cv.CV_8UC1, new cv.Scalar(0));
      const pts = quad.map(([x, y]) => [Math.round(x * scale), Math.round(y * scale)]);
      const poly = cv.matFromArray(4, 1, cv.CV_32SC2, pts.flat());
      const vec = new cv.MatVector();
      vec.push_back(poly);
      cv.fillPoly(mask, vec, new cv.Scalar(255));
      poly.delete(); vec.delete();

      const inside = g.new();
      cv.bitwise_and(bin, mask, inside);
      const keptInk = cv.countNonZero(inside);
      return (totalInk - keptInk) / totalInk <= tolerance;
    } catch (_) {
      return true;                                          // never block on a check failure
    } finally {
      g.free();
    }
  }

  /** Brightness segmentation first, edge contours as a fallback. */
  function detectPageQuad(cv, gray) {
    const candidates = [detectPageQuadByBrightness(cv, gray), detectPageQuadByEdges(cv, gray)];
    for (const q of candidates) {
      if (q && quadKeepsContent(cv, gray, q)) return q;
    }
    return null;
  }

  /** Perspective-rectify `src` using `quad`; returns { mat, matrix }. */
  function rectify(cv, src, quad) {
    const [tl, tr, br, bl] = quad;
    const wTop = dist(tl, tr); const wBot = dist(bl, br);
    const hLeft = dist(tl, bl); const hRight = dist(tr, br);
    const outW = Math.round(Math.max(wTop, wBot));
    const outH = Math.round(Math.max(hLeft, hRight));
    if (outW < 50 || outH < 50) return null;

    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [tl[0], tl[1], tr[0], tr[1], br[0], br[1], bl[0], bl[1]]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW, 0, outW, outH, 0, outH]);
    const H = cv.getPerspectiveTransform(srcTri, dstTri);
    const out = new cv.Mat();
    cv.warpPerspective(src, out, H, new cv.Size(outW, outH), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    const matrix = [
      H.doubleAt(0, 0), H.doubleAt(0, 1), H.doubleAt(0, 2),
      H.doubleAt(1, 0), H.doubleAt(1, 1), H.doubleAt(1, 2),
      H.doubleAt(2, 0), H.doubleAt(2, 1), H.doubleAt(2, 2),
    ];
    srcTri.delete(); dstTri.delete(); H.delete();
    return { mat: out, matrix };
  }

  /** Rotate by a multiple of 90°; returns { mat, matrix }. */
  function rotate90(cv, src, k) {
    const n = ((k % 4) + 4) % 4;
    if (n === 0) return { mat: src.clone(), matrix: M.identity() };
    const out = new cv.Mat();
    const code = n === 1 ? cv.ROTATE_90_CLOCKWISE : n === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
    cv.rotate(src, out, code);
    const w = src.cols; const h = src.rows;
    const matrix = n === 1 ? [0, -1, h - 1, 1, 0, 0, 0, 0, 1]
      : n === 2 ? [-1, 0, w - 1, 0, -1, h - 1, 0, 0, 1]
        : [0, 1, 0, -1, 0, w - 1, 0, 0, 1];
    return { mat: out, matrix };
  }

  /** Rotate by an arbitrary angle, expanding the canvas so nothing is clipped. */
  function rotateFine(cv, src, deg) {
    if (Math.abs(deg) < 0.05) return { mat: src.clone(), matrix: M.identity() };
    const w = src.cols; const h = src.rows;
    const rad = (deg * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad)); const sin = Math.abs(Math.sin(rad));
    const nw = Math.round(w * cos + h * sin);
    const nh = Math.round(w * sin + h * cos);
    const center = new cv.Point(w / 2, h / 2);
    const rot = cv.getRotationMatrix2D(center, deg, 1);
    // Shift so the expanded canvas is centred on the original content.
    rot.doubleAt(0, 2); // touch to ensure materialised
    const dx = nw / 2 - w / 2;
    const dy = nh / 2 - h / 2;
    rot.data64F[2] += dx;
    rot.data64F[5] += dy;
    const out = new cv.Mat();
    cv.warpAffine(src, out, rot, new cv.Size(nw, nh), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    const matrix = [
      rot.data64F[0], rot.data64F[1], rot.data64F[2],
      rot.data64F[3], rot.data64F[4], rot.data64F[5],
      0, 0, 1,
    ];
    rot.delete();
    return { mat: out, matrix };
  }

  /**
   * Refine a coarse skew estimate by maximising the variance of the horizontal
   * projection profile — sharp line peaks mean correct alignment.
   */
  function refineSkew(cv, gray, coarse) {
    const g = scope.CVB.scopeGuard();
    try {
      const scale = Math.min(1, 900 / Math.max(gray.cols, gray.rows));
      const small = g.new();
      cv.resize(gray, small, new cv.Size(0, 0), scale, scale, cv.INTER_AREA);
      const bin = g.new();
      cv.threshold(small, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

      const score = (deg) => {
        const gg = scope.CVB.scopeGuard();
        try {
          const rot = gg.new();
          const c = new cv.Point(bin.cols / 2, bin.rows / 2);
          const rm = cv.getRotationMatrix2D(c, deg, 1);
          cv.warpAffine(bin, rot, rm, new cv.Size(bin.cols, bin.rows), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
          rm.delete();
          const proj = gg.new();
          cv.reduce(rot, proj, 1, cv.REDUCE_SUM, cv.CV_32F);
          const d = proj.data32F;
          let mean = 0;
          for (let i = 0; i < d.length; i++) mean += d[i];
          mean /= d.length;
          let v = 0;
          for (let i = 1; i < d.length; i++) v += (d[i] - d[i - 1]) ** 2;   // gradient energy
          return v / (mean * mean + 1);
        } finally { gg.free(); }
      };

      let best = coarse; let bestScore = score(coarse);
      for (const step of [1, 0.25]) {
        for (let d = -4 * step; d <= 4 * step + 1e-9; d += step) {
          const cand = best + d;
          if (Math.abs(cand) > 20) continue;
          const s = score(cand);
          if (s > bestScore) { bestScore = s; best = cand; }
        }
      }
      return best;
    } finally { g.free(); }
  }

  /**
   * Full geometric normalisation.
   * @returns { mat, matrix, steps } — `matrix` maps original → canonical.
   */
  function normalize(cv, srcGray, prof, opts = {}) {
    const steps = [];
    let cur = srcGray.clone();
    let matrix = M.identity();

    if (opts.dewarp !== false) {
      const quad = opts.quad || detectPageQuad(cv, cur);
      if (quad) {
        const r = rectify(cv, cur, quad);
        if (r) {
          cur.delete(); cur = r.mat;
          matrix = M.mul(r.matrix, matrix);
          steps.push({ op: 'rectify', quad });
        }
      }
    }

    if (opts.rotate90 ) {
      const r = rotate90(cv, cur, opts.rotate90 / 90);
      cur.delete(); cur = r.mat;
      matrix = M.mul(r.matrix, matrix);
      steps.push({ op: 'rotate90', deg: opts.rotate90 });
    }

    if (opts.deskew !== false) {
      const coarse = typeof opts.skew === 'number' ? opts.skew : scope.Quality.skewAngle(cv, cur);
      const angle = Math.abs(coarse) > 0.08 || opts.forceRefine ? refineSkew(cv, cur, coarse) : coarse;
      if (Math.abs(angle) > 0.08) {
        const r = rotateFine(cv, cur, angle);
        cur.delete(); cur = r.mat;
        matrix = M.mul(r.matrix, matrix);
        steps.push({ op: 'deskew', deg: +angle.toFixed(3) });
      }
    }

    return { mat: cur, matrix, steps };
  }

  scope.Geometry = { detectPageQuad, detectPageQuadByBrightness, detectPageQuadByEdges, quadFromContour, quadKeepsContent, rectify, rotate90, rotateFine, refineSkew, normalize, quadIsSane, orderQuad };
})(self);
