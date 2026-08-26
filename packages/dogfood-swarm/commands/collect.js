/**
 * collect.js — `swarm collect`
 *
 * Collects agent outputs, validates schemas, enforces ownership, deduplicates findings.
 *
 * Steps:
 * 1. Find the current wave's agent_runs
 * 2. For each agent: read output JSON, validate schema
 * 3. Check file ownership (diff against domain globs)
 * 4. Fingerprint + dedup findings against prior waves
 * 5. Upsert findings into the control plane
 * 6. Generate wave summary
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, join as joinPath, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { openDb } from '../db/connection.js';
import { getDomains, checkOwnership, narrowToExclusivelyOwned } from '../lib/domains.js';
import { minimatch } from 'minimatch';
import { validateAuditOutput, validateFeatureOutput, validateAmendOutput } from '../lib/output-schema.js';
import { validateAgentOutput, AgentOutputValidationError } from '../lib/validate-agent-output.js';
import { computeFingerprint, classifyFindings, buildPriorMap, upsertFindings, honorReusedFindingIds } from '../lib/fingerprint.js';
import { applyDeclaredFixes } from '../lib/declared-closures.js';
import { matchesAnyGlob } from '../lib/findings-filter.js';
import { transitionAgent, canTransition } from '../lib/state-machine.js';
import { transitionWave } from '../lib/wave-state-machine.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import {
  readBoundedJson, BoundedJsonError, MAX_AGENT_OUTPUT_BYTES,
} from '../lib/bounded-json-read.js';
import { CollectUpsertError } from '../lib/errors.js';
import { logStage } from '../lib/log-stage.js';
import { getActualTouchedFiles, diffReportedVsActual, resolveWorktreeBaseRef } from '../lib/git-touched-files.js';
import { mintCorrelationId } from '../lib/correlation-id.js';
import { normalizeFilePathForGlobMatch } from '../lib/normalize-path.js';
import { pluralize } from './lib/pluralize.js';
import { isAgentBearingDomain } from './lib/agent-bearing.js';
import {
  rollupFixesSkipped,
  persistWaveFixesSkipped,
  formatFixesSkippedSummary,
} from './lib/fixes-skipped.js';
// F-ab4fbab0 (the class lib/phases.js's own header names as F-274e7ac5,
// "DISCLOSED EXCEPTION": this file's private copy, specifically): importing
// the single ordered source of truth instead of a hand-typed literal that
// can desync from it. See commands/revalidate.js's identical fix (this same
// wave) for the sibling copy in this domain.
import { AUDIT_PHASES, AMEND_PHASES } from '../lib/phases.js';

/**
 * The deterministic per-domain output filename the dispatch layout promises an
 * agent writes. dispatch.js writes the PROMPT to swarms/<run>/wave-N/<domain>.md
 * and the agent (per the README Quick start + the prompt's output contract) writes
 * its OUTPUT JSON to swarms/<run>/wave-N/<domain>/output.json. `swarm collect
 * --all` reconstructs that path so the operator no longer hand-types one
 * --domain=name:path per agent.
 */
export const AGENT_OUTPUT_FILENAME = 'output.json';

/**
 * F4-CP-05: resolve the `{ domain: outputPath }` map for `swarm collect --all`
 * straight from the control plane, instead of the operator hand-typing one
 * `--domain=name:path` per dispatched agent.
 *
 * Enumerates the domains that have an agent_run in the LATEST dispatched wave —
 * exactly the set collect() iterates (dispatch never creates an agent for a
 * `shared` domain, so `shared` is naturally excluded; the latest-per-(wave,
 * domain) filter mirrors collect()'s own read so a resumed wave maps the live
 * row, not a stale one). Each domain's expected output path is built under the
 * deterministic dispatch layout: <swarmDir>/<runId>/wave-N/<domain>/output.json.
 *
 * A domain whose output file is ABSENT on disk is reported in `missing` rather
 * than mapped — the caller (cmdCollect) surfaces it as a NON-FATAL structured
 * warning and lets collect() proceed with the present ones (the absent agent is
 * reported `failed` downstream exactly as the manual path would report it).
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {string} opts.swarmDir — root dir the per-run wave layout lives under
 *   (the CLI passes dirname(SWARM_DB) — the same relationship DEFAULT_DB_PATH ↔
 *   DEFAULT_SWARM_DIR carries by default).
 * @returns {{ waveNumber: number, outputs: Object<string,string>,
 *             missing: Array<{ domain: string, path: string }> }}
 * @throws {Error} when the run is unknown or has no dispatched wave (same
 *   diagnostics class as collect()'s own no-dispatched-wave guard).
 */
export function resolveAllDomainOutputs(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  const wave = db.prepare(`
    SELECT * FROM waves WHERE run_id = ? AND status = 'dispatched'
    ORDER BY wave_number DESC LIMIT 1
  `).get(opts.runId);
  if (!wave) {
    throw new Error(
      `No dispatched wave found for ${opts.runId}; --all has nothing to enumerate. ` +
      `Run \`swarm dispatch ${opts.runId} <phase>\` first, or supply explicit --domain=name:path pairs.`
    );
  }

  // Latest agent_run per domain in this wave (mirrors collect()'s iteration),
  // joined to domains for the name. This is exactly the agent set collect()
  // will process — no more, no less.
  const rows = db.prepare(`
    SELECT d.name AS domain_name
    FROM agent_runs ar
    JOIN domains d ON ar.domain_id = d.id
    WHERE ar.wave_id = ?
      ${LATEST_AGENT_RUN_PER_DOMAIN}
    ORDER BY d.name
  `).all(wave.id);

  const outputs = {};
  const missing = [];
  for (const r of rows) {
    const expected = joinPath(
      opts.swarmDir, opts.runId, `wave-${wave.wave_number}`, r.domain_name, AGENT_OUTPUT_FILENAME
    );
    if (existsSync(expected)) {
      outputs[r.domain_name] = expected;
    } else {
      missing.push({ domain: r.domain_name, path: expected });
    }
  }

  return { waveNumber: wave.wave_number, outputs, missing };
}

/*
 * Upper bound on agent output JSON file size before we even attempt JSON.parse.
 *
 * Honest agent outputs are typically <100 KB; even verbose findings dumps are
 * <1 MB. 50 MB leaves headroom for legitimate large outputs while preventing
 * pathological cases (an agent caught in a logging loop that writes a multi-GB
 * file before crashing would otherwise block the coordinator's event loop
 * during parse and exhaust memory).
 *
 * BR-B-001 (original). F-H5 (Wave A1 D3): constant lifted into the shared
 * lib/bounded-json-read.js helper alongside the size-gate + parse so the
 * call sites listed in the helper registry all stay in lockstep.
 */

/**
 * Upper bound on error message length persisted to agent_runs.error_message.
 *
 * Huge parse-error messages (1MB+ when the input is a giant blob) bloat the
 * audit log row and break terminal-line wrapping for the operator. 512 chars
 * is enough to convey the offending position and a snippet of context.
 * BR-B-004.
 */
const MAX_ERROR_MESSAGE_CHARS = 512;

/**
 * Upper bound on a source file we will read to build a context-snippet
 * fingerprint (fp-p-005). The snippet only needs ~7 lines, but extracting them
 * splits the whole file, so we refuse to load a pathological (minified bundle,
 * generated blob) file into memory; such a finding falls back to the line-bucket
 * fingerprint. 2 MB clears any hand-written source by a wide margin.
 */
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * tryTransition — observability-friendly wrapper around transitionAgent.
 *
 * The state machine is the law engine for agent_run status changes
 * (state-machine.js header). collect.js historically wrapped every
 * transitionAgent() call in a bare `try { ... } catch { /* comment *\/ }` —
 * silently swallowing the no-op case ("already in target state") AND any real
 * regression (FK violation, prepared-statement crash, future state-machine
 * change introducing a newly-illegal transition). The two were
 * indistinguishable at the call site, defeating the auditability the state
 * machine exists to provide (F-178610-005).
 *
 * Behaviour:
 *   - If the agent_run is already in `to`, returns `{ skipped: true }`
 *     silently. This is the explicit no-op path — replaces the rationalising
 *     comments in the old bare catches.
 *   - If `canTransition(from, to)` says the transition is allowed, performs
 *     it via transitionAgent() and returns `{ transitioned: true }`.
 *   - Anything else is logged to stderr with full context (agent run id,
 *     domain hint, from/to, reason) so an operator can distinguish a real
 *     regression from the expected already-in-target case. The error is
 *     swallowed (collect must keep processing other agents) but is NOT
 *     silent — that's the entire point of the wave-10 fix.
 */
