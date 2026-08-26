/**
 * dispatch.js — `swarm dispatch <phase>`
 *
 * Creates a wave, generates agent prompts for each domain, records agent_runs.
 *
 * Steps:
 * 1. Validate run exists and domains are frozen
 * 2. Create wave record
 * 3. Create agent_run records (one per domain)
 * 4. Generate prompts from templates
 * 5. Write prompts to disk for coordinator to dispatch
 * 6. Mark wave as dispatched
 */

import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { openDb } from '../db/connection.js';
import { readBoundedJson } from '../lib/bounded-json-read.js';
import { getDomains, aredomainsFrozen, freezeDomains, takeDomainSnapshot } from '../lib/domains.js';
import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from '../lib/templates.js';
import { buildPriorMap } from '../lib/fingerprint.js';
import { isOpenFinding } from '../lib/finding-status.js';
import { createWorktree, runShortOf } from '../lib/worktree.js';
import { findingsForDomain } from '../lib/findings-filter.js';
import { transitionAgent } from '../lib/state-machine.js';
import { IsolationError, DispatchPreconditionError } from '../lib/errors.js';
import { logStage } from '../lib/log-stage.js';
import { mintCorrelationId } from '../lib/correlation-id.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import { AUDIT_PHASES, AMEND_PHASES, renderPhaseList } from '../lib/phases.js';
import { escapePathForDisplay } from './lib/escape-reason.js';
import { readRoadmapSeedLineage } from './lib/roadmap-seed.js';
import { isAgentBearingDomain } from './lib/agent-bearing.js';

/**
 * D3B-003 (Wave A2 Stage C): emit a structured NDJSON event for a
 * dispatch precondition failure. Called BEFORE the typed throw so the
 * operator sees the failure as a coded event independent of whether the
 * top-level CLI handler manages to print the error envelope.
 */
function emitPreconditionFailed({ runId, phase, code, message }) {
  const correlationId = mintCorrelationId();
  logStage('dispatch_precondition_failed', {
    component: 'dogfood-swarm',
    correlation_id: correlationId,
    code,
    message,
    runId: runId || null,
    phase: phase || null,
  });
}

/**
 * Item 5 (Phase 2-B verification-discipline): the parallel-wave discipline
 * directive appended to amend prompts when --skip-verify is set. Tells the
 * agent NOT to run `npm test` / `npm run verify` (those reads observe the
 * cumulative tree as other parallel agents are still landing edits — a
 * Class #14 verifier-vantage-point limit). Agent emits
 * `verification_skipped: true` in its output JSON to mark the contract;
 * `commands/collect.js` propagates this into `report.serial_verify_required`
 * and the CLI surfaces the Next-step hint.
 */
export const SKIP_VERIFY_DIRECTIVE = `

## Verification discipline (parallel-wave)

This wave is running under the **serial-final-verify** discipline. Other agents are landing edits in parallel; running \`npm test\` / \`npm run verify\` from your worktree right now would observe a cumulative tree that is still in motion, producing measurement artifacts (e.g. a test that fails because a sibling agent hasn't yet landed its half of a coordinated fix).

**Do NOT run per-agent verification.** Make your edits, write your output JSON, and stop. The coordinator runs ONE \`npm run verify\` against the cumulative tree after \`swarm collect\` (PROTOCOL.md §Serial final verification).

Set \`verification_skipped: true\` at the top level of your output JSON to make the contract explicit:

\`\`\`json
{
  "domain": "...",
  "summary": "...",
  "fixes": [...],
  "files_changed": [...],
  "verification_skipped": true
}
\`\`\`
`;

/**
 * F-166ab759 (HIGH): no size bound anywhere on generated wave-brief .md
 * files. T4's roadmap-digest injection (ROADMAP_DIGEST_TOP_K, below) rests
 * on Lost-in-the-Middle (Liu et al. 2023, arXiv:2307.03172) -- a bounded
 * digest at the TOP of a brief is worthless if the REST of the brief is
 * free to grow unbounded underneath it wave over wave. This constant is the
 * WARN-first ceiling that closes that gap.
 *
 * Grounded in the measured, real distribution -- every wave-<N>/<domain>.md
 * brief this run has ever produced (276 files, `wc -c`, see this finding's
 * own amend-lane report for the exact command): sizes range from 2,573 bytes
 * (wave 1) to 1,090,242 bytes (wave 44, the current latest). The corpus is
 * NOT uniformly large -- it is two tiers, cleanly separable by phase:
 * `*-audit` waves (health-audit-a/b, stage-d-audit, feature-audit) carry
 * the accumulated findings-history + roadmap digest and grow ~monotonically
 * wave over wave (wave 3: 105KB -> wave 27: 718KB -> wave 44: 1,090KB);
 * `*-amend`/`*-execute` waves are scoped to just that wave's routed
 * findings and stay small throughout the run's entire history (a few KB to
 * ~30KB, NO growth trend). 750,000 sits at the real historical crossover
 * between the two tiers: the first brief to ever exceed it was wave 28's
 * health-audit-b (753,134 bytes), and every `*-audit` wave since has
 * stayed above it -- including feature-audit, which reset to a small base
 * at wave 38 (a fresh phase family, no accumulated digest yet) and has
 * ALREADY grown back past this threshold by wave 40. That makes this a
 * real, persistent, non-flaky signal on the current corpus, not a number
 * reverse-engineered to just barely catch today's max -- a threshold tuned
 * to ~1.09MB would need re-tuning within 1-2 more waves at the observed
 * growth rate; this one has 16+ waves of headroom behind it already.
 *
 * WARN, never fail: the live corpus already exceeds this ceiling on every
 * recent audit-phase wave, so a hard gate here would brick THIS run's own
 * next dispatch. Putting the corpus on a diet -- paginating findings-
 * history, capping the roadmap digest's own growth further, or archiving
 * old wave sections out of the live brief -- is next-cycle Director
 * material, not a call this WARN-first observability pass makes
 * unilaterally.
 */
export const WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES = 750_000;

/**
 * Derive the would-create worktree path + branch for a domain WITHOUT creating
 * anything. Mirrors lib/worktree.js#createWorktree's naming byte-for-byte so
 * the `--dry-run --isolate` preview names the exact path the apply path would
 * write. A change to createWorktree's naming must change here.
 *
 * @param {string} repoPath — run.local_path
 * @param {number} waveNumber
 * @param {string} domainName
 * @param {string} runId
 * @returns {{ worktreePath: string, branch: string }}
 */
function previewWorktree(repoPath, waveNumber, domainName, runId) {
  const runShort = runShortOf(runId);
  const branch = `swarm/${runShort}/w${waveNumber}-${domainName}`;
  // F-527dc73e: run-short slug in the directory name — must stay byte-for-byte
  // with lib/worktree.js#createWorktree.
  const worktreePath = join(repoPath, '.swarm', 'worktrees', `w${waveNumber}-${domainName}-${runShort}`);
  return { worktreePath, branch };
}

