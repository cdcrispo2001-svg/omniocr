/* OmniOCR — text-family exports: TXT, Markdown, HTML, hOCR, JSON, CSV. */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function orderedContent(page) {
  const items = [
    ...page.blocks.map((b) => ({ kind: 'block', y: b.bbox.y0, x: b.bbox.x0, column: b.column || 0, data: b })),
    ...page.tables.map((t) => ({ kind: 'table', y: t.bbox.y0, x: t.bbox.x0, column: 0, data: t })),
  ];
  items.sort((a, b) => (a.column - b.column) || (a.y - b.y) || (a.x - b.x));
  return items;
}

/* ---------------- plain text ---------------- */

export function exportTxt(pages, opts = {}) {
  const out = [];
  for (const page of pages) {
    if (opts.pageMarkers !== false && pages.length > 1) out.push(`\n──────── Page ${page.index + 1} ────────\n`);
    for (const item of orderedContent(page)) {
      if (item.kind === 'table') {
        const widths = [];
        for (const row of item.data.cells) row.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, c.text.length); });
        for (const row of item.data.cells) {
          out.push(row.map((c, i) => c.text.padEnd(widths[i] || 0)).join('  ').trimEnd());
        }
        out.push('');
      } else {
        out.push(item.data.text);
        out.push('');
      }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ---------------- markdown ---------------- */

