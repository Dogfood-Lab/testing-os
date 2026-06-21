#!/usr/bin/env node
/**
 * dogfood-init — scaffold a testing-os dogfooding workflow into a repo.
 *
 * The adoption audit found two recurring failures. First, "no copy-pasteable
 * workflow exists" was the #1 barrier — a consumer who wanted to dogfood had to
 * hand-assemble the GitHub Actions workflow, the scenario-results shape, and the
 * repo policy from scattered docs. Second, the missing `DOGFOOD_TOKEN` secret was
 * the most common silent failure: the dispatch step authenticates with that token,
 * and without it a run could go green having recorded nothing.
 *
 * `dogfood-init` is the one command that fixes both. It writes the canonical
 * templates (bundled IN this package so `npx @dogfood-lab/report`-installed
 * consumers don't need testing-os's source tree) into the target repo, and prints
 * a loud, numbered next-steps block whose FINAL, most-prominent step is minting
 * and adding the DOGFOOD_TOKEN secret.
 *
 * Operator contract (mirrors cli.js's envelope so the two bins behave the same):
 *   - exit 0  → scaffolded successfully.
 *   - exit 2  → operator error: an existing workflow without --force
 *     (TARGET_EXISTS), an unknown/valueless flag (BAD_ARGS), or an unreadable
 *     template (TEMPLATE_UNREADABLE). Structured `ERROR [<CODE>]:` line on stderr.
 *   - stdout carries the human-facing scaffold report + next steps; diagnostics
 *     and errors go to stderr. The refuse path writes NOTHING to stdout.
 *
 * Safety: this command never runs a network call and never mutates git state. Slug
 * detection is read-only (`git remote get-url origin`, then the env fallback). If
 * no slug can be found, the placeholder is left intact and the output says so —
 * a best-effort substitution, never a guess that could mislabel a consumer's repo.
 *
 * This file is a plain writer (raw writeFileSync) because, like cli.js's --output,
 * it writes to a USER-chosen local path — a CLI convenience equivalent to a shell
 * redirect, not the shared evidence store that the atomic-write torn-write
 * contract protects. It belongs on the doc-drift atomic-write allowlist alongside
 * report/cli.js and report/build-submission.js.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const TEMPLATES_DIR = resolve(__dirname, 'templates');

const EXIT_OK = 0;
const EXIT_USAGE = 2;

// The receiver repo. This is NOT the consumer's slug and must never be
// substituted — the consumer dispatches TO this repo.
const RECEIVER_REPO = 'dogfood-lab/testing-os';

// The placeholder in scenario-results.example.json that stands in for the
// consumer's own repo slug. Slug detection replaces this; nothing else.
const SLUG_PLACEHOLDER = 'your-org/your-repo';

const USAGE = `dogfood-init — scaffold a testing-os dogfooding workflow into your repo.

Usage:
  dogfood-init [options]

Writes into the target directory (default: the current directory):
  .github/workflows/dogfood.yml       the dispatch workflow (the deliverable)
  scenario-results.example.json       the scenario_result[] contract, as a starter
  policy.example.yaml                 a starter repo policy to PR into ${RECEIVER_REPO}

Options:
  --dir <path>        Scaffold into <path> instead of the current directory.
  --slug <org/repo>   Use this slug for the run-url example instead of auto-detecting.
  --force             Overwrite an existing .github/workflows/dogfood.yml.
                      Without it, init REFUSES to clobber your workflow (exit 2).
  -h, --help          Show this help and exit 0.

Exit codes:
  0  scaffolded successfully.
  2  operator error: target workflow exists without --force, bad flag, or
     unreadable bundled template.
`;

/**
 * Emit a structured, machine-greppable error to stderr — the same
 * `ERROR [<CODE>]: <message>` + `Next:` envelope cli.js uses, so an operator who
 * has seen one bin's errors recognizes the other's.
 */
function emitError(code, message, hint) {
  process.stderr.write(`ERROR [${code}]: ${message}\n`);
  if (hint) process.stderr.write(`  Next: ${hint}\n`);
}

/**
 * Parse argv into a flag map. Throws a {code, message, hint} usage error for
 * unknown flags or value-flags missing their value so every argument problem maps
 * to exit 2 in one place. Mirrors cli.js's parser.
 */
function parseArgs(argv) {
  const booleans = new Set(['--force', '-h', '--help']);
  const known = new Set(['--dir', '--slug', '--force', '-h', '--help']);
  const flags = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) {
      const err = new Error(`unexpected positional argument "${arg}"`);
      err.code = 'BAD_ARGS';
      err.hint = 'dogfood-init takes only --flags; run --help for the list.';
      throw err;
    }
    if (!known.has(arg)) {
      const err = new Error(`unknown flag "${arg}"`);
      err.code = 'BAD_ARGS';
      err.hint = 'Run dogfood-init --help for the supported flags.';
      throw err;
    }
    if (booleans.has(arg)) {
      flags[arg] = true;
      continue;
    }
    const value = argv[i + 1];
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

function readTemplate(name) {
  const path = join(TEMPLATES_DIR, name);
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    const e = new Error(`bundled template ${name} could not be read: ${reason}`);
    e.code = 'TEMPLATE_UNREADABLE';
    e.hint = 'Reinstall @dogfood-lab/report — the templates/ dir ships with the package.';
    throw e;
  }
}

/**
 * Best-effort, READ-ONLY slug detection.
 *
 * Order: explicit --slug, then GITHUB_REPOSITORY (set inside Actions), then the
 * git `origin` remote URL parsed to owner/repo. Returns null when nothing
 * resolves — the caller leaves the placeholder and says so. Never throws: a repo
 * with no git, no remote, or git-not-on-PATH is a normal case, not an error.
 */
