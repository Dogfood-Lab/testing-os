/**
 * f-5cfa163c-deterministic-now-utc.test.js
 *
 * F-5cfa163c [MEDIUM] — commands/roadmap.js's `deterministicNow(run)` reads
 * `runs.created_at`, which SQLite's own `datetime('now')` DEFAULT (db/
 * schema.js) always stores as a space-separated, timezone-UNMARKED UTC
 * string (`'YYYY-MM-DD HH:MM:SS'`). Pre-fix, `deterministicNow` parsed that
 * string with a bare `new Date(run.created_at)` — the ECMA-262 grammar
 * treats a non-'T'-separated, non-'Z'-suffixed string as LOCAL time, not
 * UTC, so on any machine whose local timezone is not UTC+0 the parsed
 * instant silently disagreed with the row's true UTC meaning by exactly the
 * local offset.
 *
 * PROOF SHAPE (per this wave's dispatch): parse the identical SQLite-shaped
 * string once as local time (the pre-fix behavior) and once forced-UTC (the
 * fix); the two epoch values differ by exactly the local UTC offset
 * whenever that offset is non-zero. Rather than depending on the CI
 * machine's own timezone (which may itself be UTC, making the two parses
 * trivially equal and the test vacuous — this repo's own "a verification
 * that cannot fail is not a verification" lesson, swarms/PROTOCOL.md
 * §"Fixing a class, not an instance"), this test spawns SEPARATE Node
 * subprocesses with an explicit, non-UTC `TZ` env var (Node honors `TZ` at
 * process start for its Date implementation) — deterministic and portable
 * to any host, including a UTC CI runner.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROADMAP_MODULE_URL = pathToFileURL(join(__dirname, 'commands', 'roadmap.js')).href;

// SQLite's real DEFAULT shape (datetime('now')) — space-separated, no
// timezone marker. Not a round datetime: minutes/seconds chosen non-zero so
// a silent truncation bug couldn't hide behind coincidental zeroes.
const SQLITE_SHAPED_CREATED_AT = '2026-07-17 12:34:56';
const EXPECTED_UTC_ISO = '2026-07-17T12:34:56.000Z';

/**
 * Runs a fresh Node subprocess under the given TZ, importing
 * commands/roadmap.js's exported `deterministicNow` and printing its result
 * for the fixed SQLite-shaped string — plus, for comparison, what a bare
 * (pre-fix-shaped) `new Date(...)` parse of the IDENTICAL string yields.
 * Both are printed as ISO strings on separate stdout lines so the test can
 * assert on each independently without a second subprocess round-trip.
 */
function runInTz(tz) {
  const code = `
    import('${ROADMAP_MODULE_URL}').then((m) => {
      const fixed = m.deterministicNow({ created_at: '${SQLITE_SHAPED_CREATED_AT}' });
      const buggyLocalParse = new Date('${SQLITE_SHAPED_CREATED_AT}');
      console.log(fixed.toISOString());
      console.log(buggyLocalParse.toISOString());
      console.log(buggyLocalParse.getTimezoneOffset());
    }).catch((e) => { console.error(e); process.exit(1); });
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf-8',
    env: { ...process.env, TZ: tz },
  });
  if (result.status !== 0) {
    assert.fail(`subprocess under TZ=${tz} failed (status ${result.status}):\n${result.stderr}`);
  }
  const [fixedIso, buggyIso, offsetRaw] = result.stdout.trim().split('\n');
  return { fixedIso, buggyIso, offsetMinutes: Number(offsetRaw) };
}

/** @pins F-5cfa163c */
describe('F-5cfa163c — deterministicNow parses runs.created_at as UTC, not local time', () => {
  it('under a non-UTC zone (America/New_York, UTC-5/-4), the fix is TZ-invariant and the pre-fix parse is NOT', () => {
    const { fixedIso, buggyIso, offsetMinutes } = runInTz('America/New_York');

    // The fix always reads the SQLite string as the UTC instant it actually
    // means, regardless of the process's local zone.
    assert.equal(fixedIso, EXPECTED_UTC_ISO,
      `deterministicNow must parse the SQLite-shaped string as UTC; got ${fixedIso}`);

    // The bug this fix closes, made concrete: under a non-UTC zone, a bare
    // `new Date(sqliteString)` parse (the pre-fix behavior) does NOT equal
    // the correct UTC instant — it is off by exactly the local offset.
    assert.notEqual(buggyIso, EXPECTED_UTC_ISO,
      'sanity check: America/New_York must actually have a non-zero UTC offset for this proof to be non-vacuous');
    const offsetMs = offsetMinutes * 60000;
    const fixedMs = Date.parse(fixedIso);
    const buggyMs = Date.parse(buggyIso);
    assert.equal(buggyMs - fixedMs, offsetMs,
      'the differential proof: parsing the identical string as local time vs. forced-UTC must differ by ' +
      'exactly getTimezoneOffset() * 60000 ms — the silent, offset-sized error the pre-fix code produced.');
  });

  it('under a different non-UTC zone (Asia/Tokyo, UTC+9), the fix still resolves to the identical UTC instant', () => {
    const { fixedIso } = runInTz('Asia/Tokyo');
    assert.equal(fixedIso, EXPECTED_UTC_ISO,
      `deterministicNow must be TZ-invariant; got ${fixedIso} under Asia/Tokyo`);
  });

  it('under UTC itself, the fix and the naive parse trivially agree (degenerate case, asserted for completeness)', () => {
    const { fixedIso, buggyIso } = runInTz('UTC');
    assert.equal(fixedIso, EXPECTED_UTC_ISO);
    assert.equal(buggyIso, EXPECTED_UTC_ISO);
  });

  it('an already timezone-marked string (e.g. a caller that already appended Z) is parsed as-is, not double-converted', () => {
    const { fixedIso } = (() => {
      const code = `
        import('${ROADMAP_MODULE_URL}').then((m) => {
          console.log(m.deterministicNow({ created_at: '2026-07-17T12:34:56.000Z' }).toISOString());
        }).catch((e) => { console.error(e); process.exit(1); });
      `;
      const result = spawnSync(process.execPath, ['-e', code], {
        encoding: 'utf-8',
        env: { ...process.env, TZ: 'America/New_York' },
      });
      assert.equal(result.status, 0, `subprocess failed:\n${result.stderr}`);
      return { fixedIso: result.stdout.trim() };
    })();
    assert.equal(fixedIso, EXPECTED_UTC_ISO);
  });

  it('an unparseable created_at falls back to the live clock, unchanged from before this fix', () => {
    const code = `
      import('${ROADMAP_MODULE_URL}').then((m) => {
        const before = Date.now();
        const result = m.deterministicNow({ created_at: 'not-a-real-date' });
        const after = Date.now();
        console.log(JSON.stringify({
          isRecent: result.getTime() >= before && result.getTime() <= after,
        }));
      }).catch((e) => { console.error(e); process.exit(1); });
    `;
    const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf-8' });
    assert.equal(result.status, 0, `subprocess failed:\n${result.stderr}`);
    const parsed = JSON.parse(result.stdout.trim());
    assert.equal(parsed.isRecent, true, 'an unparseable created_at must still degrade to a live Date(), not NaN');
  });
});
