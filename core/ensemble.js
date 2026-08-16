'use strict';
/* OmniOCR — multi-variant result fusion (ROVER-style).
 *
 * Each restoration variant sees the page differently: one recovers faint
 * strokes but fuses characters, another separates characters but drops light
 * ones. Fusing per line and per word recovers text no single variant got right.
 */
(function (scope) {
  const GARBAGE = /[^\p{L}\p{N}\s.,;:!?()"'’“”\-–—/%&$€£#@*+=<>[\]{}|\\~^`§°±×÷…]/u;

  /* ---------------- scoring ---------------- */

  function lexScore(text) {
    const Lex = scope.Lexicon;
    const tokens = text.split(/\s+/).filter((t) => /\p{L}/u.test(t));
    if (!tokens.length) return 0.5;
    let hits = 0;
    for (const t of tokens) {
      const clean = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
      if (!clean) { hits += 0.5; continue; }
      if (Lex && Lex.has(clean)) hits += 1;
      else if (/^\p{Lu}/u.test(t) && clean.length > 2) hits += 0.7;   // probably a proper noun
      else if (clean.length <= 2) hits += 0.6;
      else if (Lex && Lex.looksWordLike(clean)) hits += 0.45;
    }
    return hits / tokens.length;
  }

  /**
   * Strict lexicality: the fraction of substantial tokens that are real words.
   *
   * lexScore() above is deliberately generous — when *ranking* competing
   * readings of the same line, an unrecognised proper noun should not be
   * punished. That generosity is wrong for *rejection*: recogniser noise is
   * mostly short fragments and stray capitals, exactly the shapes that earn
   * partial credit there. Rejection therefore asks a harder question — is this
   * actually made of dictionary words?
   */
  function strictLexScore(text) {
    const Lex = scope.Lexicon;
    if (!Lex) return 1;
    const tokens = (text.match(/\p{L}[\p{L}'-]*/gu) || []).filter((t) => t.length >= 3);
    if (!tokens.length) return 0;
    let hits = 0;
    for (const t of tokens) if (isRealWord(t)) hits += 1;
    return hits / tokens.length;
  }

  /**
   * Membership in a 380 000-word list is a weak signal: three-letter noise
   * ("asa", "ony", "aes") lands in it constantly, so garbage can score as
   * perfect prose. A word counts as real only if it is actually common, or long
   * enough that hitting it by accident is implausible.
   */
  function isRealWord(token) {
    const Lex = scope.Lexicon;
    if (!Lex) return true;
    const w = token.toLowerCase().replace(/[^\p{L}]/gu, '');
    if (w.length < 3) return false;
    if (Lex.isCommon(w, 30000)) return true;
    return w.length >= 5 && Lex.has(w);
  }

  /** Numbers, codes and amounts are legitimately absent from any lexicon. */
  function isNumericLine(text) {
    const digits = (text.match(/\d/g) || []).length;
    return text.length > 0 && digits / text.length >= 0.28;
  }

  /** Penalise strings that look like recogniser noise rather than language. */
  function structureScore(text) {
    if (!text.trim()) return 0;
    const chars = [...text];
    const weird = chars.filter((c) => GARBAGE.test(c)).length / chars.length;
    const alpha = chars.filter((c) => /\p{L}/u.test(c)).length / chars.length;
    const isolated = (text.match(/(^|\s)[^\p{L}\p{N}\s](\s|$)/gu) || []).length;
    const caseFlips = (text.match(/\p{Ll}\p{Lu}/gu) || []).length / Math.max(1, chars.length / 8);
    let s = 1 - weird * 2.2 - Math.min(0.35, isolated * 0.06) - Math.min(0.3, caseFlips * 0.25);
    if (alpha < 0.35 && /\p{L}/u.test(text)) s -= 0.15;
    return Math.max(0, Math.min(1, s));
  }

  function lineScore(line) {
    const conf = Math.max(0, Math.min(100, line.conf)) / 100;
    const lex = lexScore(line.text);
    const str = structureScore(line.text);
    const lenBonus = Math.min(0.06, line.text.trim().length / 900);
    return 0.50 * conf + 0.27 * lex + 0.23 * str + lenBonus;
  }

  /* ---------------- geometry helpers ---------------- */

  const vOverlap = (a, b) => {
    const top = Math.max(a.y0, b.y0);
    const bot = Math.min(a.y1, b.y1);
    return Math.max(0, bot - top) / Math.max(1, Math.min(a.y1 - a.y0, b.y1 - b.y0));
  };
  const hOverlap = (a, b) => {
    const l = Math.max(a.x0, b.x0);
    const r = Math.min(a.x1, b.x1);
    return Math.max(0, r - l) / Math.max(1, Math.min(a.x1 - a.x0, b.x1 - b.x0));
  };

  /** Rescale a variant's boxes back into canonical page coordinates. */
  function toCanonical(result, scale) {
    if (!scale || Math.abs(scale - 1) < 1e-6) return result;
    const fix = (b) => ({ x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale });
    return {
      ...result,
      lines: result.lines.map((l) => ({
        ...l,
        bbox: fix(l.bbox),
        words: l.words.map((w) => ({ ...w, bbox: fix(w.bbox) })),
      })),
    };
  }

  /* ---------------- word-level voting ---------------- */

  /**
   * Align words of candidate lines by horizontal position and vote.
   * Only applied when ≥3 candidates agree on the line's extent, where voting
   * is reliable; otherwise the best whole line wins.
   */
  function roverWords(candidates) {
    const ref = candidates[0];
    const out = [];
    for (const rw of ref.words) {
      const group = [{ w: rw, weight: 1.15 }];   // reference gets a small prior
      for (let i = 1; i < candidates.length; i++) {
        let best = null; let bestOv = 0.34;
        for (const cw of candidates[i].words) {
          const ov = hOverlap(rw.bbox, cw.bbox);
          if (ov > bestOv && vOverlap(rw.bbox, cw.bbox) > 0.3) { bestOv = ov; best = cw; }
        }
        if (best) group.push({ w: best, weight: 1 });
      }
      if (group.length === 1) { out.push(rw); continue; }
      const votes = new Map();
      for (const { w, weight } of group) {
        const key = w.text;
        const prev = votes.get(key) || { text: key, score: 0, conf: 0, n: 0, w };
        const lex = scope.Lexicon && scope.Lexicon.has(key.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) ? 0.35 : 0;
        prev.score += weight * (w.conf / 100 + lex);
        prev.conf = Math.max(prev.conf, w.conf);
        prev.n += 1;
        votes.set(key, prev);
      }
      const winner = [...votes.values()].sort((a, b) => b.score - a.score)[0];
      out.push({ ...rw, text: winner.text, conf: Math.max(rw.conf, winner.conf), votes: votes.size });
    }
    return out;
  }

  /* ---------------- fusion ---------------- */

  /**
   * @param results Array of { result, variant } — variant carries `scale`/`id`
   * @returns fused { lines, text, confidence, agreement, sources }
   */
  function fuse(results) {
    const norm = results
      .filter((r) => r && r.result && r.result.lines.length)
      .map((r) => ({ ...toCanonical(r.result, r.variant.scale), variantId: r.variant.id }));
    if (!norm.length) return { lines: [], text: '', confidence: 0, agreement: 0, sources: [] };
    if (norm.length === 1) {
      const only = norm[0];
      return { ...only, agreement: 1, sources: [only.variantId] };
    }

    // Reference = the variant with the best aggregate line quality.
    const scored = norm.map((r) => ({
      r,
      score: r.lines.reduce((s, l) => s + lineScore(l) * Math.max(4, l.text.length), 0)
        / Math.max(1, r.lines.reduce((s, l) => s + Math.max(4, l.text.length), 0)),
    })).sort((a, b) => b.score - a.score);
    const ref = scored[0].r;
    const others = norm.filter((r) => r !== ref);

    const used = new Set();
    const fusedLines = [];
    let agreeCount = 0;

    for (const rl of ref.lines) {
      const candidates = [rl];
      for (const o of others) {
        let best = null; let bestOv = 0;
        for (let i = 0; i < o.lines.length; i++) {
          const ol = o.lines[i];
          const key = `${o.variantId}:${i}`;
          if (used.has(key)) continue;
          const ov = vOverlap(rl.bbox, ol.bbox) * hOverlap(rl.bbox, ol.bbox);
          if (ov > bestOv && ov > 0.25) { bestOv = ov; best = { ol, key }; }
        }
        if (best) { used.add(best.key); candidates.push(best.ol); }
      }

      const ranked = candidates.map((c) => ({ c, s: lineScore(c) })).sort((a, b) => b.s - a.s);
      let chosen = ranked[0].c;
      if (candidates.length > 1 && ranked[0].c.text === ranked[1]?.c.text) agreeCount++;

      // Word-level vote refines the winning line when enough variants agree
      // on its geometry — this is where "rn"→"m" style errors get repaired.
      if (candidates.length >= 3) {
        const aligned = [chosen, ...candidates.filter((c) => c !== chosen)];
        const words = roverWords(aligned);
        const text = words.map((w) => w.text).join(' ');
        const cand = { ...chosen, words, text, conf: words.reduce((s, w) => s + w.conf, 0) / Math.max(1, words.length) };
        if (lineScore(cand) >= lineScore(chosen) - 1e-6) chosen = cand;
      }
      fusedLines.push({ ...chosen, candidates: candidates.length, sources: candidates.length });
    }

    // Recover lines that only non-reference variants found (dropped faint text).
    const normText = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const seenText = new Set(fusedLines.map((l) => normText(l.text)));
    for (const o of others) {
      for (let i = 0; i < o.lines.length; i++) {
        if (used.has(`${o.variantId}:${i}`)) continue;
        const ol = o.lines[i];
        const clashes = fusedLines.some((fl) => vOverlap(fl.bbox, ol.bbox) > 0.4 && hOverlap(fl.bbox, ol.bbox) > 0.3);
        if (clashes) continue;
        // Variants often disagree about where a line ends — one reads a whole
        // line, another splits it in two. The leftover halves must not be
        // re-added, or the output repeats fragments of text it already has.
        const key = normText(ol.text);
        if (key.length > 8 && seenText.has(key)) continue;
        if (key.length > 10 && [...seenText].some((prev) => prev.length > key.length && prev.includes(key))) continue;
        seenText.add(key);
        if (lineScore(ol) > 0.62 && ol.text.trim().length > 1) {
          fusedLines.push({ ...ol, recovered: true, candidates: 1, sources: 1 });
        }
      }
    }

    fusedLines.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
    const allWords = fusedLines.flatMap((l) => l.words);
    return {
      lines: fusedLines,
      text: fusedLines.map((l) => l.text).join('\n'),
      confidence: allWords.length ? allWords.reduce((s, w) => s + w.conf, 0) / allWords.length : 0,
      agreement: ref.lines.length ? agreeCount / ref.lines.length : 0,
      sources: norm.map((r) => r.variantId),
      reference: ref.variantId,
    };
  }

  /**
   * Reject hallucinated lines.
   *
   * On a speckled or stained page the recogniser will confidently emit text
   * where there is none — "le Lar SE Sn il A a BR" and similar. Such lines are
   * simultaneously low confidence, non-lexical and structurally implausible;
   * genuine faint text fails at most one of those tests. Requiring two
   * independent failures keeps real text while removing the invented kind.
   *
   * @returns { lines, rejected }
   */
  function filterGarbage(lines, opts = {}) {
    const keep = [];
    const rejected = [];
    const minScore = opts.minScore ?? 0.40;
    for (const l of lines) {
      const text = l.text.trim();
      const lex = lexScore(text);
      const str = structureScore(text);
      const score = lineScore(l);
      const letters = (text.match(/\p{L}/gu) || []).length;

      const alphaRatio = text.length ? letters / text.length : 0;
      const bars = (text.match(/[|Il\\/_—–-]/g) || []).length / Math.max(1, text.length);
      const strict = strictLexScore(text);
      const numeric = isNumericLine(text);
      const tokens = text.split(/\s+/).filter(Boolean);
      const singleCharRatio = tokens.length
        ? tokens.filter((t) => t.replace(/[^\p{L}\p{N}]/gu, '').length <= 1).length / tokens.length
        : 1;
      const dictWords = tokens.filter(isRealWord).length;

      let bad = false;
      if (!text) bad = true;
      else if (score < minScore && lex < 0.5) bad = true;
      else if (l.conf < 45 && lex < 0.34) bad = true;
      else if (l.words.length >= 3 && lex < 0.25 && l.conf < 60) bad = true;
      else if (str < 0.35 && l.conf < 70) bad = true;
      // A "line" of stray marks is never text, however long it is. Scratches,
      // fold lines and table rules read as runs of | I l / _ — with no words.
      else if (letters === 0) bad = true;
      else if (bars > 0.45 && lex < 0.4) bad = true;
      else if (alphaRatio < 0.4 && lex < 0.25 && !/\d{2,}/.test(text)) bad = true;
      // Prose that contains almost no real words is not prose. Numeric lines
      // (amounts, references, dates) are exempt — they are legitimately absent
      // from any lexicon and must survive on invoices and forms.
      else if (!numeric && strict < 0.12) bad = true;
      else if (!numeric && strict < 0.34 && l.conf < 72) bad = true;
      else if (!numeric && strict < 0.5 && l.conf < 50) bad = true;
      // Ratios are not enough on their own: one real word among a dozen
      // fragments ("ty Es Es LESS] | | | |") scores perfectly on every ratio
      // while being obvious noise. These count actual language instead.
      else if (!numeric && tokens.length >= 5 && dictWords < 2) bad = true;
      else if (!numeric && tokens.length >= 4 && singleCharRatio > 0.4) bad = true;
      else if (!numeric && alphaRatio < 0.42) bad = true;

      if (bad) rejected.push({ text, conf: l.conf, score: +score.toFixed(3), lex: +lex.toFixed(2), strict: +strict.toFixed(2), bbox: l.bbox });
      else keep.push(l);
    }
    return { lines: keep, rejected };
  }

  scope.Ensemble = { fuse, lineScore, lexScore, strictLexScore, isRealWord, structureScore, isNumericLine, toCanonical, vOverlap, hOverlap, filterGarbage };
})(self);
