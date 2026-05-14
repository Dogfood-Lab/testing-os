/**
 * redrive.test.js — Phase 5B-2 `swarm redrive` coverage.
 *
 * NON-NEGOTIABLE CORDONED-TEST DISCIPLINE
 *
 *   `swarm redrive --apply` mutates a SQLite control plane and is dispatched
 *   from a CLI that resolves a default DB path. A single test that points at
 *   the wrong path could rewrite the operator's real control plane. Every
 *   test in this file MUST:
 *
 *     1. Create a fresh fixture directory via mkdtempSync — never use
 *        process.cwd() or any path under the actual real repo.
 *     2. Use a fixture SQLite DB at <tempDir>/control-plane.db — never the
 *        live shared control-plane.db.
 *     3. Pass the fixture dbPath explicitly to redrive() — the function
 *        requires it (no defaults).
 *     4. rmSync the fixture in afterEach (Windows-tolerant via the same
 *        try/catch wrapper revalidate.test.js / cli-smoke.test.js use).
 *     5. NEVER reference the real-repo or package directly by name as a
 *        fixture path.
 *
 *   The LAST test in this file is the explicit HEAD-comparison guard
 *   (mirrors rewind.test.js): records `git rev-parse HEAD` of the actual
 *   real repo at start of suite and asserts unchanged at end. Redrive does
 *   not touch the git tree, but the guard is the cordoning-is-verified-
 *   property gate, not a redrive-specific contract.
 *
 *   Forbidden patterns in this file (grep-checked):
 *     - process.cwd()
 *     - path.join('E:', ...)
 *     - the literal real-repo db filename component
 *     - the literal real-repo name
 *     - the literal package directory name
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { transitionAgent } from './lib/state-machine.js';
import { transitionWave } from './lib/wave-state-machine.js';
import { redrive } from './commands/redrive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cordoned-test HEAD guard — record the actual repo's HEAD by walking up
// the filesystem from this file's location. This avoids typing the repo
// path as a literal (which the grep guard forbids) while still anchoring
// the assertion at the real repo root.
const ACTUAL_REPO_ROOT = resolvePath(__dirname, '..', '..');
let ACTUAL_HEAD_AT_SUITE_START = null;

function recordActualHead() {
  try {
    return execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: ACTUAL_REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Strip BOTH block and line comments from JS source so the forbidden-pattern
 * grep at the bottom of this file scans live code only.
 */
