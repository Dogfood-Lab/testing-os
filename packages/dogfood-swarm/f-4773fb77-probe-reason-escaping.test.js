/**
 * f-4773fb77-probe-reason-escaping.test.js — F-4773fb77 (HIGH, wave 20):
 * formatVerify()/formatProbe() (commands/verify.js) rendered result.probe.reason
 * / p.reason UNESCAPED. Unlike every other `reason` render site in this
 * package, probe.reason is a ZERO-PRIVILEGE trust boundary: it embeds the
 * AUDITED TARGET REPO's own manifest content verbatim (node.js's probe()
 * reads package.json's `name` via plain JSON.parse with no character
 * restriction; rust.js's probe() extracts Cargo.toml's `name` via a regex
 * whose `[^"]` class matches raw newlines and ANSI bytes alike) — reachable
 * by simply being the repo `swarm verify` audits, no operator flag involved,
 * and with NO --format=json escape hatch for either verb. Fixed by routing
 * both render sites through escapeReasonForDisplay (commands/lib/escape-reason.js).
 *
 * Driven through the REAL adapter probes (lib/verify/registry.js's probeAll,
 * the same adapters `swarm verify` selects from) against REAL on-disk
 * manifests carrying the two proven payloads — a raw newline (forges a fake
 * adapter-probe row) and the ANSI cursor-erase primitive (\x1b[1A\x1b[2K,
 * already rated HIGH elsewhere in this package) — then through the CLI
 * subprocess exactly the way an operator would invoke it, mirroring the
 * scratch repro this fix was originally proven against
 * (scratchpad repro-f4773fb77.mjs, pre-dating this formal pin).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { openDb, closeDb } from './db/connection.js';
import { formatProbe } from './commands/verify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

function seedRun(dbPath, runId, repoDir) {
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status, created_at)
     VALUES (?, 'org/evil-repo', ?, ?, 'main', 'health-audit-a', '2026-06-01 00:00:00')`
  ).run(runId, repoDir, 'a'.repeat(40));
  db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')`
  ).run(runId);
  closeDb(dbPath);
}

/** @pins F-4773fb77 */
describe('F-4773fb77 — probe.reason (target-repo-controlled) is escaped before it reaches the operator terminal', () => {
  it('node adapter: a package.json "name" carrying a raw newline cannot forge a fake row in `swarm verify --probe-only` or the default verify render', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'f4773fb77-node-'));
    const repoDir = join(scratchRoot, 'target-repo');
    mkdirSync(repoDir, { recursive: true });
    // A completely ordinary JSON escape (\n) — no exotic input needed, just
    // an attacker-controlled package.json `name` field, valid JSON.
    const forgedRow = 'failed        collected     2026-01-01 00:00:00  ok';
    const maliciousName = `legit-pkg\n${forgedRow}`;
    writeFileSync(
      join(repoDir, 'package.json'),
      JSON.stringify({ name: maliciousName, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
      'utf-8',
    );

    const dbPath = join(scratchRoot, 'control-plane.db');
    seedRun(dbPath, 'runNode', repoDir);

    try {
      const rProbe = runCli(['verify', 'runNode', '--probe-only'], dbPath);
      const rVerify = runCli(['verify', 'runNode'], dbPath);

      assert.doesNotMatch(rProbe.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${rProbe.stderr}`);
      assert.ok(!rProbe.stdout.includes(maliciousName), `raw newline must not survive into --probe-only stdout:\n${rProbe.stdout}`);
      assert.ok(rProbe.stdout.includes('\\n'), `escaped \\n marker must be present (proves the value reached formatProbe):\n${rProbe.stdout}`);
      assert.ok(!rVerify.stdout.includes(maliciousName), `raw newline must not survive into default verify stdout:\n${rVerify.stdout}`);
      assert.ok(
        !rVerify.stdout.split('\n').some((l) => l.trim() === forgedRow),
        `the injected newline must not become its own real output line — that is the forged row this finding describes:\n${rVerify.stdout}`,
      );
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
    }
  });

  it('rust adapter: a Cargo.toml "name" carrying the ANSI cursor-erase primitive (\\x1b[1A\\x1b[2K) never reaches stdout as a raw ESC byte', () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'f4773fb77-rust-'));
    const repoDir = join(scratchRoot, 'target-repo');
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    const ESC = String.fromCharCode(0x1b);
    const maliciousName = `evil-crate${ESC}[1A${ESC}[2KTOTALLY LEGITIMATE`;
    // Cargo.toml is consumed via a raw-text regex scan (lib/verify/adapters/rust.js),
    // never a real TOML parser — so the raw ESC bytes land in the file text
    // verbatim, exactly the way an attacker-controlled Cargo.toml would.
    writeFileSync(join(repoDir, 'Cargo.toml'), `[package]\nname = "${maliciousName}"\nversion = "0.0.0"\n`, 'utf-8');
    writeFileSync(join(repoDir, 'src', 'main.rs'), 'fn main() {}\n', 'utf-8');

    const dbPath = join(scratchRoot, 'control-plane.db');
    seedRun(dbPath, 'runRust', repoDir);

    try {
      const rProbe = runCli(['verify', 'runRust', '--probe-only'], dbPath);
      const rVerify = runCli(['verify', 'runRust', '--adapter', 'rust'], dbPath);
      const rawAnsiPresent = (s) => s.includes(`${ESC}[1A`) || s.includes(`${ESC}[2K`);

      assert.doesNotMatch(rProbe.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${rProbe.stderr}`);
      assert.ok(!rawAnsiPresent(rProbe.stdout), `raw ESC[1A/ESC[2K bytes must not survive into --probe-only stdout: ${JSON.stringify(rProbe.stdout.slice(0, 400))}`);
      assert.ok(rProbe.stdout.includes('\\x1b'), `escaped \\x1b marker must be present:\n${rProbe.stdout}`);
      assert.ok(!rawAnsiPresent(rVerify.stdout), `raw ESC[1A/ESC[2K bytes must not survive into default verify stdout: ${JSON.stringify(rVerify.stdout.slice(0, 400))}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      try { rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
    }
  });
});

/**
 * F-a16e53ce — formatProbe()'s score meter (commands/verify.js:283-297,
 * `const bar = '#'.repeat(Math.round(p.score / 5))`) had zero test coverage
 * anywhere in the flat-root suite: grepped every *.test.js for "'#'.repeat",
 * "score / 5", "score/5", a literal run of '#' characters, "padEnd(8)", and
 * "padStart(3)" -- zero hits, including in this file, whose own docstring
 * frames its scope as the adjacent p.reason escaping path and never touches
 * the score/bar rendering at all.
 *
 * Unlike the reason-escaping coverage above (real adapters, real manifests,
 * driven through the CLI subprocess), the score meter's interesting
 * boundary values -- NaN, negative, >100 -- are not values any shipped
 * adapter in lib/verify/adapters/*.js naturally returns, so there is no
 * real-fixture path to reach them. They are exercised here as direct calls
 * against the real, unmutated formatProbe() export with a synthetic probe
 * array (the same shape probeAll() produces: `{ name, score, reason }`) --
 * this is a unit test of a pure rendering function, not a mock of a
 * dependency this package doesn't own.
 *
 * UPDATE (wave 37, F-d231b91e): the two boundary defects this block
 * originally left "DEFENSIVE (disclosed, not fixed here)" -- the negative-
 * score crash and the unclamped >100 bar -- are now fixed in
 * commands/verify.js by swarm-cp-verbs, the domain this block's own
 * comments named as owning that file. The two tests below are updated to
 * assert the FIXED (clamped) behavior instead of pinning the bug; a
 * dedicated pin test (f-d231b91e-formatprobe-score-clamp.test.js) carries
 * the `@pins F-d231b91e` declaration and the full boundary-value proof. The
 * NaN test's assertions are unchanged -- clamping NaN to 0 happens to
 * render the identical empty bar it always did -- but it is no longer an
 * accidental/undefended behavior; the Number.isFinite guard now makes it
 * deliberate.
 */
describe('F-a16e53ce — formatProbe() score-to-bar-length is proportional, with boundary values pinned', () => {
  function scoreLineFor(score) {
    const out = formatProbe([{ name: 'node', score, reason: 'ok' }]);
    const line = out.split('\n').find((l) => l.includes('/100'));
    if (!line) throw new Error(`formatProbe output had no score line:\n${out}`);
    return line;
  }
  function barOf(line) {
    return (line.match(/#+/) || [''])[0];
  }

  it('bar length scales proportionally to score: 0 -> 0 #s, 50 -> 10 #s, 100 -> 20 #s', () => {
    assert.equal(barOf(scoreLineFor(0)).length, 0,
      'score=0 must render an empty bar');
    assert.equal(barOf(scoreLineFor(50)).length, 10,
      'score=50 must render a 10-character bar (Math.round(50/5))');
    assert.equal(barOf(scoreLineFor(100)).length, 20,
      'score=100 must render a 20-character bar (Math.round(100/5))');
  });

  it('a NaN score renders an empty bar via the Number.isFinite guard (F-d231b91e), with no error signal', () => {
    // Math.round(NaN/5) is NaN, and '#'.repeat(NaN) coerces to zero
    // repetitions per the ToIntegerOrInfinity spec step (NaN -> +0) -- so a
    // non-numeric score renders an EMPTY bar with no thrown error,
    // indistinguishable from a legitimately-scored-zero adapter. F-d231b91e
    // made this deliberate: formatProbe's Number.isFinite(p.score) guard
    // falls back to 0 before clamping, so the visual output here is
    // UNCHANGED from before the fix -- what changed is that it is now a
    // guarded, intentional fallback rather than an unguarded coincidence of
    // '#'.repeat's own spec.
    const line = scoreLineFor(NaN);
    assert.match(line, /NaN\/100/,
      `NaN score must render literally as "NaN/100"; got: ${JSON.stringify(line)}`);
    assert.equal(barOf(line), '',
      `NaN score must render an empty bar (no '#'); got: ${JSON.stringify(line)}`);
  });

  it('FIXED (F-d231b91e): an out-of-range NEGATIVE score no longer crashes formatProbe -- it renders an empty, clamped bar', () => {
    // Pre-fix: '#'.repeat(n) throws for n < 0 (Math.round(-10/5) = -2, and
    // String.prototype.repeat's own spec throws RangeError for a negative
    // count). No adapter shipped in lib/verify/adapters/*.js naturally
    // returns a negative score, but nothing between an adapter's probe()
    // and formatProbe validated the value, so a future adapter bug (or a
    // hand-crafted --probe-only scenario) producing one crashed the WHOLE
    // `swarm verify --probe-only` invocation instead of rendering a
    // malformed-but-visible row. F-d231b91e (swarm-cp-verbs, wave 37) closed
    // this by clamping to [0, 100] before the '#'.repeat call. Full boundary
    // proof (including the exact -10 reproduction and the raw-score-still-
    // labeled behavior): f-d231b91e-formatprobe-score-clamp.test.js.
    assert.doesNotThrow(
      () => formatProbe([{ name: 'node', score: -10, reason: 'ok' }]),
      'a negative score must no longer crash formatProbe (F-d231b91e clamped it)',
    );
    const line = scoreLineFor(-10);
    assert.match(line, /-10\/100/, 'the raw negative score must still be visible in the label');
    assert.equal(barOf(line), '', 'a negative score clamps to an empty bar, not a partial or crashing one');
  });

  it('FIXED (F-d231b91e): a score > 100 renders a bar clamped to the 20-character max, not a misleadingly-long one', () => {
    // Pre-fix: score=200 -> Math.round(200/5)=40 '#'s against a printed
    // "/100" scale -- twice the visual length the 0-100 axis promises the
    // operator, with no upstream clamp. F-d231b91e (swarm-cp-verbs, wave 37)
    // closed this by clamping the bar's input to 100 while keeping the raw
    // score in the printed label. Full boundary proof:
    // f-d231b91e-formatprobe-score-clamp.test.js.
    const line = scoreLineFor(200);
    assert.match(line, /200\/100/, 'the raw out-of-range score must still be visible in the label');
    assert.equal(barOf(line).length, 20,
      `score=200 must render a bar clamped to the 20-character max, not the pre-fix unclamped 40; got ${barOf(line).length} in: ${JSON.stringify(line)}`);
  });
});