function tryTransition(db, agentRunId, to, reason, domainHint) {
  const ar = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunId);
  if (!ar) {
    // D3B-011 (Wave A2 Stage C): structured logStage instead of
    // console.warn so NDJSON consumers see the explicit no-op.
    logStage('transition_skipped', {
      component: 'dogfood-swarm',
      agent_run_id: agentRunId,
      agentRunId,
      domain: domainHint || null,
      attempted_status: to,
      reason: 'agent_run_not_found',
      detail: `agent_run ${agentRunId} not found`,
    });
    return { skipped: true };
  }
  if (ar.status === to) {
    return { skipped: true };
  }
  const check = canTransition(ar.status, to);
  if (!check.allowed) {
    // D3B-011 (Wave A2 Stage C): state-machine rejection is a real
    // observability signal — surface as structured event.
    logStage('transition_skipped', {
      component: 'dogfood-swarm',
      agent_run_id: agentRunId,
      agentRunId,
      domain: domainHint || null,
      from_status: ar.status,
      attempted_status: to,
      reason: 'state_machine_rejected',
      detail: check.reason,
    });
    return { skipped: true, rejected: true, reason: check.reason };
  }
  try {
    transitionAgent(db, agentRunId, to, reason);
    return { transitioned: true };
  } catch (e) {
    // D3B-011 (Wave A2 Stage C): a downstream throw from transitionAgent
    // is the most operator-relevant case (FK violation, prepared-statement
    // crash, future state-machine change). Structured event includes the
    // error message for grep.
    logStage('transition_skipped', {
      component: 'dogfood-swarm',
      agent_run_id: agentRunId,
      agentRunId,
      domain: domainHint || null,
      from_status: ar.status,
      attempted_status: to,
      reason: 'transition_threw',
      detail: e.message,
    });
    return { skipped: true, error: e.message };
  }
}

/**
 * Narrow each agent's `confirmed` declaration to the findings its OWN domain
 * owns. Shared with revalidate.js, whose full-coverage branch builds the
 * structurally identical union — the same one-definition/two-callers seam
 * reconcileFileClaims below already established for this pair, and the reason
 * the fix lands here rather than being copy-pasted into both.
 *
 * WHY (F-18d0ef6d, HIGH). The `confirmed` declaration replaced "silence closes
 * a finding" with "a declaration closes a finding" — but never checked WHO was
 * declaring. Any domain could close any other domain's finding by naming an id
 * it saw in the confirmation queue, which is run-wide and shows every domain's
 * open findings to every agent. Proven live against the unmutated code: a
 * domain owning only `packages/b/**` declared a CRITICAL living exclusively in
 * `packages/a/**`, and it closed, permanently. The brief tells agents "an id
 * outside your domain belongs to another agent, not to you" — prose, enforced
 * by nothing, which is the exact "nothing reads the summary" shape the
 * declaration mechanism was built to kill, one layer down inside that fix.
 *
 * Ownership is resolved with `matchesAnyGlob` — the same helper
 * findingsForDomain uses to route work TO a domain. A domain that may not be
 * ASSIGNED a finding must not be able to CLOSE it; routing and vouching had
 * better answer to one rule.
 *
 * DISCLOSED, not silently assumed away: a finding whose `file_path` no
 * agent-bearing domain matches becomes unclosable by declaration and stays open
 * (`unverified`) until a coordinator disposes of it via defer/reject. Two ways
 * to land there, and they are NOT the same gap:
 *   - the path matches a `shared` domain, which dispatch never gives an agent
 *     (root `package.json` — F-3af2f9c8's home);
 *   - the path matches NO domain at all, not even `shared`, because `shared`'s
 *     globs are root-level (`package.json`, `*.json`) and minimatch does not
 *     cross a path separator without a globstar — so a nested
 *     `packages/<name>/package.json` belongs to nobody (F-6a5eb347's home).
 *     (Spelling that glob literally here would end this comment: the star-slash
 *     closes the block. The suite went 161-red on exactly that.)
 * That is not new and not this rule's doing: F-6a5eb347 went `unverified` on
 * wave 32, ~14 minutes BEFORE this rule was committed, correctly — no agent
 * checked it because no agent COULD. Failing closed is the whole point; the
 * alternative is letting an unrelated domain vouch for a file nobody owns,
 * which is the defect being fixed.
 *
 * An earlier revision of this paragraph cited F-6a5eb347 as "root package.json,
 * `shared`" — wrong on both halves (it is `packages/dogfood-swarm/package.json`,
 * and it matches zero domains), conflating it with F-3af2f9c8. Three separate
 * lanes caught it independently, each by running minimatch against the real
 * frozen map rather than reading the comment. The conclusion survived; the
 * citation did not.
 *
 * F-8a15be4c (CRITICAL, wave 41): the file-less-finding fallback below was
 * missing entirely until this wave. `pathById.get(id) == null` cannot
 * distinguish "no such finding_id in this run" (a typo'd/hallucinated id —
 * correctly dropped) from "a real row whose file_path column is genuinely
 * NULL" (Map#get returns undefined for a miss and the column's real null
 * value for a hit, indistinguishably) — so EVERY file-less finding's
 * confirmed[] declaration was silently dropped, identically to a
 * hallucinated id. Proven live at pass scale against this run's own
 * control-plane DB: all 40 status='approved' findings had file_path IS
 * NULL, and every one of them came back unvouchable regardless of how
 * correctly a domain declared it. lib/findings-filter.js#findingsForDomain
 * already got the C3 filed_by_domain fallback for ROUTING a file-less
 * finding to a domain; this function never got the matching fallback for
 * VOUCHING — exactly the gap this docstring's own "routing and vouching had
 * better answer to one rule" already named. isVouchableByDomain, below,
 * mirrors findingsForDomain's rule byte-for-byte: a finding with a real
 * file_path is vouchable by whichever domain's globs match it (unchanged);
 * a file-less finding is vouchable by precisely its filing domain
 * (findings.filed_by_domain); a file-less finding with no recorded filer
 * (filed_by_domain IS NULL — every pre-v10 row) stays unvouchable, same as
 * before — the honest answer, not a guess.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {Array<{name: string, globs: string[]}>} domains — the frozen map
 * @param {Array<{domain: string, confirmed?: string[]}>} agents — COMPLETE agents only
 * @returns {string[]} the ids whose declaring agent actually owns them
 */

/**
 * F-8a15be4c: whether `row` is vouchable BY `domainName` — the identical
 * rule lib/findings-filter.js#findingsForDomain already applies when
 * ROUTING a file-less finding to a domain, mirrored here for VOUCHING (see
 * scopeConfirmedToOwningDomain's own docstring, above, for why the two must
 * answer to one rule). Kept LOCAL to this file rather than imported from
 * lib/findings-filter.js: a genuinely shared export would need to live in
 * `lib/` (swarm-cp-core's exclusive glob this wave), so parity is enforced
 * by this comment plus a same-fixture contract test
 * (wave41-4091637-5127-swarm-cp-pins.test.js) rather than a shared import —
 * flagged in this wave's output notes as a candidate for a real shared
 * helper once a lane owns both files at once.
 *
 * F-f347d858 (carried forward, unchanged): the has-a-file_path branch
 * normalizes BEFORE matching — the raw `file_path` column can carry a
 * leading './', a doubled/trailing slash, a backslash separator, or a case
 * variant of the identical file, none of which matchesAnyGlob's minimatch
 * call recognizes as equal to the canonical spelling a domain's own glob is
 * authored in. normalizeFilePathForGlobMatch is the shared, exported
 * lib/normalize-path.js helper both this file and lib/fingerprint.js import
 * (F-c4d70660: no longer a private per-file fork of each other).
 *
 * @param {{file_path: string|null, filed_by_domain: string|null}} row
 * @param {string} domainName
 * @param {string[]} domainGlobs
 * @returns {boolean}
 */
