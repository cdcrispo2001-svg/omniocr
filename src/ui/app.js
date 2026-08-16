/* OmniOCR — renderer controller: ingest → engine → viewer → export. */

import { ingest } from 'omni://app/src/ingest.js';
import { Engine } from 'omni://app/src/engine-client.js';
import { exportPdf } from 'omni://app/src/exporters/pdf.js';
import { exportDocx } from 'omni://app/src/exporters/docx.js';
import { exportTxt, exportMarkdown, exportHtml, exportHocr, exportJson, exportCsv } from 'omni://app/src/exporters/text.js';

const $ = (id) => document.getElementById(id);

const state = {
  pages: [],            // { id, name, source, imageData, dpi, digital, depth, result, status }
  selected: -1,
  engine: null,
  running: false,
  cancel: false,
  info: null,
  view: 'scan',
  zoom: 0,              // 0 = fit
};

/* ---------------- boot ---------------- */

async function boot() {
  state.info = await window.omni.info();
  status(`${state.info.platform} · ${state.info.cpus} cores · ${state.info.memGB} GB${state.info.depthHelper ? ' · depth capture available' : ''}`);
  state.engine = new Engine();
  state.engine.onLog = (m) => pushLog(m);
  state.engine.onProgress = (p) => {
    if (p.stage && state.running) status(`Page ${p.page + 1}: ${p.stage}…`);
  };
  const workers = Math.max(2, Math.min(4, state.info.cpus - 4));
  try {
    const ready = await state.engine.start({
      workers,
      corePath: state.info.corePath,
      workerPath: state.info.workerPath,
      langPath: state.info.langPath,
      lexiconPath: state.info.lexiconPath,
    });
    pushLog(`engine ready — ${ready.workers} OCR workers, lexicon ${ready.lexicon.toLocaleString()} words`);
  } catch (err) {
    status(`Engine failed to start: ${err.message}`);
  }
  await refreshLanguages();
}

const logs = [];
function pushLog(m) { console.log('[omniocr]', m); logs.push(`${new Date().toLocaleTimeString()}  ${m}`); if (logs.length > 500) logs.shift(); if (state.view === 'diagnostics') renderDiagnostics(); }
function status(msg) { $('statusLine').textContent = msg; }

/* ---------------- ingest ---------------- */

async function addPaths(paths) {
  if (!paths || !paths.length) return;
  const dpi = +$('optDpi').value;
  const useTextLayer = $('optTextLayer').checked;
  for (const path of paths) {
    try {
      status(`Reading ${path.split('/').pop()}…`);
      const file = await window.omni.readFile(path);
      const depthNative = $('optDepth').checked ? await window.omni.extractDepth(path).catch(() => null) : null;
      const pages = await ingest(file, { dpi, useTextLayer });
      for (const p of pages) {
        state.pages.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          path,
          ...p,
          depthNative,
          status: 'pending',
          result: null,
        });
      }
      pushLog(`ingested ${path.split('/').pop()} → ${pages.length} page(s)${pages[0] && pages[0].digital ? ' (has text layer)' : ''}`);
    } catch (err) {
      pushLog(`failed to read ${path}: ${err.message}`);
      status(`Could not read ${path.split('/').pop()}: ${err.message}`);
    }
  }
  renderPageList();
  if (state.selected < 0 && state.pages.length) select(0);
  $('btnRun').disabled = !state.pages.length || state.running;
  status(`${state.pages.length} page(s) ready`);
}

/* ---------------- rendering: page list ---------------- */

function thumbUrl(page) {
  if (page.thumb) return page.thumb;
  const src = page.imageData;
  const w = 80;
  const h = Math.max(1, Math.round((src.height / src.width) * w));
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').putImageData(src, 0, 0);
  const t = document.createElement('canvas');
  t.width = w; t.height = h;
  t.getContext('2d').drawImage(c, 0, 0, w, h);
  page.thumb = t.toDataURL('image/jpeg', 0.6);
  return page.thumb;
}

