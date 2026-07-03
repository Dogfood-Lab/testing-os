/**
 * Structural regression pins for .github/workflows/self-dogfood.yml
 * (F-CI-SELF-DOGFOOD-001 — testing-os dogfoods itself).
 *
 * Why this file exists:
 *
 * self-dogfood.yml is the 5th workflow: after CI completes, testing-os packages
 * the REAL CI conclusion into a dogfood submission about ITSELF and dispatches
 * it to its own ingest pipeline. It is the consumer template (examples/dogfood.yml)
 * turned inward — the evidence platform proving its own gate through its own
 * pipeline. Four properties are load-bearing and nothing else pins them:
 *
 * 1. Preflight fails LOUD on a missing DOGFOOD_TOKEN. GitHub's recursive-workflow
 *    prevention means the default GITHUB_TOKEN's repository_dispatch does NOT
 *    start ingest.yml, so a dedicated PAT is mandatory — there is no shortcut.
 *    Without the loud preflight, the absence of the secret is a silent green run
 *    that records nothing. A revert dropping the preflight must go RED here.
 *
 * 2. The `ingest:` head-commit loop guard. ingest.yml commits records/+indexes/
 *    with an `ingest: ...` subject; that commit does NOT match ci.yml's paths
 *    filter (so no CI run fires and no loop exists today), but the belt-and-braces
 *    job-level guard skips a run triggered by an ingest commit anyway. A revert
 *    dropping the guard must go RED here.
 *
 * 3. The dispatch authenticates with DOGFOOD_TOKEN, NOT GITHUB_TOKEN. Using
 *    GITHUB_TOKEN would make the dispatch a silent no-op (recursive-workflow
 *    prevention) — the workflow would go green having triggered nothing. A revert
 *    swapping the auth back to GITHUB_TOKEN must go RED here.
 *
 * 4. The committed scenario definition (dogfood/scenarios/self-verify-gate.yaml)
 *    must pass the wave-12 author-time lint verb (`dogfood-verify lint --scenario`).
 *    Dogfooding the dogfood: the self-submission scenario is itself linted by the
 *    tool it exercises. A malformed scenario definition must go RED here.
 *
 * Why a real YAML parse (js-yaml) and not text-token scans like the sibling
 * workflow tests: self-dogfood.yml builds scenario-results.json inline and
 * derives the verdict from github.event.workflow_run.conclusion — a malformed
 * YAML (bad indentation on the new inline node step) would land green under a
 * pure-text scan but break the actual workflow. js-yaml is already a resolvable
 * workspace dependency (findings/verify/ingest/portfolio all declare it), so the
 * one-fixture-no-parser rationale the sibling tests cite does not apply here.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const workflowPath = resolve(repoRoot, '.github/workflows/self-dogfood.yml');

test('self-dogfood.yml exists', () => {
  assert.ok(existsSync(workflowPath), `expected workflow at ${workflowPath}`);
});

test('self-dogfood.yml parses as YAML', () => {
  const text = readFileSync(workflowPath, 'utf8');
  // A parse failure (the inline scenario-results node step is the most likely
  // culprit) throws here and fails the test — the whole point of parsing over a
  // text-token scan.
  const doc = yaml.load(text);
  assert.ok(doc && typeof doc === 'object', 'self-dogfood.yml must parse to a mapping');
  // Trigger: workflow_run on CI completion (primary) + workflow_dispatch (manual).
  // yaml parses the bare `on:` key to the boolean true, so read it defensively.
  const on = doc.on ?? doc[true];
  assert.ok(on && on.workflow_run, 'must trigger on workflow_run');
  assert.deepEqual(on.workflow_run.workflows, ['CI'], 'workflow_run must key off the "CI" workflow');
  assert.ok('workflow_dispatch' in on, 'must keep workflow_dispatch as a manual fallback');
});

test('F-CI-SELF-DOGFOOD-001: preflight fails LOUD on a missing DOGFOOD_TOKEN', () => {
  const text = readFileSync(workflowPath, 'utf8');
  // The preflight must reference the secret, emit a ::error annotation, and exit 1.
  assert.match(
    text,
    /DOGFOOD_TOKEN/,
    'self-dogfood.yml must reference the DOGFOOD_TOKEN secret',
  );
  assert.match(
    text,
    /if \[ -z "\$DOGFOOD_TOKEN" \]/,
    'preflight must test for an EMPTY DOGFOOD_TOKEN (`if [ -z "$DOGFOOD_TOKEN" ]`) — the #1 silent-failure mode',
  );
  assert.match(
    text,
    /::error[^\n]*DOGFOOD_TOKEN|DOGFOOD_TOKEN[^\n]*::error/i,
    'preflight must emit a ::error annotation naming DOGFOOD_TOKEN so the missing secret is loud, not silently green',
  );
  // The preflight run: block must exit 1 on the missing secret. Anchor the
  // block to the shell `fi` keyword on its own line (^\s*fi\s*$) so the match
  // does not stop at a "fi" substring inside the ::error message text.
  const preflight = /if \[ -z "\$DOGFOOD_TOKEN" \][\s\S]*?^\s*fi\s*$/m.exec(text);
  assert.ok(preflight, 'preflight guard block not found');
  assert.match(
    preflight[0],
    /exit 1/,
    'preflight must `exit 1` when DOGFOOD_TOKEN is unset',
  );
});

test('F-CI-SELF-DOGFOOD-001: the `ingest:` head-commit loop guard is present in the job if:', () => {
  const text = readFileSync(workflowPath, 'utf8');
  const doc = yaml.load(text);
  const jobs = doc.jobs ?? {};
  const jobIfs = Object.values(jobs)
    .map((j) => (j && typeof j.if === 'string' ? j.if : ''))
    .filter(Boolean);
  assert.ok(jobIfs.length > 0, 'the self-dogfood job must declare an if: guard');
  const guard = jobIfs.join('\n');
  assert.match(
    guard,
    /head_commit\.message/,
    'the loop guard must inspect github.event.workflow_run.head_commit.message',
  );
  assert.match(
    guard,
    /startsWith/,
    'the loop guard must use startsWith(...) to detect the ingest commit prefix',
  );
  assert.match(
    guard,
    /ingest:/,
    'the loop guard must skip runs triggered by an `ingest:` commit (matches ingest.yml commit subject)',
  );
  // Also gate to main and let workflow_dispatch through the guard.
  assert.match(
    guard,
    /head_branch == 'main'|head_branch == "main"/,
    'the guard must gate the workflow_run leg to the main branch',
  );
  assert.match(
    guard,
    /workflow_dispatch/,
    'the guard must let workflow_dispatch runs through (manual fallback)',
  );
});

test('F-CI-SELF-DOGFOOD-001: the dispatch authenticates with DOGFOOD_TOKEN, NOT GITHUB_TOKEN', () => {
  const text = readFileSync(workflowPath, 'utf8');
  // The dispatch step's auth env (GH_TOKEN / GITHUB_TOKEN) must be the PAT.
  assert.match(
    text,
    /GH_TOKEN:\s*\$\{\{\s*secrets\.DOGFOOD_TOKEN\s*\}\}/,
    'the dispatch step must set GH_TOKEN to secrets.DOGFOOD_TOKEN — GITHUB_TOKEN cannot trigger ingest.yml (recursive-workflow prevention)',
  );
  // Guard against a regression that reintroduces the default token for auth.
  // A repository_dispatch sent with GITHUB_TOKEN does not start ingest.yml.
  assert.doesNotMatch(
    text,
    /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/,
    'the dispatch must NOT authenticate with GITHUB_TOKEN — that makes the self-submission a silent no-op',
  );
  // The dispatch targets the SAME repo (self-submission).
  assert.match(
    text,
    /repos\/dogfood-lab\/testing-os\/dispatches/,
    'the dispatch must target repos/dogfood-lab/testing-os/dispatches (self-submission)',
  );
  assert.match(
    text,
    /event_type[^\n]*dogfood_submission/,
    'the dispatch event_type must be dogfood_submission (matches ingest.yml repository_dispatch type)',
  );
});

test('F-CI-SELF-DOGFOOD-001: the verdict is derived from the real CI conclusion, never hardcoded pass', () => {
  const text = readFileSync(workflowPath, 'utf8');
  // The workflow must read github.event.workflow_run.conclusion to build the
  // verdict — an evidence platform that only reports its wins is worthless.
  assert.match(
    text,
    /workflow_run\.conclusion/,
    'the workflow must derive the verdict from github.event.workflow_run.conclusion',
  );
  // The scenario file the receiver enforces required_steps against.
  assert.match(
    text,
    /self-verify-gate/,
    'the built scenario_result must carry scenario_id self-verify-gate (matches the committed definition)',
  );
});

test('F-CI-SELF-DOGFOOD-001: the self-verify-gate scenario passes the wave-12 author-time lint verb (dogfood the dogfood)', () => {
  const scenarioPath = 'dogfood/scenarios/self-verify-gate.yaml';
  assert.ok(
    existsSync(resolve(repoRoot, scenarioPath)),
    `expected committed scenario at ${scenarioPath}`,
  );
  const res = spawnSync(
    process.execPath,
    ['packages/verify/cli.js', 'lint', '--scenario', scenarioPath],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(
    res.status,
    0,
    `dogfood-verify lint must exit 0 on ${scenarioPath}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
  );
});
