#!/usr/bin/env node
/**
 * dogfood-report — CLI wrapper around buildSubmission + precheckSubmission.
 *
 * The `build-submission.js` module has long carried an `import.meta`-gated CLI
 * entrypoint, but `@dogfood-lab/report` shipped with `main` and no `bin`, so a
 * consumer who `npm install`ed the package could call the builder as a module
 * yet had no installed command to run. This file is that command: it reads run
 * metadata from flags (and/or `--scenario-file`, a JSON file of scenario
 * results), builds the canonical submission, optionally prechecks it against
 * the central `@dogfood-lab/schemas` contract, and prints the submission JSON
 * to stdout so it pipes cleanly into `jq`, `ingest`, or a file.
 *
 * Contract that the rest of the toolchain relies on:
 *   - stdout is PURE submission JSON on success (exit 0) — nothing else goes
 *     there, so `dogfood-report ... | jq .run_id` works.
 *   - diagnostics, the `--output` write confirmation, and errors go to stderr.
 *   - bad arguments (missing required flag, unparseable file, unknown flag)
 *     exit 2 with a structured `ERROR [<CODE>]:` line, matching the repo-wide
 *     error envelope documented in site/.../handbook/error-codes.md.
 *   - a built submission that fails precheck exits 1 (the input was
 *     well-formed enough to build but does not satisfy the verifier contract) —
 *     a different failure class than "you called me wrong" (exit 2).
 *
 * This file deliberately does NOT change build-submission.js's public API; it
 * only composes the two exported functions.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildSubmission, precheckSubmission } from '@dogfood-lab/report';

const EXIT_OK = 0;
const EXIT_PRECHECK_FAILED = 1;
const EXIT_USAGE = 2;

const USAGE = `dogfood-report — build a testing-os submission JSON from run metadata.

Usage:
  dogfood-report --scenario-file <path> [options]   > submission.json

Required:
  --scenario-file <path>   JSON file: an array of scenario_results (or a single
                           scenario object, which is wrapped in an array).
  --repo <org/repo>        Full repository slug. (env: GITHUB_REPOSITORY)
  --commit <sha>           40-char commit SHA.   (env: GITHUB_SHA)

Run metadata (fall back to GitHub Actions env vars when omitted):
  --branch <name>          (env: GITHUB_REF_NAME)
  --version <tag>          Release version tag.
  --workflow <file>        (env: GITHUB_WORKFLOW)
  --provider-run-id <id>   (env: GITHUB_RUN_ID)
  --run-url <url>          (env: derived from GITHUB_REPOSITORY + GITHUB_RUN_ID)
  --attempt <n>            (env: GITHUB_RUN_ATTEMPT, default 1)
  --actor <name>           (env: GITHUB_ACTOR)
  --started-at <iso>       ISO datetime (default: now)
  --finished-at <iso>      ISO datetime (default: now)
  --verdict <string>       Proposed overall verdict (default: pass)
  --notes <string>

Behavior:
  --output <path>          Write submission to a file instead of stdout.
                           Use '-' (the default) for stdout.
  --precheck               Validate the built submission before emitting
                           (default). Use --no-precheck to skip.
  --no-precheck            Skip local precheck (emit unconditionally).
  -h, --help               Show this help and exit 0.

Exit codes:
  0  submission built (and prechecked, if enabled) and emitted.
  1  submission built but failed precheck.
  2  usage error (missing/invalid flag, unreadable --scenario-file).
`;

/**
 * Emit a structured, machine-greppable error to stderr.
 *
 * Mirrors the repo-wide `ERROR [<CODE>]: <message>` envelope (see
 * site/.../handbook/error-codes.md and packages/dogfood-swarm/lib/error-render.js).
 * The optional `hint` renders as a `Next:` line so an operator gets the same
 * "what do I do now" affordance the swarm CLI gives.
 */
function emitError(code, message, hint) {
  process.stderr.write(`ERROR [${code}]: ${message}\n`);
  if (hint) process.stderr.write(`  Next: ${hint}\n`);
}

/**
 * Parse argv into a flag map. Throws a {code, message, hint} usage error for
 * unknown flags or value-flags missing their value, so the caller can map every
 * argument problem to exit 2 in one place rather than scattering process.exit.
 */
function parseArgs(argv) {
  // Boolean flags take no value; everything else consumes the next token.
  const booleans = new Set(['--precheck', '--no-precheck', '-h', '--help']);
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      const err = new Error(`unexpected positional argument "${arg}"`);
      err.code = 'BAD_ARGS';
      err.hint = 'dogfood-report takes only --flags; run --help for the list.';
      throw err;
    }
    if (booleans.has(arg)) {
      flags[arg] = true;
      continue;
    }
    const value = argv[i + 1];
    // A value flag at the end of argv, or immediately followed by another flag,
    // has no value — that is an operator typo, not an empty-string intent.
    if (value === undefined || value.startsWith('-')) {
      const err = new Error(`flag "${arg}" expects a value`);
      err.code = 'BAD_ARGS';
      err.hint = `Pass a value: ${arg} <value>. Run --help for usage.`;
      throw err;
    }
    flags[arg] = value;
    i++;
  }
  return flags;
}

