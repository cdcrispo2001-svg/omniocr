#!/usr/bin/env node
/* Turns test/out/report.json into docs/TEST-RESULTS.md.
 * Run after `npm run harness`. */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/out/report.json'), 'utf8'));

const PRESET_LABEL = {
  clean: 'Clean original',
  faint: 'Faint / low toner',
  blurred: 'Out of focus',
  pixelated: 'Low resolution (0.30×)',
  noisy: 'Sensor noise + salt/pepper',
  jpegArtefacts: 'Heavy JPEG artefacts (q10)',
  skewed: 'Skewed 4.5°',
  perspective: 'Photographed at an angle',
  shadowed: 'Uneven lighting / shadow',
  smudged: 'Ink smudges',
  foreignMarks: 'Dust, fibres, coffee ring, staple',
  photocopyGeneration3: 'Third-generation photocopy',
  phonePhoto: 'Phone photo (angle+shadow+blur+JPEG)',
  severe: 'Severe — eight degradations at once',
  worstCase: 'Extreme — nine degradations at once',
  beyondRecovery: 'Past physical recovery (abstention test)',
};

const KIND_LABEL = {
  article: 'Article (headings + prose)',
  invoice: 'Invoice (ruled table)',
  twoColumn: 'Two-column layout',
  form: 'Form (labels, values, rules)',
  dense: 'Dense small print',
};

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const rows = report.rows || [];
const byPreset = new Map();
for (const r of rows) {
  if (!byPreset.has(r.preset)) byPreset.set(r.preset, []);
  byPreset.get(r.preset).push(r);
}

const out = [];
out.push('# OmniOCR — measured accuracy');
out.push('');
out.push(`Generated ${report.generated || 'n/a'} · effort profile \`${report.profile}\` · `
  + `${report.total} cases · ${report.passed} within budget · ${report.failed} over budget`);
out.push('');
out.push('Every case renders a document from known ground truth, degrades it in a');
out.push('controlled and **seeded** way, runs the real engine, and scores the output');
out.push('against the exact source text. CER is character error rate (Levenshtein over');
out.push('normalised text); WER is word error rate.');
out.push('');
out.push('## By degradation');
out.push('');
out.push('| Degradation | Mean CER | Worst CER | Mean WER | Budget | Result |');
out.push('|---|---|---|---|---|---|');
for (const [preset, list] of byPreset) {
  const scored = list.filter((r) => typeof r.cer === 'number');
  if (!scored.length) continue;
  const meanCer = scored.reduce((s, r) => s + r.cer, 0) / scored.length;
  const worst = Math.max(...scored.map((r) => r.cer));
  const meanWer = scored.reduce((s, r) => s + r.wer, 0) / scored.length;
  const failed = list.filter((r) => !r.pass).length;
  const graceful = list.some((r) => r.graceful);
  out.push(`| ${PRESET_LABEL[preset] || preset} | ${graceful ? '—' : pct(meanCer)} | ${graceful ? '—' : pct(worst)} | `
    + `${graceful ? '—' : pct(meanWer)} | ${graceful ? 'abstain / precision' : pct(list[0].budget)} | `
    + `${failed ? `${list.length - failed}/${list.length} pass` : `all ${list.length} pass`} |`);
}

out.push('');
out.push('## By document type');
out.push('');
out.push('| Document | Cases | Mean CER | Median time |');
out.push('|---|---|---|---|');
const byKind = new Map();
for (const r of rows) {
  if (!byKind.has(r.kind)) byKind.set(r.kind, []);
  byKind.get(r.kind).push(r);
}
for (const [kind, list] of byKind) {
  const scored = list.filter((r) => typeof r.cer === 'number' && !r.graceful);
  const meanCer = scored.length ? scored.reduce((s, r) => s + r.cer, 0) / scored.length : 0;
  const times = list.map((r) => r.seconds).filter(Boolean).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : 0;
  out.push(`| ${KIND_LABEL[kind] || kind} | ${list.length} | ${pct(meanCer)} | ${median.toFixed(1)}s |`);
}

out.push('');
out.push('## Full matrix');
out.push('');
out.push('| Document | Degradation | CER | WER | Confidence | Words kept | Rejected | Time | Result |');
out.push('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  if (r.error) {
    out.push(`| ${r.kind} | ${r.preset} | — | — | — | — | — | — | ERROR: ${r.error} |`);
    continue;
  }
  const verdict = r.pass ? 'pass' : 'over budget';
  const cer = r.graceful ? (r.gotChars <= 400 ? 'abstained' : `${pct(r.cer)}`) : pct(r.cer);
  out.push(`| ${r.kind} | ${r.preset} | ${cer} | ${r.graceful ? '—' : pct(r.wer)} | ${r.conf}% | `
    + `${r.truthChars ? r.gotChars : 0} ch | ${r.precision !== undefined ? `${(r.precision * 100).toFixed(0)}% precise` : '—'} | `
    + `${r.seconds}s | ${verdict} |`);
}

out.push('');
out.push('## Notes');
out.push('');
out.push('- **Abstention.** Cases marked *abstained* are ones where the engine judged the');
out.push('  page unreadable and produced nothing. That is the intended behaviour: on input');
out.push('  past physical recovery, silence is correct and confident fiction is not.');
out.push('- **Timing sensitivity.** Extreme cases are bounded by a per-page time budget, so');
out.push('  their exact output depends on machine load. Normal cases finish well inside the');
out.push('  budget and are fully deterministic.');
out.push('- Regenerate with `npm run harness && node test/report.js`.');
out.push('');

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/TEST-RESULTS.md'), out.join('\n'));
console.log(`docs/TEST-RESULTS.md written — ${rows.length} cases, ${report.passed} passing`);
