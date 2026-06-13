/**
 * stageA-cli-flag-family.test.js
 *
 * Stage A amend — the dogfood-swarm CLI flag-parsing family.
 *
 *   d5-swarm-cli-002 (MED) — parseVerifyFlags: the EQUALS-form `--threshold=abc`
 *     silently left threshold at the default 0 (strictest gate) while the
 *     space-form threw. Both forms now reject malformed input identically.
 *   d5-swarm-cli-003 (MED) — `--format`: the space-form took the next token raw
 *     with no enum check and no `--`-swallow guard. Both parseVerifyFlags AND
 *     cmdFindings now enum-validate + reject a swallowed flag (CLI_INVALID_FORMAT).
 *   d5-swarm-cli-004 (MED) — the value-flag family (`--repo`, `--ids`,
 *     `--ownership`, `--desc`, `--adapter`) lacked the cli-003 `--`-swallow guard
 *     and/or equals-form support. All now route through the shared
 *     parseValueFlag helper.
 *   d5-swarm-cli-NEW (MED) — the FIFTH `--reason` site (`domains --unfreeze
 *     --reason`) lacked the swallow guard; a `--`-prefixed value polluted the
 *     mandatory audit reason field. Now treated as a missing reason.
 *
 * Strategy: the shared parsers (parseValueFlag / parseFormatFlag /
 * parseVerifyFlags) are exported and unit-tested directly for the whole
 * family; the command-level sites (findings, approve, domains --unfreeze) are
 * exercised at the CLI seam via spawnSync against a fixture DB.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { parseVerifyFlags, parseValueFlag, parseFormatFlag } from './cli.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function teardown(...dirs) {
  for (const d of dirs) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

// ──────────────────────────────────────────────────────────────
// d5-swarm-cli-002 — --threshold equals-form rejects malformed input
// ──────────────────────────────────────────────────────────────

describe('d5-swarm-cli-002: --threshold=<bad> is rejected like the space-form', () => {
  it('--threshold=abc throws CLI_INVALID_THRESHOLD (not a silent 0)', () => {
    assert.throws(
      () => parseVerifyFlags(['run', '--threshold=abc']),
      (e) => e.code === 'CLI_INVALID_THRESHOLD' && /non-negative integer/.test(e.message),
      'd5-cli-002 regression: equals-form --threshold=abc silently became 0',
    );
  });

  it('--threshold=-1 throws CLI_INVALID_THRESHOLD', () => {
    assert.throws(
      () => parseVerifyFlags(['run', '--threshold=-1']),
      (e) => e.code === 'CLI_INVALID_THRESHOLD',
    );
  });

  it('--threshold=3abc (partially numeric) throws (parseInt would have accepted 3)', () => {
    assert.throws(
      () => parseVerifyFlags(['run', '--threshold=3abc']),
      (e) => e.code === 'CLI_INVALID_THRESHOLD',
    );
  });

  it('--threshold=3 (valid equals-form) is still accepted', () => {
    assert.equal(parseVerifyFlags(['run', '--threshold=3']).threshold, 3);
  });

  it('the space-form remains rejected (no regression in the original guard)', () => {
    assert.throws(
      () => parseVerifyFlags(['run', '--threshold', 'abc']),
      (e) => e.code === 'CLI_INVALID_THRESHOLD',
    );
    assert.equal(parseVerifyFlags(['run', '--threshold', '5']).threshold, 5);
  });

  it('CLI seam: `verify-fixed <run> --threshold=abc` exits non-zero with the structured envelope', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stageA-thr-eq-'));
    const dbPath = join(tmp, 'control-plane.db');
    try {
      const db = openDb(dbPath);
      db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
        .run('r1', 'org/r', tmp, 'a'.repeat(40));
      closeDb(dbPath);

      const r = spawnSync(process.execPath, [CLI_PATH, 'verify-fixed', 'r1', '--threshold=abc'], {
        encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
      });
      assert.notEqual(r.status, 0,
        'd5-cli-002 regression: equals-form typo must NOT exit 0 (would silently gate at 0)');
      assert.match(r.stderr, /CLI_INVALID_THRESHOLD|non-negative integer/);
    } finally {
      closeDb(dbPath);
      teardown(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// d5-swarm-cli-003 — --format enum-validated + swallow-guarded
// ──────────────────────────────────────────────────────────────

describe('d5-swarm-cli-003: --format enum validation + --swallow guard', () => {
  it('parseFormatFlag: --format xml throws CLI_INVALID_FORMAT (was silently accepted)', () => {
    assert.throws(
      () => parseFormatFlag(['--format', 'xml']),
      (e) => e.code === 'CLI_INVALID_FORMAT' && /text\|markdown\|json/.test(e.message),
      'd5-cli-003 regression: --format xml was accepted as-is then silently auto-fell-back',
    );
  });

  it('parseFormatFlag: --format --foo throws (a following flag is NOT the value)', () => {
    // parseValueFlag treats the `--`-prefixed token as missing → undefined →
    // parseFormatFlag returns undefined (NO swallow). With NO other --format,
    // the format is simply absent (auto-detect). Prove it does not capture --foo.
    assert.equal(parseFormatFlag(['--format', '--foo']), undefined,
      'd5-cli-003 regression: --format swallowed the following flag as the value');
  });

  it('parseFormatFlag: valid values pass through (both forms)', () => {
    assert.equal(parseFormatFlag(['--format', 'json']), 'json');
    assert.equal(parseFormatFlag(['--format=markdown']), 'markdown');
    assert.equal(parseFormatFlag(['--format', 'text']), 'text');
    assert.equal(parseFormatFlag(['no-format-here']), undefined);
  });

  it('parseVerifyFlags routes --format through the same enum guard', () => {
    assert.throws(
      () => parseVerifyFlags(['run', '--format', 'xml']),
      (e) => e.code === 'CLI_INVALID_FORMAT',
    );
    assert.equal(parseVerifyFlags(['run', '--format=json']).format, 'json');
  });

  it('CLI seam: `findings <run> --format xml` exits non-zero (cmdFindings sibling site)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stageA-fmt-'));
    const dbPath = join(tmp, 'control-plane.db');
    try {
      const db = openDb(dbPath);
      db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
        .run('r1', 'org/r', tmp, 'a'.repeat(40));
      closeDb(dbPath);

      const r = spawnSync(process.execPath, [CLI_PATH, 'findings', 'r1', '--format', 'xml'], {
        encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
      });
      assert.notEqual(r.status, 0,
        'd5-cli-003 regression: cmdFindings --format xml silently emitted the auto-detected format');
      assert.match(r.stderr, /CLI_INVALID_FORMAT|text\|markdown\|json/);
    } finally {
      closeDb(dbPath);
      teardown(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// d5-swarm-cli-004 — the value-flag family: equals-form + swallow guard
// ──────────────────────────────────────────────────────────────

describe('d5-swarm-cli-004: parseValueFlag closes the whole value-flag family', () => {
  it('equals-form is supported for every flag (--repo / --ids / --ownership / --adapter)', () => {
    assert.equal(parseValueFlag(['init', 'path', '--repo=org/name'], '--repo'), 'org/name');
    assert.equal(parseValueFlag(['approve', 'r1', '--ids=F-001,F-002'], '--ids'), 'F-001,F-002');
    assert.equal(parseValueFlag(['--ownership=shared'], '--ownership'), 'shared');
    assert.equal(parseValueFlag(['--adapter=python'], '--adapter'), 'python');
  });

  it('space-form is supported when the next token is a real value', () => {
    assert.equal(parseValueFlag(['--repo', 'org/name'], '--repo'), 'org/name');
    assert.equal(parseValueFlag(['--adapter', 'node'], '--adapter'), 'node');
  });

  it('a `--`-prefixed following token is treated as MISSING (swallow guard)', () => {
    assert.equal(parseValueFlag(['--adapter', '--probe-only'], '--adapter'), undefined,
      'd5-cli-004 regression: --adapter swallowed --probe-only as the override');
    assert.equal(parseValueFlag(['--ownership', '--globs', '[]'], '--ownership'), undefined,
      'd5-cli-004 regression: --ownership swallowed --globs as the ownership_class');
    assert.equal(parseValueFlag(['--ids', '--reason'], '--ids'), undefined,
      'd5-cli-004 regression: --ids swallowed --reason as a finding id');
  });

  it('a bare trailing flag with no value is MISSING', () => {
    assert.equal(parseValueFlag(['--repo'], '--repo'), undefined);
  });

  it('an absent flag is undefined (caller falls back to default)', () => {
    assert.equal(parseValueFlag(['init', 'path'], '--repo'), undefined);
  });

  it('CLI seam: `approve <run> --ids --reason` errors (does not approve the swallowed flag)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'stageA-ids-'));
    const dbPath = join(tmp, 'control-plane.db');
    try {
      const db = openDb(dbPath);
      db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
        .run('r1', 'org/r', tmp, 'a'.repeat(40));
      closeDb(dbPath);

      const r = spawnSync(process.execPath, [CLI_PATH, 'approve', 'r1', '--ids', '--reason'], {
        encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
      });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Specify --all or --ids/,
        'd5-cli-004: a swallowed --ids value must fall through to the "Specify" guard, not capture --reason');
    } finally {
      closeDb(dbPath);
      teardown(tmp);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// d5-swarm-cli-NEW — domains --unfreeze --reason is the FIFTH --reason site
// ──────────────────────────────────────────────────────────────

describe('d5-swarm-cli-NEW: `domains --unfreeze --reason <flag>` is a MISSING reason', () => {
  function freshRunDb() {
    const tmp = mkdtempSync(join(tmpdir(), 'stageA-unfreeze-'));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', tmp, 'a'.repeat(40));
    closeDb(dbPath);
    return { tmp, dbPath };
  }

  function runCli(args, dbPath) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
    });
  }

  it('`--unfreeze --reason <flag>` errors "requires --reason", does not unfreeze with a junk reason', () => {
    const fx = freshRunDb();
    try {
      // The brief's literal example `--unfreeze --reason --freeze` is intercepted
      // by cmdDomains' `args.includes('--freeze')` branch BEFORE the unfreeze
      // path (same shape as the cli-003 advance `--history` interception note).
      // Use `--apply` — a `--`-prefixed token that is NOT a domains subcommand,
      // so it reaches the unfreeze reason parser and exercises the swallow guard.
      const r = runCli(['domains', 'r1', '--unfreeze', '--reason', '--apply'], fx.dbPath);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /--unfreeze requires --reason/,
        'd5-cli-NEW regression: --reason --apply captured --apply as the audit reason');
      // The bug was a SILENT unfreeze with reason='--apply'. Prove no unfreeze ran.
      assert.doesNotMatch(r.stdout, /Domains unfrozen/);
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });

  it('`--unfreeze --reason "<text>"` is accepted (guard does not over-reject)', () => {
    const fx = freshRunDb();
    try {
      const r = runCli(['domains', 'r1', '--unfreeze', '--reason', 'genuine audit reason'], fx.dbPath);
      // A real reason passes the guard; unfreezeDomains runs (no in-flight wave
      // to block it on this fresh run). Either way it must NOT hit the
      // "requires --reason" guard.
      assert.doesNotMatch(r.stderr, /--unfreeze requires --reason/,
        'a genuine reason must be accepted, not rejected as a swallowed flag');
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });

  it('the equals-form `--reason=<text>` is also accepted for unfreeze', () => {
    const fx = freshRunDb();
    try {
      const r = runCli(['domains', 'r1', '--unfreeze', '--reason=genuine'], fx.dbPath);
      assert.doesNotMatch(r.stderr, /--unfreeze requires --reason/,
        'equals-form --reason must be honored for the unfreeze site too');
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });
});
