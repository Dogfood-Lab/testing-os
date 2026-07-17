/**
 * roadmap-seed.js — T4 seeding-side helper (F-d110f547,
 * docs/trajectory-and-closure.dispatch.md).
 *
 * Resolves + schema-validates the roadmap artifact a NEW run seeds its
 * lineage from (`swarm init --seed-from-roadmap`), and records that lineage
 * DURABLY via the existing `kv` key-value table — no schema migration
 * needed. db/schema.js is swarm-cp-core's exclusive glob this wave; `kv` is
 * the SAME no-new-column mechanism commands/dispatch.js's own F-ec97601a fix
 * already uses for `wave:<id>:skip_verify`, generalized here to
 * `roadmap_seed:<run-id>`.
 *
 * DELIBERATELY SEAM-FREE, mirroring commands/lib/roadmap-notes.js's own
 * stated rationale: this module has ZERO dependency on
 * `lib/roadmap/compiler.js` (swarm-cp-core's file, mid-flight this wave —
 * see commands/roadmap.js's own header). `dogfood/roadmap/<run-id>.json`
 * (T5's sequence-free content mirror) and `dogfood/roadmap/latest.json`
 * (T5's pointer) are both COMMITTED, plain files inside the TARGET repo's
 * own tree — reading them needs no DB connection and no core import, only
 * `repoPath` (the exact input `swarm init` already has). This generalizes
 * commands/dispatch.js's existing `loadRoadmapDigestSource` precedent (same
 * file pair, same tolerate-both-shapes read) to a NAMED run id instead of
 * "whatever's newest", and adds the schema gate that function never needed
 * (advisory digest content degrades silently by design; seeding a NEW run's
 * DURABLE lineage must fail loud instead — F-d110f547's own words).
 */