function renderPageList() {
  const el = $('pageList');
  $('pageCount').textContent = String(state.pages.length);
  if (!state.pages.length) {
    el.innerHTML = '<div class="empty"><p><strong>Drop documents here</strong></p><p class="muted">PDF · JPG · PNG · TIFF (multi-page) · HEIC · WEBP · BMP</p></div>';
    return;
  }
  el.innerHTML = '';
  state.pages.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = `page-item${i === state.selected ? ' sel' : ''}`;
    const dot = p.status === 'done'
      ? (p.result.unreadable ? 'bad' : p.result.confidence >= 90 ? 'good' : p.result.confidence >= 75 ? 'warn' : 'bad')
      : p.status === 'running' ? 'busy' : '';
    const sub = p.status === 'done'
      ? (p.result.unreadable ? 'unreadable — nothing recognised' : `${p.result.confidence.toFixed(0)}% · ${p.result.wordCount} words`)
      : p.digital ? 'text layer' : `${p.imageData.width}×${p.imageData.height}`;
    div.innerHTML = `<div class="thumb" style="background-image:url(${thumbUrl(p)})"></div>
      <div class="meta"><div class="nm">${escapeHtml(p.name)}</div>
      <div class="sub"><i class="dot ${dot}"></i>${escapeHtml(sub)}</div></div>`;
    div.onclick = () => select(i);
    el.appendChild(div);
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------------- rendering: viewer ---------------- */

function select(i) {
  state.selected = i;
  renderPageList();
  renderViewer();
  renderMetrics();
}

function currentPage() { return state.pages[state.selected] || null; }

function renderViewer() {
  const page = currentPage();
  const views = { scan: $('stage'), text: $('textView'), structure: $('structureView'), diagnostics: $('diagView') };
  for (const [k, el] of Object.entries(views)) el.hidden = k !== state.view;
  if (!page) return;
  if (state.view === 'scan') renderScan(page);
  else if (state.view === 'text') {
    $('textView').textContent = !page.result ? '(not recognised yet)'
      : page.result.unreadable
        ? 'This page could not be read.\n\nThe recogniser produced only implausible output, so OmniOCR discarded it '
          + 'rather than present invented text. Every discarded line is listed under Diagnostics.\n\n'
          + 'Try: a higher scan resolution, the Maximum effort setting, or re-capturing the page with more even lighting.'
        : page.result.text;
  }
  else if (state.view === 'structure') renderStructure(page);
  else renderDiagnostics();
}

function renderScan(page) {
  const canvas = $('pageCanvas');
  const img = page.result && page.result.image ? null : page.imageData;
  const wrap = $('canvasWrap');
  const maxW = wrap.clientWidth - 44;
  const maxH = wrap.clientHeight - 44;

  const draw = (source, w, h) => {
    const fit = Math.min(maxW / w, maxH / h, 1);
    const scale = state.zoom || fit;
    canvas.width = w; canvas.height = h;
    canvas.style.width = `${w * scale}px`;
    canvas.style.height = `${h * scale}px`;
    const ctx = canvas.getContext('2d');
    if (source instanceof ImageData) ctx.putImageData(source, 0, 0);
    else ctx.drawImage(source, 0, 0);
    $('zoomLabel').textContent = state.zoom ? `${Math.round(scale * 100)}%` : 'Fit';
    renderOverlay(page, w, h);
  };

  if (page.result && page.result.image) {
    const blob = new Blob([page.result.image.bytes], { type: page.result.image.type });
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => { draw(im, im.width, im.height); URL.revokeObjectURL(url); };
    im.src = url;
  } else {
    draw(img, img.width, img.height);
  }
}

function renderOverlay(page, w, h) {
  const svg = $('overlay');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  if (!page.result) { svg.innerHTML = ''; return; }
  const parts = [];
  const rect = (b, cls) => `<rect class="${cls}" x="${b.x0}" y="${b.y0}" width="${Math.max(1, b.x1 - b.x0)}" height="${Math.max(1, b.y1 - b.y0)}" rx="1"/>`;
  if ($('ovLines').checked) for (const l of page.result.lines) parts.push(rect(l.bbox, 'ov-line'));
  if ($('ovBlocks').checked) for (const b of page.result.blocks) parts.push(rect(b.bbox, 'ov-block'));
  if ($('ovTables').checked) {
    for (const t of page.result.tables) {
      parts.push(rect(t.bbox, 'ov-table'));
      for (const y of t.rows) parts.push(`<line class="ov-table" x1="${t.bbox.x0}" y1="${y}" x2="${t.bbox.x1}" y2="${y}"/>`);
      for (const x of t.cols) parts.push(`<line class="ov-table" x1="${x}" y1="${t.bbox.y0}" x2="${x}" y2="${t.bbox.y1}"/>`);
    }
  }
  if ($('ovLowConf').checked) {
    for (const l of page.result.lines) for (const word of l.words) if (word.conf < 70) parts.push(rect(word.bbox, 'ov-low'));
  }
  svg.innerHTML = parts.join('');
}

function renderStructure(page) {
  const el = $('structureView');
  if (!page.result) { el.innerHTML = '<p class="muted">Not recognised yet.</p>'; return; }
  const items = [
    ...page.result.blocks.map((b) => ({ y: b.bbox.y0, col: b.column || 0, html: `<div class="blk ${b.type}"><span class="tag">${b.type}${b.level ? ` h${b.level}` : ''} · ${b.conf.toFixed(0)}%</span><div>${escapeHtml(b.text)}</div></div>` })),
    ...page.result.tables.map((t) => ({
      y: t.bbox.y0,
      col: 0,
      html: `<div class="blk table"><span class="tag">table ${t.rows}×${t.cols}${t.ruled ? ' · ruled' : ' · inferred'}</span><table>${t.cells.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c.text)}</td>`).join('')}</tr>`).join('')}</table></div>`,
    })),
  ].sort((a, b) => (a.col - b.col) || (a.y - b.y));
  el.innerHTML = items.map((i) => i.html).join('') || '<p class="muted">No structure detected.</p>';
}

