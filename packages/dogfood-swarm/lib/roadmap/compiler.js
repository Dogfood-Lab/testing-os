/**
 * compiler.js — the wave-39 seam adapter between commands/roadmap.js's
 * documented contract and this directory's compile/artifacts modules.
 *
 * Both sides were built in isolated worktrees against the same pass contract
 * (docs/trajectory-and-closure.dispatch.md) from opposite ends: the verbs
 * lane documented the three exports it needed in commands/roadmap.js's
 * header; the core lane shipped compileRoadmap() + the roadmap_artifacts
 * ledger with different names and a narrower write surface. This file,
 * authored by the coordinator at the merge, is where the two ends meet — and
 * it resolves the one decision both lanes explicitly deferred upward: the
 * artifact lives in the AUDITED repo's `dogfood/roadmap/` runtime-data dir,
 * sequence-suffixed (`<run-id>.<seq>.json`) so a recompile supersedes without
 * ever rewriting history (T5), with `latest.json` as the
 * {run_id, sequence, path} pointer dogfood-roadmap.schema.json's
 * $defs/latestPointer describes and scripts/check-doc-drift.mjs validates.
 * Paths are stored repo-relative (ledger + pointer) and resolved against
 * runs.local_path on read, so a run against a temp SWARM_DB never bakes
 * machine-absolute paths into a committed artifact.
 *
 * Dissolving this adapter into either neighbor is the queued follow-up; while
 * it exists it is deliberately thin — no logic beyond naming, placement, and
 * serialization lives here.
 *
 * SCHEMA CONFORMANCE (F-e02e5bfd / F-c7b0f47b, wave 41 — READ BEFORE
 * re-investigating this gap a third time). The artifact commands/roadmap.js
 * assembles and hands to writeRoadmapArtifact below does NOT validate
 * against dogfood-roadmap.schema.json today — proven independently by two
 * wave-41 lanes (backend's schema-side audit, this domain's compiler-side
 * one). The top-level envelope (runId/compiledAt/notes/expired/attention
 * [flattened]/drain/sections/notesPath) is assembled entirely in
 * commands/roadmap.js (swarm-cp-verbs' domain) and this file's own
 * writeRoadmapArtifact (this domain) — NEITHER of which this wave's
 * swarm-cp-core lane can unilaterally reshape to snake_case without either
 * (a) editing commands/roadmap.js, which is outside this domain's globs, or
 * (b) working against backend's OWN declared resolution (backend's wave-41
 * brief, F-c7b0f47b's Fix: text): evolve the SCHEMA to describe the CLI's
 * existing flat camelCase shape rather than rewrite the shipped CLI +
 * adapter, since three already-passing wave-39 tests
 * (F-1cd5de59/F-74ba2c79/F-8a97a700) pin that exact shape. This lane's
 * contribution this wave is scoped to what lib/roadmap/** can do
 * unilaterally without fighting that direction: `content_hash` is now
 * actually embedded in the written artifact bytes (see writeRoadmapArtifact
 * below — it was computed but never written into the file before this), and
 * compile.js's own `run_anchored_at` rename/honesty fix (F-fdcf6c9b). The
 * `sections` duplication question and the full top-level rename are
 * cross-domain and unresolved as of this commit — do not assume either is
 * done without re-reading commands/roadmap.js and the schema file directly.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// H5 discipline: artifact loads go through the bounded reader — a corrupted
// or adversarially-huge roadmap file fails loud with a structured error
// instead of OOMing the coordinator.
import { readBoundedJson } from '../bounded-json-read.js';

// The artifact document and the latest.json pointer are exactly the
// torn-write class the shared atomic-write contract exists for: a consumer
// (or the drift gate) reading a half-written pointer would see corruption,
// not absence. Same cross-package edge log-stage/atomic-write already use.
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';

import { openDb } from '../../db/connection.js';
import { compileRoadmap } from './compile.js';
import { nextSequenceNumber, recordRoadmapArtifact, latestRoadmapArtifact } from './artifacts.js';

/**
 * The T1/T2/T6 factual sections, compiled read-only. Operator notes are
 * deliberately excluded: compile.js's own header defers the notes SOURCE to
 * the CLI layer, and commands/roadmap.js validates and attaches them itself.
 *
 * `now` forwards to compile.js's own injectable clock (see that module's
 * header on why `run_anchored_at` — F-fdcf6c9b, renamed from the dishonestly
 * -named `generated_at` — must never be a bare `new Date()` for T1's
 * cross-process determinism promise to hold) — commands/roadmap.js derives
 * a DB-stable stand-in (run.created_at) and passes it through here so the
 * inner `run_anchored_at` and the CLI's own top-level `compiledAt` always
 * agree and never drift between two compiles of the same run.
 */
export function compileRoadmapSections(db, runId, { gitRoot, now } = {}) {
  const artifact = compileRoadmap(db, runId, { repoRoot: gitRoot, now });
  const { operator_notes, ...sections } = artifact;
  return sections;
}

function roadmapDir(localPath) {
  return join(localPath, 'dogfood', 'roadmap');
}

