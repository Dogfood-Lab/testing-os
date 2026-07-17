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
 * SEAM (wave 39) — read before touching this file at merge time
 * ============================================================================
 * `../lib/roadmap/compiler.js` does NOT exist in this worktree. swarm-cp-core
 * lands `lib/roadmap/` in its OWN worktree this same wave (per this wave's
 * dispatch). This file is coded against the CONTRACT below, derived directly
 * from the dispatch doc's own T1/T2/T5/T6 language — not against a real,
 * mergeable module today. It is red-in-isolation (any invocation of `swarm
 * roadmap compile|show` throws Cannot-find-module) until core's module
 * lands; cli.js loads this file via a DYNAMIC import inside cmdRoadmap so
 * the seam is contained to invocation time and never breaks module-load for
 * any OTHER verb (see cli.js's cmdRoadmap for the isolation mechanism, and
 * this repo's own wave-35 cli-smoke precedent for the red-in-isolation/
 * green-at-merge pattern this mirrors).
 *
 * Expected exports from `lib/roadmap/compiler.js`:
 *
 *   compileRoadmapSections(db, runId, { gitRoot }) -> {
 *     openFindings: object[], deferredFindings: object[],
 *     approvedFindings: object[], drainQueue: object[],
 *     recurrenceStats: object, attention: { file: string, score: number }[]
 *   }
 *     The T1 factual sections (queries executed AT COMPILE TIME against the
 *     control-plane DB + git alone — never authored) plus T2's advisory,
 *     labeled, ranked top-K attention list and T6's drain-queue rollup.
 *     MUST be pure/side-effect-free (no writes) — this function only reads.
 *
 *   writeRoadmapArtifact(runId, artifact, { dbPath }) -> {
 *     path: string, latestPath: string, sequence: number
 *   }
 *     T5: versions supersede, nothing rewrites. Writes `dogfood/roadmap/
 *     <run-id>.json` (+ `latest.json`); recompiling within a run supersedes
 *     with a new sequence number. `dbPath` (not a pre-resolved directory) is
 *     passed through DELIBERATELY: F-338c8c46 itself flags the exact repo-
 *     namespacing shape of this path as an OPEN QUESTION for the coordinator/
 *     schemas domain to resolve, not swarm-cp-verbs to decide unilaterally —
 *     so this CLI layer hands over the raw ingredient (mirroring how
 *     `getOutputDir(runId)` derives ITS base dir from `dirname(getDbPath())`
 *     rather than a hardcoded repo-relative default, so a run against a
 *     custom SWARM_DB/test temp DB never pollutes the real tree) and lets
 *     core's compiler own the actual directory-resolution decision, exactly
 *     the same authority split as `compileRoadmapSections` above.
 *
 *   loadRoadmapArtifact(runId, { version, dbPath }) -> object | null
 *     Read-only. `version` omitted = latest. Returns null when nothing has
 *     been compiled yet for this run (NOT an error — `swarm roadmap show`
 *     on a fresh run is a legitimate, common state).
 *
 * If core's real module differs from this contract, reconciling THIS file
 * (not the note-validation logic in commands/lib/roadmap-notes.js, which has
 * no dependency on it at all) is the merge follow-up.
 * ============================================================================
 */