function readScenarioResults(scenarioFile) {
  const scenarioPath = resolve(scenarioFile);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(scenarioPath, 'utf-8'));
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    const e = new Error(`could not read/parse --scenario-file ${scenarioPath}: ${reason}`);
    e.code = 'SCENARIO_FILE_UNREADABLE';
    e.hint = 'Point --scenario-file at a readable JSON file containing the scenario_results array.';
    throw e;
  }
  // A single scenario object is a common shape; wrap it so buildSubmission
  // always receives the array its contract expects. Mirrors build-submission.js.
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function run(argv) {
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    emitError(err.code || 'BAD_ARGS', err.message, err.hint);
    return EXIT_USAGE;
  }

  if (flags['-h'] || flags['--help']) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }

  const scenarioFile = flags['--scenario-file'];
  if (!scenarioFile) {
    emitError(
      'MISSING_REQUIRED_FLAG',
      '--scenario-file is required.',
      'Provide a JSON file of scenario_results: dogfood-report --scenario-file <path>. Run --help for usage.'
    );
    return EXIT_USAGE;
  }

  let scenarioResults;
  try {
    scenarioResults = readScenarioResults(scenarioFile);
  } catch (err) {
    emitError(err.code || 'SCENARIO_FILE_UNREADABLE', err.message, err.hint);
    return EXIT_USAGE;
  }

  const repo = flags['--repo'] || process.env.GITHUB_REPOSITORY;
  const commitSha = flags['--commit'] || process.env.GITHUB_SHA;
  // buildSubmission throws on missing required params, but it raises an untyped
  // Error. Catch its required-param failures here and re-surface them as the
  // structured usage envelope so the operator sees WHICH flag and exits 2.
  const missing = [];
  if (!repo) missing.push('--repo (or GITHUB_REPOSITORY)');
  if (!commitSha) missing.push('--commit (or GITHUB_SHA)');
  if (missing.length > 0) {
    emitError(
      'MISSING_REQUIRED_FLAG',
      `missing required ${missing.length === 1 ? 'flag' : 'flags'}: ${missing.join(', ')}.`,
      'Supply the listed flag(s) or run inside GitHub Actions where the env vars are set. Run --help for usage.'
    );
    return EXIT_USAGE;
  }

  const runId = process.env.GITHUB_RUN_ID;
  const repoSlug = repo;

  let submission;
  try {
    submission = buildSubmission({
      repo,
      commitSha,
      branch: flags['--branch'] || process.env.GITHUB_REF_NAME,
      version: flags['--version'],
      workflow: flags['--workflow'] || process.env.GITHUB_WORKFLOW,
      providerRunId: flags['--provider-run-id'] || runId,
      runUrl:
        flags['--run-url'] ||
        (repoSlug && runId
          ? `https://github.com/${repoSlug}/actions/runs/${runId}`
          : undefined),
      attempt: Number(flags['--attempt'] || process.env.GITHUB_RUN_ATTEMPT || 1),
      actor: flags['--actor'] || process.env.GITHUB_ACTOR,
      startedAt: flags['--started-at'] || new Date().toISOString(),
      finishedAt: flags['--finished-at'] || new Date().toISOString(),
      scenarioResults,
      overallVerdict: flags['--verdict'] || 'pass',
      notes: flags['--notes']
    });
  } catch (err) {
    // Any remaining buildSubmission validation failure (e.g. a malformed
    // scenarioResults shape) is an input problem → exit 2.
    emitError('BUILD_FAILED', err && err.message ? err.message : String(err),
      'Check the run metadata flags and the --scenario-file contents. Run --help for usage.');
    return EXIT_USAGE;
  }

  const doPrecheck = !flags['--no-precheck'];
  if (doPrecheck) {
    const result = precheckSubmission(submission);
    if (!result.valid) {
      emitError('PRECHECK_FAILED', 'built submission did not satisfy the verifier contract.',
        'Fix the listed contract violations, or pass --no-precheck to emit anyway.');
      for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
      return EXIT_PRECHECK_FAILED;
    }
  }

  const json = JSON.stringify(submission, null, 2) + '\n';
  const output = flags['--output'] || '-';
  if (output === '-') {
    process.stdout.write(json);
  } else {
    writeFileSync(resolve(output), json, 'utf-8');
    // Confirmation goes to stderr so stdout stays pure even when writing a file.
    process.stderr.write(`Wrote submission to ${resolve(output)}\n`);
  }
  return EXIT_OK;
}

// CLI entrypoint — only runs when invoked directly, not when imported by tests.
const isMain = process.argv[1]?.endsWith('cli.js');
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
