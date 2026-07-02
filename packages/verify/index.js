/**
 * dogfood-labs verifier
 *
 * Central law engine. Takes a submission payload and produces a persisted record.
 * Validates schema, policy, provenance. Sets verifier-owned fields.
 * Never upgrades a proposed verdict.
 */

import { validateSubmissionSchema as _defaultValidateSubmissionSchema } from './validators/schema.js';
import { validatePolicy as _defaultValidatePolicy } from './validators/policy.js';
import {
  validateStepResults as _defaultValidateStepResults,
  validateRequiredSteps as _defaultValidateRequiredSteps
} from './validators/steps.js';
import { validateSchemaVersion as _defaultValidateSchemaVersion } from './validators/schema-version.js';
import { computeVerdict } from './validators/verdict.js';
import { parseRunUrlRepo } from './validators/repo-binding.js';
import { SUPPORTED_SCHEMA_VERSIONS } from '@dogfood-lab/schemas';

// F1-CONTRACTS-003: re-export the rejection-reason classifier from the package
// root so consumers `import { parseRejectionReason } from '@dogfood-lab/verify'`
// instead of hand-rolling .startsWith() chains over the prefix taxonomy.
export { parseRejectionReason } from './parse-rejection.js';

// Provider-keyed provenance selection. A submission's `source.provider` decides
// which provider API confirms its run; `provenanceForProvider(provider)` returns
// the matching adapter factory (or null for an unknown provider). Re-exported
// from the package root so the wiring layer selects by provider here rather than
// hand-rolling an if-chain over provider literals. The registry stays in lockstep
// with the source.provider enum via validators/provenance-registry.test.js.
export { provenanceForProvider, PROVENANCE_ADAPTERS } from './validators/provenance.js';

// F1-CONTRACTS-001: the persisted record's `schema_version` is the SINGLE
// source of truth from the contract package — not a hardcoded literal that
// can drift from `SUPPORTED_SCHEMA_VERSIONS.record.current`.
const RECORD_SCHEMA_VERSION = SUPPORTED_SCHEMA_VERSIONS.record.current;

/**
 * D1B-003 (Stage C humanization) + F-82429f90 (wave 4): the SOLE catch
 * wrapper for synchronous validator calls. Distinguishes operator-actionable
 * signals:
 *
 *   - Validator returned a structured result → caller pushes the existing
 *     `'<class>: <details>'` prefix into `rejection_reasons` (unchanged
 *     submission-bad path; back-compat is preserved).
 *   - Validator THREW (operational incident — ajv compile fault, policy
 *     merge cycle, out-of-memory) → wrapper RETHROWS a classified error
 *     whose message carries the STABLE coded prefix
 *     `'VALIDATOR_FAULT_<NAME>: <details>'` and whose `.code` is
 *     `VALIDATOR_FAULT_<NAME>`. The prefix is greppable across runner logs:
 *       `grep -E 'VALIDATOR_FAULT_' …`  → every operational incident
 *       `grep -E '^(schema|policy|steps): ' …` → every submission-bad signal
 *
 * F-82429f90 changed the fault path from push-a-rejection-reason to
 * propagate-the-throw: a validator crash is an OPERATIONAL incident, and
 * persisting it as a `_rejected` record permanently poisoned the run_id via
 * ingest's duplicate guard (the exact V2-CROSS-BO-001 pattern the sibling
 * scenario-fetch path already fixed). Both production callers
 * (packages/ingest/run.js's outer catch and cli.js's run() catch) map a
 * verify() throw to exit 2 with NOTHING persisted, so a clean resubmission
 * after recovery is accepted.
 *
 * `name` is upper-cased to match the prefix vocabulary documented in
 * verify/README.md (SCHEMA / POLICY / STEPS).
 *
 * The helper is the canonical seam for any new synchronous validator
 * — adding a 4th validator class becomes a one-call site, not a
 * five-line try/catch boilerplate.
 *
 * @param {string} name - Validator class name (will be upper-cased).
 * @param {() => T} fn - The validator call.
 * @returns {T} fn()'s result when it returned cleanly.
 * @throws {Error} classified `VALIDATOR_FAULT_<NAME>` error when fn() threw.
 * @template T
 */
function runValidator(name, fn) {
  try {
    return fn();
  } catch (e) {
    const cls = name.toUpperCase();
    const detail = e && e.message ? e.message : String(e);
    const fault = new Error(`VALIDATOR_FAULT_${cls}: ${detail}`);
    fault.code = `VALIDATOR_FAULT_${cls}`;
    fault.cause = e;
    throw fault;
  }
}

