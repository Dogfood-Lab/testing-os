/**
 * roadmap.js — `swarm roadmap compile <run-id>` / `swarm roadmap show <run-id>`
 * (T1's CLI surface, F-338c8c46).
 *
 * Thin CLI wrapper + rendering (this domain's, swarm-cp-verbs', responsibility)
 * delegating the actual query/compile logic to a core-owned
 * `lib/roadmap/compiler.js` (swarm-cp-core's domain) — matching this
 * package's established commands/*.js-wraps-lib/*.js layering (verify.js
 * wraps lib/verify/registry.js; history.js wraps lib/wave-state-machine.js;
 * clean.js wraps lib/worktree.js).
 *
 * ============================================================================
 * SEAM (wave 43 — Amendment 3) — read before touching this file at merge time
 * ============================================================================
 * CORRECTION to the wave-39 header this replaces: `../lib/roadmap/
 * compiler.js` DOES exist in this worktree (it has since wave 39's own
 * merge) — the "does not exist" framing below was stale documentation, not
 * a live seam, and is deleted rather than carried forward.
 *
 * The REAL, current seam this wave is narrower and different in kind: A3
 * (docs/trajectory-and-closure.dispatch.md, "Amendment 3") is the wave-42
 * ruling that "the schema is the contract" — `lib/roadmap/compile.js`
 * (swarm-cp-core's file) is being reshaped, IN ITS OWN WORKTREE this same
 * wave, to emit `compileRoadmapSections()`'s section object using the
 * SCHEMA's own field names (`run_id`, `repo`, `compiled_from`,
 * `open_summary`, `grandfathered_drain`, `recurrence_stats`, `attention`,
 * `run_anchored_at`) instead of the pre-A3 shape this worktree's copy of
 * compile.js still has (`findings.{open,deferred,approved}` raw arrays, no
 * `compiled_from`, no `grandfathered_drain`, a differently-shaped
 * `drain_queue`). This file is coded against A3's TEXT, below and in
 * `buildRoadmapArtifact()`'s own doc comment — not against what THIS
 * worktree's compile.js currently returns. Until core's A3 edit lands,
 * `swarm roadmap compile` is red-in-isolation here in a NEW way (wrong/
 * missing fields on the written artifact, not a missing module) — the same
 * "coded against the locked contract, not a mergeable module today"
 * posture the original wave-39 seam had, one level deeper.
 *
 * A3.1's field mapping (no intermediate vocabulary — every key taken from
 * `sections` keeps its OWN schema name):
 *
 *   FROM sections (compile.js, core, post-A3):
 *     run_id, repo, compiled_from{commit_sha}, open_summary,
 *     grandfathered_drain, recurrence_stats, attention{advisory,items[+components]},
 *     run_anchored_at (A3.3: internal name pinned, stays — NEVER renamed at
 *     the compile.js layer; this file derives the envelope's `compiled_at`
 *     from it, see buildRoadmapArtifact).
 *
 *   FROM this CLI layer (unchanged from pre-A3 — T3's notes source has
 *   ALWAYS lived here, never in compile.js, whose own `operator_notes` on
 *   this callpath is always empty and is therefore never read):
 *     operator_notes (active notes), expired_notes (A3.4: renamed from
 *     `expired`, required/empty-allowed), drain_queue (A3.2(a): still
 *     compileAuthoredDrainState's runs-ordinal shape — deliberately outside
 *     compileRoadmapSections' own composition, per lib/roadmap/drain.js's
 *     own header), notesPath (F-113eefea: repo-relative).
 *
 *   DROPPED from the pre-A3 envelope, never reintroduced: the flat `runId`
 *   (camelCase — superseded by `run_id`), the top-level `notes`/`expired`
 *   (superseded by `operator_notes`/`expired_notes`), the top-level `drain`
 *   (superseded by `drain_queue`), and `sections` itself (never persisted —
 *   wave-41's own SCHEMA CONFORMANCE note in compiler.js already established
 *   this; unchanged by A3).
 *
 * `writeRoadmapArtifact(runId, artifact, { dbPath })` and
 * `loadRoadmapArtifact(runId, { version, dbPath })` are untouched by A3 —
 * both are real, unchanged today (see lib/roadmap/compiler.js directly).
 *
 * If core's real A3 edit differs from this file's own reading of the
 * contract, reconciling THIS file (not the note-validation logic in
 * commands/lib/roadmap-notes.js, which has no dependency on compile.js at
 * all) is the merge follow-up.
 * ============================================================================
 */

