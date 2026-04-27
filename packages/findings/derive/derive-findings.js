/**
 * Main derivation engine.
 * Takes verified dogfood records and deterministically emits candidate findings.
 *
 * Usage:
 *   deriveFromRecord(record, { rejected }) → CandidateFinding[]
 *   deriveFromRecords(records) → { candidates, stats }
 */

import { RULES } from './rules.js';
import { generateFindingId } from './ids.js';
import { dedupeWithinBatch } from './dedupe.js';

/**
 * Derive candidate findings from a single verified record.
 *
 * Returns a plain array of candidates for back-compat. To get per-rule errors,
 * use `deriveFromRecordWithErrors` which returns `{ candidates, ruleErrors }`.
 *
 * @param {object} record - Full persisted dogfood record.
 * @param {{ rejected?: boolean }} opts
 * @returns {Array} - Zero or more schema-valid candidate finding objects.
 */
export function deriveFromRecord(record, opts = {}) {
  return deriveFromRecordWithErrors(record, opts).candidates;
}

/**
 * Derive candidate findings from a single verified record, exposing per-rule errors.
 *
 * Each rule's `applies` and `derive` runs in isolation. A rule that throws does
 * NOT crash the engine, but the error IS recorded in `ruleErrors` and ALSO
 * logged to stderr so operators see it in CI logs. Callers MUST treat a non-empty
 * ruleErrors as a partial failure — the engine "succeeded" only if `ruleErrors`
 * is empty.
 *
 * @param {object} record
 * @param {{ rejected?: boolean }} opts
 * @returns {{ candidates: Array, ruleErrors: Array<{ ruleId: string, runId: string, message: string }> }}
 */
export function deriveFromRecordWithErrors(record, opts = {}) {
  const rejected = opts.rejected ?? false;
  const repo = record.repo || '';
  const repoSlug = repo.split('/').pop() || 'unknown';
  const runId = record.run_id || 'unknown';
  const now = new Date().toISOString();

  const raw = [];
  const ruleErrors = [];

  // Iterate per-scenario so multi-scenario records emit findings tied to the
  // RIGHT scenario — not just scenario_results[0]. The scenario-aware helpers
  // in rules.js (scenarioSurface, scenarioMode, scenarioId, failedSteps,
  // scenarioVerdict) all read index 0; instead of touching every rule, we
  // present each rule a per-scenario VIEW of the record where scenario_results
  // contains only that one scenario. The finding's execution_mode and
  // scenario_ids in assembleFinding then come from the right scenario.
  //
  // Backward compat: a single-scenario record runs one iteration with the
  // same scenario at index 0 → byte-identical output to the old code path.
  // Rules that already iterated all scenarios internally (rule-blocked-scenario,
  // rule-execution-mode-gap) emit per-iteration findings; dedupeWithinBatch
  // collapses any duplicates by dedupe key.
  const scenarios = Array.isArray(record.scenario_results) && record.scenario_results.length > 0
    ? record.scenario_results
    : [null];

  for (const scenario of scenarios) {
    const scenarioView = scenario === null
      ? record
      : { ...record, scenario_results: [scenario] };
    const ctx = { record: scenarioView, rejected, repoSlug };

    for (const rule of RULES) {
      try {
        if (rule.applies(ctx)) {
          const emitted = rule.derive(ctx);
          for (const e of emitted) {
            raw.push(assembleFinding(e, scenarioView, rule, repoSlug, now));
          }
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        const entry = { ruleId: rule.ruleId, runId, message };
        ruleErrors.push(entry);
        // Surface the failure on stderr so operators see it in CI logs.
        // Do NOT crash the engine — other rules still get a chance to run.
        console.error(
          `[derive] rule '${rule.ruleId}' threw on run_id=${runId}: ${message}`
        );
      }
    }
  }

  // Dedupe within this record's batch
  const { unique } = dedupeWithinBatch(raw);
  return { candidates: unique, ruleErrors };
}

/**
 * Derive candidate findings from multiple records.
 *
 * The returned `ruleErrors` collects every per-rule throw across every record.
 * `stats.ruleErrors` is the count for quick scoreboarding. Callers MUST treat a
 * non-zero ruleErrors count as a partial failure — derivation did NOT fully
 * succeed if any rule threw.
 *
 * @param {Array<{ record: object, rejected: boolean }>} entries
 * @returns {{ candidates: Array, ruleErrors: Array<{ ruleId: string, runId: string, message: string }>, stats: { recordsProcessed: number, rulesEvaluated: number, candidatesEmitted: number, deduped: number, ruleErrors: number } }}
 */
export function deriveFromRecords(entries) {
  const allCandidates = [];
  const allRuleErrors = [];
  let rulesEvaluated = 0;

  for (const entry of entries) {
    rulesEvaluated += RULES.length;
    const { candidates, ruleErrors } = deriveFromRecordWithErrors(
      entry.record,
      { rejected: entry.rejected }
    );
    allCandidates.push(...candidates);
    allRuleErrors.push(...ruleErrors);
  }

  const { unique, skipped } = dedupeWithinBatch(allCandidates);

  return {
    candidates: unique,
    ruleErrors: allRuleErrors,
    stats: {
      recordsProcessed: entries.length,
      rulesEvaluated,
      candidatesEmitted: unique.length,
      deduped: skipped,
      ruleErrors: allRuleErrors.length
    }
  };
}

/**
 * Assemble a full schema-valid finding object from rule output.
 */
function assembleFinding(raw, record, rule, repoSlug, now) {
  const findingId = generateFindingId(repoSlug, raw.slug);

  return {
    schema_version: '1.0.0',
    finding_id: findingId,
    title: raw.title,
    status: 'candidate',
    repo: record.repo,
    product_surface: raw.product_surface,
    execution_mode: record.scenario_results?.[0]?.execution_mode,
    journey_stage: raw.journey_stage,
    issue_kind: raw.issue_kind,
    root_cause_kind: raw.root_cause_kind,
    remediation_kind: raw.remediation_kind,
    transfer_scope: raw.transfer_scope,
    summary: raw.summary,
    source_record_ids: [record.run_id],
    scenario_ids: record.scenario_results
      ?.map(s => s.scenario_id)
      .filter(Boolean) || [],
    evidence: raw.evidence,
    derived: {
      method: 'deterministic_rule',
      rule_id: rule.ruleId,
      derived_at: now,
      rationale: raw.rationale
    },
    created_at: now,
    updated_at: now
  };
}

/**
 * Get the rule inventory (for explain/list).
 */
export function getRuleInventory() {
  return RULES.map(r => ({
    ruleId: r.ruleId,
    description: r.description
  }));
}

export { RULES };
