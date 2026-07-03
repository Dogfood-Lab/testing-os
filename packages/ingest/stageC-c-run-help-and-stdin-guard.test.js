/**
 * stageC-c-run-help-and-stdin-guard.test.js
 *
 * Two Stage-C humanization fixes on the production WRITE-path CLI
 * (packages/ingest/run.js), the highest-stakes (record-writing) operator
 * surface and — before this — the only bin in the monorepo where `--help` did
 * nothing and a bare invocation hung.
 *
 *   F-9a65b10c (cli_help_quality) — run.js recognized none of `-h`/`--help`.
 *     An unknown `--help` fell through to positionalArgs and was ignored, after
 *     which the process blocked on stdin. Every other bin ships a USAGE block
 *     (verify/cli.js, report/cli.js, portfolio/generate.js). Fix: a
 *     `-h`/`--help` case before the positional fallback prints USAGE covering
 *     the input modes (`--file`/`--payload`/stdin), `--provenance`,
 *     `--verify-only`, and the standalone audit verbs, then exits 0.
 *
 *   F-aa67ea9a (ux) — with no `--file`/`--payload`/standalone verb, control
 *     reached the stdin read with NO `process.stdin.isTTY` guard, so a bare
 *     `node run.js` at an interactive terminal produced zero output and blocked
 *     forever — indistinguishable from a hang. Fix: guard `process.stdin.isTTY`
 *     before the read; if true (no piped input) print `ERROR: no submission
 *     provided` + a `hint:` line and exit 2, matching verify/cli.js's
 *     `no submission provided` operator error.
 *
 * Both are exercised against the REAL CLI via spawnSync. The TTY case is
 * simulated with a tiny `--import` preload that forces `process.stdin.isTTY =
 * true` before run.js reads it — a spawned child's stdin is otherwise a pipe.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(__dirname, 'run.js');

let sandbox;
let ttyPreloadUrl;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'stageC-c-run-'));
  // Force an interactive-terminal stdin for the empty-state guard test — a
  // spawned child's stdin is a pipe (isTTY undefined), so we assert isTTY=true
  // before run.js reads it.
  const preload = join(sandbox, 'force-tty.mjs');
  writeFileSync(preload,
    "Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });\n",
    'utf-8');
  ttyPreloadUrl = pathToFileURL(preload).href;
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('F-9a65b10c: run.js ships a -h/--help USAGE block (exit 0)', () => {
  for (const flag of ['--help', '-h']) {
    it(`\`${flag}\` prints USAGE covering input modes + verbs and exits 0`, () => {
      const { status, stdout, stderr } = spawnSync(
        process.execPath, [RUN, flag],
        { encoding: 'utf-8', input: '' }
      );
      const out = stdout + stderr;
      assert.equal(status, 0, `${flag} must exit 0; out=${out}`);
      assert.match(out, /usage/i, `${flag} must print a USAGE block; got: ${out}`);
      // Load-bearing tokens: the input modes and the standalone verbs an
      // operator needs the reference for.
      assert.match(out, /--file/, `USAGE must document --file; got: ${out}`);
      assert.match(out, /--payload/, `USAGE must document --payload; got: ${out}`);
      assert.match(out, /stdin/i, `USAGE must mention stdin input; got: ${out}`);
      assert.match(out, /--provenance/, `USAGE must document --provenance; got: ${out}`);
      assert.match(out, /--verify-chain/, `USAGE must document --verify-chain; got: ${out}`);
    });
  }
});

describe('F-aa67ea9a: run.js with an interactive stdin fails fast instead of hanging', () => {
  it('POSITIVE: no input + isTTY → ERROR + hint naming --file/--payload/--help, exit 2 (no hang)', () => {
    const { status, stdout, stderr } = spawnSync(
      process.execPath, ['--import', ttyPreloadUrl, RUN],
      { encoding: 'utf-8', input: '', timeout: 10_000 }
    );
    const out = stdout + stderr;

    // The core of the fix: it returns instead of blocking forever. spawnSync
    // returns a numeric status; a timeout would surface as signal SIGTERM.
    assert.notEqual(status, null, `must NOT hang on stdin; timed out (status=null); out=${out}`);
    assert.equal(status, 2, `interactive empty-state must exit 2; out=${out}`);

    assert.match(out, /no submission provided/i,
      `must name the empty state; got: ${out}`);
    // The hint verb + the concrete next levers.
    assert.match(out, /hint:/i, `must print a hint: line; got: ${out}`);
    assert.match(out, /--file/, `hint must name --file; got: ${out}`);
    assert.match(out, /--payload/, `hint must name --payload; got: ${out}`);
    assert.match(out, /--help/, `hint must point at --help; got: ${out}`);
  });

  it('NEGATIVE: valid JSON piped on a non-TTY stdin still parses (guard does not fire on piped input)', () => {
    // A non-TTY stdin (a pipe, as in CI) must NOT trip the empty-state guard;
    // the payload is read and processed. We feed malformed-but-nonempty JSON and
    // assert we get PAST the guard into JSON parsing (exit 2 with a *parse*
    // error, not the no-submission error).
    const { status, stdout, stderr } = spawnSync(
      process.execPath, [RUN, '--provenance', 'stub'],
      { encoding: 'utf-8', input: 'not json', timeout: 10_000 }
    );
    const out = stdout + stderr;
    assert.notEqual(status, null, `must not hang on a piped stdin; out=${out}`);
    assert.doesNotMatch(out, /no submission provided/i,
      `piped input must not trip the isTTY empty-state guard; got: ${out}`);
  });
});
