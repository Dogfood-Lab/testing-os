/**
 * pluralize.js — shared count-noun agreement for swarm CLI/commands text
 * renderers.
 *
 * F-e164337b (wave 35): "${count} noun" rendered unconditionally plural at
 * 22 call sites across cli.js and commands/{collect,receipt,redrive,resume,
 * rewind,status}.js (cli.js:2460's `${waveCnt.cnt} waves, ${findCnt.cnt}
 * findings` was the named finding; a sibling sweep of every `${var} noun`
 * shape in these two locations found 21 more of the same class). A lone
 * dispatched agent, a wave with exactly one finding, a single-test verify
 * run, a domain matching exactly one file, etc. all printed the plural form
 * regardless of the actual count. This package's own established convention
 * for the same shape is the `noun(s)` suffix (60+ existing call sites) or an
 * inline `n === 1 ? 'x' : 'y'` ternary (history.js, status.js); this helper
 * makes that convention reusable instead of re-derived by hand at a 23rd
 * site.
 */

/**
 * Choose the singular or plural noun form for a count, with no count text.
 * Split out from `pluralize` for the rare call site that renders the count
 * separately from its noun (e.g. an "X/Y noun" ratio, where the noun must
 * agree with Y, not X).
 *
 * @param {number} n - the count
 * @param {string} singular - singular noun form (e.g. 'wave')
 * @param {string} [plural] - plural form; defaults to `${singular}s`
 * @returns {string} the chosen noun form only, e.g. pluralizeWord(1, 'wave') -> 'wave'
 */
export function pluralizeWord(n, singular, plural = `${singular}s`) {
  return n === 1 ? singular : plural;
}

/**
 * Render a count with its noun in singular/plural agreement.
 *
 * @param {number} n - the count
 * @param {string} singular - singular noun form (e.g. 'wave')
 * @param {string} [plural] - plural form; defaults to `${singular}s`
 * @returns {string} e.g. pluralize(1, 'wave') -> '1 wave'; pluralize(2, 'wave') -> '2 waves'
 */
export function pluralize(n, singular, plural) {
  return `${n} ${pluralizeWord(n, singular, plural)}`;
}
