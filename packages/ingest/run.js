/**
 * Ingestion orchestrator
 *
 * Thin glue: dispatch → load context → verifier → persist → rebuild indexes.
 *
 * Does NOT:
 * - decide verdicts on its own
 * - enforce policy outside the verifier
 * - inspect step results beyond passing them through
 * - mutate source-authored fields except through the verifier result
 *
 * Does:
 * - parse payload
 * - gather needed inputs
 * - call verifier
 * - persist output
 * - regenerate indexes
 */

import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { verify } from '@dogfood-lab/verify';
import { stubProvenance, provenanceForProvider } from '@dogfood-lab/verify/validators/provenance.js';
import { logStage as sharedLogStage } from '@dogfood-lab/dogfood-swarm/lib/log-stage.js';
import { loadGlobalPolicy, loadRepoPolicy, loadScenarios, githubScenarioFetcher } from './load-context.js';
import { isDuplicate, writeRecord, computeRecordPath } from './persist.js';
import { rebuildIndexes } from './rebuild-indexes.js';
import { verifyChain, formatChainResult } from './verify-chain.js';
import { handleAnchorCompute, handleAnchorPost, handleAnchorVerify } from './anchor/cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the REAL provenance adapter for a submission, routed by
 * `submission.source.provider` (github | gitlab), sourcing the provider's token
 * from the environment. Returns `{ provenance }` on success or `{ err }` (a
 * structured, operator-legible Error the caller surfaces via emitCliErrorEvent
 * + exit 2). The adapter registry (`provenanceForProvider`) is the single
 * provider-keyed seam; a provider in the schema enum without a registered
 * adapter fails here loudly rather than silently skipping verification.
 *
 * @param {object} submission
 * @returns {{ provenance: object } | { err: Error }}
 */
/**
 * F-a2e40a09: the ONE definition of "running in CI" for the provenance
 * branches. Truthy check on either conventional variable — CI systems export
 * CI=1 / CI=yes / CI=true interchangeably. Previously the stub-forbidden
 * guard used this truthy check while the real-by-default branch demanded the
 * exact string 'true', so a CI=1 environment was "CI" for one branch and
 * "not CI" for the other (fail-closed, but with a misleading flag-required
 * error instead of the token hint).
 *
 * F-5ca6c91a: the literal strings 'false' and '0' are explicit OPT-OUTS
 * (a convention many tools respect — `CI=false npm test` is a real idiom),
 * not truthy CI signals. Without this carve-out, a CI=false environment was
 * classified as CI: stub provenance forbidden and the no-flag default
 * demanding a real token — fail-closed, but against the operator's stated
 * intent.
 */
function isCI() {
  const truthy = (v) => Boolean(v && v !== 'false' && v !== '0');
  return truthy(process.env.CI) || truthy(process.env.GITHUB_ACTIONS);
}

function resolveProviderProvenance(submission) {
  const provider = (submission && submission.source && submission.source.provider) || 'github';
  const factory = provenanceForProvider(provider);
  if (!factory) {
    return { err: new Error(`unknown provenance provider '${provider}' — no adapter registered (supported: github, gitlab).`) };
  }
  const token = provider === 'gitlab'
    ? (process.env.GITLAB_TOKEN || process.env.CI_JOB_TOKEN)
    : (process.env.GITHUB_TOKEN || process.env.GH_TOKEN);
  if (!token) {
    const need = provider === 'gitlab' ? 'GITLAB_TOKEN or CI_JOB_TOKEN' : 'GITHUB_TOKEN or GH_TOKEN';
    return { err: new Error(`real provenance for provider '${provider}' requires ${need} in the environment.`) };
  }
  return { provenance: factory(token) };
}

/**
 * V2-INVARIAN-004: the ONE definition of "which submissions get a scenario
 * fetcher" (and with it required-steps enforcement). Previously this
 * condition lived inline in the CLI entrypoint where it was untestable
 * without spawning a process.
 *
 * Returns a `githubScenarioFetcher` when ALL hold:
 *   - provenance is REAL (not stubProvenance — preview/test runs never hit
 *     the GitHub API);
 *   - the submission is a plain object with provider `github` (default when
 *     `source.provider` is absent) — GitLab has no contents-API adapter yet,
 *     so its required_steps gate remains unenforced (documented gap);
 *   - `submission.repo` and `submission.ref.commit_sha` are strings (the
 *     fetcher re-validates their shapes fail-closed);
 *   - a GitHub token is present in `env` (GITHUB_TOKEN, then GH_TOKEN — the
 *     same token resolveProviderProvenance validated).
 *
 * Otherwise returns null: verification proceeds without scenario
 * definitions, exactly as before F-3bfc2885 wired the production path.
 *
 * @param {object} provenance - resolved provenance adapter
 * @param {object} submission
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ReturnType<typeof githubScenarioFetcher> | null}
 */
export function resolveScenarioFetcher(provenance, submission, env = process.env) {
  return resolveScenarioFetcherDecision(provenance, submission, env).fetcher;
}

/**
 * F-b04473d5: the reason-carrying form of {@link resolveScenarioFetcher}.
 * Every ineligible branch previously returned a silent null — an operator
 * auditing an accepted record could not tell "required_steps enforced and
 * satisfied" from "enforcement skipped (GitLab gap / missing token)" in the
 * run log. The CLI logs the decision as a `scenario_enforcement` NDJSON
 * event; this function is the unit-testable seam behind it.
 *
 * @param {object} provenance
 * @param {object} submission
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ fetcher: ReturnType<typeof githubScenarioFetcher> | null,
 *   active: boolean, reason: string | null }} `reason` names the skip class
 *   when `active` is false; null when a fetcher was constructed.
 */
export function resolveScenarioFetcherDecision(provenance, submission, env = process.env) {
  const skip = (reason) => ({ fetcher: null, active: false, reason });
  if (provenance === stubProvenance) return skip('stub-provenance');
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
    return skip('submission-malformed');
  }
  if (((submission.source && submission.source.provider) || 'github') !== 'github') {
    // GitLab has no contents-API adapter yet — the documented gap.
    return skip('provider-unsupported');
  }
  if (typeof submission.repo !== 'string') return skip('repo-not-string');
  if (typeof submission.ref?.commit_sha !== 'string') return skip('commit-sha-not-string');
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) return skip('no-token');
  return {
    fetcher: githubScenarioFetcher(token, submission.repo, submission.ref.commit_sha),
    active: true,
    reason: null
  };
}

