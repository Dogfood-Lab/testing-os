/**
 * dogfood-labs verifier
 *
 * Central law engine. Takes a submission payload and produces a persisted record.
 * Validates schema, policy, provenance. Sets verifier-owned fields.
 * Never upgrades a proposed verdict.
 */

import { validateSubmissionSchema as _defaultValidateSubmissionSchema } from './validators/schema.js';
import { validatePolicy as _defaultValidatePolicy } from './validators/policy.js';
import { validateStepResults as _defaultValidateStepResults } from './validators/steps.js';
import { validateSchemaVersion as _defaultValidateSchemaVersion } from './validators/schema-version.js';
import { computeVerdict } from './validators/verdict.js';
import { SUPPORTED_SCHEMA_VERSIONS } from '@dogfood-lab/schemas';

// F1-CONTRACTS-003: re-export the rejection-reason classifier from the package
// root so consumers `import { parseRejectionReason } from '@dogfood-lab/verify'`
// instead of hand-rolling .startsWith() chains over the prefix taxonomy.
export { parseRejectionReason } from './parse-rejection.js';

// F1-CONTRACTS-001: the persisted record's `schema_version` is the SINGLE
// source of truth from the contract package — not a hardcoded literal that
// can drift from `SUPPORTED_SCHEMA_VERSIONS.record.current`.
const RECORD_SCHEMA_VERSION = SUPPORTED_SCHEMA_VERSIONS.record.current;

/**
 * D1B-003 (Stage C humanization): the SOLE catch wrapper for synchronous
 * validator calls. Distinguishes operator-actionable signals:
 *
 *   - Validator returned a structured result → caller pushes the existing
 *     `'<class>: <details>'` prefix into `rejection_reasons` (unchanged
 *     submission-bad path; back-compat is preserved).
 *   - Validator THREW (operational incident — ajv compile fault, policy
 *     merge cycle, out-of-memory) → wrapper synthesizes a STABLE coded
 *     prefix `'VALIDATOR_FAULT_<NAME>: <details>'` for the caller to push.
 *     The prefix is greppable across runner logs:
 *       `grep -E '"VALIDATOR_FAULT_' …`  → every operational incident
 *       `grep -E '^(schema|policy|steps): ' …` → every submission-bad signal
 *
 * `name` is upper-cased to match the prefix vocabulary documented in
 * verify/README.md (SCHEMA / POLICY / STEPS). Returns:
 *   { ok: true, result }   when fn() returned cleanly
 *   { ok: false, faultReason } when fn() threw
 *
 * The helper is the canonical seam for any new synchronous validator
 * — adding a 4th validator class becomes a one-call site, not a
 * five-line try/catch boilerplate.
 *
 * @param {string} name - Validator class name (will be upper-cased).
 * @param {() => T} fn - The validator call.
 * @returns {{ ok: true, result: T } | { ok: false, faultReason: string }}
 * @template T
 */
function runValidator(name, fn) {
  try {
    return { ok: true, result: fn() };
  } catch (e) {
    const cls = name.toUpperCase();
    const detail = e && e.message ? e.message : String(e);
    return { ok: false, faultReason: `VALIDATOR_FAULT_${cls}: ${detail}` };
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
        rejection_reasons: ['submission is null or not an object']
      }
    };
  }

  const { globalPolicy, repoPolicy, provenance, policyVersion, validators: validatorOverrides = {} } = options;
  // Resolve the three validators per-call so tests can inject fault-
  // injecting stubs. Production callers leave `validators` unset and the
  // module-level imports flow through unchanged.
  const validateSubmissionSchema = validatorOverrides.validateSubmissionSchema || _defaultValidateSubmissionSchema;
  const validateStepResults = validatorOverrides.validateStepResults || _defaultValidateStepResults;
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
  //    Format: https://github.com/{owner}/{repo}/actions/runs/{id}
  if (submission.repo && submission.source?.run_url) {
    const m = submission.source.run_url.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/\d+$/
    );
    if (m) {
      const sourceRepo = `${m[1]}/${m[2]}`;
      if (sourceRepo !== submission.repo) {
        reasons.push(
          `repo:mismatch: submission.repo (${submission.repo}) does not match source.run_url repo (${sourceRepo})`
        );
      }
    }
  }

  // 1. Schema validation
  // D1B-003: route both happy + fault paths through `runValidator` so
  // submission-bad (`'schema: …'`) and operational incidents
  // (`'VALIDATOR_FAULT_SCHEMA: …'`) emit DISTINCT, greppable prefixes.
  let schemaResult = { valid: false, errors: [] };
  const schemaRun = runValidator('schema', () => validateSubmissionSchema(submission));
  if (schemaRun.ok) {
    schemaResult = schemaRun.result;
    if (!schemaResult.valid) {
      reasons.push(...schemaResult.errors.map(e => `schema: ${e}`));
    }
  } else {
    reasons.push(schemaRun.faultReason);
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
  // reason; an unknown-contract throw surfaces as
  // `VALIDATOR_FAULT_CONTRACT_SCHEMA_VERSION` via the same runValidator seam.
  const versionRun = runValidator('contract_schema_version', () => validateSchemaVersion(submission, 'recordSubmission'));
  if (versionRun.ok) {
    if (!versionRun.result.valid) {
      reasons.push(...versionRun.result.errors);
    }
  } else {
    reasons.push(versionRun.faultReason);
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
      provenanceConfirmed = await provenance.confirm(submission.source);
    } catch (err) {
      reasons.push(`provenance: verification failed: ${err.message}`);
    }
    if (!provenanceConfirmed && !reasons.some(r => r.startsWith('provenance:'))) {
      reasons.push('provenance: source run could not be confirmed');
    }
  }

  // 4. Step results validation (only if schema passed)
  // D1B-003: same submission-bad-vs-operational-fault split as schema.
  if (schemaResult.valid && submission.scenario_results) {
    for (const scenario of submission.scenario_results) {
      const stepsRun = runValidator('steps', () => validateStepResults(scenario));
      if (stepsRun.ok) {
        reasons.push(...stepsRun.result.map(e => `steps[${scenario.scenario_id}]: ${e}`));
      } else {
        reasons.push(stepsRun.faultReason);
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
  if (schemaResult.valid) {
    if (repoPolicy && repoPolicy.__torn === true) {
      const detail = repoPolicy.reason || 'repo policy YAML failed to parse';
      reasons.push(`policy: repo policy unreadable — ${detail}`);
      // policyValid stays false.
    } else {
      const policyRun = runValidator('policy', () => validatePolicy(submission, { globalPolicy, repoPolicy }));
      if (policyRun.ok) {
        policyValid = policyRun.result.valid;
        reasons.push(...policyRun.result.errors.map(e => `policy: ${e}`));
      } else {
        reasons.push(policyRun.faultReason);
      }
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
      rejection_reasons: reasons
    },
    ...(submission.notes ? { notes: submission.notes } : {})
  };

  return persisted;
}
