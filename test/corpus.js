/* OmniOCR test corpus — document archetypes rendered from known ground truth.
 *
 * Ground truth is the source of the render, so every degradation case has an
 * exact reference to score against.
 */

export const DOCUMENTS = {
  article: {
    title: 'Groundwater Recharge in Semi-Arid Catchments',
    body: [
      'Groundwater recharge is the process by which water moves downward from surface',
      'water to an aquifer. In semi-arid catchments the process is episodic rather than',
      'continuous, and a single storm may account for the greater part of an entire',
      'season of recharge. Field measurements collected between 2019 and 2023 show',
      'that infiltration rates vary by nearly two orders of magnitude across sites that',
      'lie within four kilometres of one another.',
      '',
      'The dominant control appears to be the thickness of the weathered regolith. Where',
      'the regolith exceeds eight metres, storm runoff is retained long enough for slow',
      'percolation to reach the water table. Where it is thin, the same storm produces',
      'rapid overland flow and very little recharge. This distinction matters for well',
      'siting, and it explains why boreholes drilled only a short distance apart can',
      'differ so sharply in yield.',
    ],
    heading2: 'Measurement Method',
    body2: [
      'Twelve monitoring wells were instrumented with pressure transducers logging at',
      'fifteen minute intervals. Rainfall was recorded by tipping bucket gauges at four',
      'sites. Recharge was estimated using the water table fluctuation method, with',
      'specific yield determined from pumping tests conducted in the dry season.',
    ],
  },

  invoice: {
    title: 'INVOICE',
    meta: [
      'Riverside Supplies Limited',
      'Plot 24, Industrial Area, Kampala',
      'Invoice No. INV-2024-0871',
      'Date: 14 March 2024',
      'Terms: Net 30 days',
    ],
    table: {
      header: ['Description', 'Qty', 'Unit Price', 'Amount'],
      rows: [
        ['Portland cement, 50 kg bag', '120', '38,500', '4,620,000'],
        ['Reinforcement bar, 12 mm', '86', '52,000', '4,472,000'],
        ['Binding wire, 25 kg roll', '14', '96,500', '1,351,000'],
        ['River sand, cubic metre', '32', '75,000', '2,400,000'],
        ['Hardcore aggregate, tonne', '48', '61,250', '2,940,000'],
      ],
      totals: [
        ['Subtotal', '', '', '15,783,000'],
        ['VAT at 18 percent', '', '', '2,840,940'],
        ['Total due', '', '', '18,623,940'],
      ],
    },
    footer: 'Payment by bank transfer to account 0140067891234, Stanbic Bank, Garden City Branch.',
  },

  twoColumn: {
    title: 'The Structure of Scientific Reports',
    left: [
      'A scientific report follows a conventional',
      'structure because readers use that structure',
      'to navigate. The abstract states the question',
      'and the answer. The introduction explains why',
      'the question matters and what was already',
      'known. The methods section describes what was',
      'done in enough detail that another worker',
      'could repeat it.',
      '',
      'Results present the findings without',
      'interpretation. Figures and tables carry the',
      'evidence, and the text points to what the',
      'reader should notice in them.',
    ],
    right: [
      'The discussion interprets the results and',
      'places them against earlier work. It is the',
      'only section where speculation belongs, and',
      'even there it should be labelled as such.',
      '',
      'References allow a reader to trace every',
      'claim back to its source. A report that',
      'cannot be traced cannot be checked, and a',
      'claim that cannot be checked is not yet',
      'a scientific claim at all. This is the',
      'reason reference lists are held to such',
      'exacting standards by editors.',
    ],
  },

  form: {
    title: 'PATIENT REGISTRATION FORM',
    fields: [
      ['Surname', 'NAKAMYA'],
      ['Given names', 'Sarah Immaculate'],
      ['Date of birth', '07 / 11 / 1988'],
      ['Patient number', 'KMP-441907'],
      ['Blood group', 'O positive'],
      ['Weight', '64.5 kg'],
      ['Blood pressure', '118 / 76 mmHg'],
      ['Allergies', 'Penicillin, sulphonamides'],
      ['Referred by', 'Dr. B. Ochieng, Mulago'],
      ['Admission date', '22 August 2024'],
    ],
    notes: [
      'Presenting complaint: intermittent fever for eleven days with joint pain.',
      'Malaria rapid diagnostic test negative on admission. Full blood count requested.',
      'Commence oral rehydration and review after twenty four hours.',
    ],
  },

  dense: {
    title: 'Terms and Conditions of Carriage',
    body: [
      '1. The carrier accepts goods for carriage subject to these conditions, which supersede',
      'all prior arrangements. 2. The consignor warrants that the description of the goods',
      'given at the time of booking is accurate in every material respect. 3. Liability for',
      'loss or damage is limited to the declared value, or where no value is declared, to the',
      'sum of forty thousand shillings per consignment. 4. The carrier shall not be liable for',
      'delay arising from circumstances beyond its reasonable control, including but not',
      'limited to weather, civil disturbance, mechanical failure or the act of any public',
      'authority. 5. Claims must be lodged in writing within seven days of the date on which',
      'the goods were delivered or should have been delivered. 6. Perishable goods are carried',
      'entirely at the risk of the consignor unless refrigerated carriage has been booked and',
      'paid for in advance. 7. The carrier reserves a lien over all goods in its possession for',
      'unpaid charges. 8. These conditions are governed by the laws of Uganda and the courts',
      'of Uganda shall have exclusive jurisdiction over any dispute arising under them.',
    ],
  },
};

