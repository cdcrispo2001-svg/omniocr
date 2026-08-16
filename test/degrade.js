/* OmniOCR test degradations.
 *
 * Reproduces the ways real documents arrive broken: soft focus, low resolution,
 * faint toner, sensor noise, JPEG artefacts, skew, perspective, uneven lighting,
 * ink smudges, coffee rings, dust, hairs and staple shadows.
 */

/* ---------------- deterministic randomness ---------------- */

/* Degradations must be reproducible: without a fixed seed, two runs produce
 * different speckle and smudge patterns and error rates cannot be compared, so
 * the suite could not tell a real regression from a different dice roll. */
let rngState = 0x9e3779b9;
export function seed(n) { rngState = n >>> 0 || 1; }
function rnd() {
  rngState |= 0; rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

let cvp = null;
export async function cv() {
  if (!cvp) cvp = Promise.resolve(window.cv).then((m) => (m.Mat ? m : window.cv));
  return cvp;
}

function toMat(c, imageData) {
  const m = new c.Mat(imageData.height, imageData.width, c.CV_8UC4);
  m.data.set(imageData.data);
  return m;
}
function toImageData(c, mat) {
  let rgba = mat; let tmp = null;
  if (mat.channels() === 1) { tmp = new c.Mat(); c.cvtColor(mat, tmp, c.COLOR_GRAY2RGBA); rgba = tmp; }
  const out = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  if (tmp) tmp.delete();
  return out;
}

/* ---------------- individual degradations ---------------- */

const OPS = {
  blur: (c, m, amount = 2.2) => {
    const k = Math.max(3, Math.round(amount * 2) | 1);
    const o = new c.Mat();
    c.GaussianBlur(m, o, new c.Size(k, k), amount);
    m.delete(); return o;
  },

  downscale: (c, m, factor = 0.35) => {
    const small = new c.Mat();
    c.resize(m, small, new c.Size(0, 0), factor, factor, c.INTER_AREA);
    const back = new c.Mat();
    c.resize(small, back, new c.Size(m.cols, m.rows), 0, 0, c.INTER_NEAREST);
    small.delete(); m.delete(); return back;
  },

  faint: (c, m, level = 0.42) => {
    // Lift the ink towards paper white: what a dying toner cartridge produces.
    const o = new c.Mat();
    m.convertTo(o, -1, level, 255 * (1 - level));
    m.delete(); return o;
  },

  noise: (c, m, sigma = 16, saltPepper = 0.012) => {
    const d = m.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rnd() + rnd() + rnd() - 1.5) * sigma;
      for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.max(0, Math.min(255, d[i + ch] + n));
      if (rnd() < saltPepper) {
        const v = rnd() < 0.5 ? 0 : 255;
        d[i] = v; d[i + 1] = v; d[i + 2] = v;
      }
    }
    return m;
  },

  shadow: (c, m, strength = 0.55) => {
    // Diagonal illumination falloff, as when photographing under one lamp.
    const w = m.cols; const h = m.rows;
    const d = m.data;
    const cx = w * (0.15 + rnd() * 0.2);
    const cy = h * (0.1 + rnd() * 0.2);
    const maxD = Math.hypot(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = Math.hypot(x - cx, y - cy) / maxD;
        const f = 1 - strength * t * 1.35;
        const i = (y * w + x) * 4;
        for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.max(0, Math.min(255, d[i + ch] * f));
      }
    }
    return m;
  },

  skew: (c, m, deg = 4.5) => {
    const cen = new c.Point(m.cols / 2, m.rows / 2);
    const rot = c.getRotationMatrix2D(cen, deg, 1);
    const o = new c.Mat();
    c.warpAffine(m, o, rot, new c.Size(m.cols, m.rows), c.INTER_CUBIC, c.BORDER_CONSTANT, new c.Scalar(255, 255, 255, 255));  // scanner platen stays white
    rot.delete(); m.delete(); return o;
  },

  perspective: (c, m, amount = 0.06) => {
    const w = m.cols; const h = m.rows;
    const dx = w * amount; const dy = h * amount * 0.5;
    const src = c.matFromArray(4, 1, c.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    const dst = c.matFromArray(4, 1, c.CV_32FC2, [dx, dy * 0.6, w - dx * 0.4, 0, w, h - dy, dx * 0.3, h]);
    const H = c.getPerspectiveTransform(src, dst);
    const o = new c.Mat();
    c.warpPerspective(m, o, H, new c.Size(w, h), c.INTER_CUBIC, c.BORDER_CONSTANT, new c.Scalar(118, 112, 104, 255));
    src.delete(); dst.delete(); H.delete(); m.delete(); return o;
  },

  smudge: (c, m, count = 7) => {
    const w = m.cols; const h = m.rows;
    const d = m.data;
    for (let s = 0; s < count; s++) {
      const cx = rnd() * w;
      const cy = rnd() * h;
      const rx = w * (0.04 + rnd() * 0.09);
      const ry = h * (0.012 + rnd() * 0.035);
      const ang = rnd() * Math.PI;
      const dark = 0.35 + rnd() * 0.4;
      const cos = Math.cos(ang); const sin = Math.sin(ang);
      const x0 = Math.max(0, (cx - rx) | 0); const x1 = Math.min(w, (cx + rx) | 0);
      const y0 = Math.max(0, (cy - rx) | 0); const y1 = Math.min(h, (cy + rx) | 0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const ux = (x - cx) * cos + (y - cy) * sin;
          const uy = -(x - cx) * sin + (y - cy) * cos;
          const r = (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry);
          if (r > 1) continue;
          const a = (1 - r) * dark;
          const i = (y * w + x) * 4;
          for (let ch = 0; ch < 3; ch++) d[i + ch] = d[i + ch] * (1 - a);
        }
      }
    }
    return m;
  },

  foreignMarks: (c, m, opts = {}) => {
    const w = m.cols; const h = m.rows;
    const d = m.data;
    const put = (x, y, v, a = 1) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = ((y | 0) * w + (x | 0)) * 4;
      for (let ch = 0; ch < 3; ch++) d[i + ch] = d[i + ch] * (1 - a) + v * a;
    };
    // dust specks
    const specks = opts.specks ?? 2600;
    for (let i = 0; i < specks; i++) {
      const x = rnd() * w; const y = rnd() * h;
      const r = rnd() < 0.85 ? 1 : 2;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) put(x + dx, y + dy, 20, 0.85);
    }
    // hairs / fibres
    for (let i = 0; i < (opts.hairs ?? 5); i++) {
      let x = rnd() * w; let y = rnd() * h;
      let a = rnd() * Math.PI * 2;
      const len = 120 + rnd() * 600;
      for (let t = 0; t < len; t++) {
        a += (rnd() - 0.5) * 0.25;
        x += Math.cos(a); y += Math.sin(a);
        put(x, y, 40, 0.75); put(x, y + 1, 60, 0.4);
      }
    }
    // coffee ring
    if (opts.ring !== false) {
      const cx = w * (0.25 + rnd() * 0.5);
      const cy = h * (0.2 + rnd() * 0.6);
      const rad = Math.min(w, h) * (0.09 + rnd() * 0.07);
      for (let ang = 0; ang < Math.PI * 2; ang += 0.0015) {
        for (let t = -6; t <= 6; t++) {
          const rr = rad + t;
          const a = 0.22 * (1 - Math.abs(t) / 7);
          put(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, 120, a);
        }
      }
      for (let y = (cy - rad) | 0; y < cy + rad; y++) {
        for (let x = (cx - rad) | 0; x < cx + rad; x++) {
          if (Math.hypot(x - cx, y - cy) < rad) put(x, y, 190, 0.1);
        }
      }
    }
    // staple shadow / punch hole
    if (opts.staple !== false) {
      const sx = w * 0.06; const sy = h * 0.07;
      for (let y = 0; y < 60; y++) for (let x = 0; x < 12; x++) put(sx + x, sy + y, 15, 0.9);
      for (let y = 0; y < 12; y++) for (let x = 0; x < 60; x++) put(sx + x, sy + y, 15, 0.9);
    }
    return m;
  },

  jpeg: async (c, m, quality = 0.12) => {
    const img = toImageData(c, m);
    const cvs = new OffscreenCanvas(m.cols, m.rows);
    cvs.getContext('2d').putImageData(img, 0, 0);
    const blob = await cvs.convertToBlob({ type: 'image/jpeg', quality });
    const bmp = await createImageBitmap(blob);
    const out = new OffscreenCanvas(bmp.width, bmp.height);
    out.getContext('2d').drawImage(bmp, 0, 0);
    const back = out.getContext('2d').getImageData(0, 0, bmp.width, bmp.height);
    bmp.close(); m.delete();
    return toMat(c, back);
  },

  invert: (c, m) => {
    const o = new c.Mat();
    c.bitwise_not(m, o);
    m.delete(); return o;
  },
};