/**
 * Verify a dogfood submission and produce a persisted record.
 *
 * @param {object} submission - Source-authored submission payload
 * @param {object} options
 * @param {object} options.globalPolicy - Parsed global policy
 * @param {object|null} options.repoPolicy - Parsed repo policy (null if none)
 * @param {object} options.provenance - Provenance adapter { confirm(source) => Promise<boolean> }
 * @param {string} options.policyVersion - Semver of the policy set being applied
 * @param {Map<string, object>|null} [options.scenarios] - Loaded scenario
 *   definitions keyed by scenario_id (from loadScenarios). When present, each
 *   scenario_result is checked against its definition's
 *   success_criteria.required_steps — the REAL enforcement behind the
 *   `step-results-present` / `step-verdict-consistent` global reject rules
 *   (F-3bfc2885). Absent/null keeps the legacy structural-only behavior.
 * @param {object} [options.validators] - Test-only override hook (D1B-003).
 *   Pass `{ validateSubmissionSchema, validateStepResults, validatePolicy }`
 *   to swap in fault-injecting stubs. Production callers leave this unset
 *   and the helper falls back to the module-level imports. The override
 *   exists so the wrapper's catch behaviour can be tested deterministically
 *   without monkey-patching ESM modules (which is a no-op for live bindings).
 *   Documented but not part of the public stability contract — the parameter
 *   may shift shape in future minors.
 * @returns {Promise<object>} Persisted record (accepted or rejected)
 */
