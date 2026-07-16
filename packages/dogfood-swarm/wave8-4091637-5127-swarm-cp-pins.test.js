/**
 * wave8-4091637-5127-swarm-cp-pins.test.js — swarm-cp-verbs regression pins
 * for wave 8 (health-amend-a) of run swarm-1784091637-5127.
 *
 * TEST PLACEMENT: this domain (swarm-cp-verbs) owns
 * packages/dogfood-swarm/commands/** + cli.js; package-root *.test.js belongs
 * to swarm-cp-tests. That domain is ownership_class `bridge`
 * (globs: packages/dogfood-swarm/*.test.js), and lib/domains.js#checkOwnership
 * admits a file with no exclusive `owned` claimant that matches a bridge glob
 * as valid — `bridge via swarm-cp-tests`. Writing regression pins here is
 * therefore lawful by the frozen map's own design, not an exception — see
 * wave4-4091637-5127-swarm-cp-pins.test.js's header for the fuller citation.
 * It also has to be here: the only discoverable test location for this
 * package is `node --test "*.test.js" "lib/*.test.js"` (package.json), so a
 * test placed under commands/ would never be collected.
 *
 *   F-19f86582 (HIGH) — cmdFindings (`swarm findings`) was the ONE output-
 *     consuming verb that never adopted dirname(getDbPath()) resolution: it
 *     called buildDigest() with no swarmsDir override, so lib/findings-
 *     digest.js's SWARMS_DIR default (this installed package's own build-
 *     relative swarms/ dir) was always used, independent of SWARM_DB. A run
 *     collected against a relocated SWARM_DB was invisible to `swarm
 *     findings` even though `swarm collect --all` under the identical
 *     SWARM_DB found the same run's artifacts fine. Fixed by having
 *     cmdFindings resolve swarmsDir = dirname(getDbPath()), mirroring
 *     cmdCollect --all's identical derivation — and, since attaching a
 *     `.code`/`.hint` to buildDigest's own directory-not-found throws would
 *     require editing lib/findings-digest.js (swarm-cp-core's domain, not
 *     this one's), cmdFindings now reassembles buildDigest's orchestration
 *     from its individually-exported pieces (findLatestWave /
 *     loadDomainOutputs / buildDigestModel / renderDigest) so the directory-
 *     resolution throws can be typed at this call site instead.
 *
 *   F-ad540b83 (HIGH) — `swarm findings` rendered each finding's `id` field
 *     verbatim from the agent's own output.json (an agent-local namespace,
 *     e.g. 'F-001') while `swarm approve/defer/reject --ids` match ONLY
 *     findings.finding_id (the DB's fingerprint-derived canonical id, e.g.
 *     'F-c63c7498') — a disjoint namespace never cross-referenced back to
 *     the digest. Pasting a digest id into --ids matched ZERO rows with NO
 *     error, no warning, exit code 0 — textually indistinguishable from "you
 *     approved 0 findings on purpose". Fixed BOTH halves: (1) the digest now
 *     resolves and renders the DB-canonical finding_id when it can (best-
 *     effort, exact field-equality match against this wave's collected
 *     rows — see cli.js's annotateCanonicalFindingIds doc comment for the
 *     fail-closed design and its documented recurring-drift gap); (2) the
 *     three disposition verbs refuse loudly (non-zero exit, a hint naming
 *     the namespace confusion) when NONE of the supplied --ids exist in the
 *     run's findings at all, and match case-insensitively.
 *
 *   F-87dc7b35 (LOW) — commands/status.js's cross-wave 'Violations across
 *     all waves' aggregator (the run-wide file_claims COUNT feeding
 *     `swarm status`'s informational violation count) shares the IDENTICAL
 *     LATEST_AGENT_RUN_PER_DOMAIN blind spot documented for lib/advance.js
 *     #checkViolations by F-9c41a2b7 / F-4220149f: a real violation on a
 *     SUPERSEDED (non-latest) agent_run within a wave — reachable via
 *     `swarm resume` under non-isolated dispatch — is invisible to it too,
 *     and unlike F-4fa7e644's original cross-wave scenario, no mitigating
 *     operator-visible signal survives for this specific shape. The
 *     underlying semantics live in lib/queries/latest-agent-runs.js (out of
 *     this domain — swarm-cp-core's), so the fix here is the honest subset
 *     within this domain's globs: a cross-referencing comment at the
 *     aggregator itself, so a future fix to the shared filter is known to
 *     affect both consumers together instead of silently fixing one.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

function teardown(...dirs) {
  for (const d of dirs) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
}

/**
 * Seed a run with ONE owned domain, a dispatched health-audit-a wave, and a
 * written wave-1/backend/output.json carrying one AUDIT finding whose
 * agent-local `id` is deliberately in the F-001-style namespace (the exact
 * shape the finding proves collides with canonical ids). swarmDir === the
 * SWARM_DB's own dirname, so this mirrors seedDispatchedWave in
 * w4-cli-ergonomics.test.js — the established relocated-SWARM_DB pattern
 * every sibling CLI-surface fix's test file already uses.
 */