function renderDiagnostics() {
  const page = currentPage();
  const el = $('diagView');
  const rows = [];
  if (page && page.result) {
    const r = page.result;
    const p = r.profile;
    rows.push('<h3>Page condition</h3><table>');
    rows.push(row('Assessed tier', p.tier));
    rows.push(row('Sharpness (var Laplacian)', p.sharpness.toFixed(1)));
    rows.push(row('Noise σ', p.noiseSigma.toFixed(2)));
    rows.push(row('Ink/paper contrast', `${p.contrast.toFixed(1)} (ink ${p.inkLevel.toFixed(0)}, paper ${p.paperLevel.toFixed(0)})`));
    rows.push(row('Illumination spread', p.illumStd.toFixed(1)));
    rows.push(row('Character height', `${p.componentHeight}px → est. ${p.estDpi} dpi`));
    rows.push(row('Residual skew', `${p.skew.toFixed(2)}°`));
    rows.push(row('Foreign-mark load', `${(p.foreignMarkScore * 100).toFixed(1)}%`));
    rows.push(row('Speck ratio', `${(p.speckRatio * 100).toFixed(1)}%`));
    rows.push('</table><h3>Processing</h3><table>');
    rows.push(row('Geometry', r.geometrySteps.map((s) => `${s.op}${s.deg !== undefined ? ` ${s.deg}°` : ''}`).join(', ') || 'none'));
    rows.push(row('Rotation (OSD)', `${r.rotation}°`));
    rows.push(row('Depth assistance', r.depth ? JSON.stringify(r.depth) : 'none'));
    rows.push(row('Columns', r.columns));
    rows.push(row('Escalation attempts', r.attempts.map((a) => `L${a.level}/psm${a.psm}→${a.score.toFixed(3)}`).join('  ')));
    rows.push(row('Variants run', r.variantsRun.map((v) => `${v.id}@${v.scale}x psm${v.psm} ${v.conf}% ${v.ms}ms`).join('<br>')));
    rows.push(row('Corrections applied', r.corrections.length));
    rows.push(row('Timings (ms)', Object.entries(r.timings).map(([k, v]) => `${k}=${Math.round(v)}`).join(' · ')));
    rows.push('</table>');
    if (r.corrections.length) {
      rows.push('<h3>Corrections</h3><table>');
      for (const c of r.corrections.slice(0, 60)) rows.push(row(`${c.rule}`, `${escapeHtml(c.from)} → ${escapeHtml(c.to)}`));
      rows.push('</table>');
    }
  }
  rows.push('<h3>Engine log</h3><table>');
  for (const l of logs.slice(-80).reverse()) rows.push(`<tr><td colspan="2">${escapeHtml(l)}</td></tr>`);
  rows.push('</table>');
  el.innerHTML = rows.join('');
}