/**
 * The current roadmap's digest-relevant fields (T4), read from
 * `<repoLocalPath>/dogfood/roadmap/latest.json` — or, when `opts.forRunId`
 * is given, directly from `<repoLocalPath>/dogfood/roadmap/<forRunId>.json`
 * (T5's sequence-free content mirror, always kept current on every compile —
 * see lib/roadmap/compiler.js#writeRoadmapArtifact). The named-run path lets
 * a caller resolve a SPECIFIC prior run's digest rather than "whichever run
 * most recently compiled one in this checkout" (F-d110f547's ad hoc
 * `--roadmap-digest=<run-id>` and the seeded-run auto-injection gate both
 * need this — a run seeded from run A must not silently drift to reading
 * run B's digest just because B compiled something more recently in the
 * SAME checkout between seeding and dispatch).
 *
 * Tolerates BOTH shapes latest.json can legitimately hold (only relevant
 * on the no-forRunId path — an explicit `<run-id>.json` read is always the
 * full content mirror, never a pointer):
 *
 *   (1) A thin `{ run_id, sequence, path }` POINTER — the shape
 *       lib/roadmap/compiler.js#writeRoadmapArtifact actually writes for a
 *       REAL `swarm roadmap compile`. Resolved by reading the pointed-at
 *       artifact (repo-relative `path`) and using ITS `attention`/`drain`/
 *       `notes` fields.
 *   (2) The digest fields directly on latest.json itself — a fixture (or
 *       any future writer) that skips the pointer indirection.
 *
 * Absent/unreadable/malformed input degrades to `null` (no digest to seed),
 * never a throw — matching this package's established advisory-content
 * degrade-not-fail posture (getChurnStats, compileGrandfatheredManifestDrain).
 * Callers that must FAIL LOUD on a missing named artifact (the ad hoc
 * `--roadmap-digest=<run-id>` CLI path, per F-d110f547's "never silent in
 * either direction") check for a `null` return themselves and throw a
 * typed precondition error — this function stays uniformly degrade-only so
 * its behavior does not depend on which caller invoked it.
 *
 * H5 discipline: every read goes through the bounded reader rather than a
 * raw synchronous parse of the file contents — `latest.json`/`<run-id>.json`
 * and the artifact latest.json points at all live under the AUDITED repo's
 * checkout (run.local_path), the same "untrusted target-repo file" trust
 * class as lib/verify/adapters/node.js's package.json read.
 *
 * @param {string} repoLocalPath
 * @param {object} [opts]
 * @param {string} [opts.forRunId] — read this run's own content mirror
 *   directly instead of following latest.json.
 * @returns {{ attention?: Array, drain?: Array, notes?: Array } | null}
 */
