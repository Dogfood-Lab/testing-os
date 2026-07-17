/**
 * export.js — Canonical export from the swarm control plane.
 *
 * Builds review-worthy truth from the DB. Does not export raw agent chatter,
 * transient events, or intermediate state. Only canonical, provenance-attached artifacts.
 *
 * Export units:
 *   - Run summary
 *   - Wave receipts (with findings + verification + advancement)
 *   - Finding set (deduplicated, with lifecycle)
 *   - Verification outcomes
 *   - Promotion trail
 *   - Final handoff state
 */

import { openDb } from '../../db/connection.js';
import { createHash } from 'node:crypto';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../queries/latest-agent-runs.js';
import { SCHEMA_VERSION } from '../../db/schema.js';
import { isOpenFinding } from '../finding-status.js';

/**
 * D3B-014 (Phase 10 Step 1): version of the canonical export ENVELOPE
 * itself — the JSON shape `{ export_version, exported_at, provenance,
 * run, domains, waves, findings, verification, promotions }`. Distinct
 * from `SCHEMA_VERSION` (which is the DB SQL-schema version, sourced
 * from db/schema.js). Bump this when the export envelope's shape
 * changes in a way consumers care about.
 *
 * Lives here (not in db/schema.js) because the envelope and the DB
 * schema are independent contracts — the DB might bump for a column
 * add without affecting any exported field, and vice versa. One
 * constant per concept, each owned by its consumer.
 */
export const EXPORT_VERSION = '1.0.0';

/**
 * Build a canonical run export from DB truth.
 *
 * @param {Database} db
 * @param {string} runId
 * @returns {object} — canonical export
 */
export function buildRunExport(db, runId) {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const waves = db.prepare('SELECT * FROM waves WHERE run_id = ? ORDER BY wave_number').all(runId);
  const domains = db.prepare('SELECT * FROM domains WHERE run_id = ? ORDER BY name').all(runId);
  const findings = db.prepare('SELECT * FROM findings WHERE run_id = ? ORDER BY severity, finding_id').all(runId);
  const promotions = db.prepare('SELECT * FROM promotions WHERE run_id = ? ORDER BY created_at').all(runId);

  // Build wave summaries
  const waveSummaries = waves.map(w => {
    // F-H8 (Wave A1 D3): wave-9 latest-per-(wave, domain) filter via the
    // shared helper. The bug shape: after `swarm resume` redispatches a
    // failed agent, the original failed row remains in agent_runs. Iterating
    // all rows surfaced the stale failed row to the audit-DB ground truth,
    // flipping the dogfood-bridge `every(complete)` check to non-pass for
    // recovered waves. See lib/queries/latest-agent-runs.js header.
    const agents = db.prepare(`
      SELECT ar.*, d.name as domain_name
      FROM agent_runs ar JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ?
        ${LATEST_AGENT_RUN_PER_DOMAIN}
    `).all(w.id);

    // Latest receipt per wave — id DESC tiebreak (V2-INVARIAN-005, the fourth
    // F-b9a8f684 site): created_at has second granularity, so a fail-then-pass
    // verify sequence inside one second tied and could surface the FAIL row to
    // the durable export while Gate 4 (lib/advance.js) read the pass.
    const verification = db.prepare(
      'SELECT * FROM verification_receipts WHERE wave_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
    ).get(w.id);

    // F-H8-sibling (advisor-surfaced, Wave A1 D3): the violations subquery
    // is the OTHER read site in export.js that lacked the wave-9 filter. A
    // violation recorded against a stale failed agent_run row would surface
    // here even after a clean redispatch. Apply the same filter so the
    // audit-DB export shows only the surviving agent_run's violations.
    const violations = db.prepare(`
      SELECT fc.file_path, d.name as domain_name
      FROM file_claims fc
      JOIN agent_runs ar ON fc.agent_run_id = ar.id
      JOIN domains d ON ar.domain_id = d.id
      WHERE fc.violation = 1 AND ar.wave_id = ?
        ${LATEST_AGENT_RUN_PER_DOMAIN}
    `).all(w.id);

    return {
      number: w.wave_number,
      phase: w.phase,
      status: w.status,
      domain_snapshot_id: w.domain_snapshot_id,
      agents: agents.map(a => ({
        domain: a.domain_name,
        status: a.status,
        worktree: a.worktree_branch || null,
      })),
      verification: verification ? {
        passed: !!verification.passed,
        adapter: verification.repo_type,
        test_count: verification.test_count,
        exit_code: verification.exit_code,
      } : null,
      violations: violations.map(v => ({ file: v.file_path, domain: v.domain_name })),
      created: w.created_at,
      completed: w.completed_at,
    };
  });

  // Finding set
  const findingSet = findings.map(f => ({
    id: f.finding_id,
    fingerprint: f.fingerprint,
    severity: f.severity,
    category: f.category,
    file: f.file_path,
    line: f.line_number,
    symbol: f.symbol,
    description: f.description,
    recommendation: f.recommendation,
    status: f.status,
    first_seen_wave: f.first_seen_wave,
    last_seen_wave: f.last_seen_wave,
  }));

  // Finding summary
  const findingSummary = {
    total: findings.length,
    by_severity: {},
    by_status: {},
  };
  for (const f of findings) {
    findingSummary.by_severity[f.severity] = (findingSummary.by_severity[f.severity] || 0) + 1;
    findingSummary.by_status[f.status] = (findingSummary.by_status[f.status] || 0) + 1;
  }

  // Promotion trail
  const promotionTrail = promotions.map(p => ({
    from: p.from_phase,
    to: p.to_phase,
    authorized_by: p.authorized_by,
    gates: JSON.parse(p.gates_checked),
    overrides: p.overrides ? JSON.parse(p.overrides) : null,
    finding_snapshot: p.finding_snapshot ? JSON.parse(p.finding_snapshot) : null,
    at: p.created_at,
  }));

  // Compute content hash for provenance.
  //
  // D3B-014 (Phase 10 Step 1): `export_version` sources from the local
  // EXPORT_VERSION constant (envelope shape); `provenance.schema_version`
  // sources from db/schema.js SCHEMA_VERSION (DB SQL schema). Pre-fix
  // both were hardcoded literals — the schema_version had drifted to a
  // stale `3` while SCHEMA_VERSION had bumped to 5, with no compile-time
  // signal. Each constant is now imported at the module's top so a
  // future bump propagates without an editor sweep.
  const exportPayload = {
    export_version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    provenance: {
      system: 'swarm-control-plane',
      schema_version: SCHEMA_VERSION,
      run_id: runId,
    },
    run: {
      id: run.id,
      repo: run.repo,
      branch: run.branch,
      commit_sha: run.commit_sha,
      status: run.status,
      save_point_tag: run.save_point_tag,
      created: run.created_at,
      completed: run.completed_at,
    },
    domains: domains.map(d => ({
      name: d.name,
      ownership_class: d.ownership_class,
      description: d.description,
    })),
    waves: waveSummaries,
    findings: {
      summary: findingSummary,
      items: findingSet,
    },
    verification: waveSummaries
      .filter(w => w.verification)
      .map(w => ({ wave: w.number, phase: w.phase, ...w.verification })),
    promotions: promotionTrail,
  };

  // Content hash for integrity
  const hash = createHash('sha256')
    .update(JSON.stringify(exportPayload))
    .digest('hex')
    .slice(0, 16);
  exportPayload.provenance.content_hash = hash;

  return exportPayload;
}