export function exportMarkdown(pages, opts = {}) {
  const out = [];
  for (const page of pages) {
    if (opts.pageMarkers !== false && pages.length > 1) out.push(`\n<!-- page ${page.index + 1} -->\n`);
    for (const item of orderedContent(page)) {
      if (item.kind === 'table') {
        const t = item.data;
        const [head, ...body] = t.cells;
        out.push(`| ${head.map((c) => c.text || ' ').join(' | ')} |`);
        out.push(`| ${head.map(() => '---').join(' | ')} |`);
        for (const row of body) out.push(`| ${row.map((c) => c.text || ' ').join(' | ')} |`);
        out.push('');
        continue;
      }
      const b = item.data;
      if (!b.text.trim()) continue;
      if (b.type === 'heading') out.push(`${'#'.repeat(Math.min(6, b.level || 2))} ${b.text}\n`);
      else if (b.type === 'list-item') out.push(`- ${b.text.replace(/^\s*([•▪◦‣·*\-–—o]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/, '')}`);
      else if (b.type === 'page-number' || b.type === 'header' || b.type === 'footer') out.push(`<!-- ${b.type}: ${b.text} -->`);
      else out.push(`${b.text}\n`);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/* ---------------- HTML ---------------- */

/**
 * Two modes:
 *   semantic — clean reflowable HTML built from the structure tree
 *   layout   — absolutely positioned boxes reproducing the page geometry
 */
export function exportHtml(pages, opts = {}) {
  const mode = opts.mode || 'semantic';
  const body = [];

  for (const page of pages) {
    if (mode === 'layout') {
      const scale = opts.scale || 1;
      body.push(`<section class="page" style="width:${page.width * scale}px;height:${page.height * scale}px">`);
      if (page.imageDataUrl) body.push(`<img class="scan" src="${page.imageDataUrl}" alt="page ${page.index + 1}">`);
      for (const line of page.lines) {
        const b = line.bbox;
        body.push(`<div class="ln" style="left:${b.x0 * scale}px;top:${b.y0 * scale}px;width:${(b.x1 - b.x0) * scale}px;height:${(b.y1 - b.y0) * scale}px;font-size:${(b.y1 - b.y0) * scale * 0.82}px">${esc(line.text)}</div>`);
      }
      body.push('</section>');
      continue;
    }

    body.push(`<section class="page" data-page="${page.index + 1}">`);
    for (const item of orderedContent(page)) {
      if (item.kind === 'table') {
        const t = item.data;
        body.push('<table>');
        t.cells.forEach((row, ri) => {
          body.push('<tr>');
          for (const c of row) body.push(ri === 0 ? `<th>${esc(c.text)}</th>` : `<td>${esc(c.text)}</td>`);
          body.push('</tr>');
        });
        body.push('</table>');
        continue;
      }
      const b = item.data;
      if (!b.text.trim()) continue;
      const conf = ` data-conf="${b.conf.toFixed(1)}"`;
      if (b.type === 'heading') body.push(`<h${Math.min(6, b.level || 2)}${conf}>${esc(b.text)}</h${Math.min(6, b.level || 2)}>`);
      else if (b.type === 'list-item') body.push(`<li${conf}>${esc(b.text.replace(/^\s*([•▪◦‣·*\-–—o]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/, ''))}</li>`);
      else if (b.type === 'header') body.push(`<div class="running head"${conf}>${esc(b.text)}</div>`);
      else if (b.type === 'footer' || b.type === 'page-number') body.push(`<div class="running foot"${conf}>${esc(b.text)}</div>`);
      else body.push(`<p${conf}>${esc(b.text)}</p>`);
    }
    body.push('</section>');
  }

  const css = mode === 'layout'
    ? `body{background:#f4f4f5;margin:0;padding:24px}
.page{position:relative;background:#fff;margin:0 auto 24px;box-shadow:0 2px 12px rgba(0,0,0,.15)}
.page .scan{position:absolute;inset:0;width:100%;height:100%}
.ln{position:absolute;white-space:pre;color:transparent;font-family:Georgia,serif}
.ln::selection{background:rgba(80,140,255,.35)}`
    : `body{font:16px/1.65 Georgia,'Times New Roman',serif;max-width:46rem;margin:0 auto;padding:2.5rem 1.25rem;color:#1c1c1e;background:#fff}
h1,h2,h3,h4{font-family:-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.25;margin:1.6em 0 .5em}
.page{border-bottom:1px dashed #d8d8dc;padding-bottom:2rem;margin-bottom:2rem}
.page:last-child{border-bottom:0}
table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:.92em}
th,td{border:1px solid #d0d0d5;padding:.42em .6em;text-align:left;vertical-align:top}
th{background:#f6f6f8}
.running{color:#8a8a8e;font-size:.8em;font-style:italic}
li{margin:.25em 0}`;

  return `<!doctype html>
<html lang="${opts.lang || 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="OmniOCR">
<title>${esc(opts.title || 'OmniOCR document')}</title>
<style>${css}</style>
</head>
<body>
${body.join('\n')}
</body>
</html>`;
}

/* ---------------- hOCR ---------------- */

export function exportHocr(pages, opts = {}) {
  const out = [`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en">
<head>
<title>${esc(opts.title || 'OmniOCR')}</title>
<meta http-equiv="Content-Type" content="text/html;charset=utf-8" />
<meta name='ocr-system' content='OmniOCR 1.0' />
<meta name='ocr-capabilities' content='ocr_page ocr_carea ocr_par ocr_line ocrx_word' />
</head>
<body>`];

  for (const page of pages) {
    out.push(`<div class='ocr_page' id='page_${page.index + 1}' title='image "${esc(page.name || '')}"; bbox 0 0 ${page.width} ${page.height}; ppageno ${page.index}; scan_res ${page.dpi} ${page.dpi}'>`);
    let bi = 0; let li = 0; let wi = 0;
    for (const block of page.blocks) {
      const bb = block.bbox;
      out.push(`<div class='ocr_carea' id='block_${page.index + 1}_${++bi}' title='bbox ${Math.round(bb.x0)} ${Math.round(bb.y0)} ${Math.round(bb.x1)} ${Math.round(bb.y1)}'>`);
      out.push(`<p class='ocr_par' dir='ltr' title='bbox ${Math.round(bb.x0)} ${Math.round(bb.y0)} ${Math.round(bb.x1)} ${Math.round(bb.y1)}'>`);
      for (const line of block.lines) {
        const lb = line.bbox;
        out.push(`<span class='ocr_line' id='line_${page.index + 1}_${++li}' title='bbox ${Math.round(lb.x0)} ${Math.round(lb.y0)} ${Math.round(lb.x1)} ${Math.round(lb.y1)}'>`);
        for (const w of line.words) {
          const wb = w.bbox;
          out.push(`<span class='ocrx_word' id='word_${page.index + 1}_${++wi}' title='bbox ${Math.round(wb.x0)} ${Math.round(wb.y0)} ${Math.round(wb.x1)} ${Math.round(wb.y1)}; x_wconf ${Math.round(w.conf)}'>${esc(w.text)}</span>`);
        }
        out.push('</span>');
      }
      out.push('</p></div>');
    }
    out.push('</div>');
  }
  out.push('</body></html>');
  return out.join('\n');
}

/* ---------------- JSON / CSV ---------------- */

export function exportJson(pages, opts = {}) {
  return JSON.stringify({
    producer: 'OmniOCR 1.0',
    generated: opts.timestamp || null,
    document: opts.title || null,
    pages: pages.map((p) => ({
      index: p.index,
      name: p.name,
      width: p.width,
      height: p.height,
      dpi: p.dpi,
      confidence: +p.confidence.toFixed(2),
      score: +p.score.toFixed(4),
      quality: p.profile && { tier: p.profile.tier, sharpness: +p.profile.sharpness.toFixed(1), noise: +p.profile.noiseSigma.toFixed(2), contrast: +p.profile.contrast.toFixed(1), skew: +p.profile.skew.toFixed(2), estDpi: p.profile.estDpi },
      depth: p.depth,
      rotation: p.rotation,
      geometry: p.geometrySteps,
      attempts: p.attempts,
      variants: p.variantsRun,
      corrections: p.corrections,
      columns: p.columns,
      blocks: p.blocks.map((b) => ({ type: b.type, level: b.level, column: b.column, bbox: b.bbox, conf: +b.conf.toFixed(1), text: b.text })),
      tables: p.tables.map((t) => ({ bbox: t.bbox, rows: t.rows, cols: t.cols, ruled: t.ruled, cells: t.cells.map((r) => r.map((c) => c.text)) })),
      lines: p.lines.map((l) => ({ text: l.text, conf: +l.conf.toFixed(1), bbox: l.bbox, bboxOriginal: l.bboxOriginal })),
    })),
  }, null, 2);
}

export function exportCsv(pages) {
  const rows = [];
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  for (const page of pages) {
    for (const [ti, t] of page.tables.entries()) {
      rows.push(`# page ${page.index + 1} table ${ti + 1} (${t.rows}x${t.cols}${t.ruled ? ', ruled' : ''})`);
      for (const row of t.cells) rows.push(row.map((c) => q(c.text)).join(','));
      rows.push('');
    }
  }
  return rows.length ? rows.join('\n') : '# no tables detected\n';
}