function loadRoadmapDigestSource(repoLocalPath, opts = {}) {
  const { forRunId } = opts;
  const roadmapDir = join(repoLocalPath, 'dogfood', 'roadmap');
  const targetPath = forRunId ? join(roadmapDir, `${forRunId}.json`) : join(roadmapDir, 'latest.json');
  if (!existsSync(targetPath)) return null;

  let parsed;
  try {
    parsed = readBoundedJson(targetPath);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  if (forRunId) return parsed;

  const looksLikePointer = typeof parsed.path === 'string'
    && !Array.isArray(parsed.attention) && !Array.isArray(parsed.drain) && !Array.isArray(parsed.notes);
  if (!looksLikePointer) return parsed;

  const resolvedPath = join(repoLocalPath, parsed.path);
  if (!existsSync(resolvedPath)) return null;
  try {
    return readBoundedJson(resolvedPath);
  } catch {
    return null;
  }
}

/** Advisory attention/drain lists are bounded to this many lines each before
 * truncating with a "+N more" pointer (F-8a97a700(b): bounded even when the
 * underlying artifact is large, with the full artifact addressable on disk —
 * MemGPT-style paging, never a raw dump). */
const ROADMAP_DIGEST_TOP_K = 10;

/**
 * Renders the T4 roadmap-digest STRING passed as `buildAuditPrompt`'s
 * `opts.roadmapDigest` — plain text; templates.js's own
 * renderRoadmapDigestSection applies the neutralizeForPrompt/fenceSafeBlock
 * hardening (F-swarmcpcore-009), so this function does not need to.
 *
 * BOUNDED (F-8a97a700(b)): each of attention/drain is ranked (attention by
 * score DESC, a deterministic file-ASC tiebreak) and truncated to
 * ROADMAP_DIGEST_TOP_K, with an explicit "+N more, see <path>" line — never
 * a raw dump of a 200-file/500-entry artifact into every agent's prompt.
 *
 * A3 SHAPES (self-caught, this wave): reads the artifact's A3.1/A3.2(a)/
 * A3.4 section shapes — `attention.items[]` (not a bare array), `drain_queue.
 * entries[]` (not `drain`), `operator_notes[]` (not `notes`) — matching
 * commands/roadmap.js's own buildRoadmapArtifact mapping exactly, since both
 * read/write the SAME persisted artifact. An earlier revision of this
 * function still read the pre-A3 flat shapes (`source.attention` as a bare
 * array, `source.drain`, `source.notes`); against an A3-shaped artifact
 * every one of those checks silently failed its `Array.isArray`/truthiness
 * guard and rendered an EMPTY digest — no error, just nothing, the exact
 * silent-failure class T4's own contract text refuses to allow. DISCLOSED
 * RESIDUAL: a historical artifact compiled BEFORE this wave (pre-A3 shape)
 * would now read empty here too — T5's immutability guarantee means such
 * files can legitimately still exist on disk, but this function's own
 * degrade-to-nothing posture for absent/malformed content already treats
 * that identically to "no artifact at all" (a fully handled, non-error
 * state), and `--seed-from-roadmap`'s OWN schema gate (commands/lib/
 * roadmap-seed.js) independently refuses to seed a NEW run from a
 * non-conforming artifact in the first place, so a pre-A3 artifact cannot
 * reach this reader via the seeding path this wave adds — only via the
 * pre-existing, always-degrade-silently `--seed-roadmap`/latest.json
 * convenience path, which had no correctness guarantee about content shape
 * even before this fix.
 *
 * @param {string} repoLocalPath
 * @param {object} [opts]
 * @param {string} [opts.forRunId] — forwarded to loadRoadmapDigestSource;
 *   read a NAMED run's digest instead of "whatever latest.json says"
 *   (F-d110f547: the seeded-run auto-injection gate and the ad hoc
 *   `--roadmap-digest=<run-id>` escape hatch both need a specific run, not
 *   "whichever run most recently compiled one in this checkout").
 * @returns {string|undefined} — undefined when there is nothing to seed
 *   (no latest.json/<run-id>.json, or an empty/malformed one) so the caller
 *   can leave `roadmapDigest` unset entirely and templates.js's own
 *   `? ... : ''` renders nothing, exactly as if --seed-roadmap had never
 *   been passed.
 */
function buildRoadmapDigest(repoLocalPath, opts = {}) {
  const source = loadRoadmapDigestSource(repoLocalPath, opts);
  if (!source) return undefined;

  const pointerHint = 'dogfood/roadmap/latest.json';
  const lines = [];

  // F-6c030425 umbrella (reason-escaping-discipline.test.js's field-family
  // gate): `.file` is a named field-family member (git-derived, audited-repo
  // path) — escaped HERE, at the render line the mechanical scanner checks,
  // rather than relying solely on templates.js's downstream
  // neutralizeForPrompt. `id`/`owner`/`reason`/`kind`/`text` below are NOT
  // named family members and are deliberately left un-escaped at THIS line,
  // matching this same file's existing, already-allowlisted precedent for
  // opts.priorContext a few lines up in the render pipeline (buildPriorMap's
  // f.description/f.file_path join, F-d2d06af3): the WHOLE composed
  // roadmapDigest string still gets neutralizeForPrompt'd unconditionally at
  // its one render site (lib/templates.js's renderRoadmapDigestSection)
  // before reaching any agent, so adding a second, redundant escape call
  // here would only duplicate that protection, not add any.
  // A3.1: attention is {advisory, items[{file,score,components}]} — read
  // `.items`, never the bare array the pre-A3 shape had.
  const attention = source.attention && Array.isArray(source.attention.items) ? [...source.attention.items] : [];
  if (attention.length > 0) {
    attention.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    lines.push('Attention (advisory, ranked — never a gate):');
    for (const a of attention.slice(0, ROADMAP_DIGEST_TOP_K)) {
      lines.push(`- ${escapePathForDisplay(a.file)} (score ${a.score})`);
    }
    if (attention.length > ROADMAP_DIGEST_TOP_K) {
      lines.push(`- +${attention.length - ROADMAP_DIGEST_TOP_K} more, see ${pointerHint}`);
    }
  }

  // A3.2(a): drain_queue is {entries[{id,owner,cadence_runs,runs_since_review,
  // overdue,reason?}], overdue_ids[]} — the key itself is `drain_queue`, not
  // the pre-A3 `drain`.
  const drain = source.drain_queue && Array.isArray(source.drain_queue.entries) ? source.drain_queue.entries : [];
  if (drain.length > 0) {
    lines.push('');
    lines.push('Drain queue (advisory):');
    for (const d of drain.slice(0, ROADMAP_DIGEST_TOP_K)) {
      const reason = d.reason ? ` — ${d.reason}` : '';
      const overdueTag = d.overdue ? ' [OVERDUE]' : '';
      lines.push(`- ${d.id} (owner: ${d.owner || 'unknown'})${overdueTag}${reason}`);
    }
    if (drain.length > ROADMAP_DIGEST_TOP_K) {
      lines.push(`- +${drain.length - ROADMAP_DIGEST_TOP_K} more, see ${pointerHint}`);
    }
  }

  // A3.4: the persisted key is `operator_notes` (flat active-notes array),
  // never the pre-A3 `notes`.
  const notes = Array.isArray(source.operator_notes) ? source.operator_notes : [];
  if (notes.length > 0) {
    lines.push('');
    lines.push('Operator notes:');
    for (const n of notes) {
      lines.push(`- [${n.kind}] ${n.text}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.phase
 * @param {string} opts.dbPath
 * @param {string} opts.outputDir — where to write prompt files
 * @param {boolean} [opts.autoFreeze] — freeze domains if still draft
 * @param {boolean} [opts.isolate] — create per-agent worktrees
 * @param {boolean} [opts.skipVerify] — append the parallel-wave serial-final-
 *   verify directive to amend prompts (Item 5; tells agents not to run
 *   per-agent npm test, coordinator runs one verify at end)
 * @param {boolean} [opts.dryRun] — preview the wave shape (which domains become
 *   agents, the prompt paths that WOULD be written, per-domain approved-finding
 *   routing counts for amend phases, and the worktrees that WOULD be created
 *   under --isolate) WITHOUT any control-plane write, file write, or worktree
 *   creation. Returns a report with `dryRun: true` and `waveId: null`.
 * @param {boolean} [opts.seedRoadmap] — T4 (F-8a97a700): explicit opt-in to
 *   seed a bounded roadmap-digest section into every audit prompt this wave,
 *   read from `<run.local_path>/dogfood/roadmap/latest.json` if present.
 *   OFF by default — a prior run's roadmap must never leak into a new run's
 *   briefs absent this explicit flag (Q5: Semgrep's opt-in triage-propagation
 *   precedent; the same cross-boundary-trust class F-18d0ef6d/F-a9c399ce
 *   already warn against, moved from cross-domain to cross-run). See
 *   buildRoadmapDigest's own header for the bounding/truncation contract.
 *   Superseded as the PRIMARY seeding path by --seed-from-roadmap (below)
 *   once a run is init'd with it — kept working unchanged for an unseeded
 *   run/latest.json convenience, and composed as the final fallback in the
 *   resolution order F-d110f547 adds.
 * @param {boolean} [opts.noRoadmapDigest] — T4/F-d110f547: unconditionally
 *   suppresses roadmap-digest auto-injection for this dispatch, even when
 *   the run was seeded and this is its first audit-phase wave. Takes effect
 *   only when `opts.roadmapDigestRunId` is absent (an explicit ad hoc digest
 *   always wins — see that param).
 * @param {string} [opts.roadmapDigestRunId] — T4/F-d110f547: ad hoc escape
 *   hatch, `--roadmap-digest=<run-id>`. Forces a digest built from THIS
 *   named run's compiled roadmap onto THIS dispatch, bypassing both the
 *   seeded-lineage check and the first-audit-wave gate — the documented way
 *   to inject a digest on an unseeded run or a later wave. Unlike every
 *   other roadmap-digest source in this function, an unresolvable name here
 *   is a FAIL-LOUD precondition (DISPATCH_ROADMAP_DIGEST_NOT_FOUND), not a
 *   silent degrade to no-digest — the operator named a specific run this
 *   invocation; T4's contract text is explicit that the behavior must never
 *   be silent in either direction.
 * @returns {object} — { waveId, waveNumber, agents, promptDir, dryRun? }
 *
 * Atomicity contract (D3B-002, Wave A2 Stage C):
 *   The wave-build DB writes — INSERT INTO waves, UPDATE runs SET status,
 *   and the per-domain INSERT INTO agent_runs + transitionAgent loop — all
 *   run inside a single `db.transaction()`. On any throw the entire DB
 *   state rolls back to pre-dispatch (no half-built wave, no orphan
 *   agent_runs rows, no runs.status flip).
 *
 *   F-5b0996e4: filesystem-side effects split ACROSS the tx boundary, and
 *   the two halves are NOT symmetric — worktree creation (createWorktree,
 *   called inside the per-domain loop below) runs INSIDE the tx; prompt-
 *   file writes (atomicWriteFileSync, the loop after buildWave() returns)
 *   run OUTSIDE it. This corrects an earlier version of this header, which
 *   claimed BOTH were "EXPLICITLY outside the tx" — worktree creation never
 *   was; the inline note at the createWorktree call site (below) already
 *   described the true behavior ('a thrown IsolationError now propagates
 *   OUT of the surrounding db.transaction(), triggering full DB rollback.
 *   Worktrees successfully created before the failure remain on disk as FS
 *   orphans') ten lines apart from the header's contradicting claim.
 *
 *   Neither half is rolled back by a DB-tx abort: better-sqlite3 undoes SQL
 *   writes on a thrown transaction function, not filesystem writes a
 *   thrown IsolationError already performed. The trade-off: on a mid-loop
 *   IsolationError, every DB row rolls back (waves/agent_runs never
 *   existed), but worktrees already created for earlier domains in the
 *   SAME failed loop remain on disk as FS orphans — THIS is the actual
 *   source of the FS-orphan case, not the prompt loop (prompts are written
 *   only AFTER the tx has already committed, so a prompt-write failure
 *   never coincides with a DB rollback in the first place). The operator
 *   reclaims stranded worktrees with `swarm clean <run-id> --apply`, or
 *   finds any FS-orphaned prompt files from a later, successful-tx failure
 *   path with `find <outputDir> -name '*.md'` and re-dispatches. FS orphans
 *   are the better failure than a DB row that promises agents which never
 *   got their prompts.
 *
 *   Evaluated and deliberately NOT done in this pass: hoisting the
 *   createWorktree loop above buildWave() so the tx only ever INSERTs rows
 *   referencing already-created worktrees (which would make the header's
 *   original claim true, and shrink the write-lock hold time — the tx
 *   would no longer pay for N git subprocesses). Rejected here because it
 *   does not change the orphan-risk SHAPE (a hoisted loop that fails on
 *   domain K still leaves worktrees 1..K-1 on disk with no DB rows
 *   referencing them — same class of orphan, different phase) and it is a
 *   structural reorder that touches every dispatch-tx regression pin
 *   (amend2-d3b-002-dispatch-tx, dispatch-state-machine, dispatch-amend-
 *   filter, dispatch-prompt-schema) — a follow-up with its own dedicated
 *   verification pass, not a LOW-severity doc fix.
 *
 *   better-sqlite3 nests transactions cleanly — the inner
 *   `transitionAgent → executeTransition` self-wrap from Wave-A1 H9
 *   becomes a SAVEPOINT inside the outer wave-build tx.
 */
export function dispatch(opts) {
  const db = openDb(opts.dbPath);

  // 0. Validate phase BEFORE anything touches the control plane.
  //
  // d5-swarm-cli-001 (HIGH): a phase typo (e.g. `helth-audit-a`) used to slip
  // past every guard here — AUDIT_PHASES / AMEND_PHASES were only consulted
  // later to set isAudit/isAmend (both false on a bad phase) — so buildWave()
  // INSERTed the waves row, flipped runs.status to the typo string, INSERTed
  // agent_runs, and COMMITTED. Only the prompt-render loop (lib/templates.js)
  // then threw a plain untyped `Unknown audit phase` Error, AFTER the commit.
  // That left the exact "DB row that promises agents which never got their
  // prompts" state this function's header (below) promises NEVER to create,
  // and surfaced as the flat `ERROR:` form instead of the structured
  // DISPATCH_* envelope its sibling preconditions get. Gate it here as a
  // pre-commit precondition: no DB mutation, structured error + actionable
  // hint listing the valid phases. This is the same emitPreconditionFailed +
  // typed-throw shape as the run-not-found / domains-not-frozen / no-domains
  // guards below.
  if (!AUDIT_PHASES.includes(opts.phase) && !AMEND_PHASES.includes(opts.phase)) {
    const validPhases = renderPhaseList();
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_INVALID_PHASE',
      message: `Unknown phase: ${opts.phase}`,
    });
    throw new DispatchPreconditionError(`Unknown phase: ${opts.phase}`, {
      code: 'DISPATCH_INVALID_PHASE',
      runId: opts.runId,
      phase: opts.phase,
      hint: `valid phases: ${validPhases}`,
    });
  }

  // 1. Validate run
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) {
    // D3B-003 (Wave A2 Stage C): structured precondition failure with a
    // stable .code so the CLI top-level handler can render an actionable
    // hint, and a logStage event emitted BEFORE the throw so NDJSON
    // consumers see the precondition failure as an explicit signal.
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_RUN_NOT_FOUND',
      message: `Run not found: ${opts.runId}`,
    });
    throw new DispatchPreconditionError(`Run not found: ${opts.runId}`, {
      code: 'DISPATCH_RUN_NOT_FOUND',
      runId: opts.runId,
      phase: opts.phase,
      hint: `check \`swarm runs\` for the correct run id, or \`swarm init <repo>\` to create one`,
    });
  }

  // Check domains are frozen (or auto-freeze). In dry-run, --auto-freeze is a
  // mutation, so we do NOT freeze — a dry-run against a draft map still
  // previews the shape against the current draft domains. Only the
  // non-auto-freeze precondition (operator forgot to freeze AND did not ask to)
  // throws, which is the same fail-loud signal the apply path gives.
  if (!aredomainsFrozen(db, opts.runId)) {
    if (opts.autoFreeze && !opts.dryRun) {
      freezeDomains(db, opts.runId);
    } else if (opts.autoFreeze && opts.dryRun) {
      // dry-run + auto-freeze: skip the mutation, proceed with draft domains.
    } else {
      emitPreconditionFailed({
        runId: opts.runId,
        phase: opts.phase,
        code: 'DISPATCH_DOMAINS_NOT_FROZEN',
        message: 'Domains are not frozen. Review and freeze before dispatching, or pass --auto-freeze.',
      });
      throw new DispatchPreconditionError(
        'Domains are not frozen. Review and freeze before dispatching, or pass --auto-freeze.',
        {
          code: 'DISPATCH_DOMAINS_NOT_FROZEN',
          runId: opts.runId,
          phase: opts.phase,
          hint: `run \`swarm domains ${opts.runId} --freeze\` after reviewing, or re-run dispatch with --auto-freeze`,
        }
      );
    }
  }

  const domains = getDomains(db, opts.runId);
  if (domains.length === 0) {
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_NO_DOMAINS',
      message: 'No domains defined for this run',
    });
    throw new DispatchPreconditionError('No domains defined for this run', {
      code: 'DISPATCH_NO_DOMAINS',
      runId: opts.runId,
      phase: opts.phase,
      hint: `run \`swarm domains ${opts.runId} --add <name> --globs "[...]"\` then --freeze`,
    });
  }

  // F-3c8a62f1: the guard above checks the PRE-filter domain list; the
  // per-domain loop below (and the dry-run preview mirror of it) acts on
  // the POST-filter list — `shared` is a zone, not an agent, and is
  // `continue`d past every place an agent gets created. A domain map that
  // is non-empty but ALL `shared` (a real `swarm init` outcome on a repo
  // with no .md/src/lib/packages/tests — see F-6a78ffdd's reachability
  // note) sailed past `domains.length === 0`, then the loop created ZERO
  // agents, committed a wave with agentCount: 0, and exited 0 reporting
  // success — the exact same class of bug as this wave's own
  // F-a5f6b585 (redrive.js): a guard that polices a DIFFERENT set than the
  // one the code actually acts on. The wedge compounds: the next dispatch
  // then throws DISPATCH_WAVE_IN_FLIGHT ('still dispatched') PERMANENTLY,
  // since the zero-agent wave can never collect. Distinct code from
  // DISPATCH_NO_DOMAINS — two different causes ('no domains at all' vs
  // 'domains exist but none are agent-bearing') get two different
  // diagnostics, so the message names the real condition instead of
  // collapsing back into the same "doesn't name the actual cause" failure
  // one layer up.
  // F-2710aadf / GitHub #67 (verbs half): skip shared AND coordinator —
  // coordinator is exclusive-and-not-dispatched (core owns the class enum).
  const agentBearingDomains = domains.filter(isAgentBearingDomain);
  if (agentBearingDomains.length === 0) {
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_NO_AGENT_DOMAINS',
      message: `Every domain in the frozen map (${domains.length}) is class 'shared' or 'coordinator'; neither receives an agent`,
    });
    throw new DispatchPreconditionError(
      `Every domain in the frozen map (${domains.length}) is class 'shared' or 'coordinator' — ` +
      `shared is a zone and coordinator is exclusive-and-not-dispatched. ` +
      `Dispatching would create zero agent_runs, commit a wave reporting success, and permanently block future ` +
      `dispatch on DISPATCH_WAVE_IN_FLIGHT (the zero-agent wave can never collect).`,
      {
        code: 'DISPATCH_NO_AGENT_DOMAINS',
        runId: opts.runId,
        phase: opts.phase,
        hint: `run \`swarm domains ${opts.runId} --edit <name> --ownership owned\` (or --add a new owned/bridge domain) so at least one domain can carry an agent`,
      }
    );
  }

  // F-cf8b7a6c: refuse to open a NEW wave while another wave of this run is
  // still in flight. collect/resume/advance all operate on the LATEST wave
  // only, so an older 'dispatched' wave would be stranded forever: it
  // permanently satisfies hasActiveWave (blocking `swarm domains --unfreeze`),
  // its agents run until timeout, and its outputs can never be collected. The
  // classic trigger is an operator retry after a slow first dispatch.
  const inFlightWave = db.prepare(`
    SELECT id, wave_number, phase, status FROM waves
    WHERE run_id = ? AND status IN ('dispatched', 'collecting')
    ORDER BY wave_number DESC LIMIT 1
  `).get(opts.runId);
  if (inFlightWave) {
    emitPreconditionFailed({
      runId: opts.runId,
      phase: opts.phase,
      code: 'DISPATCH_WAVE_IN_FLIGHT',
      message: `Wave ${inFlightWave.wave_number} (${inFlightWave.phase}) is still '${inFlightWave.status}'`,
    });
    throw new DispatchPreconditionError(
      `Wave ${inFlightWave.wave_number} (${inFlightWave.phase}) is still '${inFlightWave.status}' — dispatching a new wave would strand it.`,
      {
        code: 'DISPATCH_WAVE_IN_FLIGHT',
        runId: opts.runId,
        phase: opts.phase,
        hint: `finish the in-flight wave first: \`swarm collect ${opts.runId}\` (or \`swarm resume ${opts.runId}\` / \`swarm redrive ${inFlightWave.id}\` / \`swarm rewind\` if it is unrecoverable)`,
      }
    );
  }

  // F-7970a30b: dispatching over a FAILED wave with blocked agents is a
  // legitimate abandon-and-retry choice (the in-flight guard above only
  // covers dispatched/collecting), but it silently closes the `swarm
  // revalidate` window — revalidate reads the LATEST wave regardless of
  // status, so the failed wave's invalid_output / ownership_violation agents
  // become unreachable by the lawful repair verb the moment this dispatch
  // lands. Warn loudly at dispatch time; `swarm redrive <wave-id>` (explicit
  // wave id) remains the surviving recovery path. Observability only — never
  // a gate.
  let supersededFailedWave = null;
  {
    const latestWave = db.prepare(`
      SELECT id, wave_number, phase, status FROM waves
      WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1
    `).get(opts.runId);
    if (latestWave && latestWave.status === 'failed') {
      const blockedRows = db.prepare(`
        SELECT ar.id FROM agent_runs ar
        WHERE ar.wave_id = ?
          ${LATEST_AGENT_RUN_PER_DOMAIN}
          AND ar.status IN ('invalid_output', 'ownership_violation')
      `).all(latestWave.id);
      if (blockedRows.length > 0) {
        supersededFailedWave = {
          waveId: latestWave.id,
          waveNumber: latestWave.wave_number,
          phase: latestWave.phase,
          blockedAgents: blockedRows.length,
          message:
            `wave ${latestWave.wave_number} (id ${latestWave.id}) is 'failed' with ` +
            `${blockedRows.length} blocked agent_run(s). Once this dispatch lands, ` +
            `\`swarm revalidate\` (which reads the LATEST wave) can no longer reach it — ` +
            `post-dispatch recovery narrows to \`swarm redrive ${latestWave.id} --reason "<text>" --apply\` or manual repair.`,
        };
        logStage('dispatch_supersedes_failed_wave', {
          component: 'dogfood-swarm',
          correlation_id: mintCorrelationId(),
          runId: opts.runId,
          phase: opts.phase,
          failedWaveId: latestWave.id,
          failedWaveNumber: latestWave.wave_number,
          blockedAgents: blockedRows.length,
          hint: `swarm redrive ${latestWave.id} --reason "<text>" --apply`,
        });
      }
    }
  }

  // 2. Take domain snapshot (read-side prep; no commits here yet).
  const snapshot = takeDomainSnapshot(db, opts.runId);

  const lastWave = db.prepare(
    'SELECT MAX(wave_number) as n FROM waves WHERE run_id = ?'
  ).get(opts.runId);
  const waveNumber = (lastWave?.n || 0) + 1;

  // 3. Classify phase. The prompt dir + prior context are FS/read-side prep;
  // the dry-run branch below short-circuits before either is materialized.
  const isAudit = AUDIT_PHASES.includes(opts.phase);
  const isAmend = AMEND_PHASES.includes(opts.phase);

  // T4/F-d110f547: whether THIS dispatch would be the run's FIRST
  // audit-phase wave — read from the PRE-dispatch waves table, BEFORE
  // buildWave() inserts this wave's own row below. Querying this AFTER the
  // insert would make every audit-phase dispatch see its own just-created
  // row and permanently read as "not first". Only meaningful for audit
  // phases; a bare `AUDIT_PHASES.includes` short-circuit keeps the query
  // off the amend-dispatch hot path entirely.
  const isFirstAuditPhaseWaveOfRun = isAudit && !db.prepare(`
    SELECT 1 FROM waves WHERE run_id = ? AND phase IN (${AUDIT_PHASES.map(() => '?').join(',')}) LIMIT 1
  `).get(opts.runId, ...AUDIT_PHASES);

  // T4/F-d110f547: resolve roadmapDigest's FINAL value now, BEFORE the
  // dry-run branch and BEFORE buildWave()'s transaction — not in the
  // post-commit prompt-rendering section further down, where this file's
  // OTHER preconditions never run. A fail-loud --roadmap-digest=<run-id>
  // typo must abort before any DB mutation, matching every sibling
  // precondition above (phase validity, run existence, domains frozen);
  // discovering it only after the wave/agent_runs rows already committed
  // would strand exactly the "DB row that promises agents which never got
  // their prompts" state this function's own header names as the thing
  // dispatch must never create.
  //
  // Three independent knobs, evaluated in explicit precedence order so the
  // behavior is NEVER silent in either direction (T4's own words):
  //
  //   1. opts.roadmapDigestRunId (ad hoc, --roadmap-digest=<run-id>) ALWAYS
  //      wins when present — bypasses BOTH the seeded-lineage check and the
  //      first-audit-wave gate, so an operator can inject a digest on an
  //      unseeded run or a later wave. A missing/invalid source artifact is
  //      a FAIL-LOUD precondition (the operator named a specific run this
  //      invocation; silently rendering nothing would be the exact silent
  //      failure T4 refuses to allow) — the only roadmapDigest source in
  //      this function that does not degrade quietly.
  //   2. Else opts.noRoadmapDigest (--no-roadmap-digest) suppresses
  //      auto-injection outright, regardless of seeding/wave-position.
  //   3. Else AUTO-INJECT iff this run was seeded (commands/init.js's
  //      --seed-from-roadmap, stamped via readRoadmapSeedLineage) AND this
  //      dispatch is the FIRST audit-phase wave of the run (T4: "injects...
  //      at the TOP of audit briefs" — subsequent audit phases build their
  //      OWN accumulating findings history via priorContext/
  //      openPriorContext, so re-injecting a prior run's digest there would
  //      be redundant). Degrades to undefined on any resolution failure —
  //      advisory content, the SAME posture the pre-existing
  //      opts.seedRoadmap path already has — falling back to that
  //      seed-run's own stamped artifact first, then (if it has since
  //      rotted off disk) to whatever latest.json currently names, so a
  //      seeded run never regresses below the unseeded convenience.
  //
  // opts.seedRoadmap (the ORIGINAL F-8a97a700 flag) stays wired exactly as
  // before for back-compat: an unseeded run dispatched with --seed-roadmap
  // keeps working unchanged, composed here as the final fallback.
  let roadmapDigest;
  if (opts.roadmapDigestRunId) {
    const forced = buildRoadmapDigest(run.local_path, { forRunId: opts.roadmapDigestRunId });
    if (forced === undefined) {
      emitPreconditionFailed({
        runId: opts.runId,
        phase: opts.phase,
        code: 'DISPATCH_ROADMAP_DIGEST_NOT_FOUND',
        message: `--roadmap-digest=${opts.roadmapDigestRunId}: no compiled roadmap artifact found`,
      });
      throw new DispatchPreconditionError(
        `--roadmap-digest=${opts.roadmapDigestRunId}: no compiled roadmap artifact found ` +
        `(dogfood/roadmap/${opts.roadmapDigestRunId}.json is absent or empty under ${run.local_path})`,
        {
          code: 'DISPATCH_ROADMAP_DIGEST_NOT_FOUND',
          runId: opts.runId,
          phase: opts.phase,
          hint: `run \`swarm roadmap compile ${opts.roadmapDigestRunId}\` first, or check \`swarm roadmap show ${opts.roadmapDigestRunId}\``,
        }
      );
    }
    roadmapDigest = forced;
  } else if (opts.noRoadmapDigest) {
    roadmapDigest = undefined;
  } else {
    const seedLineage = readRoadmapSeedLineage(db, opts.runId);
    if (seedLineage && isFirstAuditPhaseWaveOfRun) {
      roadmapDigest = buildRoadmapDigest(run.local_path, { forRunId: seedLineage.source_run_id })
        ?? buildRoadmapDigest(run.local_path);
    } else {
      roadmapDigest = opts.seedRoadmap ? buildRoadmapDigest(run.local_path) : undefined;
    }
  }

  const promptDirPath = join(opts.outputDir, `wave-${waveNumber}`);

  // F-aa32371b: approved findings that route to NO domain agent — a finding
  // with no file_path (repo-level finding), or whose path matches no owned
  // glob, is excluded from every amend prompt by findingsForDomain and would
  // otherwise be silently unfixable while its OPEN 'approved' status blocks
  // the finding-severity gate forever. Surface them loudly at dispatch time
  // (report field + NDJSON event; the CLI prints the warning) with the
  // recovery paths named.
  let unroutedApprovedFindings = [];
  if (isAmend) {
    const approved = db.prepare(
      "SELECT finding_id, severity, file_path FROM findings WHERE run_id = ? AND status = 'approved'"
    ).all(opts.runId);
    const routedIds = new Set();
    for (const domain of domains) {
      if (!isAgentBearingDomain(domain)) continue;
      for (const f of findingsForDomain(db, opts.runId, domain)) routedIds.add(f.finding_id);
    }
    unroutedApprovedFindings = approved
      .filter(f => !routedIds.has(f.finding_id))
      .map(f => ({ finding_id: f.finding_id, severity: f.severity, file_path: f.file_path }));
    if (unroutedApprovedFindings.length > 0) {
      logStage('unrouted_approved_findings', {
        component: 'dogfood-swarm',
        correlation_id: mintCorrelationId(),
        runId: opts.runId,
        phase: opts.phase,
        waveNumber,
        count: unroutedApprovedFindings.length,
        finding_ids: unroutedApprovedFindings.map(f => f.finding_id),
        hint: 'these findings block the severity gate but are routed to zero agents. To CLOSE them: land the fix, then `swarm resolve <run-id> --ids F-001,F-002 --evidence "<one line>"` — the coordinator_resolved path as a verb (persists coordinator_resolved + verified_via_evidence so `swarm verify-fixed <run-id>` classifies the closure as allowlist; no raw SQL); or DISPOSE without a fix via `swarm defer <run-id> --ids F-001,F-002 --reason "<text>"` (accepted/postponed) / `swarm reject <run-id> --ids F-001,F-002 --reason "<text>"` (not-a-defect) — both close the finding for the gate.',
      });
    }
  }

  // 3a. Dry-run / preview: compute the wave shape with ZERO side effects — no
  // DB write (waves/agent_runs/runs.status), no prompt files, no worktree
  // creation. Owned + bridge domains become agents; shared is a zone, not an
  // agent. For amend phases each agent carries its approved-finding routing
  // count (the same findingsForDomain filter the apply path uses). Under
  // --isolate the would-create worktree path + branch are derived
  // deterministically from createWorktree's naming (NOT created here). This
  // branch is the operator's "what will this dispatch do?" preview and is the
  // reason it sits before the buildWave transaction.
  if (opts.dryRun) {
    const previewAgents = [];
    for (const domain of domains) {
      if (!isAgentBearingDomain(domain)) continue;
      const agent = {
        domain: domain.name,
        domainId: domain.id,
        ownershipClass: domain.ownership_class,
        promptPath: join(promptDirPath, `${domain.name}.md`),
        worktreePath: null,
        worktreeBranch: null,
      };
      if (isAmend) {
        agent.approvedFindingCount = findingsForDomain(db, opts.runId, domain).length;
      }
      if (opts.isolate) {
        const wt = previewWorktree(run.local_path, waveNumber, domain.name, opts.runId);
        agent.worktreePath = wt.worktreePath;
        agent.worktreeBranch = wt.branch;
      }
      previewAgents.push(agent);
    }
    return {
      dryRun: true,
      waveId: null,
      waveNumber,
      phase: opts.phase,
      isolate: !!opts.isolate,
      skipVerify: !!opts.skipVerify,
      domainSnapshotId: snapshot.snapshotId,
      promptDir: promptDirPath,
      agents: previewAgents,
      unroutedApprovedFindings,
      supersededFailedWave,
    };
  }

  // 3b. Build prompt dir + prep prior context (FS / read-side prep only — none
  // of this writes to the DB).
  const promptDir = promptDirPath;
  if (!existsSync(promptDir)) mkdirSync(promptDir, { recursive: true });

  // CLOSED and OPEN priors go to the agent as SEPARATE lists carrying opposite
  // instructions. classifyFindings closes an absent prior as `fixed` when the
  // wave had full coverage — an inference that holds only if the agent would
  // have re-reported a defect that was still there. Emitting one flat
  // "do NOT re-report these" list (what this did before) made that impossible
  // for OPEN priors and turned their absence into self-fulfilling evidence:
  // wave 28 of run swarm-1784091637-5127 closed 9 untouched findings that way,
  // with no amend wave anywhere between them and the prior audit. Closed priors
  // are unaffected — classifyFindings already treats them as terminal-when-
  // absent, so nothing is ever inferred from silence about them.
  let priorContext = '';
  let openPriorContext = '';
  if (isAudit) {
    const priorMap = buildPriorMap(db, opts.runId);
    if (priorMap.size > 0) {
      const closedLines = [];
      const openLines = [];
      for (const [, f] of priorMap) {
        const line = `- [${f.status}] ${f.finding_id}: ${f.description} (${f.file_path || '?'})`;
        (isOpenFinding(f.status) ? openLines : closedLines).push(line);
      }
      priorContext = closedLines.join('\n');
      openPriorContext = openLines.join('\n');
    }
  }

  // 4. Wave-build tx (D3B-002): waves INSERT + runs UPDATE + per-domain
  // INSERT agent_runs + transitionAgent ALL land or none do. Prompts and
  // worktrees are FS-side and stay outside the tx — see header for the
  // FS-orphan trade-off.
  // F-0e55b5ca: capture the repo HEAD as this wave's diff base BEFORE the
  // wave-build tx (an FS read, not a DB write). runs.commit_sha is stamped
  // once at `swarm init` and goes stale as waves land commits; using it as
  // the non-isolated collect probe base attributed every prior wave's edits
  // to THIS wave's agents. NULL when the probe fails (bare dir in tests,
  // git unavailable) — collect falls back to runs.commit_sha, its legacy
  // behavior.
  let dispatchSha = null;
  try {
    dispatchSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: run.local_path, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch { dispatchSha = null; }

  const agents = [];
  let waveId;
  const buildWave = db.transaction(() => {
    const waveResult = db.prepare(`
      INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id, dispatch_sha)
      VALUES (?, ?, ?, 'dispatched', ?, ?)
    `).run(opts.runId, opts.phase, waveNumber, snapshot.snapshotId, dispatchSha);
    waveId = waveResult.lastInsertRowid;

    db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(opts.phase, opts.runId);

    // F-ec97601a: persist the --skip-verify discipline choice on the wave so
    // `swarm resume` can re-render redispatch prompts WITH the
    // SKIP_VERIFY_DIRECTIVE. Pre-fix the choice lived only in the originally
    // rendered prompt text — a redispatched amend agent in a
    // serial-final-verify wave would run `npm test` against the cumulative
    // in-motion tree (the exact measurement artifact Item 5 prevents).
    if (opts.skipVerify && isAmend) {
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)')
        .run(`wave:${waveId}:skip_verify`, '1');
    }

    for (const domain of domains) {
      // Only dispatch owned + bridge domains as agents (shared is a zone;
      // coordinator is exclusive-and-not-dispatched — F-2710aadf / #67).
      if (!isAgentBearingDomain(domain)) continue;

      // Create worktree if isolation is enabled.
      //
      // F-693631-001 (wave-12): the prior bare catch silently fell back to
      // running the agent in the main repo while the operator believed
      // --isolate was in effect. Re-emergence of F-742440-007 from wave-1.
      // Isolation is a contract — fail loud. The CLI is responsible for
      // catching IsolationError and exiting non-zero.
      //
      // D3B-002 (Wave A2): a thrown IsolationError now propagates OUT of
      // the surrounding db.transaction(), triggering full DB rollback.
      // Worktrees successfully created before the failure remain on disk
      // as FS orphans (documented FS-degradation in the function header).
      let worktreePath = null;
      let worktreeBranch = null;
      if (opts.isolate) {
        try {
          const wt = createWorktree(run.local_path, {
            runId: opts.runId,
            waveNumber,
            domainName: domain.name,
          });
          worktreePath = wt.worktreePath;
          worktreeBranch = wt.branch;
        } catch (e) {
          // FT-PIPELINE-004 cross-fix-dep: correlation_id pins the dispatch
          // failure across stderr, the rendered IsolationError, and any
          // resume-path follow-up. Wave-22 wrapper-strip pattern preserved by
          // calling logStage directly with the id at the outer envelope.
          const correlationId = mintCorrelationId();
          logStage('isolate_failed', {
            correlation_id: correlationId,
            err: e.message,
            runId: opts.runId,
            waveNumber,
            domain: domain.name,
            repoPath: run.local_path,
          });
          throw new IsolationError(
            `--isolate requested but worktree creation failed for domain=${domain.name}: ${e.message}`,
            { cause: e }
          );
        }
      }

      // Insert at 'pending' then transition to 'dispatched' through the state
      // machine. This is the canonical path used by resume.js — it writes
      // started_at via executeTransition() and emits a `pending → dispatched`
      // event to agent_state_events, satisfying the state-machine.js header
      // invariant that "Every agent_run status change MUST go through this
      // module" / "Every legal transition is logged". Direct INSERT with
      // status='dispatched' bypassed both, leaving started_at NULL and silently
      // breaking applyTimeoutPolicy() (F-002109-003 / F-002 symptom).
      const agentResult = db.prepare(`
        INSERT INTO agent_runs (wave_id, domain_id, status, worktree_path, worktree_branch)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(waveId, domain.id, worktreePath, worktreeBranch);
      const agentRunId = Number(agentResult.lastInsertRowid);
      transitionAgent(db, agentRunId, 'dispatched', 'initial dispatch');

      // Stash the agent record so the prompt-write loop below can run
      // outside the tx (FS work stays out of the DB tx by design — see
      // D3B-002 header trade-off).
      agents.push({
        agentRunId,
        domain,
        worktreePath,
        worktreeBranch,
      });
    }
  });
  buildWave();

  // 5. Prompt rendering + atomicWriteFileSync — FS-side, intentionally
  // outside the DB tx. A throw here leaves DB state intact (agents are
  // already committed) and the operator can re-render with the prompt-
  // generator helpers; the wave is recoverable via `swarm resume` because
  // the agent rows exist with status=dispatched.
  //
  // F-8a97a700 / F-d110f547 (T4): roadmapDigest itself is already resolved
  // above, BEFORE buildWave()'s transaction (see that block's own comment
  // for why a fail-loud --roadmap-digest=<run-id> precondition cannot live
  // here, after the wave/agent_runs rows already committed). Computed ONCE
  // for the whole wave, not per-agent — the digest is the same cross-run
  // targeting context regardless of which domain is reading it.

  const builtAgents = [];
  for (const a of agents) {
    const domain = a.domain;
    const agentWorkDir = a.worktreePath || run.local_path;
    const promptOpts = {
      repoPath: agentWorkDir,
      repo: run.repo,
      domainName: domain.name,
      globs: domain.globs,
      ownershipClass: domain.ownership_class,
      domainSnapshotId: snapshot.snapshotId,
      phase: opts.phase,
      waveNumber,
      roadmapDigest,
      // Run swarm-1784601601-bd4a: tell an isolated agent its worktree's
      // workspace links are provisioned + what to do if resolution escapes
      // (report, never `npm install`) — see templates.js#renderWorktreeSection.
      isolatedWorktree: !!a.worktreePath,
    };

    let prompt;
    if (isAudit) {
      if (opts.phase === 'feature-audit') {
        // F-f86e42eb consumer half (coordinator, wave-39 merge): the template
        // accepts the prior/CONFIRM context; pass it the same way the audit
        // branch below does. roadmapDigest is now wired (F-8a97a700, wave 39
        // seam reconciliation) via promptOpts above, gated on opts.seedRoadmap.
        prompt = buildFeatureAuditPrompt({ ...promptOpts, priorContext, openPriorContext });
      } else {
        prompt = buildAuditPrompt({ ...promptOpts, priorContext, openPriorContext });
      }
    } else if (isAmend) {
      // Filter approved findings by the agent's owned globs. An empty result is
      // the correct answer (this domain has no work in this wave) — do NOT fall
      // back to all-approved, which would feed every fix to every agent and
      // defeat exclusive file ownership (Law #1). See lib/findings-filter.js.
      const findings = findingsForDomain(db, opts.runId, domain);
      prompt = buildAmendPrompt({ ...promptOpts, findings });
      // Item 5: amend prompts are the verification-discipline carrier — audit
      // prompts don't run tests anyway. Append the parallel-wave directive
      // when --skip-verify is set so the agent skips per-agent verify and
      // marks `verification_skipped: true` in its output JSON.
      if (opts.skipVerify) prompt += SKIP_VERIFY_DIRECTIVE;
    } else {
      prompt = buildAuditPrompt(promptOpts); // generic fallback
    }

    const promptPath = join(promptDir, `${domain.name}.md`);

    // F-166ab759: WARN-first ceiling on the composed brief, checked here —
    // the one point every prompt-writing path WITHIN dispatch() (audit,
    // feature-audit, amend, the generic fallback) already funnels through
    // before the write. The package's only OTHER brief-write site,
    // commands/resume.js's redispatch loop, carries the same check against
    // this same exported constant (found by this finding's sibling sweep;
    // its line carries `context: 'resume_redispatch'` to tell the two
    // apart in the NDJSON stream). Byte
    // length, not `.length` (UTF-16 code units), so multi-byte characters in
    // findings text/paths/roadmap-digest content don't undercount. See
    // WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES's own comment for how 750,000 was
    // grounded in this run's measured on-disk corpus. WARN only — never
    // blocks the write — because the live corpus already exceeds this
    // ceiling on every recent audit-phase wave; a hard gate here would brick
    // this very run's own next dispatch.
    const promptByteSize = Buffer.byteLength(prompt, 'utf-8');
    if (promptByteSize > WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES) {
      logStage('wave_brief_oversized', {
        component: 'dogfood-swarm',
        correlation_id: mintCorrelationId(),
        runId: opts.runId,
        waveNumber,
        phase: opts.phase,
        domain: domain.name,
        byteSize: promptByteSize,
        thresholdBytes: WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES,
      });
    }

    atomicWriteFileSync(promptPath, prompt, 'utf-8');

    builtAgents.push({
      agentRunId: a.agentRunId,
      domain: domain.name,
      domainId: domain.id,
      promptPath,
      worktreePath: a.worktreePath,
      worktreeBranch: a.worktreeBranch,
    });
  }

  // 6. Dispatch-success observability (D3B-016): emit a structured
  // wave_dispatched event so NDJSON consumers see the success path as
  // explicitly as they see isolate_failed. Symmetric with the failure-
  // emit at the createWorktree catch above.
  const dispatchCorrelationId = mintCorrelationId();
  logStage('wave_dispatched', {
    correlation_id: dispatchCorrelationId,
    runId: opts.runId,
    waveId,
    waveNumber,
    phase: opts.phase,
    agentCount: builtAgents.length,
    isolated: !!opts.isolate,
    skipVerify: !!opts.skipVerify,
  });

  return {
    waveId,
    waveNumber,
    phase: opts.phase,
    agents: builtAgents,
    promptDir,
    unroutedApprovedFindings,
    supersededFailedWave,
  };
}
