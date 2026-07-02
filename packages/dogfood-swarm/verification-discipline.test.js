/**
 * verification-discipline.test.js — Phase 2-B verification-discipline slice.
 *
 * Three independent assertions:
 *
 *   Item 5 (Serial final verification)
 *     - `swarm dispatch --skip-verify` appends the SKIP_VERIFY_DIRECTIVE to
 *       amend prompts (audit prompts are unaffected — they don't run tests).
 *     - When an agent JSON carries `verification_skipped: true`, `swarm
 *       collect` propagates that into `report.serial_verify_required` so the
 *       CLI can surface the Next-step hint.
 *
 *   VD-NEW-1 (files_changed independent diff cross-check)
 *     - Ownership runs against the union of agent self-reported `files_changed`
 *       AND the independently-computed touched-file set from
 *       `lib/git-touched-files.js`. An agent that under-reports `files_changed`
 *       cannot bypass ownership enforcement.
 *
 *   VD-NEW-1 helper unit
 *     - `diffReportedVsActual` reports symmetric divergences in both
 *       directions (missing_from_report and extra_in_report).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { buildReceipt } from './commands/receipt.js';
import { renderProbeDegradedAgents } from './cli.js';
import {
  getActualTouchedFiles,
  diffReportedVsActual,
} from './lib/git-touched-files.js';

/**
 * Capture every console.error line produced during fn(), then restore.
 * Mirrors the helper in stageC-swarm-cli-operator-signal.test.js — used to
 * assert the structured logStage NDJSON event (a RENDER/event path, not just
 * the returned object field).
 */
function captureStderrLines(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.map(String).join(' ')); };
  let result;
  try { result = fn(); } finally { console.error = orig; }
  return { result, lines };
}

function ndjsonEvents(lines) {
  const out = [];
  for (const ln of lines) {
    if (!ln.startsWith('{')) continue;
    try {
      const obj = JSON.parse(ln);
      if (obj && obj.stage) out.push(obj);
    } catch { /* not NDJSON */ }
  }
  return out;
}

const RUN_ID = 'test-verification-discipline';

