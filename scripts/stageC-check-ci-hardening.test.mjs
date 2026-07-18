/**
 * Structural regression pins for .github/workflows/ci.yml — token scope
 * (F-W1-CI-002), the Node version test matrix (F-W1-CI-010), and the
 * windows-latest win32 proof-of-life job (F-92a05b18).
 *
 * F-W1-CI-002 — ci.yml runs untrusted PR code via `npm ci` + `npm test`, so
 * the GITHUB_TOKEN scope is part of the attack surface. The workflow
 * declares `permissions: contents: read` explicitly at the workflow level
 * rather than inheriting whatever repo-default scope is configured —
 * `contents: read` is the floor `actions/checkout` needs, nothing more (no
 * job in this workflow writes back to the repo). A future edit widening this
 * (or dropping it back to an unstated, potentially-broader repo default)
 * would silently expand what a compromised transitive dependency executing
 * during `npm ci`/`npm test` could do with the token.
 *
 * F-W1-CI-010 — the Node test matrix is `[22, 24]`: Node 20 hit EOL on
 * 2026-04-30 and was dropped; 22 is current Maintenance LTS, 24 is Active
 * LTS. Bumping the matrix surfaces Node 24 native-test-runner / permission-
 * model / fetch behavior drift before downstream consumers hit it. A
 * regression back to including 20 would test an unsupported runtime;
 * `fail-fast: false` stays so both legs always complete and a version-
 * specific failure is distinguishable from a real bug (rather than Node 24
 * cancelling mid-flight when Node 22 fails first).
 *
 * F-92a05b18 — scripts/check-step-fixtures.test.mjs's win32-only resolveSh()
 * branch (Git-for-Windows bundled sh.exe discovery) had zero CI proof-of-life:
 * build-and-test above is ubuntu-latest only, and on Linux the branch is
 * never reached (the preceding plain spawnSync('sh', ...) probe always
 * succeeds first). windows-step-fixtures-proof-of-life is a SEPARATE job,
 * gated `if: github.event_name == 'workflow_dispatch'` so it costs nothing on
 * push/PR (github-actions.md: avoid a standing windows-latest leg — roughly
 * 2x the per-minute cost of ubuntu-latest), running ONLY
 * scripts/check-step-fixtures.test.mjs, not the full suite. A regression
 * either removing the job, widening it to push/PR, or broadening it past the
 * one named test file would defeat the narrow, deliberately-bounded cost
 * tradeoff this finding's recommendation asked for.
 *
 * Why text/structure assertions and not a YAML parse: same rationale as the
 * sibling stageA-check-ci-honesty-paths.test.mjs / stageC-check-release-
 * resilience.test.mjs — parsing YAML in a regression test pulls in a
 * dependency just for one fixture. (self-dogfood-workflow.test.mjs uses a
 * real js-yaml parse instead, for a file with indentation-sensitive inline
 * steps where a text scan cannot tell well-formed from broken; ci.yml has no
 * such step, so the lighter text-token convention applies here too.)
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const ciPath = resolve(repoRoot, '.github/workflows/ci.yml');

test('ci.yml exists', () => {
  assert.ok(existsSync(ciPath), `expected workflow at ${ciPath}`);
});

test('F-W1-CI-002: workflow-level permissions declares contents: read explicitly, not inherited', () => {
  const text = readFileSync(ciPath, 'utf8');
  // Scope to the workflow-level block (before the top-level `jobs:` key) so
  // a future job-level permissions override elsewhere in the file cannot
  // satisfy this assertion by accident.
  const jobsIdx = text.indexOf('\njobs:');
  assert.ok(jobsIdx > 0, 'expected a top-level `jobs:` key in ci.yml');
  const workflowLevel = text.slice(0, jobsIdx);
  assert.match(
    workflowLevel,
    /^permissions:\s*\n\s*contents:\s*read\s*$/m,
    'ci.yml must declare `permissions:\\n  contents: read` at the workflow level (F-W1-CI-002) — ci.yml runs untrusted PR code via npm ci + npm test, so the GITHUB_TOKEN scope is part of the attack surface',
  );
});

test('F-W1-CI-010: the Node test matrix is exactly [22, 24] — Node 20 (EOL 2026-04-30) is excluded, fail-fast stays false', () => {
  const text = readFileSync(ciPath, 'utf8');
  const jobsIdx = text.indexOf('\njobs:');
  const jobsBlock = text.slice(jobsIdx);
  assert.match(
    jobsBlock,
    /node-version:\s*\[22,\s*24\]/,
    'ci.yml matrix must be exactly node-version: [22, 24] (F-W1-CI-010)',
  );
  assert.doesNotMatch(
    jobsBlock,
    /node-version:\s*\[[^\]]*\b20\b[^\]]*\]/,
    'the Node matrix must not include 20 — it hit EOL on 2026-04-30 (F-W1-CI-010)',
  );
  assert.match(
    jobsBlock,
    /fail-fast:\s*false/,
    'the matrix strategy must keep fail-fast: false so both Node legs always complete and a version-specific failure is distinguishable from a real cross-version bug',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-92a05b18 — windows-step-fixtures-proof-of-life. Scoped to the new job's
// own block via the same jobsIdx-slicing technique the tests above use, so an
// assertion here cannot accidentally match text inside build-and-test.
// ─────────────────────────────────────────────────────────────────────────────

function windowsJobBlock(text) {
  const idx = text.indexOf('\n  windows-step-fixtures-proof-of-life:');
  assert.ok(idx > 0, 'expected a windows-step-fixtures-proof-of-life job in ci.yml');
  return text.slice(idx);
}

/** @pins F-92a05b18 */
test('F-92a05b18: windows-step-fixtures-proof-of-life job exists, runs on windows-latest, and is gated to workflow_dispatch only — zero standing cost on push or pull_request', () => {
  const text = readFileSync(ciPath, 'utf8');
  const jobBlock = windowsJobBlock(text);
  assert.match(
    jobBlock,
    /runs-on:\s*windows-latest/,
    'the whole point of this job is exercising the win32-only resolveSh() branch — it must run on windows-latest',
  );
  assert.match(
    jobBlock,
    /if:\s*github\.event_name\s*==\s*'workflow_dispatch'/,
    "the job must be gated to workflow_dispatch only — a push/PR trigger would add a standing ~2x-cost windows-latest leg this finding's recommendation explicitly rejected",
  );
});

