/**
 * wave10-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 10 (health-amend-a) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: identical rationale to wave8-4091637-5127-swarm-cp-pins.test.js's
 * header — swarm-cp-verbs owns cli.js + commands/**, but package-root *.test.js
 * is swarm-cp-tests' bridge glob and the ONLY location `node --test "*.test.js"
 * "lib/*.test.js"` discovers, so a CLI-surface pin has to live here. These two
 * were authored by the coordinator against the merged tree (wave-8 precedent):
 * the verbs amend agent proved both fixes with an ad-hoc subprocess harness but
 * could not commit a root test file from its isolated worktree, leaving the
 * source pins orphaned until this file landed.
 *
 *   F-0a888394 (MEDIUM) — cmdAdvance's PROMOTED branch never echoed
 *     result.gates, so an operator who typed `advance --override --reason '...'`
 *     saw promotion happen but not which named gates their reason consented to
 *     mask (recoverable only via a second `--history` call). The fix renders
 *     the same per-gate PASS/FAIL breakdown the BLOCKED branch already had,
 *     plus an `[OVERRIDDEN]` tag on gates the override path marked.
 *
 *   F-1d972160 (HIGH) — the zero-match refusal hint for approve/defer/reject
 *     used to suggest `swarm status --format=json` for canonical finding ids —
 *     a dead end (status emits aggregate counts only, never an individual
 *     finding_id). The fix points at `swarm findings <run> --format=json`,
 *     whose annotateCanonicalFindingIds resolution actually emits ids.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

// ── F-0a888394 — the PROMOTED branch echoes the per-gate breakdown ──
// A clean ADVANCE (all gates pass, no override) still carries result.gates;
// pre-fix the promoted branch printed nothing but PROMOTED/Verdict/Next. Seed
// the minimum promotable state: a collected health-audit-a wave with all
// agents complete, a passing verification receipt, and no open findings /
// violations, so checkGates returns ADVANCE and the Gates block must render.
test('F-0a888394: `swarm advance` prints the per-gate breakdown on a promoted advance', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'w10-advance-'));
  try {
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w10-advance';
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
       VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
    ).run(RUN_ID, tmp, 'a'.repeat(40));
    const dom = db.prepare(
      `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
       VALUES (?, 'backend', '["src/**"]', 'owned', 1)`
    ).run(RUN_ID);
    const wave = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status)
       VALUES (?, 'health-audit-a', 1, 'collected')`
    ).run(RUN_ID);
    const waveId = Number(wave.lastInsertRowid);
    db.prepare(
      `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`
    ).run(waveId, Number(dom.lastInsertRowid));
    db.prepare(
      `INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count)
       VALUES (?, 'node', 'npm test', 0, 1, 100)`
    ).run(waveId);
    closeDb(dbPath);

    const r = runCli(['advance', RUN_ID], dbPath);
    assert.equal(r.status, 0, `advance should promote a clean wave: ${r.stderr}`);
    assert.match(r.stdout, /PROMOTED:/, 'the promotion still prints');
    // The fix: the promoted branch now echoes the gate breakdown in-place.
    assert.match(r.stdout, /Gates:/, 'F-0a888394: the promoted branch must echo the Gates breakdown, not only the BLOCKED branch');
    assert.match(r.stdout, /\[PASS\] verification/, 'each evaluated gate is shown with its PASS/FAIL state at the moment of promotion');
    // F-3c8eb1c3 (wave 12): this test never passes --override, so it never
    // exercised the `g.overridden ? ' [OVERRIDDEN]' : ''` ternary at all — an
    // "always tag every gate" mutation of that line left every assertion
    // above green (the mutated PASS/FAIL lines still match, and nothing
    // checked for the tag's absence on a clean, non-override promotion).
    assert.doesNotMatch(r.stdout, /\[OVERRIDDEN\]/,
      'F-3c8eb1c3: a clean, non-override advance must never carry an [OVERRIDDEN] tag on any gate line');
  } finally {
    teardown(tmp);
  }
});

// ── F-3c8eb1c3 / F-f33081a2 (wave 12) — the override tag lands ONLY on the
// gate(s) the operator's reason actually disposed of. MUTATION-PROVEN gap:
// the F-0a888394 test above drives `advance` with no --override at all, so
// it never touches cli.js's override-tag ternary; an "always-tag" mutation
// (unconditionally ' [OVERRIDDEN]') and a "never-tag" mutation (unconditionally
// '') both left every pin in this file green before this test existed.
// Reproduces HANDOFF.md promotion #8's shape (also pinned at the advance()
// function level by lib/advance-override-amend-reroute.test.js, out of this
// domain — that file calls advance() directly and never spawns cli.js, so it
// cannot see cmdAdvance's render line either): an open HIGH finding routes
// checkGates to verdict AMEND, and a failing adjudication gate is the
// SEPARATE overridable failure the operator's --reason actually targets.
// F-f33081a2 excludes finding_severity from the override mask in this shape
// (the wave lands on the amend phase BECAUSE it is still failing, not
// because the override waived it) — that exclusion must be visible in the
// SAME terminal output, not just inferable from the DB.
test('F-3c8eb1c3: an amend-reroute override tags adjudication [OVERRIDDEN] but NOT finding_severity, which stays open', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'w10-override-reroute-'));
  try {
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w10-override-reroute';
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
       VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
    ).run(RUN_ID, tmp, 'c'.repeat(40));
    const dom = db.prepare(
      `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
       VALUES (?, 'backend', '["src/**"]', 'owned', 1)`
    ).run(RUN_ID);
    const wave = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status)
       VALUES (?, 'health-audit-a', 1, 'collected')`
    ).run(RUN_ID);
    const waveId = Number(wave.lastInsertRowid);
    db.prepare(
      `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`
    ).run(waveId, Number(dom.lastInsertRowid));
    db.prepare(
      `INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count)
       VALUES (?, 'node', 'npm test', 0, 1, 100)`
    ).run(waveId);
    // An open HIGH finding — findingGate fails, the phase is finding-gated,
    // so checkGates returns verdict AMEND with nextPhase = health-amend-a.
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-openhigh', 'fp-openhigh', 'HIGH', 'bug', 'src/a.js', 'still open', 'new', ?, ?)`
    ).run(RUN_ID, waveId, waveId);
    // A non-corroborate adjudication — the SEPARATE overridable gate the
    // operator's --reason actually targets.
    db.prepare(
      `INSERT INTO adjudications (wave_id, run_id, overall, authority, panel_size, seats)
       VALUES (?, ?, 'insufficient_context', 'advisory', 3, '[]')`
    ).run(waveId, RUN_ID);
    closeDb(dbPath);

    const r = runCli(['advance', RUN_ID, '--override', '--reason', 'disposing the insufficient_context jury verdict only'], dbPath);
    assert.equal(r.status, 0, `an amend-reroute override still promotes, to the amend edge: ${r.stderr}`);
    const promotedLine = (r.stdout.match(/^PROMOTED: .*$/m) || [])[0] || '';
    assert.match(promotedLine, /health-audit-a/, 'fromPhase must be the audit phase');
    assert.match(promotedLine, /health-amend-a/, 'F-f33081a2: toPhase must route along the amend edge, not past it');

    const findingSeverityLine = (r.stdout.match(/\[(?:PASS|FAIL)\] finding_severity — [^\n]*/) || [])[0];
    const adjudicationLine = (r.stdout.match(/\[(?:PASS|FAIL)\] adjudication — [^\n]*/) || [])[0];
    assert.ok(findingSeverityLine, 'the finding_severity gate line must render in the Gates block');
    assert.ok(adjudicationLine, 'the adjudication gate line must render in the Gates block');
    assert.doesNotMatch(findingSeverityLine, /\[OVERRIDDEN\]/,
      'F-f33081a2: finding_severity must NOT be tagged — the wave lands on the amend phase because it is still failing, not because the override waived it');
    assert.match(adjudicationLine, /\[OVERRIDDEN\]/,
      'F-3c8eb1c3: adjudication IS the gate this override actually disposed of and must carry the tag');
  } finally {
    teardown(tmp);
  }
});

