/**
 * stageC-b001-pattern-skipped-signal.test.js — close the ONE derive-family
 * gap left by D2B-001: pattern derivation.
 *
 * AT HEAD: `deriveRecommendations` and `deriveDoctrine` both surface a
 * `skipped: [{ path, error }]` field (D2B-001), but `derivePatterns` does NOT.
 * It loads findings via `loadFindings` (reader.js), which returns a torn /
 * unparseable finding YAML as `{ valid: false, errors: [{ message }] }`, then
 * filters `accepted = allFindings.filter(f => f.valid && ...)`. A torn finding
 * that on disk WAS an accepted finding is silently dropped from clustering —
 * `derivePatterns` returns only `{ patterns, stats }` with no `skipped` field,
 * and the CLI `patterns derive` handler prints nothing about it. That can
 * change pattern_strength or drop a cluster below the 2-finding threshold with
 * zero operator signal.
 *
 * AFTER FIX: `derivePatterns(rootDir)` returns a `skipped: [{ path, error }]`
 * field alongside `patterns` / `stats`, built from the `valid === false`
 * entries of the loadFindings result (error at `f.errors[0].message`). Mirrors
 * the recommendation/doctrine shape exactly. Exit 0 is preserved (partial
 * derivation completes honestly).
 *
 * This test proves the guard FIRES (a torn accepted finding appears in
 * `skipped`) AND that a healthy pair of accepted findings still clusters into a
 * pattern (the guard does not suppress good output), AND back-compat
 * (torn-free dir → empty `skipped`).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { derivePatterns } from './pattern-derivation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_stageC_b001_pattern_skip__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) {
    try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* drop */ }
  }
}

/**
 * Write a schema-valid accepted finding into findings/<org>/<repo>/<file>.
 * Two findings that share issue_kind + root_cause_kind but live in DIFFERENT
 * repos with DIFFERENT source_record_ids cluster into one pattern (clearing
 * the isFalseRecurrence guard).
 */
function makeAcceptedFinding({ id, repo, recordId }) {
  return {
    schema_version: '1.0.0',
    finding_id: id,
    title: 'CLI entrypoint flags must match the real argparse contract',
    status: 'accepted',
    repo,
    product_surface: 'cli',
    execution_mode: 'bot',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'docs_code_drift',
    remediation_kind: 'scenario_change',
    transfer_scope: 'surface_archetype',
    summary:
      'A dogfood scenario assumed CLI flags that did not match the real argparse contract, producing exit code 2 which the verifier recorded as an honest fail.',
    source_record_ids: [recordId],
    scenario_ids: ['cli-init-and-audit'],
    evidence: [
      { evidence_kind: 'record', record_id: recordId, note: 'Corrected record after entrypoint fix.' },
    ],
    created_at: '2026-03-29T12:00:00Z',
    updated_at: '2026-03-29T12:00:00Z',
  };
}

function writeFinding(rootDir, org, repo, fileName, data) {
  const dir = resolve(rootDir, 'findings', org, repo);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, fileName), yaml.dump(data), 'utf-8');
}

function writeTornFinding(rootDir, org, repo, fileName) {
  const dir = resolve(rootDir, 'findings', org, repo);
  mkdirSync(dir, { recursive: true });
  // Unparseable YAML — js-yaml throws, parseFinding returns { error }, reader
  // marks it { valid: false }.
  writeFileSync(resolve(dir, fileName), 'this: is: not valid yaml: [', 'utf-8');
}

describe('Stage C / B001: derivePatterns surfaces skipped torn findings', () => {
  before(setup);
  after(teardown);

  it('reports a torn accepted finding in skipped[] while the clean pair still forms a pattern', () => {
    const root = resolve(TEST_ROOT, 'patterns-with-torn');

    // Two clean accepted findings, same issue/root-cause dims, different repos
    // + record ids → they cluster into a real pattern.
    writeFinding(root, 'org-a', 'repo-1', 'a.yaml', makeAcceptedFinding({
      id: 'dfind-a-entrypoint-truth', repo: 'org-a/repo-1', recordId: 'run-a-1',
    }));
    writeFinding(root, 'org-a', 'repo-2', 'b.yaml', makeAcceptedFinding({
      id: 'dfind-b-entrypoint-truth', repo: 'org-a/repo-2', recordId: 'run-b-1',
    }));

    // One torn finding that WAS (on disk) meant to be an accepted finding.
    writeTornFinding(root, 'org-a', 'repo-3', 'torn.yaml');

    const result = derivePatterns(root);

    // Healthy input still passes: the clean pair forms a pattern.
    assert.ok(Array.isArray(result.patterns), 'patterns[] present');
    assert.equal(result.patterns.length, 1, 'the clean accepted pair clusters into one pattern');
    assert.ok(result.stats, 'stats present');
    assert.equal(result.stats.findingsConsidered, 2, 'only the two clean accepted findings reached clustering');

    // Guard FIRES: the torn finding is reported, not silently dropped.
    assert.ok(Array.isArray(result.skipped), 'skipped[] present on return shape');
    assert.equal(result.skipped.length, 1, 'one torn finding reported');
    assert.match(result.skipped[0].path, /torn\.yaml$/, 'skipped record carries the offending path');
    assert.match(result.skipped[0].error, /YAML parse error/i, 'structured error string the operator can act on');
  });

  it('back-compat: torn-free findings dir → skipped[] is an empty array', () => {
    const root = resolve(TEST_ROOT, 'patterns-no-torn');
    writeFinding(root, 'org-a', 'repo-1', 'a.yaml', makeAcceptedFinding({
      id: 'dfind-clean-a', repo: 'org-a/repo-1', recordId: 'run-clean-a',
    }));

    const result = derivePatterns(root);
    assert.ok(Array.isArray(result.skipped), 'skipped[] always present (type-stable)');
    assert.equal(result.skipped.length, 0, 'no torn findings → empty skipped');
  });
});