function isVouchableByDomain(row, domainName, domainGlobs) {
  if (row.file_path != null) {
    return matchesAnyGlob(normalizeFilePathForGlobMatch(row.file_path), domainGlobs);
  }
  return row.filed_by_domain != null && row.filed_by_domain === domainName;
}

export function scopeConfirmedToOwningDomain(db, runId, domains, agents) {
  const rowById = new Map(
    db.prepare('SELECT finding_id, file_path, filed_by_domain FROM findings WHERE run_id = ?')
      .all(runId)
      .map(f => [String(f.finding_id).toUpperCase(), f]),
  );
  const domainByName = new Map(domains.map(d => [d.name, d]));

  const scoped = [];
  for (const agent of agents) {
    const domain = domainByName.get(agent.domain);
    if (!domain || !Array.isArray(agent.confirmed)) continue;
    for (const id of agent.confirmed) {
      // An id naming no finding in this run declares nothing. Dropping it is
      // not merely tidiness: a typo'd or hallucinated id must never be able to
      // vacuously "close" anything, and it cannot be owned by definition.
      // F-8a15be4c: `.get()` returning undefined is the ONLY drop signal now
      // (a real row is always a truthy object, even with file_path NULL) —
      // see isVouchableByDomain, above, for the rule applied to a real row.
      const row = rowById.get(String(id).toUpperCase());
      if (!row) continue;
      if (isVouchableByDomain(row, agent.domain, domain.globs)) scoped.push(id);
    }
  }
  return scoped;
}

/**
 * F-f347d858: local, private normalization for a `file_path` immediately
 * before it is matched against a domain's glob list. Same transform as
 * lib/fingerprint.js's private normalizePath (not importable — that function
 * is not exported): strips a leading './', collapses doubled/trailing
 * slashes, converts backslash to forward slash, and lowercases. Domain globs
 * are authored literals (always forward-slash, always lowercase in this
 * repo's convention) so only the untrusted file_path side needs normalizing.
 *
 * @param {string} filePath
 * @returns {string}
 */
// The wave-37 local copy of this normalizer moved to the shared leaf
// lib/normalize-path.js at the wave-39 merge (the byte-identical duplicate
// F-d656acc4 tracked); collect.js now consumes the one definition.

/**
 * F-67ddcd02: the shared file_claims reconciliation step BOTH collect() (this
 * file, below) and revalidate.js's mutation pass must run before writing an
 * agent_run's current-pass file claims.
 *
 * Pre-fix, both write paths were add/upsert-ONLY: a row for a file the
 * CURRENT pass no longer even examines — because a corrected diff base
 * landed between two collect() attempts (`swarm redrive` re-opening a wave),
 * a domain-map recomputation narrowed the set, or the agent's edits were
 * fully reverted before a revalidate() repair — was never revisited by
 * either the violation-upsert or the valid-insert-or-ignore loop. A stale
 * violation=1 row from an earlier, WRONG attempt then survived forever,
 * corrupting `swarm status`'s violation count and any exported
 * `swarm receipt` for a wave whose real, corrected result was clean (proven
 * live against this run's own control-plane DB: wave 4's first, broken-diff-
 * base collect attempt wrote 335 violation=1 rows across 6 agents; the
 * corrected second attempt never touched them, and `swarm receipt` for wave
 * 4 still exports all 335 as live violations today).
 *
 * file_claims rows are a CLAIM about what the current pass observed, not an
 * audit event (DS-MUT-001's framing, a few lines below, for the sibling
 * upsert) — deleting a superseded claim is the lawful write, not data loss.
 * The audit trail for WHY an agent_run reached its current status lives in
 * agent_state_events, untouched by this.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} agentRunId
 * @param {string[]} keep — the file paths this pass's ownership check
 *   actually examined (collect.js's filesForOwnership: reported self-report
 *   UNION independently-observed touched files). Any EXISTING file_claims
 *   row for this agent_run_id whose file_path is NOT in this set is
 *   superseded and removed — regardless of whether it was violation=1 or
 *   violation=0, since either can go stale the same way. An empty array
 *   clears every row for this agent_run_id, which is correct for a fully-
 *   reverted / now-empty pass.
 */
export function reconcileFileClaims(db, agentRunId, keep) {
  if (keep.length === 0) {
    db.prepare('DELETE FROM file_claims WHERE agent_run_id = ?').run(agentRunId);
    return;
  }
  const placeholders = keep.map(() => '?').join(',');
  db.prepare(`
    DELETE FROM file_claims WHERE agent_run_id = ? AND file_path NOT IN (${placeholders})
  `).run(agentRunId, ...keep);
}

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {Object<string, string>} opts.outputs — domain → output JSON path
 * @returns {object} — collection report
 */
