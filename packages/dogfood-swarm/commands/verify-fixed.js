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
 * F-2f10ff78 (wave 29): the filename this dual-mode contract writes to
 * (verify-fixed-<wave>.json, below) is deliberately schema-agnostic — which
 * means a v2 invocation and a --legacy-v1 invocation against the identical
 * run+wave write the IDENTICAL path, with no clobber guard and no version
 * suffix. verifyFixed() now reads whatever schema is already on disk at that
 * path immediately before the atomic write replaces it, and logs a durable
 * `verify_fixed_schema_overwrite` event when it differs from the schema
 * about to be written — so a consumer that reads a mysteriously
 * wrong-shaped delta has a trail to follow. The clobber itself is
 * unchanged: the filename contract is part of this repo's published
 * backing-store API (root CLAUDE.md "Runtime data dirs at the repo root"),
 * so widening it to encode schema version is a bigger, cross-cutting change
 * left for a future finding, not folded into this one.
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
import { readBoundedJson } from '../lib/bounded-json-read.js';
import { runNotFoundError } from './lib/run-lookup-error.js';

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
    throw runNotFoundError(opts.runId);
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

  // F-2f10ff78 (Stage C): --legacy-v1 and the v2 default write to the
  // IDENTICAL deltaPath for a given run+wave — the filename is deliberately
  // schema-agnostic (the module header's v1/v2 dual-mode contract above), so
  // a v2 invocation followed by a --legacy-v1 invocation against the same
  // run+wave (or vice versa) silently clobbers the other schema with no
  // warning and no version suffix in the filename. Changing the filename
  // contract or refusing the overwrite outright are both bigger, more
  // cross-cutting changes than this Stage C humanization pass should make
  // unilaterally (the filename is part of this repo's published backing-
  // store API — see root CLAUDE.md "Runtime data dirs at the repo root").
  // What IS fixed: the missing observability. Read whatever schema is
  // already on disk at this exact path BEFORE the atomic write replaces it,
  // and log a durable, greppable event when it differs from the schema
  // about to be written — a downstream consumer that reads a mysteriously
  // wrong-shaped delta now has an actual trail to follow instead of nothing.
  //
  // Routed through readBoundedJson rather than a bare JSON.parse(readFileSync)
  // (the bounded-json discipline, amend1-bounded-json-discipline.test.js). The
  // helper's own "out of scope" carve-out names lib/verify-fixed.js — that is
  // the sibling module parsing DB-derived columns, NOT this file: here the
  // input is a real on-disk artifact whose size scales with the run's finding
  // count, so no bound can be honestly argued from this call site, and only
  // one small field is needed off the front of it. A prior file that is
  // oversized, unreadable, or corrupt fails CLOSED to "no warning" rather than
  // taking down the verb: this check is best-effort observability layered onto
  // the write path, and diagnosing a malformed prior delta is not its job.
  if (existsSync(deltaPath)) {
    let priorSchema;
    try {
      priorSchema = readBoundedJson(deltaPath).schema;
    } catch {
      priorSchema = undefined;
    }
    if (priorSchema && priorSchema !== delta.schema) {
      logStage('verify_fixed_schema_overwrite', {
        component: 'dogfood-swarm',
        runId: opts.runId,
        wave: waveNumber,
        deltaPath,
        priorSchema,
        newSchema: delta.schema,
      });
    }
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
