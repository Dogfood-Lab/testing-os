/**
 * f-e0bcbc47-unknown-flag-rejection.test.js
 *
 * F-e0bcbc47 (Stage C humanization) — the CLI's arg-parsing loop had an
 * explicit else-if chain for every known flag, ending in a catch-all
 * `else { positionalArgs.push(args[i]); }` with no rejection of an
 * unrecognized flag. `positionalArgs` is a write-only sink (declared,
 * pushed to, never read anywhere else in the file). Live-proven pre-fix
 * trigger: `--provenance=stub --fiel <path>` (a one-character typo of
 * --file) silently dropped BOTH the misspelled flag and its path argument,
 * fell through to reading stdin, hit EOF, and crashed with a raw
 * `Unexpected end of JSON input` stack — an operator reading that message
 * has no reason to suspect a misspelled flag; the tool never even attempted
 * to read their submission file.
 *
 * Fix: reject any unrecognized `--`-prefixed token immediately via the same
 * structured D1B-001 `emitCliErrorEvent` + exit-2 discipline this file
 * already uses for every other CLI-toplevel failure, matching the sibling
 * pattern already correct in packages/verify/cli.js
 * (`unknown argument: --version` -> exit 2, no stack, no fallthrough).
 *
 * RED proof (reasoned): pre-fix, this exact invocation reliably produced
 * exit 2 via a DIFFERENT path (the stdin-EOF JSON.parse crash) — so a naive
 * "exits 2" assertion alone would NOT have caught this regression (it
 * passed both before and after for the wrong reason). The load-bearing
 * assertions here are (a) the stderr message names the actual unknown flag,
 * not a JSON parse error, and (b) the misleading 'Unexpected end of JSON
 * input' string is ABSENT — both false pre-fix (confirmed by reading the
 * pre-fix else-branch directly: it only ever pushed to positionalArgs, and
 * the JSON.parse of an eventual empty stdin read is what actually produced
 * the exit).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Parse NDJSON logStage lines out of a captured stderr stream. */
function parseStageEvents(stderrText) {
  const events = [];
  for (const line of stderrText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.stage) events.push(parsed);
    } catch {
      // Tolerate non-JSON noise (the human-readable companion banner).
    }
  }
  return events;
}

/**
 * Invoke run.js directly. Mirrors d1b-001-cli-toplevel-error-event.test.js's
 * `runCliRaw` — clears CI markers so unrelated provenance-precondition
 * guards don't fire before the arg-parsing branch under test.
 */
function runCliRaw(extraArgs, payload = '', extraEnv = {}) {
  return spawnSync(process.execPath, [
    resolve(__dirname, 'run.js'),
    ...extraArgs
  ], {
    input: payload,
    encoding: 'utf-8',
    // ingest-live-tree: the --anchor-compute cases below MUST pass
    // INGEST_REPO_ROOT via extraEnv — run.js otherwise falls back to the real
    // testing-os root and anchoring would write into the live working tree.
    // Same sandbox discipline as f-ingest-003-flag-value-not-flag.test.js.
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', GITHUB_TOKEN: '', GH_TOKEN: '', ...extraEnv }
  });
}

/** @pins F-e0bcbc47 */
describe('F-e0bcbc47 — unrecognized --flag is rejected at parse time, not silently absorbed', () => {
  it('a misspelled --fiel (typo of --file) exits 2 naming the unknown flag, NOT a JSON-parse error', () => {
    const child = runCliRaw(['--provenance', 'stub', '--fiel', '/some/path.json'], '');

    assert.equal(child.status, 2, `must exit 2; stdout=${child.stdout} stderr=${child.stderr}`);

    // The load-bearing negative: pre-fix this reliably ALSO exited 2, but via
    // the misleading JSON-parse crash. That string must now be absent.
    assert.doesNotMatch(child.stderr, /Unexpected end of JSON input/,
      `must not fall through to the misleading stdin/JSON-parse crash; stderr=${child.stderr}`);

    // The load-bearing positive: the actual typo'd flag is named.
    assert.match(child.stderr, /unknown argument: --fiel/,
      `must name the actual unrecognized flag; stderr=${child.stderr}`);

    const events = parseStageEvents(child.stderr);
    const errorEvents = events.filter((e) => e.stage === 'error');
    assert.equal(errorEvents.length, 1,
      `expected exactly one structured stage:error event; got ${errorEvents.length}. stderr=${child.stderr}`);
    assert.equal(errorEvents[0].component, 'ingest');
    assert.equal(errorEvents[0].failed_stage, 'cli_parse_args');
    assert.ok(errorEvents[0].correlation_id && errorEvents[0].correlation_id.startsWith('ing-'),
      `correlation_id must be a synth id (arg-parsing happens before any submission is read); got ${JSON.stringify(errorEvents[0].correlation_id)}`);
  });

  it('an unrecognized flag with no value token still exits 2 (no positionalArgs partner required)', () => {
    const child = runCliRaw(['--totally-bogus-flag'], '');
    assert.equal(child.status, 2);
    assert.match(child.stderr, /unknown argument: --totally-bogus-flag/);
  });

  it('a real --version-shaped unknown flag (matches the sibling verify/cli.js repro) is rejected the same way', () => {
    const child = runCliRaw(['--version'], '');
    assert.equal(child.status, 2);
    assert.match(child.stderr, /unknown argument: --version/);
  });

  it('control: a bare non-flag positional token (no leading --) does NOT trip the new rejection branch', () => {
    // Historical behavior for a stray non-flag token is unchanged by this
    // fix (it is scoped to `--`-prefixed tokens only) — the process still
    // proceeds to read stdin and fails there (empty payload -> JSON parse
    // error), NOT the new "unknown argument" message.
    const child = runCliRaw(['--provenance', 'stub', 'not-a-flag'], '');
    assert.doesNotMatch(child.stderr, /unknown argument:/,
      `a bare positional token must not trigger the --flag rejection; stderr=${child.stderr}`);
  });

  it('control: --help still works and is unaffected by the new branch', () => {
    const child = runCliRaw(['--help'], '');
    assert.equal(child.status, 0);
    assert.doesNotMatch(child.stderr, /unknown argument:/);
  });
});