// F-0245118c (wave 12): the simpler sibling case the finding's own manual CLI
// reproduction used — a single overridable gate failing with no AMEND verdict
// in play at all. Proves the override tag's headline claim in the most direct
// shape: exactly one gate carries [OVERRIDDEN], and it is never a passing one.
test('F-0245118c: a single-gate override (ownership violation) tags only that gate — no passing gate is ever tagged', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'w10-override-single-'));
  try {
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w10-override-single';
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
       VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
    ).run(RUN_ID, tmp, 'd'.repeat(40));
    const dom = db.prepare(
      `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
       VALUES (?, 'backend', '["src/**"]', 'owned', 1)`
    ).run(RUN_ID);
    const wave = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status)
       VALUES (?, 'health-audit-a', 1, 'collected')`
    ).run(RUN_ID);
    const waveId = Number(wave.lastInsertRowid);
    const agentRun = db.prepare(
      `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'complete')`
    ).run(waveId, Number(dom.lastInsertRowid));
    // A real ownership violation — the ONLY failing gate: no findings, a
    // passing verification receipt, no adjudication run.
    db.prepare(
      `INSERT INTO file_claims (agent_run_id, file_path, claim_type, domain_id, violation)
       VALUES (?, 'out/of/domain.js', 'edit', ?, 1)`
    ).run(Number(agentRun.lastInsertRowid), Number(dom.lastInsertRowid));
    db.prepare(
      `INSERT INTO verification_receipts (wave_id, repo_type, commands_run, exit_code, passed, test_count)
       VALUES (?, 'node', 'npm test', 0, 1, 100)`
    ).run(waveId);
    closeDb(dbPath);

    const r = runCli(['advance', RUN_ID, '--override', '--reason', 'disposing the ownership violation'], dbPath);
    assert.equal(r.status, 0, `a single overridable-gate override must promote: ${r.stderr}`);
    assert.match(r.stdout, /\[FAIL\] ownership — 1 ownership violation\(s\) detected \[OVERRIDDEN\]/,
      'the ownership gate line must carry the tag');

    const taggedLines = r.stdout.split('\n').filter((l) => l.includes('[OVERRIDDEN]'));
    assert.equal(taggedLines.length, 1, `exactly one gate line may carry the tag; got: ${JSON.stringify(taggedLines)}`);
    assert.match(taggedLines[0], /ownership/, 'the one tagged line must be the ownership gate, not a passing gate');
  } finally {
    teardown(tmp);
  }
});

// ── F-1d972160 — the zero-match hint names a verb that actually emits ids ──
test('F-1d972160: the --ids zero-match hint points at `swarm findings --format=json`, not the `swarm status` dead end', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'w10-nomatch-'));
  try {
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w10-nomatch';
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
       VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
    ).run(RUN_ID, tmp, 'b'.repeat(40));
    const nmWave = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status)
       VALUES (?, 'health-audit-a', 1, 'collected')`
    ).run(RUN_ID);
    const nmWaveId = Number(nmWave.lastInsertRowid);
    // One real finding so the run HAS findings — the hint fires on zero-MATCH,
    // not zero-findings.
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-realabcd', 'fp-real', 'HIGH', 'bug', 'src/a.js', 'a real finding', 'approved', ?, ?)`
    ).run(RUN_ID, nmWaveId, nmWaveId);
    closeDb(dbPath);

    const r = runCli(['approve', RUN_ID, '--ids', 'F-NOSUCHID'], dbPath);
    assert.notEqual(r.status, 0, 'a zero-match --ids must fail loudly (non-zero), not silently exit 0');
    assert.match(r.stderr, /swarm findings [^\n]*--format=json/, 'F-1d972160: the hint must name `swarm findings --format=json`, the verb that actually emits canonical ids');
    assert.doesNotMatch(r.stderr, /swarm status [^\n]*--format=json/, 'the pre-fix `swarm status --format=json` dead-end suggestion must be gone');
  } finally {
    teardown(tmp);
  }
});

