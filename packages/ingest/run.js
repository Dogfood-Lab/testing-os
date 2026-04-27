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

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verify } from '@dogfood-lab/verify';
import { stubProvenance, githubProvenance } from '@dogfood-lab/verify/validators/provenance.js';
import { logStage as sharedLogStage } from '@dogfood-lab/dogfood-swarm/lib/log-stage.js';
import { loadGlobalPolicy, loadRepoPolicy, loadScenarios } from './load-context.js';
import { isDuplicate, writeRecord } from './persist.js';
import { rebuildIndexes } from './rebuild-indexes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
 * persist_complete | rebuild_indexes_complete | rejected_pre_persist | error.
 *
 * @param {string} stage
 * @param {object} fields - Stage-specific fields. `submission_id` strongly
 *   recommended. Do NOT pass `stage` as an inner field — it would collide
 *   with the outer stage name and the spread is last-wins. For "this stage
 *   failed inside that stage" use `failed_stage` (e.g.
 *   `logStage('error', { failed_stage: 'rebuild_indexes', ... })`).
 */
function logStage(stage, fields = {}) {
  // Defensive against F-827321-035: strip any caller-supplied `stage:`
  // before spreading, so the positional `stage` always wins. The shared
  // helper itself spreads fields last; without this strip, an inner
  // `stage:` would silently overwrite the outer name and a grep of
  // `"stage":"error"` across runner logs would miss the failure.
  const { stage: _ignored, ...safeFields } = fields;
  sharedLogStage(stage, { component: 'ingest', ...safeFields });
}

/**
 * Run the full ingestion pipeline.
 *
 * @param {object} submission - Source-authored submission payload
 * @param {object} options
 * @param {string} options.repoRoot - Absolute path to dogfood-labs repo root
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

  logStage('dispatch_received', {
    submission_id: submissionId,
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
    policy_version: policyVersion,
    repo_policy_present: !!repoPolicy
  });

  // 3. Load scenario definitions (non-fatal if missing — becomes rejection reason)
  let scenarioErrors = [];
  if (scenarioFetcher && submissionIsObject && submission.scenario_results) {
    const result = await loadScenarios(submission, scenarioFetcher);
    scenarioErrors = result.errors;
  }

  // 4. Call verifier — the law engine makes all decisions
  const record = await verify(submission, {
    globalPolicy,
    repoPolicy,
    provenance,
    policyVersion
  });

  logStage('verify_complete', {
    submission_id: submissionId,
    status: record.verification?.status ?? null,
    rejection_reason_count: record.verification?.rejection_reasons?.length ?? 0,
    verdict: record.overall_verdict?.verified ?? null
  });

  // 4b. Append scenario loading errors to rejection reasons if any
  if (scenarioErrors.length > 0) {
    record.verification.rejection_reasons.push(
      ...scenarioErrors.map(e => `scenario-load: ${e}`)
    );
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
      reason: 'skip_persist',
      rejection_reasons: record.verification?.rejection_reasons ?? []
    });
    return { record, path: null, written: false, duplicate: false };
  }
  const persistStart = Date.now();
  const { path, written } = writeRecord(record, repoRoot);
  logStage('persist_complete', {
    submission_id: submissionId,
    path,
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
      logStage('error', {
        submission_id: submissionId,
        failed_stage: 'rebuild_indexes',
        message: err.message
      });
      console.error(`WARNING: record persisted but index rebuild failed: ${err.message} — indexes may be stale`);
    }
  }

  return { record, path, written, duplicate: false };
}

// --- CLI entrypoint ---
// When run directly, reads submission from stdin or file argument

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__dirname, 'run.js');

if (isMain) {
  const args = process.argv.slice(2);
  const repoRoot = resolve(__dirname, '../..');

  // Parse CLI flags
  let submissionJson;
  let provenanceMode = null;
  const positionalArgs = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provenance' && args[i + 1]) {
      provenanceMode = args[++i];
    } else if (args[i] === '--file' && args[i + 1]) {
      const { readFileSync } = await import('node:fs');
      submissionJson = readFileSync(resolve(args[++i]), 'utf-8');
    } else if (args[i] === '--payload' && args[i + 1]) {
      submissionJson = args[++i];
    } else {
      positionalArgs.push(args[i]);
    }
  }

  if (!submissionJson) {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    submissionJson = Buffer.concat(chunks).toString('utf-8');
  }

  let submission;
  try {
    submission = JSON.parse(submissionJson);
    if (typeof submission === 'string') {
      submission = JSON.parse(submission);
    }
  } catch (err) {
    console.error(`ERROR: invalid JSON payload: ${err.message}`);
    process.exit(2);
  }

  // Resolve provenance adapter — explicit, never implicit
  let provenance;
  if (provenanceMode === 'stub') {
    // Structural anti-misuse: stub only allowed outside CI
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      console.error('ERROR: --provenance=stub is not allowed in CI/production. Use --provenance=github.');
      process.exit(2);
    }
    console.error('WARNING: Using stub provenance (test/dev only). Records will NOT have real provenance verification.');
    provenance = stubProvenance;
  } else if (provenanceMode === 'github') {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      console.error('ERROR: --provenance=github requires GITHUB_TOKEN or GH_TOKEN environment variable.');
      process.exit(2);
    }
    provenance = githubProvenance(token);
  } else if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
    // In CI without explicit flag: default to github provenance, fail if no token
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      console.error('ERROR: Running in CI without --provenance flag and no GITHUB_TOKEN. Cannot verify provenance.');
      process.exit(2);
    }
    provenance = githubProvenance(token);
  } else {
    console.error('ERROR: --provenance flag is required. Use --provenance=github (production) or --provenance=stub (test/dev only).');
    process.exit(2);
  }

  try {
    const result = await ingest(submission, { repoRoot, provenance });

    if (result.duplicate) {
      console.log(JSON.stringify({ status: 'duplicate', run_id: submission.run_id }));
      process.exit(0);
    }

    console.log(JSON.stringify({
      status: result.record.verification.status,
      run_id: result.record.run_id ?? null,
      verdict: result.record.overall_verdict?.verified ?? null,
      path: result.path,
      written: result.written,
      rejection_reasons: result.record.verification.rejection_reasons ?? []
    }));

    process.exit(result.record.verification.status === 'accepted' ? 0 : 1);
  } catch (err) {
    console.error(`ERROR: ingest failed: ${err.message}`);
    process.exit(2);
  }
}
