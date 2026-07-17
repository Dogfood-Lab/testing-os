/**
 * Structural regression pins for .github/workflows/ci.yml — token scope
 * (F-W1-CI-002) and the Node version test matrix (F-W1-CI-010).
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
 * Why text/structure assertions and not a YAML parse: same rationale as the
 * sibling stageA-check-ci-honesty-paths.test.mjs / stageC-check-release-
 * resilience.test.mjs — parsing YAML in a regression test pulls in a
 * dependency just for one fixture.
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