// ─────────────────────────────────────────────────────────────────
// The boundary this fix's FIRST attempt got wrong (caught by wave 29's
// serial verify, not by this file — which is why these cases are here now).
//
// The first attempt used a bare `else if (arg.startsWith('--'))` catch-all.
// That cannot distinguish "unknown flag" from "KNOWN flag whose `&& hasValue`
// guard failed", so it reported the real, handled flag `--anchor-network` as
// `unknown argument: --anchor-network` when F-INGEST-003's own fix correctly
// made `hasValue` false (next token is a flag, not a value). The message was
// a lie, and it broke F-INGEST-003's pinned contract.
//
// The tests above all passed against that broken build — every one of them
// uses a genuinely-unknown flag, so none of them could see the false-positive
// on a KNOWN one. That is the gap: this file asserted the fix fired, never
// that it fired ONLY where it should.
// ─────────────────────────────────────────────────────────────────

/** @pins F-e0bcbc47 */
describe('F-e0bcbc47 boundary: a KNOWN flag missing its value is NOT "unknown"', () => {
  it('--anchor-network --anchor-compute: the known-but-dangling flag is never reported as an unknown argument', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'f-e0bcbc47-boundary-'));
    try {
      const child = runCliRaw(
        ['--provenance', 'stub', `--payload=${JSON.stringify({ run_id: 't', repo: 'o/r' })}`,
          '--anchor-network', '--anchor-compute'],
        '',
        { INGEST_REPO_ROOT: sandbox }
      );
      const out = `${child.stdout}${child.stderr}`;
      // The exact regression: --anchor-network IS a known flag (run.js handles
      // it via `flagIs('--anchor-network') && hasValue`); calling it unknown is
      // a false claim.
      assert.doesNotMatch(out, /unknown argument: --anchor-network/,
        `a KNOWN flag missing its value must never be reported as unknown:\n${out}`);
      // And F-INGEST-003's pinned behavior still holds: the FOLLOWING flag runs.
      assert.match(out, /anchor-compute:/,
        `--anchor-compute must still run on its own (F-INGEST-003's pin):\n${out}`);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('the dangling known flag emits an honest structured warn naming it (residual: ignored, not honoured — but no longer silent)', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'f-e0bcbc47-warn-'));
    try {
      const child = runCliRaw(
        ['--provenance', 'stub', `--payload=${JSON.stringify({ run_id: 't', repo: 'o/r' })}`,
          '--anchor-network', '--anchor-compute'],
        '',
        { INGEST_REPO_ROOT: sandbox }
      );
      const warns = parseStageEvents(child.stderr)
        .filter((e) => e.stage === 'warn' && e.kind === 'cli_flag_missing_value');
      assert.equal(warns.length, 1,
        `expected exactly one cli_flag_missing_value warn; got ${JSON.stringify(warns)}`);
      assert.equal(warns[0].flag, '--anchor-network');
      assert.equal(warns[0].component, 'ingest');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('a genuinely unknown flag is STILL rejected — this boundary fix did not just disable the rejection', () => {
    // Counter-test: without this, the two cases above could both be satisfied
    // by deleting the rejection entirely.
    const child = runCliRaw(['--fiel', '/some/path.json'], '');
    assert.equal(child.status, 2);
    assert.match(child.stderr, /unknown argument: --fiel/);
  });
});

/** @pins F-e0bcbc47 */
describe('F-e0bcbc47 chain-shape guard: every flag branch registers through flagIs()', () => {
  it('no branch in the arg-parse chain compares `arg` to a flag literal directly', () => {
    // `knownFlagName` is DERIVED from the chain (see run.js's flagIs doc): a
    // branch written as a bare `arg === '--new'` would parse fine but would
    // NOT register the name, so that flag would be misreported as "unknown"
    // the moment it dangles — reintroducing exactly the bug above for the new
    // flag only. This guard makes that shape impossible to add silently.
    //
    // Deliberately anchored on the full `} else if (arg === '` code shape
    // rather than a bare `arg === '` scan: this repo's own PROTOCOL warns that
    // any gate grepping raw source will eventually trip on a comment ("prose
    // is not code"), and run.js's comments DO discuss `arg === '--new'` in
    // prose. The canonical comment-stripper lives at
    // packages/dogfood-swarm/test-support/strip-comments.js, which this
    // package cannot import — it is not in dogfood-swarm's `exports` field,
    // and adding one is an out-of-domain edit. The anchored shape is the
    // honest compromise, and it FAILS CLOSED: a comment that ever contains
    // this exact prefix makes the test go RED (a visible, investigable false
    // positive), never silently green. That is the safe direction.
    const src = readFileSync(resolve(__dirname, 'run.js'), 'utf-8');
    const offenders = src.split('\n')
      .map((line, n) => ({ line: line.trim(), n: n + 1 }))
      .filter(({ line }) => /\} else if \(arg === '/.test(line));

    assert.deepEqual(offenders, [],
      'every flag branch must register its name via flagIs() so the ' +
      'known-flag set stays derived from the chain instead of drifting:\n' +
      offenders.map((o) => `  run.js:${o.n}: ${o.line}`).join('\n'));
  });
});
