/**
 * stageA-ds-commands-amend.test.js — Stage A AMEND wave, ds-commands domain.
 *
 * Four CONFIRMED, code-verified defects in the dogfood-swarm command layer.
 * Each block names its finding id and is shaped to fail RED against pre-fix
 * HEAD and pass GREEN after the surgical fix.
 *
 *   DS-MUT-001 (HIGH) — collect.js: the ownership-violation file_claims write was
 *     a non-idempotent plain INSERT while the valid-claim write used INSERT OR
 *     IGNORE. On a re-collect that re-processes an agent already holding a
 *     committed violation claim (the `swarm redrive` re-open path), the duplicate
 *     (agent_run_id, file_path) hit UNIQUE and threw INSIDE the loop
 *     db.transaction — rolling back every sibling agent's fresh work and leaving
 *     the wave stuck 'dispatched' and permanently un-collectable.
 *
 *   SCHEMA-A-001 (HIGH) — collect.js: feature-audit outputs carry `priority`, not
 *     `severity`. The collected feature objects reached upsertFindings with
 *     severity=undefined → NULL; findings.severity is TEXT NOT NULL, so INSERT OR
 *     IGNORE silently skipped every row (changes=0). The whole feature pass
 *     persisted zero approvable rows.
 *
 *   advance-exit-0 (MED) — cli.js cmdAdvance printed 'BLOCKED: <verdict>' for a
 *     non-promoted result but never exited non-zero, so a scripted
 *     `swarm advance <run> && swarm dispatch <run> <next>` proceeded past a hard
 *     block. Sibling verbs (cmdVerify cli-p-002, cmdResume B002) already exit 1
 *     on their gate-fail. A HARD block (BLOCK / VERIFY / override-refused) must
 *     exit non-zero; AMEND (an actionable next-step verdict) stays 0.
 *
 *   ds-lib-002 (LOW) — resume.js classified aborted_for_rewind agents as
 *     'complete' because it bucketed on isTerminal(), which includes BOTH
 *     'complete' AND 'aborted_for_rewind'. A rewound wave then reported action
 *     'all_complete' and rendered the aborted agents as [OK], inviting a collect
 *     over a rewound tree.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { resume } from './commands/resume.js';
import { transitionAgent } from './lib/state-machine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, 'cli.js');

function teardown(...dirs) {
  for (const d of dirs) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

// ══════════════════════════════════════════════════════════════════════
// DS-MUT-001 — the violation file_claims write is idempotent under re-collect
// ══════════════════════════════════════════════════════════════════════

describe('DS-MUT-001: a re-collect over a committed ownership violation must not throw', () => {
  const RID = 'r-ds-mut-001';
  let tmp, dbPath, outPath;

  // The agent self-reports editing a file owned by NO domain (unassigned).
  // getActualTouchedFiles is unavailable in a non-git temp dir, so ownership
  // enforcement falls back to the self-reported files_changed — the rogue file
  // is flagged as a violation and its file_claims row is written with
  // violation=1. No git worktree is needed to drive the violation path.
  const ROGUE = 'packages/rogue/x.js';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ds-mut-001-'));
    dbPath = join(tmp, 'control-plane.db');
    outPath = join(tmp, 'backend.json');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RID);
    // Seed a dispatched amend wave with a single agent_run (ownership is only
    // checked for amend phases). Direct seeding mirrors advance.test.js's
    // setupRun and gives full control over the re-open below.
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-amend-a', 1, 'dispatched')"
    ).run(RID);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(RID);
    db.prepare(
      "INSERT INTO agent_runs (wave_id, domain_id, status, started_at) VALUES (?, ?, 'dispatched', datetime('now'))"
    ).run(Number(wave.lastInsertRowid), dom.id);
    closeDb(dbPath);

    writeFileSync(outPath, JSON.stringify({
      domain: 'backend',
      summary: 'self-reported out-of-domain edit',
      fixes: [{ finding_id: 'F-1', description: 'edited a rogue file' }],
      files_changed: [ROGUE],
    }));
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(tmp);
  });

  it('DS-MUT-001: second collect of a re-opened wave does not throw and keeps one violation=1 claim', () => {
    // First collect: the violation is detected and committed.
    const r1 = collect({ runId: RID, dbPath, outputs: { backend: outPath } });
    const a1 = r1.agents.find(a => a.domain === 'backend');
    assert.equal(a1.status, 'ownership_violation',
      'precondition: the self-reported rogue edit must be flagged as a violation');
    assert.ok(r1.violations.some(v => v.file === ROGUE),
      'precondition: the rogue file is in the violations report');

    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    const claimsAfter1 = db.prepare(
      'SELECT violation FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).all(ar.id, ROGUE);
    assert.equal(claimsAfter1.length, 1, 'precondition: exactly one violation claim after the first collect');
    assert.equal(claimsAfter1[0].violation, 1);

    // Simulate the `swarm redrive` re-open: the blocked ownership_violation
    // agent stays put, its schema-valid output.json stays on disk, and the wave
    // flips back to 'dispatched'. The next collect re-enumerates the same agent.
    db.prepare("UPDATE waves SET status = 'dispatched' WHERE run_id = ?").run(RID);

    // Second collect: pre-fix, the plain INSERT re-runs for the same
    // (agent_run_id, file_path) → SQLITE_CONSTRAINT_UNIQUE thrown inside the
    // loop db.transaction → the whole collect rolls back and throws.
    let r2;
    assert.doesNotThrow(() => {
      r2 = collect({ runId: RID, dbPath, outputs: { backend: outPath } });
    }, 'DS-MUT-001 regression: the duplicate violation write must be idempotent, not throw');

    // The violation claim is still a single row with violation=1 (upserted, not
    // duplicated), and the wave completed its transition to 'failed' — proof
    // collect() ran past transitionWave rather than aborting.
    const claimsAfter2 = db.prepare(
      'SELECT violation FROM file_claims WHERE agent_run_id = ? AND file_path = ?'
    ).all(ar.id, ROGUE);
    assert.equal(claimsAfter2.length, 1, 'still exactly one violation claim (no duplicate row)');
    assert.equal(claimsAfter2[0].violation, 1, 'the claim is still marked violation=1');
    assert.equal(r2.agents.find(a => a.domain === 'backend').status, 'ownership_violation',
      'the re-detected violation is reported again');
    const wave = db.prepare('SELECT status FROM waves WHERE run_id = ?').get(RID);
    assert.equal(wave.status, 'failed',
      'the wave reached a terminal transition — it is not stuck dispatched/un-collectable');
  });
});

// ══════════════════════════════════════════════════════════════════════
// SCHEMA-A-001 — feature-audit features persist with severity from priority
// ══════════════════════════════════════════════════════════════════════

describe('SCHEMA-A-001: a feature-audit feature persists as a findings row', () => {
  const RID = 'r-schema-a-001';
  let tmp, dbPath, outPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'schema-a-001-'));
    dbPath = join(tmp, 'control-plane.db');
    outPath = join(tmp, 'backend.json');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RID);
    closeDb(dbPath);
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(tmp);
  });

  it('SCHEMA-A-001: a HIGH-priority feature is inserted (not silently skipped) with severity HIGH', () => {
    dispatch({ runId: RID, phase: 'feature-audit', dbPath, outputDir: tmp });

    // A feature carries `priority`, NOT `severity`. The envelope requires the
    // id to match ^F-[A-Za-z0-9-]+$. Pre-fix, the collected feature reached
    // upsertFindings with severity=undefined → NULL → INSERT OR IGNORE skipped.
    writeFileSync(outPath, JSON.stringify({
      domain: 'backend',
      summary: 'one high-priority feature',
      features: [{
        id: 'F-FEAT-1',
        priority: 'HIGH',
        category: 'missing-feature',
        description: 'add a caching layer',
        scope: ['packages/backend/**'],
        effort: 'medium',
        recommendation: 'wire an LRU',
      }],
    }));

    const report = collect({ runId: RID, dbPath, outputs: { backend: outPath } });
    assert.equal(report.findings.new, 1,
      'SCHEMA-A-001 regression: the feature must persist as one new finding, not be silently discarded');

    const db = openDb(dbPath);
    const rows = db.prepare('SELECT severity, description FROM findings WHERE run_id = ?').all(RID);
    assert.equal(rows.length, 1, 'exactly one findings row persisted for the feature');
    assert.equal(rows[0].severity, 'HIGH',
      'the feature\'s priority is stored as the finding severity (the enum is shared)');
    assert.equal(rows[0].description, 'add a caching layer');
  });
});

// ══════════════════════════════════════════════════════════════════════
// advance-exit-0 — cmdAdvance exit code matches the verdict severity
// ══════════════════════════════════════════════════════════════════════

describe('advance-exit-0: `swarm advance` exit code matches a hard block vs an actionable AMEND', () => {
  const RID = 'r-advance-exit';

  function runCli(args, dbPath) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf-8',
      cwd: __dirname,
      env: { ...process.env, SWARM_DB: dbPath },
    });
  }

  /**
   * Seed a run + one collected/dispatched wave with a single complete agent.
   * `findings` seeds open findings so the finding-severity gate can trip AMEND.
   */
  function seed(prefix, { phase, waveStatus, findings = [] }) {
    const tmp = mkdtempSync(join(tmpdir(), prefix));
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RID);
    const wave = db.prepare(
      'INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, ?, 1, ?)'
    ).run(RID, phase, waveStatus);
    const dom = db.prepare('SELECT id FROM domains WHERE run_id = ?').get(RID);
    db.prepare("INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')")
      .run(Number(wave.lastInsertRowid), dom.id);
    for (const f of findings) {
      db.prepare(`INSERT INTO findings
        (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
        VALUES (?, ?, ?, ?, 'bug', 'needs fix', 'new', 1, 1)`)
        .run(RID, f.id, f.fp, f.severity);
    }
    closeDb(dbPath);
    return { tmp, dbPath };
  }

  it('advance-exit-0: a BLOCK verdict (wave still dispatched) exits non-zero', () => {
    // A dispatched wave fails the wave_status gate → hard BLOCK. Pre-fix the CLI
    // printed BLOCKED and fell off the end at exit 0.
    const fx = seed('advance-block-', { phase: 'health-audit-a', waveStatus: 'dispatched' });
    try {
      const r = runCli(['advance', RID], fx.dbPath);
      assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
      assert.match(r.stdout, /BLOCKED: BLOCK/, 'the human-readable hard block is still printed');
      assert.notEqual(r.status, 0,
        `advance-exit-0 regression: a hard BLOCK must exit non-zero so a scripted \`advance && dispatch\` halts; got ${r.status}\nstdout:\n${r.stdout}`);
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });

  it('advance-exit-0: an AMEND verdict (open HIGH finding in a gated phase) stays at exit 0', () => {
    // collected wave + all agents complete + an open HIGH finding in the
    // finding-gated health-audit-a phase → AMEND, an actionable next step.
    const fx = seed('advance-amend-', {
      phase: 'health-audit-a',
      waveStatus: 'collected',
      findings: [{ id: 'F-1', fp: 'fp-amend-1', severity: 'HIGH' }],
    });
    try {
      const r = runCli(['advance', RID], fx.dbPath);
      assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
      assert.match(r.stdout, /BLOCKED: AMEND/, 'the AMEND verdict is surfaced');
      assert.equal(r.status, 0,
        `advance-exit-0: AMEND is an actionable next-step verdict and must stay at exit 0; got ${r.status}\nstderr:\n${r.stderr}`);
    } finally {
      closeDb(fx.dbPath);
      teardown(fx.tmp);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// ds-lib-002 — resume does not classify aborted_for_rewind as complete
// ══════════════════════════════════════════════════════════════════════

describe('ds-lib-002: resume routes aborted_for_rewind out of the complete bucket', () => {
  const RID = 'r-ds-lib-002';
  let tmp, dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ds-lib-002-'));
    dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RID, [
      { name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RID);
    closeDb(dbPath);
    // dispatch creates wave 1 + agent_run #1 at status 'dispatched'.
    dispatch({ runId: RID, phase: 'health-audit-a', dbPath, outputDir: tmp });
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    teardown(tmp);
  });

  it('ds-lib-002: a wave whose only agent is aborted_for_rewind does NOT classify as all_complete', () => {
    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    // `swarm rewind --apply` writes this terminal status via the override path;
    // dispatched → aborted_for_rewind is a lawful direct transition.
    transitionAgent(db, ar.id, 'aborted_for_rewind', 'forced for ds-lib-002 test');
    closeDb(dbPath);

    const report = resume({ runId: RID, dbPath, outputDir: tmp });

    assert.notEqual(report.action, 'all_complete',
      'ds-lib-002 regression: a rewound wave must not report all_complete (which invites a collect over a rewound tree)');
    assert.equal(report.complete.length, 0,
      'ds-lib-002 regression: an aborted_for_rewind agent must NOT be bucketed as complete');
    assert.ok(Array.isArray(report.rewound) && report.rewound.length === 1,
      'the aborted agent is routed to a distinct rewound bucket');
    assert.equal(report.rewound[0].domain, 'backend');
    assert.equal(report.action, 'rewound',
      'the wave surfaces a distinct rewound action, not the unknown dead-end');
  });

  it('ds-lib-002: `swarm resume` on a rewound wave exits non-zero and renders [RWND], not [OK]', () => {
    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    transitionAgent(db, ar.id, 'aborted_for_rewind', 'forced for ds-lib-002 test');
    closeDb(dbPath);

    const r = spawnSync(process.execPath, [CLI_PATH, 'resume', RID], {
      encoding: 'utf-8', cwd: __dirname, env: { ...process.env, SWARM_DB: dbPath },
    });
    assert.doesNotMatch(r.stderr || '', /SyntaxError/, `cli.js failed to parse:\n${r.stderr}`);
    assert.match(r.stdout, /Action: rewound/, 'the rewound action is surfaced to the operator');
    assert.match(r.stdout, /\[RWND\]/, 'the aborted agent renders under a distinct [RWND] marker');
    assert.doesNotMatch(r.stdout, /\[OK  \] backend/, 'a rewound agent must NOT render as [OK]');
    assert.notEqual(r.status, 0,
      `a rewound wave is not collectable — resume must exit non-zero so \`resume && collect\` halts; got ${r.status}\nstdout:\n${r.stdout}`);
  });

  it('ds-lib-002: a genuinely complete wave still classifies as all_complete', () => {
    const db = openDb(dbPath);
    const ar = db.prepare('SELECT id FROM agent_runs WHERE wave_id = 1').get();
    transitionAgent(db, ar.id, 'complete', 'agent finished');
    closeDb(dbPath);

    const report = resume({ runId: RID, dbPath, outputDir: tmp });
    assert.equal(report.action, 'all_complete',
      'a truly complete wave is unchanged — complete still buckets as complete');
    assert.equal(report.complete.length, 1);
    assert.equal((report.rewound || []).length, 0, 'no rewound agents for a clean complete wave');
  });
});