/**
 * SEED-1 (d3-ingest-003) — posixify a path-shaped value at the operator/log
 * SERIALIZATION boundary. `computeRecordPath`/`writeRecord` return OS-native
 * paths (backslash-separated, absolute, on win32) because those values are
 * also used for real filesystem operations. But the moment a path crosses into
 * CLI JSON output, NDJSON log lines, or a downstream report
 * (dogfood-swarm persist.js records `report.dogfood.path`), it must be
 * forward-slash so operators and log pivots see one canonical shape across
 * OSes — and so a copy-paste into a raw.githubusercontent URL is not a broken
 * link. We posixify ONLY here, at the emit sites, leaving the returned fs paths
 * OS-native for the filesystem layer. Mirrors the boundary-normalize doctrine
 * already used in rebuild-indexes.js and parse-regression-pins.js. NEVER a
 * win32-skip.
 *
 * @param {string|null} p
 * @returns {string|null}
 */
function posixifyPath(p) {
  return typeof p === 'string' ? p.split(sep).join('/') : p;
}

/**
 * F-2750c4e8: ceiling on individually-persisted `scenario-load:` rejection
 * reasons. A hostile pre-schema-gate payload can produce up to
 * MAX_DISTINCT_SCENARIO_FETCHES scenario-load errors; persisting one reason
 * line per error bloats the evidence record without adding operator signal
 * (a 1000-error submission has one root cause). Everything past the ceiling
 * collapses into a single count summary.
 */
const SCENARIO_LOAD_REASON_CEILING = 20;

/**
 * Format loadScenarios errors as `scenario-load:` rejection reasons,
 * collapsing past {@link SCENARIO_LOAD_REASON_CEILING}.
 *
 * @param {string[]} scenarioErrors
 * @returns {string[]}
 */
function scenarioLoadReasons(scenarioErrors) {
  const reasons = scenarioErrors.map(e => `scenario-load: ${e}`);
  if (reasons.length <= SCENARIO_LOAD_REASON_CEILING) return reasons;
  return [
    ...reasons.slice(0, SCENARIO_LOAD_REASON_CEILING),
    `scenario-load: (+${reasons.length - SCENARIO_LOAD_REASON_CEILING} more scenario-load errors collapsed; ${reasons.length} total)`
  ];
}

/**
 * DESIGN RULING (wave 4): loadScenarios' `warnings` (true-404 scenario
 * definitions — nothing declared, nothing to enforce) land on the v1.6.0
 * accepted-with-warning channel (`verification.warnings`), NEVER on
 * rejection_reasons. verify() only sets the field when policy warnings
 * exist, so create-or-append here.
 *
 * @param {object} record - the record returned by verify()
 * @param {string[]} scenarioWarnings
 */
function appendScenarioWarnings(record, scenarioWarnings) {
  if (!scenarioWarnings || scenarioWarnings.length === 0) return;
  record.verification.warnings = [
    ...(record.verification.warnings || []),
    ...scenarioWarnings
  ];
}

/**
 * Emit a single structured stage-transition log line via the shared helper.
 *
 * Pins `component: 'ingest'` so every ingest event is tagged regardless of
 * caller-supplied fields. Delegates to the canonical helper at
 * `@dogfood-lab/dogfood-swarm/lib/log-stage.js`, which adds the wave-17
 * verdict-first human banner (TTY or DOGFOOD_LOG_HUMAN=1) on top of the
 * NDJSON line that ingest.yml's CI log captures.
 *
 * Stages: dispatch_received | context_loaded | verify_complete |
 * persist_complete | rebuild_indexes_complete | verify_only_complete |
 * rejected_pre_persist | error.
 *
 * F-252714-061 (FT-PIPELINE-004): callers may include `correlation_id` in
 * `fields` so a downstream log aggregator can pivot a multi-line NDJSON
 * stream into a per-submission trace. The wrapper passes it through; the
 * canonical generation site is `ingest()`/`verifyOnly()` (one ID per run).
 *
 * @param {string} stage
 * @param {object} fields - Stage-specific fields. `submission_id` and
 *   `correlation_id` strongly recommended. Do NOT pass `stage` as an inner
 *   field — it would collide with the outer stage name and the spread is
 *   last-wins. For "this stage failed inside that stage" use `failed_stage`
 *   (e.g. `logStage('error', { failed_stage: 'rebuild_indexes', ... })`).
 */
function logStage(stage, fields = {}) {
  // Defensive against F-827321-035: strip any caller-supplied `stage:`
  // before spreading, so the positional `stage` always wins. The shared
  // helper itself spreads fields last; without this strip, an inner
  // `stage:` would silently overwrite the outer name and a grep of
  // `"stage":"error"` across runner logs would miss the failure.
  // `correlation_id` (FT-PIPELINE-004) is destructured-and-passed: it has
  // no collision with the outer stage name, but naming it explicitly here
  // documents the wave-22 wrapper-strip pattern's safe-field contract.
  const { stage: _ignored, correlation_id, ...rest } = fields;
  sharedLogStage(stage, { component: 'ingest', correlation_id, ...rest });
}

/**
 * Generate a synthetic correlation_id for ingests where the submission has
 * no usable run_id (null/non-object/malformed). Format: `ing-<base36-ts>-<rand4>`.
 *
 * Examples: `ing-1abc234d-x7f9` — readable, sortable, distinct from real
 * `run_id` values (which never start with the `ing-` prefix in practice).
 */
function synthCorrelationId() {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `ing-${ts}-${rand}`;
}

/**
 * Resolve the correlation_id for a single ingest run.
 * Prefer `submission.run_id` (operator pivots stay on the user-meaningful
 * key); fall back to a synthetic id for invalid/malformed submissions.
 */
function resolveCorrelationId(submission) {
  if (submission && typeof submission === 'object' && !Array.isArray(submission)) {
    if (typeof submission.run_id === 'string' && submission.run_id.length > 0) {
      return submission.run_id;
    }
  }
  return synthCorrelationId();
}

/**
 * F-41872706: count how many loaded scenario definitions actually carry an
 * enforceable required_steps gate. `scenarios.size` alone answers "how many
 * definitions were fetched"; this answers "how many of those could fire the
 * step-results-present / step-verdict-consistent reject rules" — a definition
 * with no (or empty) success_criteria.required_steps enforces nothing (see
 * verify/index.js: requiredSteps defaults to [] and the loop no-ops).
 *
 * @param {Map|null} scenarios - the Map returned by loadScenarios, or null
 * @returns {number}
 */
