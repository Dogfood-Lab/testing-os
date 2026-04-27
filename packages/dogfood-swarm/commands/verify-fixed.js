/**
 * verify-fixed.js — `swarm verify-fixed <run-id> [--threshold=N] [--format=...] [--legacy-v1]`
 *
 * F-252713-002 (Phase 7 wave 1, FT-BACKEND-002): the on-demand command
 * companion to FT-OUTPUTS-001's always-on CI gate. Together they
 * operationalize Class #14 — the wave-1 "claimed-fixed without
 * verification" pattern — with a runtime check (this command) and a
 * commit-time check (the parse-regression-pins.js harness). Surface for
 * an operator at the keyboard who wants to ask, right now, "did those
 * fixes actually land?"
 *
 * **Wave 30 / W3-BACK-002: v2 refactor.** Class #14b — v1's classifier
 * vantage-point limit — produced 11 incidental closures during wave 29 where
 * the CLI reported `claimed-but-still-present` and an agent re-audit reported
 * `verified` because the fix landed in a *consumer* file the v1 anchor
 * couldn't see. v2 rebases the verdict on lib/verify-classifier-v2.js, which:
 *   - tags every classification with `verified_via` (anchor / cross_ref /
 *     allowlist / agent_attestation / unverifiable) so operators see HOW
 *     the verdict was reached, not just the verdict.
 *   - treats `cross_ref` and coordinator-resolved allowlist entries as
 *     first-class evidence channels.
 *   - bumps the output schema string to `verify-fixed-delta/v2`.
 *   - adds `summary.verified_via_distribution: { anchor, cross_ref,
 *     allowlist, agent_attestation, unverifiable }`.
 *
 * Migration path for the wave-29 11 incidental closures (handled by the
 * coordinator at collect-time, NOT by this command):
 *   - Findings whose fix landed in a consumer file: attach
 *     `cross_ref: { file, symbol, line }` to the finding row.
 *   - Findings whose fix is architectural / doc-level / cross-cutting:
 *     attach `coordinator_resolved: true` plus a one-line
 *     `verified_via_evidence`.
 * v2 reads these fields without mutation.
 *
 * `--legacy-v1` flag preserves the v1 schema for any consumer that has
 * pinned to `verify-fixed-delta/v1` and isn't ready to migrate. The flag
 * routes through the v1 builder so output is byte-for-byte v1.
 *
 * The command:
 *   1. Loads every finding WHERE run_id=? AND status='fixed'.
 *   2. Hands them to buildV2Delta() (or buildVerifyFixedDelta() under
 *      --legacy-v1) to classify.
 *   3. Writes the delta JSON to swarms/<run>/verify-fixed-<wave>.json.
 *   4. Emits a TTY-aware summary via renderVerifyFixedDelta() choke-point.
 *   5. Exits 0/1/2 per the wave-18 3-way disambiguation contract.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';

import { openDb } from '../db/connection.js';
import { loadFixedFindings, buildVerifyFixedDelta } from '../lib/verify-fixed.js';
import { buildV2Delta } from '../lib/verify-classifier-v2.js';
import { renderVerifyFixedDelta } from '../lib/findings-render.js';
import { logStage } from '../lib/log-stage.js';

const V2_SCHEMA = 'verify-fixed-delta/v2';
const V2_VERB = 'verify-fixed';

/**
 * Run the verify-fixed audit.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {string} opts.outputDir — root swarms/<run> directory; the delta
 *   JSON is written to swarms/<run>/verify-fixed-<wave>.json.
 * @param {number} [opts.threshold=0]
 * @param {string} [opts.format] — text|markdown|json (auto-detect if
 *   omitted)
 * @param {boolean} [opts.legacyV1=false] — emit v1 schema for backward compat
 * @param {NodeJS.WriteStream} [opts.stream=process.stdout]
 * @returns {{ delta: object, output: string, deltaPath: string, exitCode: 0|1|2 }}
 */
export function verifyFixed(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) {
    throw new Error(`Run not found: ${opts.runId}`);
  }

  // Pin the wave number to the latest wave for filename + reporting. We
  // do not require a wave to exist — a run with zero waves still has zero
  // fixed findings, and exit code 0 is the right answer.
  const latestWave = db.prepare(
    'SELECT wave_number FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1'
  ).get(opts.runId);
  const waveNumber = latestWave?.wave_number ?? null;

  const fixed = loadFixedFindings(db, opts.runId);

  logStage('verify_fixed_start', {
    component: 'dogfood-swarm',
    runId: opts.runId,
    wave: waveNumber,
    fixed_count: fixed.length,
    threshold: opts.threshold ?? 0,
    schema_version: opts.legacyV1 ? 'v1' : 'v2',
  });

  const threshold = opts.threshold ?? 0;
  const delta = opts.legacyV1
    ? buildVerifyFixedDelta({
        runId: opts.runId,
        waveNumber,
        fixedFindings: fixed,
        repoRoot: run.local_path,
        threshold,
      })
    : buildV2Delta({
        verb: V2_VERB,
        schema: V2_SCHEMA,
        runId: opts.runId,
        waveNumber,
        findings: fixed,
        repoRoot: run.local_path,
        threshold,
      });

  // Persist the delta JSON inside the run's swarms directory, alongside
  // wave artifacts. Filename uses the wave number when known, otherwise
  // `verify-fixed.json` so the contract still has a stable path.
  const deltaName = waveNumber != null ? `verify-fixed-${waveNumber}.json` : 'verify-fixed.json';
  const deltaPath = join(opts.outputDir, deltaName);
  if (!existsSync(dirname(deltaPath))) {
    mkdirSync(dirname(deltaPath), { recursive: true });
  }
  atomicWriteFileSync(deltaPath, JSON.stringify(delta, null, 2) + '\n', 'utf-8');

  const output = renderVerifyFixedDelta(delta, opts.format, opts.stream || process.stdout);

  logStage('verify_fixed_complete', {
    component: 'dogfood-swarm',
    runId: opts.runId,
    wave: waveNumber,
    summary: delta.summary,
    threshold: delta.threshold,
    threshold_exceeded: delta.thresholdExceeded,
    delta_path: deltaPath,
    exit_code: delta.exitCode,
    schema_version: opts.legacyV1 ? 'v1' : 'v2',
  });

  return {
    delta,
    output,
    deltaPath,
    exitCode: delta.exitCode,
  };
}
