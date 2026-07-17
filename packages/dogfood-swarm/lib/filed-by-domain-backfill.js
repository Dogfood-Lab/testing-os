/**
 * filed-by-domain-backfill.js — F-e71f9e7a: a one-time, lawful, evidence-
 * bearing backfill for `findings.filed_by_domain` rows that were stranded
 * NULL before this repo's collect-time `_declaringDomain` attribution
 * existed (or before a caller threaded it through), and that are now
 * blocking LIVE, present-tense work — most concretely, the 40 findings this
 * run approved at wave 38 (first_seen_wave predates the attribution fix),
 * which findingsForDomain's filed_by_domain fallback can never route to any
 * domain, and which therefore can never lawfully close.
 *
 * WHY A SEPARATE MODULE, NOT MORE fingerprint.js: this is a one-time,
 * operator-triggered archival operation, not part of the per-wave
 * classify/upsert hot path fingerprint.js already owns — grouping by what
 * changes together (Parnas, DECOMPOSE_BY_SECRETS) keeps the two from
 * tangling.
 *
 * THE MAPPING IS THE LAW, NEVER INFERENCE (rider's own instruction: "never
 * silent inference"). This module does not guess a filer from wave_id,
 * agent_run_id, or any other correlated-but-unreliable signal — wave 38
 * dispatched SIX domains simultaneously, and finding_events.agent_run_id was
 * never populated for the 'reported' event type, so no such signal could be
 * trusted anyway (see F-e71f9e7a's own finding text for the full forensic
 * trail: the true filer is only reconstructable, if at all, from wave 38's
 * still-on-disk swarms/<run>/wave-38/<domain>/output.json files — grepping
 * those for a finding_id is how an operator BUILDS the mapping this module
 * consumes, not something this module does itself). Every mapping entry
 * REQUIRES its own `evidence` string — a caller with nothing to cite for a
 * given id should omit that id from the mapping, not invent a placeholder.
 *
 * DRY-RUN-FIRST (the redrive/revalidate idiom this package's other recovery
 * verbs use): `opts.apply` defaults to false. A dry-run call makes ZERO
 * writes and returns exactly the report an `--apply` call would have
 * produced, so an operator can review before committing.
 *
 * LAWFUL: never overwrites a filed_by_domain that is already set (matches
 * upsertFindings' COALESCE-based backfill's identical "first-filed fact,
 * never clobbered" contract — see fingerprint.js's F-e71f9e7a comment), and
 * only accepts a domain name that is LIVE in this run's current domain map
 * (never a typo'd or retired name silently persisted).
 */

import { logStage } from './log-stage.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {Record<string, { domain: string, evidence: string }>} mapping —
 *   operator-supplied finding_id -> { domain, evidence }. `evidence` is a
 *   short human-readable pointer to WHERE the attribution was reconstructed
 *   from (e.g. "swarms/<run>/wave-38/backend/output.json fixes[] lists this
 *   id"), carried into the applied report and the logStage event — never
 *   optional, per this module's own "never silent inference" contract.
 * @param {object} [opts]
 * @param {boolean} [opts.apply=false] — dry-run by default; set true to
 *   actually write.
 * @returns {{
 *   run_id: string,
 *   apply: boolean,
 *   applied: Array<{ finding_id: string, domain: string, evidence: string }>,
 *   skipped: Array<{ finding_id: string, reason: string }>,
 * }}
 */
export function backfillFiledByDomain(db, runId, mapping, opts = {}) {
  const { apply = false } = opts;

  const liveDomainNames = new Set(
    db.prepare(`SELECT name FROM domains WHERE run_id = ?`).all(runId).map((r) => r.name),
  );

  const applied = [];
  const skipped = [];

  for (const [findingId, entry] of Object.entries(mapping || {})) {
    const domain = entry && typeof entry.domain === 'string' ? entry.domain : null;
    const evidence = entry && typeof entry.evidence === 'string' && entry.evidence.length > 0 ? entry.evidence : null;

    if (!domain) {
      skipped.push({ finding_id: findingId, reason: 'mapping entry is missing a string domain — nothing applied without an explicit target' });
      continue;
    }
    if (!evidence) {
      skipped.push({ finding_id: findingId, reason: 'mapping entry is missing evidence — this module never applies an unsourced attribution' });
      continue;
    }
    if (!liveDomainNames.has(domain)) {
      skipped.push({ finding_id: findingId, reason: `${JSON.stringify(domain)} is not a live domain for run ${runId} — refusing to persist a name the current map does not recognize` });
      continue;
    }

    const row = db.prepare(`SELECT id, filed_by_domain FROM findings WHERE run_id = ? AND finding_id = ?`).get(runId, findingId);
    if (!row) {
      skipped.push({ finding_id: findingId, reason: 'no finding row exists for this id in this run' });
      continue;
    }
    if (row.filed_by_domain != null) {
      skipped.push({ finding_id: findingId, reason: `filed_by_domain is already ${JSON.stringify(row.filed_by_domain)} — a first-filed fact is never overwritten, even by a lawful backfill` });
      continue;
    }

    applied.push({ finding_id: findingId, domain, evidence });
  }

  if (apply && applied.length > 0) {
    const update = db.prepare(
      `UPDATE findings SET filed_by_domain = ? WHERE run_id = ? AND finding_id = ? AND filed_by_domain IS NULL`,
    );
    const tx = db.transaction(() => {
      for (const a of applied) {
        update.run(a.domain, runId, a.finding_id);
        logStage('filed_by_domain_backfilled', {
          component: 'dogfood-swarm',
          run_id: runId,
          finding_id: a.finding_id,
          domain: a.domain,
          evidence: a.evidence,
        });
      }
    });
    tx();
  }

  return { run_id: runId, apply, applied, skipped };
}
