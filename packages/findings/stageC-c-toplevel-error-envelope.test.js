/**
 * F-26179cb8 (Stage C humanization) — the findings CLI top-level catch.
 *
 * `main().catch(err => { console.error(err); process.exit(2); })` printed the
 * whole Error object — i.e. its stack — for any unexpected throw, the exact
 * anti-pattern every guarded verb path in this bin routes AROUND. A mis-rooted
 * checkout, an EACCES on a records file, or any un-caught throw handed the
 * operator a raw Node stack with no `ERROR [<code>]:` line, no message-first
 * framing, and no next command — while sibling bins (report/cli.js,
 * report/init.js) route unexpected faults through `ERROR [<CODE>]: <message>`
 * + a next-step line.
 *
 * This pins the structural contract of the improved envelope:
 *   - stderr carries `ERROR [<CODE>]:` (not a bare stack) with the message,
 *   - a `Next:` line names a recovery action (repo root / FINDINGS_REPO_ROOT /
 *     --help),
 *   - the raw stack does NOT default to stderr,
 *   - the non-zero exit code is preserved,
 *   - and DEBUG=1 still surfaces the stack for triage (gate, not default).
 *
 * The real top-level catch is exercised via a subprocess. The CLI is guarded on
 * every verb by design (that is WHY the catch is a last-resort net), so we force
 * a deterministic unexpected throw with a tiny `--import` preload that makes the
 * first `console.log` throw — the throw propagates out of `main()` straight into
 * the top-level `.catch`, exactly the path an operator hits on any un-anticipated
 * fault.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, 'cli.js');

let sandbox;
let preloadUrl;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'stageC-c-toplevel-'));
  // A preload that makes the FIRST console.log throw an un-anticipated error.
  // `dogfood findings help` calls console.log first, so the throw escapes the
  // verb and lands in main()'s top-level .catch — the real handler under test.
  const preload = join(sandbox, 'throw-on-log.mjs');
  writeFileSync(preload, [
    'let fired = false;',
    'const realLog = console.log.bind(console);',
    'console.log = (...args) => {',
    '  if (!fired) { fired = true; throw new Error("simulated unexpected fault"); }',
    '  return realLog(...args);',
    '};',
    '',
  ].join('\n'), 'utf-8');
  preloadUrl = pathToFileURL(preload).href;
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runCli(extraEnv = {}) {
  return spawnSync(process.execPath, ['--import', preloadUrl, CLI, 'help'], {
    encoding: 'utf-8',
    env: { ...process.env, ...extraEnv },
  });
}

describe('F-26179cb8: findings CLI top-level catch renders a structured envelope', () => {
  it('POSITIVE: unexpected throw → ERROR [<CODE>] + a Next: recovery line, exit 2, no default stack', () => {
    const { status, stderr } = runCli();

    assert.equal(status, 2, `non-zero exit must be preserved; stderr=${stderr}`);

    // Structured envelope — the message-first framing the sibling bins use.
    assert.match(stderr, /ERROR \[[^\]]+\]:/,
      `must render ERROR [<CODE>]: framing, not a raw Error/stack; got: ${stderr}`);
    assert.match(stderr, /simulated unexpected fault/,
      `must carry the error message; got: ${stderr}`);

    // A next-step line naming a concrete recovery action (repo root /
    // FINDINGS_REPO_ROOT / --help) — the "what do I do now" affordance.
    assert.match(stderr, /Next:/, `must print a Next: recovery line; got: ${stderr}`);
    assert.match(stderr, /FINDINGS_REPO_ROOT|repo root|--help/i,
      `Next: line must name a concrete recovery lever; got: ${stderr}`);

    // The raw stack must NOT default to stderr — that is the anti-pattern.
    assert.doesNotMatch(stderr, /^\s+at\s+.+\(.+:\d+:\d+\)/m,
      `raw stack frames must not default to stderr; got: ${stderr}`);
  });

  it('NEGATIVE: DEBUG=1 gates the stack back on for triage without losing the envelope', () => {
    const { status, stderr } = runCli({ DEBUG: '1' });

    assert.equal(status, 2, `exit code unchanged under DEBUG; stderr=${stderr}`);
    // Envelope still present.
    assert.match(stderr, /ERROR \[[^\]]+\]:/, `envelope must remain under DEBUG; got: ${stderr}`);
    // Stack surfaces for triage when explicitly requested.
    assert.match(stderr, /^\s+at\s+.+:\d+:\d+/m,
      `DEBUG=1 must surface the stack for triage; got: ${stderr}`);
  });
});