function detectSlug(explicit, targetDir) {
  if (explicit) return explicit;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;

  let remoteUrl;
  try {
    remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: targetDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  return parseSlugFromRemote(remoteUrl);
}

/**
 * Parse owner/repo from a git remote URL. Handles the two forms a consumer's
 * origin actually takes — `git@github.com:owner/repo.git` (SSH) and
 * `https://github.com/owner/repo(.git)` (HTTPS) — and returns null for anything
 * that doesn't yield exactly owner/repo, so a malformed remote leaves the
 * placeholder rather than writing garbage.
 */
function parseSlugFromRemote(url) {
  if (!url) return null;
  let path;
  const ssh = url.match(/^git@[^:]+:(.+)$/);
  if (ssh) {
    path = ssh[1];
  } else {
    const https = url.match(/^https?:\/\/[^/]+\/(.+)$/);
    if (https) path = https[1];
  }
  if (!path) return null;
  path = path.replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = path.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}/${parts[1]}`;
}

function writeFileMakingDirs(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

/**
 * The loud, numbered next-steps block. Built as a string (not written inline) so
 * the ENTIRE block is one stdout write and the DOGFOOD_TOKEN step is provably last.
 */
function nextSteps({ workflowPath, slug, slugDetected }) {
  const slugLine = slugDetected
    ? `Detected repo slug "${slug}" and substituted it into the run-url example in scenario-results.example.json.`
    : `Could not detect a repo slug — left the "${SLUG_PLACEHOLDER}" placeholder in scenario-results.example.json. Replace it with your org/repo, or re-run with --slug <org/repo>.`;

  return [
    '',
    'Scaffolded:',
    `  ${workflowPath}`,
    '  scenario-results.example.json',
    '  policy.example.yaml',
    '',
    slugLine,
    '',
    '════════════════════════════════════════════════════════════════════',
    ' NEXT STEPS',
    '════════════════════════════════════════════════════════════════════',
    '',
    ' 1. Wire the workflow trigger: in .github/workflows/dogfood.yml, set the',
    '    workflow_run "workflows:" list to YOUR test workflow\'s name (it ships',
    '    pointing at "CI"), or fold the steps into your existing test job.',
    '',
    ' 2. Produce scenario-results.json from your test output. The bundled',
    '    scenario-results.example.json shows the contract: an array of',
    '    scenario_result objects. Replace the cp-the-example step accordingly.',
    '',
    ` 3. Add your repo policy UPSTREAM. Your policy does NOT live in your repo —`,
    `    it lives in ${RECEIVER_REPO} at`,
    `    policies/repos/<org>/<repo>.yaml. Open a PR there starting from the`,
    `    local policy.example.yaml this command just wrote.`,
    '',
    ' ─────────────────────────────────────────────────────────────────── ',
    ' 4. *** THE STEP EVERYONE FORGETS — DO NOT SKIP *** ',
    ' ─────────────────────────────────────────────────────────────────── ',
    '    Set the DOGFOOD_TOKEN secret, or the dispatch silently records nothing:',
    '',
    `      a. Mint a fine-grained PAT with  contents: write  on  ${RECEIVER_REPO}`,
    '      b. In THIS repo: Settings → Secrets and variables → Actions →',
    '         New repository secret → name it  DOGFOOD_TOKEN',
    '',
    '    The workflow preflight FAILS LOUD if DOGFOOD_TOKEN is missing, so a',
    '    misconfigured run errors instead of going green with nothing recorded.',
    '════════════════════════════════════════════════════════════════════',
    '',
  ].join('\n');
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

  const targetDir = resolve(flags['--dir'] || process.cwd());
  const workflowPath = join(targetDir, '.github', 'workflows', 'dogfood.yml');
  const force = Boolean(flags['--force']);

  // Never clobber a consumer's workflow silently — this is their CI surface.
  if (existsSync(workflowPath) && !force) {
    emitError(
      'TARGET_EXISTS',
      `${workflowPath} already exists.`,
      'Re-run with --force to overwrite it, or scaffold into a clean --dir. Your existing workflow was left untouched.'
    );
    return EXIT_USAGE;
  }

  let workflowTemplate, scenarioTemplate, policyTemplate;
  try {
    workflowTemplate = readTemplate('dogfood.yml');
    scenarioTemplate = readTemplate('scenario-results.example.json');
    policyTemplate = readTemplate('policy.example.yaml');
  } catch (err) {
    emitError(err.code || 'TEMPLATE_UNREADABLE', err.message, err.hint);
    return EXIT_USAGE;
  }

  const slug = detectSlug(flags['--slug'], targetDir);
  const slugDetected = Boolean(slug);
  // Only the scenario-results run-url example carries the consumer-slug
  // placeholder; the workflow's dogfood-lab/testing-os references are the
  // RECEIVER and must pass through untouched.
  const scenarioOut = slug
    ? scenarioTemplate.split(SLUG_PLACEHOLDER).join(slug)
    : scenarioTemplate;

  writeFileMakingDirs(workflowPath, workflowTemplate);
  writeFileMakingDirs(join(targetDir, 'scenario-results.example.json'), scenarioOut);
  writeFileMakingDirs(join(targetDir, 'policy.example.yaml'), policyTemplate);

  process.stdout.write(
    nextSteps({ workflowPath, slug: slug || SLUG_PLACEHOLDER, slugDetected })
  );
  return EXIT_OK;
}

// CLI entrypoint — only runs when invoked directly, not when imported by tests.
const isMain = process.argv[1]?.endsWith('init.js');
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
