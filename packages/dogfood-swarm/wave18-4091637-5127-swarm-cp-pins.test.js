/**
 * wave18-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 18 (health-amend-a) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: package-root `*.test.js` is swarm-cp-tests' glob, but its
 * `ownership_class` is `bridge` (not `owned`) — mirrors wave14's own pin
 * file's documented rationale (see wave14-4091637-5127-swarm-cp-pins.test.js
 * header): no OWNED domain's globs match `packages/dogfood-swarm/*.test.js`
 * (swarm-cp-verbs owns only `commands/**` + `cli.js`), so checkOwnership's
 * bridge fallback grants ANY calling domain a valid claim on this file.
 *
 * F-7c3e91a4 (HIGH, commands/history.js) and F-463c7179 (HIGH,
 * commands/status.js): the wave-16 fix (escapeReasonForDisplay,
 * cli.js:1760-1767 at the time) hardened exactly ONE call site
 * (formatOverrideGroups — `swarm advance --history`'s promotions view,
 * pinned by wave14-4091637-5127-swarm-cp-pins.test.js). Every OTHER
 * reason-rendering site in the package applied ZERO escaping: `swarm
 * history` (F-7c3e91a4), `swarm status`'s breadcrumb (F-463c7179), and the
 * immediate-echo summaries in rewind/redrive/revalidate/clean-claims traced
 * by the same finding's "same root defect recurs elsewhere" section. This
 * wave (a) extracted escapeReasonForDisplay into commands/lib/escape-
 * reason.js — a shared leaf helper, matching the atomic-write.js/
 * log-stage.js precedent in this package's CLAUDE.md — and (b) routed
 * EVERY reason-rendering site in the package through it, including two
 * sites the finding text did not enumerate but this wave's own grep sweep
 * found: `swarm domains --unfreeze`'s immediate echo and `swarm domains
 * --history`'s stored domain_events.reason render (cli.js), plus `swarm
 * receipt`'s state-transitions section (commands/receipt.js).
 *
 * This file pins the CLASS fix, not just the two approved findings: every
 * CLI-reachable render site gets a live subprocess proof that the
 * newline-forgery / ANSI-overwrite primitive is dead and --format=json (or
 * the JSON-serializing sibling path) stays lossless. The companion
 * discipline gate (reason-escaping-discipline.test.js) is the mechanical,
 * ongoing guard against a NEW site shipping unescaped — this file proves
 * TODAY'S fix; that file guards TOMORROW'S regression.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { formatCleanClaims } from './commands/clean-claims.js';
import { formatReceiptMarkdown } from './commands/receipt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function runCli(args, dbPath, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    // rewind resolves its own `cwd` from process.cwd() at the CLI wrapper
    // (cli.js's cmdRewind — the function itself never defaults, by design,
    // so tests can point it at a fixture tree), so the rewind pin below
    // passes its fixture repo's tempDir here — mirroring
    // rewind.test.js's own runRewindCli({ cwd }) helper. Every other verb
    // ignores process.cwd() entirely (path state comes from the DB), so
    // defaulting to __dirname is safe for them.
    cwd: cwd || __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

function teardown(dir) {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows lock lag */ } }
}

// The shared attack payload every finding was proven against: a short,
// legitimate-looking prefix, then a raw newline, then text mimicking a REAL
// `swarm history` row (2-space indent, fixed-width columns, phase-transition
// shape) — byte-perfect enough to be indistinguishable from a genuine row if
// escaping is missing.
const FORGED_ROW_TEXT = 'failed        collected     2026-01-01 00:00:00  ok';
function forgedRowPayload(prefix) {
  return `${prefix}\n${FORGED_ROW_TEXT}`;
}

// The proven ANSI cursor-erase primitive (finding F-7c3e91a4's repro):
// \x1b[1A moves the cursor up one line, \x1b[2K erases it — strictly worse
// than append-only forgery because it can blank a GENUINE line, not just pad
// with a fake one.
const ESC = String.fromCharCode(0x1b);
const ANSI_OVERWRITE_PAYLOAD = `ok${ESC}[1A${ESC}[2KTOTALLY LEGITIMATE`;