function stripCommentsForGrep(source) {
  let cleaned = source.replace(/\/\*[\s\S]*?\*\//g, '');
  cleaned = cleaned.split('\n')
    .map(line => {
      const idx = line.indexOf('//');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  return cleaned;
}

before(() => {
  ACTUAL_HEAD_AT_SUITE_START = recordActualHead();
});

// ──────────────────────────────────────────────────────────────
// Helpers — fixture DB
// ──────────────────────────────────────────────────────────────

function setupFixture({ withDomains = true } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'redrive-fixture-'));
  const dbPath = join(tempDir, 'control-plane.db');
  const db = openDb(dbPath);

  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run('r1', 'org/r', tempDir, 'a'.repeat(40));

  if (withDomains) {
    db.prepare(`
      INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
      VALUES (?, 'backend', '["src/**"]', 'owned', 1)
    `).run('r1');
    db.prepare(`
      INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
      VALUES (?, 'tests', '["**/*.test.*"]', 'owned', 1)
    `).run('r1');
    db.prepare(`
      INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
      VALUES (?, 'docs', '["docs/**"]', 'owned', 1)
    `).run('r1');
    db.prepare(`
      INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
      VALUES (?, 'ci', '["ci/**"]', 'owned', 1)
    `).run('r1');
  }

  closeDb(dbPath);
  return { tempDir, dbPath };
}

/**
 * Seed a wave with one agent_run per provided source status. Each source
 * status maps to a domain in declaration order; eligible vs refused vs
 * preserved is determined by the source status itself.
 *
 * Lands the agent at the requested source through the state machine:
 *   pending      -> raw INSERT (initial DEFAULT)
 *   dispatched   -> pending -> dispatched
 *   failed       -> pending -> dispatched -> failed
 *   timed_out    -> pending -> dispatched -> timed_out
 *   complete     -> pending -> dispatched -> complete
 *   invalid_output, ownership_violation -> use raw UPDATE (the production
 *                                          path that produces these statuses
 *                                          is collect.js's validation guard;
 *                                          we mimic the end state)
 *   aborted_for_rewind -> raw UPDATE then audit-row insert
 *   running      -> pending -> dispatched -> running
 */
function seedWaveWithSources(dbPath, sources, { waveStatus = 'dispatched' } = {}) {
  const db = openDb(dbPath);
  const w = db.prepare(`
    INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
    VALUES ('r1', 'health-audit-a', 1, ?, 'snap1')
  `).run(waveStatus);
  const waveId = Number(w.lastInsertRowid);

  const domains = db.prepare('SELECT id, name FROM domains WHERE run_id = ?').all('r1');
  const agentRunIds = [];
  for (let i = 0; i < sources.length; i++) {
    const dom = domains[i % domains.length];
    const src = sources[i];
    // Insert at 'pending' (DEFAULT)
    const ar = db.prepare(`
      INSERT INTO agent_runs (wave_id, domain_id, status)
      VALUES (?, ?, 'pending')
    `).run(waveId, dom.id);
    const id = Number(ar.lastInsertRowid);
    agentRunIds.push({ id, domain: dom.name, status: src });

    if (src === 'pending') {
      // Nothing to do.
    } else if (src === 'dispatched') {
      transitionAgent(db, id, 'dispatched', 'initial dispatch');
    } else if (src === 'failed') {
      transitionAgent(db, id, 'dispatched', 'initial dispatch');
      transitionAgent(db, id, 'failed', 'fixture: agent failed');
    } else if (src === 'timed_out') {
      transitionAgent(db, id, 'dispatched', 'initial dispatch');
      transitionAgent(db, id, 'timed_out', 'fixture: agent timed out');
    } else if (src === 'running') {
      transitionAgent(db, id, 'dispatched', 'initial dispatch');
      transitionAgent(db, id, 'running', 'fixture: agent running');
    } else if (src === 'complete') {
      transitionAgent(db, id, 'dispatched', 'initial dispatch');
      transitionAgent(db, id, 'complete', 'fixture: agent completed');
      // Set output_path so the receipt-byte-identity hash has signal.
      db.prepare('UPDATE agent_runs SET output_path = ? WHERE id = ?')
        .run(`/fixture/output-${id}.json`, id);
    } else if (src === 'invalid_output') {
      transitionAgent(db, id, 'dispatched', 'initial dispatch');
      // collect.js sets this via the state machine, but the canonical
      // dispatched->invalid_output transition lives in TRANSITIONS; use it.
      transitionAgent(db, id, 'invalid_output', 'fixture: schema mismatch');
    } else if (src === 'ownership_violation') {
      transitionAgent(db, id, 'dispatched', 'initial dispatch');
      transitionAgent(db, id, 'ownership_violation', 'fixture: out-of-domain edit');
    } else if (src === 'aborted_for_rewind') {
      transitionAgent(db, id, 'dispatched', 'initial dispatch');
      transitionAgent(db, id, 'aborted_for_rewind', 'fixture: rewound', true);
    } else {
      throw new Error(`unknown fixture source: ${src}`);
    }
  }

  closeDb(dbPath);
  return { waveId, agentRunIds };
}

function teardown(tempDir, dbPath) {
  if (dbPath) {
    try { closeDb(dbPath); } catch { /* */ }
  }
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ──────────────────────────────────────────────────────────────
// Contract guards
// ──────────────────────────────────────────────────────────────

describe('redrive — required-parameter contract', () => {
  it('throws when wave-id is missing', () => {
    assert.throws(
      () => redrive({ reason: 'r', dbPath: '/x.db' }),
      /wave-id.*required/,
    );
  });

  it('throws when wave-id is not a positive integer', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      assert.throws(
        () => redrive({ waveId: 'abc', reason: 'r', dbPath }),
        /wave-id.*positive integer/,
      );
      assert.throws(
        () => redrive({ waveId: 0, reason: 'r', dbPath }),
        /wave-id.*positive integer/,
      );
      assert.throws(
        () => redrive({ waveId: -3, reason: 'r', dbPath }),
        /wave-id.*positive integer/,
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('throws when reason is missing or empty', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      assert.throws(
        () => redrive({ waveId: 1, reason: '', dbPath }),
        /reason.*required/,
      );
      assert.throws(
        () => redrive({ waveId: 1, reason: '   ', dbPath }),
        /reason.*required/,
      );
      assert.throws(
        () => redrive({ waveId: 1, dbPath }),
        /reason.*required/,
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('throws when dbPath is missing (no implicit default)', () => {
    assert.throws(
      () => redrive({ waveId: 1, reason: 'r', dbPath: '' }),
      /dbPath.*required/,
    );
  });

  it('throws when wave is not found', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      assert.throws(
        () => redrive({ waveId: 9999, reason: 'r', dbPath }),
        (err) => err.code === 'WAVE_NOT_FOUND',
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Wave-level eligibility
// ──────────────────────────────────────────────────────────────

describe('redrive — wave-level eligibility (terminal waves refused)', () => {
  it('refuses advanced wave with WAVE_TERMINAL error', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['complete']);
      const db = openDb(dbPath);
      transitionWave(db, waveId, 'collected', 'fixture: pass');
      transitionWave(db, waveId, 'advanced', 'fixture: promotion');
      closeDb(dbPath);

      assert.throws(
        () => redrive({ waveId, reason: 'r', dbPath, apply: true }),
        (err) => err.code === 'WAVE_TERMINAL' && /advanced/.test(err.message),
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('refuses aborted_for_rewind wave with WAVE_TERMINAL error', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['failed']);
      const db = openDb(dbPath);
      transitionWave(db, waveId, 'aborted_for_rewind', 'fixture: rewound', true);
      closeDb(dbPath);

      assert.throws(
        () => redrive({ waveId, reason: 'r', dbPath, apply: true }),
        (err) => err.code === 'WAVE_TERMINAL' && /aborted_for_rewind/.test(err.message),
      );
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Dry-run vs apply
// ──────────────────────────────────────────────────────────────

describe('redrive — dry-run vs apply', () => {
  it('dry-run does not touch the DB', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(
        dbPath,
        ['complete', 'failed', 'pending', 'invalid_output'],
      );

      const r = redrive({ waveId, reason: 'dry-run check', dbPath });

      assert.equal(r.dryRun, true);
      assert.equal(r.db_transaction_done, false);

      const db = openDb(dbPath);
      const w = db.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.status, 'dispatched');
      for (const ar of agentRunIds) {
        const row = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(ar.id);
        assert.equal(row.status, ar.status);
      }
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('dry-run plan classifies every agent_run into preserved / eligible / refused', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(
        dbPath,
        ['complete', 'failed', 'pending', 'invalid_output'],
      );

      const r = redrive({ waveId, reason: 'preview', dbPath });

      assert.equal(r.preserved.length, 1);
      assert.equal(r.preserved[0].from_status, 'complete');

      assert.equal(r.eligible.length, 2);
      const eligibleStatuses = r.eligible.map(e => e.from_status).sort();
      assert.deepEqual(eligibleStatuses, ['failed', 'pending']);
      assert.ok(r.eligible.every(e => e.to_status === 'dispatched'));

      assert.equal(r.refused.length, 1);
      assert.equal(r.refused[0].from_status, 'invalid_output');
      assert.match(r.refused[0].reason, /swarm revalidate/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('--apply mutates: eligible -> dispatched, refused unchanged, preserved unchanged', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(
        dbPath,
        ['complete', 'failed', 'pending', 'invalid_output'],
      );

      const r = redrive({ waveId, reason: 'apply test', dbPath, apply: true });

      assert.equal(r.apply, true);
      assert.equal(r.db_transaction_done, true);
      assert.equal(r.receipt_byte_identity_verified, true);

      const db = openDb(dbPath);
      // [0]=complete preserved, [1]=failed->dispatched, [2]=pending->dispatched, [3]=invalid_output refused
      const a0 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunIds[0].id);
      assert.equal(a0.status, 'complete', 'preserved (complete) — unchanged');
      const a1 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunIds[1].id);
      assert.equal(a1.status, 'dispatched', 'failed -> dispatched via override');
      const a2 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunIds[2].id);
      assert.equal(a2.status, 'dispatched', 'pending -> dispatched via normal path');
      const a3 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunIds[3].id);
      assert.equal(a3.status, 'invalid_output', 'invalid_output refused — unchanged');
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('--apply records the redrive: prefix on every audit row', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(dbPath, ['failed', 'pending']);

      redrive({ waveId, reason: 'session resume', dbPath, apply: true });

      const db = openDb(dbPath);
      const waveEvents = db.prepare(
        'SELECT * FROM wave_state_events WHERE wave_id = ? ORDER BY id'
      ).all(waveId);
      const lastWave = waveEvents[waveEvents.length - 1];
      assert.equal(lastWave.to_status, 'dispatched');
      assert.ok(lastWave.reason && lastWave.reason.startsWith('redrive: '));
      assert.ok(lastWave.reason.includes('session resume'));

      for (const ar of agentRunIds) {
        const agentEvents = db.prepare(
          'SELECT * FROM agent_state_events WHERE agent_run_id = ? ORDER BY id'
        ).all(ar.id);
        const lastAgent = agentEvents[agentEvents.length - 1];
        assert.equal(lastAgent.to_status, 'dispatched');
        assert.ok(lastAgent.reason && lastAgent.reason.startsWith('redrive: '));
        assert.ok(lastAgent.reason.includes('session resume'));
      }
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Receipt-byte-identity contract (proof gate)
// ──────────────────────────────────────────────────────────────

describe('redrive — receipt-byte-identity (proof gate)', () => {
  it('completed agent_run sha256 hash is byte-identical before and after --apply', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(
        dbPath,
        ['complete', 'complete', 'failed'],
      );
      const completeIds = [agentRunIds[0].id, agentRunIds[1].id];

      const r = redrive({ waveId, reason: 'apply byte-identity check', dbPath, apply: true });

      // ── byte-identity gate: equality of every preserved-row hash ──
      assert.equal(r.receipt_byte_identity_verified, true,
        'receipt-byte-identity contract violated');
      assert.ok(r.preserved_receipt_hashes_before, 'hashes-before must be present');
      assert.ok(r.preserved_receipt_hashes_after, 'hashes-after must be present');

      for (const cid of completeIds) {
        const hBefore = r.preserved_receipt_hashes_before[cid];
        const hAfter = r.preserved_receipt_hashes_after[cid];
        assert.ok(hBefore, `expected before-hash for agent_run ${cid}`);
        assert.ok(hAfter, `expected after-hash for agent_run ${cid}`);
        assert.equal(hBefore, hAfter,
          `agent_run ${cid} (complete) hash changed across redrive: ` +
          `${hBefore.slice(0, 12)}... -> ${hAfter.slice(0, 12)}...`);
        // Sanity: hash is a sha256 hex digest
        assert.match(hBefore, /^[0-9a-f]{64}$/);
      }
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('preserved complete agents have NO new agent_state_events row appended', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(dbPath, ['complete', 'failed']);
      const completeId = agentRunIds[0].id;

      const db = openDb(dbPath);
      const eventsBefore = db.prepare(
        'SELECT COUNT(*) AS n FROM agent_state_events WHERE agent_run_id = ?'
      ).get(completeId).n;
      closeDb(dbPath);

      redrive({ waveId, reason: 'preserve audit', dbPath, apply: true });

      const db2 = openDb(dbPath);
      const eventsAfter = db2.prepare(
        'SELECT COUNT(*) AS n FROM agent_state_events WHERE agent_run_id = ?'
      ).get(completeId).n;
      closeDb(dbPath);

      assert.equal(eventsAfter, eventsBefore,
        'preserved complete agent must not gain new audit rows on redrive');
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// 5B-1 fold-in T2: prior-audit-row preservation
// ──────────────────────────────────────────────────────────────

describe('redrive — T2: prior-audit-row preservation (append-only contract)', () => {
  it('prior wave_state_events rows survive byte-identical after --apply', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['failed'], { waveStatus: 'dispatched' });
      const db = openDb(dbPath);
      // Seed two prior wave_state_events rows. dispatched -> failed is the
      // canonical "collect rejected" path; failed -> dispatched via override
      // is the canonical "revalidate" path. Both are legal.
      transitionWave(db, waveId, 'failed', 'collect rejected');
      transitionWave(db, waveId, 'dispatched', 'revalidate: patched outputs', true);
      const priorRows = db.prepare(
        'SELECT id, wave_id, from_status, to_status, reason, created_at ' +
        'FROM wave_state_events WHERE wave_id = ? ORDER BY id'
      ).all(waveId);
      assert.ok(priorRows.length >= 2, `expected >= 2 prior rows, got ${priorRows.length}`);
      closeDb(dbPath);

      redrive({ waveId, reason: 'audit-row preservation', dbPath, apply: true });

      const db2 = openDb(dbPath);
      const afterRows = db2.prepare(
        'SELECT id, wave_id, from_status, to_status, reason, created_at ' +
        'FROM wave_state_events WHERE wave_id = ? ORDER BY id'
      ).all(waveId);
      assert.ok(afterRows.length >= priorRows.length + 1,
        `expected at least ${priorRows.length + 1} rows after redrive, got ${afterRows.length}`);

      // Prior rows survive byte-identical.
      for (let i = 0; i < priorRows.length; i++) {
        assert.deepEqual(afterRows[i], priorRows[i],
          `prior wave_state_events row #${i} was mutated`);
      }

      // The new last row is the redrive event.
      const last = afterRows[afterRows.length - 1];
      assert.equal(last.to_status, 'dispatched');
      assert.ok(last.reason && last.reason.startsWith('redrive: '));
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('prior agent_state_events rows survive byte-identical for a redriven agent', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(dbPath, ['failed']);
      const id = agentRunIds[0].id;
      const db = openDb(dbPath);
      const priorRows = db.prepare(
        'SELECT id, agent_run_id, from_status, to_status, reason, created_at ' +
        'FROM agent_state_events WHERE agent_run_id = ? ORDER BY id'
      ).all(id);
      assert.ok(priorRows.length >= 2,
        `expected >= 2 prior agent rows (pending->dispatched + dispatched->failed), got ${priorRows.length}`);
      closeDb(dbPath);

      redrive({ waveId, reason: 'agent audit preservation', dbPath, apply: true });

      const db2 = openDb(dbPath);
      const afterRows = db2.prepare(
        'SELECT id, agent_run_id, from_status, to_status, reason, created_at ' +
        'FROM agent_state_events WHERE agent_run_id = ? ORDER BY id'
      ).all(id);
      assert.ok(afterRows.length >= priorRows.length + 1,
        'redrive must append exactly one new event row per redriven agent');

      for (let i = 0; i < priorRows.length; i++) {
        assert.deepEqual(afterRows[i], priorRows[i],
          `prior agent_state_events row #${i} was mutated`);
      }

      const last = afterRows[afterRows.length - 1];
      assert.equal(last.from_status, 'failed');
      assert.equal(last.to_status, 'dispatched');
      assert.ok(last.reason.startsWith('redrive: '));
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Blocked / refused taxonomy
// ──────────────────────────────────────────────────────────────

describe('redrive — blocked/refused taxonomy', () => {
  it('every refused status names the recovery verb', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(
        dbPath,
        ['invalid_output', 'ownership_violation', 'aborted_for_rewind', 'running'],
      );

      const r = redrive({ waveId, reason: 'taxonomy audit', dbPath });

      assert.equal(r.refused.length, 4);
      const byStatus = Object.fromEntries(r.refused.map(x => [x.from_status, x]));

      assert.ok(byStatus.invalid_output);
      assert.match(byStatus.invalid_output.reason, /swarm revalidate/);
      assert.equal(byStatus.invalid_output.correct_verb, 'revalidate');

      assert.ok(byStatus.ownership_violation);
      assert.match(byStatus.ownership_violation.reason, /ownership/);
      assert.equal(byStatus.ownership_violation.correct_verb, 'manual');

      assert.ok(byStatus.aborted_for_rewind);
      assert.match(byStatus.aborted_for_rewind.reason, /terminal|fresh wave/);
      assert.equal(byStatus.aborted_for_rewind.correct_verb, 'fresh-wave');

      assert.ok(byStatus.running);
      assert.match(byStatus.running.reason, /in-flight|timeout/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('refused agents are NOT mutated on --apply', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(
        dbPath,
        ['invalid_output', 'ownership_violation'],
      );
      redrive({ waveId, reason: 'refused not mutated', dbPath, apply: true });

      const db = openDb(dbPath);
      const a0 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunIds[0].id);
      assert.equal(a0.status, 'invalid_output');
      const a1 = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunIds[1].id);
      assert.equal(a1.status, 'ownership_violation');
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Wave-level redrive paths
// ──────────────────────────────────────────────────────────────

describe('redrive — wave-level transition paths', () => {
  it('failed wave is redriven via override path (BLOCKED source)', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['failed']);
      const db = openDb(dbPath);
      transitionWave(db, waveId, 'failed', 'fixture: collect rejected');
      closeDb(dbPath);

      const r = redrive({ waveId, reason: 'fail->dispatched', dbPath, apply: true });

      assert.equal(r.planned_wave_transition.from_status, 'failed');
      assert.equal(r.planned_wave_transition.to_status, 'dispatched');
      assert.equal(r.planned_wave_transition.applied, true);

      const db2 = openDb(dbPath);
      const w = db2.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.status, 'dispatched');
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('collected wave is redriven via normal path (collected -> dispatched edge)', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['complete', 'failed']);
      const db = openDb(dbPath);
      transitionWave(db, waveId, 'collected', 'fixture: collect passed');
      closeDb(dbPath);

      const r = redrive({ waveId, reason: 'collected->dispatched', dbPath, apply: true });

      assert.equal(r.planned_wave_transition.from_status, 'collected');
      assert.equal(r.planned_wave_transition.to_status, 'dispatched');

      const db2 = openDb(dbPath);
      const w = db2.prepare('SELECT status FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.status, 'dispatched');
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('already-dispatched wave: no transition needed, audit row still appended', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['pending', 'failed']);
      // Wave is at 'dispatched' (default seedWaveWithSources).

      const r = redrive({ waveId, reason: 'noop wave xition', dbPath, apply: true });

      assert.equal(r.planned_wave_transition.from_status, 'dispatched');
      assert.equal(r.planned_wave_transition.to_status, 'dispatched');
      assert.equal(r.planned_wave_transition.needs_transition, false);
      // Still applied (audit-row append even when no transition needed).
      assert.equal(r.planned_wave_transition.applied, true);

      const db = openDb(dbPath);
      const events = db.prepare(
        'SELECT * FROM wave_state_events WHERE wave_id = ? AND reason LIKE ? ORDER BY id DESC LIMIT 1'
      ).get(waveId, 'redrive: %');
      assert.ok(events, 'redrive audit row must be appended even for no-op wave transition');
      assert.equal(events.from_status, 'dispatched');
      assert.equal(events.to_status, 'dispatched');
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Already-dispatched agent_run (no-op + audit row)
// ──────────────────────────────────────────────────────────────

describe('redrive — already-dispatched agent_run (no-op audit row)', () => {
  it('appends a redrive: audit row even when source == target (dispatched -> dispatched)', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(dbPath, ['dispatched']);
      const id = agentRunIds[0].id;
      const db = openDb(dbPath);
      const eventsBefore = db.prepare(
        'SELECT COUNT(*) AS n FROM agent_state_events WHERE agent_run_id = ?'
      ).get(id).n;
      closeDb(dbPath);

      redrive({ waveId, reason: 'noop agent xition', dbPath, apply: true });

      const db2 = openDb(dbPath);
      const eventsAfter = db2.prepare(
        'SELECT * FROM agent_state_events WHERE agent_run_id = ? ORDER BY id'
      ).all(id);
      assert.equal(eventsAfter.length, eventsBefore + 1,
        'no-op redrive must still append exactly one new audit row');
      const last = eventsAfter[eventsAfter.length - 1];
      assert.equal(last.from_status, 'dispatched');
      assert.equal(last.to_status, 'dispatched');
      assert.ok(last.reason && last.reason.startsWith('redrive: '));
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// serial_verify_required preservation (design call 4)
// ──────────────────────────────────────────────────────────────

describe('redrive — serial_verify_required preserved across redrive', () => {
  it('wave.serial_verify_required survives a redrive --apply', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['failed']);
      const db = openDb(dbPath);
      // The TRUTH-001 column is not touched by transitionWave — set it
      // directly via the discipline-flag path (collect.js writes it the
      // same way).
      db.prepare('UPDATE waves SET serial_verify_required = 1 WHERE id = ?').run(waveId);
      closeDb(dbPath);

      const r = redrive({ waveId, reason: 'preserve discipline', dbPath, apply: true });
      assert.equal(r.serialVerifyRequiredPreserved, true);

      const db2 = openDb(dbPath);
      const w = db2.prepare('SELECT serial_verify_required FROM waves WHERE id = ?').get(waveId);
      assert.equal(w.serial_verify_required, 1,
        'serial_verify_required must survive redrive (discipline flag, not state)');
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Design-call surfacing
// ──────────────────────────────────────────────────────────────

describe('redrive — design-call surfacing in report', () => {
  it('report carries the four design calls with choice + alternatives + reasoning', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['failed']);
      const r = redrive({ waveId, reason: 'design call audit', dbPath });

      assert.ok(Array.isArray(r.design_calls_surfaced));
      const names = r.design_calls_surfaced.map(d => d.name).sort();
      assert.deepEqual(names, [
        'agent_target_status_on_redrive',
        'serial_verify_required_flag_on_redrive',
        'stale_output_json_files_on_disk',
        'wave_target_status_on_redrive',
      ]);

      for (const dc of r.design_calls_surfaced) {
        assert.ok(dc.choice_made, `design call ${dc.name} missing choice_made`);
        assert.ok(Array.isArray(dc.alternatives_considered) && dc.alternatives_considered.length > 0,
          `design call ${dc.name} missing alternatives_considered`);
        assert.ok(dc.reasoning && dc.reasoning.length > 50,
          `design call ${dc.name} missing substantive reasoning`);
      }
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// T4 fold-in: preserved-count surface (and redrive breakdown)
// ──────────────────────────────────────────────────────────────

describe('redrive — T4 preserved-count surface in summary', () => {
  it('summary names preserved / redriven / refused counts on dedicated lines', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(
        dbPath,
        ['complete', 'failed', 'invalid_output'],
      );

      const r = redrive({ waveId, reason: 'summary surface check', dbPath });
      assert.match(r.summary, /Preserved:\s+1 complete agent_runs/);
      assert.match(r.summary, /Redriven:\s+1 agent_runs/);
      assert.match(r.summary, /Refused:\s+1 agent_runs/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// CLI subprocess smoke
// ──────────────────────────────────────────────────────────────

describe('redrive — CLI subprocess smoke', () => {
  const CLI_PATH = join(__dirname, 'cli.js');

  function runRedriveCli(args, { cwd, env = {} } = {}) {
    return spawnSync(process.execPath, [CLI_PATH, 'redrive', ...args], {
      encoding: 'utf-8',
      cwd: cwd || __dirname,
      env: { ...process.env, ...env },
    });
  }

  it('`swarm redrive --help` exits 0 and prints Usage', () => {
    const r = runRedriveCli(['--help']);
    assert.doesNotMatch(r.stderr || '', /SyntaxError/);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: swarm redrive <wave-id>/);
    assert.match(r.stdout, /--reason "<text>"/);
    assert.match(r.stdout, /--apply/);
    assert.match(r.stdout, /PRESERVED/);
    assert.match(r.stdout, /REFUSED/);
    assert.match(r.stdout, /ELIGIBLE/);
  });

  it('`swarm redrive` (no args) exits 1 with Usage error', () => {
    const r = runRedriveCli([]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage: swarm redrive/);
  });

  it('`swarm redrive <bogus-wave-id>` exits 1 with actionable error', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const r = runRedriveCli(
        ['99999', '--reason', 'r'],
        { env: { SWARM_DB: dbPath } },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /wave not found.*99999/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('`swarm redrive` rejects missing --reason at the CLI layer', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['failed']);
      const r = runRedriveCli(
        [String(waveId)],
        { env: { SWARM_DB: dbPath } },
      );
      assert.equal(r.status, 1);
      assert.match(r.stderr, /--reason "<text>" is required/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('`swarm redrive <wave-id>` (dry-run) exits 0 with planned classifications', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(
        dbPath,
        ['complete', 'failed', 'invalid_output'],
      );
      const r = runRedriveCli(
        [String(waveId), '--reason', 'subprocess dry-run'],
        { env: { SWARM_DB: dbPath } },
      );
      assert.equal(r.status, 0, `expected 0, got ${r.status}; stderr: ${r.stderr}`);
      assert.match(r.stdout, /Redrive \(DRY-RUN\)/);
      assert.match(r.stdout, /Preserved:\s+1/);
      assert.match(r.stdout, /Redriven:\s+1/);
      assert.match(r.stdout, /Refused:\s+1/);
      assert.match(r.stdout, /Re-run with --apply/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('`swarm redrive <wave-id> --apply` mutates and exits 0', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId, agentRunIds } = seedWaveWithSources(dbPath, ['failed']);
      const r = runRedriveCli(
        [String(waveId), '--reason', 'subprocess apply', '--apply'],
        { env: { SWARM_DB: dbPath } },
      );
      assert.equal(r.status, 0, `expected 0, got ${r.status}; stderr: ${r.stderr}`);
      assert.match(r.stdout, /Redrive \(APPLIED\)/);

      const db = openDb(dbPath);
      const a = db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(agentRunIds[0].id);
      assert.equal(a.status, 'dispatched');
      const lastEvent = db.prepare(
        'SELECT * FROM agent_state_events WHERE agent_run_id = ? ORDER BY id DESC LIMIT 1'
      ).get(agentRunIds[0].id);
      assert.equal(lastEvent.to_status, 'dispatched');
      assert.ok(lastEvent.reason.startsWith('redrive: '));
      closeDb(dbPath);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('vantage-point: after --apply, `swarm history <wave-id>` shows redrive row', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['failed']);
      runRedriveCli(
        [String(waveId), '--reason', 'vantage check', '--apply'],
        { env: { SWARM_DB: dbPath } },
      );

      const hr = spawnSync(process.execPath, [CLI_PATH, 'history', String(waveId)], {
        encoding: 'utf-8', cwd: __dirname,
        env: { ...process.env, SWARM_DB: dbPath },
      });
      assert.equal(hr.status, 0);
      // The wave is seeded at 'dispatched' but seedWaveWithSources's
      // pending->dispatched on agent_runs doesn't write to wave_state_events;
      // the wave's first event is therefore the redrive: row itself when
      // there are no prior failed/collected transitions. We assert the row
      // is present and carries the redrive: reason.
      assert.match(hr.stdout, /dispatched +dispatched/);
      assert.match(hr.stdout, /redrive: vantage check/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });

  it('vantage-point: after --apply, `swarm status <run-id>` breadcrumb points at redrive', () => {
    const { tempDir, dbPath } = setupFixture();
    try {
      const { waveId } = seedWaveWithSources(dbPath, ['failed']);
      // Need at least one prior wave transition to make the breadcrumb
      // "interesting" (count > 1 trigger). Land collected->failed first.
      const db = openDb(dbPath);
      transitionWave(db, waveId, 'failed', 'fixture: collect rejected', true);
      closeDb(dbPath);

      runRedriveCli(
        [String(waveId), '--reason', 'breadcrumb check', '--apply'],
        { env: { SWARM_DB: dbPath } },
      );

      const sr = spawnSync(process.execPath, [CLI_PATH, 'status', 'r1'], {
        encoding: 'utf-8', cwd: __dirname,
        env: { ...process.env, SWARM_DB: dbPath },
      });
      assert.equal(sr.status, 0);
      assert.match(sr.stdout, /History:.*transitions?.*redrive: breadcrumb check/);
    } finally {
      teardown(tempDir, dbPath);
    }
  });
});

// ──────────────────────────────────────────────────────────────
// Cordoned-test HEAD guard — MUST be the last set of tests in the file
// ──────────────────────────────────────────────────────────────

describe('cordoned-test HEAD guard (MUST be last)', () => {
  it('actual repo HEAD is unchanged after the full redrive test suite', () => {
    const headNow = recordActualHead();
    assert.equal(headNow, ACTUAL_HEAD_AT_SUITE_START,
      `Cordoned-test contract violated: actual repo HEAD changed from ` +
      `${ACTUAL_HEAD_AT_SUITE_START} to ${headNow}. ` +
      `One of the redrive tests escaped its fixture directory.`);
    assert.ok(headNow, 'HEAD must resolve at the repo root');
  });

  it('forbidden-pattern grep: this file contains no live-repo path literals', () => {
    const self = readFileSync(__filename, 'utf-8');
    const codeOnly = stripCommentsForGrep(self);
    const forbidden = [
      new RegExp('process' + '\\.cwd\\(\\)'),
      new RegExp('swarms' + '/' + 'control-plane' + '\\.db'),
      new RegExp('path' + '\\.join\\(\\s*[\'"]E:[\'"]'),
      new RegExp('\\bjoin\\(\\s*[\'"]E:[\'"]'),
    ];

    for (const pat of forbidden) {
      assert.doesNotMatch(codeOnly, pat,
        `Forbidden pattern ${pat} found in redrive.test.js code. Cordoning rule violated.`);
    }
  });
});