test('F-92a05b18: the proof-of-life job runs ONLY scripts/check-step-fixtures.test.mjs — checkout, setup-node, npm ci, and exactly that one test command, never the full suite or a build step', () => {
  const text = readFileSync(ciPath, 'utf8');
  const jobBlock = windowsJobBlock(text);
  assert.match(jobBlock, /uses:\s*actions\/checkout@/, 'must check out the repo');
  assert.match(jobBlock, /uses:\s*actions\/setup-node@/, 'must set up node');
  assert.match(jobBlock, /run:\s*npm ci\s*$/m, 'must install dependencies via npm ci');
  assert.match(
    jobBlock,
    /run:\s*node --test scripts\/check-step-fixtures\.test\.mjs\s*$/m,
    'must run exactly the one test file this finding names',
  );
  // Narrow surface, not the full suite/matrix — the dispatch's own
  // constraint. packages/portfolio (the test file's one workspace import) is
  // plain JS, so no build step is needed to exercise it.
  assert.doesNotMatch(jobBlock, /run:\s*npm test\s*$/m, 'must not run the full suite — narrow proof-of-life only');
  assert.doesNotMatch(jobBlock, /run:\s*npm run build/, 'the target test file needs no build step (packages/portfolio is plain JS, not compiled)');
  assert.doesNotMatch(jobBlock, /run:\s*npm run verify/, 'must not run the full verify gate');
  assert.doesNotMatch(jobBlock, /\bstrategy\s*:/, 'a single-purpose proof-of-life job must not carry a matrix — one Node version is enough to exercise the win32 branch');
});

test('F-92a05b18: the proof-of-life job pins the exact same actions/checkout and actions/setup-node SHAs as build-and-test — one pin source, not a second one that can silently drift out of sync', () => {
  const text = readFileSync(ciPath, 'utf8');
  const buildJobIdx = text.indexOf('\n  build-and-test:');
  const windowsJobIdx = text.indexOf('\n  windows-step-fixtures-proof-of-life:');
  assert.ok(buildJobIdx > 0 && windowsJobIdx > buildJobIdx, 'expected build-and-test before windows-step-fixtures-proof-of-life');
  const buildBlock = text.slice(buildJobIdx, windowsJobIdx);
  const windowsBlock = text.slice(windowsJobIdx);

  const extractSha = (block, action) => {
    const m = block.match(new RegExp(`uses:\\s*${action.replace('/', '\\/')}@([0-9a-f]{40})`));
    return m ? m[1] : null;
  };
  const checkoutShaBuild = extractSha(buildBlock, 'actions/checkout');
  const checkoutShaWindows = extractSha(windowsBlock, 'actions/checkout');
  const setupNodeShaBuild = extractSha(buildBlock, 'actions/setup-node');
  const setupNodeShaWindows = extractSha(windowsBlock, 'actions/setup-node');

  assert.ok(checkoutShaBuild, 'expected a 40-char SHA-pinned actions/checkout in build-and-test');
  assert.ok(setupNodeShaBuild, 'expected a 40-char SHA-pinned actions/setup-node in build-and-test');
  assert.equal(checkoutShaWindows, checkoutShaBuild, 'the proof-of-life job must pin the SAME actions/checkout SHA as build-and-test, not an independent (and potentially unpinned or stale) one');
  assert.equal(setupNodeShaWindows, setupNodeShaBuild, 'the proof-of-life job must pin the SAME actions/setup-node SHA as build-and-test');
});

test('F-92a05b18: exactly two top-level jobs exist — build-and-test is untouched (still the only OTHER job) and no third job crept in', () => {
  const text = readFileSync(ciPath, 'utf8');
  const jobsIdx = text.indexOf('\njobs:');
  const jobsBlock = text.slice(jobsIdx);
  const jobNames = [...jobsBlock.matchAll(/^  ([a-zA-Z_][a-zA-Z0-9_-]*):\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(
    jobNames,
    ['build-and-test', 'windows-step-fixtures-proof-of-life'],
    'exactly these two top-level jobs, in this order — a new job must not silently multiply beyond the one this finding asked for, and build-and-test must not be renamed or removed',
  );
});