// ─────────────────────────────────────────────────────────────────
// F-7c3e91a4 — `swarm history <wave-id>`
// ─────────────────────────────────────────────────────────────────

function seedWaveWithEvents(events) {
  const tmp = mkdtempSync(join(tmpdir(), 'w18-history-'));
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);
  const RUN_ID = 'run-w18-history';
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
     VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
  ).run(RUN_ID, tmp, 'a'.repeat(40));
  const wave = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')`
  ).run(RUN_ID);
  const waveId = Number(wave.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO wave_state_events (wave_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)`
  );
  for (const e of events) insert.run(waveId, e.from, e.to, e.reason);
  closeDb(dbPath);
  return { tmp, dbPath, waveId, RUN_ID };
}

const HISTORY_ROW_LINE = /^dispatched|^failed|^collected/;

describe('F-7c3e91a4: `swarm history <wave-id>` neutralizes the reason-rendering class', () => {
  it('a raw newline plus a column-aligned fake row cannot forge an extra transition row', () => {
    const fx = seedWaveWithEvents([
      { from: 'dispatched', to: 'failed', reason: 'collect: 1 validation error(s)' },
      { from: 'failed', to: 'collected', reason: forgedRowPayload('rewind: ') },
    ]);
    try {
      const r = runCli(['history', String(fx.waveId)], fx.dbPath);
      assert.equal(r.status, 0, `history should render: ${r.stderr}`);

      const rowLines = r.stdout.split('\n').filter((l) => HISTORY_ROW_LINE.test(l));
      assert.equal(rowLines.length, 2,
        `expected exactly 2 real transition rows (the forged 3rd must stay inline), got ${rowLines.length}:\n${r.stdout}`);
      assert.match(r.stdout, /\(2 transitions\)/, 'the honest footer must still say 2, not 3');
      // The escaped newline keeps the forged text inline as part of ONE
      // REASON cell (escape-then-truncate: the escaped 61-char cell exceeds
      // REASON_W=60, so it ends in the truncation ellipsis). Exact substring
      // check (not a hand-spaced regex) against FORGED_ROW_TEXT's own
      // literal column spacing.
      const expectedCell = `rewind: \\n${FORGED_ROW_TEXT}`.slice(0, 57) + '...';
      assert.ok(r.stdout.includes(expectedCell),
        `expected the forged row text to render inline, escaped, as one truncated cell (${JSON.stringify(expectedCell)}):\n${r.stdout}`);
    } finally {
      teardown(fx.tmp);
    }
  });

  it('the proven ANSI cursor-erase payload never emits a raw ESC byte', () => {
    const fx = seedWaveWithEvents([
      { from: 'dispatched', to: 'failed', reason: 'collect: 1 validation error(s)' },
      { from: 'failed', to: 'collected', reason: ANSI_OVERWRITE_PAYLOAD },
    ]);
    try {
      const r = runCli(['history', String(fx.waveId)], fx.dbPath);
      assert.equal(r.status, 0, `history should render: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, /\x1b/,
        'no raw ESC byte may reach stdout — the proven cursor-erase primitive must render as the visible \\x1b escape');
      assert.match(r.stdout, /\\x1b\[1A\\x1b\[2K/, 'the ESC/CSI sequence must render as its visible \\xHH form');
    } finally {
      teardown(fx.tmp);
    }
  });

  it('--format=json stays lossless — the escaped text view never leaks into the machine-readable form', () => {
    const rawReason = forgedRowPayload('legitimate-looking short reason');
    const fx = seedWaveWithEvents([{ from: 'dispatched', to: 'collected', reason: rawReason }]);
    try {
      const r = runCli(['history', String(fx.waveId), '--format=json'], fx.dbPath);
      assert.equal(r.status, 0, `history --format=json should render: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.events[0].reason, rawReason,
        'the text view\'s escaping must never leak into --format=json');
    } finally {
      teardown(fx.tmp);
    }
  });

  it('a legitimate multi-transition wave with plain reasons stays readable (no over-escaping)', () => {
    const fx = seedWaveWithEvents([
      { from: 'dispatched', to: 'failed', reason: 'collect: 2 validation error(s)' },
      { from: 'failed', to: 'collected', reason: 'revalidate: corrected the domain map' },
    ]);
    try {
      const r = runCli(['history', String(fx.waveId)], fx.dbPath);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /collect: 2 validation error\(s\)/);
      assert.match(r.stdout, /revalidate: corrected the domain map/);
      assert.match(r.stdout, /\(2 transitions\)/);
    } finally {
      teardown(fx.tmp);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// F-463c7179 — `swarm status <run-id>` breadcrumb
// ─────────────────────────────────────────────────────────────────

function seedRunWithWaveHistory(events) {
  const tmp = mkdtempSync(join(tmpdir(), 'w18-status-'));
  const dbPath = join(tmp, 'control-plane.db');
  const db = openDb(dbPath);
  const RUN_ID = 'run-w18-status';
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
     VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
  ).run(RUN_ID, tmp, 'a'.repeat(40));
  const wave = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')`
  ).run(RUN_ID);
  const waveId = Number(wave.lastInsertRowid);
  const insert = db.prepare(
    `INSERT INTO wave_state_events (wave_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)`
  );
  for (const e of events) insert.run(waveId, e.from, e.to, e.reason);
  closeDb(dbPath);
  return { tmp, dbPath, waveId, RUN_ID };
}

describe('F-463c7179: `swarm status <run-id>` breadcrumb neutralizes the reason-rendering class', () => {
  it('a raw newline cannot split the ONE breadcrumb line into a forged second line', () => {
    // >1 transition makes summarizeWaveHistory classify this "interesting"
    // so the breadcrumb renders at all.
    const fx = seedRunWithWaveHistory([
      { from: 'dispatched', to: 'failed', reason: 'collect: 1 validation error(s)' },
      { from: 'failed', to: 'collected', reason: forgedRowPayload('rewind: ') },
    ]);
    try {
      const r = runCli(['status', fx.RUN_ID], fx.dbPath);
      assert.equal(r.status, 0, `status should render: ${r.stderr}`);
      const breadcrumbLines = r.stdout.split('\n').filter((l) => l.includes('History:'));
      assert.equal(breadcrumbLines.length, 1, `expected exactly 1 "History:" breadcrumb line, got:\n${r.stdout}`);
      assert.doesNotMatch(r.stdout.split('\n').find((l) => l.includes('History:')), /\n/,
        'the breadcrumb text itself must contain no raw newline');
    } finally {
      teardown(fx.tmp);
    }
  });

  it('a lone embedded double-quote cannot forge a fake trailer clause (reopens F-fa23cc37\'s class)', () => {
    const forgeAttempt = 'revalidate: benign-looking") -- FORGED TRAILER -- ("still-one-string';
    const fx = seedRunWithWaveHistory([
      { from: 'dispatched', to: 'failed', reason: 'collect: 1 validation error(s)' },
      { from: 'failed', to: 'collected', reason: forgeAttempt },
    ]);
    try {
      const r = runCli(['status', fx.RUN_ID], fx.dbPath);
      assert.equal(r.status, 0, `status should render: ${r.stderr}`);
      // The reason's own quotes must be escaped (\") so the true closing
      // quote of the breadcrumb's quoted clause is the ONLY unescaped one.
      // truncateReason (data layer, 60-char budget) runs BEFORE escaping —
      // this reason is 68 raw chars, so the breadcrumb carries the
      // truncated-then-escaped form, not the full string.
      assert.match(r.stdout, /last reason: "revalidate: benign-looking\\"\) -- FORGED TRAILER -- \(\\"still\.\.\."/,
        `expected the embedded quotes to render escaped, not close the clause early:\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, /FORGED TRAILER -- \("still/,
        'an UNESCAPED quote would visually close the clause right before FORGED TRAILER — must never appear');
    } finally {
      teardown(fx.tmp);
    }
  });

  it('--format=json stays lossless for the SAME wave.history.lastReason field the breadcrumb reads', () => {
    // Deliberately longer than the 60-char truncation budget so this test
    // exercises the truncate-then-DON'T-escape data-layer contract
    // unambiguously (a reason sized to land exactly on the boundary would
    // leave that half of the contract unexercised).
    const rawReason = forgedRowPayload('rewind: attempted deep audit override');
    const fx = seedRunWithWaveHistory([
      { from: 'dispatched', to: 'failed', reason: 'x' },
      { from: 'failed', to: 'collected', reason: rawReason },
    ]);
    try {
      const r = runCli(['status', fx.RUN_ID, '--format=json'], fx.dbPath);
      assert.equal(r.status, 0, `status --format=json should render: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      // summarizeWaveHistory truncates at 60 chars but does NOT escape —
      // the JSON path must carry that truncated-but-raw text (including the
      // raw, un-escaped newline), proving the text-view escaping in
      // formatStatus never touched the data layer.
      assert.equal(parsed.waves.current.history.lastReason, rawReason.slice(0, 57) + '...',
        'the JSON path\'s lastReason must stay the lossless (truncated, unescaped) canonical form');
    } finally {
      teardown(fx.tmp);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Immediate-echo sites: rewind / redrive / revalidate / clean-claims /
// domains --unfreeze. Each prints the operator's OWN just-typed --reason
// back within the SAME invocation. Minimal fixtures (dry-run where
// possible) since the goal is proving the render call escapes, not
// re-exercising each verb's full business logic (already covered by
// rewind.test.js / redrive.test.js / revalidate.test.js / clean-claims.test.js).
// ─────────────────────────────────────────────────────────────────

function seedMinimalGitRun(runId) {
  const tempDir = mkdtempSync(join(tmpdir(), 'w18-echo-'));
  execFileSync('git', ['init', '-q', '-b', 'main', tempDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: tempDir });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: tempDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: tempDir });
  writeFileSync(join(tempDir, '.gitignore'), '*.db\n*.db-wal\n*.db-shm\n', 'utf-8');
  writeFileSync(join(tempDir, 'README.md'), '# fixture\n', 'utf-8');
  execFileSync('git', ['add', '.'], { cwd: tempDir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture: initial'], {
    cwd: tempDir,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  });
  execFileSync('git', ['tag', 'swarm-save-w18'], { cwd: tempDir });

  const dbPath = join(tempDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`)
    .run(runId, tempDir, 'a'.repeat(40));
  closeDb(dbPath);
  return { tempDir, dbPath };
}

describe('Immediate-echo sites neutralize the reason-rendering class (F-7c3e91a4 "same root defect recurs elsewhere")', () => {
  it('`swarm rewind --reason` (dry-run): forged-row payload confined to the quoted "Reason would be" clause', () => {
    const fx = seedMinimalGitRun('run-w18-rewind');
    try {
      const payload = forgedRowPayload('rewind attempt');
      const r = runCli(['rewind', 'swarm-save-w18', '--reason', payload], fx.dbPath, { cwd: fx.tempDir });
      assert.equal(r.status, 0, `rewind dry-run should succeed: ${r.stderr}`);
      const lines = r.stdout.split('\n');
      const reasonLines = lines.filter((l) => l.includes('Reason would be:'));
      assert.equal(reasonLines.length, 1, `expected exactly 1 "Reason would be:" line:\n${r.stdout}`);
      assert.match(reasonLines[0], /rewind attempt\\nfailed/, 'the newline must render as the visible \\n escape');
    } finally {
      teardown(fx.tempDir);
    }
  });

  it('`swarm redrive --reason` (dry-run): ANSI payload cannot reach stdout as a raw ESC byte', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w18-redrive-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w18-redrive';
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RUN_ID, tmp, 'a'.repeat(40));
    const wave = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, 'collected')`
    ).run(RUN_ID);
    closeDb(dbPath);
    try {
      const r = runCli(['redrive', String(wave.lastInsertRowid), '--reason', ANSI_OVERWRITE_PAYLOAD], dbPath);
      assert.equal(r.status, 0, `redrive dry-run should succeed: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, /\x1b/, 'no raw ESC byte may reach stdout');
      assert.match(r.stdout, /Reason would be: "redrive: ok\\x1b\[1A\\x1b\[2KTOTALLY LEGITIMATE"/);
    } finally {
      teardown(tmp);
    }
  });

  it('`swarm revalidate --reason` (--apply): the FORMERLY unquoted "Reason:" line now fences and escapes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w18-revalidate-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w18-revalidate';
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RUN_ID, tmp, 'a'.repeat(40));
    db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, 'failed')`
    ).run(RUN_ID);
    closeDb(dbPath);
    try {
      // Points --domain at a domain that doesn't exist for this run, which
      // is refused before any repair — report.repairs stays empty, so the
      // mutation tx never runs, but the summary (with the Reason: line)
      // still renders unconditionally on --apply. Minimal, safe fixture for
      // proving the render call alone.
      const r = runCli([
        'revalidate', RUN_ID,
        '--reason', forgedRowPayload('revalidate attempt'),
        '--domain=nonexistent:/does/not/exist.json',
        '--apply',
      ], dbPath);
      assert.equal(r.status, 0, `revalidate --apply should still exit 0 (a refusal is not a hard failure): ${r.stderr}`);
      assert.match(r.stdout, /Reason: "revalidate attempt\\nfailed/, 'the apply-path Reason: line must now be quote-fenced AND escaped');
    } finally {
      teardown(tmp);
    }
  });

  it('`swarm clean-claims --reason` (--apply, nothing eligible): "Reason recorded" is escaped', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w18-clean-claims-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w18-clean-claims';
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RUN_ID, tmp, 'a'.repeat(40));
    closeDb(dbPath);
    try {
      const r = runCli(['clean-claims', RUN_ID, '--apply', '--reason', ANSI_OVERWRITE_PAYLOAD], dbPath);
      assert.equal(r.status, 0, `clean-claims --apply with nothing eligible should still succeed: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, /\x1b/, 'no raw ESC byte may reach stdout');
      assert.match(r.stdout, /Reason recorded: "clean-claims: ok\\x1b\[1A\\x1b\[2KTOTALLY LEGITIMATE"/);
    } finally {
      teardown(tmp);
    }
  });

  it('`swarm domains --unfreeze --reason`: immediate echo is escaped', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w18-unfreeze-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w18-unfreeze';
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RUN_ID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, RUN_ID);
    closeDb(dbPath);
    try {
      const r = runCli(['domains', RUN_ID, '--unfreeze', '--reason', forgedRowPayload('operator note')], dbPath);
      assert.equal(r.status, 0, `unfreeze should succeed (no active wave): ${r.stderr}`);
      assert.match(r.stdout, /Domains unfrozen for run-w18-unfreeze \(reason: operator note\\nfailed/,
        'the newline in the immediate echo must render as the visible \\n escape');
    } finally {
      teardown(tmp);
    }
  });

  it('`swarm domains --history`: the STORED domain_events.reason (same read-later shape as `swarm history`) is escaped', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w18-domains-history-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w18-domains-history';
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RUN_ID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [{ name: 'backend', globs: ['src/**'], ownership_class: 'owned' }]);
    freezeDomains(db, RUN_ID);
    closeDb(dbPath);

    // First unfreeze for real (writes a genuine domain_events row), THEN
    // insert a SECOND, attacker-shaped row directly — mirrors the finding's
    // own repro method (insert a row matching exactly what the write path
    // persists, then run the real subprocess against it).
    try {
      const unfreeze = runCli(['domains', RUN_ID, '--unfreeze', '--reason', 'legitimate unfreeze'], dbPath);
      assert.equal(unfreeze.status, 0, `precondition unfreeze must succeed: ${unfreeze.stderr}`);

      const db2 = openDb(dbPath);
      const domainId = db2.prepare('SELECT id FROM domains WHERE run_id = ? LIMIT 1').get(RUN_ID).id;
      db2.prepare(
        `INSERT INTO domain_events (domain_id, event_type, reason) VALUES (?, 'file_claims_cleaned', ?)`
      ).run(domainId, forgedRowPayload('clean-claims: forged'));
      closeDb(dbPath);

      const r = runCli(['domains', RUN_ID, '--history'], dbPath);
      assert.equal(r.status, 0, `domains --history should render: ${r.stderr}`);
      assert.doesNotMatch(r.stdout, /\n[^\n]*forged-row-mimic-never-appears-unescaped/, 'sanity: marker string not literally present');
      assert.match(r.stdout, /clean-claims: forged\\nfailed {8}collected/,
        'the stored domain_events.reason newline must render escaped, not split into a forged extra event line');

      // Exactly 4 events: 'created' (saveDomainDraft), 'frozen'
      // (freezeDomains), 'unfrozen' (real), and the injected
      // 'file_claims_cleaned' — the forged row content must NOT count as a
      // 5th (which is exactly what an unescaped raw newline would do).
      const eventLines = r.stdout.split('\n').filter((l) => /^ {2}\d{4}-\d{2}-\d{2}/.test(l));
      assert.equal(eventLines.length, 4, `expected exactly 4 domain_events lines, got ${eventLines.length}:\n${r.stdout}`);
    } finally {
      teardown(tmp);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Direct function-level pins for the two sites this wave found that are
// exported pure render functions with no CLI-reachable text/text-format
// distinction worth a heavier DB-seeded subprocess proof: clean-claims.js's
// evidence-trail echo (requires a full eligible-group + agent_state_events
// chain to reach via the CLI) and receipt.js's state-transitions section
// (requires a fully-collected wave + verification receipt to reach via
// `swarm receipt`). Both call the REAL, unmutated shipped formatter with a
// crafted report/receipt object — same proof shape, lighter fixture.
// ─────────────────────────────────────────────────────────────────

describe('Direct-call pins for the remaining two self-discovered sites', () => {
  it('formatCleanClaims escapes the evidence-trail last_event.reason (agent_state_events, the agent-level twin of wave_state_events)', () => {
    const report = {
      summary: 'Clean-claims (DRY-RUN) — run r1 (org/repo)',
      apply: false,
      eligible: [{
        agent_run_id: 7,
        domain: 'backend',
        wave_number: 4,
        wave_status: 'advanced',
        phase: 'health-amend-a',
        agent_status: 'complete',
        claim_count: 1,
        claims: [{ id: 1, file_path: 'src/x.js', claim_type: 'edit' }],
        evidence: {
          event_count: 2,
          last_event: {
            from_status: 'ownership_violation',
            to_status: 'complete',
            reason: forgedRowPayload('revalidate: corrected'),
            created_at: '2026-07-15 10:00:00',
          },
        },
      }],
      refused: [],
    };
    const text = formatCleanClaims(report);
    assert.doesNotMatch(text, /\n {8}failed {8}collected/, 'the forged row text must not land on its own line');
    assert.match(text, /revalidate: corrected\\nfailed {8}collected/, 'the newline must render as the visible \\n escape');
  });

  it('formatReceiptMarkdown escapes a state-transition reason (agent_state_events surfaced in the markdown receipt)', () => {
    const receipt = {
      run: { id: 'r1', repo: 'org/repo', commit_sha: 'a'.repeat(40), branch: 'main' },
      wave: { id: 1, number: 4, phase: 'health-amend-a', status: 'advanced', domain_snapshot_id: 'x', ownership_probe_degraded: false },
      generated_at: '2026-07-15T10:00:00Z',
      agents: [],
      state_transitions: [
        { domain: 'backend', from: 'ownership_violation', to: 'complete', reason: ANSI_OVERWRITE_PAYLOAD, at: '2026-07-15 10:00:00' },
      ],
      ownership_violations: [],
      findings: { total: 0, by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }, this_wave: { new: 0, recurring: 0, fixed: 0 }, by_status: {} },
      verification: null,
      recommendation: { action: 'ADVANCE', reason: null },
    };
    const text = formatReceiptMarkdown(receipt);
    assert.doesNotMatch(text, /\x1b/, 'no raw ESC byte may land in the markdown receipt');
    assert.match(text, /ok\\x1b\[1A\\x1b\[2KTOTALLY LEGITIMATE/, 'the ANSI payload must render as its visible \\xHH escape form');
  });
});