const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;

function renderMetrics() {
  const p = currentPage();
  const r = p && p.result;
  $('mConf').textContent = r ? `${r.confidence.toFixed(1)}%` : '—';
  $('mScore').textContent = r ? r.score.toFixed(3) : '—';
  $('mTier').textContent = r ? (r.unreadable ? 'unreadable' : r.profile.tier) : '—';
  $('mWords').textContent = r ? r.wordCount : '—';
  $('mFixes').textContent = r ? r.corrections.length : '—';
  $('mTime').textContent = r ? `${(r.timings.total / 1000).toFixed(1)}s` : '—';
  const done = state.pages.some((x) => x.status === 'done');
  document.querySelectorAll('[data-export]').forEach((b) => { b.disabled = !done; });
}

/* ---------------- run ---------------- */

function currentOptions() {
  return {
    profile: $('optProfile').value,
    dewarp: $('optDewarp').checked,
    deskew: $('optDeskew').checked,
    autoRotate: $('optRotate').checked,
    useDepth: $('optDepth').checked,
    tables: $('optTables').checked,
    correct: $('optCorrect').checked,
    enhanceExport: $('optEnhance').checked,
  };
}

async function run() {
  if (state.running) return;
  state.running = true; state.cancel = false;
  $('btnRun').disabled = true; $('btnCancel').hidden = false;
  const opts = currentOptions();
  const t0 = performance.now();
  let done = 0;

  for (let i = 0; i < state.pages.length; i++) {
    if (state.cancel) break;
    const page = state.pages[i];
    if (page.status === 'done') { done++; continue; }
    page.status = 'running';
    renderPageList();
    status(`Recognising page ${i + 1} of ${state.pages.length}…`);
    try {
      const useTextLayer = page.digital && $('optTextLayer').checked;
      const depth = useTextLayer ? null : await depthFor(page);
      page.result = await state.engine.page(
        { imageData: page.imageData, index: i, name: page.name, dpi: page.dpi, depth },
        useTextLayer ? { ...opts, digitalLines: page.digital.lines } : opts,
      );
      page.status = 'done';
      done++;
    } catch (err) {
      page.status = 'error';
      pushLog(`page ${i + 1} failed: ${err.message}`);
    }
    $('progressFill').style.width = `${((i + 1) / state.pages.length) * 100}%`;
    renderPageList();
    if (i === state.selected) { renderViewer(); renderMetrics(); }
  }

  state.running = false;
  $('btnRun').disabled = false; $('btnCancel').hidden = true;
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  status(`Recognised ${done} page(s) in ${secs}s`);
  renderMetrics();
  if (state.selected >= 0) renderViewer();
}

async function depthFor(page) {
  if (!$('optDepth').checked) return null;
  if (page.depth) return page.depth;
  if (page.depthNative && page.depthNative.ok) {
    const data = new Float32Array(page.depthNative.buffer);
    let min = Infinity; let max = -Infinity;
    for (const v of data) { if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; } }
    const span = (max - min) || 1;
    const norm = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) norm[i] = Number.isFinite(data[i]) ? (data[i] - min) / span : 0.5;
    page.depth = { width: page.depthNative.width, height: page.depthNative.height, data: norm, kind: page.depthNative.kind, source: 'native' };
    pushLog(`depth map ${page.depth.width}×${page.depth.height} (${page.depth.kind}) applied to ${page.name}`);
    return page.depth;
  }
  return null;
}

/* ---------------- export ---------------- */

const EXPORTERS = {
  pdf: { ext: 'pdf', mime: 'application/pdf', fn: (pages, o) => exportPdf(pages, o) },
  docx: { ext: 'docx', fn: (pages, o) => exportDocx(pages, o) },
  html: { ext: 'html', fn: (pages, o) => exportHtml(pages, o) },
  txt: { ext: 'txt', fn: (pages) => exportTxt(pages) },
  md: { ext: 'md', fn: (pages) => exportMarkdown(pages) },
  csv: { ext: 'csv', fn: (pages) => exportCsv(pages) },
  hocr: { ext: 'hocr', fn: (pages, o) => exportHocr(pages, o) },
  json: { ext: 'json', fn: (pages, o) => exportJson(pages, o) },
};

