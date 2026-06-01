/**
 * D2B-005 — Policy schema validation at load time.
 *
 * Pre-fix: `loadGlobalPolicy` and `loadRepoPolicy` validated only that the
 * YAML parsed (D1B-006 closed the torn-parse gap). A policy YAML that
 * parsed cleanly but didn't conform to `policy.schema.json` — extra
 * fields, wrong types, missing required, malformed enums — silently
 * loaded and the downstream `validatePolicy` fell through to ad-hoc
 * field probing, producing "verifier accepts everything" for a
 * structurally invalid policy. The verifier IS the gate; a structural
 * bypass is a real defense-in-depth gap.
 *
 * Post-H3 the fix is one-line trivial: `validatePayload('policy', …)`
 * at load time. The canonical seam holds the cached validator, so the
 * cost is one cache hit per policy load (already amortised by the
 * existing per-call module-scope caching).
 *
 * Contracts preserved:
 *   - The 14 currently-shipping policies (1 global + 13 repo) must
 *     ALL pass the new gate. A migration that rejected a real policy
 *     would be a regression, not a fix. The kickoff explicitly required
 *     this check first; this file pins it as a regression-test.
 *   - The torn-sentinel mechanism (D1B-006: `{ __torn: true, reason, path }`)
 *     is reused for the schema-invalid case. The verifier already
 *     surfaces the sentinel as `policy: <reason>` rejection (verify/index.js
 *     line 189-192); no verifier change needed.
 *   - Global policy load throws a structured error (matches the existing
 *     YAML-invalid throw pattern) because the global policy is required
 *     and a fault at load time should fail loud, not produce a
 *     misleading per-submission rejection on every later request.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync,
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadGlobalPolicy, loadRepoPolicy } from './load-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

// ─────────────────────────────────────────────────────────────────
// Regression pin — every currently-shipping policy passes the new gate
// ─────────────────────────────────────────────────────────────────

describe('D2B-005 — every shipping policy passes load-time schema validation (regression pin)', () => {
  it('global-policy.yaml loads cleanly under the new gate', () => {
    const policy = loadGlobalPolicy(REPO_ROOT);
    assert.equal(typeof policy, 'object', 'global policy must load as object');
    assert.ok(policy !== null, 'global policy must not be null');
    // The shape of `policy.policy_version` confirms we got past the
    // load — if loadGlobalPolicy had thrown the assertion would
    // surface the thrown error instead.
    assert.equal(typeof policy.policy_version, 'string',
      'global policy.policy_version must be a string per policy.schema.json');
  });

  it('every shipping repo policy under policies/repos/ loads cleanly under the new gate', () => {
    const orgDir = resolve(REPO_ROOT, 'policies/repos/mcp-tool-shop-org');
    const repoFiles = readdirSync(orgDir).filter(f => f.endsWith('.yaml'));
    assert.ok(repoFiles.length >= 10,
      `expected at least 10 shipping repo policies; got ${repoFiles.length}`);

    for (const file of repoFiles) {
      const repoName = file.replace(/\.yaml$/, '');
      const slug = `mcp-tool-shop-org/${repoName}`;
      const result = loadRepoPolicy(slug, REPO_ROOT);
      // None of the shipping policies should be missing (the test
      // enumerates files that exist), and none should be torn (clean
      // YAML in the repo), and the new gate must not reject any of
      // them — that would be the regression the kickoff warned about.
      assert.notEqual(result, null,
        `${slug}: loadRepoPolicy returned null but the file exists at ${file}`);
      assert.notEqual(result.__torn, true,
        `${slug}: loadRepoPolicy returned __torn sentinel — should load cleanly. ` +
        `reason=${result.reason ?? '(none)'}, path=${result.path ?? '(none)'}. ` +
        `D2B-005 regression: the new schema gate rejected a currently-shipping ` +
        `policy. Either the policy is genuinely malformed (fix the YAML), or ` +
        `the schema is too strict (loosen the schema and re-verify against ` +
        `the full set).`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// POSITIVE — global policy: schema-invalid YAML throws structured error
// ─────────────────────────────────────────────────────────────────

describe('D2B-005 — global policy schema-invalid throws at load time', () => {
  const TEST_ROOT = resolve(__dirname, '__test_root_d2b005_global__');

  function withTempRepoRoot(globalPolicyContent) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(resolve(TEST_ROOT, 'policies'), { recursive: true });
    writeFileSync(
      resolve(TEST_ROOT, 'policies/global-policy.yaml'),
      globalPolicyContent,
      'utf-8',
    );
  }

  it('POSITIVE: global policy with extra unknown field throws schema-invalid (additionalProperties: false)', (t) => {
    // policy.schema.json declares `additionalProperties: false` at the
    // root. A YAML that parses but smuggles in an extra top-level key
    // (typo'd section name, copy-paste from a different schema,
    // intentional manipulation) should fail the load-time gate.
    // Pre-fix this silently loaded and the verifier's ad-hoc field
    // probing ignored the unknown key — "verifier defaults to lenient
    // for a structurally invalid policy."
    withTempRepoRoot('policy_version: "1.0.0"\nthisFieldIsNotInTheSchema: "should-fail"\n');
    t.after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

    assert.throws(
      () => loadGlobalPolicy(TEST_ROOT),
      /global policy schema-invalid/i,
      'a global policy with extra unknown fields must throw a "schema-invalid" error, ' +
      'not silently load and let the verifier default to lenient',
    );
  });

  it('POSITIVE: global policy missing required `policy_version` throws schema-invalid', (t) => {
    // policy_version is the ONLY required field at the top level per
    // policy.schema.json. A YAML that omits it is a stronger violation
    // than the extra-field case above — required-field misses are
    // structurally invalid even without strict-mode checking.
    withTempRepoRoot('enforcement:\n  mode: "required"\n');
    t.after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

    assert.throws(
      () => loadGlobalPolicy(TEST_ROOT),
      /global policy schema-invalid/i,
      'a global policy missing the required policy_version field must throw',
    );
  });

  it('POSITIVE: error message names the path and a schema-violation reason', (t) => {
    withTempRepoRoot('policy_version: "1.0.0"\nbogusField: "x"\n');
    t.after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

    try {
      loadGlobalPolicy(TEST_ROOT);
      assert.fail('expected loadGlobalPolicy to throw');
    } catch (e) {
      assert.match(e.message, /global-policy\.yaml/,
        'error must name the offending file path');
      assert.match(e.message, /schema|additional|property|required/i,
        'error must mention a schema violation reason (extra property, required field, etc.)');
    }
  });

  it('NEGATIVE: a valid global policy still loads cleanly', (t) => {
    // Build a minimal-valid policy by copying the shipping one — we
    // know it passes (regression pin above).
    const shipping = readFileSync(resolve(REPO_ROOT, 'policies/global-policy.yaml'), 'utf-8');
    withTempRepoRoot(shipping);
    t.after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

    const result = loadGlobalPolicy(TEST_ROOT);
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.policy_version, 'string');
  });
});

// ─────────────────────────────────────────────────────────────────
// POSITIVE — repo policy: schema-invalid YAML produces __torn sentinel
// ─────────────────────────────────────────────────────────────────

describe('D2B-005 — repo policy schema-invalid surfaces as __torn sentinel (D1B-006 reuse)', () => {
  const TEST_ROOT = resolve(__dirname, '__test_root_d2b005_repo__');

  function withTempRepoPolicy(orgRepo, content) {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    const [org, repo] = orgRepo.split('/');
    mkdirSync(resolve(TEST_ROOT, 'policies/repos', org), { recursive: true });
    writeFileSync(
      resolve(TEST_ROOT, 'policies/repos', org, `${repo}.yaml`),
      content,
      'utf-8',
    );
  }

  it('POSITIVE: repo policy with wrong enforcement.mode enum returns __torn with schema reason', (t) => {
    // The policy.schema.json restricts enforcement.mode to specific
    // enum values. A YAML that parses but uses an invalid enum must
    // surface as __torn — the same sentinel mechanism D1B-006 uses
    // for YAML parse failures, so the existing verify-side handler
    // catches both classes with one branch.
    withTempRepoPolicy(
      'mcp-tool-shop-org/test-repo',
      'repo: mcp-tool-shop-org/test-repo\npolicy_version: "1.0.0"\nsurfaces:\n  cli:\n    execution_mode_policy:\n      allowed:\n        - "totally-invalid-enum-value"\n',
    );
    t.after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

    const result = loadRepoPolicy('mcp-tool-shop-org/test-repo', TEST_ROOT);
    assert.equal(result.__torn, true,
      `schema-invalid repo policy must return __torn sentinel; got ${JSON.stringify(result)}`);
    assert.equal(typeof result.reason, 'string',
      '__torn sentinel must carry a reason string');
    assert.equal(typeof result.path, 'string',
      '__torn sentinel must carry the policy file path');
    // The reason should mention the schema-class problem (not just
    // "YAML parse failed" — that's the D1B-006 case).
    assert.match(result.reason, /schema|enum|allowed|invalid/i,
      `__torn reason should mention the schema-class problem; got: ${result.reason}`);
  });

  it('NEGATIVE: a valid repo policy loads cleanly (no __torn)', (t) => {
    // Mirror the shape of an existing shipping policy so we know the
    // schema accepts it.
    withTempRepoPolicy(
      'mcp-tool-shop-org/test-repo',
      'repo: mcp-tool-shop-org/test-repo\npolicy_version: "1.0.0"\nsurfaces:\n  cli:\n    required_scenarios:\n      - "test-scenario"\n    freshness:\n      max_age_days: 30\n',
    );
    t.after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

    const result = loadRepoPolicy('mcp-tool-shop-org/test-repo', TEST_ROOT);
    assert.notEqual(result, null);
    assert.notEqual(result.__torn, true,
      `valid repo policy must NOT return __torn; got reason=${result.reason ?? '(none)'}`);
    assert.equal(result.repo, 'mcp-tool-shop-org/test-repo');
  });

  it('NEGATIVE: missing repo policy file STILL returns null (defaults-apply contract preserved)', (t) => {
    // The D1B-006 design specifically preserved "no repo-policy file →
    // defaults apply silently → null" as a distinct shape from
    // "__torn". D2B-005 must NOT collapse these two into one — a
    // missing policy is not a schema failure, and tightening the
    // missing-file case to a rejection would change a documented
    // contract.
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(resolve(TEST_ROOT, 'policies/repos/mcp-tool-shop-org'), { recursive: true });
    t.after(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

    const result = loadRepoPolicy('mcp-tool-shop-org/nonexistent-repo', TEST_ROOT);
    assert.equal(result, null,
      'missing repo policy file must return null (defaults-apply), NOT __torn');
  });
});
