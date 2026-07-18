/**
 * f-04ecea6d-verify-format-json.test.js — F-04ecea6d (LOW): `swarm verify
 * <run-id>` and `swarm verify --probe-only` had no `--format=json` option at
 * all — confirmed directly against pre-fix HEAD: cmdVerify's usage string
 * listed only `[--adapter node|python|rust] [--probe-only]`, and the
 * `--probe-only` branch returned immediately after
 * `console.log(formatProbe(probes))` with no format check anywhere; the
 * normal-run branch was the same shape one level down.
 *
 * Fixed by threading the SAME `parseFormatFlag`/`VERIFY_FORMATS` enum guard
 * the four verify-* sibling verbs already share through both cmdVerify
 * branches (cli.js):
 *   - `--probe-only --format=json` emits the raw `probes` array losslessly,
 *     unescaped (never calling formatProbe) — matching this package's
 *     universal "format=json bypasses escapeReasonForDisplay and stays
 *     lossless" convention. The default text path is unchanged.
 *   - the normal-run branch emits the identity-projected `result` object
 *     (mirrors cmdStatus/cmdDoctor), printed ALONGSIDE — not instead of —
 *     the existing cli-p-002 exit-code gating, so a non-pass verdict still
 *     exits non-zero under `--format=json` exactly as it does under text.
 *     This is the one subtlety this file exists to pin: most of this file's
 *     other `--format=json` branches `return` immediately after printing,
 *     which would have been the WRONG shape here — it would have silently
 *     reintroduced cli-p-002's original bug (a CI `swarm verify --format=
 *     json | jq` step reading exit 0 on a hard FAIL) for JSON callers only.
 *
 * Driven entirely through the real CLI subprocess (spawnSync against
 * cli.js), never a direct import of cmdVerify (it is not exported) —
 * mirroring f-4773fb77-probe-reason-escaping.test.js's own established
 * pattern for this exact verb.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openDb, closeDb } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

const tmpRoots = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

// CHILD_BASE_ENV: process.env minus NODE_TEST_CONTEXT. This suite runs under
// `node --test`, which sets NODE_TEST_CONTEXT=child-v8 in its own process
// env. spawnSync inherits it by default, so without stripping it, the
// "genuinely passing" fixture below (whose own `test` script is itself
// `node --test`) spawns a NESTED node test runner that inherits the same
// var — Node then treats it as a subordinate child-coordinator context and
// its TAP output collapses to a few bytes instead of the real summary, which
// extractTestCount then (correctly, given what it was handed) fails to
// recognize. Proven live by direct debugging: the identical fixture run
// in-process via runSteps() (no ambient NODE_TEST_CONTEXT) produces a clean
// 'pass'/test_count:1; the same fixture through this CLI subprocess, run
// from inside `node --test`, produced 'unmeasured_tests' on 23 bytes of
// output until this var was stripped. Built once at module level (a plain
// `delete` on a copy — deterministic, not reliant on undefined-env-value
// omission semantics) so runCli's spawn call below can build its env INLINE
// in the call's own argument text, which the task_6026249b sweep requires.
const CHILD_BASE_ENV = { ...process.env };
delete CHILD_BASE_ENV.NODE_TEST_CONTEXT;

// task_6026249b discipline (meta-wal-sidecar-teardown-guard.test.js's
// isolation sweep): SWARM_DB is pinned to a temp fallback AT the spawn site,
// inside the call's own argument text, so no call path — including a future
// call site that forgets dbPath, or a usage-error path that opens the DB
// before validating args (the cmdHistory precedent) — can ever touch the
// repo's live swarms/control-plane.db. The pre-fix shape built the env
// object in a separate statement and passed the bare identifier into
// spawnSync, which is exactly the "options object built outside the call
// parens" over-flag shape that sweep's own header prescribes inlining for.
// Matches f-d110f547-roadmap-seed-flags.test.js's established fallback
// idiom; explicit dbPath (every current call site) overrides the fallback.
const fallbackDbDir = makeTmpDir('f04ecea6d-fallback-db-');
function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...CHILD_BASE_ENV, SWARM_DB: dbPath || join(fallbackDbDir, 'control-plane.db') },
  });
}

function seedRun(dbPath, runId, repoDir) {
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at)
     VALUES (?, 'org/fixture-repo', ?, ?, 'main', 'health-audit-a', '2026-06-01 00:00:00')`
  ).run(runId, repoDir, 'a'.repeat(40));
  db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')`
  ).run(runId);
  closeDb(dbPath);
}

/** @pins F-04ecea6d */
describe('F-04ecea6d — `swarm verify` / `swarm verify --probe-only` support --format=json', () => {
  it('--probe-only --format=json emits a valid, parseable JSON array — the RAW probes array, losslessly unescaped, while the default text path stays escaped (F-4773fb77 unaffected)', () => {
    const scratchRoot = makeTmpDir('f04ecea6d-probe-');
    const repoDir = join(scratchRoot, 'target-repo');
    mkdirSync(repoDir, { recursive: true });
    // Reuses F-4773fb77's own proven payload: a package.json "name" carrying
    // a raw newline. Not re-testing F-4773fb77's escaping fix itself (that
    // finding owns that proof) — testing that adding --format=json did not
    // regress it, AND that the new JSON path is the lossless escape hatch
    // this package's other verbs already have.
    const maliciousName = 'legit-pkg\nFAKE-ROW';
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: maliciousName, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
      'utf-8',
    );
    const dbPath = join(scratchRoot, 'control-plane.db');
    seedRun(dbPath, 'runProbe', repoDir);

    const rJson = runCli(['verify', 'runProbe', '--probe-only', '--format=json'], dbPath);
    assert.equal(rJson.status, 0, `--probe-only --format=json must exit 0; stderr:\n${rJson.stderr}`);

    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(rJson.stdout); }, `stdout must be valid JSON:\n${rJson.stdout}`);
    assert.ok(Array.isArray(parsed), 'the JSON payload must be the raw probes array');
    const nodeEntry = parsed.find((p) => p.name === 'node');
    assert.ok(nodeEntry, 'a node probe entry must be present');
    assert.ok(
      nodeEntry.reason.includes(maliciousName),
      `the raw, unescaped name must survive losslessly into the JSON reason field; got: ${JSON.stringify(nodeEntry.reason)}`,
    );

    // Default text path: unchanged, still escaped (F-4773fb77's invariant).
    const rText = runCli(['verify', 'runProbe', '--probe-only'], dbPath);
    assert.ok(!rText.stdout.includes(maliciousName), `raw newline must not survive into default text stdout:\n${rText.stdout}`);
    assert.ok(rText.stdout.includes('\\n'), `escaped \\n marker must be present in the default text render:\n${rText.stdout}`);
  });

  it('--format=json on the normal-run branch emits the identity-projected result object, and a NON-PASS verdict still exits non-zero under JSON exactly as it does under text (cli-p-002 must not regress for JSON callers)', () => {
    const scratchRoot = makeTmpDir('f04ecea6d-verify-nonpass-');
    const repoDir = join(scratchRoot, 'target-repo');
    mkdirSync(repoDir, { recursive: true });
    // A `test` script that exits 0 but emits output matching no known runner
    // summary deterministically produces verdict 'unmeasured_tests' (lib/
    // verify/runner.js) — never 'pass' — the exact non-pass shape cli-p-002
    // exists to gate on.
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: 'nonpass-fixture', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
      'utf-8',
    );
    const dbPath = join(scratchRoot, 'control-plane.db');
    seedRun(dbPath, 'runNonPass', repoDir);

    const rJson = runCli(['verify', 'runNonPass', '--format=json'], dbPath);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(rJson.stdout); }, `stdout must be valid JSON:\n${rJson.stdout}`);
    assert.notEqual(parsed.verdict, 'pass', `fixture must produce a NON-pass verdict; got ${parsed.verdict}`);
    assert.ok(Array.isArray(parsed.steps), 'the JSON payload must carry the steps array');

    // The load-bearing assertion: exit code must be non-zero under JSON,
    // matching the text path's own exit code for the identical fixture.
    assert.notEqual(rJson.status, 0, `a non-pass verdict must exit non-zero under --format=json; stdout:\n${rJson.stdout}`);

    const rText = runCli(['verify', 'runNonPass'], dbPath);
    assert.equal(rJson.status, rText.status, 'the JSON and text paths must agree on exit code for the identical fixture/verdict');
  });

  it('--format=json on a genuinely PASSING verify still exits 0 (both formats agree on the pass case too)', () => {
    const scratchRoot = makeTmpDir('f04ecea6d-verify-pass-');
    const repoDir = join(scratchRoot, 'target-repo');
    mkdirSync(repoDir, { recursive: true });
    // `node --test` emits a real TAP summary (`# tests N` at line start,
    // lib/verify/runner.js's extractTestCount) that the runner recognizes,
    // giving a genuine positive test_count and a real 'pass' verdict — not
    // just an exit-0 no-op the way the sibling non-pass fixture above is.
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: 'pass-fixture', scripts: { test: 'node --test' } }, null, 2),
      'utf-8',
    );
    writeFileSync(
      join(repoDir, 'sample.test.js'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('trivially true', () => { assert.equal(1, 1); });\n",
      'utf-8',
    );
    const dbPath = join(scratchRoot, 'control-plane.db');
    seedRun(dbPath, 'runPass', repoDir);

    const rJson = runCli(['verify', 'runPass', '--format=json'], dbPath);
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(rJson.stdout); }, `stdout must be valid JSON:\n${rJson.stdout}`);
    assert.equal(parsed.verdict, 'pass', `fixture must produce a pass verdict; got ${parsed.verdict} (reason: ${parsed.reason}), full: ${rJson.stdout}`);
    assert.equal(rJson.status, 0, `a pass verdict must exit 0 under --format=json; stderr:\n${rJson.stderr}`);

    const rText = runCli(['verify', 'runPass'], dbPath);
    assert.equal(rText.status, 0, `a pass verdict must exit 0 under text too; stderr:\n${rText.stderr}`);
  });

  it('an out-of-enum --format value on `swarm verify` fails loud with CLI_INVALID_FORMAT, same as every verify-* sibling', () => {
    const scratchRoot = makeTmpDir('f04ecea6d-badformat-');
    const repoDir = join(scratchRoot, 'target-repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'x', scripts: {} }), 'utf-8');
    const dbPath = join(scratchRoot, 'control-plane.db');
    seedRun(dbPath, 'runBadFormat', repoDir);

    const r = runCli(['verify', 'runBadFormat', '--format=yaml'], dbPath);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ERROR \[CLI_INVALID_FORMAT\]:/, `stderr:\n${r.stderr}`);

    const rProbe = runCli(['verify', 'runBadFormat', '--probe-only', '--format=yaml'], dbPath);
    assert.notEqual(rProbe.status, 0);
    assert.match(rProbe.stderr, /ERROR \[CLI_INVALID_FORMAT\]:/, `stderr:\n${rProbe.stderr}`);
  });
});
