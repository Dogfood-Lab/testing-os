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

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validatePayload } from '@dogfood-lab/schemas';

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

  const required = { repo, commitSha, startedAt, finishedAt, scenarioResults };
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
    schema_version: '1.0.0',
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

const isMain = process.argv[1]?.endsWith('build-submission.js');

if (isMain) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : null;
  };

  const scenarioFile = get('--scenario-file');
  if (!scenarioFile) {
    console.error('Usage: node build-submission.js --scenario-file <path> [--output <path>] ...');
    process.exit(1);
  }

  const scenarioResults = JSON.parse(readFileSync(resolve(scenarioFile), 'utf-8'));

  const submission = buildSubmission({
    repo: get('--repo') || process.env.GITHUB_REPOSITORY,
    commitSha: get('--commit') || process.env.GITHUB_SHA,
    branch: get('--branch') || process.env.GITHUB_REF_NAME,
    workflow: get('--workflow') || process.env.GITHUB_WORKFLOW,
    providerRunId: get('--provider-run-id') || process.env.GITHUB_RUN_ID,
    runUrl: get('--run-url') || `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    attempt: Number(get('--attempt') || process.env.GITHUB_RUN_ATTEMPT || 1),
    actor: get('--actor') || process.env.GITHUB_ACTOR,
    startedAt: get('--started-at') || new Date().toISOString(),
    finishedAt: get('--finished-at') || new Date().toISOString(),
    scenarioResults: Array.isArray(scenarioResults) ? scenarioResults : [scenarioResults],
    overallVerdict: get('--verdict') || 'pass',
    notes: get('--notes')
  });

  const precheck = precheckSubmission(submission);
  if (!precheck.valid) {
    console.error('Precheck failed:');
    for (const e of precheck.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const output = get('--output') || '-';
  const json = JSON.stringify(submission, null, 2) + '\n';

  if (output === '-') {
    process.stdout.write(json);
  } else {
    writeFileSync(resolve(output), json, 'utf-8');
    console.error(`Wrote submission to ${output}`);
  }
}