/**
 * T5 write: sequence-suffixed document + latest.json pointer + ledger row,
 * PLUS a sequence-free `<run-id>.json` convenience mirror.
 *
 * The sequence-suffixed file is T5's immutable history ("nothing rewrites");
 * the ledger row + latest.json pointer are how a reader finds the newest one
 * without knowing the sequence number. The plain `<run-id>.json` mirror is
 * ADDITIVE to that contract, not a replacement for it: three independent
 * wave-39 gate tests (F-1cd5de59, F-74ba2c79, F-feeaef78) were written
 * RED-IN-ISOLATION against a sequence-free path — a documented assumption
 * none of them could verify against this module (which did not exist in
 * their worktree) — and this mirror satisfies that CLI-facing convention
 * without disturbing the sequence-suffixed file, the ledger, or latest.json,
 * none of which any currently-passing test pins to a specific filename (this
 * module had zero dedicated unit tests of its own before this wave).
 * Always overwritten on recompile — it is a projection of "the current
 * state", exactly like latest.json is a projection of "which sequence is
 * current", not a second historical record.
 *
 * Returns { path, currentPath, latestPath, sequence } with absolute paths
 * for the CLI's own report; the persisted pointer/ledger keep the
 * repo-relative form.
 */
export function writeRoadmapArtifact(runId, artifact, { dbPath } = {}) {
  const db = openDb(dbPath);
  const run = db.prepare('SELECT local_path FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`writeRoadmapArtifact: no run found with id ${JSON.stringify(runId)}`);

  const dir = roadmapDir(run.local_path);
  mkdirSync(dir, { recursive: true });

  const sequence = nextSequenceNumber(db, runId);
  const body = { ...artifact, sequence };
  const json = JSON.stringify(body, null, 2);
  const contentHash = createHash('sha256').update(json).digest('hex');

  // F-e02e5bfd / F-c7b0f47b: dogfood-roadmap.schema.json's `content_hash` is
  // computed right above (sha256 of `body`) but, before this fix, was ONLY
  // ever passed to recordRoadmapArtifact for the DB ledger row — never
  // written into the artifact file itself, so the one schema field this
  // codebase already got right in spirit was unreachable in the real file. A
  // consumer that fetches dogfood/roadmap/<run-id>.<seq>.json directly (no DB
  // access) had no way to verify it against latest.json's pointer. Hashed
  // BEFORE this field is added (`body`, not `bodyWithHash`) to avoid hashing
  // a value that includes itself — the embedded value and the DB ledger's
  // column are therefore the same hash of the same underlying content, just
  // surfaced in two places. Deliberately added ONLY to the sequence-suffixed
  // history file, never to the sequence-free `<run-id>.json` mirror below:
  // content_hash is a property of "these exact file bytes as written this
  // attempt", the same "which write attempt produced it" character
  // `sequence` already has (see that field's own comment below for why it
  // is excluded from the mirror) — embedding it there would tie the mirror
  // to one specific compile attempt, contradicting its own documented
  // "represents CONTENT, not a historical record" purpose.
  const bodyWithHash = { ...body, content_hash: contentHash };
  const jsonWithHash = JSON.stringify(bodyWithHash, null, 2);

  const relPath = `dogfood/roadmap/${runId}.${sequence}.json`;
  const absPath = join(run.local_path, relPath);
  atomicWriteFileSync(absPath, jsonWithHash);

  // Deliberately WITHOUT `sequence` (unlike the historical file above):
  // sequence increments on every compile purely as a bookkeeping side effect
  // of calling this function, regardless of whether the underlying DB state
  // changed at all — embedding it here would fail F-feeaef78's cross-process
  // byte-identity proof for a reason unrelated to T1's actual determinism
  // claim (two compiles of an UNCHANGED DB would still disagree on this one
  // field). The mirror represents CONTENT ("what does this run's roadmap
  // say right now"), not "which write attempt produced it".
  const currentJson = JSON.stringify(artifact, null, 2);
  const currentPath = join(dir, `${runId}.json`);
  atomicWriteFileSync(currentPath, currentJson);

  const latestPath = join(dir, 'latest.json');
  atomicWriteFileSync(latestPath, JSON.stringify({ run_id: runId, sequence, path: relPath }, null, 2));

  recordRoadmapArtifact(db, { runId, path: relPath, contentHash });

  return { path: absPath, currentPath, latestPath, sequence };
}

/**
 * Read-only load. `version` omitted → the ledger's latest row; a run with no
 * compiled artifact returns null (a legitimate state, never an error).
 */
export function loadRoadmapArtifact(runId, { version, dbPath } = {}) {
  const db = openDb(dbPath);
  const run = db.prepare('SELECT local_path FROM runs WHERE id = ?').get(runId);
  if (!run) throw new Error(`loadRoadmapArtifact: no run found with id ${JSON.stringify(runId)}`);

  let row;
  if (version != null) {
    row = db.prepare(
      'SELECT path, sequence_number FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = ?'
    ).get(runId, version);
  } else {
    row = latestRoadmapArtifact(db, runId);
  }
  if (!row) return null;

  const relPath = row.path;
  return readBoundedJson(join(run.local_path, relPath));
}