function seedAuditWave({ findingId = 'F-001' } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'w8-findings-'));
  const swarmDir = tmp;
  const dbPath = join(swarmDir, 'control-plane.db');
  const db = openDb(dbPath);

  const RUN_ID = 'run-w8-findings';
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
     VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`
  ).run(RUN_ID, tmp, 'b'.repeat(40));

  const dBackend = db.prepare(
    `INSERT INTO domains (run_id, name, globs, ownership_class, frozen)
     VALUES (?, 'backend', '["src/**"]', 'owned', 1)`
  ).run(RUN_ID);

  const waveNumber = 1;
  const wave = db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status)
     VALUES (?, 'health-audit-a', ?, 'dispatched')`
  ).run(RUN_ID, waveNumber);
  const waveId = Number(wave.lastInsertRowid);

  db.prepare(
    `INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, 'dispatched')`
  ).run(waveId, Number(dBackend.lastInsertRowid));

  closeDb(dbPath);

  const waveDir = join(swarmDir, RUN_ID, `wave-${waveNumber}`, 'backend');
  mkdirSync(waveDir, { recursive: true });
  writeFileSync(join(waveDir, 'output.json'), JSON.stringify({
    domain: 'backend',
    stage: 'A',
    summary: '1 finding',
    findings: [
      {
        id: findingId, severity: 'HIGH', category: 'bug',
        file: 'src/a.js', line: 10, symbol: 'doThing',
        description: `a real bug, agent-local id ${findingId}`,
      },
    ],
  }));

  return { tmp, dbPath, swarmDir, waveNumber, RUN_ID };
}

// ══════════════════════════════════════════════════════════════════════
// F-19f86582 — `swarm findings` resolves SWARM_DB-relative artifacts
// ══════════════════════════════════════════════════════════════════════

