/**
 * Submission builder
 *
 * Tiny helper that assembles a canonical submission JSON from structured inputs.
 * Prevents formatting drift across pilot repos. Not a framework.
 *
 * Usage:
 *   node build-submission.js --output submission.json \
 *     --repo org/repo \
 *     --branch main \
 *     --commit abc123... \
 *     --workflow dogfood.yml \
 *     --provider-run-id 12345 \
 *     --run-url https://github.com/... \
 *     --actor ci-bot \
 *     --scenario-file results.json
 *
 * Or as a module:
 *   import { buildSubmission } from './build-submission.js'
 */

import { randomBytes } from 'node:crypto';
import { validatePayload, SUPPORTED_SCHEMA_VERSIONS } from '@dogfood-lab/schemas';

// F-6fff020d: the stamped schema_version derives from the contract package —
// the same key validateSchemaVersion gates on — mirroring verify/index.js's
// F1-CONTRACTS-001 discipline ('not a hardcoded literal that can drift'). When
// the submission contract's major bumps, every consumer scaffolded by this
// builder picks it up with the dependency bump instead of emitting
// CONTRACT_SCHEMA_TOO_OLD until someone hunts down a literal.
const SUBMISSION_SCHEMA_VERSION = SUPPORTED_SCHEMA_VERSIONS.recordSubmission.current;

// ULID-like sortable ID (timestamp prefix + random suffix)
function generateRunId() {
  const ts = Date.now().toString(36).padStart(10, '0');
  const rand = randomBytes(10).toString('base64url').slice(0, 16);
  return `${ts}-${rand}`;
}

const VERIFIER_OWNED_FIELDS = ['policy_version', 'verification'];

/**
 * Build a canonical submission object.
 *
 * @param {object} params
 * @param {string} params.repo - Full org/repo
 * @param {string} params.commitSha - 40-char hex SHA
 * @param {string} [params.branch] - Branch name
 * @param {string} [params.version] - Release version tag
 * @param {string} params.workflow - Workflow filename
 * @param {string} params.providerRunId - GitHub Actions run ID
 * @param {string} params.runUrl - Full URL to the workflow run
 * @param {number} [params.attempt=1] - Workflow attempt number
 * @param {string} [params.actor] - GitHub username that triggered
 * @param {string} params.startedAt - ISO datetime
 * @param {string} params.finishedAt - ISO datetime
 * @param {object[]} params.scenarioResults - Array of scenario result objects
 * @param {object[]} [params.ciChecks] - Array of CI check objects
 * @param {string} params.overallVerdict - Proposed verdict string
 * @param {string} [params.notes]
 * @returns {object} Canonical submission object
 */
export function buildSubmission(params) {
  const {
    repo,
    commitSha,
    branch,
    version,
    workflow,
    providerRunId,
    runUrl,
    attempt = 1,
    actor,
    startedAt,
    finishedAt,
    scenarioResults,
    ciChecks,
    overallVerdict,
    notes
  } = params;

  // F-fc1bbffa: providerRunId was the one required param this check missed —
  // workflow/runUrl are effectively (if accidentally) protected too: an
  // omitted value stays `undefined`, JSON.stringify drops the key entirely,
  // and precheckSubmission's schema gate catches the resulting missing
  // source.workflow/source.run_url downstream. providerRunId instead gets
  // COERCED below (`String(providerRunId)`), and `String(undefined)` is the
  // real, non-empty, 9-character string "undefined" — schema-conformant
  // (provider_run_id is typed string only, no pattern/minLength) and
  // therefore silent all the way to the real verifier, where it fails as a
  // GitHub API 404 on run id "undefined" instead of a clear build-time error.
  const required = { repo, commitSha, startedAt, finishedAt, scenarioResults, providerRunId };
  for (const [name, value] of Object.entries(required)) {
    if (value == null) throw new Error(`buildSubmission: missing required param "${name}"`);
  }

  if (typeof overallVerdict !== 'string') {
    throw new Error('overallVerdict must be a string, not ' + typeof overallVerdict);
  }

  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(finishedAt).getTime();
  const durationMs = endMs - startMs;
  // F-882513-002 — schema requires duration_ms to be a non-negative integer when present;
  // omit it entirely when the timing inputs are malformed (NaN or negative). The previous
  // `null` produced submissions that the central verifier rejected with a misleading
  // "invalid duration_ms" instead of letting the missing-field check speak for itself.
  const hasValidDuration = Number.isFinite(durationMs) && durationMs >= 0;

  const submission = {
    schema_version: SUBMISSION_SCHEMA_VERSION,
    run_id: generateRunId(),
    repo,
    ref: {
      commit_sha: commitSha,
      ...(branch ? { branch } : {}),
      ...(version ? { version } : {})
    },
    source: {
      provider: 'github',
      workflow,
      provider_run_id: String(providerRunId),
      attempt,
      run_url: runUrl,
      ...(actor ? { actor } : {})
    },
    timing: {
      started_at: startedAt,
      finished_at: finishedAt,
      ...(hasValidDuration ? { duration_ms: durationMs } : {})
    },
    ...(ciChecks && ciChecks.length > 0 ? { ci_checks: ciChecks } : {}),
    scenario_results: scenarioResults,
    overall_verdict: overallVerdict,
    ...(notes ? { notes } : {})
  };

  return submission;
}