/* ---------------- presets ---------------- */

export const PRESETS = {
  clean: [],
  faint: [['faint', 0.38]],
  blurred: [['blur', 2.4]],
  pixelated: [['downscale', 0.3]],
  noisy: [['noise', 20, 0.02]],
  jpegArtefacts: [['jpeg', 0.1]],
  skewed: [['skew', 4.5]],
  perspective: [['perspective', 0.07]],
  shadowed: [['shadow', 0.6]],
  smudged: [['smudge', 9]],
  foreignMarks: [['foreignMarks', { specks: 3000, hairs: 6 }]],
  photocopyGeneration3: [['faint', 0.55], ['blur', 1.4], ['noise', 10, 0.008], ['smudge', 4]],
  phonePhoto: [['perspective', 0.05], ['shadow', 0.5], ['blur', 1.6], ['noise', 9, 0.003], ['jpeg', 0.35]],
  severe: [['downscale', 0.42], ['faint', 0.5], ['blur', 1.8], ['skew', 3.2], ['smudge', 7], ['foreignMarks', { specks: 2200, hairs: 4 }], ['noise', 14, 0.012], ['jpeg', 0.2]],
  worstCase: [['downscale', 0.42], ['faint', 0.46], ['blur', 1.9], ['perspective', 0.05], ['skew', 5.5], ['smudge', 11], ['foreignMarks', { specks: 3500, hairs: 7 }], ['noise', 18, 0.016], ['jpeg', 0.16]],
  // Deliberately past the point of physical recoverability: 0.3x resolution and
  // a 2.6px blur leave no glyph strokes. Nothing can read this, so the engine is
  // required to fail gracefully rather than invent text.
  beyondRecovery: [['downscale', 0.3], ['faint', 0.42], ['blur', 2.6], ['perspective', 0.05], ['skew', 5.5], ['smudge', 11], ['foreignMarks', { specks: 3500, hairs: 7 }], ['noise', 20, 0.02], ['jpeg', 0.12]],
};

/** Apply a named preset to an ImageData, returning a new ImageData. */
export async function degrade(imageData, presetName, seedValue) {
  const c = await cv();
  // Seed from the preset name so a case is identical no matter which other
  // cases ran before it.
  let h = 0x811c9dc5;
  for (const ch of presetName) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  seed(seedValue === undefined ? h : seedValue);
  const ops = PRESETS[presetName];
  if (!ops) throw new Error(`unknown preset ${presetName}`);
  let m = toMat(c, imageData);
  for (const [name, ...args] of ops) {
    const fn = OPS[name];
    if (!fn) throw new Error(`unknown degradation ${name}`);
    const out = fn(c, m, ...args);
    m = out instanceof Promise ? await out : out;
  }
  const result = toImageData(c, m);
  m.delete();
  return result;
}

export const PRESET_NAMES = Object.keys(PRESETS);