/**
 * Compute the overall verdict for a run export.
 * Used by downstream systems to determine pass/fail/partial.
 */
export function computeRunVerdict(exportData) {
  // F-b721038e: `complete` used to short-circuit HERE, before the
  // open-findings count below ever ran — so 'complete' (the run's normal
  // SUCCESS terminal state, not an edge case) always returned 'pass'
  // regardless of what findings were still open. A run that picked up an
  // open CRITICAL and was forced past the (overridable) finding_severity
  // gate via a documented `swarm advance --override` carried that open
  // finding all the way to 'complete' with zero further check, and this
  // function erased it entirely from the published verdict — while the
  // sibling repoknowledge-bridge#buildAuditPayload, built from the SAME
  // exportData in the SAME `swarm persist` call, has never special-cased
  // run.status: it derives overallStatus purely from isOpenFinding() and
  // correctly reported 'fail'/blocking_release:true for the identical
  // finding state. Two artifacts, one call, opposite verdicts.
  //
  // The fix: 'complete' no longer skips the check. It now falls through to
  // the same open-findings count every other non-aborted status already
  // used, so 'complete' means 'pass' only when it is actually earned.
  // 'aborted' keeps its unconditional 'fail' below.
  //
  // F-6859e492: this paragraph used to end "...the safe/conservative
  // direction, unlike 'complete', so it is not subject to the same fix" —
  // true of THIS function in isolation, but that framing missed that the
  // cross-artifact-agreement test above ("two artifacts, one call, opposite
  // verdicts") applies to every run.status value, not only 'complete'.
  // buildAuditPayload never special-cased run.status either way, so for
  // 'aborted' it fell straight through to the SAME open-findings computation
  // 'complete' used pre-fix — reporting overall_status:'pass'/
  // blocking_release:false whenever an aborted run happened to have zero
  // open findings (or all findings closed), while this function kept
  // returning 'fail' unconditionally. The fix mirrors THIS branch's
  // conservative semantics into buildAuditPayload
  // (lib/persist/repoknowledge-bridge.js) rather than loosening it here: an
  // aborted run is never a safe 'pass' in either artifact, because the run
  // itself never reached a point where "no open findings" means "nothing
  // left to find." See export-verdict-aborted-sibling-agreement.test.js for
  // the 4-state × both-artifacts pin (this file's own agreement test above
  // only covers 'complete').
  if (exportData.run.status === 'aborted') return 'fail';

  // F-5c562913: the verdict counts OPEN findings only. Pre-fix, hasCritical
  // counted by_severity regardless of status — a CRITICAL that was already
  // FIXED (or rejected/deferred) still forced 'fail' into the durable dogfood
  // corpus — and the variable named openCritical actually counted
  // new+recurring across ALL severities, so one open LOW returned 'partial'.
  // Open/closed semantics come from lib/finding-status.js (the same source
  // the advancement gate uses).
  const openItems = (exportData.findings.items || []).filter(f => isOpenFinding(f.status));
  const openCritical = openItems.filter(f => f.severity === 'CRITICAL').length;

  if (openCritical > 0) return 'fail';
  if (openItems.length > 0) return 'partial';
  return 'pass';
}