function setupRun(dbPath, repoPath) {
  const db = openDb(dbPath);

  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
    VALUES (?, ?, ?, ?, 'main', 'pending')`)
    .run(RUN_ID, 'org/repo', repoPath, 'a'.repeat(40));

  saveDomainDraft(db, RUN_ID, [
    { name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' },
    { name: 'domain-b', globs: ['packages/b/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, RUN_ID);

  // Approved findings so the amend dispatch has real work.
  const insert = db.prepare(`INSERT INTO findings
    (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
     description, recommendation, status)
    VALUES (?, ?, ?, ?, 'quality', ?, ?, ?, ?, 'approved')`);
  insert.run(RUN_ID, 'F-A-001', 'fp-a-1', 'HIGH',
    'packages/a/src/foo.js', 10, 'A finding', 'fix A1');
  insert.run(RUN_ID, 'F-B-001', 'fp-b-1', 'HIGH',
    'packages/b/src/baz.js', 20, 'B finding', 'fix B1');

  return db;
}

describe('Item 5 — `swarm dispatch --skip-verify` appends parallel-wave directive to amend prompts', () => {
  let tmpDir, dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-dispatch-'));
    dbPath = join(tmpDir, 'control-plane.db');
    setupRun(dbPath, '/tmp/repo');
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends the SKIP_VERIFY_DIRECTIVE when skipVerify=true on an amend wave', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
      skipVerify: true,
    });

    assert.equal(result.agents.length, 2);

    for (const a of result.agents) {
      const prompt = readFileSync(a.promptPath, 'utf-8');
      assert.match(prompt, /Verification discipline \(parallel-wave\)/,
        `${a.domain}: directive header missing`);
      assert.match(prompt, /Do NOT run per-agent verification/,
        `${a.domain}: imperative missing`);
      assert.match(prompt, /verification_skipped.*true/,
        `${a.domain}: contract field missing`);
    }
  });

  it('omits the SKIP_VERIFY_DIRECTIVE when skipVerify is unset', () => {
    const result = dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });

    for (const a of result.agents) {
      const prompt = readFileSync(a.promptPath, 'utf-8');
      assert.doesNotMatch(prompt, /Verification discipline \(parallel-wave\)/,
        `${a.domain}: directive leaked into a non-skip-verify wave`);
    }
  });
});

describe('Item 5 — `swarm collect` propagates verification_skipped into serial_verify_required', () => {
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-collect-'));
    dbPath = join(tmpDir, 'control-plane.db');
    // Real git repo so getActualTouchedFiles() works; the touched-file probe
    // is exercised in the VD-NEW-1 block, but collect.js still runs it on
    // every amend agent and we don't want it to silently degrade here.
    repoPath = join(tmpDir, 'repo');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'README.md'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });

    setupRun(dbPath, repoPath);
    // Dispatch the amend wave so agent_runs exist.
    dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
      skipVerify: true,
    });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets serial_verify_required when any agent JSON carries verification_skipped:true', () => {
    // Both agents skipped verify per the discipline.
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'skipped',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: [],
      verification_skipped: true,
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'skipped',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
      verification_skipped: true,
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    assert.equal(report.serial_verify_required, true,
      'serial_verify_required must be set when agents skip verify');
    const aReport = report.agents.find(r => r.domain === 'domain-a');
    assert.equal(aReport.verification_skipped, true,
      'per-agent verification_skipped must surface on the agent report');
  });

  it('leaves serial_verify_required=false when no agent skipped verify', () => {
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'verified locally',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: [],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'verified locally',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    assert.equal(report.serial_verify_required, false,
      'serial_verify_required must stay false in legacy single-agent semantics');
  });
});

describe('VD-NEW-1 — files_changed is no longer the sole ownership input', () => {
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-vdnew1-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    mkdirSync(join(repoPath, 'packages/a/src'), { recursive: true });
    mkdirSync(join(repoPath, 'packages/b/src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'seed\n');
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });

    setupRun(dbPath, repoPath);
    dispatch({
      runId: RUN_ID,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('catches a self-reported domain-a edit of a domain-b file (non-isolated)', () => {
    // Domain-a SELF-REPORTS editing a domain-b file. The agent's own
    // files_changed is always checked in full, even in a non-isolated wave, so
    // a self-confessed out-of-domain edit is still flagged. (The independent
    // git probe is restricted to domain-a's globs in non-isolated mode — see
    // the d3b-collect-A-002 block below — but the self-report path is not.)
    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'self-reported out-of-domain edit',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: ['packages/b/src/baz.js'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'no work',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    const aReport = report.agents.find(r => r.domain === 'domain-a');
    assert.equal(aReport.status, 'ownership_violation',
      'a self-reported edit of another domain\'s file must be flagged');
    assert.ok(report.violations.some(v => v.file === 'packages/b/src/baz.js'),
      'the violated file must appear in the ownership-violations report');
  });
});

describe('d3b-collect-A-002 — non-isolated wave does not flag phantom cross-domain violations', () => {
  // In a NON-isolated parallel amend wave (no --isolate), every agent shares
  // run.local_path. getActualTouchedFiles returns the whole-tree union of all
  // agents' edits — so domain-a's independent touched set includes domain-b's
  // files and vice versa. The OLD code attributed that union to each agent and
  // flagged the OTHER domain's legitimate edits as ownership violations,
  // flipping a clean wave to failed. The fix restricts each agent's independent
  // probe to its own globs when isolation is absent.
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-a002-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    mkdirSync(join(repoPath, 'packages/a/src'), { recursive: true });
    mkdirSync(join(repoPath, 'packages/b/src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'seed\n');
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });

    setupRun(dbPath, repoPath);
    dispatch({ runId: RUN_ID, phase: 'health-amend-a', dbPath, outputDir: tmpDir });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('neither domain is flagged when each agent edits only its own files in a shared tree', () => {
    // Both agents edit only their own files, but the shared tree carries BOTH
    // edits — exactly the parallel-amend reality the bug mis-attributed.
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'fixed by A\n');
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'fixed by B\n');

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: ['packages/a/src/foo.js'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: ['packages/b/src/baz.js'],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    const aReport = report.agents.find(r => r.domain === 'domain-a');
    const bReport = report.agents.find(r => r.domain === 'domain-b');
    assert.notEqual(aReport.status, 'ownership_violation',
      'domain-a must not be flagged for domain-b\'s edit in a shared tree');
    assert.notEqual(bReport.status, 'ownership_violation',
      'domain-b must not be flagged for domain-a\'s edit in a shared tree');
    assert.equal(report.violations.length, 0,
      'a clean parallel amend wave must produce zero ownership violations');
  });

  it('surfaces an ownership_probe_degraded note when isolation is absent', () => {
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'fixed by A\n');

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: ['packages/a/src/foo.js'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'no work',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    const aReport = report.agents.find(r => r.domain === 'domain-a');
    assert.ok(aReport.ownership_probe_degraded,
      'non-isolated wave must surface the degraded-probe note');
    assert.equal(aReport.ownership_probe_degraded.isolated, false);
    assert.match(aReport.ownership_probe_degraded.reason, /--isolate/,
      'the note must point the operator at --isolate for full attribution');
  });

  it('rolls the per-agent degraded notes into a multi_domain wave-level signal', () => {
    // Both domains edit their own files in the shared (non-isolated) tree, so
    // both agents' probes are narrowed. The wave-level aggregate must list both
    // domains and flag multi_domain so the CLI can recommend --isolate once,
    // rather than the operator having to read every agent record.
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'fixed by A\n');
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'fixed by B\n');

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: ['packages/a/src/foo.js'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: ['packages/b/src/baz.js'],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    assert.ok(report.ownership_probe_degraded,
      'a non-isolated amend wave must carry a wave-level degraded-probe signal');
    assert.equal(report.ownership_probe_degraded.isolated, false);
    assert.equal(report.ownership_probe_degraded.multi_domain, true,
      'two degraded domains in one shared worktree is the multi_domain case');
    assert.deepEqual(
      [...report.ownership_probe_degraded.domains].sort(),
      ['domain-a', 'domain-b'],
      'the wave-level signal must list every domain whose probe was narrowed');
  });

  // swarm-cli-B-001 (Stage C carry-over): the per-agent degraded flag was set
  // on the returned object but reached NO operator surface. A SINGLE degraded
  // domain never tripped the wave-level `multi_domain` banner, and the flag-set
  // point in collect.js emitted no structured event. These two tests assert the
  // RENDER path (cli render helper) and the NDJSON event — not just the field.

  it('emits a structured ownership_probe_degraded NDJSON event at the flag-set point', () => {
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'fixed by A\n');

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: ['packages/a/src/foo.js'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'no work',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: [],
    }));

    const { lines } = captureStderrLines(() => collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    }));

    const events = ndjsonEvents(lines).filter(e => e.stage === 'ownership_probe_degraded');
    assert.ok(events.length >= 1,
      'collect must emit a stage=ownership_probe_degraded NDJSON event when an agent probe is narrowed');
    const ev = events.find(e => e.domain === 'domain-a') || events[0];
    assert.ok(ev.correlation_id && /^coord-/.test(ev.correlation_id),
      'the event must carry a coord- correlation id like the sibling coordination events');
    assert.equal(ev.domain, 'domain-a', 'the event must name the degraded domain');
    assert.equal(ev.runId, RUN_ID, 'the event must name the run');
    assert.equal(ev.isolated, false, 'the event must record that the wave was non-isolated');
  });

  it('renders a per-agent [degraded] line for every degraded agent (real collect report)', () => {
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'fixed by A\n');
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'fixed by B\n');

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: ['packages/a/src/foo.js'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: ['packages/b/src/baz.js'],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });

    const rendered = renderProbeDegradedAgents(report).join('\n');
    assert.match(rendered, /\[degraded\]/,
      'a degraded agent must render a [degraded] marker the operator can scan');
    assert.match(rendered, /domain-a/, 'the render must name degraded domain-a');
    assert.match(rendered, /domain-b/, 'the render must name degraded domain-b');
    assert.match(rendered, /--isolate/,
      'the degraded line must point the operator at --isolate for full attribution');
  });

  it('renders a [degraded] line independent of the multi_domain banner gate (single degraded agent)', () => {
    // The wave-level banner in cmdCollect fires ONLY when multi_domain is true
    // (≥2 degraded domains). A report whose ONLY degraded agent is a single
    // domain leaves the banner silent — the per-agent render is then the SOLE
    // operator surface. Crafted directly so the single-degraded-domain case is
    // exercised regardless of the unconditional per-agent degradation path in
    // collect.js. Reverting renderProbeDegradedAgents to a no-op turns this red.
    const singleDegraded = {
      ownership_probe_degraded: { isolated: false, domains: ['domain-a'], multi_domain: false },
      agents: [
        { domain: 'domain-a', status: 'complete', ownership_probe_degraded: { isolated: false, reason: 'x' } },
        { domain: 'domain-b', status: 'complete' },
      ],
    };
    const lines = renderProbeDegradedAgents(singleDegraded);
    assert.equal(lines.length, 1,
      'exactly the one degraded agent must render — and it must render even though multi_domain is false');
    assert.match(lines[0], /\[degraded\] domain-a/);
    assert.match(lines[0], /--isolate/);
  });

  it('renders NO per-agent degraded line when nothing is degraded', () => {
    // No agent carries the degraded flag → zero lines. Without this guard a
    // render that always fires would pass the assertions above vacuously.
    const cleanReport = { agents: [{ domain: 'domain-a', status: 'complete' }] };
    assert.deepEqual(renderProbeDegradedAgents(cleanReport), [],
      'a report with no degraded agent must render zero degraded lines');
  });
});

describe('FT-d — collect persists ownership_probe_degraded into the wave receipt', () => {
  // The per-agent / wave-level ownership_probe_degraded note is computed in
  // collect.js, emitted to NDJSON, and printed to collect stdout — but it was
  // NOT persisted to the control plane, so the wave receipt and any post-hoc
  // audit could not see that a wave ran with weakened ownership attribution.
  // FT-d persists a wave-level waves.ownership_probe_degraded column and
  // surfaces it on the receipt. These tests assert the round-trip:
  // collect → DB column → buildReceipt → receipt.wave.ownership_probe_degraded.
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-ftd-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    mkdirSync(join(repoPath, 'packages/a/src'), { recursive: true });
    mkdirSync(join(repoPath, 'packages/b/src'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'seed\n');
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });

    setupRun(dbPath, repoPath);
    dispatch({ runId: RUN_ID, phase: 'health-amend-a', dbPath, outputDir: tmpDir });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a NON-isolated amend wave records ownership_probe_degraded=true on the receipt', () => {
    // Both agents edit their own files in the shared (non-isolated) worktree —
    // every agent's independent probe is narrowed, so the wave is degraded.
    writeFileSync(join(repoPath, 'packages/a/src/foo.js'), 'fixed by A\n');
    writeFileSync(join(repoPath, 'packages/b/src/baz.js'), 'fixed by B\n');

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: ['packages/a/src/foo.js'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: ['packages/b/src/baz.js'],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });
    assert.ok(report.ownership_probe_degraded,
      'precondition: the non-isolated wave must compute a degraded signal');

    // The persisted DB column must carry the signal (not just the returned
    // object that scrolls past).
    const db = openDb(dbPath);
    const waveRow = db.prepare(
      'SELECT ownership_probe_degraded FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1',
    ).get(RUN_ID);
    assert.equal(waveRow.ownership_probe_degraded, 1,
      'collect must persist waves.ownership_probe_degraded=1 for a non-isolated wave');

    const receipt = buildReceipt({ runId: RUN_ID, dbPath });
    assert.equal(receipt.wave.ownership_probe_degraded, true,
      'the receipt must surface the persisted degraded signal so a post-hoc audit sees it');
  });

  it('an ISOLATED wave records ownership_probe_degraded=false on the receipt', () => {
    // Give each agent_run its OWN isolated worktree (`worktree_path` set) — the
    // real `--isolate` shape, where each agent edits a private checkout. The
    // independent probe runs at full scope per agent and sees ONLY that agent's
    // own edit, so the degradation note is NEVER raised and the receipt must
    // read false. Build a per-domain git worktree, each editing only its own
    // file.
    const wtA = join(tmpDir, 'wt-a');
    const wtB = join(tmpDir, 'wt-b');
    for (const [wt, rel] of [[wtA, 'packages/a/src/foo.js'], [wtB, 'packages/b/src/baz.js']]) {
      mkdirSync(join(wt, 'packages/a/src'), { recursive: true });
      mkdirSync(join(wt, 'packages/b/src'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: wt });
      execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: wt });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: wt });
      writeFileSync(join(wt, 'packages/a/src/foo.js'), 'seed\n');
      writeFileSync(join(wt, 'packages/b/src/baz.js'), 'seed\n');
      execFileSync('git', ['add', '.'], { cwd: wt });
      execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: wt });
      // Each isolated worktree edits ONLY its own domain's file.
      writeFileSync(join(wt, rel), 'fixed in isolation\n');
    }

    const db = openDb(dbPath);
    const waveId = db.prepare(
      'SELECT id FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1',
    ).get(RUN_ID).id;
    const arRows = db.prepare(`
      SELECT ar.id, d.name AS domain
      FROM agent_runs ar JOIN domains d ON ar.domain_id = d.id
      WHERE ar.wave_id = ?
    `).all(waveId);
    const setWt = db.prepare('UPDATE agent_runs SET worktree_path = ? WHERE id = ?');
    for (const ar of arRows) setWt.run(ar.domain === 'domain-a' ? wtA : wtB, ar.id);
    closeDb(dbPath);

    const outA = join(tmpDir, 'a.json');
    const outB = join(tmpDir, 'b.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'domain-a',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-A-001', description: 'fixed it' }],
      files_changed: ['packages/a/src/foo.js'],
    }));
    writeFileSync(outB, JSON.stringify({
      domain: 'domain-b',
      summary: 'fixed own file',
      fixes: [{ finding_id: 'F-B-001', description: 'fixed it' }],
      files_changed: ['packages/b/src/baz.js'],
    }));

    const report = collect({
      runId: RUN_ID,
      dbPath,
      outputs: { 'domain-a': outA, 'domain-b': outB },
    });
    assert.equal(report.ownership_probe_degraded, null,
      'precondition: an isolated wave must NOT compute a degraded signal');

    const db2 = openDb(dbPath);
    const waveRow = db2.prepare(
      'SELECT ownership_probe_degraded FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1',
    ).get(RUN_ID);
    assert.equal(waveRow.ownership_probe_degraded, 0,
      'an isolated wave must leave waves.ownership_probe_degraded at its 0 default');

    const receipt = buildReceipt({ runId: RUN_ID, dbPath });
    assert.equal(receipt.wave.ownership_probe_degraded, false,
      'the receipt of an isolated wave must record ownership_probe_degraded=false');
  });
});

describe('VD-NEW-1 — diffReportedVsActual helper', () => {
  it('reports missing_from_report when actual has files the agent did not list', () => {
    const d = diffReportedVsActual(['a.js'], ['a.js', 'b.js']);
    assert.deepEqual(d.missing_from_report, ['b.js']);
    assert.deepEqual(d.extra_in_report, []);
    assert.equal(d.match, false);
  });

  it('reports extra_in_report when the agent listed files the worktree did not actually touch', () => {
    const d = diffReportedVsActual(['a.js', 'phantom.js'], ['a.js']);
    assert.deepEqual(d.missing_from_report, []);
    assert.deepEqual(d.extra_in_report, ['phantom.js']);
    assert.equal(d.match, false);
  });

  it('flags a perfect match', () => {
    const d = diffReportedVsActual(['a.js', 'b.js'], ['b.js', 'a.js']);
    assert.equal(d.match, true);
  });

  it('normalizes backslash paths so Windows agent reports compare against forward-slash git output', () => {
    const d = diffReportedVsActual(['packages\\a\\src\\foo.js'], ['packages/a/src/foo.js']);
    assert.equal(d.match, true);
  });
});

describe('VD-NEW-1 — getActualTouchedFiles graceful degradation', () => {
  it('returns unavailable=true when the path is not a git repo', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'not-a-git-repo-'));
    try {
      const r = getActualTouchedFiles(tmp);
      assert.equal(r.unavailable, true);
      assert.deepEqual(r.all, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('wave2-live-001 — glob-overlap narrowing must not phantom-flag the broad-glob domain (d3b-collect-A-002 fractal)', () => {
  // Live incident, run swarm-1783007856-9fdb wave 2: a "tests"-style domain
  // owning `**/*.test.*` shared a worktree with package domains owning
  // `packages/<pkg>/**`. The non-isolated narrowing admitted every sibling
  // agent's test-file edit into the broad-glob agent's independent set (glob
  // MEMBERSHIP), while checkOwnership resolves the exclusive owner by glob
  // SPECIFICITY — so the package-owned test files resolved to the package
  // domain and the tests agent was blocked on 39 phantom out-of-domain edits
  // it never made. The narrowing must use the same arbitration as enforcement:
  // exclusive-owner resolution, not bare glob membership.
  const OVERLAP_RUN = 'test-glob-overlap-narrowing';
  let tmpDir, dbPath, repoPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'verif-disc-overlap-'));
    dbPath = join(tmpDir, 'control-plane.db');
    repoPath = join(tmpDir, 'repo');
    mkdirSync(join(repoPath, 'packages/a/src'), { recursive: true });
    mkdirSync(join(repoPath, 'dogfood'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'packages/a/src/foo.test.js'), 'seed\n');
    writeFileSync(join(repoPath, 'dogfood/gate.test.js'), 'seed\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoPath });

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(OVERLAP_RUN, 'org/repo', repoPath, 'a'.repeat(40));
    saveDomainDraft(db, OVERLAP_RUN, [
      { name: 'pkg-a', globs: ['packages/a/**'], ownership_class: 'owned' },
      { name: 'xtests', globs: ['**/*.test.*'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, OVERLAP_RUN);
    const insert = db.prepare(`INSERT INTO findings
      (run_id, finding_id, fingerprint, severity, category, file_path, line_number,
       description, recommendation, status)
      VALUES (?, ?, ?, ?, 'quality', ?, ?, ?, ?, 'approved')`);
    insert.run(OVERLAP_RUN, 'F-PA-001', 'fp-pa-1', 'HIGH',
      'packages/a/src/foo.test.js', 1, 'pkg-a test finding', 'fix it');
    insert.run(OVERLAP_RUN, 'F-XT-001', 'fp-xt-1', 'HIGH',
      'dogfood/gate.test.js', 1, 'xtests finding', 'fix it');
    dispatch({ runId: OVERLAP_RUN, phase: 'health-amend-a', dbPath, outputDir: tmpDir });
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not attribute a package-owned test-file edit to the broad **/*.test.* domain', () => {
    // pkg-a edits ITS OWN test file in the shared (non-isolated) tree.
    writeFileSync(join(repoPath, 'packages/a/src/foo.test.js'), 'fixed by pkg-a\n');

    const outA = join(tmpDir, 'pkg-a.json');
    const outX = join(tmpDir, 'xtests.json');
    writeFileSync(outA, JSON.stringify({
      domain: 'pkg-a',
      summary: 'fixed own test file',
      fixes: [{ finding_id: 'F-PA-001', description: 'fixed it' }],
      files_changed: ['packages/a/src/foo.test.js'],
    }));
    writeFileSync(outX, JSON.stringify({
      domain: 'xtests',
      summary: 'no work this wave',
      fixes: [{ finding_id: 'F-XT-001', description: 'fixed it' }],
      files_changed: [],
    }));

    const report = collect({
      runId: OVERLAP_RUN,
      dbPath,
      outputs: { 'pkg-a': outA, 'xtests': outX },
    });

    const xReport = report.agents.find(r => r.domain === 'xtests');
    const aReport = report.agents.find(r => r.domain === 'pkg-a');
    assert.notEqual(xReport.status, 'ownership_violation',
      'the broad-glob domain must not be flagged for a file whose exclusive owner (by specificity) is another domain');
    assert.notEqual(aReport.status, 'ownership_violation',
      'the owning domain editing its own test file is clean');
    assert.equal(report.violations.length, 0,
      'a clean overlapping-glob wave must produce zero ownership violations');
  });
});
