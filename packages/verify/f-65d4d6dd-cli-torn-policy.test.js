/**
 * F-65d4d6dd: the verify CLI's preview path loaded the repo policy with a bare
 * yaml.load and no schema gate, so a policy that PARSES but is schema-invalid
 * (the D2B-005 class) was silently applied as-is — `dogfood-verify --explain`
 * could print VERDICT: ACCEPTED for a submission production ingest rejects
 * with `policy: repo policy unreadable — schema-invalid …`. The CLI exists to
 * prevent exactly that preview/production divergence.
 *
 * Contract after the fix (byte-identical to ingest's loadRepoPolicy):
 *   - absent policy file          → null (defaults apply)
 *   - parses but schema-invalid   → { __torn: true } sentinel → rejected
 *   - exists but YAML-unparseable → { __torn: true } sentinel → rejected
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { run } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const REAL_REPO_ROOT = resolve(__dirname, '../..');

let pilot0;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

function makeIo(repoRoot) {
  const out = [];
  const err = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), repoRoot },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n')
  };
}

/**
 * Build a temp repoRoot with the REAL global policy and an optional repo
 * policy for pilot-0's repo (mcp-tool-shop-org/dogfood-labs).
 */
function makeRepoRoot(repoPolicyText) {
  const root = mkdtempSync(join(tmpdir(), 'verify-cli-torn-'));
  mkdirSync(join(root, 'policies', 'repos', 'mcp-tool-shop-org'), { recursive: true });
  copyFileSync(
    join(REAL_REPO_ROOT, 'policies', 'global-policy.yaml'),
    join(root, 'policies', 'global-policy.yaml')
  );
  if (repoPolicyText != null) {
    writeFileSync(
      join(root, 'policies', 'repos', 'mcp-tool-shop-org', 'dogfood-labs.yaml'),
      repoPolicyText,
      'utf-8'
    );
  }
  return root;
}

describe('F-65d4d6dd: CLI preview matches ingest on broken repo policies', () => {
  it('rejects when the repo policy parses but is schema-invalid (was: silent ACCEPTED)', async () => {
    // Parses cleanly; violates policy.schema.json (unknown top-level key +
    // bad enforcement.mode enum) — the exact D2B-005 class.
    const root = makeRepoRoot([
      'policy_version: "1.0.0"',
      'repo: mcp-tool-shop-org/dogfood-labs',
      'enforcement:',
      '  mode: banana',
      'not_a_policy_field: true',
      ''
    ].join('\n'));

    const { io, stdout } = makeIo(root);
    const code = await run(['--payload', JSON.stringify(pilot0), '--explain'], io);
    assert.equal(code, 1, `expected exit 1 (rejected), got ${code}\n${stdout()}`);
    assert.match(stdout(), /repo policy unreadable/);
    assert.match(stdout(), /schema-invalid/);
  });

  it('rejects when the repo policy file exists but is not parseable YAML', async () => {
    const root = makeRepoRoot('::not: valid: yaml: {{{');
    const { io, stdout } = makeIo(root);
    const code = await run(['--payload', JSON.stringify(pilot0), '--explain'], io);
    assert.equal(code, 1, `expected exit 1 (rejected), got ${code}\n${stdout()}`);
    assert.match(stdout(), /repo policy unreadable/);
  });

  it('still accepts when no repo policy exists (defaults apply)', async () => {
    const root = makeRepoRoot(null);
    const { io, stdout } = makeIo(root);
    const code = await run(['--payload', JSON.stringify(pilot0), '--explain'], io);
    assert.equal(code, 0, `expected exit 0 (accepted), got ${code}\n${stdout()}`);
    assert.match(stdout(), /VERDICT: ACCEPTED/);
  });
});
