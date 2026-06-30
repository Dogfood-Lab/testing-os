/**
 * @dogfood-labs/findings
 *
 * Finding contract spine for dogfood-labs.
 * The fourth contract alongside record, scenario, and policy.
 *
 * Exports: validation, reading, listing, filtering, duplicate detection.
 */

export { parseFinding, validateFinding, validateFindingFile } from './validate.js';
export { discoverFindings, discoverFixtures, loadFindings, findById, filterFindings, findDuplicates, matchesText } from './reader.js';
