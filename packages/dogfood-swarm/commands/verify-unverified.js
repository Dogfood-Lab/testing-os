/**
 * verify-unverified.js — `swarm verify-unverified <run-id> [--threshold=N] [--format=...]`
 *
 * **W3-BACK-004 (Phase 7 wave 3).** Sister verb to verify-fixed.
 *
 * Reads findings with `status='unverified'` — findings the prior amend
 * agent could not confirm one way or the other. These accumulate during
 * waves where:
 *   - the agent looked, didn't see the bug, but didn't have enough
 *     surrounding context to declare it `fixed`;
 *   - the bug-class is on a code path the agent's tooling couldn't
 *     exercise (e.g., a runtime check on a network adapter the agent
 *     can't connect to);
 *   - the finding's anchor was ambiguous and the agent declined to
 *     guess.
 *
 * **What we surface:** for every `unverified` row, run the v2 classifier
 * against the *current* code state. The point is that "unverified" is a
 * deferred decision — `verify-unverified` re-runs the decision at
 * present-day. Outcome:
 *   - if the v2 classifier returns `verified`, the deferred concern is
 *     now closed.
 *   - if `claimed-but-still-present` or `regressed`, the bug-class is
 *     still in the working tree and the deferral was a soft-fail.
 *   - if `unverifiable`, the deferral was correct: still no anchor
 *     evidence, still needs a human.
 *
 * **B-BACK-003 scope-uncovered class:** historically `unverified`
 * findings have been the silent-fail surface — they accumulate without
 * any operator-visible recheck. This verb is the recheck.
 *
 * Output schema: `verify-unverified-delta/v1`. Pattern #8 envelope shared
 * with verify-fixed v2.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';

import { openDb } from '../db/connection.js';
import { buildV2Delta } from '../lib/verify-classifier-v2.js';
import { renderVerifyFixedDelta } from '../lib/findings-render.js';
import { logStage } from '../lib/log-stage.js';

const SCHEMA = 'verify-unverified-delta/v1';
const VERB = 'verify-unverified';

/**
 * Load all findings with status='unverified', joined with the most recent
 * `unverified` event so the operator can see which wave deferred.
 */
export function loadUnverifiedFindings(db, runId) {
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
        WHERE e.finding_id = f.id AND e.event_type = 'unverified') AS deferred_wave_number
    FROM findings f
    WHERE f.run_id = ? AND f.status = 'unverified'
    ORDER BY f.id ASC
  `).all(runId);
}

export function verifyUnverified(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) {
    throw new Error(`Run not found: ${opts.runId}`);
  }

  const latestWave = db.prepare(
    'SELECT wave_number FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1'
  ).get(opts.runId);
  const waveNumber = latestWave?.wave_number ?? null;

  const unverified = loadUnverifiedFindings(db, opts.runId);

  logStage('verify_unverified_start', {
    component: 'dogfood-swarm',
    runId: opts.runId,
    wave: waveNumber,
    unverified_count: unverified.length,
    threshold: opts.threshold ?? 0,
  });

  const threshold = opts.threshold ?? 0;
  const delta = buildV2Delta({
    verb: VERB,
    schema: SCHEMA,
    runId: opts.runId,
    waveNumber,
    findings: unverified,
    repoRoot: run.local_path,
    threshold,
    entryDecorator: (raw) => ({
      deferred_wave_number: raw.deferred_wave_number,
    }),
  });

  const deltaName = waveNumber != null ? `verify-unverified-${waveNumber}.json` : 'verify-unverified.json';
  const deltaPath = join(opts.outputDir, deltaName);
  if (!existsSync(dirname(deltaPath))) {
    mkdirSync(dirname(deltaPath), { recursive: true });
  }
  atomicWriteFileSync(deltaPath, JSON.stringify(delta, null, 2) + '\n', 'utf-8');

  const output = renderVerifyFixedDelta(delta, opts.format, opts.stream || process.stdout);

  logStage('verify_unverified_complete', {
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
