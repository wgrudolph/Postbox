// Weighted character counter, approximating X's rules.
// Shared by the browser composer and the Worker's server-side validation.

const URL_RE = /https?:\/\/\S+/gu;
const URL_PLACEHOLDER = "x".repeat(23); // X counts every link as 23
const EMOJI_RE = /\p{Extended_Pictographic}/u;

const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** @param {number} cp */
function codePointWeight(cp) {
  if (
    (cp >= 0x0000 && cp <= 0x10ff) ||
    (cp >= 0x2000 && cp <= 0x200d) ||
    (cp >= 0x2010 && cp <= 0x201f) ||
    (cp >= 0x2032 && cp <= 0x2037)
  ) {
    return 1;
  }
  return 2;
}

/**
 * @param {string} text
 * @returns {number}
 */
export function weightedLength(text) {
  const s = String(text ?? "").replace(URL_RE, URL_PLACEHOLDER);
  const graphemes = segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s);
  let total = 0;
  for (const g of graphemes) {
    if (EMOJI_RE.test(g)) {
      total += 2;
      continue;
    }
    for (const ch of g) total += codePointWeight(/** @type {number} */ (ch.codePointAt(0)));
  }
  return total;
}