import { existsSync } from 'node:fs';
import { relative as relativePath, resolve as resolvePath, join as joinPath, sep } from 'node:path';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { openDb } from '../db/connection.js';
import { readOperatorNotes, splitExpiredNotes, roadmapError } from './lib/roadmap-notes.js';
import { escapeReasonForDisplay, escapePathForDisplay } from './lib/escape-reason.js';
import { compileRoadmapSections, writeRoadmapArtifact, loadRoadmapArtifact } from '../lib/roadmap/compiler.js';
// F-1cd5de59's authored, run-ordinal drain-state half — additive to (never a
// replacement for) core's own two-halves compileDrainQueue, which lives
// inside compileRoadmapSections above and is left untouched.
//
// A3.5: the three named residuals (allowlist-overdue, unroutable-approved,
// deferred-stale) surface in `swarm roadmap show` ONLY — computed live
// against current DB/git state, never persisted into the compiled artifact.
// All three are already-real, already-exported functions (lib/roadmap/
// drain.js has never been behind the compiler.js seam) — imported directly,
// same as compileAuthoredDrainState already was.
import {
  compileAuthoredDrainState,
  compileGrandfatheredManifestDrain,
  compileUnroutableApprovedDrain,
  compileDeferredFindingsDrain,
} from '../lib/roadmap/drain.js';

function requireRun(db, runId) {
  // created_at is load-bearing (deterministicNow below) — omitting it here
  // silently falls back to a live `new Date()` clock, exactly the wall-clock
  // non-determinism T1/F-feeaef78 exist to catch.
  const run = db.prepare('SELECT id, repo, local_path, created_at FROM runs WHERE id = ?').get(runId);
  if (!run) {
    throw roadmapError(
      'ROADMAP_RUN_NOT_FOUND',
      `roadmap: run not found: ${runId}`,
      'check `swarm runs` for the correct run id',
      { runId }
    );
  }
  return run;
}

/**
 * F-5cfa163c: SQLite's `datetime('now')` (`runs.created_at`'s own DEFAULT,
 * db/schema.js) returns a UTC instant in the space-separated,
 * timezone-UNMARKED form `'YYYY-MM-DD HH:MM:SS'` — UTC by SQLite's own
 * convention (`datetime('now')` is always UTC unless the `'localtime'`
 * modifier is applied, which this schema's DEFAULT never uses). `new
 * Date(...)` has no way to know that: the ECMA-262 date-string grammar
 * treats a non-'T'-separated, non-'Z'/offset-suffixed string as LOCAL time,
 * not UTC. On any machine whose local timezone is not UTC+0, `new
 * Date(run.created_at)` therefore parsed the identical stored string to a
 * DIFFERENT instant than the row's true UTC meaning — silently, off by
 * exactly the local UTC offset. The proof shape: parse the same SQLite-
 * shaped string once as local time and once forced-UTC; the two epoch
 * values differ by `getTimezoneOffset() * 60000` ms whenever that offset is
 * non-zero (see f-5cfa163c-deterministic-now-utc.test.js, which pins this
 * via TZ-env-injected subprocesses rather than depending on the CI
 * machine's own zone). T1's cross-process byte-identity promise
 * (F-feeaef78) was unaffected BY ITSELF — the same wrong offset applies
 * consistently within one machine/process — but the VALUE embedded in
 * every compiled artifact's `compiled_at` (A3.3) was wrong on any non-UTC
 * machine.
 *
 * Robust to three input shapes without assuming which one a given caller
 * (production SQLite reads vs. a hand-built test fixture) supplies:
 *   - already timezone-marked (`...Z` or `...+HH:MM`/`...-HH:MM`) → parsed
 *     as-is, no rewrite (a caller that was already explicit is trusted).
 *   - space-separated, no timezone marker (the real SQLite shape) → the
 *     space is replaced with `T` and `Z` appended, forcing the UTC read
 *     SQLite's own value always means.
 *   - anything else unparseable → NaN, handled by deterministicNow's
 *     existing live-clock fallback (unchanged).
 *
 * @param {string} raw — runs.created_at's stored value
 * @returns {Date}
 */
function parseSqliteUtcDatetime(raw) {
  if (typeof raw !== 'string') return new Date(NaN);
  const hasTimezoneMarker = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  const normalized = hasTimezoneMarker ? raw : `${raw.replace(' ', 'T')}Z`;
  return new Date(normalized);
}

