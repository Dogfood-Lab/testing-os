/**
 * attention.js — T2 composed attention score (F-e7c4c16d,
 * docs/trajectory-and-closure.dispatch.md):
 *
 *   per-file attention score = churn (relative, git-derived)
 *                             × prior-finding recency/count (DB-derived)
 *                             × lane-fragmentation (DB-derived)
 *
 * A SIMPLE, TRANSPARENT, ADVISORY heuristic per T2's own text — emitted as a
 * ranked top-K list, consumed only as audit-brief context. NEVER a gate,
 * NEVER a predictor, NEVER auto-blame (Q3: Google's deployed predictor
 * changed no developer behavior; SZZ-style blame misattributes against
 * developer oracles). Composes three raw signals this domain already built
 * as separate, independently-testable, pure functions
 * (lib/git-touched-files.js#getChurnStats, lib/queries/cross-run-analytics
 * .js#queryFindingRecencyByFile / #queryLaneFragmentation) rather than
 * re-deriving any of them here.
 *
 * NORMALIZATION. Each raw factor is divided by its OWN max across the
 * candidate file set before multiplying, so no dimension dominates purely
 * because of its raw numeric scale (a relative_churn of 3.2 and a
 * domain_count of 2 are not directly comparable magnitudes). A file at the
 * max for a factor scores 1.0 on it; a file entirely ABSENT from a signal
 * source scores 0 on it.
 *
 * WHY A PRODUCT, NOT A SUM (and why that is a deliberate T2 property, not
 * this module's invention): T2's own formula is literally "×". A file
 * missing ANY ONE of the three signals therefore scores exactly 0 overall —
 * a file nobody has ever filed a finding against, however hot its churn, has
 * not yet earned attention by this heuristic's own stated formula. This is
 * acceptable specifically BECAUSE the score is advisory-only, never a gate —
 * see T2's own text and the dispatch's "what we refuse to build" section.
 *
 * RECENCY/COUNT COMPOSITION. T2 names ONE factor, "prior-finding
 * recency/count" — not two separate multiplicands. This module combines
 * them as (finding_count / maxFindingCount) × (most_recent_wave /
 * maxWaveNumber), so a file with MORE findings that were ALSO seen MORE
 * recently outranks one with many findings all from early, possibly-stale
 * waves.
 */

import { getChurnStats } from '../git-touched-files.js';
import { queryLaneFragmentation, queryFindingRecencyByFile } from '../queries/cross-run-analytics.js';

/** T2 does not pin a specific K; 20 is a deliberately small, legible default. */
export const DEFAULT_TOP_K = 20;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} [opts]
 * @param {string} [opts.repoPath] — absolute path to the repo for the git
 *   churn probe. Omitted/unreadable → churn_available: false, every score 0
 *   (degraded, not a throw — mirrors getChurnStats' own never-throws contract).
 * @param {number} [opts.sinceDays] — forwarded to getChurnStats
 * @param {number} [opts.topK=DEFAULT_TOP_K]
 * @returns {{
 *   advisory: true,
 *   churn_available: boolean,
 *   top: Array<{ file: string, attention_score: number, factors: {
 *     relative_churn: number, finding_count: number, most_recent_wave: number, domain_count: number
 *   } }>,
 *   truncated: boolean,
 *   total_candidates: number,
 * }}
 */
export function computeAttentionScores(db, runId, opts = {}) {
  const { repoPath, sinceDays, topK = DEFAULT_TOP_K } = opts;

  const churn = repoPath ? getChurnStats(repoPath, { sinceDays }) : { available: false, files: [] };
  const recency = queryFindingRecencyByFile(db, runId);
  const fragmentation = queryLaneFragmentation(db, runId);

  const churnByFile = new Map(churn.files.map((f) => [f.file, f.relative_churn]));
  const recencyByFile = new Map(recency.map((r) => [r.file_path, r]));
  const fragByFile = new Map(fragmentation.map((f) => [f.file_path, f.domain_count]));

  const allFiles = new Set([...churnByFile.keys(), ...recencyByFile.keys(), ...fragByFile.keys()]);

  const maxChurn = Math.max(0, ...churnByFile.values());
  const maxFindingCount = Math.max(0, ...[...recencyByFile.values()].map((r) => r.finding_count));
  const maxWave = Math.max(0, ...[...recencyByFile.values()].map((r) => r.most_recent_wave || 0));
  const maxDomainCount = Math.max(0, ...fragByFile.values());

  const rows = [];
  for (const file of allFiles) {
    const relativeChurn = churnByFile.get(file) ?? 0;
    const rec = recencyByFile.get(file);
    const findingCount = rec ? rec.finding_count : 0;
    const mostRecentWave = rec ? (rec.most_recent_wave || 0) : 0;
    const domainCount = fragByFile.get(file) ?? 0;

    const churnFactor = maxChurn > 0 ? relativeChurn / maxChurn : 0;
    const countFactor = maxFindingCount > 0 ? findingCount / maxFindingCount : 0;
    const recencyFactor = maxWave > 0 ? mostRecentWave / maxWave : 0;
    const domainFactor = maxDomainCount > 0 ? domainCount / maxDomainCount : 0;

    const attention_score = churnFactor * (countFactor * recencyFactor) * domainFactor;

    rows.push({
      file,
      attention_score,
      factors: {
        relative_churn: relativeChurn,
        finding_count: findingCount,
        most_recent_wave: mostRecentWave,
        domain_count: domainCount,
      },
    });
  }

  // Deterministic tiebreak (file ASC) — T1's "same DB state -> byte-identical
  // artifact" requirement extends to this composed ranking, not only to the
  // raw SQL queries it is built from.
  rows.sort((a, b) => b.attention_score - a.attention_score || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    advisory: true,
    churn_available: churn.available,
    top: rows.slice(0, topK),
    truncated: rows.length > topK,
    total_candidates: rows.length,
  };
}