/**
 * Validate a submission for obvious issues before dispatch.
 *
 * F-246817-006 — this used to be a hand-rolled mirror of a few required-field
 * checks from dogfood-record-submission.schema.json, missing the step_id
 * pattern, scenario_id presence, surface enum, execution_mode enum, verdict
 * enum, and schema_version pattern. Known-bad payloads sailed through and
 * only failed at the central verifier, wasting a CI run with no local hint.
 *
 * It now delegates to {@link validatePayload} from `@dogfood-lab/schemas`
 * (see packages/schemas/src/validate.ts), so local precheck is identical to
 * the central verifier. Verifier-owned-field checks remain on top because
 * Ajv reports them as "additional property" without naming the contract
 * concept; surfacing them with the explicit "verifier-owned" label keeps
 * existing operator-facing error messages.
 *
 * @param {object} submission
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function precheckSubmission(submission) {
  // F-721047-001 — defensive guard: callers can mistakenly hand precheck a
  // null/non-object value (e.g. JSON.parse on an empty file returns null,
  // a typo passes a string). Pre-fix the `field in submission` check on the
  // very next loop threw a raw TypeError instead of returning the documented
  // {valid, errors} shape, breaking the CLI's structured error formatter at
  // lines 207-209. Mirrors wave-8 F-246817-001's clean-rejection philosophy.
  // Arrays are also rejected: scenario_results is an array but a submission
  // root must be a plain object.
  if (submission === null || typeof submission !== 'object' || Array.isArray(submission)) {
    return {
      valid: false,
      errors: ['submission must be a non-null object, not ' + (Array.isArray(submission) ? 'array' : submission === null ? 'null' : typeof submission)]
    };
  }

  const errors = [];

  // Verifier-owned-field checks: surface a precise message before Ajv's
  // generic "must NOT have additional properties" fires.
  for (const field of VERIFIER_OWNED_FIELDS) {
    if (field in submission) {
      errors.push(`submission must not contain verifier-owned field: ${field}`);
    }
  }
  if (submission && typeof submission.overall_verdict === 'object') {
    errors.push('overall_verdict must be a string, not an object (verifier-owned shape)');
  }

  // Central schema validation — identical contract to the wire-side verifier.
  const result = validatePayload('recordSubmission', submission);
  if (!result.valid) {
    for (const e of result.errors) {
      const path = e.path && e.path !== '/' ? e.path : '(root)';
      errors.push(`${path} ${e.message}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// --- CLI entrypoint ---
//
// F-a9d91e67: this module used to carry its own inline arg parser here — a
// second, less-hardened front door to the operation cli.js (the installed
// `dogfood-report`/`report` bin) already provides: no -h/--help, no try/catch
// around the buildSubmission() call (an ordinary flag typo like --reop
// surfaced a raw uncaught stack, the "no raw stacks" class SHIP_GATE hard
// gate B exists to catch), and exit codes that disagreed with cli.js's
// documented contract. The public handbook names
// `node packages/report/build-submission.js ...` as a consumer's first
// command, so the entry point must keep working — it now delegates to
// cli.js's run(), leaving exactly ONE parser, one USAGE block, one
// `ERROR [<CODE>]:` envelope, and one exit-code contract (2 usage /
// 1 precheck) to keep in parity. The import is dynamic so importing this
// module as the package main never loads the CLI layer, and so there is no
// static import cycle (cli.js imports this module's exports).
const isMain = process.argv[1]?.endsWith('build-submission.js');

if (isMain) {
  import('./cli.js')
    .then(({ run }) => run(process.argv.slice(2)))
    .then((code) => process.exit(code));
}