/**
 * A deterministic stand-in for "now", derived from the run's OWN DB row
 * rather than the wall clock. T1's determinism promise ("same DB state ->
 * byte-identical artifact", pinned by F-feeaef78's cross-process test) is
 * incompatible with a live `new Date()` timestamp: two separate `swarm
 * roadmap compile` processes against the identical DB, run moments apart,
 * would otherwise never agree byte-for-byte. `runs.created_at` is fixed the
 * moment the row is inserted and never changes across repeated compiles of
 * the same run, so it is a legitimate "compiled at" stand-in that is still
 * genuinely DB-derived, not authored (F-feeaef78's own guidance: "derived
 * from the DB's own data... never datetime('now')"). Falls back to a live
 * clock only if the column is somehow unparseable — a defensive, undocumented
 * corner, not the normal path.
 */
export function deterministicNow(run) {
  const parsed = parseSqliteUtcDatetime(run.created_at);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * F-113eefea: store `notesPath` repo-relative in the committed artifact,
 * mirroring how the artifact's own `path`/`latestPath` are recorded
 * (writeRoadmapArtifact's persisted ledger row + latest.json pointer are
 * repo-relative; only the CLI report's own path/currentPath/latestPath
 * fields carry the absolute form, for the operator's terminal). Pre-fix,
 * `readOperatorNotes`'s own default (`resolve(repoRoot, 'dogfood',
 * 'roadmap-notes.json')`, always absolute) went straight into the artifact
 * unconverted — a machine-absolute, Robot-rig-specific path baked verbatim
 * into a committed, tracked JSON artifact, non-portable to any other
 * machine or checkout location and a second, undisclosed threat to
 * F-feeaef78's "same DB state -> byte-identical artifact" promise (two
 * genuinely-identical DB states compiled from two different checkouts would
 * disagree on this one field alone).
 *
 * `path.relative` on Windows returns backslash separators; normalized to
 * forward slashes to match every other repo-relative path this artifact
 * already carries (`path`/`currentPath`/`latestPath`'s persisted form, and
 * this repo's general glob/path convention — always forward-slash).
 *
 * @param {string} repoRoot — run.local_path
 * @param {string} absoluteNotesPath — readOperatorNotes' own resolved path
 * @returns {string}
 */
function toRepoRelativeNotesPath(repoRoot, absoluteNotesPath) {
  return relativePath(repoRoot, absoluteNotesPath).split(sep).join('/');
}

/**
 * A3.1: assembles the persisted artifact body from compile.js's
 * schema-shaped sections plus the CLI-layer-only additions (real operator
 * notes, the runs-ordinal drain_queue, notesPath). Pure, no I/O — exported
 * so the FIELD-MAPPING CONTRACT ITSELF ("no intermediate vocabulary": every
 * key taken from `sections` keeps its own schema name, nothing renamed or
 * reshaped) is unit-testable with a hand-built `sections` fixture,
 * independent of whether lib/roadmap/compile.js has landed A3's shape in a
 * given worktree (this file's own header SEAM note). Explicit whitelist,
 * not a `...sections` spread: `additionalProperties: false` at the schema's
 * top level means any extra/leftover key on `sections` (e.g. a transitional
 * shape still carrying the pre-A3 `findings` raw arrays) would otherwise be
 * smuggled straight into a schema-invalid artifact — the exact failure mode
 * A3.1 exists to close, not reintroduce one layer down.
 *
 * @param {object} sections — compileRoadmapSections' return value; expected
 *   (per A3.1, the wave-43 locked contract) to already carry: run_id, repo,
 *   compiled_from, open_summary, grandfathered_drain, recurrence_stats,
 *   attention, run_anchored_at (A3.3: internal name pinned, stays).
 * @param {object} extras
 * @param {object[]} extras.activeNotes — T3's real notes source (this CLI
 *   layer, never compile.js's own always-[] operator_notes on this callpath)
 * @param {object[]} extras.expiredNotes
 * @param {{entries: object[], overdue_ids: string[]}} extras.drainQueue — A3.2(a)
 * @param {string} extras.notesPath — repo-relative (F-113eefea)
 * @returns {object} — the artifact body BEFORE writeRoadmapArtifact stamps
 *   `sequence`/`content_hash`
 */
export function buildRoadmapArtifact(sections, extras) {
  return {
    run_id: sections.run_id,
    repo: sections.repo,
    compiled_from: sections.compiled_from,
    open_summary: sections.open_summary,
    grandfathered_drain: sections.grandfathered_drain,
    recurrence_stats: sections.recurrence_stats,
    attention: sections.attention,
    // A3.3: a REAL read-through of the section's own value — never an
    // independent second `now.toISOString()` computation. Recomputing
    // invites the two call sites (this envelope vs. compile.js's own
    // run_anchored_at) silently drifting apart if compile.js's derivation
    // ever changes; deriving from the section's own value makes drift
    // structurally impossible instead of merely unlikely.
    compiled_at: sections.run_anchored_at,
    operator_notes: extras.activeNotes,
    // A3.4: renamed from `expired` — required, empty-allowed.
    expired_notes: extras.expiredNotes,
    drain_queue: extras.drainQueue,
    notesPath: extras.notesPath,
  };
}

/**
 * `swarm roadmap compile <run-id>`
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {string} [opts.notesPath] — override for the operator-notes seed path
 * @returns {object} report — the compiled artifact + { sequence, path, currentPath, latestPath, content_hash }
 */
export function compileRoadmap(opts) {
  const { runId, dbPath } = opts;
  if (!runId) throw new Error('roadmap compile: <run-id> is required');

  const db = openDb(dbPath);
  const run = requireRun(db, runId);
  const now = deterministicNow(run);

  // T3: fail-loud, CLI-layer note validation — BEFORE any core compile work,
  // matching this package's "validate every flag/input up front" discipline
  // (cmdAdjudicate's F-a7eb2d09 precedent).
  const { notesPath, notes } = readOperatorNotes(run.local_path, { notesPath: opts.notesPath });
  const { active, expired } = splitExpiredNotes(notes, now);

  // A3.1: consume compile.js's schema-shaped sections VERBATIM (see
  // buildRoadmapArtifact for the field-by-field mapping) — no intermediate
  // vocabulary.
  const sections = compileRoadmapSections(db, runId, { gitRoot: run.local_path, now });

  // A3.2(a): drain_queue is compileAuthoredDrainState's runs-ordinal shape —
  // deliberately NOT part of compileRoadmapSections' own composition (that
  // module's own header: "never folded into compileDrainQueue's
  // composition... callers that want both call each explicitly"). Only the
  // PERSISTED KEY NAME changed under A3 (`drain` -> `drain_queue`); this
  // call and its shape are unchanged from pre-A3.
  const drainState = compileAuthoredDrainState(db, run);

  const artifact = buildRoadmapArtifact(sections, {
    activeNotes: active,
    expiredNotes: expired,
    drainQueue: { entries: drainState.entries, overdue_ids: drainState.overdue_ids },
    notesPath: toRepoRelativeNotesPath(run.local_path, notesPath),
  });

  const written = writeRoadmapArtifact(runId, artifact, { dbPath });
  // F-113eefea/F-520023e7 axis 4 (content_hash): ONE derivation, core's.
  // writeRoadmapArtifact computes the schema-blessed SELF-EXCLUDED hash
  // (sha256 of the serialized body BEFORE the content_hash field is embedded
  // into the written file), records it in the roadmap_artifacts ledger, and
  // returns it. An earlier merge state re-hashed the final file bytes here —
  // bytes that now CONTAIN the embedded hash — which can never equal the
  // ledger's self-excluded value; the wave-41 pin (showRoadmap surfaces the
  // SAME content_hash the ledger records) caught the divergence on the
  // merged tree.
  return {
    ...artifact,
    sequence: written.sequence,
    path: written.path,
    currentPath: written.currentPath,
    latestPath: written.latestPath,
    content_hash: written.content_hash,
  };
}

/**
 * `swarm roadmap compile <run-id> --undo <sequence> [--apply]`
 *
 * F-d875b3c1 — compensator (workflow-standards NAMED_COMPENSATORS; no skip
 * allowed for an irreversible action):
 *
 *   Irreversible action: writeRoadmapArtifact (core's lib/roadmap/
 *   compiler.js) performs FOUR chained, non-atomic writes on every `swarm
 *   roadmap compile` — two file writes (the sequence-suffixed document +
 *   the sequence-free `<run-id>.json` mirror), a `latest.json` pointer
 *   overwrite, and a roadmap_artifacts ledger INSERT — with no dry-run/
 *   --apply gate and, until this fix, no compensator, unlike every sibling
 *   recovery verb in this package (reopen/close/redrive/rewind/revalidate/
 *   clean/adjudicate --undo). A process that reverts the file-tree half
 *   after the ledger row already committed (a `git checkout`/`git clean`, a
 *   crash, a concurrent peer wave compiling then cleaning up its own
 *   tracked-file writes) leaves the ledger permanently ahead of the tree —
 *   loadRoadmapArtifact trusts the ledger unconditionally, so `swarm
 *   roadmap show` (no explicit --version) then hard-ENOENTs. This is not
 *   hypothetical: it is the live state of run swarm-1784091637-5127 at the
 *   moment this fix was written (roadmap_artifacts sequence 2 pointing at a
 *   `.2.json` that was never committed and does not exist on disk).
 *
 *   Command-to-undo: `swarm roadmap compile <run-id> --undo <sequence>
 *   --apply` (this function). Dry-run by default, mirroring every other
 *   recovery verb in this package.
 *
 *   Post-rollback state: the targeted roadmap_artifacts row is gone.
 *   'latest' is DERIVED as MAX(sequence_number) (lib/roadmap/artifacts.js's
 *   own header) — removing the current-latest row un-latests it at the DB
 *   level automatically. If the next-highest remaining sequence's own file
 *   is present on disk, `latest.json` is REPOINTED to it (the same
 *   `{run_id, sequence, path}` shape writeRoadmapArtifact writes) so ledger
 *   and pointer stay in agreement; if that file is ALSO missing, or no
 *   sequence remains at all, `latest.json` is left untouched and the report
 *   carries an explicit `warning` — never a silent guess. Never touches any
 *   OTHER sequence's row or file (the DELETE is scoped to exactly
 *   `(run_id, sequence_number)`).
 *
 *   Owner: the operator (or coordinator) invoking --undo, naming the
 *   specific orphaned sequence surfaced by showRoadmap's
 *   ROADMAP_ARTIFACT_MISSING error (or a direct roadmap_artifacts read).
 *
 * Deliberately implemented with direct SQL against `roadmap_artifacts`
 * rather than a new lib/roadmap/artifacts.js export: that module is
 * swarm-cp-core's exclusive glob this wave (this file's own SEAM note,
 * above). lib/adjudication-store.js#deleteAdjudication /
 * commands/adjudicate.js#undoAdjudication already establish the identical
 * precedent one ledger table over — an otherwise-append-only, ledger-shaped
 * table getting one narrow, named, --apply-gated DELETE compensator, owned
 * by the commands-layer verb that needs it rather than the lib module that
 * doesn't.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {number} opts.sequence — the roadmap_artifacts.sequence_number to retire
 * @param {boolean} [opts.apply]
 * @returns {object} report
 */
export function undoRoadmapCompile(opts) {
  const { runId, dbPath, sequence, apply } = opts;
  if (!runId) throw new Error('roadmap compile --undo: <run-id> is required');
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw roadmapError(
      'ROADMAP_UNDO_INVALID_SEQUENCE',
      `roadmap compile --undo: sequence must be a positive integer (got ${JSON.stringify(sequence)})`,
      'pass the sequence number named in a ROADMAP_ARTIFACT_MISSING error, `swarm roadmap show <run-id> --format=json`, or a direct roadmap_artifacts read',
      { runId }
    );
  }

  const db = openDb(dbPath);
  const run = requireRun(db, runId);

  const target = db.prepare(
    'SELECT * FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = ?'
  ).get(runId, sequence);
  if (!target) {
    throw roadmapError(
      'ROADMAP_UNDO_NOT_FOUND',
      `roadmap compile --undo: no roadmap_artifacts row for run ${runId} at sequence ${sequence}`,
      `there is nothing to undo at sequence ${sequence} — a direct roadmap_artifacts read (or \`swarm roadmap show ${runId} --format=json\`) lists what sequences actually exist`,
      { runId, sequence }
    );
  }

  const currentLatest = db.prepare(
    'SELECT sequence_number FROM roadmap_artifacts WHERE run_id = ? ORDER BY sequence_number DESC LIMIT 1'
  ).get(runId);
  const wasLatest = !!currentLatest && currentLatest.sequence_number === sequence;
  const priorRow = db.prepare(
    'SELECT * FROM roadmap_artifacts WHERE run_id = ? AND sequence_number < ? ORDER BY sequence_number DESC LIMIT 1'
  ).get(runId, sequence);

  const targetAbsPath = resolvePath(run.local_path, target.path);
  const report = {
    dryRun: !apply,
    apply: !!apply,
    runId,
    target: {
      sequence: target.sequence_number,
      path: target.path,
      contentHash: target.content_hash,
      createdAt: target.created_at,
    },
    fileExists: existsSync(targetAbsPath),
    wasLatest,
    removed: false,
    newLatest: null,
    latestJsonRepointed: false,
    warning: null,
  };

  if (apply) {
    // Repoint (or warn) BEFORE the DELETE — a crash between the two steps
    // then leaves latest.json ALREADY correct while the ledger still has
    // the soon-to-be-removed row, so a re-run of this same --undo is still
    // correct and idempotent. The reverse order (DELETE first) would leave
    // the more confusing state: ledger says removed, latest.json still
    // names the removed sequence.
    if (wasLatest && priorRow) {
      const priorAbsPath = resolvePath(run.local_path, priorRow.path);
      report.newLatest = { sequence: priorRow.sequence_number, path: priorRow.path };
      if (existsSync(priorAbsPath)) {
        const latestJsonPath = joinPath(run.local_path, 'dogfood', 'roadmap', 'latest.json');
        atomicWriteFileSync(
          latestJsonPath,
          JSON.stringify({ run_id: runId, sequence: priorRow.sequence_number, path: priorRow.path }, null, 2)
        );
        report.latestJsonRepointed = true;
      } else {
        report.warning =
          `sequence ${priorRow.sequence_number} would become latest by ledger order, but its own file ` +
          `(${priorRow.path}) is ALSO missing on disk — left latest.json untouched. Undo that sequence too, ` +
          `inspect manually, or run \`swarm roadmap compile ${runId}\` for a fresh sequence.`;
      }
    } else if (wasLatest && !priorRow) {
      report.warning =
        `no remaining sequence for run ${runId} after this undo — if latest.json exists it now names a ` +
        `nonexistent sequence. Delete it manually, or run \`swarm roadmap compile ${runId}\` to produce a fresh one.`;
    }

    const result = db.prepare(
      'DELETE FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = ?'
    ).run(runId, sequence);
    report.removed = result.changes > 0;
  }

  return report;
}

