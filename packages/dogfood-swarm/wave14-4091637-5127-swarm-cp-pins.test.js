/**
 * wave14-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pin
 * for wave 14 (health-amend-a, the FINAL amend) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: package-root `*.test.js` is swarm-cp-tests' glob, but its
 * `ownership_class` is `bridge` (not `owned`) — confirmed directly against
 * the live control-plane domain map for this run: no OWNED domain's globs
 * match `packages/dogfood-swarm/*.test.js` (swarm-cp-verbs owns only
 * `commands/**` + `cli.js`), so `resolveExclusiveOwner` returns null for this
 * file and `checkOwnership`'s bridge fallback (lib/domains.js) grants ANY
 * calling domain — not just swarm-cp-tests' own agent — a valid claim on it,
 * independent of which domain's name is doing the collecting. commands/
 * collect.js additionally confirms this wave runs `--isolate`d (each agent's
 * worktree diffed on its own, `independentTouched = actualTouched.all`, no
 * narrowToExclusivelyOwned trimming), so the full untracked-file diff this
 * commit produces — including this new file — reaches checkOwnership as-is.
 * Landed directly from the swarm-cp-verbs worktree rather than deferred to
 * the coordinator at merge (contrast wave12's sibling pin file, which notes
 * the wave-12 agent believed it could not commit a root test itself).
 *
 *   F-fa23cc37 (LOW) — F-51fa8e13's fix (formatOverrideGroups) grouped gate
 *     names sharing an identical reason correctly, but joined the resulting
 *     `gates: reason` clauses with the SAME '; ' the reason's OWN free text
 *     could also contain (--reason is unrestricted operator text, no
 *     character validation anywhere in cmdAdvance/parseValueFlag) — so a
 *     reason containing the literal substrings '; ' or ': ' rendered
 *     indistinguishably from genuine clause structure in the `--history`
 *     text view. The fix wraps each reason in double quotes and escapes any
 *     embedded '\' or '"' (escapeReasonForDisplay, backslash-first so an
 *     existing `\"` round-trips instead of being misread) — the only
 *     UNESCAPED quote in a rendered clause is its true closing one, so the
 *     clause boundary is recoverable regardless of the reason's content,
 *     including a reason that tries to forge a fake second clause with a raw
 *     `"`. `--format=json` (buildPromotionsJSON) is untouched: it stays the
 *     lossless, unescaped canonical form this file's Case E pins.
 *
 *   F-11f0e453 (MEDIUM, wave 16) — F-fa23cc37's quote/backslash fence stops a
 *     reason from forging fake STRUCTURE inside one printed line, but never
 *     neutralized a literal newline, which forges an entire fake LINE:
 *     `console.log` prints whatever bytes a reason contains, so an embedded
 *     '\n' ends the current terminal line and starts a new one that can be
 *     shaped, byte-for-byte, to look like a genuine second `--history` row
 *     (fake timestamp, fake phase transition, fake gate count, fake
 *     authorizer) — proven live by direct CLI-subprocess execution against
 *     the real, unmutated shipped code. escapeReasonForDisplay now also
 *     escapes '\n', '\r', and '\t' to their visible two-character form,
 *     confining the entire rendered row to the one line `console.log` was
 *     asked to print; `--format=json` remains untouched and lossless. This
 *     wave also closes a mutation-coverage gap wave-15's F-1518efd6 found in
 *     the F-fa23cc37 pins above: none of the 5 exercise the TEXT view with a
 *     raw backslash (only the --format=json pin at line 203 does, and JSON
 *     bypasses escapeReasonForDisplay entirely), so a mutant dropping ONLY
 *     the backslash-doubling half passed all 5. The new pins below combine a
 *     trailing raw backslash with the newly-escaped newline in one
 *     adversarial reason so both escape passes — and their ordering — are
 *     exercised together, not in isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

function teardown(dir) {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows lock lag */ } }
}

