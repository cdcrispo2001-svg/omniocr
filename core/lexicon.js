'use strict';
/* OmniOCR — lexicon service.
 *
 * Used for (a) scoring how language-like a candidate line is during fusion and
 * (b) gating post-OCR corrections. Corrections are only ever applied when the
 * original is NOT a word and the correction IS — the engine never "improves"
 * text it already read correctly.
 */
(function (scope) {
  const state = {
    words: new Set(),
    rank: new Map(),      // word → frequency rank (0 = most common)
    loaded: false,
  };

  async function load(base) {
    if (state.loaded) return state;
    const [wRes, fRes] = await Promise.all([
      fetch(`${base}/en-words.txt`),
      fetch(`${base}/en-freq.txt`),
    ]);
    const wordsTxt = await wRes.text();
    for (const w of wordsTxt.split('\n')) if (w) state.words.add(w);
    const freqTxt = await fRes.text();
    const freq = freqTxt.split('\n');
    for (let i = 0; i < freq.length; i++) if (freq[i]) state.rank.set(freq[i], i);
    state.loaded = true;
    return state;
  }

  const has = (w) => state.words.has(w) || state.rank.has(w);
  const rank = (w) => (state.rank.has(w) ? state.rank.get(w) : Infinity);
  const isCommon = (w, within = 20000) => rank(w) < within;

  /** Cheap plausibility test for words outside the lexicon (names, codes). */
  function looksWordLike(w) {
    if (!w || w.length < 2) return false;
    if (!/^\p{L}+$/u.test(w)) return false;
    const vowels = (w.match(/[aeiouy]/gi) || []).length;
    if (!vowels) return false;
    if (/[bcdfghjklmnpqrstvwxz]{5,}/i.test(w)) return false;   // impossible cluster
    if (vowels / w.length > 0.85) return false;
    return true;
  }

  /* ---------------- OCR confusion model ---------------- */

  // Character groups Tesseract genuinely confuses on degraded print.
  const CONFUSIONS = [
    ['rn', 'm'], ['m', 'rn'], ['cl', 'd'], ['d', 'cl'], ['vv', 'w'], ['w', 'vv'],
    ['ii', 'u'], ['nn', 'nn'], ['li', 'h'], ['fi', 'fi'],
    ['0', 'o'], ['o', '0'], ['O', '0'], ['0', 'O'], ['1', 'l'], ['l', '1'], ['l', 'i'], ['i', 'l'],
    ['5', 's'], ['s', '5'], ['8', 'B'], ['B', '8'], ['6', 'b'], ['b', '6'], ['9', 'g'], ['g', '9'],
    ['2', 'z'], ['z', '2'], ['t', 'f'], ['f', 't'], ['c', 'e'], ['e', 'c'], ['a', 'o'], ['o', 'a'],
    ['u', 'n'], ['n', 'u'], ['h', 'b'], ['b', 'h'], ['ri', 'n'], ['n', 'ri'], ['I', 'l'], ['l', 'I'],
  ];

  /**
   * Generate single-confusion repairs of a token.
   * Deliberately conservative: one substitution at a time, no free-form edits.
   */
  function* confusionCandidates(token) {
    for (const [from, to] of CONFUSIONS) {
      let idx = token.indexOf(from);
      while (idx !== -1) {
        yield token.slice(0, idx) + to + token.slice(idx + from.length);
        idx = token.indexOf(from, idx + 1);
      }
    }
  }

  /**
   * Best in-lexicon repair for a non-word token, or null.
   * @param token   raw token (case preserved by the caller)
   * @param maxRank only accept corrections at least this common
   */
  function correct(token, maxRank = 40000) {
    const lower = token.toLowerCase();
    if (has(lower)) return null;                       // already a word — leave alone
    let best = null; let bestRank = Infinity;
    for (const cand of confusionCandidates(lower)) {
      if (cand === lower || !has(cand)) continue;
      const r = rank(cand);
      if (r < bestRank) { bestRank = r; best = cand; }
    }
    if (!best) return null;
    if (bestRank > maxRank && !state.words.has(best)) return null;
    return best;
  }

  /**
   * Split a run-together token ("ofthe" → "of the") when both halves are common.
   * Only fires for tokens that are not themselves words.
   */
  function split(token) {
    const lower = token.toLowerCase();
    if (lower.length < 5 || lower.length > 24 || has(lower)) return null;
    if (!/^\p{L}+$/u.test(lower)) return null;
    for (let i = 2; i <= lower.length - 2; i++) {
      const a = lower.slice(0, i); const b = lower.slice(i);
      if (isCommon(a, 12000) && isCommon(b, 12000)) return [a, b];
    }
    return null;
  }

  scope.Lexicon = { load, has, rank, isCommon, looksWordLike, correct, split, confusionCandidates, state };
})(self);