/**
 * `swarm roadmap show <run-id> [--version=N]`
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {number} [opts.version]
 * @returns {object} report — `{ runId, compiled: false, version, ...residuals }`
 *   when nothing has been compiled yet, else
 *   `{ runId, compiled: true, ...artifact, ...residuals }`. `residuals` is
 *   A3.5's three named, NOT-persisted sections (`allowlist_overdue`,
 *   `unroutable_approved`, `deferred_stale`) — always present, live-computed
 *   against current DB/git state regardless of whether a roadmap has ever
 *   been compiled for this run (`show` is a live read, not merely an
 *   artifact echo).
 * @throws {Error} `ROADMAP_ARTIFACT_MISSING` (F-d875b3c1) when the
 *   roadmap_artifacts ledger names a sequence whose file is absent on disk
 *   — see that error's own construction, below, for why this is a named,
 *   recoverable state rather than a raw fs error.
 */
export function showRoadmap(opts) {
  const { runId, dbPath, version } = opts;
  if (!runId) throw new Error('roadmap show: <run-id> is required');

  const db = openDb(dbPath);
  const run = requireRun(db, runId);

  // A3.5: three named residuals — the allowlist-overdue registry (36-entry
  // scripts/regression-pin-allowlist.json, DISTINCT from grandfathered_drain
  // in the persisted artifact, which reads the 256-entry
  // scripts/grandfathered-pins.json manifest instead), findings 'approved'
  // but structurally unroutable to any domain, and deferred findings gone
  // stale by wave count (kept out of the persisted artifact entirely —
  // findings rows carry no owner column and owners are never invented).
  // All three surface here (and in dispatch's digest, per this wave's
  // dispatch.js changes) whether or not a roadmap has ever been compiled.
  const residuals = {
    allowlist_overdue: compileGrandfatheredManifestDrain(run.local_path),
    unroutable_approved: compileUnroutableApprovedDrain(db, runId),
    deferred_stale: compileDeferredFindingsDrain(db, runId),
  };

  let loaded;
  try {
    loaded = loadRoadmapArtifact(runId, { version, dbPath });
  } catch (e) {
    // F-d875b3c1: `swarm roadmap compile` has no compensator for its four
    // chained, non-atomic writes (two file writes + a latest.json overwrite
    // + a roadmap_artifacts ledger INSERT) — a reverted file-tree half (a
    // `git checkout`/`git clean`, a crash, a concurrent peer wave compiling
    // then cleaning up its own tracked-file writes) can leave the ledger
    // pointing at a sequence whose file no longer exists. loadRoadmapArtifact
    // (core's lib/roadmap/compiler.js) trusts the ledger unconditionally and
    // lets the underlying BoundedJsonError's raw `ERROR [ENOENT]: bounded-
    // json: cannot stat ...` propagate — an operator reading that has no way
    // to know this is a KNOWN, NAMED, recoverable state rather than
    // filesystem corruption. Name the repair instead of letting the raw fs
    // error speak for itself.
    throw roadmapError(
      'ROADMAP_ARTIFACT_MISSING',
      `roadmap show: the compiled artifact for run ${runId}` +
        (version != null ? ` (version ${version})` : ' (latest)') +
        ` is recorded in the ledger but missing on disk: ${e.message}`,
      `run \`swarm roadmap show ${runId} --format=json\` with an explicit ` +
        `--version=N to find a sequence that still resolves, then ` +
        `\`swarm roadmap compile ${runId} --undo <sequence> --apply\` to ` +
        `retire the orphaned ledger row, or \`swarm roadmap compile ${runId}\` ` +
        `to produce a fresh sequence`,
      { runId, version: version ?? null, cause: e }
    );
  }
  if (!loaded) {
    return { runId, compiled: false, version: version ?? null, ...residuals };
  }

  // F-113eefea/F-520023e7 axis 4: content_hash is not embedded in the
  // artifact's own JSON body (see compileRoadmap's identical note) — looked
  // up from the roadmap_artifacts ledger row this exact (run_id, sequence)
  // was loaded from. `loaded.sequence` is always present (writeRoadmapArtifact
  // embeds it into every persisted body); a missing ledger row at this point
  // would mean the ledger changed between loadRoadmapArtifact's own read and
  // this one — degrades to `null` rather than throwing, matching this
  // function's now-established "name real gaps, never fabricate" posture.
  const ledgerRow = db.prepare(
    'SELECT content_hash FROM roadmap_artifacts WHERE run_id = ? AND sequence_number = ?'
  ).get(runId, loaded.sequence);

  return {
    runId,
    compiled: true,
    ...loaded,
    content_hash: ledgerRow ? ledgerRow.content_hash : null,
    ...residuals,
  };
}

