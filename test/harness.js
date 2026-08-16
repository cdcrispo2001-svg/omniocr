/* OmniOCR test harness.
 *
 * Renders known documents, degrades them in controlled ways, runs the real
 * engine over the result, and scores the output against the exact ground truth
 * with character and word error rates. Exit status is non-zero if any case
 * misses its budget, so this doubles as the release gate.
 */

import { render, KINDS } from 'omni://app/test/corpus.js';
import { degrade, PRESET_NAMES, cv } from 'omni://app/test/degrade.js';
import { Engine } from 'omni://app/src/engine-client.js';
import { exportPdf } from 'omni://app/src/exporters/pdf.js';
import { exportDocx } from 'omni://app/src/exporters/docx.js';
import { exportTxt, exportMarkdown, exportHtml, exportHocr, exportJson, exportCsv } from 'omni://app/src/exporters/text.js';

const log = (m) => window.omni.harness.log(m);

/* ---------------- scoring ---------------- */

/** Normalise for comparison: collapse whitespace, unify punctuation variants. */
function normalize(s) {
  return s
    .normalize('NFKC')
    .replace(/[’‘‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance with a rolling row (O(min) memory). */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function wordErrorRate(truth, got) {
  const t = normalize(truth).split(' ').filter(Boolean);
  const g = normalize(got).split(' ').filter(Boolean);
  // Token-level Levenshtein via character mapping (one code point per token).
  const vocab = new Map();
  const enc = (arr) => arr.map((w) => {
    if (!vocab.has(w)) vocab.set(w, String.fromCodePoint(0xe000 + vocab.size));
    return vocab.get(w);
  }).join('');
  return t.length ? levenshtein(enc(t), enc(g)) / t.length : 0;
}

function score(truth, got) {
  const t = normalize(truth);
  const g = normalize(got);
  return {
    cer: t.length ? levenshtein(t, g) / t.length : 0,
    wer: wordErrorRate(truth, got),
    truthChars: t.length,
    gotChars: g.length,
  };
}

/* ---------------- debug output ---------------- */

const OUT_DIR = 'test/out';

async function savePng(imageData, name) {
  const c = new OffscreenCanvas(imageData.width, imageData.height);
  c.getContext('2d').putImageData(imageData, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  await window.omni.writeFile(`${OUT_DIR}/${name}.png`, bytes);
  log(`    dumped ${OUT_DIR}/${name}.png (${(bytes.length / 1024) | 0} KB)`);
}

async function saveBytes(bytes, name) {
  await window.omni.writeFile(`${OUT_DIR}/${name}`, bytes);
  log(`    dumped ${OUT_DIR}/${name} (${(bytes.length / 1024) | 0} KB)`);
}

/* ---------------- budgets ---------------- */

/* Maximum acceptable character error rate per degradation preset. These are the
 * release gate; they were set from measured behaviour, not aspiration. */
const BUDGET = {
  clean: 0.010,
  faint: 0.030,
  blurred: 0.060,
  pixelated: 0.130,
  noisy: 0.050,
  jpegArtefacts: 0.050,
  skewed: 0.020,
  perspective: 0.060,
  shadowed: 0.030,
  smudged: 0.050,
  foreignMarks: 0.080,
  photocopyGeneration3: 0.090,
  phonePhoto: 0.070,
  severe: 0.200,
  worstCase: 0.320,
};

/* Cases where correct behaviour is to produce almost nothing rather than
 * hallucinate. Scored on restraint, not accuracy. */
const GRACEFUL = {
  // Nothing can read this; the requirement is that the engine says so.
  beyondRecovery: { maxChars: 400 },
  // At the very edge of legibility, partial recovery is acceptable but
  // invention is not: most of what is emitted must actually be on the page.
  worstCase: { minPrecision: 0.55 },
};

/** Fraction of emitted words that genuinely occur in the ground truth. */
function wordPrecision(truth, got) {
  const tokens = (s) => normalize(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const truthSet = new Map();
  for (const w of tokens(truth)) truthSet.set(w, (truthSet.get(w) || 0) + 1);
  const emitted = tokens(got);
  if (!emitted.length) return 1;
  let hits = 0;
  for (const w of emitted) {
    const n = truthSet.get(w) || 0;
    if (n > 0) { hits++; truthSet.set(w, n - 1); }
  }
  return hits / emitted.length;
}

/* ---------------- export self-test ---------------- */

/**
 * Recognise real pages and run every exporter over the result. Correctness of
 * the searchable PDF is verified externally by extracting its text again with
 * an independent tool and comparing — an exporter that writes a plausible file
 * containing the wrong text layer would otherwise pass unnoticed.
 */
async function exportSelfTest(engine, profile) {
  log('');
  log('Export self-test');
  log('─'.repeat(94));
  const pages = [];
  const cases = [['article', 'clean'], ['invoice', 'smudged'], ['form', 'skewed']];
  for (const [kind, preset] of cases) {
    const base = render(kind);
    const imageData = await degrade(base.imageData, preset);
    const result = await engine.page(
      { imageData, index: pages.length, name: `${kind}/${preset}`, dpi: 300, depth: null },
      { profile, dewarp: true, deskew: true, autoRotate: false, tables: true, correct: true, exportImage: true },
    );
    pages.push(result);
    log(`  recognised ${kind}/${preset}: ${result.wordCount} words, ${result.blocks.length} blocks, ${result.tables.length} tables`);
  }

  const outputs = {
    'export.pdf': await exportPdf(pages, { title: 'OmniOCR export self-test' }),
    'export.docx': await exportDocx(pages, { title: 'OmniOCR export self-test' }),
    'export.html': exportHtml(pages, { title: 'OmniOCR export self-test' }),
    'export.layout.html': exportHtml(pages, { title: 'OmniOCR layout', mode: 'layout' }),
    'export.md': exportMarkdown(pages),
    'export.txt': exportTxt(pages),
    'export.hocr': exportHocr(pages),
    'export.json': exportJson(pages),
    'export.csv': exportCsv(pages),
  };
  const summary = {};
  for (const [name, data] of Object.entries(outputs)) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await window.omni.writeFile(`${OUT_DIR}/${name}`, bytes);
    summary[name] = bytes.length;
    log(`  wrote ${name.padEnd(20)} ${(bytes.length / 1024).toFixed(1).padStart(9)} KB`);
  }
  // The engine's own text, for the external comparison.
  await window.omni.writeFile(`${OUT_DIR}/export.expected.txt`, new TextEncoder().encode(pages.map((p) => p.text).join('\n')));
  return { summary, pages: pages.length, words: pages.reduce((s, p) => s + p.wordCount, 0) };
}

/* ---------------- depth-assisted capture ---------------- */

/**
 * Build a depth map consistent with a photographed page: the sheet sits nearer
 * the camera than the surface behind it, and curls slightly along one edge.
 * Derived from the rendered scene itself so the geometry genuinely agrees with
 * the image the engine is given.
 */
function syntheticDepth(imageData, { curl = 0.12 } = {}) {
  const dw = Math.max(64, Math.round(imageData.width / 8));
  const dh = Math.max(64, Math.round(imageData.height / 8));
  const data = new Float32Array(dw * dh);
  const src = imageData.data;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(imageData.height - 1, Math.round((y / dh) * imageData.height));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(imageData.width - 1, Math.round((x / dw) * imageData.width));
      const i = (sy * imageData.width + sx) * 4;
      const lum = (src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114) / 255;
      // Paper is bright and near; the surface behind it is darker and further.
      const onPage = lum > 0.55;
      const bend = curl * Math.sin((x / dw) * Math.PI);      // gentle cylindrical curl
      data[y * dw + x] = onPage ? 0.34 + bend : 0.86;
    }
  }
  return { width: dw, height: dh, data, kind: 'depth', source: 'synthetic' };
}

async function depthSelfTest(engine, profile) {
  log('');
  log('Depth-assisted capture');
  log('─'.repeat(94));
  const base = render('article');
  const imageData = await degrade(base.imageData, 'phonePhoto');
  const depth = syntheticDepth(imageData);
  log(`  depth map ${depth.width}x${depth.height} derived from the scene`);

  const opts = { profile, dewarp: true, deskew: true, autoRotate: false, tables: true, correct: true, exportImage: false };
  const withDepth = await engine.page(
    { imageData, index: 0, name: 'article/phonePhoto+depth', dpi: 300, depth },
    { ...opts, useDepth: true },
  );
  const withoutDepth = await engine.page(
    { imageData, index: 1, name: 'article/phonePhoto', dpi: 300, depth: null },
    { ...opts, useDepth: false },
  );

  const a = score(base.truth, withDepth.text);
  const b = score(base.truth, withoutDepth.text);
  log(`  with depth   : CER ${(a.cer * 100).toFixed(2)}%  info=${JSON.stringify(withDepth.depth)}`);
  log(`  without depth: CER ${(b.cer * 100).toFixed(2)}%`);

  const used = !!(withDepth.depth && withDepth.depth.used);
  const consumed = used && (withDepth.depth.quad || withDepth.depth.curl);
  // The requirement is that depth is genuinely consumed and does no harm.
  const pass = used && consumed && a.cer <= Math.max(0.08, b.cer + 0.02);
  log(`  depth consumed: ${consumed} (page quad: ${withDepth.depth && withDepth.depth.quad}, curl flattening: ${withDepth.depth && withDepth.depth.curl})`);
  log(`  ${pass ? 'ok' : 'FAIL'}`);
  return { pass, withDepth: +a.cer.toFixed(4), withoutDepth: +b.cer.toFixed(4), info: withDepth.depth };
}

/* ---------------- runner ---------------- */

async function main() {
  const args = await window.omni.harness.args();
  const only = (args.find((a) => a.startsWith('--harness-only=')) || '').split('=')[1];
  const kindsArg = (args.find((a) => a.startsWith('--harness-kinds=')) || '').split('=')[1];
  const profile = (args.find((a) => a.startsWith('--harness-profile=')) || '').split('=')[1] || 'balanced';

  const exportsOnly = args.includes('--harness-exports');
  const depthOnly = args.includes('--harness-depth');
  const presets = only ? only.split(',') : PRESET_NAMES;
  const kinds = kindsArg ? kindsArg.split(',') : KINDS;

  await cv();                                   // degradation module's OpenCV
  const engine = new Engine();
  engine.onLog = () => {};
  const ready = await engine.start({ workers: 3 });
  log(`engine: ${ready.workers} workers · lexicon ${ready.lexicon} · profile ${profile}`);
  log('');
  if (depthOnly) {
    const info = await depthSelfTest(engine, profile);
    await engine.stop();
    window.omni.harness.done({ pass: info.pass, depth: info });
    return;
  }

  if (exportsOnly) {
    const info = await exportSelfTest(engine, profile);
    await engine.stop();
    log('─'.repeat(94));
    log(`export self-test complete: ${info.pages} pages, ${info.words} words`);
    window.omni.harness.done({ pass: true, exports: info });
    return;
  }

  log('case                                  CER      WER    conf   score  tier      time   budget');
  log('─'.repeat(94));

  const rows = [];
  let index = 0;
  for (const kind of kinds) {
    const base = render(kind);
    for (const preset of presets) {
      const t0 = performance.now();
      const imageData = await degrade(base.imageData, preset);
      const dump = args.some((a) => a === `--harness-dump=${preset}` || a === '--harness-dump=all');
      if (dump) await savePng(imageData, `${kind}-${preset}-input`);
      let result = null;
      let error = null;
      try {
        result = await engine.page(
          { imageData, index: index++, name: `${kind}/${preset}`, dpi: 300, depth: null },
          { profile, dewarp: true, deskew: true, autoRotate: false, tables: true, correct: true, exportImage: false, dumpVariants: dump },
        );
      } catch (err) {
        error = err.message;
      }
      const elapsed = (performance.now() - t0) / 1000;
      const budget = BUDGET[preset] ?? 0.2;
      if (error) {
        rows.push({ kind, preset, error, pass: false, budget });
        log(`${`${kind}/${preset}`.padEnd(36)}  ERROR: ${error}`);
        continue;
      }
      if (dump) {
        for (const d of result.debugImages || []) await saveBytes(d.bytes, `${kind}-${preset}-var-${d.id.replace(/[^\w.@-]/g, '_')}.png`);
        if (result.canonicalImage) await saveBytes(result.canonicalImage.bytes, `${kind}-${preset}-canonical.png`);
        await saveBytes(new TextEncoder().encode(result.text), `${kind}-${preset}-output.txt`);
        await saveBytes(new TextEncoder().encode(base.truth), `${kind}-truth.txt`);
      }
      const s = score(base.truth, result.text);
      const graceful = GRACEFUL[preset];
      const precision = wordPrecision(base.truth, result.text);
      // For unrecoverable input, success means restraint: no crash, no hang,
      // and no page of invented text.
      const pass = graceful
        ? (graceful.maxChars !== undefined
          ? s.gotChars <= graceful.maxChars
          : precision >= graceful.minPrecision)
        : s.cer <= budget;
      rows.push({
        kind, preset, pass, budget,
        cer: +s.cer.toFixed(4), wer: +s.wer.toFixed(4),
        conf: +result.confidence.toFixed(1), score: +result.score.toFixed(3),
        tier: result.profile.tier, seconds: +elapsed.toFixed(1),
        attempts: result.attempts.length, corrections: result.corrections.length,
        blocks: result.blocks.length, tables: result.tables.length,
        truthChars: s.truthChars, gotChars: s.gotChars, graceful: !!graceful, precision: +precision.toFixed(3),
      });
      log(`${`${kind}/${preset}`.padEnd(36)} ${(s.cer * 100).toFixed(2).padStart(6)}% ${(s.wer * 100).toFixed(1).padStart(6)}% `
        + `${result.confidence.toFixed(0).padStart(5)}% ${result.score.toFixed(3).padStart(6)}  ${result.profile.tier.padEnd(9)} `
        + `${elapsed.toFixed(1).padStart(5)}s  ${pass ? 'ok' : (graceful ? (graceful.maxChars !== undefined ? `FAIL emitted ${s.gotChars} chars` : `FAIL precision ${(precision * 100).toFixed(0)}%`) : `FAIL >${(budget * 100).toFixed(1)}%`)}`);
      if (args.includes('--harness-verbose')) {
        log(`    timings: ${Object.entries(result.timings).map(([k, v]) => `${k}=${Math.round(v)}`).join(' ')}`);
        log(`    variants: ${result.variantsRun.map((v) => `${v.id}@${v.scale}x=${v.ms}ms(${v.conf}%)`).join(' ')}`);
        log(`    size: ${result.width}x${result.height} blocks=${result.blocks.length} tables=${result.tables.length} fixes=${result.corrections.length} kept=${result.lines.length} rejected=${(result.rejected || []).length} precision=${(precision * 100).toFixed(0)}% keptLex=${result.keptLexicality} unreadable=${result.unreadable}`);
        for (const l of result.lines.slice(0, 6)) log(`      KEPT  conf=${l.conf.toFixed(0)} "${l.text.slice(0, 78)}"`);
        for (const r of (result.rejected || []).slice(0, 4)) log(`      DROP  conf=${r.conf.toFixed(0)} strict=${r.strict} "${r.text.slice(0, 60)}"`);
      }
    }
  }

  await engine.stop();

  const failures = rows.filter((r) => !r.pass);
  const ok = rows.filter((r) => r.pass);
  const meanCer = ok.length ? ok.reduce((s, r) => s + r.cer, 0) / ok.length : 0;
  log('─'.repeat(94));
  log(`${rows.length} cases · ${ok.length} within budget · ${failures.length} over budget · mean CER (passing) ${(meanCer * 100).toFixed(2)}%`);
  if (failures.length) {
    log('');
    log('Over budget:');
    for (const f of failures) {
      const g = GRACEFUL[f.preset];
      const why = f.error ? f.error
        : g && g.maxChars !== undefined ? `emitted ${f.gotChars} chars, expected <= ${g.maxChars}`
          : g ? `word precision ${(f.precision * 100).toFixed(0)}%, expected >= ${(g.minPrecision * 100).toFixed(0)}%`
            : `CER ${(f.cer * 100).toFixed(2)}% > ${(f.budget * 100).toFixed(1)}%`;
      log(`  ${f.kind}/${f.preset}: ${why}`);
    }
  }

  window.omni.harness.done({
    pass: failures.length === 0,
    generated: new Date().toISOString(),
    profile,
    total: rows.length,
    passed: ok.length,
    failed: failures.length,
    meanCer,
    rows,
  });
}

main().catch((err) => {
  log(`harness crashed: ${err.stack || err}`);
  window.omni.harness.done({ pass: false, error: String(err.stack || err), rows: [] });
});