// ── F-37f65a8f (wave 12) — annotateCanonicalFindingIds's drifted-line
// fallback fails CLOSED when two distinct findings share (file, symbol,
// category, severity) at different lines. MUTATION-PROVEN gap: the
// F-1d972160 test above never calls `swarm findings` and never seeds a
// recurring finding, so it never exercises annotateCanonicalFindingIds at
// all — removing the ambiguity guard at cli.js (`looseBucket.length === 1`
// widened to `>= 1`) left every existing pin in both this file and
// wave8-4091637-5127-swarm-cp-pins.test.js (the only two files anywhere in
// the repo that reference annotateCanonicalFindingIds) green. A ghost id is
// worse than none: an operator who approves/defers/rejects a wrongly
// cross-resolved id acts on the WRONG finding while believing they targeted
// the right one.
test('F-37f65a8f: a drifted line that collides with a sibling finding resolves to NOTHING, not the sibling\'s id', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'w10-ambiguous-'));
  try {
    const dbPath = join(tmp, 'control-plane.db');
    const db = openDb(dbPath);
    const RUN_ID = 'run-w10-ambiguous';
    db.prepare(
      `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
       VALUES (?, 'org/repo', ?, ?, 'main', 'health-audit-a')`
    ).run(RUN_ID, tmp, 'e'.repeat(40));
    const wave1 = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 1, 'collected')`
    ).run(RUN_ID);
    const wave1Id = Number(wave1.lastInsertRowid);
    const wave2 = db.prepare(
      `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'health-audit-a', 2, 'collected')`
    ).run(RUN_ID);
    const wave2Id = Number(wave2.lastInsertRowid);

    // Two genuinely distinct, unrelated findings sharing (file, symbol,
    // category, severity) at DIFFERENT lines — both first-seen in wave 1,
    // still open/recurring in wave 2 (last_seen_wave = wave2Id).
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-siblingA1', 'fp-siblingA1', 'HIGH', 'bug', 'src/shared.js', 10, 'sharedFn', 'first, unrelated bug near the top', 'recurring', ?, ?)`
    ).run(RUN_ID, wave1Id, wave2Id);
    db.prepare(
      `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, symbol, description, status, first_seen_wave, last_seen_wave)
       VALUES (?, 'F-siblingB2', 'fp-siblingB2', 'HIGH', 'bug', 'src/shared.js', 50, 'sharedFn', 'second, unrelated bug near the bottom', 'recurring', ?, ?)`
    ).run(RUN_ID, wave1Id, wave2Id);
    closeDb(dbPath);

    // wave-2 output.json: sibling B recurs at its EXACT DB line (50) and must
    // resolve via the primary full-tuple match, unaffected by sibling A's
    // presence. Sibling A has drifted to a THIRD line (12 — neither 10 nor
    // 50): its full-tuple match is empty, so it falls to the loose
    // (file,symbol,category,severity) fallback, where it collides with
    // sibling B's row and must resolve to NOTHING rather than guessing.
    const waveDir = join(tmp, RUN_ID, 'wave-2', 'backend');
    mkdirSync(waveDir, { recursive: true });
    writeFileSync(join(waveDir, 'output.json'), JSON.stringify({
      domain: 'backend',
      stage: 'A',
      summary: '2 findings',
      findings: [
        { id: 'agent-local-B', severity: 'HIGH', category: 'bug', file: 'src/shared.js', line: 50, symbol: 'sharedFn', description: 'second, unrelated bug near the bottom' },
        { id: 'agent-local-A-drifted', severity: 'HIGH', category: 'bug', file: 'src/shared.js', line: 12, symbol: 'sharedFn', description: 'first, unrelated bug near the top' },
      ],
    }));

    const r = runCli(['findings', RUN_ID, '2', '--format=json'], dbPath);
    assert.equal(r.status, 1, `findings-present exit code: ${r.stderr}`); // digest's own 3-way contract
    const model = JSON.parse(r.stdout);
    const exactMatch = model.findings.find((f) => f.line === 50);
    const drifted = model.findings.find((f) => f.line === 12);
    assert.ok(exactMatch && drifted, 'both digest findings must be present in the output');

    assert.equal(exactMatch.id, 'F-siblingB2',
      'the exact-match sibling (line 50) must resolve to its OWN canonical id, unaffected by its sibling sharing the loose tuple');
    assert.equal(drifted.id, 'agent-local-A-drifted',
      'F-37f65a8f: the drifted+ambiguous finding must fail CLOSED — it keeps its agent-local id rather than cross-resolving to F-siblingB2 (a real, but WRONG, finding)');
  } finally {
    teardown(tmp);
  }
});