function renderNotesSection(lines, notes) {
  if (!notes) return;
  if (notes.active && notes.active.length > 0) {
    lines.push('Operator notes:');
    for (const n of notes.active) {
      const enforcer = n.enforced_by ? ` (enforced_by: ${escapePathForDisplay(n.enforced_by)})` : '';
      lines.push(`  [${n.kind}] ${escapeReasonForDisplay(n.text)}${enforcer}`);
    }
    lines.push('');
  }
  // T3: "compile drops expired notes loudly (listed in output as EXPIRED,
  // not silently omitted)".
  if (notes.expired && notes.expired.length > 0) {
    lines.push('EXPIRED (dropped from this compile):');
    for (const n of notes.expired) {
      lines.push(`  [${n.kind}] ${escapeReasonForDisplay(n.text)} (expired ${escapeReasonForDisplay(String(n.expires))})`);
    }
    lines.push('');
  }
}

function renderAttentionSection(lines, attention) {
  // A3.1: attention is {advisory, items[{file,score,components}]} — the
  // schema's own shape, consumed verbatim (no more flattening a `top[]`
  // array down to a synthesized {file,score} list).
  if (!attention || !Array.isArray(attention.items) || attention.items.length === 0) return;
  // T2: "never a gate, never a predictor, never auto-blame" — the header is
  // unmissable in text (and JSON, per the pass contract's own refusal),
  // matching cmdRoadmap's --format=json branch, which emits the report
  // object (including this same `attention` object) verbatim.
  lines.push('ADVISORY — NOT A GATE (per-file attention, top-K):');
  for (const a of attention.items) {
    lines.push(`  ${escapePathForDisplay(a.file)}  (score ${a.score})`);
  }
  lines.push('');
}

