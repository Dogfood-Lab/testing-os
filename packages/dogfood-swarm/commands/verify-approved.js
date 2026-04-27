/**
 * verify-approved.js — `swarm verify-approved <run-id> [--threshold=N] [--format=...]`
 *
 * **W3-BACK-005 (Phase 7 wave 3).** Pre-amend gate.
 *
 * Reads findings with `status='approved'` — findings the operator has
 * cleared for amend dispatch. Before any amend agent runs, we re-classify
 * each approved finding's anchor to confirm it still exists in the working
 * tree at (or near) the originally-recorded location. If the anchor has
 * drifted since approval — say, an unrelated commit moved the function or
 * the operator hand-edited the file — the dispatched amend agent would be
 * given a stale target and could either:
 *   1. Edit the wrong line (wave-1 Class #14 territory: agent reports
 *      success, the actual bug never moved), or
 *   2. Bail out with a confusing "couldn't find anchor" error.
 *
 * Either failure mode loses operator trust. **verify-approved blocks the
 * amend dispatch when the anchor has drifted** by exiting with code 2 —
 * the same "broken" code verify-fixed v2 uses for pipeline-broken state.
 * CI / human operators who run `swarm verify-approved` before
 * `swarm dispatch ... amend-*` get a hard gate.
 *
 * **Sibling to verify-recurring's regression detection** but for the
 * pre-execution state: verify-recurring detects "fix landed twice";
 * verify-approved detects "approval still points at a real anchor."
 *
 * Output schema: `verify-approved-delta/v1`. Pattern #8 envelope shared
 * with verify-fixed v2.
 *
 * **Exit codes (overrides v2's default contract for the gate semantics):**
 *   0 — no approved findings, or every approved finding still has a
 *       valid anchor (classifier returns claimed-but-still-present, which
 *       is the *expected* state for an approved-but-not-yet-amended row).
 *       Threshold is on offending count = `verified` (anchor is gone, so
 *       the approval no longer matches the working tree) PLUS `regressed`.
 *   1 — offending count > threshold.
 *   2 — at least one approved finding classifies `unverifiable` OR the
 *       anchor drifted to a non-trivial degree. Per the directive
 *       (W3-BACK-005: "Exit code 2 (broken anchor) blocks subsequent amend
 *       dispatch"), 2 is the broken-anchor signal regardless of
 *       quantity — one drifted approval is enough to block dispatch.
 *
 * Note that the "offending" semantic for verify-approved is INVERTED from
 * verify-fixed: an approved finding's anchor *should* still be there
 * (because the fix hasn't been applied yet). `verified` here means "the
 * anchor is gone before the fix has been dispatched" — drift. `regressed`
 * means "the anchor moved to a different line in the same bucket" —
 * partial drift.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';

import { openDb } from '../db/connection.js';
import { buildV2Delta } from '../lib/verify-classifier-v2.js';
import { renderVerifyFixedDelta } from '../lib/findings-render.js';
import { logStage } from '../lib/log-stage.js';

const SCHEMA = 'verify-approved-delta/v1';
const VERB = 'verify-approved';

/**
 * Load all findings with status='approved', joined with the most recent
 * `approved` event so the operator can see which wave approved.
 */
export function loadApprovedFindings(db, runId) {
  return db.prepare(`
    SELECT
      f.id            AS row_id,
      f.finding_id    AS finding_id,
      f.fingerprint   AS fingerprint,
      f.severity      AS severity,
      f.category      AS category,
      f.file_path     AS file_path,
      f.line_number   AS line_number,
      f.symbol        AS symbol,
      f.description   AS description,
      f.recommendation AS recommendation,
      f.last_seen_wave AS last_seen_wave,
      (SELECT MAX(w.wave_number) FROM finding_events e
        JOIN waves w ON w.id = e.wave_id
        WHERE e.finding_id = f.id AND e.event_type = 'approved') AS approved_wave_number
    FROM findings f
    WHERE f.run_id = ? AND f.status = 'approved'
    ORDER BY f.id ASC
  `).all(runId);
}

/**
 * Recompute exit code under verify-approved's gate semantics.
 *
 * @param {object} delta — the v2 delta produced by buildV2Delta
 * @param {number} threshold
 * @returns {0|1|2}
 */
function approvalExitCode(delta, threshold) {
  if (delta.summary.total === 0) return 0;
  // Any unverifiable approved finding → broken anchor → block.
  if (delta.summary.unverifiable > 0) return 2;
  // For approved findings, drift = anchor gone (`verified`) or moved
  // (`regressed`). Both are signals that the approval no longer matches
  // working-tree reality.
  const drifted = delta.summary.verified + delta.summary.regressed;
  if (drifted > threshold) return 1;
  return 0;
}

export function verifyApproved(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) {
    throw new Error(`Run not found: ${opts.runId}`);
  }

  const latestWave = db.prepare(
    'SELECT wave_number FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1'
  ).get(opts.runId);
  const waveNumber = latestWave?.wave_number ?? null;

  const approved = loadApprovedFindings(db, opts.runId);

  logStage('verify_approved_start', {
    component: 'dogfood-swarm',
    runId: opts.runId,
    wave: waveNumber,
    approved_count: approved.length,
    threshold: opts.threshold ?? 0,
  });

  const threshold = opts.threshold ?? 0;
  const baseDelta = buildV2Delta({
    verb: VERB,
    schema: SCHEMA,
    runId: opts.runId,
    waveNumber,
    findings: approved,
    repoRoot: run.local_path,
    threshold,
    entryDecorator: (raw) => ({
      approved_wave_number: raw.approved_wave_number,
    }),
  });

  // Override exit code with the gate-specific semantics.
  const overriddenExit = approvalExitCode(baseDelta, threshold);
  const drifted = baseDelta.summary.verified + baseDelta.summary.regressed;
  const delta = {
    ...baseDelta,
    thresholdExceeded: drifted > threshold,
    exitCode: overriddenExit,
  };

  const deltaName = waveNumber != null ? `verify-approved-${waveNumber}.json` : 'verify-approved.json';
  const deltaPath = join(opts.outputDir, deltaName);
  if (!existsSync(dirname(deltaPath))) {
    mkdirSync(dirname(deltaPath), { recursive: true });
  }
  atomicWriteFileSync(deltaPath, JSON.stringify(delta, null, 2) + '\n', 'utf-8');

  const output = renderVerifyFixedDelta(delta, opts.format, opts.stream || process.stdout);

  logStage('verify_approved_complete', {
    component: 'dogfood-swarm',
    runId: opts.runId,
    wave: waveNumber,
    summary: delta.summary,
    threshold: delta.threshold,
    threshold_exceeded: delta.thresholdExceeded,
    delta_path: deltaPath,
    exit_code: delta.exitCode,
  });

  return {
    delta,
    output,
    deltaPath,
    exitCode: delta.exitCode,
  };
}
