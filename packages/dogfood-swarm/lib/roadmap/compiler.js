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
 * SCHEMA CONFORMANCE (F-e02e5bfd / F-c7b0f47b, wave 41; UPDATED wave 43 —
 * Amendment 3, docs/trajectory-and-closure.dispatch.md — READ BEFORE
 * re-investigating this gap a further time). As of wave 41 the artifact
 * commands/roadmap.js assembled did NOT validate against
 * dogfood-roadmap.schema.json — proven independently by two wave-41 lanes.
 * Amendment 3's ruling (wave 42) settled the direction the wave-41 comment
 * below left open: "the schema is the contract" — compile.js's own sections
 * conform TO the schema, not the reverse. This wave (43), compile.js was
 * rewritten to emit the schema-exact section shapes directly
 * (open_summary/compiled_from/recurrence_stats/attention{advisory,items}/
 * grandfathered_drain/drain_queue — see that file's own header for the full
 * list) — `compileRoadmapSections` below now returns compile.js's artifact
 * VERBATIM (no more `sections` stripping; see this function's own doc
 * comment). What remains OUT of this domain's globs and UNVERIFIED as of
 * this commit: whether commands/roadmap.js (swarm-cp-verbs) actually
 * CONSUMES these sections as-is for the persisted envelope, or still
 * re-derives its own flat runId/compiledAt/notes/expired/attention
 * [flattened]/drain/notesPath shape independently (its `compileRoadmap` CLI
 * function and `flattenAttention` helper did exactly that as of this
 * domain's last read, pre-dating this wave's fix) — that reconciliation is
 * this wave's disclosed cross-domain seam, not something this file can
 * verify or complete unilaterally. Do not assume it is done without
 * re-reading commands/roadmap.js directly.
 *
 * OPERATOR NOTES PLUMBING (A3.4, coordinator relay wave 43 — precision pass
 * over an earlier, too-broad reading of this instruction that had this file
 * claiming compile.js accepts no notes input at all; corrected). VALIDATION
 * is not this file's concern, nor compile.js's: commands/lib/
 * roadmap-notes.js#readOperatorNotes is the ONE surviving, live,
 * fail-closed, F-74ba2c79-pinned validator, and stays commands-side.
 * PLUMBING an already-validated array through to compile.js IS this file's
 * job — `compileRoadmapSections` below now forwards an `operatorNotes` opt
 * straight to `compileRoadmap`, which splits active/expired (T3's own
 * compile-time obligation: "compile MUST drop expired notes LOUDLY") and
 * emits `operator_notes`/`expired_notes`. The CALLER (commands/roadmap.js)
 * is expected to call readOperatorNotes() FIRST and pass its (validated)
 * `notes` array in here as `operatorNotes` — that wiring is out of this
 * domain's globs and unverified as of this commit (see the SCHEMA
 * CONFORMANCE note above for the same disclosed-seam caveat).
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
 * The schema-required factual sections, compiled read-only, returned
 * VERBATIM — no reshaping, no key-stripping. `operatorNotes`, when supplied,
 * is expected to be ALREADY VALIDATED by commands/lib/roadmap-notes.js
 * #readOperatorNotes (the one surviving fail-closed validator, out of this
 * domain's globs) — this function does not validate, only forwards, so
 * compile.js can perform its own T3-assigned compile-time obligation
 * (split active vs. expired, loudly).
 *
 * WAVE-43 CHANGE (A3.4, coordinator relay — corrects an intermediate,
 * too-broad state where this function stripped/dropped notes entirely):
 * this function previously destructured `operator_notes` OFF of compile
 * .js's return before forwarding the rest (`const {operator_notes,
 * ...sections} = artifact; return sections;`) — that stripping was live
 * code as long as compile.js computed operator_notes itself via a SECOND,
 * fail-open, full-revalidating implementation (./notes.js, deleted this
 * wave) that this very function never actually fed real notes into (dead
 * weight, not a working alternate route). Now that compile.js's notes
 * handling is a thin, correctly-scoped split (not a duplicate validator),
 * this function forwards `operatorNotes` straight through and returns
 * compile.js's artifact VERBATIM — no stripping, no reshaping.
 *
 * `now` forwards to compile.js's own injectable clock (see that module's
 * header on why `run_anchored_at` — F-fdcf6c9b, renamed from the dishonestly
 * -named `generated_at` — must never be a bare `new Date()` for T1's
 * cross-process determinism promise to hold) — commands/roadmap.js derives
 * a DB-stable stand-in (run.created_at) and passes it through here so the
 * inner `run_anchored_at` and the CLI's own top-level `compiledAt` always
 * agree and never drift between two compiles of the same run.
 */
export function compileRoadmapSections(db, runId, { gitRoot, now, operatorNotes } = {}) {
  return compileRoadmap(db, runId, { repoRoot: gitRoot, now, operatorNotes });
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

  // content_hash returned so the CLI envelope surfaces the SAME self-excluded
  // hash embedded above and recorded in the ledger — the merge of the two
  // wave-41 halves briefly had commands/roadmap.js re-hashing the final file
  // bytes (hash-including-the-embedded-hash), which can never equal the
  // ledger's self-excluded value; one derivation, surfaced everywhere.
  return { path: absPath, currentPath, latestPath, sequence, content_hash: contentHash };
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