/**
 * A3.2(a): drain_queue = compileAuthoredDrainState's runs-ordinal shape
 * `{entries[{id,owner,cadence_runs,runs_since_review,overdue,reason?}],
 * overdue_ids[]}`. Renders "overdue drain state" (this wave's `swarm
 * roadmap show` surfacing task) in both `compile`'s and `show`'s text
 * output — the persisted artifact already carries it, so unlike the A3.5
 * residuals below this is not show-only.
 */
function renderDrainQueueSection(lines, drainQueue) {
  if (!drainQueue || !Array.isArray(drainQueue.entries) || drainQueue.entries.length === 0) return;
  lines.push('Drain queue (advisory — runs-ordinal cadence):');
  for (const e of drainQueue.entries) {
    const overdueTag = e.overdue ? '  [OVERDUE]' : '';
    const reasonClause = e.reason ? ` — ${escapeReasonForDisplay(e.reason)}` : '';
    lines.push(`  ${e.id} (owner: ${e.owner || 'unknown'}; ${e.runs_since_review}/${e.cadence_runs} runs)${overdueTag}${reasonClause}`);
  }
  if (Array.isArray(drainQueue.overdue_ids) && drainQueue.overdue_ids.length > 0) {
    lines.push(`  ${drainQueue.overdue_ids.length} overdue: ${drainQueue.overdue_ids.join(', ')}`);
  }
  lines.push('');
}

