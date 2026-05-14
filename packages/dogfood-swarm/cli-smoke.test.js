/**
 * cli-smoke.test.js — parser-load + invoke-as-subprocess regression for cli.js.
 *
 * Why this test exists
 *
 *   The Stage D CLI Help auditor (CHR-1) surfaced that `node packages/
 *   dogfood-swarm/cli.js` was failing at parse time with `SyntaxError:
 *   missing ) after argument list at cli.js:784` for three commits worth of
 *   wave receipts (965/965/0 cumulative gate). The 965 production tests all
 *   passed because NO test in the package invokes the CLI as a subprocess —
 *   the tests that touch cli.js read it as text and grep for patterns.
 *   `package.json` declares `bin: { swarm: ./cli.js }`, which means the
 *   moment any operator runs `swarm <anything>`, they hit the parse error.
 *
 *   This file closes that vantage-point gap: every assertion here invokes
 *   the CLI the way an operator does — `node cli.js [args...]` as a child
 *   process — and grades the captured stdout/stderr against the contract
 *   the help text + per-command Usage error lines are supposed to honor.
 *
 *   Pattern #10 (FAILS-then-PASSES proof gate) from this repo's swarm-
 *   evidence catalog was applied when this file was added: the test was
 *   written and run against the broken cli.js FIRST, asserted to fail with
 *   SyntaxError, then the cli.js fix was applied and the same test was re-
 *   run to confirm pass. The hotfix dispatch JSON at
 *   `swarms/swarm-1778729265-8a9f/stage-d/hotfix/cli-smoke.json` captures
 *   the before/after stderr for audit.
 *
 *   Going forward, this test runs in `npm test` and `npm run verify`, so
 *   any future unescaped backtick (or other parser-load defect) in the
 *   help-text template literal will be caught at CI time rather than at
 *   the operator's first `swarm` invocation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args = []) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    // Inherit env so node modules resolve; bound stdio so we capture both
    // streams without parser-load output sneaking past.
  });
}

describe('cli.js parser-load (Pattern #10 regression gate)', () => {
  it('node cli.js (no args) does not produce a SyntaxError', () => {
    const r = runCli([]);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr || '', /missing \) after argument list/,
      `cli.js has an unclosed call:\n${r.stderr}`);
  });

  it('node cli.js (no args) prints the help text on stdout and exits cleanly', () => {
    const r = runCli([]);
    // No-args is treated as orientation surface, not an error — cli.js:868
    // exits with code 0 when no command was provided.
    assert.equal(r.status, 0,
      `no-args invocation should exit 0; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /swarm — Truthful swarm control plane for repo work/,
      'help banner missing from stdout');
    assert.match(r.stdout, /Commands:/,
      'help "Commands:" section header missing from stdout');
    assert.match(r.stdout, /Phases:/,
      'help "Phases:" footer missing from stdout');
  });

  it('node cli.js revalidate (no args) prints the Usage error and exits 1', () => {
    const r = runCli(['revalidate']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 1,
      `revalidate-with-no-args should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
    // cmdRevalidate prints its Usage error via console.error to stderr.
    assert.match(r.stderr, /Usage: swarm revalidate/,
      'revalidate Usage line missing from stderr');
  });

  it('node cli.js status (no args) prints the Usage error and exits 1', () => {
    const r = runCli(['status']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 1,
      `status-with-no-args should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /Usage: swarm status/,
      'status Usage line missing from stderr');
  });

  it('node cli.js dispatch (no args) prints the Usage error and exits 1', () => {
    // Belt-and-suspenders: dispatch's Usage error short-form is the
    // operator's most-frequent contact when they typo a wave-launch
    // invocation. CHR-3 noted the Usage line itself drifts from the
    // no-args help block; this test only asserts parse + Usage emission,
    // not the flag-listing completeness (that's a Stage D MEDIUM, deferred).
    const r = runCli(['dispatch']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/,
      `cli.js failed to parse:\n${r.stderr}`);
    assert.equal(r.status, 1,
      `dispatch-with-no-args should exit 1; got ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /Usage: swarm dispatch/,
      'dispatch Usage line missing from stderr');
  });
});