async function doExport(kind) {
  const results = state.pages.filter((p) => p.status === 'done').map((p) => p.result);
  if (!results.length) return;
  const spec = EXPORTERS[kind];
  const base = (state.pages[0].source || 'document').replace(/\.[^.]+$/, '');
  const target = await window.omni.saveDialog({
    title: `Export ${kind.toUpperCase()}`,
    defaultPath: `${base}.omniocr.${spec.ext}`,
    filters: [{ name: kind.toUpperCase(), extensions: [spec.ext] }],
  });
  if (!target) return;
  status(`Writing ${kind.toUpperCase()}…`);
  try {
    const out = await spec.fn(results, { title: base, timestamp: new Date().toISOString() });
    const bytes = typeof out === 'string' ? new TextEncoder().encode(out) : out;
    await window.omni.writeFile(target, bytes);
    status(`Saved ${target}`);
    pushLog(`exported ${kind} → ${target} (${(bytes.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    status(`Export failed: ${err.message}`);
    pushLog(`export ${kind} failed: ${err.stack || err.message}`);
  }
}

/* ---------------- languages ---------------- */

async function refreshLanguages() {
  const installed = await window.omni.listLanguages();
  const sel = $('optLang');
  const known = { eng: 'English' };
  sel.innerHTML = '';
  const codes = ['eng', ...installed.filter((c) => c !== 'eng' && c !== 'osd')];
  for (const c of codes) {
    const o = document.createElement('option');
    o.value = c; o.textContent = known[c] || c;
    sel.appendChild(o);
  }
}

/* ---------------- wiring ---------------- */

function wire() {
  $('btnAdd').onclick = async () => addPaths(await window.omni.openFiles({}));
  $('btnFolder').onclick = async () => addPaths(await window.omni.openFiles({ directory: true }));
  $('btnRun').onclick = run;
  $('btnCancel').onclick = () => { state.cancel = true; status('Stopping after current page…'); };

  document.querySelectorAll('#viewModes button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#viewModes button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      state.view = b.dataset.view;
      renderViewer();
    };
  });
  ['ovLines', 'ovBlocks', 'ovTables', 'ovLowConf'].forEach((id) => { $(id).onchange = () => renderViewer(); });
  $('zoomIn').onclick = () => { state.zoom = Math.min(4, (state.zoom || 1) * 1.25); renderViewer(); };
  $('zoomOut').onclick = () => { state.zoom = Math.max(0.1, (state.zoom || 1) / 1.25); renderViewer(); };
  $('zoomLabel').onclick = () => { state.zoom = 0; renderViewer(); };

  document.querySelectorAll('[data-export]').forEach((b) => { b.onclick = () => doExport(b.dataset.export); });

  $('btnInstallLang').onclick = async () => {
    const code = $('langCode').value.trim().toLowerCase();
    if (!code) return;
    status(`Downloading language pack “${code}”…`);
    try {
      await window.omni.installLanguage(code);
      await refreshLanguages();
      $('optLang').value = code;
      status(`Language pack “${code}” installed`);
    } catch (err) {
      status(`Language install failed: ${err.message}`);
    }
  };

  $('optLang').onchange = async () => {
    const lang = $('optLang').value;
    const path = lang === 'eng' ? 'omni://app/vendor/tessdata/best' : 'omni://userlang/';
    status(`Loading ${lang}…`);
    try { await state.engine.setLanguages(lang, path); status(`Language: ${lang}`); }
    catch (err) { status(`Could not load ${lang}: ${err.message}`); }
  };

  // drag & drop
  const overlay = $('dropOverlay');
  window.addEventListener('dragover', (e) => { e.preventDefault(); overlay.hidden = false; });
  window.addEventListener('dragleave', (e) => { if (e.clientX === 0 && e.clientY === 0) overlay.hidden = true; });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    overlay.hidden = true;
    const paths = [...e.dataTransfer.files].map((f) => window.omni.pathFor ? window.omni.pathFor(f) : f.path).filter(Boolean);
    if (paths.length) addPaths(paths);
  });

  window.addEventListener('resize', () => { if (state.view === 'scan') renderViewer(); });
}

wire();
boot();
