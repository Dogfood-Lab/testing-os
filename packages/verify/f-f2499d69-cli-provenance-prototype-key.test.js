/**
 * f-f2499d69-cli-provenance-prototype-key.test.js
 *
 * F-f2499d69 (LOW) — third call site of the F-2965699b prototype-exposed-
 * registry family: `dogfood-verify`'s local preview CLI resolves
 * `submission.source.provider` through `provenanceForProvider` (cli.js:342)
 * and threw `if (!factory)` only for a value that resolved falsy. Before the
 * F-2965699b fix, `provider='valueOf'` resolved a truthy inherited
 * `Object.prototype.valueOf` — the `!factory` gate never fired, and calling
 * that unrelated built-in as `factory(token)` produced
 * "Cannot convert undefined or null to object": exit 2, but with NO hint
 * line and a message naming nothing the operator can act on (every other
 * OperatorError in this file carries a `hint:` line).
 *
 * The fix is entirely upstream (F-2965699b's Object.hasOwn guard in
 * provenanceForProvider) — this file is the lock-in regression test the
 * finding's own verification instructions describe: a poisoned provider
 * value must now produce the SAME "unknown provenance provider" + hint pair
 * an ordinary invalid provider (e.g. 'bogus') already produces. The root-
 * cause RED/GREEN proof (revert Object.hasOwn, watch it fail) already lives
 * in provenance-registry.test.js; this file proves the correct behavior
 * reaches all the way through the CLI's error-rendering path, not just the
 * registry function in isolation.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { run } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, 'fixtures');
const REPO_ROOT = resolve(__dirname, '../..');

function makeIo(repoRoot = REPO_ROOT) {
  const out = [];
  const err = [];
  return {
    io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s), repoRoot },
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
  };
}

let pilot0;
let tmpDir;

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
  tmpDir = mkdtempSync(join(tmpdir(), 'verify-cli-provenance-proto-'));
});

function writeSubmissionWithProvider(provider) {
  const submission = structuredClone(pilot0);
  submission.source.provider = provider;
  const path = join(tmpDir, `sub-${provider.replace(/[^a-z0-9]/gi, '_')}.json`);
  writeFileSync(path, JSON.stringify(submission), 'utf-8');
  return path;
}

describe('F-f2499d69: an Object.prototype-key provider gets the SAME actionable error as an ordinary invalid provider', () => {
  it('provider="valueOf" with --provenance=github: exit 2, "unknown provenance provider", WITH a hint', async () => {
    const file = writeSubmissionWithProvider('valueOf');
    const { io, stderr } = makeIo();
    const code = await run(['--file', file, '--provenance=github'], io);

    assert.equal(code, 2, `expected exit 2; got ${code}\n${stderr()}`);
    assert.match(stderr(), /unknown provenance provider 'valueOf'/,
      `expected the actionable "unknown provenance provider" message; got: ${stderr()}`);
    assert.match(stderr(), /hint:/,
      `pre-fix this crashed with "Cannot convert undefined or null to object" and NO hint line; got: ${stderr()}`);
  });

  it('provider="__proto__" with --provenance=github: exit 2 with the same actionable message (pre-fix: uncaught TypeError)', async () => {
    const file = writeSubmissionWithProvider('__proto__');
    const { io, stderr } = makeIo();
    const code = await run(['--file', file, '--provenance=github'], io);

    assert.equal(code, 2, `expected exit 2; got ${code}\n${stderr()}`);
    assert.match(stderr(), /unknown provenance provider/,
      `expected the actionable message, not an uncaught stack; got: ${stderr()}`);
    assert.match(stderr(), /hint:/);
  });

  it('parity: a poisoned key and an ordinary invalid provider ("bogus") produce IDENTICAL error text', async () => {
    const poisonedFile = writeSubmissionWithProvider('valueOf');
    const bogusFile = writeSubmissionWithProvider('bogus');

    const poisoned = makeIo();
    const bogus = makeIo();
    await run(['--file', poisonedFile, '--provenance=github'], poisoned.io);
    await run(['--file', bogusFile, '--provenance=github'], bogus.io);

    // Same shape (only the quoted provider token differs) — proves the
    // Object.prototype key is now treated as an ordinary unknown provider,
    // not a special crash path.
    const normalize = (s) => s.replace(/provider '[^']*'/, "provider '<x>'");
    assert.equal(normalize(poisoned.stderr()), normalize(bogus.stderr()));
  });
});