function countRequiredStepsGates(scenarios) {
  if (!scenarios || typeof scenarios.values !== 'function') return 0;
  let gates = 0;
  for (const definition of scenarios.values()) {
    const steps = definition?.success_criteria?.required_steps;
    if (Array.isArray(steps) && steps.length > 0) gates++;
  }
  return gates;
}

/**
 * Run the full ingestion pipeline.
 *
 * @param {object} submission - Source-authored submission payload
 * @param {object} options
 * @param {string} options.repoRoot - Absolute path to the dogfood-lab/testing-os repo root
 * @param {object} options.provenance - Provenance adapter (REQUIRED — no default, no implicit stub)
 * @param {object} [options.scenarioFetcher] - Scenario fetch adapter
 * @returns {Promise<{ record: object, path: string, written: boolean, duplicate: boolean }>}
 */
export async function ingest(submission, options) {
  const {
    repoRoot,
    provenance,
    scenarioFetcher = null
  } = options;

  // Provenance adapter is REQUIRED. No implicit stub. Fail closed.
  if (!provenance || typeof provenance.confirm !== 'function') {
    throw new Error(
      'Provenance adapter is required. Use githubProvenance(token) for production ' +
      'or stubProvenance for tests. No implicit default — fail closed.'
    );
  }

  const submissionIsObject = submission && typeof submission === 'object' && !Array.isArray(submission);
  const submissionId = submissionIsObject ? (submission.run_id || null) : null;
  const submissionRepo = submissionIsObject ? (submission.repo || null) : null;

  // F-252714-061 (FT-PIPELINE-004): one correlation_id per ingest run, pinned
  // across every stage. For valid submissions, prefer submission.run_id so
  // operator pivots stay on the user-meaningful key; for invalid/malformed
  // submissions (no run_id) generate a synthetic `ing-<base36-ts>-<rand4>`.
  const correlation_id = resolveCorrelationId(submission);

  logStage('dispatch_received', {
    submission_id: submissionId,
    correlation_id,
    repo: submissionRepo,
    has_scenario_results: !!(submissionIsObject && submission.scenario_results)
  });

  // 1. Check for duplicate before doing any work
  //    We need a minimal record shape to compute the path for duplicate check
  //    Guard against null/non-object submissions — those flow straight to verify()
  //    which produces a rejection record marked _skipPersist.
  if (submissionIsObject && submission.run_id && submission.repo && submission.timing?.finished_at) {
    const probeRecord = {
      run_id: submission.run_id,
      repo: submission.repo,
      timing: submission.timing,
      verification: { status: 'accepted' }
    };
    if (isDuplicate(submission.run_id, probeRecord, repoRoot)) {
      logStage('rejected_pre_persist', {
        submission_id: submissionId,
        correlation_id,
        reason: 'duplicate'
      });
      return {
        record: null,
        path: null,
        written: false,
        duplicate: true
      };
    }
  }

  // 2. Load context
  const globalPolicy = loadGlobalPolicy(repoRoot);
  const repoPolicy = loadRepoPolicy(submissionIsObject ? (submission.repo || '') : '', repoRoot);
  const policyVersion = repoPolicy?.policy_version || globalPolicy.policy_version || '1.0.0';

  logStage('context_loaded', {
    submission_id: submissionId,
    correlation_id,
    policy_version: policyVersion,
    repo_policy_present: !!repoPolicy
  });

  // 3. Load scenario definitions.
  // F-3bfc2885: keep the loaded `scenarios` Map (previously discarded) and hand
  // it to verify() so success_criteria.required_steps is actually enforced.
  // F-efe4f893: gate on Array.isArray — this runs BEFORE the schema gate on
  // untrusted input, and a string/object scenario_results must never reach the
  // fetch loop (a string iterates CHARACTERS). verify() lands the
  // authoritative schema rejection downstream.
  // DESIGN RULING (wave 4): a true-404 definition is a WARNING (nothing
  // declared, nothing to enforce), a malformed committed file is a
  // `scenario-load:` rejection, and V2-CROSS-BO-001 outages (incl. exhausted
  // timeout, F-07ab7f86) throw `scenario-fetch-fault:` PAST this step — the
  // CLI's outer catch emits a structured operational error and exits 2.
  let scenarioErrors = [];
  let scenarioWarnings = [];
  let scenarios = null;
  if (scenarioFetcher && submissionIsObject && Array.isArray(submission.scenario_results)) {
    const result = await loadScenarios(submission, scenarioFetcher);
    scenarioErrors = result.errors;
    scenarioWarnings = result.warnings || [];
    scenarios = result.scenarios;
  }

  // 4. Call verifier — the law engine makes all decisions
  const record = await verify(submission, {
    globalPolicy,
    repoPolicy,
    provenance,
    policyVersion,
    scenarios
  });

  logStage('verify_complete', {
    submission_id: submissionId,
    correlation_id,
    status: record.verification?.status ?? null,
    rejection_reason_count: record.verification?.rejection_reasons?.length ?? 0,
    verdict: record.overall_verdict?.verified ?? null,
    // F-41872706: the scenario_enforcement event (CLI wrapper, pre-load) logs
    // scenario_count = how many scenarios the submission DECLARED. These three
    // are the post-load breakdown so an operator can tell "N gates enforced"
    // from "N scenarios, all true-404, enforcement skipped". scenarios_loaded
    // is the Map size (definitions actually fetched); required_steps_gates_fired
    // is the subset that carried a non-empty required_steps.
    scenarios_loaded: scenarios ? scenarios.size : 0,
    required_steps_gates_fired: countRequiredStepsGates(scenarios),
    scenarios_warned: scenarioWarnings.length,
    scenarios_errored: scenarioErrors.length
  });

  // 4b. Surface scenario loading outcomes: warnings (true-404 definitions) go
  // to verification.warnings; errors (malformed committed files) become
  // scenario-load rejections, collapsed past the reason ceiling (F-2750c4e8).
  appendScenarioWarnings(record, scenarioWarnings);
  if (scenarioErrors.length > 0) {
    record.verification.rejection_reasons.push(...scenarioLoadReasons(scenarioErrors));
    // If scenario loading failed, this is a rejection
    if (record.verification.status === 'accepted' && scenarioErrors.length > 0) {
      record.verification.status = 'rejected';
      record.verification.policy_valid = false;
      // Downgrade verdict if needed
      if (record.overall_verdict.verified === 'pass') {
        record.overall_verdict.verified = 'fail';
        record.overall_verdict.downgraded = true;
        if (!record.overall_verdict.downgrade_reasons) {
          record.overall_verdict.downgrade_reasons = [];
        }
        record.overall_verdict.downgrade_reasons.push('scenario definitions could not be loaded');
      }
    }
  }

  // 5. Persist record
  //    Verifier marks _skipPersist when input was null/non-object — the stub record
  //    lacks repo/run_id/timing.finished_at and would crash computeRecordPath().
  //    Surface the structured rejection cleanly without writing.
  if (record._skipPersist) {
    delete record._skipPersist;
    logStage('rejected_pre_persist', {
      submission_id: submissionId,
      correlation_id,
      reason: 'skip_persist',
      rejection_reasons: record.verification?.rejection_reasons ?? []
    });
    return { record, path: null, written: false, duplicate: false };
  }
  const persistStart = Date.now();
  const { path, written } = writeRecord(record, repoRoot);
  logStage('persist_complete', {
    submission_id: submissionId,
    correlation_id,
    // d3-ingest-003: posixify at the log boundary — `path` is OS-native from
    // writeRecord (used for the fs write); the NDJSON log surface gets forward
    // slashes so log pivots are byte-identical across OSes.
    path: posixifyPath(path),
    written,
    duplicate: !written,
    duration_ms: Date.now() - persistStart
  });

  // 6. Rebuild indexes
  if (written) {
    const rebuildStart = Date.now();
    try {
      const indexResult = rebuildIndexes(repoRoot);
      logStage('rebuild_indexes_complete', {
        submission_id: submissionId,
        correlation_id,
        duration_ms: Date.now() - rebuildStart,
        accepted: indexResult.accepted,
        rejected: indexResult.rejected,
        corrupted_count: indexResult.corrupted?.length ?? 0
      });
    } catch (err) {
      // failed_stage (not stage) — outer stage='error' must survive the
      // spread inside the shared logStage helper. F-827321-035: an inner
      // `stage:` field overwrites the outer name, hiding the error event
      // from any `"stage":"error"` grep across the runner log.
      //
      // `rebuildIndexes()` is called as one unit — there is no partial
      // `indexResult` to surface from this catch (counts only exist on the
      // success path above). The structured event surfaces what the operator
      // actually needs: throw site (stack, truncated), where the record
      // landed, and the recovery path. The console warning mirrors the same
      // shape so log-only readers get the same actionable hint.
      const truncatedStack = err.stack
        ? err.stack.split('\n').slice(0, 20).join('\n')
        : null;
      const stackPreview = err.stack
        ? err.stack.split('\n').slice(0, 5).join(' / ')
        : 'n/a';
      logStage('error', {
        submission_id: submissionId,
        correlation_id,
        failed_stage: 'rebuild_indexes',
        message: err.message,
        stack: truncatedStack,
        // d3-ingest-003: operator-facing path → posixify at the log boundary.
        record_persisted_at: posixifyPath(path),
        recovery: 'next ingest will trigger a full rebuild of indexes/'
      });
      console.error(
        `WARNING: record persisted at ${posixifyPath(path)}, but index rebuild failed: ${err.message}\n` +
        `         indexes/ may be stale until next ingest. To force rebuild now, re-run any test ingest.\n` +
        `         stack: ${stackPreview}`
      );
    }
  }

  return { record, path, written, duplicate: false };
}

