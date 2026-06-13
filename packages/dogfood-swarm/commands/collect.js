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
import { getDomains, checkOwnership } from '../lib/domains.js';
import { validateAuditOutput, validateFeatureOutput, validateAmendOutput } from '../lib/output-schema.js';
import { validateAgentOutput, AgentOutputValidationError } from '../lib/validate-agent-output.js';
import { computeFingerprint, classifyFindings, buildPriorMap, upsertFindings } from '../lib/fingerprint.js';
import { transitionAgent, canTransition } from '../lib/state-machine.js';
import { transitionWave } from '../lib/wave-state-machine.js';
import { LATEST_AGENT_RUN_PER_DOMAIN } from '../lib/queries/latest-agent-runs.js';
import {
  readBoundedJson, BoundedJsonError, MAX_AGENT_OUTPUT_BYTES,
} from '../lib/bounded-json-read.js';
import { CollectUpsertError } from '../lib/errors.js';
import { logStage } from '../lib/log-stage.js';
import { getActualTouchedFiles, diffReportedVsActual } from '../lib/git-touched-files.js';
import { randomBytes } from 'node:crypto';

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

const AUDIT_PHASES = ['health-audit-a', 'health-audit-b', 'health-audit-c', 'stage-d-audit', 'feature-audit'];
const AMEND_PHASES = ['health-amend-a', 'health-amend-b', 'health-amend-c', 'stage-d-amend', 'feature-execute'];

/**
 * Mint a synthetic correlation_id for a coordination stage (FT-PIPELINE-004
 * pattern). The ingest pipeline uses `ing-<base36-ts>-<rand4>`; coordination
 * stages here use `coord-<base36-ts>-<rand4>` so a single grep tells the
 * operator which side of the contract emitted the event.
 */
function mintCorrelationId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `coord-${ts}-${rand}`;
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
    summary: null,
  };

  const allFindings = [];

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
    // We probe `git status --porcelain` + `git diff --name-only HEAD` via
    // lib/git-touched-files.js, then run checkOwnership against the union
    // (actual ∪ reported). The union semantics preserves backwards-compat
    // for legacy outputs where files_changed lists files outside the
    // worktree's HEAD diff (e.g. an amend that reverted edits before
    // reporting). When git is unavailable (no .git), we fall back to the
    // agent's self-report and surface the degradation in the report.
    if (isAmend && output.files_changed !== undefined) {
      const worktree = ar.worktree_path || run.local_path;
      const actualTouched = getActualTouchedFiles(worktree);
      const reported = Array.isArray(output.files_changed) ? output.files_changed : [];
      const divergence = diffReportedVsActual(reported, actualTouched.all);

      const ownershipSet = new Set([
        ...reported.map(p => p.replace(/\\/g, '/')),
        ...actualTouched.all,
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

      if (filesForOwnership.length > 0) {
        const ownership = checkOwnership(db, opts.runId, domain.name, filesForOwnership);
        if (ownership.violations.length > 0) {
          agentReport.status = 'ownership_violation';
          agentReport.violations = ownership.violations;
          const violMsg = `Out-of-domain edits: ${ownership.violations.map(v => v.file).join(', ')}`;
          tryTransition(db, ar.id, 'ownership_violation', violMsg, domain.name);
          db.prepare('UPDATE agent_runs SET error_message = ? WHERE id = ?')
            .run(violMsg, ar.id);

          // Record file claims with violations
          for (const v of ownership.violations) {
            db.prepare(`
              INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
              VALUES (?, ?, 'edit', ?, 1)
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

    // Collect findings for dedup
    const findings = isAudit
      ? (output.findings || output.features || [])
      : [];

    const sourceRoot = ar.worktree_path || run.local_path;
    for (const f of findings) {
      const sourceText = readFindingSource(sourceRoot, f.file);
      f.fingerprint = computeFingerprint(f, { sourceText });
      allFindings.push(f);
    }

    agentReport.findings_count = findings.length;
    if (agentReport.status === 'complete') {
      tryTransition(db, ar.id, 'complete', 'Output collected and validated', domain.name);
      db.prepare('UPDATE agent_runs SET output_path = ? WHERE id = ?')
        .run(outputPath, ar.id);
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

  // Fingerprint + dedup.
  //
  // Note: classifyFindings is called WITHOUT a `scope` argument here — that is
  // the strictly-safe default per B-BACK-003. Without scope info, every prior
  // finding not rediscovered this wave is classified `unverified` rather than
  // `fixed`. A follow-up wave will wire wave-bound domain globs into a scope
  // descriptor (minimatch → path-prefix conversion is non-trivial and out of
  // scope for the wave 8 self-inspection slice). Until then, the digest will
  // surface `unverified` counts so operators have an explicit "agent did not
  // look at this" signal instead of a silent false-fix claim.
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
  if (allFindings.length > 0) {
    const priorMap = buildPriorMap(db, opts.runId);
    const classified = classifyFindings(allFindings, priorMap);
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
        `upsertFindings failed for wave=${wave.wave_number} (${allFindings.length} findings attempted): ${e.message}`,
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
  const waveStatus = hasViolations || hasErrors ? 'failed' : 'collected';
  // OPF-3: name the dispatched → <waveStatus> transition explicitly so the
  // operator does not have to infer it from a subsequent `No dispatched wave
  // found` error.
  report.waveStatusBefore = 'dispatched';
  report.waveStatusAfter = waveStatus;
  const collectReason = hasViolations
    ? `collect: ${report.violations.length} ownership violation(s)`
    : hasErrors
      ? `collect: ${report.validation_errors.length} validation error(s)`
      : `collect: ${report.agents.length} agent(s) accepted`;
  transitionWave(db, wave.id, waveStatus, collectReason);
  if (report.serial_verify_required) {
    db.prepare('UPDATE waves SET serial_verify_required = 1 WHERE id = ?').run(wave.id);
  }

  // Generate summary
  report.summary = buildSummary(db, opts.runId, wave, report);

  return report;
}

/**
 * Build a human-readable wave summary.
 */
function buildSummary(db, runId, wave, report) {
  const allFindings = db.prepare(
    "SELECT severity, status FROM findings WHERE run_id = ?"
  ).all(runId);

  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const byStatus = { new: 0, recurring: 0, approved: 0, fixed: 0, deferred: 0 };
  for (const f of allFindings) {
    if (bySeverity[f.severity] != null) bySeverity[f.severity]++;
    if (byStatus[f.status] != null) byStatus[f.status]++;
  }

  const agentSummary = report.agents
    .map(a => `  ${a.domain}: ${a.status}${a.findings_count ? ` (${a.findings_count} findings)` : ''}${a.errors.length ? ` [ERRORS: ${a.errors.length}]` : ''}`)
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

  return `Wave ${wave.wave_number} (${wave.phase}):${transitionLine}
  CRITICAL: ${bySeverity.CRITICAL}  HIGH: ${bySeverity.HIGH}  MEDIUM: ${bySeverity.MEDIUM}  LOW: ${bySeverity.LOW}
  New: ${report.findings.new}  Recurring: ${report.findings.recurring}  Fixed: ${report.findings.fixed}
  Violations: ${report.violations.length}${revalidateHint}

Agents:
${agentSummary}`;
}