export function collect(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) throw new Error(`Run not found: ${opts.runId}`);

  // Find current wave (most recent dispatched)
  const wave = db.prepare(`
    SELECT * FROM waves WHERE run_id = ? AND status = 'dispatched'
    ORDER BY wave_number DESC LIMIT 1
  `).get(opts.runId);
  if (!wave) {
    // OPF-3: surface the most-recent non-dispatched wave's status so the
    // operator does not face a dead end. A `failed` wave is the
    // `swarm revalidate` happy path; `collected` is already advanced; etc.
    const latest = db.prepare(`
      SELECT wave_number, phase, status FROM waves WHERE run_id = ?
      ORDER BY wave_number DESC LIMIT 1
    `).get(opts.runId);
    if (latest && latest.status === 'failed') {
      throw new Error(
        `No dispatched wave found. The most recent wave (${latest.wave_number}, ${latest.phase}) is in '${latest.status}'. ` +
        `For invalid_output / ownership_violation recovery, use \`swarm revalidate ${opts.runId} --reason "<text>" --domain=<name>:<corrected.json> --apply\`. ` +
        `For full diagnostics: \`swarm status ${opts.runId}\`.`
      );
    }
    if (latest) {
      throw new Error(
        `No dispatched wave found. The most recent wave (${latest.wave_number}, ${latest.phase}) is in '${latest.status}'. ` +
        `Use \`swarm status ${opts.runId}\` for full diagnostics, or \`swarm dispatch ${opts.runId} <phase>\` to start a new wave.`
      );
    }
    throw new Error('No dispatched wave found. Run `swarm dispatch` first.');
  }

  const isAudit = AUDIT_PHASES.includes(wave.phase);
  const isAmend = AMEND_PHASES.includes(wave.phase);

  // Read the LATEST agent_run per (wave_id, domain_id). After `swarm resume`
  // runs, the wave gains a new agent_run row per redispatched domain (resume.js
  // INSERTs at status='pending', then transitions to 'dispatched'); the OLD
  // failed/timed_out row remains. Iterating ALL rows would (a) double-count
  // findings if the old outputPath still exists on disk, (b) silently call
  // transitionAgent('failed' → 'failed') on the stale row (illegal — the
  // state machine throws), and (c) flip wave.status back to 'failed' even
  // when every redispatched agent succeeded, blocking advance.js.
  //
  // F-375053-002 (original mutation-side fix). F-H6/H7/H8 (Wave A1 D3): the
  // SQL fragment is now lifted into lib/queries/latest-agent-runs.js so the
  // entire wave-9 family — mutation sites AND read sites — share ONE
  // definition. The mechanical guard
  // (`amend1-wave9-filter-discipline.test.js`) ensures no future
  // `FROM agent_runs` site under packages/dogfood-swarm/** can re-divide.
  const agentRuns = db.prepare(`
    SELECT ar.* FROM agent_runs ar
    WHERE ar.wave_id = ?
      ${LATEST_AGENT_RUN_PER_DOMAIN}
  `).all(wave.id);
  const domains = getDomains(db, opts.runId);
  const domainMap = new Map(domains.map(d => [d.name, d]));

  // F-16bab049: a --domain=<name>:<path> pair whose NAME does not match any
  // domain in this run is a CLI typo, not a missing agent — refuse loudly
  // and BEFORE any mutation. Nothing below this point has written to the DB
  // yet (agentRuns/domains above are reads), so the wave stays 'dispatched'
  // and a corrected `swarm collect` re-runs immediately — no `swarm redrive`
  // detour. Pre-fix, collect() only ever looked up
  // `opts.outputs?.[domain.name]` (iterating FROM the domain side), so an
  // extra/misspelled key in `opts.outputs` was silently never read: the
  // REAL domain for that typo'd slot then had no output, got marked
  // 'failed' downstream ('Output file not found'), and the wave flipped to
  // 'failed' with no diagnostic naming the typo. Mirrors revalidate.js's
  // unknown-domain refusal (revalidate.js's validation pass) for the same
  // class of operator mistake.
  const unknownDomains = Object.keys(opts.outputs || {}).filter(name => !domainMap.has(name));
  if (unknownDomains.length > 0) {
    const validDomains = domains.map(d => d.name).sort();
    logStage('collect_unknown_domain', {
      component: 'dogfood-swarm',
      correlation_id: mintCorrelationId(),
      runId: opts.runId,
      waveId: wave.id,
      waveNumber: wave.wave_number,
      unknownDomains,
      validDomains,
    });
    const err = new Error(
      `collect: unknown domain(s) in --domain=<name>:<path>: ${unknownDomains.join(', ')}. ` +
      `Valid domains for this run: ${validDomains.join(', ') || '(none)'}. ` +
      `The wave was NOT modified — re-run \`swarm collect\` with the corrected name.`
    );
    err.code = 'COLLECT_UNKNOWN_DOMAIN';
    err.runId = opts.runId;
    err.waveId = wave.id;
    err.unknownDomains = unknownDomains;
    err.validDomains = validDomains;
    err.hint = `valid domains for this run: ${validDomains.join(', ') || '(none)'}`;
    throw err;
  }

  const report = {
    waveId: wave.id,
    waveNumber: wave.wave_number,
    phase: wave.phase,
    agents: [],
    findings: { new: 0, recurring: 0, fixed: 0, unverified: 0 },
    violations: [],
    validation_errors: [],
    // Item 5 (Phase 2-B verification-discipline): when any amend agent set
    // `verification_skipped: true` in its output JSON, the wave was dispatched
    // under the serial-final-verify discipline. The coordinator must run a
    // single `npm run verify` against the cumulative tree before promoting
    // the wave to `collected`. The CLI surfaces this as a Next-step hint.
    serial_verify_required: false,
    // F-aba6fa9d: agents whose output file was missing. Previously these were
    // transitioned to 'failed' but counted toward NEITHER validation_errors
    // NOR violations, so the wave landed in 'collected' with a failed agent
    // and the collect reason claimed every agent was "accepted". A wave with
    // a missing output is a FAILED wave; recovery is `swarm redrive <wave-id>`
    // (flips wave + agent back to dispatched) after re-running the agent.
    missing_outputs: [],
    // d3b-collect-A-002 (Stage B follow-up): wave-level aggregate of the
    // per-agent `ownership_probe_degraded` note. In a NON-isolated amend wave
    // the independent git probe cannot attribute the shared-worktree diff to a
    // single agent, so each agent's probe is narrowed to its own domain globs —
    // a silent cross-domain edit that the agent also omits from `files_changed`
    // is no longer independently caught. This field rolls the per-agent notes up
    // so the weakened guarantee is visible at the wave level, not buried in each
    // agent record. `null` when no agent's probe was degraded (isolated wave, or
    // git probe unavailable). The CLI surfaces a multi-domain wave here as a
    // banner recommending `--isolate`. Observability only — never a gate.
    ownership_probe_degraded: null,
    // F-64e6da30 / F-a1e35a0d / GitHub #65: wave-level rollup of fixes[] refusals. null
    // until an amend agent skips at least one declaration; then counts by
    // reason + capped id sample, persisted to kv so status/receipt see it
    // after collect stdout scrolls past.
    fixes_skipped: null,
    summary: null,
  };

  // Accumulator for the wave-level fixes_skipped rollup (amend only).
  const fixesSkippedEntries = [];

  // DS-PROAC-03: bracket the multi-agent collection with a lifecycle NDJSON
  // pair matching verify_start/verify_complete (verify.js) and wave_dispatched
  // (dispatch.js). collect iterates every agent_run, validates each output, runs
  // ownership, and dedups findings — a long, multi-item operation whose only
  // prior breadcrumbs were per-failure events with no "began / finished with
  // these counts" anchor. One correlation_id ties the start, the per-agent
  // failure events, and the complete together for a single grep. collect_complete
  // is emitted before every return below so a degraded run SAYS it degraded
  // (invalid/violation counts) rather than scrolling past silently.
  const collectCorrelationId = mintCorrelationId();
  logStage('collect_start', {
    component: 'dogfood-swarm',
    correlation_id: collectCorrelationId,
    runId: opts.runId,
    waveId: wave.id,
    waveNumber: wave.wave_number,
    phase: wave.phase,
    agentCount: agentRuns.length,
  });

  const allFindings = [];

  // d3b-collect-A-002 (Stage B follow-up): domains whose independent ownership
  // probe was narrowed to their own globs because the wave ran without
  // --isolate. Accumulated inside the per-agent loop, rolled into
  // report.ownership_probe_degraded after the loop.
  const ownershipDegradedDomains = [];

  // fp-p-005: source-text cache for the context-snippet fingerprint. Each
  // finding's file is read at most once per collect; computeFingerprint folds an
  // edit-stable hash of the ~7 lines around finding.line into the base
  // fingerprint, so two distinct findings in one file+bucket no longer collide.
  // Audit waves (the only ones that produce findings) do not edit the tree, so
  // this read is the same source snapshot the auditor reported against. The
  // cache value is the file text, or null when the file is unreadable, oversized,
  // or resolves OUTSIDE the worktree — in which case computeFingerprint falls
  // back to the historical line-bucket. A `finding.file` is attacker-adjacent
  // (it comes from agent JSON), so the containment guard refuses any path that
  // escapes the worktree root even though we only ever hash a snippet of it.
  const sourceCache = new Map();
  const readFindingSource = (root, file) => {
    if (!root || !file) return null;
    const rootResolved = resolvePath(root);
    const resolved = resolvePath(root, String(file));
    if (sourceCache.has(resolved)) return sourceCache.get(resolved);
    let text = null;
    const contained = resolved === rootResolved || resolved.startsWith(rootResolved + sep);
    if (contained) {
      try {
        const st = statSync(resolved);
        if (st.isFile() && st.size <= MAX_SOURCE_FILE_BYTES) {
          text = readFileSync(resolved, 'utf-8');
        }
      } catch { text = null; }
    }
    sourceCache.set(resolved, text);
    return text;
  };

  // L3-003 (Wave A2 amend2 — family seal of D3B-002): wrap the per-agent
  // collection loop in a single db.transaction() so a mid-loop crash
  // rolls back EVERY DB write across all agents iterated so far. Pre-fix,
  // agent A's artifacts + file_claims + tryTransition could commit while
  // agent B's readFileSync / git probe / tryTransition threw — leaving
  // partial DB state that swarm resume could not recover. better-sqlite3
  // nests the inner executeTransition self-wrap (Wave A1 H9) as a
  // SAVEPOINT inside the outer tx, so atomicity composes correctly.
  //
  // Filesystem-side ops (readFileSync, git status, etc.) happen inside
  // the tx body. They cannot be rolled back, but the tx guarantees that
  // if any of them throws, no DB row carries the partial result. Same
  // FS-orphan trade-off as D3B-002 on dispatch.js: a worktree state
  // that was probed before the throw is unchanged; only DB rows are
  // rolled back.
  db.transaction(() => {
    for (const ar of agentRuns) {
    const domain = domains.find(d => d.id === ar.domain_id);
    if (!domain) continue;

    const outputPath = opts.outputs?.[domain.name];
    const agentReport = {
      domain: domain.name,
      agentRunId: ar.id,
      status: 'complete',
      findings_count: 0,
      errors: [],
      violations: [],
    };

    // Check if output exists
    if (!outputPath || !existsSync(outputPath)) {
      agentReport.status = 'failed';
      agentReport.errors.push('Output file not found');
      tryTransition(db, ar.id, 'failed', 'Output file not found', domain.name);
      db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
        .run('Output file not found', ar.id);
      report.agents.push(agentReport);
      // F-aba6fa9d: count the missing output toward the wave-failure decision
      // so the wave does not land in 'collected' while overstating success.
      report.missing_outputs.push({ domain: domain.name, path: outputPath || null });
      continue;
    }

    // Read and parse output. Size-gate before parse so a pathological agent
    // output (logging loop, raw stdout dump) cannot block the coordinator's
    // event loop or exhaust memory. BR-B-001 (original). F-H5 (Wave A1 D3):
    // statSync + readFileSync + JSON.parse triplet now goes through the
    // shared helper so the size-limit is enforced identically across every
    // operator-supplied / agent-emitted JSON read site.
    let output;
    try {
      output = readBoundedJson(outputPath, { maxBytes: MAX_AGENT_OUTPUT_BYTES });
    } catch (e) {
      // Truncate before persistence — a 1MB+ parse-error message would bloat
      // the agent_runs.error_message column and break terminal-line wrapping
      // for the operator reading audit output. BR-B-004.
      const truncatedMsg = e.message.length > MAX_ERROR_MESSAGE_CHARS
        ? e.message.slice(0, MAX_ERROR_MESSAGE_CHARS - 3) + '...'
        : e.message;
      agentReport.status = 'invalid_output';
      agentReport.errors.push(`JSON parse error: ${truncatedMsg}`);
      tryTransition(db, ar.id, 'invalid_output', `JSON parse error: ${truncatedMsg}`, domain.name);
      db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
        .run(truncatedMsg, ar.id);
      report.agents.push(agentReport);
      report.validation_errors.push({ domain: domain.name, error: truncatedMsg });
      continue;
    }

    // F-252713-017 (Phase 7 wave 1 → wave 2 wiring): canonical envelope gate.
    // Runs BEFORE the legacy shape-specific validators below and BEFORE
    // fingerprint computation, so a malformed agent JSON is rejected with a
    // structured AgentOutputValidationError pointing the operator at
    // packages/schemas/src/json/agent-output.schema.json. The legacy validators stay for
    // shape-specific extras (e.g. 'stage' enum) but the schema is now the
    // contract gate. Wave-22 logStage wrapper-strip pattern preserved by
    // calling logStage directly with a fresh correlation_id.
    try {
      validateAgentOutput(output, {
        domain: domain.name,
        phase: wave.phase,
        outputPath,
      });
    } catch (e) {
      if (e instanceof AgentOutputValidationError) {
        const correlationId = mintCorrelationId();
        logStage('agent_output_invalid', {
          correlation_id: correlationId,
          err: e.message,
          domain: domain.name,
          runId: opts.runId,
          waveId: wave.id,
          waveNumber: wave.wave_number,
          outputPath,
          errorCount: e.errors.length,
        });
        agentReport.status = 'invalid_output';
        agentReport.errors = e.errors.map(err => `${err.path || '/'} ${err.message}`);
        tryTransition(db, ar.id, 'invalid_output', `Schema gate: ${e.message}`, domain.name);
        db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
          .run(e.message, ar.id);
        report.agents.push(agentReport);
        report.validation_errors.push({ domain: domain.name, errors: agentReport.errors });
        continue;
      }
      throw e;
    }

    // Validate schema
    let validation;
    if (isAudit && wave.phase !== 'feature-audit') {
      validation = validateAuditOutput(output);
    } else if (wave.phase === 'feature-audit') {
      validation = validateFeatureOutput(output);
    } else if (isAmend) {
      validation = validateAmendOutput(output);
    } else {
      validation = { valid: true, errors: [] };
    }

    if (!validation.valid) {
      agentReport.status = 'invalid_output';
      agentReport.errors = validation.errors;
      tryTransition(db, ar.id, 'invalid_output', `Schema validation: ${validation.errors.join('; ')}`, domain.name);
      db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
        .run(validation.errors.join('; '), ar.id);
      report.agents.push(agentReport);
      report.validation_errors.push({ domain: domain.name, errors: validation.errors });
      continue;
    }

    // Record artifact
    const contentHash = createHash('sha256')
      .update(readFileSync(outputPath))
      .digest('hex')
      .slice(0, 16);

    db.prepare(`
      INSERT INTO artifacts (agent_run_id, artifact_type, path, content_hash)
      VALUES (?, ?, ?, ?)
    `).run(ar.id, isAudit ? 'audit_output' : 'amend_output', outputPath, contentHash);

    // Check ownership for amend waves.
    //
    // VD-NEW-1 (Phase 2-B verification-discipline): ownership is grounded in
    // the **independently-computed** touched-file set, not the agent's
    // self-reported `files_changed`. The agent's list is a verifier-in-the-
    // thing-being-verified surface (Class #14) — an agent that under-reports
    // `files_changed` would bypass ownership enforcement.
    //
    // Sourcing: the agent worktree (if --isolate was used) or run.local_path.
    // We probe `git status --porcelain -z` (uncommitted + untracked) AND — per
    // F-4ba6036b — a committed-delta diff against the dispatch base, then run
    // checkOwnership against the union (actual ∪ reported). Without the
    // committed-delta half, an agent that `git commit`ed inside its worktree
    // made every edit invisible to the probe and enforcement fell back
    // entirely to the self-reported files_changed (the untrusted channel
    // VD-NEW-1 exists to distrust). Diff base: the worktree's branch point
    // for --isolate (dispatch-time HEAD, resolved via merge-base — NOT
    // current main HEAD, which would attribute other waves' merged work to
    // this agent); runs.commit_sha for the non-isolated shared tree. The
    // union semantics preserves backwards-compat for legacy outputs where
    // files_changed lists files outside the probed diff (e.g. an amend that
    // reverted edits before reporting). When git is unavailable (no .git), we
    // fall back to the agent's self-report and surface the degradation in
    // the report.
    // F-0e55b5ca: the base is the PER-WAVE dispatch-time HEAD
    // (waves.dispatch_sha), not runs.commit_sha — the init-time sha goes
    // stale as waves land commits, so diffing against it attributed every
    // prior wave's landed edits to this agent (false divergence alarms; the
    // prior waves' in-domain files INSERTed into file_claims under this
    // agent's identity). Legacy waves (dispatched before the v8 column) fall
    // back to the per-path derivation below, the historical behavior.
    //
    // F-COORD-DIFFBASE: dispatch_sha is preferred on BOTH paths. F-0e55b5ca
    // added the column and wired it into the non-isolated branch only,
    // leaving --isolate to re-derive its base via
    // resolveWorktreeBaseRef = `git merge-base <run.branch> HEAD`. That
    // equals the dispatch point ONLY IF the worktrees forked from
    // run.branch's tip; commit a wave to a feature branch and merge-base
    // silently returns where that branch diverged from run.branch instead —
    // re-creating F-0e55b5ca's exact stale-base failure on the path that
    // needs the fix most (run swarm-1784091637-5127 wave 4: 335 phantom
    // ownership violations across 6 agents; backend diffed to 114 files
    // against the merge-base vs 6 against dispatch_sha). dispatch_sha IS the
    // worktree fork point by construction — dispatch.js captures
    // `git rev-parse HEAD` and lib/worktree.js's createWorktree forks from
    // that same HEAD — so reading the recorded fact is strictly more direct
    // than re-deriving it, and cannot drift when HEAD is off run.branch.
    if (isAmend && output.files_changed !== undefined) {
      const isolated = !!ar.worktree_path;
      const worktree = ar.worktree_path || run.local_path;
      const baseRef = wave.dispatch_sha
        || (isolated ? resolveWorktreeBaseRef(worktree, run.branch) : run.commit_sha);
      const actualTouched = getActualTouchedFiles(worktree, { baseRef });
      const reported = Array.isArray(output.files_changed) ? output.files_changed : [];

      // d3b-collect-A-002: in a NON-isolated parallel amend wave (no --isolate),
      // every agent shares run.local_path, so getActualTouchedFiles returns the
      // UNION of every agent's edits — git cannot attribute a given file to a
      // given agent. Attributing that whole-tree diff to one agent would flag
      // files another domain legitimately edited as ownership violations,
      // failing the wave on phantom out-of-domain edits. Without per-agent
      // isolation the independent probe can only soundly validate THIS domain's
      // own files; restrict the independent contribution to the files this
      // domain EXCLUSIVELY OWNS. wave2-live-001 / V2-INVARIAN-002: the
      // narrowing is the shared narrowToExclusivelyOwned helper (lib/domains.js)
      // — the same specificity arbitration checkOwnership uses — consumed by
      // both collect and revalidate so the two paths cannot fork. Narrowing by
      // bare glob MEMBERSHIP over-collects when globs overlap (`**/*.test.*`
      // admits every sibling package's test-file edits, which enforcement then
      // resolves to the package domain and phantom-flags). The agent's
      // self-reported `files_changed` is still checked in full, so a
      // self-confessed out-of-domain edit is still caught. Under --isolate the
      // worktree holds only this agent's edits, so the full diff is
      // attributable and the cross-domain under-report catch (VD-NEW-1) is
      // preserved.
      const independentTouched = isolated
        ? actualTouched.all
        : narrowToExclusivelyOwned(domains, domain.name, actualTouched.all);

      const divergence = diffReportedVsActual(reported, independentTouched);

      const ownershipSet = new Set([
        ...reported.map(p => p.replace(/\\/g, '/')),
        ...independentTouched,
      ]);
      const filesForOwnership = Array.from(ownershipSet);

      // Non-blocking divergence finding — operator-visible, but the
      // ownership check below remains the gate.
      if (!divergence.match && !actualTouched.unavailable) {
        agentReport.files_changed_divergence = {
          missing_from_report: divergence.missing_from_report,
          extra_in_report: divergence.extra_in_report,
        };
      }
      if (actualTouched.unavailable) {
        agentReport.files_changed_divergence = { unavailable: true, reason: 'git probe failed; ownership check used agent self-report only' };
      }
      // V2-CONTRACT-003 / V2-INVARIAN-006: the committed-delta half of the
      // probe degraded — either the base diff itself failed (bad ref / shallow
      // clone: actualTouched.baseDiffUnavailable) or an isolated agent's fork
      // point could not be resolved (resolveWorktreeBaseRef returned null, so
      // no base diff was even attempted). Either way committed edits are
      // invisible and coverage silently narrows to status + self-report — the
      // exact channel F-4ba6036b exists to distrust. Surface it like the
      // sibling degradations above: agent-report note + structured
      // ownership_probe_degraded breadcrumb. Observability only — never a gate.
      if (!actualTouched.unavailable && (actualTouched.baseDiffUnavailable || (isolated && !baseRef))) {
        agentReport.base_diff_unavailable = {
          reason: isolated && !baseRef
            ? 'worktree fork point unresolved (merge-base failed) — committed edits are invisible; probe coverage is status + self-report only'
            : 'base diff failed (bad ref or shallow clone) — committed edits are invisible; probe coverage is status + self-report only',
        };
        logStage('ownership_probe_degraded', {
          correlation_id: mintCorrelationId(),
          domain: domain.name,
          runId: opts.runId,
          waveId: wave.id,
          waveNumber: wave.wave_number,
          isolated,
          reason: 'base_diff_unavailable',
          remediation: isolated
            ? 'ensure the run branch and the worktree fork point are resolvable (full clone, valid runs.branch)'
            : 'ensure runs.commit_sha is a resolvable ref in the local repo',
        });
      }
      // Degradation note (F-c5eb20ef rewording): the narrowed probe keeps
      // only files this domain EXCLUSIVELY OWNS, and checkOwnership then
      // classifies exactly those as valid — so in non-isolated mode the
      // independent contribution is structurally incapable of producing a
      // violation. Say the true property (zero independent cross-domain
      // coverage; enforcement rests on self-report), not "restricted to this
      // domain's globs", which read as partial coverage. The narrowed files
      // still add forensic file_claims rows. Operator-visible so the
      // weakened guarantee is never silent.
      if (!isolated && !actualTouched.unavailable) {
        agentReport.ownership_probe_degraded = {
          isolated: false,
          reason:
            'non-isolated wave: the shared-worktree diff cannot be attributed per-agent, ' +
            'so the independent probe cannot catch ANY cross-domain edit — ' +
            'ownership enforcement for this wave rests entirely on the agent\'s ' +
            'files_changed self-report. ' +
            'Re-dispatch with --isolate for independent cross-domain attribution.',
        };
        ownershipDegradedDomains.push(domain.name);
        // swarm-cli-B-001 (Stage C carry-over): emit a structured event at the
        // exact point the per-agent guarantee is weakened, mirroring the
        // transition_skipped / agent_output_invalid logStage pattern in this
        // file. Before this, the degradation reached the returned object but
        // NO NDJSON line — an operator tailing stderr couldn't grep the
        // weakened-attribution moment that --isolate would have closed.
        logStage('ownership_probe_degraded', {
          correlation_id: mintCorrelationId(),
          domain: domain.name,
          runId: opts.runId,
          waveId: wave.id,
          waveNumber: wave.wave_number,
          isolated: false,
          // F-c5eb20ef: the old code 'probe_restricted_to_domain_globs' read
          // as partial coverage; the true property is that the independent
          // probe contributes ZERO cross-domain enforcement here.
          reason: 'self_report_only_cross_domain',
          remediation: '--isolate',
        });
      }

      // F-67ddcd02: supersede this agent_run's PRIOR file_claims rows before
      // writing the current pass's — see reconcileFileClaims's doc comment
      // (above tryTransition) for the full rationale. Runs unconditionally,
      // even when filesForOwnership is now empty, so a fully-reverted
      // agent_run's stale claims (of either violation value) are cleared
      // too, not just the ones this pass happens to re-examine.
      reconcileFileClaims(db, ar.id, filesForOwnership);

      if (filesForOwnership.length > 0) {
        const ownership = checkOwnership(db, opts.runId, domain.name, filesForOwnership);
        if (ownership.violations.length > 0) {
          agentReport.status = 'ownership_violation';
          agentReport.violations = ownership.violations;
          const violMsg = `Out-of-domain edits: ${ownership.violations.map(v => v.file).join(', ')}`;
          tryTransition(db, ar.id, 'ownership_violation', violMsg, domain.name);
          db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
            .run(violMsg, ar.id);

          // Record file claims with violations.
          //
          // DS-MUT-001: the violation write is idempotent — a re-collect that
          // re-processes an agent still holding a committed violation claim (the
          // `swarm redrive` re-open path: the wave flips back to 'dispatched'
          // while the blocked agent's schema-valid output.json stays on disk)
          // re-runs this INSERT for the SAME (agent_run_id, file_path). A plain
          // INSERT hit UNIQUE(agent_run_id, file_path) and threw INSIDE the loop
          // db.transaction, rolling back every sibling agent's fresh work and
          // leaving the wave stuck 'dispatched' and un-collectable. The upsert
          // re-affirms violation=1 (and refreshes the owning domain) instead —
          // matching the INSERT OR IGNORE discipline the valid-claim write below
          // already used.
          for (const v of ownership.violations) {
            db.prepare(`
              INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
              VALUES (?, ?, 'edit', ?, 1)
              ON CONFLICT(agent_run_id, file_path)
              DO UPDATE SET violation = 1, domain_id = excluded.domain_id
            `).run(ar.id, v.file, domain.id);
          }
          report.violations.push(...ownership.violations);
        }

        // Record valid file claims
        for (const v of (ownership.valid || [])) {
          db.prepare(`
            INSERT OR IGNORE INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
            VALUES (?, ?, 'edit', ?, 0)
          `).run(ar.id, v.file, domain.id);
        }
      }
    }

    // Collect findings for dedup.
    //
    // Feature waves read features[] FIRST (observed in run
    // swarm-1784601601-bd4a): a canonicalized feature envelope can carry
    // `findings: []` beside a populated features[], and `[] || features`
    // short-circuits on the truthy empty array — silently dropping every
    // feature. Phase-aware ordering keys the read off what the wave's own
    // validator (validateFeatureOutput) just required.
    const findings = isAudit
      ? (wave.phase === 'feature-audit'
        ? (output.features || output.findings || [])
        : (output.findings || output.features || []))
      : [];

    const sourceRoot = ar.worktree_path || run.local_path;
    for (const f of findings) {
      const sourceText = readFindingSource(sourceRoot, f.file);
      // SCHEMA-A-001: feature-audit outputs carry `priority`, not `severity`
      // (the CRITICAL/HIGH/MEDIUM/LOW enum is identical for both). findings.severity
      // is TEXT NOT NULL, so a feature reaching upsertFindings without a severity
      // is silently skipped by its INSERT OR IGNORE (changes=0) — the whole feature
      // pass then persists zero approvable rows. Normalize severity from priority
      // on a copy (audit findings already carry severity and pass through
      // untouched; the on-disk feature object keeps its priority). severity is not
      // folded into computeFingerprint, so this does not perturb the fingerprint.
      const stored = f.severity == null ? { ...f, severity: f.priority } : f;
      stored.fingerprint = computeFingerprint(stored, { sourceText });
      // Domain attribution for honorReusedFindingIds' ownership gate — a
      // declared id reuse is honored only when the DECLARING domain owns the
      // prior's file, the same authority the confirmed[] close path enforces.
      stored._declaringDomain = domain.name;
      allFindings.push(stored);
    }

    agentReport.findings_count = findings.length;
    // The agent's own declaration of which open priors it actually checked and
    // found gone. Audit-only: an amend wave's silence about a prior never
    // closed anything in the first place. Carried onto the report so the
    // classify call below can hold `fixed` to a declaration instead of
    // inferring it from silence.
    if (isAudit) agentReport.confirmed = Array.isArray(output.confirmed) ? output.confirmed : [];
    if (agentReport.status === 'complete') {
      tryTransition(db, ar.id, 'complete', 'Output collected and validated', domain.name);
      db.prepare('UPDATE agent_runs SET output_path = ? WHERE id = ?')
        .run(outputPath, ar.id);
    }

    // A COMPLETE amend agent's fixes[] closes the approved findings it names
    // (observed in run swarm-1784601601-bd4a: fixes[] was schema-required,
    // prompt-demanded, README-promised — and consumed by nothing, so amended
    // findings stayed 'approved' and later audit lenses swept them to
    // 'unverified'). Gated on 'complete': a blocked agent's declarations are
    // exactly as untrusted as its diff. Runs inside the L3-003 loop tx, so a
    // mid-collect crash rolls the closures back with everything else.
    // Ownership/status/idempotency rules live in lib/declared-closures.js.
    if (isAmend && agentReport.status === 'complete') {
      const declared = applyDeclaredFixes(db, {
        runId: opts.runId,
        waveId: wave.id,
        agentRunId: ar.id,
        domainName: domain.name,
        domainGlobs: domain.globs,
        fixes: Array.isArray(output.fixes) ? output.fixes : [],
      });
      agentReport.fixes_closed = declared.closed.length;
      if (declared.skipped.length > 0) {
        agentReport.fixes_skipped = declared.skipped;
        for (const s of declared.skipped) {
          fixesSkippedEntries.push({ ...s, domain: domain.name });
        }
      }
      report.findings.fixed += declared.closed.length;
    }

    // Item 5: propagate the per-agent `verification_skipped` flag into the
    // wave-level coordination signal. The schema declares this as optional;
    // falsy/absent = legacy single-agent semantics. A single skipped agent
    // is enough to require the coordinator's serial verify pass — partial
    // parallel discipline still left some agents seeing the cumulative tree.
    //
    // TRUTH-003: write the per-agent flag to agent_runs so the wave receipt
    // can render forensic truth at the agent identity (the wave aggregate
    // loses which specific agent skipped). Targeted at the latest agent_run
    // row for this domain — `ar.id` is the row selected at the top of the
    // loop by the latest-per-(wave, domain) filter, so historical rows are
    // untouched.
    if (output.verification_skipped === true) {
      agentReport.verification_skipped = true;
      report.serial_verify_required = true;
      db.prepare('UPDATE agent_runs SET verification_skipped = 1 WHERE id = ?')
        .run(ar.id);
    }

    report.agents.push(agentReport);
  }
  })(); // L3-003 — invoke the db.transaction() wrap immediately

  // d3b-collect-A-002 (Stage B follow-up): roll the per-agent degraded-probe
  // notes into a single wave-level signal. Present (non-null) iff at least one
  // amend agent's independent ownership probe was narrowed for lack of
  // --isolate. `multi_domain` is the operator's action trigger: with two or
  // more degraded domains in one shared worktree, a silent cross-domain edit
  // that the editing agent also omits from `files_changed` would go
  // independently undetected — exactly the case --isolate closes. The CLI
  // promotes that case to a banner.
  if (ownershipDegradedDomains.length > 0) {
    report.ownership_probe_degraded = {
      isolated: false,
      domains: ownershipDegradedDomains,
      multi_domain: ownershipDegradedDomains.length >= 2,
    };
  }

  // Fingerprint + dedup.
  //
  // Scope (B-BACK-003, CP4-SCOPE-WIRING): the trivial-but-honest coverage
  // case is wired — when this wave's agent set covers EVERY agent-bearing
  // (non-shared) domain in the frozen map, the wave examined the whole owned
  // surface, so `scope = { full: true }` and a prior finding not rediscovered
  // is positively `fixed`. Any PARTIAL coverage keeps the strictly-safe
  // default: no scope info → every non-rediscovered prior is `unverified`
  // rather than `fixed` (we do not invent fixed verdicts). The finer-grained
  // per-domain scope descriptor (minimatch → path-prefix conversion) remains
  // future work; partial-coverage waves surface `unverified` counts so
  // operators keep the explicit "agent did not look at this" signal.
  // F-693631-002 (wave-12): upsertFindings was previously unguarded. Its
  // inner db.transaction() guarantees atomicity at the SQLite level — a
  // throw rolls back every INSERT/UPDATE inside the tx — but that throw
  // then escaped collect AFTER artifact rows + file_claims + agent state
  // transitions had been committed, leaving the wave-status UPDATE below
  // unrun. Result: artifacts persisted, agents `complete`, wave still
  // `dispatched`, findings missing — a state `swarm resume` couldn't
  // recover. The wrapper here logs structured context, surfaces a typed
  // error so the CLI can exit non-zero, and lets atomicity stay where it
  // belongs (inside upsertFindings).
  // F-6c5ee5dd: the classification pass runs for EVERY audit wave, including
  // the fully-clean re-audit reporting ZERO findings (the success case the
  // whole loop drives toward). classifyFindings([], priorMap) handles the
  // empty-current case and marks non-rediscovered priors 'unverified'
  // consistently with a wave that reported one finding — pre-fix, a clean
  // wave reclassified nothing, so stale prior rows kept their statuses with
  // no finding_events row recording that the clean wave looked at all.
  if (allFindings.length > 0 || isAudit) {
    const priorMap = buildPriorMap(db, opts.runId);
    // CP4-SCOPE-WIRING: full coverage iff every agent-bearing domain in the
    // frozen map has an agent that COMPLETED in this wave (dispatch never
    // creates an agent for a `shared` domain, so `shared` is excluded). An
    // agent whose output was missing/invalid/violating did NOT audit its
    // domain — its absence-of-priors is not evidence of anything, so any
    // non-complete agent demotes the wave to partial coverage and the safe
    // unverified default.
    const completedDomains = new Set(
      report.agents.filter(a => a.status === 'complete').map(a => a.domain)
    );
    const agentBearing = domains.filter(isAgentBearingDomain);
    const fullCoverage = agentBearing.length > 0
      && agentBearing.every(d => completedDomains.has(d.name));
    // The union of every COMPLETE agent's `confirmed` declaration, NARROWED to
    // the findings each agent's own domain owns. Domain coverage proves the
    // wave read the files; only the declaration proves it looked for a given
    // prior, which is the one thing that does not survive a lens change (a
    // stage-d-audit agent hunting typography "covers" every file a
    // defensive-coding finding lives in). An incomplete agent's declaration is
    // discarded for the same reason its silence is: it did not audit its domain.
    //
    // Deliberately NOT `|| null`: a wave where every agent legitimately checked
    // nothing must assert an EMPTY set (close nothing), not "no assertion"
    // (close everything). That distinction is the whole gate — collapsing an
    // empty declaration into the coarse reading would fail open exactly when
    // the agents told us they looked at nothing.
    const confirmed = scopeConfirmedToOwningDomain(
      db, opts.runId, domains,
      report.agents.filter(a => a.status === 'complete'),
    );
    // A CONFIRM-queue re-report that reuses a prior's finding id must match
    // that prior, not mint a duplicate row — the brief promises exactly this,
    // and content fingerprints cannot deliver it (see honorReusedFindingIds).
    // Same helper, same position (post-fingerprint, pre-classify) as the
    // revalidate.js caller — one definition, two callers, so the arbitration
    // cannot fork. The frozen map rides along for the ownership gate.
    const reconciled = honorReusedFindingIds(allFindings, priorMap, domains);
    const classified = classifyFindings(
      reconciled, priorMap, fullCoverage ? { full: true, confirmed } : null
    );
    let stats;
    try {
      stats = upsertFindings(db, opts.runId, wave.id, classified);
    } catch (e) {
      // FT-PIPELINE-004 cross-fix-dep: logStage callsites in coordination
      // commands carry correlation_id so a single forensic grep ties the
      // failure to the receipt + the agent prompt + any downstream
      // resume/dispatch. Wrapper-strip pattern in lib/log-stage.js handles
      // inner-field collisions; we pin the id at the outer envelope.
      const correlationId = mintCorrelationId();
      logStage('upsert_findings_failed', {
        correlation_id: correlationId,
        err: e.message,
        runId: opts.runId,
        waveId: wave.id,
        waveNumber: wave.wave_number,
        findingsAttempted: allFindings.length,
      });
      throw new CollectUpsertError(
        `upsertFindings failed for wave=${wave.wave_number} (${pluralize(allFindings.length, 'finding')} attempted): ${e.message}`,
        { cause: e, waveId: wave.id, findingsAttempted: allFindings.length }
      );
    }

    report.findings = {
      new: stats.inserted,
      recurring: stats.updated,
      fixed: stats.fixed,
      unverified: stats.unverified || 0,
    };
  }

  // Update wave status via the lawful state machine (Phase 5A).
  // The transition writes the audit row in wave_state_events and sets
  // completed_at as a side effect. serial_verify_required is a separate
  // discipline flag (NOT a state-machine concern) — persist it independently
  // after the state transition lands. TRUTH-001 / TRUTH-003 require that
  // `swarm status` and downstream readers see the discipline signal after
  // collect's stdout hint scrolls past.
  const hasViolations = report.violations.length > 0;
  const hasErrors = report.validation_errors.length > 0;
  // F-aba6fa9d: a missing agent output is a wave failure too — otherwise the
  // wave lands 'collected' with a failed agent, collect cannot re-run
  // (requires 'dispatched'), and the operator hits a dead end after `swarm
  // resume`. As a 'failed' wave the named recovery is `swarm redrive`.
  const hasMissing = report.missing_outputs.length > 0;
  const waveStatus = hasViolations || hasErrors || hasMissing ? 'failed' : 'collected';
  // OPF-3: name the dispatched → <waveStatus> transition explicitly so the
  // operator does not have to infer it from a subsequent `No dispatched wave
  // found` error.
  report.waveStatusBefore = 'dispatched';
  report.waveStatusAfter = waveStatus;
  const acceptedForReason = report.agents.filter(a => a.status === 'complete').length;
  const collectReason = hasViolations
    ? `collect: ${report.violations.length} ownership violation(s)`
    : hasErrors
      ? `collect: ${report.validation_errors.length} validation error(s)`
      : hasMissing
        ? `collect: ${report.missing_outputs.length} missing output(s), ${acceptedForReason} agent(s) accepted — recover with \`swarm redrive <wave-id>\``
        : `collect: ${acceptedForReason} agent(s) accepted`;
  transitionWave(db, wave.id, waveStatus, collectReason);
  if (report.serial_verify_required) {
    db.prepare('UPDATE waves SET serial_verify_required = 1 WHERE id = ?').run(wave.id);
  }
  // FT-d: persist the wave-level ownership-attribution-degraded signal so the
  // receipt and any post-hoc audit see that this wave ran with a narrowed
  // ownership probe. `report.ownership_probe_degraded` is non-null iff at least
  // one agent's independent probe was restricted for lack of --isolate (set in
  // the per-agent loop above). Persisted independently of the state machine,
  // exactly like serial_verify_required — it is a discipline signal, not a
  // wave-status concern, and must outlive the collect-time stdout/NDJSON hint.
  if (report.ownership_probe_degraded) {
    db.prepare('UPDATE waves SET ownership_probe_degraded = 1 WHERE id = ?').run(wave.id);
  }

  // F-64e6da30: persist the fixes_skipped rollup so status/receipt see
  // evaporated declarations after collect's stdout hint scrolls past.
  if (fixesSkippedEntries.length > 0) {
    report.fixes_skipped = rollupFixesSkipped(fixesSkippedEntries);
    persistWaveFixesSkipped(db, wave.id, report.fixes_skipped);
  }

  // Generate summary
  report.summary = buildSummary(db, opts.runId, wave, report);

  // DS-PROAC-03: completion half of the lifecycle pair. Shares the start's
  // correlation_id and reports the outcome counts so a degraded run is loud:
  // `accepted` is agents whose status ended `complete`; `invalid` and
  // `violations` mirror report.validation_errors / report.violations (the two
  // failure classes that flip the wave to `failed`). An operator greps the one
  // correlation_id and reads accepted/invalid/violations without parsing stdout.
  const acceptedCount = report.agents.filter(a => a.status === 'complete').length;
  logStage('collect_complete', {
    component: 'dogfood-swarm',
    correlation_id: collectCorrelationId,
    runId: opts.runId,
    waveId: wave.id,
    waveNumber: wave.wave_number,
    phase: wave.phase,
    agentCount: report.agents.length,
    accepted: acceptedCount,
    invalid: report.validation_errors.length,
    violations: report.violations.length,
    waveStatus: report.waveStatusAfter,
    serial_verify_required: report.serial_verify_required,
  });

  return report;
}

