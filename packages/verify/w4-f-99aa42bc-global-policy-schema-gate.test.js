/**
 * w4-f-99aa42bc-global-policy-schema-gate.test.js
 *
 * F-99aa42bc (wave 4): the F-65d4d6dd fix mirrored ingest's torn-sentinel
 * contract for the REPO policy, but the GLOBAL policy was still a bare
 * yaml.load with no validatePayload('policy', …) gate — production
 * loadGlobalPolicy fails loud on a schema-invalid global policy while the
 * preview silently applied it as-is (and a null/empty YAML flowed into
 * validatePolicy, surfacing as a confusing VALIDATOR_FAULT_POLICY).
 *
 * Contract: the preview CLI schema-gates the parsed global policy and exits
 * 2 (OperatorError) on failure, mirroring loadGlobalPolicy's fail-loud
 * contract — the same preview/production-divergence class F-65d4d6dd closed
 * for the repo half.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

function withTempRoot(globalPolicyYaml, fn) {
  const root = mkdtempSync(join(tmpdir(), 'verify-cli-gpolicy-'));
  try {
    mkdirSync(join(root, 'policies'), { recursive: true });
    writeFileSync(join(root, 'policies', 'global-policy.yaml'), globalPolicyYaml, 'utf-8');
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function collectIo() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    out,
    err
  };
}

describe('F-99aa42bc — preview CLI schema-gates the global policy like production', () => {
  it('a parses-but-schema-invalid global policy is an operator error (exit 2), never silently applied', async () => {
    await withTempRoot('just_a_string: true\nnot_a_policy_field: 12\n', async (root) => {
      const { io, err } = collectIo();
      const code = await run(['--payload', '{}'], { ...io, repoRoot: root });
      assert.equal(code, 2, `stderr=${err.join('\n')}`);
      assert.match(err.join('\n'), /global policy schema-invalid/);
    });
  });

  it('a null/empty global policy YAML is an operator error (exit 2), not a VALIDATOR_FAULT_POLICY downstream', async () => {
    await withTempRoot('', async (root) => {
      const { io, err } = collectIo();
      const code = await run(['--payload', '{}'], { ...io, repoRoot: root });
      assert.equal(code, 2);
      assert.match(err.join('\n'), /global policy schema-invalid/);
      assert.doesNotMatch(err.join('\n'), /VALIDATOR_FAULT_POLICY/);
    });
  });

  it('the real repo global policy still loads (no false positive)', async () => {
    // A junk payload against the REAL policies/ must reach a verdict (exit 1
    // rejected), proving the schema gate lets a conformant policy through.
    const { io, err } = collectIo();
    const code = await run(['--payload', '{}'], { ...io, repoRoot: REPO_ROOT });
    assert.equal(code, 1, `expected a rejection verdict, not an operator error; stderr=${err.join('\n')}`);
  });

  it('production parity: the gate reuses the same policy schema production loadGlobalPolicy validates against', () => {
    // Both surfaces must cite policy.schema.json conformance — pin the
    // preview message vocabulary so drift is visible.
    const src = readFileSync(resolve(__dirname, 'cli.js'), 'utf-8');
    assert.match(src, /validatePayload\('policy', globalPolicy\)/,
      'the preview must run the canonical validatePayload seam over the global policy');
  });
});