function seedPromotion(overrides) {
  const tmp = mkdtempSync(join(tmpdir(), 'w14-history-'));
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);
  const RUN_ID = 'run-w14-history';
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
     VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
  ).run(RUN_ID, tmp, 'a'.repeat(40));
  const wave = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status)
     VALUES (?, 'health-audit-a', 1, 'collected')`
  ).run(RUN_ID);
  const waveId = Number(wave.lastInsertRowid);
  const gatesChecked = overrides.map(o => ({ name: o.gate, passed: false, overridden: true }));
  db.prepare(
    `INSERT INTO promotions (wave_id, run_id, from_phase, to_phase, authorized_by, gates_checked, overrides, finding_snapshot)
     VALUES (?, ?, 'health-audit-a', 'health-amend-a', 'director', ?, ?, NULL)`
  ).run(waveId, RUN_ID, JSON.stringify(gatesChecked), JSON.stringify(overrides));
  closeDb(dbPath);
  return { tmp, dbPath, RUN_ID };
}

function extractOverrideTag(stdout) {
  const m = stdout.match(/\[OVERRIDE: ([\s\S]*)\]/);
  assert.ok(m, `expected an [OVERRIDE: ...] tag in stdout:\n${stdout}`);
  return m[1];
}

/**
 * The correct grammar for `gate, gate: "escaped reason"; ...` — the ONLY
 * unescaped '"' in a clause closes it, so this parser recovers the exact
 * {gates, reason} pairs regardless of what punctuation (including raw '"'
 * or '\') the reason contains. Assumes gate names never contain ':' ',' '"'
 * '\\' — true in production, where gate names are the fixed literal set
 * checkGates() emits (adjudication/verification/ownership — lib/advance.js).
 */
function parseOverrideGroups(text) {
  const groups = [];
  let i = 0;
  while (i < text.length) {
    const sepIdx = text.indexOf(': "', i);
    if (sepIdx === -1) throw new Error(`malformed at ${i}: no ': "' found in ${JSON.stringify(text.slice(i))}`);
    const gates = text.slice(i, sepIdx).split(', ');
    let j = sepIdx + 3;
    let reason = '';
    let closed = false;
    while (j < text.length) {
      const ch = text[j];
      if (ch === '\\' && j + 1 < text.length) { reason += text[j + 1]; j += 2; continue; }
      if (ch === '"') { j += 1; closed = true; break; }
      reason += ch; j += 1;
    }
    if (!closed) throw new Error(`malformed: unterminated quote from ${sepIdx}`);
    groups.push({ gates, reason });
    if (text.slice(j, j + 2) === '; ') i = j + 2;
    else if (j >= text.length) i = j;
    else throw new Error(`malformed: unexpected trailer at ${j}: ${JSON.stringify(text.slice(j))}`);
  }
  return groups;
}

test('F-fa23cc37: a reason containing the delimiter chars renders unambiguously — the stress case from the finding', () => {
  // Two REAL groups; the FIRST reason itself contains '; ' — pre-fix this
  // naive-'; '-split-misread as THREE clauses (a gate-less middle one).
  const fx = seedPromotion([
    { gate: 'adjudication', reason: 'fixing A; also fixing B' },
    { gate: 'ownership', reason: 'second reason' },
  ]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history'], fx.dbPath);
    assert.equal(r.status, 0, `--history should render: ${r.stderr}`);
    const tag = extractOverrideTag(r.stdout);
    // Visual fence: both reasons are quote-bounded in the rendered text.
    assert.match(tag, /adjudication: "fixing A; also fixing B"/,
      'the reason\'s own \'; \' stays inside its quotes, not read as a clause break');
    assert.match(tag, /ownership: "second reason"/, 'the second, genuinely distinct clause is still present');
    // Mechanical proof: a quote-aware parser recovers the TRUE 2 groups, not 3.
    const parsed = parseOverrideGroups(tag);
    assert.equal(parsed.length, 2, `expected 2 groups, got ${JSON.stringify(parsed)}`);
    assert.deepEqual(parsed[0], { gates: ['adjudication'], reason: 'fixing A; also fixing B' });
    assert.deepEqual(parsed[1], { gates: ['ownership'], reason: 'second reason' });
  } finally {
    teardown(fx.tmp);
  }
});

test('F-fa23cc37: a reason containing a raw double-quote cannot forge a fake second clause', () => {
  // Naive "just add quotes, don't escape" would let this reason inject what
  // looks like its own closing quote followed by a second override.
  const fx = seedPromotion([
    { gate: 'adjudication', reason: 'a"; ownership: "fake' },
  ]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history'], fx.dbPath);
    assert.equal(r.status, 0, `--history should render: ${r.stderr}`);
    const tag = extractOverrideTag(r.stdout);
    const parsed = parseOverrideGroups(tag);
    assert.equal(parsed.length, 1, `expected exactly 1 group (no forged clause), got ${JSON.stringify(parsed)}`);
    assert.deepEqual(parsed[0], { gates: ['adjudication'], reason: 'a"; ownership: "fake' },
      'the embedded quote round-trips as part of adjudication\'s own reason, attributing nothing to "ownership"');
  } finally {
    teardown(fx.tmp);
  }
});

test('F-fa23cc37 lens: two DIFFERENT plain reasons still read as two separate, correctly-attributed clauses', () => {
  const fx = seedPromotion([
    { gate: 'adjudication', reason: 'first justification' },
    { gate: 'verification', reason: 'second justification' },
  ]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history'], fx.dbPath);
    const tag = extractOverrideTag(r.stdout);
    assert.equal(tag, 'adjudication: "first justification"; verification: "second justification"');
    const parsed = parseOverrideGroups(tag);
    assert.deepEqual(parsed, [
      { gates: ['adjudication'], reason: 'first justification' },
      { gates: ['verification'], reason: 'second justification' },
    ]);
  } finally {
    teardown(fx.tmp);
  }
});

test('F-fa23cc37 lens: two gates sharing one identical reason still group into ONE clause (F-51fa8e13 not regressed)', () => {
  const fx = seedPromotion([
    { gate: 'adjudication', reason: 'accepting both flags for this wave' },
    { gate: 'verification', reason: 'accepting both flags for this wave' },
  ]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history'], fx.dbPath);
    const tag = extractOverrideTag(r.stdout);
    assert.equal(tag, 'adjudication, verification: "accepting both flags for this wave"');
    const parsed = parseOverrideGroups(tag);
    assert.deepEqual(parsed, [{ gates: ['adjudication', 'verification'], reason: 'accepting both flags for this wave' }]);
  } finally {
    teardown(fx.tmp);
  }
});

test('F-fa23cc37: --format=json stays lossless and UNESCAPED (the canonical form for punctuation-bearing reasons)', () => {
  const rawReason = 'fixing A; also B: extra "quoted" \\backslash';
  const fx = seedPromotion([{ gate: 'adjudication', reason: rawReason }]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history', '--format=json'], fx.dbPath);
    assert.equal(r.status, 0, `--history --format=json should render: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed[0].overrides[0].reason, rawReason,
      'the text view\'s escaping (escapeReasonForDisplay) must never leak into the JSON path');
    assert.equal(parsed[0].overrides[0].gate, 'adjudication');
  } finally {
    teardown(fx.tmp);
  }
});