/**
 * Build a human-readable wave summary.
 */
export function buildSummary(db, runId, wave, report) {
  const allFindings = db.prepare(
    "SELECT severity, status FROM findings WHERE run_id = ?"
  ).all(runId);

  // F-SWARMCP-004: roll up by status dynamically (mirrors status.js). The prior
  // hard-coded literal { new, recurring, approved, fixed, deferred } + `!= null`
  // guard SILENTLY DROPPED any status outside the set — notably `unverified`
  // and `rejected` — so the summary undercounted the finding population and
  // hid whole disposition buckets from the operator.
  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const byStatus = {};
  for (const f of allFindings) {
    if (bySeverity[f.severity] != null) bySeverity[f.severity]++;
    byStatus[f.status] = (byStatus[f.status] || 0) + 1;
  }
  const statusLine = Object.keys(byStatus).sort()
    .map(s => `${s}: ${byStatus[s]}`)
    .join('  ');

  const agentSummary = report.agents
    .map(a => `  ${a.domain}: ${a.status}${a.findings_count ? ` (${pluralize(a.findings_count, 'finding')})` : ''}${a.errors.length ? ` [ERRORS: ${a.errors.length}]` : ''}`)
    .join('\n');

  // OPF-3: surface the wave-status transition in the summary header so the
  // dispatched → failed flip is not silent. Subsequent `swarm collect` calls
  // that hit `No dispatched wave found` (see CLI handler in cli.js) can then
  // name `swarm revalidate` as the recovery path.
  const transitionLine = report.waveStatusBefore && report.waveStatusAfter
    ? `\n  Wave status: ${report.waveStatusBefore} → ${report.waveStatusAfter}`
    : '';
  const revalidateHint = report.waveStatusAfter === 'failed'
    ? `\n  Recovery: \`swarm revalidate ${runId} --reason "<text>" --domain=<name>:<corrected.json> --apply\` (dry-run without --apply).`
    : '';

  const statusRollup = statusLine ? `\n  Status: ${statusLine}` : '';
  // F-64e6da30: name evaporated declarations in the summary so collect
  // stdout is not the only place that saw them before kv persistence.
  const fixesSkippedLine = report.fixes_skipped && report.fixes_skipped.total > 0
    ? `\n  [!] fixes_skipped: ${formatFixesSkippedSummary(report.fixes_skipped)}`
    : '';

  return `Wave ${wave.wave_number} (${wave.phase}):${transitionLine}
  CRITICAL: ${bySeverity.CRITICAL}  HIGH: ${bySeverity.HIGH}  MEDIUM: ${bySeverity.MEDIUM}  LOW: ${bySeverity.LOW}
  New: ${report.findings.new}  Recurring: ${report.findings.recurring}  Fixed: ${report.findings.fixed}${statusRollup}
  Violations: ${report.violations.length}${fixesSkippedLine}${revalidateHint}

Agents:
${agentSummary}`;
}
