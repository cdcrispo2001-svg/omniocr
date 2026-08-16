/* OmniOCR — Word (.docx) export.
 *
 * Rebuilt from the layout tree, not from raw text: headings stay headings,
 * lists stay lists, tables stay tables, and running heads become real Word
 * headers/footers instead of stray paragraphs in the body.
 */

const D = window.docx;

function headingLevel(level) {
  return [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3,
    D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5][Math.min(4, Math.max(1, level) - 1)];
}

function runsFor(block) {
  // Word-level styling is carried over where Tesseract reported it.
  const words = block.lines.flatMap((l) => l.words);
  const anyStyle = words.some((w) => w.bold || w.italic);
  if (!anyStyle) return [new D.TextRun({ text: block.text })];
  const runs = [];
  let buf = ''; let bold = false; let italic = false;
  const flush = () => { if (buf) { runs.push(new D.TextRun({ text: buf, bold, italics: italic })); buf = ''; } };
  for (const w of words) {
    if (w.bold !== bold || w.italic !== italic) { flush(); bold = !!w.bold; italic = !!w.italic; }
    buf += (buf ? ' ' : '') + w.text;
  }
  flush();
  return runs;
}

function tableToDocx(table) {
  const rows = table.cells.map((row, ri) => new D.TableRow({
    tableHeader: ri === 0,
    children: row.map((cell) => new D.TableCell({
      children: [new D.Paragraph({ children: [new D.TextRun({ text: cell.text, bold: ri === 0 })] })],
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
    })),
  }));
  return new D.Table({
    rows,
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    borders: table.ruled ? undefined : {
      top: { style: D.BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
      bottom: { style: D.BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
      left: { style: D.BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
      right: { style: D.BorderStyle.SINGLE, size: 1, color: 'BFBFBF' },
      insideHorizontal: { style: D.BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
      insideVertical: { style: D.BorderStyle.SINGLE, size: 1, color: 'D9D9D9' },
    },
  });
}

/** Interleave blocks and tables in true reading order. */
function orderedContent(page) {
  const items = [
    ...page.blocks.map((b) => ({ kind: 'block', y: b.bbox.y0, x: b.bbox.x0, column: b.column || 0, data: b })),
    ...page.tables.map((t) => ({ kind: 'table', y: t.bbox.y0, x: t.bbox.x0, column: 0, data: t })),
  ];
  items.sort((a, b) => (a.column - b.column) || (a.y - b.y) || (a.x - b.x));
  return items;
}

export async function exportDocx(pages, opts = {}) {
  const sections = [];

  for (const page of pages) {
    const children = [];
    const headers = [];
    const footers = [];

    for (const item of orderedContent(page)) {
      if (item.kind === 'table') { children.push(tableToDocx(item.data)); children.push(new D.Paragraph({ text: '' })); continue; }
      const b = item.data;
      if (!b.text.trim()) continue;
      switch (b.type) {
        case 'heading':
          children.push(new D.Paragraph({ children: runsFor(b), heading: headingLevel(b.level), spacing: { before: 200, after: 100 } }));
          break;
        case 'list-item':
          children.push(new D.Paragraph({
            children: [new D.TextRun({ text: b.text.replace(/^\s*([•▪◦‣·*\-–—o]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)])\s+/, '') })],
            bullet: { level: 0 },
          }));
          break;
        case 'header':
          headers.push(new D.Paragraph({ children: [new D.TextRun({ text: b.text, size: 18, color: '666666' })] }));
          break;
        case 'footer':
        case 'page-number':
          footers.push(new D.Paragraph({ children: [new D.TextRun({ text: b.text, size: 18, color: '666666' })] }));
          break;
        default:
          children.push(new D.Paragraph({ children: runsFor(b), spacing: { after: 120 }, alignment: b.lines[0] && b.lines[0].centered ? D.AlignmentType.CENTER : undefined }));
      }
    }
    if (!children.length) children.push(new D.Paragraph({ text: '' }));

    sections.push({
      properties: {
        page: {
          size: {
            width: Math.round((page.width / (page.dpi || 300)) * 1440),   // twips
            height: Math.round((page.height / (page.dpi || 300)) * 1440),
          },
          margin: { top: 720, bottom: 720, left: 720, right: 720 },
        },
      },
      headers: headers.length ? { default: new D.Header({ children: headers }) } : undefined,
      footers: footers.length ? { default: new D.Footer({ children: footers }) } : undefined,
      children,
    });
  }

  const doc = new D.Document({
    creator: 'OmniOCR',
    title: opts.title || 'OmniOCR document',
    description: 'Recognised with OmniOCR',
    sections,
  });
  const blob = await D.Packer.toBlob(doc);
  return new Uint8Array(await blob.arrayBuffer());
}