/**
 * Run the verify-only pipeline: steps 0-4 (load context + verify), assemble
 * the would-be record, return it WITHOUT touching the filesystem or rebuilding
 * indexes. Surfaces what `ingest()` WOULD have persisted plus `would_persist_to`
 * — the path where the record would have landed.
 *
 * F-252714-058 (FT-PIPELINE-001): the verify pipeline already has a
 * `_skipPersist` internal sentinel for null/non-object inputs; this function
 * generalizes that path into a public entrypoint operators can use to dry-run
 * any submission without side effects.
 *
 * Same logStage events fire as a real ingest EXCEPT `persist_complete` and
 * `rebuild_indexes_complete` (which would lie about persistence). A
 * `verify_only_complete` event takes their place so CI logs read coherently.
 *
 * @param {object} submission - Source-authored submission payload
 * @param {object} options
 * @param {string} options.repoRoot - Absolute path to repo root (still
 *   needed for policy + scenario lookup)
 * @param {object} options.provenance - Provenance adapter (REQUIRED)
 * @param {object} [options.scenarioFetcher] - Scenario fetch adapter
 * @returns {Promise<{
 *   record: object,
 *   would_persist_to: string|null,
 *   verify_only: true
 * }>}
 */
export async function verifyOnly(submission, options) {
  const {
    repoRoot,
    provenance,
    scenarioFetcher = null
  } = options;

  // Provenance adapter is REQUIRED. Same fail-closed contract as ingest().
  if (!provenance || typeof provenance.confirm !== 'function') {
    throw new Error(
      'Provenance adapter is required. Use githubProvenance(token) for production ' +
      'or stubProvenance for tests. No implicit default — fail closed.'
    );
  }

  const submissionIsObject = submission && typeof submission === 'object' && !Array.isArray(submission);
  const submissionId = submissionIsObject ? (submission.run_id || null) : null;
  const submissionRepo = submissionIsObject ? (submission.repo || null) : null;
  const correlation_id = resolveCorrelationId(submission);

  logStage('dispatch_received', {
    submission_id: submissionId,
    correlation_id,
    repo: submissionRepo,
    has_scenario_results: !!(submissionIsObject && submission.scenario_results),
    verify_only: true
  });

  // 2. Load context (verify-only still needs policy to drive the verifier)
  const globalPolicy = loadGlobalPolicy(repoRoot);
  const repoPolicy = loadRepoPolicy(submissionIsObject ? (submission.repo || '') : '', repoRoot);
  const policyVersion = repoPolicy?.policy_version || globalPolicy.policy_version || '1.0.0';

  logStage('context_loaded', {
    submission_id: submissionId,
    correlation_id,
    policy_version: policyVersion,
    repo_policy_present: !!repoPolicy
  });

  // 3. Load scenario definitions — same gates + semantics as ingest() step 3
  // (F-3bfc2885 Map pass-through, F-efe4f893 Array.isArray gate, wave-4
  // ruling's warning/rejection/operational split), so verify-only and real
  // ingest produce identical records for the same submission.
  let scenarioErrors = [];
  let scenarioWarnings = [];
  let scenarios = null;
  if (scenarioFetcher && submissionIsObject && Array.isArray(submission.scenario_results)) {
    const result = await loadScenarios(submission, scenarioFetcher);
    scenarioErrors = result.errors;
    scenarioWarnings = result.warnings || [];
    scenarios = result.scenarios;
  }

  // 4. Call verifier
  const record = await verify(submission, {
    globalPolicy,
    repoPolicy,
    provenance,
    policyVersion,
    scenarios
  });

  logStage('verify_complete', {
    submission_id: submissionId,
    correlation_id,
    status: record.verification?.status ?? null,
    rejection_reason_count: record.verification?.rejection_reasons?.length ?? 0,
    verdict: record.overall_verdict?.verified ?? null,
    // F-41872706: same post-load scenario breakdown as ingest()'s
    // verify_complete, so verify-only and real ingest produce identical NDJSON
    // observability for the same submission.
    scenarios_loaded: scenarios ? scenarios.size : 0,
    required_steps_gates_fired: countRequiredStepsGates(scenarios),
    scenarios_warned: scenarioWarnings.length,
    scenarios_errored: scenarioErrors.length
  });

  // 4b. Mirror ingest's scenario-error verdict downgrade so verify-only and
  //     real ingest produce identical records for the same submission.
  appendScenarioWarnings(record, scenarioWarnings);
  if (scenarioErrors.length > 0) {
    record.verification.rejection_reasons.push(...scenarioLoadReasons(scenarioErrors));
    if (record.verification.status === 'accepted' && scenarioErrors.length > 0) {
      record.verification.status = 'rejected';
      record.verification.policy_valid = false;
      if (record.overall_verdict.verified === 'pass') {
        record.overall_verdict.verified = 'fail';
        record.overall_verdict.downgraded = true;
        if (!record.overall_verdict.downgrade_reasons) {
          record.overall_verdict.downgrade_reasons = [];
        }
        record.overall_verdict.downgrade_reasons.push('scenario definitions could not be loaded');
      }
    }
  }

  // 5. Compute would_persist_to without writing.
  //    `_skipPersist` records lack the fields needed by computeRecordPath()
  //    (repo, run_id, timing.finished_at). Surface null in that case — same
  //    semantic as the real-ingest `rejected_pre_persist` branch.
  let would_persist_to = null;
  if (record._skipPersist) {
    delete record._skipPersist;
  } else {
    try {
      would_persist_to = computeRecordPath(record, repoRoot);
    } catch {
      // Defensive: if a record passes verify() but still trips path
      // computation (e.g., a future schema with looser constraints), keep
      // verify-only side-effect-free. Real ingest would surface the throw
      // via writeRecord; verify-only just returns null and lets the operator
      // see the rejection in record.verification.rejection_reasons.
      would_persist_to = null;
    }
  }

  logStage('verify_only_complete', {
    submission_id: submissionId,
    correlation_id,
    status: record.verification?.status ?? null,
    // d3-ingest-003: posixify at the log boundary. The returned
    // `would_persist_to` below stays OS-native so callers that resolve it
    // against the filesystem keep a real fs path.
    would_persist_to: posixifyPath(would_persist_to)
  });

  return { record, would_persist_to, verify_only: true };
}

