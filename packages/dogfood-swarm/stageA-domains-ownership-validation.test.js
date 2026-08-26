/**
 * stageA-domains-ownership-validation.test.js — d5-swarm-cli-004 sibling.
 *
 * editDomain validated ownership_class against {owned,shared,bridge}; addDomain
 * did not, so a literal bad `--ownership` value persisted unvalidated. Pins that
 * addDomain now rejects an invalid ownership_class at the same boundary, accepts
 * the three valid classes, and still allows ownership_class to be omitted.
 *
 * F-0ec571d2 / GitHub #67: also pin the (exclusive?, skipped-at-dispatch?)
 * matrix over every accepted ownership_class. The public-surface / coordinator
 * law needs exactly one class that is exclusive under resolveExclusiveOwner
 * AND skipped at dispatch — today's triad has zero such classes; the merged
 * tree (coordinator present) must have exactly one.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openMemoryDb, openDb, closeDb } from './db/connection.js';
import { STATUS } from './db/schema.js';
import {
  addDomain,
  getDomains,
  saveDomainDraft,
  freezeDomains,
  resolveExclusiveOwner,
} from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';

const RUN_ID = 'stageA-own-validate';

describe('addDomain validates ownership_class (d5-swarm-cli-004)', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  });

  afterEach(() => { try { db.close(); } catch { /* */ } });

  it('rejects an invalid ownership_class (the gap: editDomain guarded, addDomain did not)', () => {
    assert.throws(
      () => addDomain(db, RUN_ID, { name: 'backend', globs: ['src/**'], ownership_class: 'garbage' }),
      /Invalid ownership class/,
      'a bad ownership_class must be rejected at the addDomain boundary',
    );
    // And nothing was persisted — the throw happened before INSERT.
    assert.equal(getDomains(db, RUN_ID).length, 0, 'no domain row persisted on rejection');
  });

  for (const cls of ['owned', 'shared', 'bridge']) {
    it(`accepts the valid ownership_class "${cls}"`, () => {
      assert.doesNotThrow(() => addDomain(db, RUN_ID, { name: `d-${cls}`, globs: ['src/**'], ownership_class: cls }));
      const rows = getDomains(db, RUN_ID);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ownership_class, cls);
    });
  }

  it('omitting ownership_class applies the schema default "owned" (not a NULL-constraint crash)', () => {
    assert.doesNotThrow(() => addDomain(db, RUN_ID, { name: 'nodefault', globs: ['src/**'] }));
    const rows = getDomains(db, RUN_ID);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ownership_class, 'owned', 'omitted ownership_class defaults to "owned" per the schema');
  });
});

describe('ownership_class exclusive × skipped-at-dispatch matrix (F-0ec571d2 / #67)', () => {
  // Prove-red for the missing conjunction: a class that is exclusive under
  // resolveExclusiveOwner AND skipped at dispatch. Bridge stays bridge —
  // this pin does not reclassify swarm-cp-tests.
  const MATRIX_RUN = 'stageA-own-matrix';

  function isExclusive(cls) {
    const name = `zone-${cls}`;
    const owner = resolveExclusiveOwner(
      [{ name, ownership_class: cls, globs: [`${cls}-files/**`] }],
      `${cls}-files/item.js`,
    );
    return owner === name;
  }

  function isSkippedAtDispatch(cls) {
    const tmpDir = mkdtempSync(join(tmpdir(), `own-matrix-${cls}-`));
    const dbPath = join(tmpDir, 'control-plane.db');
    try {
      const db = openDb(dbPath);
      db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
        VALUES (?, ?, ?, ?, 'main', 'pending')`)
        .run(MATRIX_RUN, 'org/repo', '/tmp/repo', 'a'.repeat(40));

      // Always include an owned baseline so DISPATCH_NO_AGENT_DOMAINS cannot
      // fire when measuring a skipped-only class.
      const draft = [
        { name: 'baseline-owned', globs: ['packages/**'], ownership_class: 'owned' },
      ];
      if (cls !== 'owned') {
        draft.push({
          name: `probe-${cls}`,
          globs: [`${cls}-files/**`],
          ownership_class: cls,
        });
      }
      saveDomainDraft(db, MATRIX_RUN, draft);
      freezeDomains(db, MATRIX_RUN);
      closeDb(dbPath);

      const result = dispatch({
        runId: MATRIX_RUN,
        phase: 'health-audit-a',
        dbPath,
        outputDir: tmpDir,
        skipVerify: true,
      });
      const agentNames = (result.agents || []).map(a => a.domain);
      if (cls === 'owned') {
        return !agentNames.includes('baseline-owned');
      }
      return !agentNames.includes(`probe-${cls}`);
    } finally {
      try { closeDb(dbPath); } catch { /* */ }
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
    }
  }

  it('every accepted ownership_class has a known (exclusive, skipped-at-dispatch) pair; exactly one is exclusive AND skipped', () => {
    const accepted = STATUS.ownership_class;
    assert.ok(Array.isArray(accepted) && accepted.length >= 3,
      'STATUS.ownership_class must enumerate the accepted classes');
    for (const required of ['owned', 'shared', 'bridge']) {
      assert.ok(accepted.includes(required), `accepted set must still include "${required}"`);
    }

    const matrix = {};
    for (const cls of accepted) {
      // Acceptance boundary: STATUS and addDomain must agree (core wires both).
      const mem = openMemoryDb();
      mem.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
        .run(`${MATRIX_RUN}-accept`, 'org/repo', '/tmp/repo', 'a'.repeat(40));
      assert.doesNotThrow(
        () => addDomain(mem, `${MATRIX_RUN}-accept`, {
          name: `accept-${cls}`,
          globs: ['src/**'],
          ownership_class: cls,
        }),
        `addDomain must accept STATUS.ownership_class member "${cls}"`,
      );
      mem.close();

      matrix[cls] = {
        exclusive: isExclusive(cls),
        skipped: isSkippedAtDispatch(cls),
      };
    }

    assert.deepEqual(matrix.owned, { exclusive: true, skipped: false },
      'owned must be exclusive and agent-bearing');
    assert.deepEqual(matrix.shared, { exclusive: false, skipped: true },
      'shared must be non-exclusive and skipped at dispatch');
    assert.deepEqual(matrix.bridge, { exclusive: false, skipped: false },
      'bridge must be non-exclusive and agent-bearing (test-first amend waves stay legal)');

    const exclusiveAndSkipped = accepted.filter(
      cls => matrix[cls].exclusive === true && matrix[cls].skipped === true,
    );
    assert.equal(
      exclusiveAndSkipped.length,
      1,
      `exactly one ownership_class must be exclusive AND skipped at dispatch ` +
        `(coordinator / public-surface law); got ${JSON.stringify(exclusiveAndSkipped)} ` +
        `from matrix ${JSON.stringify(matrix)}`,
    );
    if (accepted.includes('coordinator')) {
      assert.equal(exclusiveAndSkipped[0], 'coordinator',
        'when STATUS lists coordinator it must be the exclusive+skipped class');
    }
  });
});