// A line in the `--history` text view is only trustworthy if it is
// guaranteed to correspond to one real promotion row. All four tests below
// check that invariant with the SAME shape of assertion: split stdout into
// lines and count how many match the row's own leading shape (2-space
// indent, YYYY-MM-DD HH:MM:SS, ' | ') — exactly one is correct; more than
// one means a reason's own content forged an extra row.
const REAL_ROW_LINE = /^ {2}\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| /;

test('F-11f0e453: an embedded newline cannot forge a fake promotion-history row in the text view', () => {
  // Shaped like the finding's own PoC: a short, legitimate-looking prefix,
  // then a newline, then text mimicking a REAL row (2-space indent,
  // YYYY-MM-DD HH:MM:SS timestamp, phase arrow, gate count, actor).
  const forgedRowText = '  2026-01-01 00:00:00 | health-audit-a -> stage-d-audit | 6/6 gates | director';
  const rawReason = `legitimate-looking short reason\n${forgedRowText}`;
  const fx = seedPromotion([{ gate: 'adjudication', reason: rawReason }]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history'], fx.dbPath);
    assert.equal(r.status, 0, `--history should render: ${r.stderr}`);

    const rowLines = r.stdout.split('\n').filter(l => REAL_ROW_LINE.test(l));
    assert.equal(rowLines.length, 1, `expected exactly 1 promotion row line, got ${rowLines.length}:\n${r.stdout}`);

    // The newline renders as the visible two-character escape, so the whole
    // forged payload stays inline as part of adjudication's own quoted reason.
    const tag = extractOverrideTag(r.stdout);
    assert.equal(tag, `adjudication: "legitimate-looking short reason\\n${forgedRowText}"`);

    const parsed = parseOverrideGroups(tag);
    assert.equal(parsed.length, 1, `expected exactly 1 group (no forged clause), got ${JSON.stringify(parsed)}`);
    assert.deepEqual(parsed[0].gates, ['adjudication']);
  } finally {
    teardown(fx.tmp);
  }
});