/**
 * D1B-001: emit a single structured `stage:'error'` NDJSON event for any
 * CLI-toplevel exit-2 failure, mirroring the shape used by the
 * `rebuild_indexes` inner catch. Truncates the stack to 20 lines so the
 * event stays grep-friendly. The human-readable `console.error` line is
 * preserved so log-only readers continue to get the same actionable hint.
 *
 * Keep this hoisted (above the `isMain` block) so it is callable from every
 * branch inside the CLI body — including the JSON.parse catch which fires
 * BEFORE the pipeline has assigned a correlation_id from `submission.run_id`.
 */
function emitCliErrorEvent({ failedStage, correlationId, submissionId = null, err, humanPrefix }) {
  const truncatedStack = err && err.stack
    ? err.stack.split('\n').slice(0, 20).join('\n')
    : null;
  logStage('error', {
    submission_id: submissionId,
    correlation_id: correlationId,
    failed_stage: failedStage,
    message: err && err.message ? err.message : String(err),
    stack: truncatedStack
  });
  console.error(`ERROR: ${humanPrefix}: ${err && err.message ? err.message : String(err)}`);
}

// --- CLI entrypoint ---
// When run directly, reads submission from stdin or file argument

// F-9a65b10c (Stage C humanization): the write-path CLI ships a USAGE block like
// every other bin (verify/cli.js, report/cli.js, portfolio/generate.js). This is
// the only operator-facing entry point that writes records, so its reference has
// to live IN the tool, not scattered across docs.
const USAGE = `ingest — persist a dogfood submission (verify → policy → provenance → write)

USAGE:
  node packages/ingest/run.js --file <path>   --provenance=github|stub
  node packages/ingest/run.js --payload '<json>' --provenance=github|stub
  echo '<json>' | node packages/ingest/run.js --provenance=github|stub

INPUT (exactly one; stdin used when neither flag is given):
  --file <path>        Read the submission JSON from a file.
  --payload <json>     Pass the submission JSON inline.
  (stdin)              Pipe the submission JSON on stdin.

PROVENANCE (required for an ingest):
  --provenance=github  Confirm the source run via the GitHub API.
  --provenance=stub    No-network local confirm (dry-run / dev only).

MODES:
  --verify-only        Run the full pipeline WITHOUT writing or rebuilding
                       indexes; report where a real ingest WOULD have landed.

STANDALONE AUDIT VERBS (no submission, no stdin, no --provenance):
  --verify-chain       Verify the append-only integrity ledger (offline).
    --reconcile        Also fail on on-disk records missing from the ledger.
    --all              Report every independent break instead of the first.
  --anchor-compute     Compute + write the next XRPL anchor manifest (offline).
  --anchor-post        Compute if needed + post the anchor to XRPL (needs XRPL_SEED).
  --anchor-verify      Verify local manifests + run the truncation check (offline).

  -h, --help           Show this help.

EXIT CODES:
  0  success     1  integrity/audit break     2  operator error (flags / IO / JSON)`;

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__dirname, 'run.js');

