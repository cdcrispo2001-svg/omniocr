'use strict';
/* OmniOCR — OpenCV bridge and low-level image utilities.
 * Loaded via importScripts() inside the engine worker; exposes `self.CVB`.
 */
(function (scope) {
  let cvMod = null;
  let loading = null;

  /** Resolve the OpenCV WASM module (the build exports a promise-like). */
  function ready() {
    if (cvMod) return Promise.resolve(cvMod);
    if (!loading) {
      loading = Promise.resolve(scope.cv).then((m) => {
        cvMod = m && m.Mat ? m : scope.cv;
        return cvMod;
      });
    }
    return loading;
  }

  const get = () => cvMod;

  /* ---------------- Mat lifecycle helpers ---------------- */

  /** Track Mats so a whole stage can be released even when it throws. */
  function scopeGuard() {
    const mats = [];
    return {
      add(m) { mats.push(m); return m; },
      new(...args) { const cv = get(); const m = new cv.Mat(...args); mats.push(m); return m; },
      free() { for (const m of mats) { try { if (m && !m.isDeleted()) m.delete(); } catch (_) { /* already gone */ } } mats.length = 0; },
    };
  }

  function fromImageData(imgData) {
    const cv = get();
    const m = new cv.Mat(imgData.height, imgData.width, cv.CV_8UC4);
    m.data.set(imgData.data);
    return m;
  }

  function toImageData(mat) {
    const cv = get();
    let rgba = mat;
    let tmp = null;
    if (mat.channels() === 1) { tmp = new cv.Mat(); cv.cvtColor(mat, tmp, cv.COLOR_GRAY2RGBA); rgba = tmp; }
    else if (mat.channels() === 3) { tmp = new cv.Mat(); cv.cvtColor(mat, tmp, cv.COLOR_RGB2RGBA); rgba = tmp; }
    const out = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
    if (tmp) tmp.delete();
    return out;
  }

  function toGray(mat) {
    const cv = get();
    if (mat.channels() === 1) return mat.clone();
    const g = new cv.Mat();
    cv.cvtColor(mat, g, mat.channels() === 4 ? cv.COLOR_RGBA2GRAY : cv.COLOR_RGB2GRAY);
    return g;
  }

  /**
   * Encode an 8-bit single-channel Mat as an uncompressed 8bpp BMP.
   * Leptonica (inside Tesseract) reads this directly; skipping PNG compression
   * saves ~200-400 ms per variant on full-page images.
   */
  function grayToBmp(mat, dpi = 300) {
    const w = mat.cols;
    const h = mat.rows;
    const rowSize = (w + 3) & ~3;             // rows padded to 4 bytes
    const paletteSize = 256 * 4;
    const headerSize = 14 + 40 + paletteSize;
    const dataSize = rowSize * h;
    const buf = new ArrayBuffer(headerSize + dataSize);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4d);              // 'BM'
    dv.setUint32(2, headerSize + dataSize, true);
    dv.setUint32(10, headerSize, true);
    dv.setUint32(14, 40, true);                               // BITMAPINFOHEADER
    dv.setInt32(18, w, true);
    dv.setInt32(22, -h, true);                                // negative = top-down
    dv.setUint16(26, 1, true);
    dv.setUint16(28, 8, true);                                // 8 bpp
    dv.setUint32(34, dataSize, true);
    const ppm = Math.round((dpi || 300) / 0.0254);            // Tesseract reads DPI from here
    dv.setUint32(38, ppm, true); dv.setUint32(42, ppm, true);
    dv.setUint32(46, 256, true); dv.setUint32(50, 256, true);
    for (let i = 0; i < 256; i++) {                           // greyscale palette
      const o = 54 + i * 4;
      u8[o] = i; u8[o + 1] = i; u8[o + 2] = i; u8[o + 3] = 0;
    }
    const src = mat.data;
    const step = mat.cols;
    for (let y = 0; y < h; y++) {
      u8.set(src.subarray(y * step, y * step + w), headerSize + y * rowSize);
    }
    return u8;
  }

  /* ---------------- statistics ---------------- */

  function histogram(mat) {
    const h = new Float64Array(256);
    const d = mat.data;
    for (let i = 0; i < d.length; i++) h[d[i]]++;
    return h;
  }

  function percentileFromHist(hist, total, p) {
    let acc = 0;
    const target = total * p;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 255;
  }

  function meanStd(mat) {
    const cv = get();
    const mean = new cv.Mat(); const std = new cv.Mat();
    cv.meanStdDev(mat, mean, std);
    const r = { mean: mean.data64F[0], std: std.data64F[0] };
    mean.delete(); std.delete();
    return r;
  }

  /** Odd kernel size, clamped to >= 3. */
  const odd = (n) => { const v = Math.max(3, Math.round(n)); return v % 2 ? v : v + 1; };

  /* ---------------- 3x3 matrix maths (transform tracking) ---------------- */

  const M = {
    identity: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
    mul(a, b) { // a ∘ b  (apply b first)
      const o = new Array(9);
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
        }
      }
      return o;
    },
    scale: (sx, sy) => [sx, 0, 0, 0, sy, 0, 0, 0, 1],
    translate: (tx, ty) => [1, 0, tx, 0, 1, ty, 0, 0, 1],
    rotateDeg(deg, cx, cy) {
      const r = (deg * Math.PI) / 180;
      const cos = Math.cos(r); const sin = Math.sin(r);
      return [cos, -sin, cx - cos * cx + sin * cy, sin, cos, cy - sin * cx - cos * cy, 0, 0, 1];
    },
    apply(m, x, y) {
      const w = m[6] * x + m[7] * y + m[8];
      return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
    },
    invert(m) {
      const [a, b, c, d, e, f, g, h, i] = m;
      const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
      const det = a * A + b * B + c * C;
      if (!det) return M.identity();
      const inv = [
        A, -(b * i - c * h), b * f - c * e,
        B, a * i - c * g, -(a * f - c * d),
        C, -(a * h - b * g), a * e - b * d,
      ];
      return inv.map((v) => v / det);
    },
    /** Map an axis-aligned box through m, returning the bounding box. */
    box(m, box) {
      const pts = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]
        .map(([x, y]) => M.apply(m, x, y));
      const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
      return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    },
  };

  scope.CVB = { ready, get, scopeGuard, fromImageData, toImageData, toGray, grayToBmp, histogram, percentileFromHist, meanStd, odd, M };
})(self);