/* ---------------- rendering ---------------- */

const A4 = { w: 2480, h: 3508 };     // 300 dpi

function ctxFor(scale = 1) {
  const w = Math.round(A4.w * scale);
  const h = Math.round(A4.h * scale);
  const c = new OffscreenCanvas(w, h);
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, w, h);
  x.fillStyle = '#0a0a0a';
  x.textBaseline = 'alphabetic';
  return { canvas: c, ctx: x, w, h };
}

/** @returns { imageData, truth } — truth is the reading-order text. */
export function render(kind, opts = {}) {
  const scale = opts.scale || 1;
  const { canvas, ctx, w } = ctxFor(scale);
  const S = (n) => n * scale;
  const truth = [];
  const serif = 'Georgia, "Times New Roman", serif';
  const sans = '"Helvetica Neue", Arial, sans-serif';

  const line = (text, x, y, font) => {
    ctx.font = font;
    ctx.fillText(text, x, y);
    if (text.trim()) truth.push(text.trim());
  };

  if (kind === 'article') {
    const d = DOCUMENTS.article;
    let y = S(280);
    line(d.title, S(220), y, `600 ${S(58)}px ${serif}`);
    y += S(110);
    for (const t of d.body) { if (t) line(t, S(220), y, `${S(34)}px ${serif}`); y += S(54); }
    y += S(40);
    line(d.heading2, S(220), y, `600 ${S(42)}px ${serif}`);
    y += S(80);
    for (const t of d.body2) { line(t, S(220), y, `${S(34)}px ${serif}`); y += S(54); }
  }

  if (kind === 'dense') {
    const d = DOCUMENTS.dense;
    let y = S(260);
    line(d.title, S(200), y, `600 ${S(46)}px ${serif}`);
    y += S(90);
    for (const t of d.body) { line(t, S(200), y, `${S(26)}px ${serif}`); y += S(42); }
  }

  if (kind === 'twoColumn') {
    const d = DOCUMENTS.twoColumn;
    let y = S(260);
    line(d.title, S(200), y, `600 ${S(52)}px ${serif}`);
    const top = S(400);
    let ly = top;
    for (const t of d.left) { if (t) line(t, S(200), ly, `${S(32)}px ${serif}`); ly += S(50); }
    let ry = top;
    for (const t of d.right) { if (t) line(t, S(1320), ry, `${S(32)}px ${serif}`); ry += S(50); }
  }

  if (kind === 'invoice') {
    const d = DOCUMENTS.invoice;
    let y = S(240);
    line(d.title, S(200), y, `700 ${S(62)}px ${sans}`);
    y += S(90);
    for (const t of d.meta) { line(t, S(200), y, `${S(30)}px ${sans}`); y += S(46); }
    y += S(50);

    const cols = [S(200), S(1320), S(1620), S(2000)];
    const right = S(2280);
    const rowH = S(64);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = Math.max(1, S(2));

    const tableTop = y;
    ctx.font = `700 ${S(30)}px ${sans}`;
    d.table.header.forEach((h, i) => { ctx.fillText(h, cols[i], y + S(42)); });
    truth.push(d.table.header.join(' '));
    y += rowH;
    ctx.font = `${S(30)}px ${sans}`;
    for (const r of [...d.table.rows, ...d.table.totals]) {
      r.forEach((cell, i) => { if (cell) ctx.fillText(cell, cols[i], y + S(42)); });
      if (r.join('').trim()) truth.push(r.filter(Boolean).join(' '));
      y += rowH;
    }
    // rules
    const bottom = y;
    for (let ry = tableTop; ry <= bottom; ry += rowH) {
      ctx.beginPath(); ctx.moveTo(cols[0] - S(20), ry); ctx.lineTo(right, ry); ctx.stroke();
    }
    for (const cx of [cols[0] - S(20), cols[1] - S(20), cols[2] - S(20), cols[3] - S(20), right]) {
      ctx.beginPath(); ctx.moveTo(cx, tableTop); ctx.lineTo(cx, bottom); ctx.stroke();
    }
    y += S(90);
    line(d.footer, S(200), y, `${S(28)}px ${sans}`);
  }

  if (kind === 'form') {
    const d = DOCUMENTS.form;
    let y = S(250);
    line(d.title, S(200), y, `700 ${S(50)}px ${sans}`);
    y += S(110);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = Math.max(1, S(2));
    for (const [label, value] of d.fields) {
      ctx.font = `${S(30)}px ${sans}`;
      ctx.fillText(`${label}:`, S(200), y);
      ctx.font = `600 ${S(32)}px ${sans}`;
      ctx.fillText(value, S(900), y);
      truth.push(`${label}: ${value}`);
      ctx.beginPath(); ctx.moveTo(S(880), y + S(14)); ctx.lineTo(S(2280), y + S(14)); ctx.stroke();
      y += S(86);
    }
    y += S(50);
    for (const t of d.notes) { line(t, S(200), y, `${S(30)}px ${sans}`); y += S(52); }
  }

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { imageData, truth: truth.join('\n'), kind };
}

export const KINDS = Object.keys(DOCUMENTS);