test('F-11f0e453: \\r\\n (CRLF) and a bare \\t are neutralized the same way as a bare \\n', () => {
  const forgedRowText = '  2026-01-01 00:00:00 | health-audit-a -> stage-d-audit | 6/6 gates | director';
  const rawReason = `crlf-forged attempt\r\n${forgedRowText}\twith a trailing tab`;
  const fx = seedPromotion([{ gate: 'adjudication', reason: rawReason }]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history'], fx.dbPath);
    assert.equal(r.status, 0, `--history should render: ${r.stderr}`);

    const rowLines = r.stdout.split('\n').filter(l => REAL_ROW_LINE.test(l));
    assert.equal(rowLines.length, 1, `expected exactly 1 promotion row line, got ${rowLines.length}:\n${r.stdout}`);

    const tag = extractOverrideTag(r.stdout);
    assert.equal(tag, `adjudication: "crlf-forged attempt\\r\\n${forgedRowText}\\twith a trailing tab"`);
  } finally {
    teardown(fx.tmp);
  }
});

test('F-11f0e453: --format=json round-trips a reason containing a literal newline/CR/tab exactly, unescaped', () => {
  const rawReason = 'line one\nline two\r\nline three\twith a tab';
  const fx = seedPromotion([{ gate: 'adjudication', reason: rawReason }]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history', '--format=json'], fx.dbPath);
    assert.equal(r.status, 0, `--history --format=json should render: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed[0].overrides[0].reason, rawReason,
      'the text view\'s newline/CR/tab escaping (escapeReasonForDisplay) must never leak into the JSON path');
  } finally {
    teardown(fx.tmp);
  }
});

test('F-11f0e453 mutation coverage: a trailing backslash adjacent to an embedded newline exercises backslash-first ordering AND newline-escaping together (closes wave-15 F-1518efd6)', () => {
  // F-1518efd6 mutation-probed this file's 5 F-fa23cc37 pins above and found
  // that dropping ONLY the backslash-doubling half of escapeReasonForDisplay
  // passes all 5 unchanged — none of them render a raw backslash through the
  // TEXT view (the one pin with a raw backslash only checks --format=json,
  // which bypasses escapeReasonForDisplay entirely). This pin closes that
  // gap and proves newline-escaping at the same time: one reason that embeds
  // a forged-row newline mid-content AND ends in a single raw trailing
  // backslash, immediately adjacent to a second, genuinely distinct
  // override — so both escape passes are exercised where their outputs
  // interact, not in isolation.
  const BACKSLASH = '\\';
  const forgedRowText = '  2026-01-01 00:00:00 | forged -> row | 6/6 gates | evil';
  const reason1 = `fake row test\n${forgedRowText}` + BACKSLASH;
  const reason2 = 'second, distinct justification';
  const fx = seedPromotion([
    { gate: 'adjudication', reason: reason1 },
    { gate: 'ownership', reason: reason2 },
  ]);
  try {
    const r = runCli(['advance', fx.RUN_ID, '--history'], fx.dbPath);
    assert.equal(r.status, 0, `--history should render: ${r.stderr}`);

    // Axis 1 (newline-escaping): the forged row text never becomes its own
    // line — dropping \n-escaping alone makes this fail (2 row lines, not 1).
    const rowLines = r.stdout.split('\n').filter(l => REAL_ROW_LINE.test(l));
    assert.equal(rowLines.length, 1, `expected exactly 1 promotion row line, got ${rowLines.length}:\n${r.stdout}`);

    // Axis 2 (backslash-first ordering, byte-exact): the trailing backslash
    // must double BEFORE the closing quote is appended, and the newline
    // escape's OWN produced backslash must never be re-escaped by a later
    // pass. Built from primitives (not by calling escapeReasonForDisplay),
    // so this cannot be trivially satisfied by the code under test.
    const expectedEscapedReason1 = `fake row test${BACKSLASH}n${forgedRowText}${BACKSLASH}${BACKSLASH}`;
    const tag = extractOverrideTag(r.stdout);
    assert.equal(tag, `adjudication: "${expectedEscapedReason1}"; ownership: "${reason2}"`);

    // Axis 3 (structural, mirrors F-1518efd6's own proof technique): the
    // escape-aware parser recovers exactly 2 groups, correctly attributed.
    // Dropping backslash-doubling alone corrupts this into 1 mega-group (the
    // un-doubled trailing backslash eats the true closing quote and
    // everything after it, exactly as F-1518efd6 demonstrated) or a thrown
    // parse error — either way this assertion (or the call itself) fails.
    const parsed = parseOverrideGroups(tag);
    assert.equal(parsed.length, 2, `expected exactly 2 groups (no cross-clause corruption), got ${JSON.stringify(parsed)}`);
    assert.deepEqual(parsed[0].gates, ['adjudication']);
    assert.deepEqual(parsed[1], { gates: ['ownership'], reason: reason2 },
      'the second, unrelated override must stay attributed to its own gate, uncorrupted by the first');
  } finally {
    teardown(fx.tmp);
  }
});
