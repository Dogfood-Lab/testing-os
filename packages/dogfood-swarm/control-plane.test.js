/**
 * control-plane.test.js — Tests for the swarm control plane.
 *
 * Tests the core data model, domain detection, fingerprinting, ownership,
 * output validation, and command flows.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── DB + Schema ──
import { openMemoryDb } from './db/connection.js';
import { SCHEMA_VERSION } from './db/schema.js';

// ── Domains ──
import {
  saveDomainDraft, freezeDomains, aredomainsFrozen, getDomains, checkOwnership,
} from './lib/domains.js';

// ── Fingerprint ──
import {
  computeFingerprint, classifyFindings, upsertFindings, buildPriorMap,
} from './lib/fingerprint.js';

// ── Output validation ──
import {
  validateAuditOutput, validateFeatureOutput, validateAmendOutput,
} from './lib/output-schema.js';

// ── Templates ──
import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from './lib/templates.js';

// ═══════════════════════════════════════════
// Schema + DB
// ═══════════════════════════════════════════

describe('Schema', () => {
  it('creates all 10 tables + kv', () => {
    const db = openMemoryDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name);

    assert.ok(tables.includes('runs'));
    assert.ok(tables.includes('waves'));
    assert.ok(tables.includes('domains'));
    assert.ok(tables.includes('agent_runs'));
    assert.ok(tables.includes('file_claims'));
    assert.ok(tables.includes('artifacts'));
    assert.ok(tables.includes('findings'));
    assert.ok(tables.includes('finding_events'));
    assert.ok(tables.includes('verification_receipts'));
    assert.ok(tables.includes('kv'));
    db.close();
  });

  it('stores schema version', () => {
    const db = openMemoryDb();
    const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
    assert.equal(row.value, String(SCHEMA_VERSION));
    db.close();
  });

  it('enforces foreign keys', () => {
    const db = openMemoryDb();
    assert.throws(() => {
      db.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
        .run('nonexistent', 'test', 1);
    });
    db.close();
  });
});

// ═══════════════════════════════════════════
// Domains
// ═══════════════════════════════════════════

describe('Domains', () => {
  let db;
  const RUN_ID = 'test-run-001';

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'a'.repeat(40));
  });

  it('saves domain draft (unfrozen)', () => {
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
    ]);

    const domains = getDomains(db, RUN_ID);
    assert.equal(domains.length, 2);
    assert.equal(domains[0].frozen, 0);
    assert.deepEqual(domains[0].globs, ['src/**']);
    db.close();
  });

  it('freezes domains', () => {
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    ]);
    assert.equal(aredomainsFrozen(db, RUN_ID), false);

    freezeDomains(db, RUN_ID);
    assert.equal(aredomainsFrozen(db, RUN_ID), true);
    db.close();
  });

  it('checks ownership — valid edit in own domain', () => {
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
    ]);

    const result = checkOwnership(db, RUN_ID, 'backend', ['src/server.js']);
    assert.equal(result.valid.length, 1);
    assert.equal(result.violations.length, 0);
    db.close();
  });

  it('checks ownership — violation for cross-domain edit', () => {
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
    ]);

    const result = checkOwnership(db, RUN_ID, 'backend', ['tests/test_server.js']);
    assert.equal(result.valid.length, 0);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].actual_owner, 'tests');
    db.close();
  });

  it('checks ownership — shared domain allows all agents', () => {
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'config', globs: ['*.json'], ownership_class: 'shared' },
    ]);

    const result = checkOwnership(db, RUN_ID, 'backend', ['package.json']);
    assert.equal(result.valid.length, 1);
    assert.equal(result.valid[0].reason, 'shared via config');
    db.close();
  });

  it('checks ownership — bridge domain allows crossover', () => {
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'types', globs: ['src/types/**'], ownership_class: 'bridge' },
    ]);

    const result = checkOwnership(db, RUN_ID, 'backend', ['src/types/index.ts']);
    // matches own domain first (src/**)
    assert.equal(result.valid.length, 1);
    db.close();
  });
});

// ═══════════════════════════════════════════
// Fingerprinting
// ═══════════════════════════════════════════

describe('Fingerprint', () => {
  it('produces stable fingerprints for identical findings', () => {
    const f1 = { category: 'bug', file: 'src/server.js', line: 42, symbol: 'handleRequest', description: 'null check' };
    const f2 = { category: 'bug', file: 'src/server.js', line: 42, symbol: 'handleRequest', description: 'null check' };

    assert.equal(computeFingerprint(f1), computeFingerprint(f2));
  });

  it('produces different fingerprints for different files', () => {
    const f1 = { category: 'bug', file: 'src/a.js', line: 10, description: 'issue' };
    const f2 = { category: 'bug', file: 'src/b.js', line: 10, description: 'issue' };

    assert.notEqual(computeFingerprint(f1), computeFingerprint(f2));
  });

  it('normalizes line numbers to 10-line buckets', () => {
    const f1 = { category: 'bug', file: 'src/a.js', line: 42, description: 'issue' };
    const f2 = { category: 'bug', file: 'src/a.js', line: 45, description: 'issue' };
    const f3 = { category: 'bug', file: 'src/a.js', line: 52, description: 'issue' };

    // 42 and 45 are in the same bucket (40-49)
    assert.equal(computeFingerprint(f1), computeFingerprint(f2));
    // 52 is in a different bucket (50-59)
    assert.notEqual(computeFingerprint(f1), computeFingerprint(f3));
  });

  it('handles findings without file/line', () => {
    // Description is intentionally NOT in the fingerprint — see B-BACK-002.
    // Two `docs` findings with the same (category, no file, no line) are the same
    // fingerprint regardless of description. To distinguish them, callers should
    // set rule_id, file, symbol, or line.
    const f1 = { category: 'docs', description: 'README outdated' };
    const f2 = { category: 'docs', description: 'README outdated' };
    const f3 = { category: 'docs', description: 'CHANGELOG missing' };

    assert.equal(computeFingerprint(f1), computeFingerprint(f2));
    // f1 and f3 collapse — both are category=docs with no other identity. To
    // differentiate, give them rule_ids or file paths:
    assert.equal(computeFingerprint(f1), computeFingerprint(f3));

    const f4 = { category: 'docs', file: 'README.md' };
    const f5 = { category: 'docs', file: 'CHANGELOG.md' };
    assert.notEqual(computeFingerprint(f4), computeFingerprint(f5));
  });
});

describe('Finding classification', () => {
  it('classifies new findings', () => {
    const current = [
      { category: 'bug', file: 'a.js', line: 10, description: 'new bug', fingerprint: 'fp-new' },
    ];
    const prior = new Map();

    const result = classifyFindings(current, prior);
    assert.equal(result.new.length, 1);
    assert.equal(result.recurring.length, 0);
    assert.equal(result.fixed.length, 0);
  });

  it('classifies recurring findings', () => {
    const current = [
      { category: 'bug', file: 'a.js', line: 10, description: 'old bug', fingerprint: 'fp-old' },
    ];
    const prior = new Map([['fp-old', { id: 1, status: 'new' }]]);

    const result = classifyFindings(current, prior);
    assert.equal(result.new.length, 0);
    assert.equal(result.recurring.length, 1);
  });

  it('detects fixed findings', () => {
    // Per B-BACK-003: "fixed" requires positive evidence — caller must declare
    // that the current wave's scope covered the prior finding's path.
    const current = [];
    const prior = new Map([
      ['fp-gone', { id: 1, status: 'new', fingerprint: 'fp-gone', file_path: 'src/server.js' }],
    ]);

    const result = classifyFindings(current, prior, { scopePaths: ['src/'] });
    assert.equal(result.fixed.length, 1);
    assert.equal(result.unverified.length, 0);
  });

  it('does not mark deferred findings as fixed', () => {
    const current = [];
    const prior = new Map([['fp-defer', { id: 1, status: 'deferred', fingerprint: 'fp-defer' }]]);

    const result = classifyFindings(current, prior, { scopePaths: ['/'] });
    assert.equal(result.fixed.length, 0);
  });
});

describe('Finding upsert', () => {
  let db;
  const RUN_ID = 'test-run-fp';

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/repo', '/tmp/repo', 'b'.repeat(40));
    db.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
      .run(RUN_ID, 'health-audit-a', 1);
  });

  it('inserts new findings + events', () => {
    const classified = {
      new: [{ fingerprint: 'fp1', severity: 'HIGH', category: 'bug', description: 'test bug' }],
      recurring: [],
      fixed: [],
    };

    const stats = upsertFindings(db, RUN_ID, 1, classified);
    assert.equal(stats.inserted, 1);
    assert.equal(stats.updated, 0);

    const findings = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(RUN_ID);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].status, 'new');

    const events = db.prepare('SELECT * FROM finding_events').all();
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, 'reported');
    db.close();
  });

  it('updates recurring findings', () => {
    // Insert a finding first
    db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, description, status, first_seen_wave, last_seen_wave)
      VALUES (?, 'F-001', 'fp1', 'HIGH', 'bug', 'test', 'new', 1, 1)
    `).run(RUN_ID);

    // Add wave 2
    db.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
      .run(RUN_ID, 'health-audit-a', 2);

    const existing = db.prepare('SELECT * FROM findings WHERE fingerprint = ?').get('fp1');

    const classified = {
      new: [],
      recurring: [{ fingerprint: 'fp1', severity: 'HIGH', category: 'bug', description: 'test', prior: existing }],
      fixed: [],
    };

    const stats = upsertFindings(db, RUN_ID, 2, classified);
    assert.equal(stats.updated, 1);

    const updated = db.prepare('SELECT * FROM findings WHERE fingerprint = ?').get('fp1');
    assert.equal(updated.status, 'recurring');
    assert.equal(updated.last_seen_wave, 2);
    db.close();
  });
});

// ═══════════════════════════════════════════
// Output Validation
// ═══════════════════════════════════════════

describe('Audit output validation', () => {
  it('accepts valid audit output', () => {
    const output = {
      domain: 'backend',
      stage: 'A',
      findings: [
        { id: 'F-001', severity: 'HIGH', category: 'bug', description: 'null check missing', file: 'src/a.js', line: 10 },
      ],
      summary: 'One issue found',
    };
    const result = validateAuditOutput(output);
    assert.equal(result.valid, true);
  });

  it('rejects missing domain', () => {
    const result = validateAuditOutput({ stage: 'A', findings: [], summary: 'ok' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('domain')));
  });

  it('accepts stage D output (Visual Polish)', () => {
    const output = {
      domain: 'frontend',
      stage: 'D',
      findings: [
        { id: 'F-001', severity: 'HIGH', category: 'ux', description: 'no walkthroughs configured', file: 'package.json', line: 130 },
      ],
      summary: 'Stage D pass — first-run welcome missing',
    };
    const result = validateAuditOutput(output);
    assert.equal(result.valid, true, `Stage D output should validate; errors: ${result.errors.join('; ')}`);
  });

  it('rejects invalid severity', () => {
    const result = validateAuditOutput({
      domain: 'backend', stage: 'A', summary: 'x',
      findings: [{ id: 'F-1', severity: 'EXTREME', category: 'bug', description: 'x' }],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('severity')));
  });

  it('rejects invalid category', () => {
    const result = validateAuditOutput({
      domain: 'backend', stage: 'A', summary: 'x',
      findings: [{ id: 'F-1', severity: 'HIGH', category: 'invalid-cat', description: 'x' }],
    });
    assert.equal(result.valid, false);
  });

  it('accepts future-proofing category (Stage B lens from PROTOCOL.md)', () => {
    const result = validateAuditOutput({
      domain: 'backend', stage: 'B', summary: 'ok',
      findings: [{
        id: 'F-1', severity: 'MEDIUM', category: 'future-proofing',
        description: 'hardcoded version in 11 places — needs registry', file: 'src/x.js', line: 5,
      }],
    });
    assert.equal(result.valid, true, `expected valid; got errors: ${result.errors.join('; ')}`);
  });
});

describe('Feature output validation', () => {
  it('accepts valid feature output', () => {
    const result = validateFeatureOutput({
      domain: 'backend',
      features: [
        { id: 'FT-1', priority: 'HIGH', category: 'missing-feature', description: 'needs caching' },
      ],
      summary: 'one feature',
    });
    assert.equal(result.valid, true);
  });

  it('rejects invalid priority', () => {
    const result = validateFeatureOutput({
      domain: 'backend',
      features: [{ id: 'FT-1', priority: 'URGENT', category: 'ux', description: 'x' }],
    });
    assert.equal(result.valid, false);
  });
});

describe('Amend output validation', () => {
  it('accepts valid amend output', () => {
    const result = validateAmendOutput({
      domain: 'backend',
      fixes: [{ finding_id: 'F-001', file: 'src/a.js', description: 'added null check' }],
      files_changed: ['src/a.js'],
      summary: 'fixed one',
    });
    assert.equal(result.valid, true);
  });

  it('rejects missing fixes array', () => {
    const result = validateAmendOutput({ domain: 'backend', files_changed: [] });
    assert.equal(result.valid, false);
  });
});

// ═══════════════════════════════════════════
// Templates
// ═══════════════════════════════════════════

describe('Templates', () => {
  const baseOpts = {
    repoPath: '/tmp/repo',
    repo: 'org/test',
    domainName: 'backend',
    globs: ['src/**'],
    waveNumber: 1,
  };

  it('generates health audit A prompt', () => {
    const prompt = buildAuditPrompt({ ...baseOpts, phase: 'health-audit-a' });
    assert.ok(prompt.includes('Bug/Security Fix'));
    assert.ok(prompt.includes('backend'));
    assert.ok(prompt.includes('src/**'));
    assert.ok(prompt.includes('HARD RULE'));
  });

  it('generates health audit B prompt', () => {
    const prompt = buildAuditPrompt({ ...baseOpts, phase: 'health-audit-b' });
    assert.ok(prompt.includes('Proactive Health'));
    assert.ok(prompt.includes('Defensive coding'));
  });

  it('generates health audit C prompt', () => {
    const prompt = buildAuditPrompt({ ...baseOpts, phase: 'health-audit-c' });
    assert.ok(prompt.includes('Humanization'));
    assert.ok(prompt.includes('Error messages'));
    assert.ok(prompt.includes('Accessibility'));
  });

  it('generates Stage D audit prompt with stage letter D in JSON template', () => {
    const prompt = buildAuditPrompt({ ...baseOpts, phase: 'stage-d-audit' });
    assert.ok(prompt.includes('Visual Polish'));
    assert.ok(prompt.includes('Typography'));
    assert.ok(prompt.includes('Marketplace listing'));
    // Critical: prompt must instruct agent to output stage="D", not stage="AUDIT"
    // (the brittle split('-').pop() pattern was wrong for stage-d-* phases)
    assert.ok(prompt.includes('"stage": "D"'), 'Stage D prompt must instruct output stage="D"');
  });

  it('generates feature audit prompt', () => {
    const prompt = buildFeatureAuditPrompt({ ...baseOpts, phase: 'feature-audit' });
    assert.ok(prompt.includes('Feature Audit'));
    assert.ok(prompt.includes('missing-feature'));
  });

  it('generates amend prompt with findings', () => {
    const prompt = buildAmendPrompt({
      ...baseOpts,
      phase: 'health-amend-a',
      findings: [
        { finding_id: 'F-001', severity: 'HIGH', description: 'null check', file_path: 'src/a.js', line_number: 10, recommendation: 'add guard' },
      ],
    });
    assert.ok(prompt.includes('F-001'));
    assert.ok(prompt.includes('null check'));
    assert.ok(prompt.includes('HARD RULE'));
  });

  it('includes prior context for dedup', () => {
    const prompt = buildAuditPrompt({
      ...baseOpts,
      phase: 'health-audit-a',
      priorContext: '- [fixed] F-001: old bug (src/x.js)',
    });
    assert.ok(prompt.includes('Prior Findings'));
    assert.ok(prompt.includes('F-001'));
  });

  it('throws on unknown phase', () => {
    assert.throws(() => {
      buildAuditPrompt({ ...baseOpts, phase: 'invalid-phase' });
    });
  });
});

// ═══════════════════════════════════════════
// Integration: full wave lifecycle
// ═══════════════════════════════════════════

describe('Wave lifecycle (integration)', () => {
  let db;
  const RUN_ID = 'test-lifecycle';

  beforeEach(() => {
    db = openMemoryDb();

    // Create run
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'org/test', '/tmp/test', 'c'.repeat(40));

    // Create domains
    saveDomainDraft(db, RUN_ID, [
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'tests', globs: ['tests/**'], ownership_class: 'owned' },
      { name: 'config', globs: ['*.json'], ownership_class: 'shared' },
    ]);
    freezeDomains(db, RUN_ID);
  });

  it('full wave: create → dispatch → collect → status', () => {
    // Create wave
    const wave = db.prepare(
      "INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'dispatched')"
    ).run(RUN_ID);

    const domains = getDomains(db, RUN_ID);
    const backendDomain = domains.find(d => d.name === 'backend');
    const testsDomain = domains.find(d => d.name === 'tests');

    // Create agent runs
    db.prepare('INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, ?)')
      .run(wave.lastInsertRowid, backendDomain.id, 'dispatched');
    db.prepare('INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, ?)')
      .run(wave.lastInsertRowid, testsDomain.id, 'dispatched');

    // Simulate agent completion
    db.prepare("UPDATE agent_runs SET status = 'complete' WHERE wave_id = ?")
      .run(wave.lastInsertRowid);

    // Insert findings
    const classified = {
      new: [
        { fingerprint: 'fp-a', severity: 'HIGH', category: 'bug', file: 'src/a.js', line: 10, description: 'null check' },
        { fingerprint: 'fp-b', severity: 'MEDIUM', category: 'quality', file: 'tests/t.js', line: 5, description: 'missing assertion' },
      ],
      recurring: [],
      fixed: [],
    };
    const stats = upsertFindings(db, RUN_ID, Number(wave.lastInsertRowid), classified);
    assert.equal(stats.inserted, 2);

    // Check ownership: backend agent editing test file = violation
    const ownership = checkOwnership(db, RUN_ID, 'backend', ['tests/t.js']);
    assert.equal(ownership.violations.length, 1);

    // Check ownership: backend agent editing config = OK (shared)
    const configOwnership = checkOwnership(db, RUN_ID, 'backend', ['package.json']);
    assert.equal(configOwnership.valid.length, 1);

    // Query findings
    const findings = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(RUN_ID);
    assert.equal(findings.length, 2);

    // Build prior map for next wave
    const priorMap = buildPriorMap(db, RUN_ID);
    assert.equal(priorMap.size, 2);

    db.close();
  });

  it('dedup across waves', () => {
    // Wave 1
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')")
      .run(RUN_ID);

    const classified1 = {
      new: [
        { fingerprint: 'fp-persist', severity: 'HIGH', category: 'bug', description: 'persists', file: 'src/a.js' },
        { fingerprint: 'fp-gone', severity: 'LOW', category: 'quality', description: 'will be fixed', file: 'src/b.js' },
      ],
      recurring: [],
      fixed: [],
    };
    upsertFindings(db, RUN_ID, 1, classified1);

    // Wave 2 — fp-persist recurs, fp-gone is fixed, fp-new appears.
    // Wave 2's scope covers all of src/, so fp-gone (at src/b.js) qualifies as
    // "fixed" by positive evidence rather than "unverified". See B-BACK-003.
    db.prepare("INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 2, 'dispatched')")
      .run(RUN_ID);

    // Patch file_path onto prior rows so the scope check has a path to test.
    db.prepare(`UPDATE findings SET file_path = 'src/a.js' WHERE fingerprint = 'fp-persist'`).run();
    db.prepare(`UPDATE findings SET file_path = 'src/b.js' WHERE fingerprint = 'fp-gone'`).run();

    const priorMap = buildPriorMap(db, RUN_ID);
    const wave2Findings = [
      { fingerprint: 'fp-persist', severity: 'HIGH', category: 'bug', description: 'persists' },
      { fingerprint: 'fp-new', severity: 'MEDIUM', category: 'security', description: 'new issue' },
    ];

    const classified2 = classifyFindings(wave2Findings, priorMap, { scopePaths: ['src/'] });
    assert.equal(classified2.new.length, 1);          // fp-new
    assert.equal(classified2.recurring.length, 1);     // fp-persist
    assert.equal(classified2.fixed.length, 1);         // fp-gone

    const stats = upsertFindings(db, RUN_ID, 2, classified2);
    assert.equal(stats.inserted, 1);
    assert.equal(stats.updated, 1);
    assert.equal(stats.fixed, 1);

    // Verify final state
    const all = db.prepare('SELECT * FROM findings WHERE run_id = ?').all(RUN_ID);
    assert.equal(all.length, 3); // 2 from wave 1 + 1 new from wave 2

    const persisted = all.find(f => f.fingerprint === 'fp-persist');
    assert.equal(persisted.status, 'recurring');
    assert.equal(persisted.last_seen_wave, 2);

    const gone = all.find(f => f.fingerprint === 'fp-gone');
    assert.equal(gone.status, 'fixed');

    const newOne = all.find(f => f.fingerprint === 'fp-new');
    assert.equal(newOne.status, 'new');

    db.close();
  });
});
