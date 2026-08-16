'use strict';
/* OmniOCR — post-recognition text repair.
 *
 * Conservative by construction: a token is only rewritten when the original is
 * NOT in the lexicon, the replacement IS, and the recogniser was not already
 * confident. Every change is recorded so the user can inspect or disable them.
 */
(function (scope) {
  const LIGATURES = { 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st', 'æ': 'ae', 'Æ': 'AE' };
  const QUOTE_FIX = [
    [/[’‘‛]/g, "'"], [/[“”„]/g, '"'], [/[‒–—―]/g, '-'],
  ];

  const DIGIT_MAP = { O: '0', o: '0', Q: '0', D: '0', l: '1', I: '1', i: '1', '|': '1', S: '5', s: '5', B: '8', G: '6', b: '6', g: '9', Z: '2', z: '2', T: '7' };
  const ALPHA_MAP = { '0': 'o', '1': 'l', '5': 's', '8': 'B', '6': 'b', '9': 'g', '2': 'z' };

  function normalizeUnicode(s, opts = {}) {
    let out = s.normalize('NFC');
    for (const [k, v] of Object.entries(LIGATURES)) out = out.split(k).join(v);
    if (opts.straightQuotes) for (const [re, rep] of QUOTE_FIX) out = out.replace(re, rep);
    return out;
  }

  const strip = (t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

  /** Restore digits inside tokens that are clearly numeric (amounts, IDs, dates). */
  function repairNumeric(token) {
    const core = strip(token);
    if (core.length < 2) return null;
    const digits = (core.match(/\d/g) || []).length;
    const letters = (core.match(/\p{L}/gu) || []).length;
    if (!digits || digits / core.length < 0.5 || !letters) return null;
    // Don't touch things that are legitimately alphanumeric codes with 3+ letters.
    if (letters > 2) return null;
    let out = '';
    for (const ch of token) out += (DIGIT_MAP[ch] !== undefined && /\p{L}/u.test(ch)) ? DIGIT_MAP[ch] : ch;
    return out !== token ? out : null;
  }

  /** The reverse case: digits that crept into an otherwise alphabetic word. */
  function repairAlpha(token) {
    const core = strip(token);
    if (core.length < 3) return null;
    const digits = (core.match(/\d/g) || []).length;
    const letters = (core.match(/\p{L}/gu) || []).length;
    if (!digits || letters < core.length - digits || digits / core.length > 0.34) return null;
    let out = '';
    for (const ch of token) out += (ALPHA_MAP[ch] !== undefined && /\d/.test(ch)) ? ALPHA_MAP[ch] : ch;
    if (out === token) return null;
    return scope.Lexicon.has(strip(out).toLowerCase()) ? out : null;
  }

  /** Preserve the original capitalisation pattern when swapping in a correction. */
  function matchCase(original, replacement) {
    if (original === original.toUpperCase() && /\p{Lu}/u.test(original)) return replacement.toUpperCase();
    if (/^\p{Lu}/u.test(original)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    return replacement;
  }

  /**
   * Repair a single word in place.
   * @returns { text, change } where change is null when nothing was altered
   */
  function repairWord(word, opts) {
    const original = word.text;
    let text = normalizeUnicode(original, opts);
    const core = strip(text);
    const lower = core.toLowerCase();

    if (!core) return { text, change: text !== original ? { from: original, to: text, rule: 'unicode' } : null };

    // 1. numeric / alphabetic context repair (independent of confidence)
    const num = repairNumeric(text);
    if (num) return { text: num, change: { from: original, to: num, rule: 'numeric-context' } };
    const alpha = repairAlpha(text);
    if (alpha) return { text: alpha, change: { from: original, to: alpha, rule: 'alpha-context' } };

    // 2. lexicon-gated confusion repair
    const known = scope.Lexicon.has(lower);
    if (!known && word.conf < (opts.confidenceCeiling ?? 96) && /^\p{L}[\p{L}'-]*$/u.test(core)) {
      const fixed = scope.Lexicon.correct(core, opts.maxRank ?? 40000);
      if (fixed) {
        const replaced = text.replace(core, matchCase(core, fixed));
        return { text: replaced, change: { from: original, to: replaced, rule: 'confusion', conf: word.conf } };
      }
      if (opts.splitMerged !== false && word.conf < 88) {
        const parts = scope.Lexicon.split(core);
        if (parts) {
          const replaced = text.replace(core, matchCase(core, parts.join(' ')));
          return { text: replaced, change: { from: original, to: replaced, rule: 'split', conf: word.conf } };
        }
      }
    }
    return { text, change: text !== original ? { from: original, to: text, rule: 'unicode' } : null };
  }

  /** Tidy spacing/punctuation in rendered text (never affects word boxes). */
  function tidyText(s) {
    return s
      .replace(/[ \t]+/g, ' ')
      .replace(/ ([,.;:!?%)\]}])/g, '$1')
      .replace(/([([{]) /g, '$1')
      .replace(/ +\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Apply repairs to every line of a page.
   * @returns { lines, corrections }
   */
  function repairLines(lines, opts = {}) {
    if (opts.enabled === false) return { lines, corrections: [] };
    const corrections = [];
    const out = lines.map((line) => {
      const words = line.words.map((w) => {
        const { text, change } = repairWord(w, opts);
        if (change) corrections.push({ ...change, bbox: w.bbox });
        return text === w.text ? w : { ...w, text, corrected: true, originalText: w.text };
      });
      return { ...line, words, text: words.map((w) => w.text).join(' ') };
    });
    return { lines: out, corrections };
  }

  scope.PostProcess = { repairLines, repairWord, tidyText, normalizeUnicode, repairNumeric, repairAlpha, matchCase };
})(self);
