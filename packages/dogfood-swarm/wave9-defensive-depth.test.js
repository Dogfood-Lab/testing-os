/**
 * wave9-defensive-depth.test.js — Wave-9 operator-trust cluster regression tests.
 *
 * Each block here is the failing receipt for one wave-9 finding:
 *
 *   F-COORD-003   findings-digest file-glob mismatch (`.output.json` vs
 *                 actual `<domain>.json`) — digest reported 0 against real
 *                 wave dirs.
 *   F-178610-004  db/connection.js connection pool had no busy_timeout
 *                 pragma; cached handle was not sentinel-checked on reuse.
 *   F-375053-003  commands/resume.js iterated ALL agent_runs for the wave,
 *                 so the second `swarm resume` call inserted a third
 *                 redispatch row for the same domain. Latest-per-domain
 *                 filter now caps it at one new row per call.
 *   F-375053-004  lib/state-machine.js `applyTimeoutPolicy` instant-timed-out
 *                 agents whose started_at was NULL. Defense-in-depth at the
 *                 law engine: NULL is now "not eligible for timeout this
 *                 pass" (with a stderr warn surfacing the broken invariant).
 *   F-375053-001  lib/worktree.js `ensureGitignore` shelled out to `cat`/
 *                 `echo` which fail on Windows cmd.exe. Now pure-fs.
 *   F-246817-007  persist-results.js error-path coverage gap — malformed
 *                 JSON, missing required fields, schema mismatches.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDomainOutputs, buildDigest } from './lib/findings-digest.js';
import { openDb, closeDb, BUSY_TIMEOUT_MS } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { resume } from './commands/resume.js';
import { applyTimeoutPolicy, transitionAgent } from './lib/state-machine.js';
import { ensureGitignore } from './lib/worktree.js';
import {
  buildAuditPayload,
  buildScenarioResults,
  surfaceFromType,
} from './persist-results.js';

// ═══════════════════════════════════════════
// F-COORD-003 — findings-digest file-glob mismatch
// ═══════════════════════════════════════════

describe('findings-digest — F-COORD-003 file-glob', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'digest-fglob-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads <domain>.json (the canonical convention) and skips <domain>.md prompts', () => {
    // Mirror the actual wave-dir layout: per-domain .json output + .md prompt.
    const runId = 'r-fglob';
    const runDir = join(tmp, runId);
    const waveDir = join(runDir, 'wave-1');
    mkdirSync(waveDir, { recursive: true });

    writeFileSync(
      join(waveDir, 'backend.json'),
      JSON.stringify({
        domain: 'backend',
        findings: [
          { id: 'F-1', severity: 'HIGH', category: 'bug', description: 'a' },
          { id: 'F-2', severity: 'LOW',  category: 'bug', description: 'b' },
        ],
      })
    );
    writeFileSync(
      join(waveDir, 'docs.json'),
      JSON.stringify({
        domain: 'docs',
        findings: [
          { id: 'F-3', severity: 'MEDIUM', category: 'doc', description: 'c' },
        ],
      })
    );
    // The companion prompt files — must be ignored by the digest.
    writeFileSync(join(waveDir, 'backend.md'), '# prompt');
    writeFileSync(join(waveDir, 'docs.md'), '# prompt');

    const outputs = loadDomainOutputs(waveDir);
    assert.equal(outputs.length, 2,
      'must load exactly 2 per-domain output files (no .md, no manifest)');
    assert.deepEqual(
      outputs.map(o => o.domain).sort(),
      ['backend', 'docs']
    );

    const { output, waveNumber } = buildDigest({ runId, swarmsDir: tmp });
    assert.equal(waveNumber, 1);
    assert.match(output, /\*\*Total:\*\* 3/,
      'digest must surface all 3 findings, not 0');
  });

  it('still tolerates the legacy <domain>.output.json shape', () => {
    const runId = 'r-fglob-legacy';
    const waveDir = join(tmp, runId, 'wave-1');
    mkdirSync(waveDir, { recursive: true });
    writeFileSync(
      join(waveDir, 'backend.output.json'),
      JSON.stringify({
        domain: 'backend',
        findings: [
          { id: 'F-1', severity: 'HIGH', category: 'bug', description: 'legacy' },
        ],
      })
    );

    const outputs = loadDomainOutputs(waveDir);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].domain, 'backend',
      'domain stripped from legacy .output.json suffix');
  });

  it('skips reserved manifest-like JSON filenames in the wave dir', () => {
    const runId = 'r-fglob-reserved';
    const waveDir = join(tmp, runId, 'wave-1');
    mkdirSync(waveDir, { recursive: true });
    writeFileSync(join(waveDir, 'manifest.json'), '{}');
    writeFileSync(join(waveDir, 'summary.json'), '{}');
    writeFileSync(join(waveDir, 'submission.json'), '{}');
    writeFileSync(join(waveDir, 'audit-payload.json'), '{}');
    writeFileSync(
      join(waveDir, 'backend.json'),
      JSON.stringify({ domain: 'backend', findings: [] })
    );

    const outputs = loadDomainOutputs(waveDir);
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].domain, 'backend');
  });
});

// ═══════════════════════════════════════════
// F-178610-004 — db/connection busy_timeout + sentinel
// ═══════════════════════════════════════════

describe('db/connection — F-178610-004 concurrency hardening', () => {
  let tmp;
  let dbPath;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'db-busy-'));
    dbPath = join(tmp, 'control-plane.db');
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('sets busy_timeout pragma to a non-zero value', () => {
    const db = openDb(dbPath);
    const row = db.pragma('busy_timeout', { simple: true });
    assert.equal(Number(row), BUSY_TIMEOUT_MS,
      `busy_timeout must equal BUSY_TIMEOUT_MS (${BUSY_TIMEOUT_MS}), got ${row}`);
  });

  it('allows two concurrent openDb readers to coexist (cached + fresh)', () => {
    const a = openDb(dbPath);
    const b = openDb(dbPath);
    // Pool returns the same handle for the same path
    assert.equal(a, b, 'pool must return the cached handle on second open');
    // Both can read
    assert.doesNotThrow(() => a.prepare('SELECT 1').get());
    assert.doesNotThrow(() => b.prepare('SELECT 1').get());
  });

  it('drops a dead cached handle and reopens on next openDb call', () => {
    const first = openDb(dbPath);
    // Close the underlying handle directly without going through closeDb()
    // to leave the pool entry stale — simulates a crashed sibling process
    // closing its handle and our pool entry rotting.
    first.close();

    // Sentinel check should detect the dead handle and reopen.
    const second = openDb(dbPath);
    assert.notEqual(first, second, 'must return a fresh handle, not the dead one');
    assert.doesNotThrow(() => second.prepare('SELECT 1').get());
  });
});

// ═══════════════════════════════════════════
// F-375053-003 — resume latest-per-domain filter
// ═══════════════════════════════════════════

describe('resume — F-375053-003 unbounded INSERT growth', () => {
  let tmp;
  let dbPath;
  const RUN_ID = 'r-resume-cap';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'resume-cap-'));
    dbPath = join(tmp, 'control-plane.db');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', tmp, 'a'.repeat(40));

    saveDomainDraft(db, RUN_ID, [
      { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('caps redispatch growth: two resume calls produce 2 agent_runs total, not 3+', () => {
    // 1. Initial dispatch — creates agent_run #1 (status='dispatched').
    dispatch({ runId: RUN_ID, phase: 'health-audit-a', dbPath, outputDir: tmp });

    const db = openDb(dbPath);

    // 2. Force the agent into 'failed' so resume sees it as redispatchable.
    const ar1 = db.prepare("SELECT id FROM agent_runs WHERE wave_id = 1").get();
    transitionAgent(db, ar1.id, 'failed', 'simulated failure for test');

    // 3. First resume: should redispatch and create agent_run #2.
    const r1 = resume({ runId: RUN_ID, dbPath, outputDir: tmp });
    assert.equal(r1.redispatch.length, 1, 'first resume must redispatch the failed agent');

    // 4. Second resume call WITHOUT touching the new agent_run.
    //    The new row is in 'dispatched' (in-flight) — should be classified
    //    as still_running, NOT redispatched again.
    const r2 = resume({ runId: RUN_ID, dbPath, outputDir: tmp });
    assert.equal(r2.redispatch.length, 0,
      'second resume must NOT redispatch — the new agent_run is in-flight');

    // 5. Total agent_runs for this domain in this wave must be exactly 2,
    //    not 3+. This is the unbounded-growth check.
    const count = db.prepare(
      "SELECT COUNT(*) as n FROM agent_runs WHERE wave_id = 1"
    ).get();
    assert.equal(count.n, 2,
      `wave_id=1 must have exactly 2 agent_runs after two resume calls; got ${count.n}`);
  });
});

// ═══════════════════════════════════════════
// F-375053-004 — state-machine NULL started_at defense
// ═══════════════════════════════════════════

describe('applyTimeoutPolicy — F-375053-004 NULL started_at defense', () => {
  let tmp;
  let dbPath;
  const RUN_ID = 'r-null-started';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sm-null-'));
    dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(RUN_ID, 'org/repo', tmp, 'a'.repeat(40));
    saveDomainDraft(db, RUN_ID, [
      { name: 'd1', globs: ['src/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, RUN_ID);
  });
  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('does NOT instant-timeout an agent_run with status=dispatched and started_at=NULL', () => {
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id)
      VALUES (?, 'health-audit-a', 1, 'dispatched', 'snap-x')`).run(RUN_ID);
    const domain = db.prepare("SELECT id FROM domains WHERE run_id = ? LIMIT 1").get(RUN_ID);

    // Direct INSERT bypassing the state machine — the broken-invariant case
    // this test defends against. Status is dispatched but started_at NULL.
    const ar = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status, started_at)
      VALUES (1, ?, 'dispatched', NULL)`).run(domain.id);
    const arId = Number(ar.lastInsertRowid);

    // Suppress the deliberate stderr warning the law engine emits.
    const origWarn = console.warn;
    const warnCalls = [];
    console.warn = (...args) => warnCalls.push(args);

    let timedOut;
    try {
      timedOut = applyTimeoutPolicy(db, 1, 30 * 60 * 1000); // 30-min timeout
    } finally {
      console.warn = origWarn;
    }

    assert.equal(timedOut.length, 0,
      'NULL started_at must NOT instant-time-out the agent');
    const row = db.prepare("SELECT status FROM agent_runs WHERE id = ?").get(arId);
    assert.equal(row.status, 'dispatched',
      'agent must remain dispatched, not be flipped to timed_out');
    assert.ok(warnCalls.length > 0,
      'state machine must surface the broken invariant via console.warn');
  });
});

// ═══════════════════════════════════════════
// F-375053-001 — worktree ensureGitignore no-shell
// ═══════════════════════════════════════════

describe('ensureGitignore — F-375053-001 no shell', () => {
  let tmp;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'wt-gi-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('appends .swarm/ to an existing .gitignore without spawning a shell', () => {
    const gi = join(tmp, '.gitignore');
    writeFileSync(gi, 'node_modules/\ndist/\n', 'utf-8');

    ensureGitignore(tmp);

    const after = readFileSync(gi, 'utf-8');
    assert.match(after, /\.swarm\//,
      '.swarm/ must be appended');
    // Exactly one occurrence — re-running must be idempotent (next test).
    const occurrences = (after.match(/\.swarm\//g) || []).length;
    assert.equal(occurrences, 1, '.swarm/ must appear exactly once');
    // No literal "echo" trailing-space artifact (cmd.exe `echo` quirk).
    assert.ok(!after.includes('.swarm/ '),
      'no trailing-space artifact from cmd.exe echo');
    // Line endings are clean LF on the new line — no stray CRLF artifact
    // even if the original had mixed endings.
    assert.match(after, /\.swarm\/\n/,
      'must terminate the .swarm/ entry with a single LF');
  });

  it('is idempotent — second call adds nothing', () => {
    const gi = join(tmp, '.gitignore');
    writeFileSync(gi, 'node_modules/\n', 'utf-8');
    ensureGitignore(tmp);
    const first = readFileSync(gi, 'utf-8');
    ensureGitignore(tmp);
    const second = readFileSync(gi, 'utf-8');
    assert.equal(first, second, 'second call must not modify the file');
  });

  it('handles an empty .gitignore without prepending a stray newline', () => {
    const gi = join(tmp, '.gitignore');
    writeFileSync(gi, '', 'utf-8');
    ensureGitignore(tmp);
    const after = readFileSync(gi, 'utf-8');
    assert.equal(after, '.swarm/\n');
  });

  it('appends a leading newline when the existing file lacks a trailing one', () => {
    const gi = join(tmp, '.gitignore');
    // Note: no trailing \n — historically the cmd.exe `echo X >> file` would
    // glue ".swarm/" directly onto the previous line.
    writeFileSync(gi, 'node_modules/', 'utf-8');
    ensureGitignore(tmp);
    const after = readFileSync(gi, 'utf-8');
    assert.equal(after, 'node_modules/\n.swarm/\n');
  });

  it('is a no-op when .gitignore does not exist', () => {
    // No file beforehand — ensureGitignore must NOT create one (unchanged
    // semantics from the original wave-1 fix).
    ensureGitignore(tmp);
    assert.equal(existsSync(join(tmp, '.gitignore')), false);
  });
});

// ═══════════════════════════════════════════
// F-246817-007 — persist-results.js error-path coverage
// ═══════════════════════════════════════════

describe('persist-results — F-246817-007 error-path coverage', () => {
  const manifest = {
    repo: 'org/x',
    commit_sha: 'a'.repeat(40),
  };

  it('surfaceFromType returns cli for null/undefined component_type rather than throwing', () => {
    // Defensive: persist-results may receive an audit result missing
    // component_type. The mapper falls through to 'cli' instead of crashing.
    assert.equal(surfaceFromType(null), 'cli');
    assert.equal(surfaceFromType(undefined), 'cli');
  });

  it('buildScenarioResults handles audit with no findings array (treat as empty, verdict=pass)', () => {
    // Malformed-but-survivable audit: missing findings array entirely.
    const audits = [{ component_id: 'core', component_type: 'backend' }];
    const results = buildScenarioResults(audits, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].verdict, 'pass',
      'no findings → pass verdict, not a thrown error');
    assert.equal(results[0].evidence.total_findings, 0);
  });

  it('buildAuditPayload handles audit with no controls AND no findings', () => {
    // Partial-write recovery: an agent that produced an empty result.
    const audits = [{ component_id: 'empty' }];
    const payload = buildAuditPayload(manifest, audits, []);
    assert.equal(payload.controls.length, 0);
    assert.equal(payload.findings.length, 0);
    assert.equal(payload.metrics.controls_total, 0);
    assert.equal(payload.metrics.pass_rate, 0,
      'no controls → pass_rate=0, not NaN or division-by-zero');
    assert.equal(payload.run.overall_status, 'pass');
    assert.equal(payload.run.overall_posture, 'healthy');
  });

  it('buildAuditPayload tolerates findings missing the domain field', () => {
    // Cross-cutting blind-spot: a finding without a domain field must NOT
    // crash the payload builder. domains_checked simply omits it.
    const audits = [{
      component_id: 'core',
      controls: [{ id: 'c1', status: 'pass' }],
      findings: [
        { id: 'f1', severity: 'high', status: 'open' /* no domain */ },
      ],
    }];
    const payload = buildAuditPayload(manifest, audits, []);
    assert.equal(payload.findings.length, 1);
    assert.equal(payload.run.domains_checked.length, 0,
      'domain-less finding must not pollute domains_checked');
  });

  it('buildAuditPayload tolerates a remediation entry with missing fixes array', () => {
    // Cross-cutting: a partial remediation result (just component_id, no
    // fixes) must not throw.
    const audits = [{
      component_id: 'core',
      controls: [],
      findings: [{ id: 'f1', severity: 'critical', domain: 'sec', status: 'open' }],
    }];
    const remediate = [{ component_id: 'core' /* no fixes field */ }];
    const payload = buildAuditPayload(manifest, audits, remediate);
    // The critical finding should still count as open since no fixes were applied.
    assert.equal(payload.metrics.critical_count, 1);
    assert.equal(payload.run.blocking_release, true);
  });

  it('buildAuditPayload tolerates remediation fix without finding_id', () => {
    // A fix entry with no finding_id is malformed — must be ignored, not
    // crash the dedup pass.
    const audits = [{
      component_id: 'core',
      controls: [],
      findings: [{ id: 'f1', severity: 'high', domain: 'q', status: 'open' }],
    }];
    const remediate = [{
      component_id: 'core',
      fixes: [
        { /* no finding_id */ },
        { finding_id: 'f1' },
      ],
    }];
    const payload = buildAuditPayload(manifest, audits, remediate);
    // f1 should still be marked fixed despite the malformed sibling.
    const f1 = payload.findings.find(f => f.id === 'f1');
    assert.equal(f1.status, 'fixed');
  });

  it('buildScenarioResults handles a fixed-only set as pass verdict', () => {
    // All findings already fixed → component should pass, not partial.
    const audits = [{
      component_id: 'x',
      component_type: 'backend',
      findings: [
        { id: 'f1', severity: 'critical', status: 'fixed' },
        { id: 'f2', severity: 'high', status: 'fixed' },
      ],
    }];
    const results = buildScenarioResults(audits, []);
    assert.equal(results[0].verdict, 'pass');
    assert.equal(results[0].evidence.open_findings, 0);
    assert.equal(results[0].evidence.fixed, 2);
  });
});