/**
 * A3.5: the three named residuals — SHOW-ONLY (never part of
 * formatRoadmapCompile's output; these are live reads against current
 * DB/git state, not a projection of what got persisted). Each section is
 * explicitly labeled "NOT persisted" so an operator reading `swarm roadmap
 * show`'s text output cannot mistake advisory, always-recomputed content
 * for something a re-run of `swarm roadmap compile` will remember.
 */
function renderResidualsSection(lines, residuals) {
  if (!residuals) return;
  const { allowlist_overdue: allowlistOverdue, unroutable_approved: unroutableApproved, deferred_stale: deferredStale } = residuals;

  if (allowlistOverdue && allowlistOverdue.available && allowlistOverdue.overdue.length > 0) {
    lines.push(`Allowlist overdue (advisory, NOT persisted — scripts/regression-pin-allowlist.json, ${allowlistOverdue.overdue.length}):`);
    for (const o of allowlistOverdue.overdue) {
      const reasonClause = o.reason ? ` — ${escapeReasonForDisplay(o.reason)}` : '';
      lines.push(`  ${o.finding_id} (owner: ${o.owner || 'unknown'}, due ${o.revalidate_by})${reasonClause}`);
    }
    lines.push('');
  }

  if (unroutableApproved && unroutableApproved.count > 0) {
    lines.push(`Unroutable approved findings (advisory, NOT persisted — no lawful domain/owner, ${unroutableApproved.count}):`);
    for (const f of unroutableApproved.findings) {
      lines.push(`  ${f.finding_id} (filed_by_domain: ${f.filed_by_domain || 'none'})`);
    }
    lines.push('');
  }

  if (deferredStale && Array.isArray(deferredStale.stale) && deferredStale.stale.length > 0) {
    lines.push(`Deferred findings gone stale (advisory, NOT persisted — no owner column, owners never invented, ${deferredStale.stale.length}):`);
    for (const f of deferredStale.stale) {
      lines.push(`  ${f.finding_id} (${escapePathForDisplay(f.file_path || '(no file)')}, ${f.waves_behind} waves behind)`);
    }
    lines.push('');
  }
}