describe('F-19f86582: `swarm findings` resolves artifacts relative to SWARM_DB, not a build-relative default', () => {
  let fx;
  afterEach(() => { teardown(fx?.tmp); fx = null; });

  it('PROVEN END-TO-END: collect --all succeeds under a relocated SWARM_DB, and swarm findings now finds the SAME run', () => {
    fx = seedAuditWave();

    const collectResult = runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    assert.equal(collectResult.status, 0, `collect --all must succeed: ${collectResult.stderr}`);
    assert.match(collectResult.stdout, /backend: complete/);

    const findingsResult = runCli(['findings', fx.RUN_ID, '--format=json'], fx.dbPath);
    // F-19f86582 regression: pre-fix this exited 1 via the untyped "Run
    // directory not found" throw — textually similar (also exit 1) to the
    // 'findings present' contract, but for the WRONG reason. Assert the
    // symptom text is absent AND that a real, parseable digest came back.
    assert.doesNotMatch(findingsResult.stderr || '', /Run directory not found/,
      'the pre-fix symptom: findings looked in the build-relative default swarms/ dir instead of dirname(SWARM_DB)');
    assert.equal(findingsResult.status, 1, // digest's own 3-way contract: 1 = findings present
      `swarm findings must resolve the SAME SWARM_DB collect --all just used: ${findingsResult.stderr}`);
    const model = JSON.parse(findingsResult.stdout);
    assert.equal(model.totals.findings, 1);
  });

  it('a truly missing run under this SWARM_DB fails with a TYPED error + hint, not a bare untyped throw', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w8-findings-missing-'));
    const dbPath = join(tmp, 'control-plane.db');
    try {
      const r = runCli(['findings', 'no-such-run'], dbPath);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /ERROR \[FINDINGS_RUN_DIR_NOT_FOUND\]/,
        'the untyped "Run directory not found" throw must gain a stable .code so renderTopLevelError renders it structured');
      assert.match(r.stderr, /Next:/, 'a typed error must carry an actionable hint');
      assert.match(r.stderr, /SWARM_DB/, 'the hint must point at the SWARM_DB knob, the actual fix for this symptom');
    } finally {
      teardown(tmp);
    }
  });

  it('a run dir that exists but has no wave-N directories fails with a typed error', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'w8-findings-nowave-'));
    const dbPath = join(tmp, 'control-plane.db');
    mkdirSync(join(tmp, 'empty-run'), { recursive: true });
    try {
      const r = runCli(['findings', 'empty-run'], dbPath);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /ERROR \[FINDINGS_NO_WAVES_FOUND\]/);
      assert.match(r.stderr, /Next:/);
    } finally {
      teardown(tmp);
    }
  });

  it('an explicit wave number that does not exist fails with a typed error naming a recovery step', () => {
    fx = seedAuditWave();
    const r = runCli(['findings', fx.RUN_ID, '99'], fx.dbPath);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /ERROR \[FINDINGS_WAVE_DIR_NOT_FOUND\]/);
    assert.match(r.stderr, /Next:/);
    assert.match(r.stderr, /swarm status/);
  });

  it('LENS (unchanged direction): --format xml still fails BEFORE any directory resolution, same as pre-fix', () => {
    fx = seedAuditWave();
    const r = runCli(['findings', fx.RUN_ID, '--format', 'xml'], fx.dbPath);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CLI_INVALID_FORMAT/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// F-ad540b83 — dual finding-id namespaces
// ══════════════════════════════════════════════════════════════════════

describe('F-ad540b83: digest ids match --ids (canonical, case-insensitive), and a true zero-match refuses loudly', () => {
  let fx;
  afterEach(() => { teardown(fx?.tmp); fx = null; });

  it('PROVEN END-TO-END: swarm findings renders the CANONICAL finding_id (not the agent-local id), and pasting it into approve --ids works on the first try', () => {
    fx = seedAuditWave({ findingId: 'F-001' });

    const collectResult = runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    assert.equal(collectResult.status, 0, `collect must succeed: ${collectResult.stderr}`);

    const findingsResult = runCli(['findings', fx.RUN_ID, '--format=json'], fx.dbPath);
    const model = JSON.parse(findingsResult.stdout);
    assert.equal(model.findings.length, 1);
    const renderedId = model.findings[0].id;
    assert.notEqual(renderedId, 'F-001',
      'F-ad540b83 regression: the digest must render the DB-canonical finding_id, not the agent-local id verbatim');
    assert.match(renderedId, /^F-[0-9a-f]{8}$/, 'the canonical id shape (F-<8 hex>, lib/fingerprint.js)');

    const approveResult = runCli(['approve', fx.RUN_ID, '--ids', renderedId], fx.dbPath);
    assert.equal(approveResult.status, 0, `approve with the digest-rendered id must succeed: ${approveResult.stderr}`);
    assert.match(approveResult.stdout, /Approved 1 findings/);
  });

  it('pasting the AGENT-LOCAL id (the pre-fix silent-0-match trap) refuses loudly instead of a bare "Approved 0" at exit 0', () => {
    fx = seedAuditWave({ findingId: 'F-001' });
    const collectResult = runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    assert.equal(collectResult.status, 0, `collect must succeed: ${collectResult.stderr}`);

    // The exact proven-live shape from the finding: paste the agent's own
    // local id (still present, unresolved, on any output.json this digest
    // could theoretically be re-read from) into --ids.
    const r = runCli(['approve', fx.RUN_ID, '--ids', 'F-001'], fx.dbPath);
    assert.notEqual(r.status, 0,
      'F-ad540b83 regression: a --ids value matching ZERO findings must not silently succeed at exit 0');
    assert.match(r.stderr, /ERROR \[CLI_FINDINGS_ID_NO_MATCH\]/);
    assert.match(r.stderr, /agent-local/,
      'the hint must name the id-namespace confusion, not just say "not found"');
    assert.doesNotMatch(r.stdout, /Approved 0 findings/,
      'the old, silent, textually-indistinguishable-from-success message must not print');
  });

  it('case-insensitive: an UPPERCASED canonical id still matches --ids for approve', () => {
    fx = seedAuditWave();
    const collectResult = runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    assert.equal(collectResult.status, 0, `collect must succeed: ${collectResult.stderr}`);
    const model = JSON.parse(runCli(['findings', fx.RUN_ID, '--format=json'], fx.dbPath).stdout);
    const canonicalId = model.findings[0].id;

    const r = runCli(['approve', fx.RUN_ID, '--ids', canonicalId.toUpperCase()], fx.dbPath);
    assert.equal(r.status, 0, `an uppercased canonical id must still match case-insensitively: ${r.stderr}`);
    assert.match(r.stdout, /Approved 1 findings/);
  });

  it('defer/reject share the same zero-match refusal and case-insensitive matching', () => {
    fx = seedAuditWave();
    const collectResult = runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    assert.equal(collectResult.status, 0, `collect must succeed: ${collectResult.stderr}`);
    const model = JSON.parse(runCli(['findings', fx.RUN_ID, '--format=json'], fx.dbPath).stdout);
    const canonicalId = model.findings[0].id;

    const bad = runCli(['defer', fx.RUN_ID, '--ids', 'F-001', '--reason', 'x'], fx.dbPath);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /ERROR \[CLI_FINDINGS_ID_NO_MATCH\]/);

    const good = runCli(['defer', fx.RUN_ID, '--ids', canonicalId.toUpperCase(), '--reason', 'x'], fx.dbPath);
    assert.equal(good.status, 0, `stderr: ${good.stderr}`);
    assert.match(good.stdout, /Deferred 1 findings/);

    // reject on a fresh (undisposed) run of the same shape.
    fx = seedAuditWave();
    runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    const badReject = runCli(['reject', fx.RUN_ID, '--ids', 'F-001', '--reason', 'x'], fx.dbPath);
    assert.notEqual(badReject.status, 0);
    assert.match(badReject.stderr, /ERROR \[CLI_FINDINGS_ID_NO_MATCH\]/);
  });

  it('LENS (unchanged direction): re-running defer over an already-deferred (EXISTING, canonical) id still exits 0 — the loud refusal is existence-based, not open-status-based', () => {
    fx = seedAuditWave();
    runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    const model = JSON.parse(runCli(['findings', fx.RUN_ID, '--format=json'], fx.dbPath).stdout);
    const canonicalId = model.findings[0].id;

    const first = runCli(['defer', fx.RUN_ID, '--ids', canonicalId, '--reason', 'first'], fx.dbPath);
    assert.equal(first.status, 0, `stderr: ${first.stderr}`);
    assert.match(first.stdout, /Deferred 1 findings/);

    const again = runCli(['defer', fx.RUN_ID, '--ids', canonicalId, '--reason', 'second'], fx.dbPath);
    assert.equal(again.status, 0,
      'idempotent re-defer of an EXISTING (already-terminal) canonical id must stay a quiet no-op, not the zero-match refusal');
    assert.match(again.stdout, /Deferred 0 findings/);
  });

  it('LENS (unchanged direction): `swarm approve --all` matching zero pending findings is still a normal, unrefused no-op', () => {
    fx = seedAuditWave();
    runCli(['collect', fx.RUN_ID, '--all'], fx.dbPath);
    const model = JSON.parse(runCli(['findings', fx.RUN_ID, '--format=json'], fx.dbPath).stdout);
    runCli(['approve', fx.RUN_ID, '--ids', model.findings[0].id], fx.dbPath);

    // Nothing left in new/recurring — --all must stay a quiet, unrefused no-op.
    const r = runCli(['approve', fx.RUN_ID, '--all'], fx.dbPath);
    assert.equal(r.status, 0, `--all matching zero pending findings must never refuse: ${r.stderr}`);
    assert.match(r.stdout, /Approved 0 findings/);
  });

  it('a NOT-YET-COLLECTED wave keeps rendering the plain agent-local id (no DB rows to resolve against, no crash)', () => {
    fx = seedAuditWave({ findingId: 'F-001' });
    // No collect() call — the wave is still 'dispatched', findings table empty.
    const r = runCli(['findings', fx.RUN_ID, '--format=json'], fx.dbPath);
    assert.equal(r.status, 1, `stderr: ${r.stderr}`); // findings-present exit code
    const model = JSON.parse(r.stdout);
    assert.equal(model.findings[0].id, 'F-001',
      'pre-collect, there is no canonical id yet — the digest must keep showing the agent-local id unchanged');
  });
});

// ══════════════════════════════════════════════════════════════════════
// F-87dc7b35 (LOW) — status.js documents the resume-within-wave blind spot
// it inherits from advance.js#checkViolations
// ══════════════════════════════════════════════════════════════════════

describe('F-87dc7b35: status.js\'s violations aggregator cross-references the shared LATEST_AGENT_RUN_PER_DOMAIN blind spot', () => {
  // This is a documentation-surface pin, not a behavior pin — mirrors the
  // established honesty-check pattern this package already trusts
  // (wave8-approve-disposition-honesty.test.js's source-text assertions):
  // it protects a load-bearing comment from silently disappearing in a
  // future refactor, the same way that file protects an operator-facing
  // hint string. The underlying gate-side blind spot (lib/advance.js /
  // lib/queries/latest-agent-runs.js) is NOT this domain's to fix — see
  // this file's header — so the only real, testable surface this domain
  // owns is that the cross-reference itself survives, sits at the right
  // place, and says something concrete rather than a vague gesture.
  it('the comment sits directly above the violations query and names the cross-reference, the shared filter, and the concrete reachability path', () => {
    const statusPath = join(__dirname, 'commands', 'status.js');
    const statusSrc = readFileSync(statusPath, 'utf-8');

    const queryIdx = statusSrc.indexOf('const violations = db.prepare(`');
    assert.ok(queryIdx > -1,
      'the violations aggregator query must still exist at its documented shape — extraction is broken if this fails');

    // The cross-reference must be the IMMEDIATELY preceding comment block,
    // not just present somewhere in the file — a reader landing on the SQL
    // via grep/blame must find it right there, not have to go hunting.
    const preceding = statusSrc.slice(Math.max(0, queryIdx - 2200), queryIdx);

    assert.match(preceding, /F-87dc7b35/, 'must name its own finding id (so a reader can trace it back to this pin)');
    assert.match(preceding, /F-9c41a2b7/,
      'must cross-reference the finding that documents the gate-side (lib/advance.js) blind spot');
    assert.match(preceding, /F-4220149f/,
      'must cross-reference wave-8\'s core-domain fix target for the identical underlying issue');
    assert.match(preceding, /LATEST_AGENT_RUN_PER_DOMAIN/,
      'must name the shared filter fragment so a future edit to lib/queries/latest-agent-runs.js is flagged as affecting this consumer too, not only lib/advance.js');
    assert.match(preceding, /swarm resume/,
      'must name the concrete reachability path (a superseded agent_run WITHIN a wave via resume under non-isolated dispatch), not just gesture at "a blind spot"');
    assert.match(preceding, /observability note, not a fix/i,
      'must be honest that this is documentation, not a functional close of the underlying gap — the gap itself is out of this domain');
  });

  // F-5574e29e (wave 10): the pin above only reads the COMMENT preceding
  // queryIdx — none of its five assertions look at the query itself, so a
  // future edit that quietly drops the interpolation from the real SQL (or
  // swaps in a different, still-wrong filter) while leaving the comment
  // untouched would stay green here. Mutation-probed: reverting this
  // interpolation in a scratch copy of status.js flips this pin red while
  // leaving the pin above green, confirming the two pins now cover
  // disjoint halves of the same claim rather than one silently standing in
  // for the other.
  //
  // F-3e449453 (wave 12): the FIXED `queryIdx + 300` window below originally
  // used here left only ~67 chars of slack past the interpolation's real
  // offset (233 at the time this was measured). Two benign, functionally-
  // inert SQL comment lines added ahead of the WHERE clause — an ordinary,
  // plausible future edit, e.g. a maintainer clarifying the query — push the
  // interpolation to offset ~359+ and past the window, failing this pin for
  // the WRONG reason (a slice-size accident) even though the interpolation
  // is still fully present and the query is functionally unchanged. Anchored
  // on the query's own closing `` `).get(opts.runId); `` marker instead: the
  // slice now grows and shrinks with the query's real content, so it cannot
  // be broken by an unrelated edit to the preamble. Mutation-probed both
  // directions: (a) inserting two benign comment lines between the opening
  // backtick and the WHERE clause leaves this pin green (the old fixed-300
  // version would have false-failed here); (b) removing the real
  // interpolation still flips this pin red, same as before.
  it('the query body itself — not just the comment above it — still applies the shared filter', () => {
    const statusPath = join(__dirname, 'commands', 'status.js');
    const statusSrc = readFileSync(statusPath, 'utf-8');

    const queryIdx = statusSrc.indexOf('const violations = db.prepare(`');
    assert.ok(queryIdx > -1,
      'the violations aggregator query must still exist at its documented shape — extraction is broken if this fails');

    const queryEnd = statusSrc.indexOf('`).get(opts.runId);', queryIdx);
    assert.ok(queryEnd > queryIdx,
      'the query\'s own closing `).get(opts.runId); marker must still exist — extraction is broken if this fails');

    const queryBody = statusSrc.slice(queryIdx, queryEnd);
    assert.match(queryBody, /\$\{LATEST_AGENT_RUN_PER_DOMAIN\}/,
      'the violations query must actually interpolate LATEST_AGENT_RUN_PER_DOMAIN, not merely be described as doing so by the comment above it');
  });

  // F-5574e29e (wave 10), second half: the mirror case the comment itself
  // names — "a change scoped only to lib/advance.js#checkViolations would
  // leave this operator-facing count still wrong" (status.js:135-136).
  // Neither file imports the other's query; they are two independent
  // inlined copies of the same shape, kept honest only by pins like this
  // one. Reading lib/advance.js here does not edit it — this domain
  // (package-root *.test.js) owns the read, not the file. Mutation-probed
  // against a scratch copy of advance.js with the interpolation stripped
  // from checkViolations only: this pin flips red while the two pins above
  // (which only ever read status.js) stay green, confirming this is
  // genuinely the cross-file half and not a restatement of the first pin.
  it('lib/advance.js#checkViolations — the sibling this comment cross-references by name — has not silently diverged on the same shared filter', () => {
    const advancePath = join(__dirname, 'lib', 'advance.js');
    const advanceSrc = readFileSync(advancePath, 'utf-8');

    const fnIdx = advanceSrc.indexOf('function checkViolations');
    assert.ok(fnIdx > -1,
      'lib/advance.js#checkViolations must still exist at its documented shape — this pin cross-references it by name (not by import), so a rename here needs a matching rename there');

    const fnBody = advanceSrc.slice(fnIdx, fnIdx + 600);
    assert.match(fnBody, /\$\{LATEST_AGENT_RUN_PER_DOMAIN\}/,
      'lib/advance.js#checkViolations must still apply LATEST_AGENT_RUN_PER_DOMAIN — if this is ever changed without commands/status.js:138-146 changing to match (or vice versa), the two cross-references in status.js\'s comment have silently diverged');
  });
});
