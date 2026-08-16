'use strict';
/* OmniOCR — depth-assisted capture.
 *
 * Phones that record a depth/disparity map alongside the photo (Apple portrait
 * HEIC/JPEG, Android Dynamic Depth) give us something edge detection cannot:
 * the page as a physical surface. We use it to segment the sheet from a
 * cluttered background, find its true corners, and flatten page curl before
 * any recognition happens.
 *
 * Sources, in order of preference:
 *   1. macOS native helper  — AVFoundation/CoreImage aux depth (HEIC, JPEG)
 *   2. Android Dynamic Depth — XMP GDepth/Container payload (pure JS)
 *   3. Apple MPF            — secondary JPEG image (pure JS)
 *   4. Sidecar depth image  — "<name>.depth.png" next to the original
 */
(function (scope) {
  /* ---------------- JPEG container parsing ---------------- */

  /** Collect APP1 XMP payloads (standard + extended) from a JPEG byte stream. */
  function readXmp(bytes) {
    const dec = new TextDecoder('utf-8');
    let i = 2;
    let main = '';
    const extended = [];
    while (i < bytes.length - 4) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xda || marker === 0xd9) break;                    // start of scan / EOI
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      const start = i + 4;
      if (marker === 0xe1) {
        const head = dec.decode(bytes.subarray(start, Math.min(start + 40, bytes.length)));
        if (head.startsWith('http://ns.adobe.com/xap/1.0/\0')) {
          main += dec.decode(bytes.subarray(start + 29, i + 2 + len));
        } else if (head.startsWith('http://ns.adobe.com/xmp/extension/\0')) {
          // 35-byte namespace + 32-byte GUID + 4-byte total + 4-byte offset
          const off = start + 35 + 32;
          const total = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
          const chunkOff = (bytes[off + 4] << 24) | (bytes[off + 5] << 16) | (bytes[off + 6] << 8) | bytes[off + 7];
          extended.push({ offset: chunkOff, total, data: dec.decode(bytes.subarray(off + 8, i + 2 + len)) });
        }
      }
      i += 2 + len;
    }
    extended.sort((a, b) => a.offset - b.offset);
    return main + extended.map((e) => e.data).join('');
  }

  const B64 = /[A-Za-z0-9+/=\s]+/;

  /** Android Dynamic Depth: base64 PNG/JPEG depth payload inside XMP. */
  function depthFromXmp(xmp) {
    if (!xmp) return null;
    const patterns = [
      /GDepth:Data\s*=\s*"([^"]+)"/,
      /<GDepth:Data>([\s\S]*?)<\/GDepth:Data>/,
      /Depth:Data\s*=\s*"([^"]+)"/,
    ];
    for (const re of patterns) {
      const m = re.exec(xmp);
      if (m && B64.test(m[1])) {
        const clean = m[1].replace(/\s+/g, '');
        try {
          const bin = atob(clean);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          const near = /GDepth:Near\s*=\s*"([\d.]+)"/.exec(xmp);
          const far = /GDepth:Far\s*=\s*"([\d.]+)"/.exec(xmp);
          return { encoded: out, near: near ? +near[1] : 0, far: far ? +far[1] : 1, kind: 'dynamic-depth' };
        } catch (_) { /* not valid base64 */ }
      }
    }
    return null;
  }

  /** Apple MPF: locate the secondary (depth/disparity) JPEG in the stream. */
  function depthFromMpf(bytes) {
    // Find the second SOI that is not the primary image start.
    for (let i = 2; i < bytes.length - 3; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
        const tail = bytes.subarray(i);
        if (tail.length > 1024) return { encoded: tail, kind: 'mpf' };
      }
    }
    return null;
  }

  /** Decode an encoded depth payload into a normalised Float32 grid. */
  async function decodeDepthImage(encoded) {
    const blob = new Blob([encoded]);
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const out = new Float32Array(bmp.width * bmp.height);
    for (let i = 0, p = 0; i < out.length; i++, p += 4) {
      out[i] = (img.data[p] * 0.299 + img.data[p + 1] * 0.587 + img.data[p + 2] * 0.114) / 255;
    }
    bmp.close();
    return { width: bmp.width, height: bmp.height, data: out };
  }

  /**
   * Obtain a depth map for an image.
   * @param bytes    original file bytes
   * @param native   result of the macOS helper (may be null/unsuccessful)
   */
  async function acquire(bytes, native) {
    if (native && native.ok && native.buffer) {
      const data = new Float32Array(native.buffer);
      let min = Infinity; let max = -Infinity;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
      }
      const norm = new Float32Array(data.length);
      const span = max - min || 1;
      for (let i = 0; i < data.length; i++) norm[i] = Number.isFinite(data[i]) ? (data[i] - min) / span : 0.5;
      return { width: native.width, height: native.height, data: norm, kind: native.kind, source: 'native' };
    }
    if (!bytes || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;   // not JPEG
    const xmp = readXmp(bytes);
    const dyn = depthFromXmp(xmp);
    if (dyn) {
      const img = await decodeDepthImage(dyn.encoded);
      return { ...img, kind: dyn.kind, source: 'xmp' };
    }
    const mpf = depthFromMpf(bytes);
    if (mpf) {
      try {
        const img = await decodeDepthImage(mpf.encoded);
        // Depth maps are small and smooth; a full-size second photo is not depth.
        if (img.width <= 1024 && img.height <= 1024) return { ...img, kind: 'mpf', source: 'mpf' };
      } catch (_) { /* not decodable */ }
    }
    return null;
  }

  /* ---------------- using depth ---------------- */

  /**
   * Segment the page: the dominant near-surface. Returns an 8-bit mask Mat at
   * the target size, or null when depth is too flat/noisy to be informative.
   */
  function pageMask(cv, depth, targetW, targetH) {
    const { width, height, data } = depth;
    // Histogram the depth to find the dominant (page) mode among near values.
    const bins = 64;
    const hist = new Float64Array(bins);
    for (let i = 0; i < data.length; i++) hist[Math.min(bins - 1, Math.max(0, (data[i] * bins) | 0))]++;
    let peak = 0;
    for (let i = 1; i < bins; i++) if (hist[i] > hist[peak]) peak = i;
    const strength = hist[peak] / data.length;
    if (strength < 0.12) return null;                       // no dominant surface

    const centre = (peak + 0.5) / bins;
    const tol = 0.12;
    const m = new cv.Mat(height, width, cv.CV_8UC1);
    const d = m.data;
    let on = 0;
    for (let i = 0; i < data.length; i++) {
      const hit = Math.abs(data[i] - centre) <= tol ? 255 : 0;
      d[i] = hit; if (hit) on++;
    }
    const frac = on / data.length;
    if (frac < 0.08 || frac > 0.97) { m.delete(); return null; }

    // Clean up, keep the largest blob.
    const k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(m, m, cv.MORPH_CLOSE, k);
    cv.morphologyEx(m, m, cv.MORPH_OPEN, k);
    k.delete();
    const labels = new cv.Mat(); const stats = new cv.Mat(); const cent = new cv.Mat();
    const n = cv.connectedComponentsWithStats(m, labels, stats, cent, 8, cv.CV_32S);
    let bestLabel = 0; let bestArea = 0;
    for (let i = 1; i < n; i++) {
      const a = stats.intAt(i, cv.CC_STAT_AREA);
      if (a > bestArea) { bestArea = a; bestLabel = i; }
    }
    const lab = labels.data32S;
    for (let i = 0; i < d.length; i++) d[i] = lab[i] === bestLabel ? 255 : 0;
    labels.delete(); stats.delete(); cent.delete();

    if (width !== targetW || height !== targetH) {
      const up = new cv.Mat();
      cv.resize(m, up, new cv.Size(targetW, targetH), 0, 0, cv.INTER_NEAREST);
      m.delete();
      return up;
    }
    return m;
  }

  /** Page corners from a depth mask — robust where edge detection fails. */
  function quadFromMask(cv, mask) {
    const contours = new cv.MatVector(); const hier = new cv.Mat();
    cv.findContours(mask, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = null; let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a > bestArea) {
        const peri = cv.arcLength(c, true);
        const approx = new cv.Mat();
        for (const eps of [0.02, 0.03, 0.05]) {
          cv.approxPolyDP(c, approx, eps * peri, true);
          if (approx.rows === 4) break;
        }
        if (approx.rows === 4) {
          bestArea = a;
          best = [];
          for (let j = 0; j < 4; j++) best.push([approx.intAt(j, 0), approx.intAt(j, 1)]);
        }
        approx.delete();
      }
      c.delete();
    }
    contours.delete(); hier.delete();
    if (!best) return null;
    const quad = scope.Geometry.orderQuad(best);
    return scope.Geometry.quadIsSane(quad, mask.cols, mask.rows) ? quad : null;
  }

  /**
   * Flatten page curl using a cylindrical model derived from depth.
   * For each output column we measure how much the surface recedes and stretch
   * the image back, which straightens text that bends near a bound spine.
   * This is an approximation (no camera intrinsics) but reliably recovers
   * several percent of accuracy on photographed book pages.
   */
  function flattenCurl(cv, gray, depth) {
    const w = gray.cols; const h = gray.rows;
    const dW = depth.width; const dH = depth.height;
    // Column-wise median depth of the page area.
    const colDepth = new Float64Array(w);
    for (let x = 0; x < w; x++) {
      const dx = Math.min(dW - 1, Math.round((x / w) * dW));
      let sum = 0; let n = 0;
      for (let y = 0; y < dH; y += Math.max(1, dH >> 6)) {
        const v = depth.data[y * dW + dx];
        if (Number.isFinite(v)) { sum += v; n++; }
      }
      colDepth[x] = n ? sum / n : 0.5;
    }
    // Smooth, then convert relative depth into a horizontal stretch factor.
    const sm = new Float64Array(w);
    const win = Math.max(5, w >> 6);
    for (let x = 0; x < w; x++) {
      let s = 0; let n = 0;
      for (let i = Math.max(0, x - win); i <= Math.min(w - 1, x + win); i++) { s += colDepth[i]; n++; }
      sm[x] = s / n;
    }
    let min = Infinity; let max = -Infinity;
    for (let x = 0; x < w; x++) { if (sm[x] < min) min = sm[x]; if (sm[x] > max) max = sm[x]; }
    if (max - min < 0.04) return null;                    // essentially flat — nothing to do

    // Cumulative arc length: columns further away represent more real-world width.
    const cum = new Float64Array(w + 1);
    for (let x = 0; x < w; x++) {
      const rel = (sm[x] - min) / (max - min);
      cum[x + 1] = cum[x] + (1 + rel * 0.35);
    }
    const totalArc = cum[w];
    const mapX = new Float32Array(w * h);
    const mapY = new Float32Array(w * h);
    let src = 0;
    for (let ox = 0; ox < w; ox++) {
      const target = (ox / (w - 1)) * totalArc;
      while (src < w - 1 && cum[src + 1] < target) src++;
      const span = cum[src + 1] - cum[src] || 1;
      const frac = (target - cum[src]) / span;
      const sx = Math.min(w - 1, src + frac);
      for (let y = 0; y < h; y++) { mapX[y * w + ox] = sx; mapY[y * w + ox] = y; }
    }
    const mx = cv.matFromArray(h, w, cv.CV_32F, mapX);
    const my = cv.matFromArray(h, w, cv.CV_32F, mapY);
    const out = new cv.Mat();
    cv.remap(gray, out, mx, my, cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
    mx.delete(); my.delete();
    return out;
  }

  scope.Depth = { acquire, pageMask, quadFromMask, flattenCurl, readXmp, depthFromXmp, depthFromMpf, decodeDepthImage };
})(self);