if (isMain) {
  const args = process.argv.slice(2);
  // SEED-2 (d3-ingest-002) — make the CLI's repoRoot overridable so callers
  // (notably dogfood-swarm's commands/persist.js execSync, and any test
  // harness) can redirect every record write + index rebuild into a sandbox
  // instead of the REAL working tree. Without this the only way to sandbox was
  // a brittle source-copy of this file (the setupTempRunJs run.js-copy in
  // d1b-001-cli-toplevel-error-event.test.js) that rewrote __dirname's `../..`
  // walk. A production caller passes the real root explicitly; a test passes a
  // temp dir; the default preserves the historical behavior when the env var
  // is unset. resolve() makes a relative override absolute so the downstream
  // join()s stay anchored.
  const repoRoot = process.env.INGEST_REPO_ROOT
    ? resolve(process.env.INGEST_REPO_ROOT)
    : resolve(__dirname, '../..');

  // Parse CLI flags
  let submissionJson;
  let provenanceMode = null;
  let verifyOnlyFlag = false;
  let verifyChainFlag = false;
  // --verify-chain modifiers (only meaningful alongside it):
  //   --reconcile → collectOrphans (INGEST-PROACT-001): also flag on-disk records
  //     absent from the ledger (a torn persist). Makes the audit fail on orphans.
  //   --all → collectAllBreaks (INGEST-PROACT-004): continue past the first
  //     per-record-independent break and report every break in one pass.
  let reconcileFlag = false;
  let allBreaksFlag = false;
  let helpFlag = false;
  // Anchor verbs (optional, off-by-default, operator-run). --anchor-compute and
  // --anchor-verify are fully offline (never import xrpl); --anchor-post lazily
  // loads the optional xrpl package and needs XRPL_SEED.
  let anchorComputeFlag = false;
  let anchorPostFlag = false;
  let anchorVerifyFlag = false;
  let anchorMode = 'since-last';
  let anchorAlgo = null;
  let anchorNetwork = null;
  let anchorTxFile = null;
  let anchorTrustedAccounts = [];
  const positionalArgs = [];

  for (let i = 0; i < args.length; i++) {
    // Accept BOTH the space form (`--flag value`) and the equals form
    // (`--flag=value`). The prior parser matched only the space form, so a
    // caller passing `--provenance=stub --file=...` (the shape dogfood-swarm's
    // commands/persist.js builds for its execSync invocation) fell through to
    // positionalArgs — `--provenance` then read as missing and the CLI exited 2
    // ("--provenance flag is required"), silently breaking `swarm persist
    // --ingest` on every platform. (dogfood-swarm self-audit follow-up.)
    let arg = args[i];
    let inlineValue = null;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        inlineValue = arg.slice(eq + 1);
        arg = arg.slice(0, eq);
      }
    }
    // A space-form value is the NEXT token only when it is not itself a flag —
    // otherwise `--flag --next` would swallow `--next` as `--flag`'s value and
    // silently drop it. A `--`-prefixed next token means this flag has no value,
    // so it falls through to its "requires a value" path (for `--provenance`,
    // the downstream "--provenance flag is required" error).
    const nextIsValue = args[i + 1] !== undefined && !args[i + 1].startsWith('--');
    const hasValue = inlineValue !== null || nextIsValue;
    const takeValue = () => (inlineValue !== null ? inlineValue : args[++i]);

    if (arg === '--provenance' && hasValue) {
      provenanceMode = takeValue();
    } else if (arg === '--file' && hasValue) {
      const { readFileSync } = await import('node:fs');
      // D1B-001 family (operator-legibility): a --file read failure
      // (ENOENT/EACCES) routes through the structured error event and exits 2
      // — pre-fix it propagated as a raw uncaught stack + exit 1, with NO
      // grep-able `"stage":"error"` NDJSON line. This read runs during
      // arg-parsing, BEFORE `cliCorrelationId` is seeded below, so synth a
      // correlation id here (the same pivot the JSON.parse catch uses when
      // there is no submission to derive a run_id from yet).
      try {
        submissionJson = readFileSync(resolve(takeValue()), 'utf-8');
      } catch (err) {
        emitCliErrorEvent({
          failedStage: 'cli_read_file',
          correlationId: synthCorrelationId(),
          err,
          humanPrefix: 'could not read --file payload'
        });
        process.exit(2);
      }
    } else if (arg === '--payload' && hasValue) {
      submissionJson = takeValue();
    } else if (arg === '--verify-only') {
      // F-252714-058: dry-run the pipeline without writing or rebuilding
      // indexes. CI / operators preview what WOULD have been persisted.
      verifyOnlyFlag = true;
    } else if (arg === '--verify-chain') {
      // Integrity chain v1: verify the append-only tamper-evident ledger at
      // indexes/integrity/chain.jsonl, fully offline. No submission, no stdin,
      // no provenance — a standalone audit command.
      verifyChainFlag = true;
    } else if (arg === '--reconcile') {
      // Modifier for --verify-chain: also reconcile on-disk records against the
      // ledger and fail on any orphan (INGEST-PROACT-001).
      reconcileFlag = true;
    } else if (arg === '--all') {
      // Modifier for --verify-chain: report every per-record-independent break
      // instead of stopping at the first (INGEST-PROACT-004).
      allBreaksFlag = true;
    } else if (arg === '--anchor-compute') {
      // Optional XRPL anchor: compute + write the next anchor manifest. Offline.
      anchorComputeFlag = true;
    } else if (arg === '--anchor-post') {
      // Optional XRPL anchor: compute if needed + post to XRPL. Needs the
      // optional xrpl package (lazily loaded) and XRPL_SEED.
      anchorPostFlag = true;
    } else if (arg === '--anchor-verify') {
      // Optional XRPL anchor: verify local manifests + run the truncation check.
      // Offline reports honest NOT-verified for the on-chain leg.
      anchorVerifyFlag = true;
    } else if (arg === '--anchor-all') {
      // Genesis snapshot mode for compute/post (covers the whole chain).
      anchorMode = 'all';
    } else if (arg === '--anchor-algo' && hasValue) {
      anchorAlgo = takeValue();
    } else if (arg === '--anchor-network' && hasValue) {
      anchorNetwork = takeValue();
    } else if (arg === '--anchor-tx' && hasValue) {
      // Path to a JSON file containing a fetched XRPL tx (with Memos) for the
      // on-chain leg of --anchor-verify. Offline-honest: omit it to run the
      // truncation check only.
      anchorTxFile = takeValue();
    } else if (arg === '--anchor-trusted' && hasValue) {
      // Comma-separated trusted anchor accounts (UNIONed with the bundled list).
      anchorTrustedAccounts = takeValue().split(',').map((s) => s.trim()).filter(Boolean);
    } else if (arg === '-h' || arg === '--help' || arg === '--usage') {
      helpFlag = true;
    } else {
      positionalArgs.push(args[i]);
    }
  }

  // F-9a65b10c: print USAGE and exit 0 before any input resolution — help must
  // never block on stdin or demand a --provenance flag.
  if (helpFlag) {
    console.log(USAGE);
    process.exit(0);
  }

  // --verify-chain is a standalone, side-effect-free audit: it reads only the
  // ledger + the record files it references, takes no submission, reads no
  // stdin, and needs no provenance adapter. Handle it BEFORE the stdin read and
  // provenance resolution so `node run.js --verify-chain` does not block on
  // stdin or demand a --provenance flag. Exit 0 when the chain verifies, 1 on
  // the first break (operator-legible output, no raw stack traces).
  if (verifyChainFlag) {
    const result = verifyChain(repoRoot, {
      collectOrphans: reconcileFlag,
      collectAllBreaks: allBreaksFlag,
    });
    logStage(result.ok ? 'verify_chain_complete' : 'error', {
      correlation_id: synthCorrelationId(),
      ...(result.ok ? {} : { failed_stage: 'verify_chain' }),
      verified: result.count,
      head_digest: result.head_digest,
      chain_ok: result.ok,
      ...(result.break ? { break_seq: result.break.seq, break_reason: result.break.reason } : {}),
      // INGEST-PROACT-004 / -001: surface the full corruption scope when the
      // operator asked for it, so a grep of the NDJSON shows how many breaks and
      // orphans were found, not just the first break.
      ...(Array.isArray(result.breaks) ? { break_count: result.breaks.length } : {}),
      ...(Array.isArray(result.orphans) ? { orphan_count: result.orphans.length } : {})
    });
    const lines = formatChainResult(result);
    if (result.ok) {
      for (const line of lines) console.log(line);
    } else {
      for (const line of lines) console.error(line);
    }
    process.exit(result.ok ? 0 : 1);
  }

  // Optional XRPL anchor verbs — operator-run, off by default, NOT in the normal
  // ingest/CI path. Like --verify-chain these are standalone audit/operations:
  // no submission, no stdin, no provenance adapter. --anchor-compute and
  // --anchor-verify are fully offline (never import xrpl); --anchor-post lazily
  // loads the optional xrpl package and needs XRPL_SEED. Each handler returns
  // { ok, exitCode, lines, event } and run.js owns the console + logStage + exit.
  if (anchorComputeFlag || anchorPostFlag || anchorVerifyFlag) {
    const correlation_id = synthCorrelationId();
    let result;
    if (anchorComputeFlag) {
      result = handleAnchorCompute(repoRoot, {
        mode: anchorMode,
        ...(anchorAlgo ? { algo: anchorAlgo } : {}),
        ...(anchorNetwork ? { network: anchorNetwork } : {}),
      });
    } else if (anchorPostFlag) {
      result = await handleAnchorPost(repoRoot, {
        mode: anchorMode,
        ...(anchorNetwork ? { network: anchorNetwork } : {}),
      });
    } else {
      // --anchor-verify: optionally load a fetched tx JSON for the on-chain leg.
      let tx;
      if (anchorTxFile) {
        const { readFileSync } = await import('node:fs');
        try {
          tx = JSON.parse(readFileSync(resolve(anchorTxFile), 'utf-8'));
        } catch (err) {
          emitCliErrorEvent({
            failedStage: 'anchor_verify_read_tx',
            correlationId: correlation_id,
            err,
            humanPrefix: 'could not read --anchor-tx file'
          });
          process.exit(2);
        }
      }
      result = handleAnchorVerify(repoRoot, { tx, trustedAnchorAccounts: anchorTrustedAccounts });
    }

    // logStage strips any inner `stage:` field (the positional name wins), so
    // spreading result.event — which carries its own `stage` — is safe.
    logStage(result.event.stage, { correlation_id, ...result.event });
    const sink = result.exitCode === 0 ? console.log : console.error;
    for (const line of result.lines) sink(line);
    process.exit(result.exitCode);
  }

  if (!submissionJson) {
    // F-aa67ea9a (Stage C humanization): guard an interactive stdin. Without a
    // piped payload, `for await (…process.stdin)` blocks forever at a TTY —
    // exactly what a first-run operator who forgot to pipe input types — and
    // looks like a hang. Fail fast with the same empty-state error verify/cli.js
    // gives, naming the concrete input levers.
    if (process.stdin.isTTY) {
      console.error('ERROR: no submission provided');
      console.error(
        "  hint: pass --file <path> or --payload '<json>', or pipe JSON on stdin; " +
        'run --help for usage.'
      );
      process.exit(2);
    }
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    submissionJson = Buffer.concat(chunks).toString('utf-8');
  }

  // D1B-001 (Stage C humanization): every CLI exit-2 path emits a structured
  // `logStage('error', ...)` event before `process.exit(2)` so a grep of
  // `"stage":"error"` across runner logs surfaces the failure with the same
  // discipline as the inner `rebuild_indexes` catch. `failed_stage` names
  // the last-successful pipeline stage; `correlation_id` carries the pivot
  // key (submission.run_id when available, synth `ing-…` otherwise).
  let lastSuccessfulStage = 'cli_startup';
  let cliCorrelationId = synthCorrelationId();

  let submission;
  try {
    submission = JSON.parse(submissionJson);
    if (typeof submission === 'string') {
      submission = JSON.parse(submission);
    }
    lastSuccessfulStage = 'cli_parse_payload';
    // Promote the synth id to submission.run_id when we have one.
    cliCorrelationId = resolveCorrelationId(submission);
  } catch (err) {
    emitCliErrorEvent({
      failedStage: 'cli_parse_payload',
      correlationId: cliCorrelationId,
      err,
      humanPrefix: 'invalid JSON payload'
    });
    process.exit(2);
  }

  // Resolve provenance adapter — explicit, never implicit.
  //
  // L1-001 (Wave A2 amend2): every exit-2 path here routes through
  // `emitCliErrorEvent` so the D1B-001 documented invariant ("every CLI
  // exit-2 path emits a structured logStage('error', …) event") holds.
  // `failed_stage='cli_provenance_resolve'` names the precondition; the
  // `console.error` line is preserved inside the helper so log-only
  // readers keep the same actionable hint.
  let provenance;
  if (provenanceMode === 'stub') {
    // Structural anti-misuse: stub only allowed outside CI
    if (isCI()) {
      emitCliErrorEvent({
        failedStage: 'cli_provenance_resolve',
        correlationId: cliCorrelationId,
        submissionId: submission && submission.run_id ? submission.run_id : null,
        err: new Error('--provenance=stub is not allowed in CI/production. Use --provenance=github.'),
        humanPrefix: 'provenance precondition unmet'
      });
      process.exit(2);
    }
    console.error('WARNING: Using stub provenance (test/dev only). Records will NOT have real provenance verification.');
    provenance = stubProvenance;
  } else if (provenanceMode === 'github') {
    // --provenance=github selects REAL provenance; the actual provider is taken
    // from submission.source.provider, so a GitLab submission is confirmed via
    // gitlabProvenance end-to-end (the adapter registry keys on the provider).
    const resolved = resolveProviderProvenance(submission);
    if (resolved.err) {
      emitCliErrorEvent({
        failedStage: 'cli_provenance_resolve',
        correlationId: cliCorrelationId,
        submissionId: submission && submission.run_id ? submission.run_id : null,
        err: resolved.err,
        humanPrefix: 'provenance precondition unmet'
      });
      process.exit(2);
    }
    provenance = resolved.provenance;
  } else if (isCI()) {
    // In CI without an explicit flag: default to real provenance, routed by the
    // submission's source.provider (github | gitlab).
    const resolved = resolveProviderProvenance(submission);
    if (resolved.err) {
      emitCliErrorEvent({
        failedStage: 'cli_provenance_resolve',
        correlationId: cliCorrelationId,
        submissionId: submission && submission.run_id ? submission.run_id : null,
        err: resolved.err,
        humanPrefix: 'provenance precondition unmet'
      });
      process.exit(2);
    }
    provenance = resolved.provenance;
  } else {
    emitCliErrorEvent({
      failedStage: 'cli_provenance_resolve',
      correlationId: cliCorrelationId,
      submissionId: submission && submission.run_id ? submission.run_id : null,
      err: new Error('--provenance flag is required. Use --provenance=github (production) or --provenance=stub (test/dev only).'),
      humanPrefix: 'provenance precondition unmet'
    });
    process.exit(2);
  }

  // F-3bfc2885: construct a scenario fetcher for the production path. Before
  // this, the CLI never passed one, so scenario definitions — and with them the
  // `step-results-present` / `step-verdict-consistent` required_steps gates —
  // were test-only: an operator-declared severity:reject rule silently passed.
  // Real (non-stub) provenance + a github-provider submission loads scenario
  // definitions from the source repo at the persisted commit, reusing the token
  // resolveProviderProvenance already validated. GitLab submissions have no
  // scenario fetcher yet (no gitlab contents-API adapter exists); their
  // required_steps gate remains unenforced — a known, documented gap.
  // V2-INVARIAN-004: the eligibility condition is the exported, unit-tested
  // resolveScenarioFetcherDecision above.
  // F-b04473d5: log the decision — an operator auditing an accepted record
  // must be able to tell "required_steps enforced" from "enforcement skipped
  // (and why)" straight from the NDJSON stream.
  const scenarioDecision = resolveScenarioFetcherDecision(provenance, submission, process.env);
  const scenarioFetcher = scenarioDecision.fetcher;
  logStage('scenario_enforcement', {
    submission_id: submission && typeof submission === 'object' && !Array.isArray(submission)
      ? (submission.run_id || null)
      : null,
    correlation_id: cliCorrelationId,
    active: scenarioDecision.active,
    ...(scenarioDecision.reason ? { reason: scenarioDecision.reason } : {}),
    scenario_count: submission && typeof submission === 'object' && Array.isArray(submission.scenario_results)
      ? submission.scenario_results.length
      : 0
  });

  // D1B-001: track the last successful pipeline stage so the outer catch
  // can surface a useful `failed_stage` in its structured error event.
  // We update it once the verify/ingest call has RETURNED — anything
  // thrown inside `ingest()` or `verifyOnly()` is, by definition, a
  // pipeline-runtime failure for which the wrapper itself is the failing
  // boundary. `cli_pipeline` is the right label there; the inner code
  // paths that throw have already emitted their own structured rejection
  // events (`rejected_pre_persist`, `rebuild_indexes_complete` etc.)
  // when they could.
  try {
    if (verifyOnlyFlag) {
      const result = await verifyOnly(submission, { repoRoot, provenance, scenarioFetcher });
      lastSuccessfulStage = 'verify_only';

      console.log(JSON.stringify({
        status: result.record.verification.status,
        run_id: result.record.run_id ?? null,
        verdict: result.record.overall_verdict?.verified ?? null,
        // d3-ingest-003: posixify path-shaped CLI output so the operator
        // contract is identical across OSes (a Windows backslash here breaks
        // any downstream URL-build/string-match).
        would_persist_to: posixifyPath(result.would_persist_to),
        verify_only: true,
        rejection_reasons: result.record.verification.rejection_reasons ?? []
      }));

      // Same accepted/rejected exit-code contract as a real ingest so CI
      // wrappers can swap `--verify-only` in/out without changing their
      // exit-code handling.
      process.exit(result.record.verification.status === 'accepted' ? 0 : 1);
    }

    const result = await ingest(submission, { repoRoot, provenance, scenarioFetcher });
    lastSuccessfulStage = 'ingest';

    if (result.duplicate) {
      console.log(JSON.stringify({ status: 'duplicate', run_id: submission.run_id }));
      process.exit(0);
    }

    console.log(JSON.stringify({
      status: result.record.verification.status,
      run_id: result.record.run_id ?? null,
      verdict: result.record.overall_verdict?.verified ?? null,
      // d3-ingest-003: posixify path-shaped CLI output (same family as
      // would_persist_to above). dogfood-swarm's persist.js pivots on this.
      path: posixifyPath(result.path),
      written: result.written,
      rejection_reasons: result.record.verification.rejection_reasons ?? []
    }));

    process.exit(result.record.verification.status === 'accepted' ? 0 : 1);
  } catch (err) {
    // D1B-001 (Stage C humanization): emit the structured error event
    // BEFORE exit 2 so `"stage":"error"` greps land. `failed_stage` is
    // the last stage that DID complete — anything inside `ingest()` /
    // `verifyOnly()` that throws has, by definition, blown the boundary
    // we were about to cross.
    const submissionId =
      submission && typeof submission === 'object' && !Array.isArray(submission)
        ? (submission.run_id || null)
        : null;
    emitCliErrorEvent({
      failedStage: lastSuccessfulStage,
      correlationId: cliCorrelationId,
      submissionId,
      err,
      humanPrefix: 'ingest failed'
    });
    process.exit(2);
  }
}