export async function verify(submission, options) {
  if (!submission || typeof submission !== 'object' || Array.isArray(submission)) {
    const now = new Date().toISOString();
    // Null/non-object input cannot drive computeRecordPath() (needs repo + run_id +
    // timing.finished_at). Mark _skipPersist so the ingest layer surfaces the
    // rejection without crashing the persist layer with `invalid repo format: undefined`.
    return {
      schema_version: RECORD_SCHEMA_VERSION,
      _skipPersist: true,
      verification: {
        status: 'rejected',
        verified_at: now,
        provenance_confirmed: false,
        schema_valid: false,
        policy_valid: false,
        // verify-B-003: a null/non-object submission is a malfunctioning
        // DISPATCHER (the caller handed us garbage), not a submitter who sent a
        // bad-but-shaped payload. Carry a typed `submission-malformed:` prefix so
        // parseRejectionReason classifies it 'operational' (page the runner) instead
        // of bouncing an ops incident back to the submitter as 'unknown'.
        rejection_reasons: ['submission-malformed: submission is null or not an object']
      }
    };
  }

  const { globalPolicy, repoPolicy, provenance, policyVersion, scenarios = null, validators: validatorOverrides = {} } = options;
  // Resolve the three validators per-call so tests can inject fault-
  // injecting stubs. Production callers leave `validators` unset and the
  // module-level imports flow through unchanged.
  const validateSubmissionSchema = validatorOverrides.validateSubmissionSchema || _defaultValidateSubmissionSchema;
  const validateStepResults = validatorOverrides.validateStepResults || _defaultValidateStepResults;
  const validateRequiredSteps = validatorOverrides.validateRequiredSteps || _defaultValidateRequiredSteps;
  const validatePolicy = validatorOverrides.validatePolicy || _defaultValidatePolicy;
  const validateSchemaVersion = validatorOverrides.validateSchemaVersion || _defaultValidateSchemaVersion;
  const now = new Date().toISOString();
  const reasons = [];

  // 0. Cross-field guard: submission.repo MUST match the owner/repo encoded in
  //    source.run_url. Without this, a submitter can claim
  //    submission.repo='victim-org/victim-repo' while supplying source.run_url for a
  //    real, legitimate run from their own repo. Provenance would confirm (the run
  //    exists), and the persist layer would file the record under victim-org's path
  //    — a forged "pass" verdict for a repo the submitter does not control.
  //
  //    verify-B-001: the run_url shape is PROVIDER-specific, so the decode is keyed
  //    by `source.provider` in validators/repo-binding.js. RUN_URL_PARSERS there MUST
  //    stay in lockstep with the source.provider enum in the submission schema — a
  //    coverage test (validators/repo-binding.test.js) fails CI if a provider is
  //    added to the schema without a parser, so this binding can never silently
  //    no-op for a new provider (which would reopen the verify-A-001 forgery vector).
  if (submission.repo && submission.source?.run_url) {
    const bound = parseRunUrlRepo(submission.source.provider, submission.source.run_url);
    if (bound) {
      const sourceRepo = `${bound.owner}/${bound.repo}`;
      if (sourceRepo !== submission.repo) {
        reasons.push(
          `repo:mismatch: submission.repo (${submission.repo}) does not match source.run_url repo (${sourceRepo})`
        );
      }
    }
  }

  // 1. Schema validation
  // D1B-003 / F-82429f90: submission-bad results push the `'schema: …'`
  // prefix; a validator CRASH propagates out of verify() as a classified
  // VALIDATOR_FAULT_SCHEMA throw (operational — exit 2, nothing persisted).
  const schemaResult = runValidator('schema', () => validateSubmissionSchema(submission));
  if (!schemaResult.valid) {
    reasons.push(...schemaResult.errors.map(e => `schema: ${e}`));
  }

  // 1b. schema_version VALUE gate (F1-CONTRACTS-001)
  // The schema check above gates `schema_version` by PATTERN only. This gate
  // compares the declared MAJOR against `SUPPORTED_SCHEMA_VERSIONS` (the
  // single source of truth in @dogfood-lab/schemas) and refuses an
  // incompatible major instead of silently mis-validating a future contract
  // against the live 1.x schema. It runs INDEPENDENT of `schemaResult.valid`:
  // a future-major payload may also fail shape, but the version refusal is the
  // operator-actionable signal and must land regardless. The validator emits a
  // fully-prefixed `CONTRACT_SCHEMA_TOO_NEW:` / `CONTRACT_SCHEMA_TOO_OLD:`
  // reason; an unknown-contract throw propagates as a classified
  // `VALIDATOR_FAULT_CONTRACT_SCHEMA_VERSION` fault via the same
  // runValidator seam (F-82429f90: operational, never persisted).
  const versionResult = runValidator('contract_schema_version', () => validateSchemaVersion(submission, 'recordSubmission'));
  if (!versionResult.valid) {
    reasons.push(...versionResult.errors);
  }

  // 2. Reject if submission includes verifier-owned fields
  const verifierFields = ['policy_version', 'verification'];
  for (const field of verifierFields) {
    if (field in submission) {
      reasons.push(`submission-contains-verifier-field: ${field}`);
    }
  }
  if (typeof submission.overall_verdict === 'object') {
    reasons.push('submission-contains-verifier-field: overall_verdict must be a string in submissions');
  }

  // 3. Provenance check
  let provenanceConfirmed = false;
  if (schemaResult.valid && submission.source) {
    try {
      // verify-A-001: bind the PERSISTED commit (submission.ref.commit_sha) to the
      // verified run. The record attests to this commit, so the provenance adapter
      // must reject a run whose head differs from it — otherwise a real run can be
      // pointed at an arbitrary persisted sha. Adapters that ignore the binding
      // (stub/rejecting) accept the extra arg harmlessly.
      provenanceConfirmed = await provenance.confirm(submission.source, {
        refCommitSha: submission.ref?.commit_sha
      });
    } catch (err) {
      // verify-A-002 + F-82429f90: the adapter THROWS on operational provider
      // faults (429 rate-limit, 5xx outage, 401/403 token, exhausted-retry
      // transport errors — F-dac7e08c) and returns false only for a
      // genuinely-absent run (HTTP 404). RETHROW as a classified
      // PROVENANCE_FAULT so the incident propagates out of verify() —
      // mirroring SCENARIO_FETCH_FAULT — and is NEVER assembled into a
      // persisted `_rejected` record: persisting an outage-window rejection
      // permanently blocked the run_id via ingest's duplicate guard. Both
      // production callers (ingest run.js outer catch; verify cli.js run()
      // catch) map the throw to exit 2 with nothing persisted. The message
      // keeps the `provenance-fault:` prefix parseRejectionReason classifies
      // as operational. The not-confirmed case below keeps the bare
      // `provenance:` prefix (still submission-bad).
      const fault = new Error(`provenance-fault: verification failed: ${err.message}`);
      fault.code = 'PROVENANCE_FAULT';
      fault.cause = err;
      throw fault;
    }
    if (!provenanceConfirmed) {
      reasons.push('provenance: source run could not be confirmed');
    }
  }

  // 4. Step results validation (only if schema passed)
  // D1B-003: same submission-bad-vs-operational-fault split as schema.
  if (schemaResult.valid && submission.scenario_results) {
    for (const scenario of submission.scenario_results) {
      const stepsErrors = runValidator('steps', () => validateStepResults(scenario));
      reasons.push(...stepsErrors.map(e => `steps[${scenario.scenario_id}]: ${e}`));

      // F-3bfc2885: enforce success_criteria.required_steps when the caller
      // loaded the scenario definition. This is the enforcement behind the
      // `step-results-present` / `step-verdict-consistent` global reject rules
      // that KNOWN_REJECT_RULE_IDS attributes to "verify() itself" — before
      // this wiring, validateRequiredSteps had no callers and the rules were
      // declared-but-unenforced. A scenario_result whose definition failed to
      // load is NOT checked here; loadScenarios already reports that as a
      // `scenario-load:` rejection at the ingest layer.
      if (scenarios && typeof scenarios.get === 'function') {
        const definition = scenarios.get(scenario.scenario_id);
        const requiredSteps = definition?.success_criteria?.required_steps ?? [];
        if (requiredSteps.length > 0) {
          const requiredErrors = runValidator('steps', () => validateRequiredSteps(scenario, requiredSteps));
          reasons.push(...requiredErrors.map(e => `steps[${scenario.scenario_id}]: ${e}`));
        }
      }
    }
  }

  // 5. Policy evaluation (only if schema passed)
  // D1B-003: see runValidator JSDoc for the split. Policy-fault on
  // `globalPolicy` corruption surfaces as `VALIDATOR_FAULT_POLICY:` and
  // is the operator's signal that the POLICY FILE (not the submission)
  // is broken.
  //
  // D1B-006: a torn repo-policy file (sentinel `{ __torn: true, reason }`
  // returned by `loadRepoPolicy`) MUST reject the submission with
  // `policy_valid=false` + a `policy: repo policy unreadable` rejection
  // reason. Pre-fix the sentinel was a silent `null` — the verifier
  // happily ran defaults against a corrupt policy. Catch the sentinel
  // BEFORE handing the (broken) policy to `validatePolicy`, so the
  // operator sees a real "policy:" rejection in `rejection_reasons`.
  let policyValid = false;
  // VERIFY-F4: severity:warn / severity:info policy rules surface here as an
  // accepted-with-warning channel. Warnings NEVER enter `reasons` (which become
  // rejection_reasons and flip status to 'rejected') — they land on
  // verification.warnings at assembly so an operator sees the advisory without
  // the submission being bounced.
  const warnings = [];
  if (schemaResult.valid) {
    if (repoPolicy && repoPolicy.__torn === true) {
      const detail = repoPolicy.reason || 'repo policy YAML failed to parse';
      reasons.push(`policy: repo policy unreadable — ${detail}`);
      // policyValid stays false.
    } else {
      const policyResult = runValidator('policy', () => validatePolicy(submission, { globalPolicy, repoPolicy }));
      policyValid = policyResult.valid;
      reasons.push(...policyResult.errors.map(e => `policy: ${e}`));
      // VERIFY-F1: a malformed REPO custom-rule predicate is a distinct
      // `policy-config:` rejection (submission-bad — the repo authored the bad
      // rule). A malformed GLOBAL predicate never reaches here; it throws and
      // propagates as a classified VALIDATOR_FAULT_POLICY (operational,
      // F-82429f90 — exit 2, nothing persisted) via runValidator.
      reasons.push(...(policyResult.configErrors || []).map(e => `policy-config: ${e}`));
      warnings.push(...(policyResult.warnings || []).map(w => `policy: ${w}`));
    }
  }

  // 6. Compute verdict
  const proposedVerdict = typeof submission.overall_verdict === 'string'
    ? submission.overall_verdict
    : null;

  const hasErrors = reasons.length > 0;
  const status = hasErrors ? 'rejected' : 'accepted';

  const verdictResult = computeVerdict(proposedVerdict, {
    schemaValid: schemaResult.valid,
    policyValid,
    provenanceConfirmed,
    scenarioResults: schemaResult.valid ? submission.scenario_results : [],
    reasons
  });

  // 7. Assemble persisted record
  const persisted = {
    schema_version: RECORD_SCHEMA_VERSION,
    policy_version: policyVersion,
    run_id: submission.run_id,
    repo: submission.repo,
    ref: submission.ref,
    source: submission.source,
    timing: submission.timing,
    ...(submission.ci_checks ? { ci_checks: submission.ci_checks } : {}),
    scenario_results: submission.scenario_results || [],
    overall_verdict: {
      proposed: proposedVerdict,
      verified: verdictResult.verified,
      downgraded: verdictResult.downgraded,
      ...(verdictResult.downgrade_reasons.length > 0
        ? { downgrade_reasons: verdictResult.downgrade_reasons }
        : {})
    },
    verification: {
      status,
      verified_at: now,
      provenance_confirmed: provenanceConfirmed,
      schema_valid: schemaResult.valid,
      policy_valid: policyValid,
      rejection_reasons: reasons,
      ...(warnings.length ? { warnings } : {})
    },
    ...(submission.notes ? { notes: submission.notes } : {})
  };

  return persisted;
}
