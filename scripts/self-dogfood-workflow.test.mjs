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
 * pipeline. Five properties are load-bearing and nothing else pins them:
 *
 * 1. The job carries `contents: write`. POST /repos/{o}/{r}/dispatches requires
 *    it; a permissions narrowing (back to contents: read) turns every dispatch
 *    into a 403. History: two revisions required a DOGFOOD_TOKEN PAT here on
 *    the mistaken belief that recursion prevention blocks a GITHUB_TOKEN
 *    repository_dispatch — the documented exception ("with the exception of
 *    workflow_dispatch and repository_dispatch") makes same-repo dispatch the
 *    officially supported path, and two rounds of fine-grained-PAT 403s
 *    retired the PAT design. A revert narrowing permissions must go RED here.
 *
 * 2. The `ingest:` head-commit loop guard. ingest.yml commits records/+indexes/
 *    with an `ingest: ...` subject; that commit does NOT match ci.yml's paths
 *    filter (so no CI run fires and no loop exists today), but the belt-and-braces
 *    job-level guard skips a run triggered by an ingest commit anyway. A revert
 *    dropping the guard must go RED here.
 *
 * 3. The dispatch authenticates with the workflow's own token (github.token)
 *    and NO DOGFOOD_TOKEN reference remains anywhere in the file — the
 *    long-lived-secret design is retired for the self case (consumers keep
 *    their PAT: cross-repo dispatch has no workflow-local substitute). A
 *    revert reintroducing the secret must go RED here.
 *
 * 4. The committed scenario definition (dogfood/scenarios/self-verify-gate.yaml)
 *    must pass the wave-12 author-time lint verb (`dogfood-verify lint --scenario`).
 *    Dogfooding the dogfood: the self-submission scenario is itself linted by the
 *    tool it exercises. A malformed scenario definition must go RED here.
 *
 * 5. The submission handoff is self-contained and path-consistent. The FIRST
 *    live run of this workflow never completed a self-submission because the
 *    build step shelled out to the PUBLISHED @dogfood-lab/report from a
 *    different cwd and silently produced no submission.json — the dispatch's
 *    `--slurpfile s submission.json` then errored "No such file or directory".
 *    The fix builds with the LOCAL CLI (`node packages/report/cli.js`) against
 *    THIS commit's code, writes and reads the same submission.json, and stamps
 *    the commit CI actually gated (workflow_run.head_sha, not $GITHUB_SHA). A
 *    revert to the npm-exec-the-published-package path, a write/read path
 *    mismatch, or a drop back to $GITHUB_SHA must go RED here.
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

test('F-CI-SELF-DOGFOOD-001: job carries contents: write and no DOGFOOD_TOKEN remains', () => {
  const text = readFileSync(workflowPath, 'utf8');
  // POST /dispatches requires contents: write on the workflow token. A
  // narrowing back to `contents: read` 403s every dispatch.
  assert.match(
    text,
    /permissions:\s*\n\s*contents:\s*write/,
    'self-dogfood.yml must grant contents: write — the dispatches API requires it on the workflow token',
  );
  // The retired PAT design must not creep back in.
  assert.doesNotMatch(
    text,
    /DOGFOOD_TOKEN/,
    'self-dogfood.yml must not reference DOGFOOD_TOKEN — the self case uses the workflow token (documented recursion-prevention exception); only CROSS-repo consumers need a PAT',
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

test('F-CI-SELF-DOGFOOD-001: the dispatch authenticates with the workflow token', () => {
  const text = readFileSync(workflowPath, 'utf8');
  assert.match(
    text,
    /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/,
    'the Dispatch step must authenticate with github.token — same-repo repository_dispatch is the documented recursion-prevention exception',
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

test('F-CI-SELF-DOGFOOD-001: the submission is built by the LOCAL CLI and dispatched from the same path', () => {
  const text = readFileSync(workflowPath, 'utf8');
  // Regression guard for the observed handoff bug (property 5). The build step
  // must invoke the LOCAL CLI (packages/report/cli.js) and write to
  // submission.json. The prior npm-exec-from-$RUNNER_TEMP path silently
  // produced nothing.
  assert.match(
    text,
    /node packages\/report\/cli\.js[\s\S]*?--output\s+submission\.json/,
    'the build step must run the local report CLI (node packages/report/cli.js) and write --output submission.json',
  );
  // The dispatch step must slurp the SAME file the build step wrote — a
  // write/read path mismatch is the exact defect that broke the first live run.
  assert.match(
    text,
    /--slurpfile\s+s\s+submission\.json/,
    'the dispatch step must read the same submission.json the build step wrote',
  );
  // Self-contained: no npm-exec of the published package anywhere. Self-
  // dogfooding must exercise THIS commit's builder, not a registry artifact that
  // can lag the commit CI just gated (and that no-ops from the repo root).
  assert.doesNotMatch(
    text,
    /\bnpx\b/,
    'self-dogfood must build + confirm with the local CLI, never npm-exec (npx) the published package',
  );
});

test('F-CI-SELF-DOGFOOD-001: the workflow installs + builds so the local --precheck has the schemas dist', () => {
  const text = readFileSync(workflowPath, 'utf8');
  // precheckSubmission imports validatePayload from @dogfood-lab/schemas, whose
  // package `main` is dist/index.js — so the local --precheck path needs the TS
  // build. `npm ci` provides the @dogfood-lab/* workspace symlinks the local CLI
  // resolves through.
  assert.match(
    text,
    /npm ci/,
    'must `npm ci` so the local report CLI resolves its @dogfood-lab/* workspace deps',
  );
  assert.match(
    text,
    /npm run build/,
    'must `npm run build` so @dogfood-lab/schemas dist/ exists for the local --precheck',
  );
});

test('F-CI-SELF-DOGFOOD-001: the submission is stamped with the commit CI actually gated (workflow_run.head_sha)', () => {
  const text = readFileSync(workflowPath, 'utf8');
  // Under a workflow_run event $GITHUB_SHA is the default-branch head, NOT the
  // tested commit; ref.commit_sha must be the commit CI gated so the evidence is
  // about the right revision.
  assert.match(
    text,
    /workflow_run\.head_sha/,
    'the build step must pin --commit to github.event.workflow_run.head_sha (the tested commit), not rely on $GITHUB_SHA',
  );
});