import { existsSync, readdirSync } from 'node:fs';
// H5 bounded-read discipline: every from-disk JSON read routes through the
// shared bounded reader — a seed artifact is repo-tree data an operator can
// point anywhere, so it gets the same cap agent outputs do.
import { readBoundedJson } from '../../lib/bounded-json-read.js';
import { join, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { roadmapError } from './roadmap-notes.js';

const require = createRequire(import.meta.url);

let _validate = null;
let _loadError = null;

/**
 * Local Ajv instance for dogfood-roadmap.schema.json, mirroring
 * lib/validate-agent-output.js's established convention for this package's
 * swarm-internal envelopes ("a LOCAL Ajv instance in the consuming package"
 * — the schema's own top-of-file description names this as the intended
 * pattern, exactly like agent-output.schema.json/case-file.schema.json
 * before it). Lazy + cached: most `swarm init` invocations never pass
 * --seed-from-roadmap, so paying Ajv's compile cost only when seeding is
 * actually requested matches this package's general "don't pay for what you
 * didn't ask for" posture.
 */
function getRoadmapValidator() {
  if (_validate) return _validate;
  if (_loadError) throw _loadError;
  try {
    const schemaPath = require.resolve('@dogfood-lab/schemas/json/dogfood-roadmap.schema.json');
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = readBoundedJson(schemaPath);
    _validate = ajv.compile(schema);
    return _validate;
  } catch (e) {
    _loadError = new Error(`dogfood-roadmap schema load failed: ${e.message}`);
    throw _loadError;
  }
}

export const ROADMAP_SEED_KV_PREFIX = 'roadmap_seed:';

/**
 * T4/F-d110f547: resolves + schema-validates the roadmap artifact a NEW run
 * seeds its lineage from, via a PURE filesystem read against the target
 * repo's own committed `dogfood/roadmap/` tree.
 *
 * @param {string} repoPath — resolved target repo root (opts.repoPath, init.js)
 * @param {string|true} requested — the --seed-from-roadmap value: `true`
 *   (bare flag) or the literal string `'latest'` both mean "whatever this
 *   checkout's dogfood/roadmap/latest.json currently names"; any other
 *   string is an explicit run id, read directly from
 *   dogfood/roadmap/<run-id>.json (the sequence-free content mirror T5's
 *   writeRoadmapArtifact always keeps current on every compile).
 * @returns {{ sourceRunId: string, sequence: number, relPath: string, artifact: object }}
 * @throws {Error} roadmapError — ROADMAP_SEED_NOT_FOUND (nothing resolves:
 *   missing pointer/file, unparseable JSON, or a well-formed-but-incomplete
 *   pointer) or ROADMAP_SEED_SCHEMA_INVALID (the resolved artifact fails
 *   dogfood-roadmap.schema.json validation, or lacks run_id/sequence even
 *   after passing it)
 */
export function resolveRoadmapSeed(repoPath, requested) {
  const roadmapDir = join(repoPath, 'dogfood', 'roadmap');
  const wantsLatest = requested === true || requested === 'latest';
  const label = wantsLatest ? 'latest' : requested;
  let relPath;

  if (wantsLatest) {
    const latestPath = join(roadmapDir, 'latest.json');
    if (!existsSync(latestPath)) {
      throw roadmapError(
        'ROADMAP_SEED_NOT_FOUND',
        `--seed-from-roadmap=latest: no dogfood/roadmap/latest.json in ${repoPath}`,
        'run `swarm roadmap compile <a-prior-run-id>` against this checkout first, or pass an explicit --seed-from-roadmap=<run-id>',
        { repoPath }
      );
    }
    let pointer;
    try {
      pointer = readBoundedJson(latestPath);
    } catch (e) {
      throw roadmapError(
        'ROADMAP_SEED_NOT_FOUND',
        `--seed-from-roadmap=latest: dogfood/roadmap/latest.json is not valid JSON: ${e.message}`,
        'recompile with `swarm roadmap compile <run-id>` to regenerate a valid pointer',
        { repoPath }
      );
    }
    if (!pointer || typeof pointer.path !== 'string' || pointer.path.length === 0) {
      throw roadmapError(
        'ROADMAP_SEED_NOT_FOUND',
        `--seed-from-roadmap=latest: dogfood/roadmap/latest.json has no usable "path" field`,
        'recompile with `swarm roadmap compile <run-id>` to regenerate a valid pointer',
        { repoPath }
      );
    }
    relPath = pointer.path;
  } else {
    // F-f0865cdf: an explicit --seed-from-roadmap=<run-id> must resolve the
    // NEWEST SEQUENCED history file (`<run-id>.<N>.json`), never the
    // sequence-free content mirror (`<run-id>.json`). The mirror deliberately
    // omits `sequence` to preserve F-feeaef78's cross-compile byte-identity,
    // so it can never satisfy the schema's required `sequence` — reading it
    // made the explicit form fail ROADMAP_SEED_SCHEMA_INVALID against every
    // real artifact, unconditionally. Every history file carries `sequence` by
    // construction (T5: history is append-only, nothing rewrites), so this is
    // the same shape the `latest.json` pointer already resolves for the bare
    // form. Prefix/suffix match rather than a regex so the run-id needs no
    // escaping; the `\d+` middle segment excludes the mirror itself (whose
    // middle segment is empty).
    let bestSeq = -1;
    let bestFile = null;
    if (existsSync(roadmapDir)) {
      const prefix = `${requested}.`;
      for (const entry of readdirSync(roadmapDir)) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
        const middle = entry.slice(prefix.length, entry.length - '.json'.length);
        if (!/^\d+$/.test(middle)) continue;
        const n = Number(middle);
        if (n > bestSeq) { bestSeq = n; bestFile = entry; }
      }
    }
    if (!bestFile) {
      throw roadmapError(
        'ROADMAP_SEED_NOT_FOUND',
        `--seed-from-roadmap=${requested}: no compiled roadmap history file dogfood/roadmap/${requested}.<N>.json exists in ${repoPath}`,
        `run \`swarm roadmap compile ${requested}\` against this checkout first, or check \`swarm roadmap show ${requested}\` for the sequences that exist`,
        { repoPath }
      );
    }
    relPath = `dogfood/roadmap/${bestFile}`;
  }

  const absPath = resolvePath(repoPath, relPath);
  if (!existsSync(absPath)) {
    throw roadmapError(
      'ROADMAP_SEED_NOT_FOUND',
      `--seed-from-roadmap=${label}: ${relPath} does not exist`,
      wantsLatest
        ? 'recompile with `swarm roadmap compile <run-id>` to regenerate a valid pointer'
        : `run \`swarm roadmap compile ${requested}\` first, or check \`swarm roadmap show ${requested}\``,
      { repoPath, relPath }
    );
  }

  let artifact;
  try {
    artifact = readBoundedJson(absPath);
  } catch (e) {
    throw roadmapError(
      'ROADMAP_SEED_SCHEMA_INVALID',
      `--seed-from-roadmap=${label}: ${relPath} is not valid JSON: ${e.message}`,
      'recompile the source run to regenerate a valid artifact',
      { repoPath, relPath }
    );
  }

  const validate = getRoadmapValidator();
  if (!validate(artifact)) {
    throw roadmapError(
      'ROADMAP_SEED_SCHEMA_INVALID',
      `--seed-from-roadmap=${label}: ${relPath} fails dogfood-roadmap.schema.json validation (${validate.errors.length} error(s))`,
      'the seed artifact is stale or was written by a non-conforming compiler — recompile the source run with the current build before seeding from it',
      { repoPath, relPath, errors: validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`) }
    );
  }

  // Belt-and-braces: a schema that happens not to constrain these two (or a
  // future schema revision that loosens them) must not hand back a lineage
  // stamp with a missing anchor — the WHOLE POINT of stamping lineage is a
  // resolvable (source_run_id, sequence) pair.
  if (typeof artifact.run_id !== 'string' || typeof artifact.sequence !== 'number') {
    throw roadmapError(
      'ROADMAP_SEED_SCHEMA_INVALID',
      `--seed-from-roadmap=${label}: ${relPath} passed schema validation but is missing run_id/sequence`,
      'recompile the source run to regenerate a valid artifact',
      { repoPath, relPath }
    );
  }

  return { sourceRunId: artifact.run_id, sequence: artifact.sequence, relPath, artifact };
}

/**
 * Records the seed lineage DURABLY on the new run via the `kv` table (no
 * migration). One row per NEW run id — `swarm init` runs once per run, so
 * INSERT OR REPLACE is idempotent-safe rather than load-bearing.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} newRunId
 * @param {{ sourceRunId: string, sequence: number, relPath: string }} seed
 */
export function stampRoadmapSeedLineage(db, newRunId, seed) {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    `${ROADMAP_SEED_KV_PREFIX}${newRunId}`,
    JSON.stringify({
      source_run_id: seed.sourceRunId,
      sequence: seed.sequence,
      path: seed.relPath,
      seeded_at: new Date().toISOString(),
    })
  );
}

/**
 * Reads back a run's stamped seed lineage (or null if the run was never
 * seeded, or was seeded before this feature existed). Used by dispatch.js
 * to decide the T4 auto-injection gate (seeded + first audit-phase wave).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @returns {{ source_run_id: string, sequence: number, path: string, seeded_at: string } | null}
 */
export function readRoadmapSeedLineage(db, runId) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(`${ROADMAP_SEED_KV_PREFIX}${runId}`);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    return parsed && typeof parsed.source_run_id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}