export function formatRoadmapCompile(report) {
  const lines = [];
  lines.push(`Roadmap compiled — run ${report.run_id} (sequence ${report.sequence})`);
  lines.push(`  Artifact: ${escapePathForDisplay(report.path)}`);
  lines.push(`  Latest:   ${escapePathForDisplay(report.latestPath)}`);
  lines.push('');
  renderNotesSection(lines, { active: report.operator_notes, expired: report.expired_notes });
  renderAttentionSection(lines, report.attention);
  renderDrainQueueSection(lines, report.drain_queue);
  return lines.join('\n');
}

export function formatRoadmapShow(report) {
  if (!report.compiled) {
    const versionNote = report.version ? ` (version ${report.version})` : '';
    const lines = [`No roadmap compiled yet for run ${report.runId}${versionNote}.`, ''];
    renderResidualsSection(lines, report);
    lines.push(`Next: swarm roadmap compile ${report.runId}`);
    return lines.join('\n');
  }
  const lines = [];
  lines.push(`Roadmap — run ${report.run_id} (sequence ${report.sequence}, compiled ${report.compiled_at})`);
  lines.push('');
  renderNotesSection(lines, { active: report.operator_notes, expired: report.expired_notes });
  renderAttentionSection(lines, report.attention);
  renderDrainQueueSection(lines, report.drain_queue);
  renderResidualsSection(lines, report);
  return lines.join('\n');
}

/**
 * Human-readable report for `swarm roadmap compile --undo`. F-d875b3c1;
 * mirrors formatAdjudicationUndo's shape (commands/adjudicate.js) for the
 * sibling compensator this package already established.
 */
export function formatRoadmapUndo(report) {
  const verb = report.apply ? 'Undo (APPLIED)' : 'Undo (DRY-RUN)';
  const t = report.target;
  const lines = [];
  lines.push(`${verb} — run ${report.runId}, sequence ${t.sequence}`);
  lines.push(`  Artifact: ${escapePathForDisplay(t.path)}${report.fileExists ? '' : '  (MISSING on disk)'}`);
  lines.push(`  Was latest: ${report.wasLatest ? 'yes' : 'no'}`);
  if (report.apply) {
    lines.push(`  Removed: ${report.removed ? 'yes' : 'no (already gone)'}`);
    if (report.wasLatest) {
      lines.push(report.newLatest
        ? `  New latest: sequence ${report.newLatest.sequence}${report.latestJsonRepointed ? ' (latest.json repointed)' : ' (latest.json NOT repointed — see warning)'}`
        : '  New latest: none (no remaining sequence)');
    }
    if (report.warning) lines.push(`  WARNING: ${escapeReasonForDisplay(report.warning)}`);
  } else {
    lines.push('  Re-run with --apply to remove this ledger row.');
  }
  return lines.join('\n');
}