import { existsSync } from 'node:fs';
import { relative as relativePath, resolve as resolvePath, join as joinPath, sep } from 'node:path';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { openDb } from '../db/connection.js';
import { readOperatorNotes, splitExpiredNotes, roadmapError } from './lib/roadmap-notes.js';
import { escapeReasonForDisplay, escapePathForDisplay } from './lib/escape-reason.js';
// SEAM: see this file's header. Does not exist in this worktree yet.
import { compileRoadmapSections, writeRoadmapArtifact, loadRoadmapArtifact } from '../lib/roadmap/compiler.js';
// F-1cd5de59's authored, run-ordinal drain-state half — additive to (never a
// replacement for) core's own two-halves compileDrainQueue, which lives
// inside compileRoadmapSections above and is left untouched.
import { compileAuthoredDrainState } from '../lib/roadmap/drain.js';

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
function deterministicNow(run) {
  const parsed = new Date(run.created_at);
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

  const sections = compileRoadmapSections(db, runId, { gitRoot: run.local_path, now });
  const drainState = compileAuthoredDrainState(db, run);

  const artifact = {
    runId,
    repo: run.repo,
    // F-520023e7: named to match packages/schemas/src/json/
    // dogfood-roadmap.schema.json's chosen field name (`compiled_at`, snake
    // case, matching every other schema-blessed field on this artifact) —
    // the VALUE is unchanged, still deterministicNow(run) (DB-derived, never
    // a live wall clock — F-feeaef78's determinism promise depends on it).
    compiled_at: now.toISOString(),
    // Flat, CLI-facing sections (F-1cd5de59/F-74ba2c79/F-8a97a700's own
    // pinned wire shape) — projections of `sections` (core's richer internal
    // shape), not a second independent compile.
    //
    // F-113eefea/F-520023e7: the nested `sections` object itself is
    // DELIBERATELY NOT persisted here (dropped, not renamed) — it duplicated
    // the same content the flat fields below already carry, nobody in this
    // domain's own code reads `.sections` (grepped: zero hits outside this
    // file before this fix), and the schema does not bless a `sections` key
    // at all (additionalProperties: false, no such property). `sections` is
    // still computed locally, above, purely to derive `attention` below.
    notes: active,
    expired,
    attention: flattenAttention(sections.attention),
    drain: { entries: drainState.entries, overdue_ids: drainState.overdue_ids },
    notesPath: toRepoRelativeNotesPath(run.local_path, notesPath),
  };

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
 * Projects core's rich `{ advisory, churn_available, top: [{file,
 * attention_score, factors}], truncated, total_candidates }` shape (T2,
 * lib/roadmap/attention.js) down to the flat `[{file, score}]` list the
 * CLI-facing artifact and dispatch's roadmap-digest injection (F-8a97a700)
 * both consume. Never throws on a missing/malformed input — an absent
 * attention section (e.g. a artifact compiled before this field existed)
 * degrades to an empty list, matching this module's overall degrade-not-throw
 * posture for advisory-only content.
 */
function flattenAttention(attention) {
  if (!attention || !Array.isArray(attention.top)) return [];
  return attention.top.map((a) => ({ file: a.file, score: a.attention_score }));
}

/**
 * `swarm roadmap show <run-id> [--version=N]`
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {number} [opts.version]
 * @returns {object} report — `{ runId, compiled: false, version }` when
 *   nothing has been compiled yet, else `{ runId, compiled: true, ...artifact }`
 * @throws {Error} `ROADMAP_ARTIFACT_MISSING` (F-d875b3c1) when the
 *   roadmap_artifacts ledger names a sequence whose file is absent on disk
 *   — see that error's own construction, below, for why this is a named,
 *   recoverable state rather than a raw fs error.
 */
export function showRoadmap(opts) {
  const { runId, dbPath, version } = opts;
  if (!runId) throw new Error('roadmap show: <run-id> is required');

  const db = openDb(dbPath);
  requireRun(db, runId);

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
    return { runId, compiled: false, version: version ?? null };
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

  return { runId, compiled: true, ...loaded, content_hash: ledgerRow ? ledgerRow.content_hash : null };
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
  if (!attention || attention.length === 0) return;
  // T2: "never a gate, never a predictor, never auto-blame" — the header is
  // unmissable in text (and JSON, per the pass contract's own refusal),
  // matching cmdRoadmap's --format=json branch, which emits the report
  // object (including this same flat `attention` array) verbatim.
  lines.push('ADVISORY — NOT A GATE (per-file attention, top-K):');
  for (const a of attention) {
    lines.push(`  ${escapePathForDisplay(a.file)}  (score ${a.score})`);
  }
  lines.push('');
}

export function formatRoadmapCompile(report) {
  const lines = [];
  lines.push(`Roadmap compiled — run ${report.runId} (sequence ${report.sequence})`);
  lines.push(`  Artifact: ${escapePathForDisplay(report.path)}`);
  lines.push(`  Latest:   ${escapePathForDisplay(report.latestPath)}`);
  lines.push('');
  renderNotesSection(lines, { active: report.notes, expired: report.expired });
  renderAttentionSection(lines, report.attention);
  return lines.join('\n');
}

export function formatRoadmapShow(report) {
  if (!report.compiled) {
    const versionNote = report.version ? ` (version ${report.version})` : '';
    return `No roadmap compiled yet for run ${report.runId}${versionNote}.\n` +
      `Next: swarm roadmap compile ${report.runId}`;
  }
  const lines = [];
  lines.push(`Roadmap — run ${report.runId} (sequence ${report.sequence}, compiled ${report.compiled_at})`);
  lines.push('');
  renderNotesSection(lines, { active: report.notes, expired: report.expired });
  renderAttentionSection(lines, report.attention);
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
