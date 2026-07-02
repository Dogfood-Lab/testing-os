/**
 * F-a2e40a09: the stub-forbidden guard fired on ANY truthy CI/GITHUB_ACTIONS,
 * but the default-to-real-provenance branch required the exact string 'true'.
 * On a CI system exporting CI=1 with no --provenance flag, the run fell
 * through to the final else and demanded a flag — fail-closed, but the two
 * branches disagreed about what "in CI" means.
 *
 * Contract: one isCI() truthy check drives BOTH branches, so any CI system
 * (CI=1, CI=yes, GITHUB_ACTIONS=true) gets stub-forbidden AND real-by-default
 * consistently.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pilot0;
before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(__dirname, '../verify/fixtures/pilot-0-submission.json'), 'utf-8'));
});

function runCliRaw(extraArgs, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [resolve(__dirname, 'run.js'), ...extraArgs], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', GITHUB_TOKEN: '', GH_TOKEN: '', ...extraEnv }
  });
}

describe('F-a2e40a09: both CI branches agree on what "in CI" means', () => {
  it('CI=1 (truthy, not "true") defaults to REAL provenance — the error demands a token, not a flag', () => {
    const child = runCliRaw([], pilot0, { CI: '1' });
    assert.equal(child.status, 2, `stdout=${child.stdout} stderr=${child.stderr}`);
    assert.match(child.stderr, /GITHUB_TOKEN or GH_TOKEN/,
      'CI=1 must select real-by-default (token error), not fall through to the flag-required else');
    assert.doesNotMatch(child.stderr, /--provenance flag is required/,
      'the flag-required message means the CI=1 environment was NOT recognized as CI');
  });

  it('CI=1 still forbids --provenance=stub (both branches see the same environment)', () => {
    const child = runCliRaw(['--provenance', 'stub'], pilot0, { CI: '1' });
    assert.equal(child.status, 2);
    assert.match(child.stderr, /stub is not allowed in CI/);
  });

  it('GITHUB_ACTIONS=true with no flag defaults to real provenance', () => {
    const child = runCliRaw([], pilot0, { GITHUB_ACTIONS: 'true' });
    assert.equal(child.status, 2);
    assert.match(child.stderr, /GITHUB_TOKEN or GH_TOKEN/);
  });

  it('outside CI with no flag, the flag-required error still fires', () => {
    const child = runCliRaw([], pilot0);
    assert.equal(child.status, 2);
    assert.match(child.stderr, /--provenance flag is required/);
  });
});
