/**
 * f-166ab759-wave-brief-size-warn.test.js — F-166ab759 (HIGH): zero
 * enforcement anywhere in this package of any size/line bound on a
 * generated wave-brief .md file. T4's roadmap-digest injection is bounded
 * (ROADMAP_DIGEST_TOP_K, commands/dispatch.js) but the REST of an
 * audit-phase brief — specifically the global findings-history section
 * (`priorContext`/`openPriorContext`, built from lib/fingerprint.js's
 * buildPriorMap, which pulls EVERY non-rejected finding for the run with no
 * domain filter and injects the full list into every domain's prompt) — was
 * free to grow unbounded wave over wave. Measured live against this run's
 * own on-disk history (276 real briefs, wc -c): 2,573 bytes (wave 1) up to
 * 1,090,242 bytes (wave 44, the current latest), with every `*-audit`-phase
 * wave since wave 28 (753,134 bytes, the first to cross it) exceeding
 * WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES (750,000) — see that constant's own
 * doc comment in commands/dispatch.js for the full distribution writeup.
 *
 * Fixed by a WARN-first logStage('wave_brief_oversized', ...) check at the
 * one point every prompt-writing path (audit, feature-audit, amend, the
 * generic fallback) already funnels through: immediately before
 * atomicWriteFileSync in dispatch()'s per-agent loop. WARN only — the live
 * corpus already exceeds the ceiling on every recent audit wave, so a hard
 * gate would brick this very run's own next dispatch (see the threshold
 * constant's comment for why 750,000 specifically, and why WARN-not-fail).
 *
 * This file drives dispatch() DIRECTLY (in-process, matching
 * amend2-d3b-002-dispatch-tx.test.js's own established fixture pattern —
 * dispatch() needs no real git checkout on the non---isolate path) and
 * captures console.error the way f-00c2b7fd-drain-degradation-warning.test.js
 * already established for this exact "WARN via logStage, prove it fires AND
 * prove it stays quiet" shape: DOGFOOD_LOG_HUMAN=0 isolates the NDJSON line
 * from its human-banner companion, and only this fix's own `stage` is
 * filtered out of whatever else logStage emits during a real dispatch.
 *
 * RED-ABLE, proven by temporary mutation (see this lane's own report for
 * the exact before/after transcript): with the wave_brief_oversized
 * logStage call site in commands/dispatch.js commented out, the OVERSIZED
 * test below failed (zero lines captured) while the QUIET test kept passing
 * trivially (it asserts an empty array, which an entirely-removed call site
 * still satisfies) — restoring the call site returned the suite to green.
 *
 * CLASS EXTENSION (same wave, coordinator-granted scope): the sibling sweep
 * for this finding found the package's one OTHER brief-write site —
 * commands/resume.js's redispatch loop (buildAmendPrompt/buildAuditPrompt →
 * atomicWriteFileSync into wave-<N>-resume/) — with the identical zero-bound
 * shape. Fixed with the SAME check against the SAME exported constant
 * (imported over resume.js's pre-existing ./dispatch.js edge, alongside
 * SKIP_VERIFY_DIRECTIVE — no new import edge, no duplicated number), tagged
 * `context: 'resume_redispatch'` in the shared stage. The resume-path
 * growth vector differs from dispatch's: resume's audit branch rebuilds
 * prompts WITHOUT priorContext/openPriorContext, so its briefs balloon via
 * ROUTED APPROVED FINDINGS on the amend branch instead — the resume
 * subtests below drive exactly that vector. Red-proof for the resume site
 * was run the same way (call site deleted, only the resume OVERSIZED
 * subtest failed while every dispatch subtest stayed green — a
 * discriminating red — then restored).
 */

import { describe, it, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch, WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES } from './commands/dispatch.js';
import { resume } from './commands/resume.js';

const ORIGINAL_CONSOLE_ERROR = console.error;
const ORIGINAL_DOGFOOD_LOG_HUMAN = process.env.DOGFOOD_LOG_HUMAN;
let capturedLines;

beforeEach(() => {
  capturedLines = [];
  // Isolate the NDJSON line from the human-banner companion (log-stage.js's
  // own convention) so each logStage call captures as exactly one parseable
  // line here, matching f-00c2b7fd-drain-degradation-warning.test.js.
  process.env.DOGFOOD_LOG_HUMAN = '0';
  console.error = (...args) => capturedLines.push(args.join(' '));
});

afterEach(() => {
  console.error = ORIGINAL_CONSOLE_ERROR;
  if (ORIGINAL_DOGFOOD_LOG_HUMAN === undefined) delete process.env.DOGFOOD_LOG_HUMAN;
  else process.env.DOGFOOD_LOG_HUMAN = ORIGINAL_DOGFOOD_LOG_HUMAN;
});

/** Only this fix's own stage — logStage may emit other NDJSON lines during a real dispatch (e.g. wave_dispatched). */
function oversizedLines() {
  return capturedLines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((l) => l && l.stage === 'wave_brief_oversized');
}

const tmpRoots = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

/**
 * Seeds a run with ONE owned domain (frozen) and `count` synthetic findings
 * rows, each carrying a `descLength`-byte (ASCII, so byte length ==
 * character count) description. With the default status 'new':
 * buildPriorMap (lib/fingerprint.js) has no domain filter — it pulls every
 * non-rejected finding for the run — so these rows reach EVERY domain's
 * audit-phase priorContext/openPriorContext regardless of file_path, which
 * is exactly the unbounded-growth shape this finding describes on the
 * DISPATCH path. With status 'approved': findingsForDomain routes them into
 * amend-phase briefs via the glob match, the growth vector on the RESUME
 * path (whose audit branch rebuilds prompts without priorContext at all).
 * Returns { dbPath, tmpDir }.
 */
function seedOversizedRun(runId, count, descLength, { status = 'new' } = {}) {
  const tmpDir = makeTmpDir(`f166ab759-${runId}-`);
  const dbPath = join(tmpDir, 'control-plane.db');
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`
  ).run(runId, join(tmpDir, 'repo'), 'a'.repeat(40));
  saveDomainDraft(db, runId, [
    { name: 'only-domain', globs: ['packages/only/**'], ownership_class: 'owned' },
  ]);
  freezeDomains(db, runId);

  const insertFinding = db.prepare(
    `INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
     VALUES (?, ?, ?, 'LOW', 'production-readiness', ?, ?, ?)`
  );
  const filler = 'x'.repeat(descLength);
  for (let i = 0; i < count; i++) {
    const id = `F-synthetic-${String(i).padStart(6, '0')}`;
    insertFinding.run(runId, id, `fp-${id}`, 'packages/only/synthetic.js', `${filler}-${i}`, status);
  }
  closeDb(dbPath);
  return { dbPath, tmpDir };
}

/** @pins F-166ab759 */
describe('dispatch() wave-brief size WARN (F-166ab759)', () => {
  it('OVERSIZED: a brief whose global findings-history pushes it past the threshold fires exactly one wave_brief_oversized warning naming the domain, byte size, and threshold — and the real file on disk matches that size', () => {
    // 1000 findings x ~1000-byte descriptions -> well over 1,000,000 bytes
    // of raw description text alone (plus per-line overhead), a robust
    // margin above the 750,000-byte threshold — not a borderline value that
    // could flake on template-overhead drift, and the same order of
    // magnitude as this run's own real wave-44 briefs (~1.09MB).
    const runId = 'run-oversized';
    const { dbPath, tmpDir } = seedOversizedRun(runId, 1000, 1000);

    const result = dispatch({
      runId,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(result.agents.length, 1, 'one domain dispatched');

    const warnings = oversizedLines();
    assert.equal(warnings.length, 1, `expected exactly one wave_brief_oversized line; captured stderr:\n${capturedLines.join('\n')}`);
    const w = warnings[0];
    assert.equal(w.runId, runId);
    assert.equal(w.domain, 'only-domain');
    assert.equal(w.thresholdBytes, WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES);
    assert.ok(w.byteSize > WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES,
      `byteSize (${w.byteSize}) must exceed the threshold (${WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES})`);
    assert.ok(typeof w.waveNumber === 'number' && w.waveNumber >= 1);
    assert.equal(w.phase, 'health-audit-a');

    // Cross-check: the logged byteSize matches the REAL file this dispatch
    // actually wrote — the warning is not just loud, it is accurate.
    const agent = result.agents[0];
    const onDiskSize = statSync(agent.promptPath).size;
    assert.equal(w.byteSize, onDiskSize,
      'the logged byteSize must equal the real on-disk file size (Buffer.byteLength, not the JS string .length)');
    assert.ok(onDiskSize > WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES);

    closeDb(dbPath);
  });

  it('QUIET: an ordinary small brief (few short findings) writes normally with ZERO wave_brief_oversized warnings', () => {
    const runId = 'run-quiet';
    const { dbPath, tmpDir } = seedOversizedRun(runId, 3, 40);

    const result = dispatch({
      runId,
      phase: 'health-audit-a',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(result.agents.length, 1);

    assert.deepEqual(oversizedLines(), [],
      `an ordinary small brief must never warn; captured stderr:\n${capturedLines.join('\n')}`);

    const agent = result.agents[0];
    const onDiskSize = statSync(agent.promptPath).size;
    assert.ok(onDiskSize < WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES,
      `fixture sanity: the quiet-path brief (${onDiskSize} bytes) must actually be under the threshold, or this test proves nothing`);
    // Fixture sanity, mirroring F-6a5eb347's non-vacuity floor cited in this
    // finding's own recommendation text: the file must be real and non-empty,
    // not an accidentally-empty write that would trivially pass either test.
    const content = readFileSync(agent.promptPath, 'utf-8');
    assert.ok(content.length > 100, 'the quiet-path brief must be a real, non-trivial prompt');

    closeDb(dbPath);
  });

  it('an AMEND-phase brief against the SAME oversized-findings DB state stays quiet (amend prompts are scoped to routed approved findings, not the global priorContext/openPriorContext audit briefs carry)', () => {
    const runId = 'run-amend-unaffected';
    const { dbPath, tmpDir } = seedOversizedRun(runId, 1000, 1000);
    // None of the seeded findings are 'approved', so findingsForDomain
    // routes zero findings to the one domain on an amend-phase dispatch —
    // the amend prompt stays at its ordinary small size regardless of how
    // large the global findings table is, since isAudit gates
    // priorContext/openPriorContext construction (commands/dispatch.js).
    const result = dispatch({
      runId,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(result.agents.length, 1);
    assert.deepEqual(oversizedLines(), [],
      `an amend-phase brief must not inherit the audit-phase priorContext growth; captured stderr:\n${capturedLines.join('\n')}`);

    closeDb(dbPath);
  });
});

/**
 * The class's second write site (commands/resume.js's redispatch loop) —
 * see this file's header "CLASS EXTENSION" note. Fixture pattern follows
 * dispatch-amend-filter.test.js's own established resume block: dispatch a
 * real amend wave (creates the wave + agent_runs rows resume() needs), flip
 * the agent to a redispatchable status, then let resume() rebuild the brief
 * in-process. capturedLines is reset between the dispatch and resume calls
 * so each assertion sees ONLY the resume-path stderr — the oversized
 * fixture's dispatch necessarily fires the dispatch-path warn first, which
 * is the sibling site's job, not this suite's subject.
 */
/** @pins F-166ab759 */
describe('resume() redispatch-brief size WARN (F-166ab759 — class extension to the second write site)', () => {
  function seedFailedAmendWave(runId, count, descLength) {
    const { dbPath, tmpDir } = seedOversizedRun(runId, count, descLength, { status: 'approved' });
    const dispatchResult = dispatch({
      runId,
      phase: 'health-amend-a',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(dispatchResult.agents.length, 1, 'fixture sanity: one agent dispatched');
    // Redispatchable state — resume() rebuilds the brief only for these.
    const db = openDb(dbPath);
    db.prepare("UPDATE agent_runs SET status = 'failed'").run();
    // Only the resume path is under test from here on.
    capturedLines.length = 0;
    return { dbPath, tmpDir };
  }

  it('RESUME OVERSIZED: a redispatch brief ballooned by routed approved findings fires exactly one wave_brief_oversized warning tagged context=resume_redispatch — and the logged byteSize matches the wave-N-resume file on disk', () => {
    const runId = 'run-resume-oversized';
    const { dbPath, tmpDir } = seedFailedAmendWave(runId, 1000, 1000);

    const report = resume({ runId, dbPath, outputDir: tmpDir });
    assert.equal(report.action, 'redispatched');
    assert.equal(report.redispatch.length, 1, 'the failed agent must be redispatched');

    const warnings = oversizedLines();
    assert.equal(warnings.length, 1,
      `expected exactly one wave_brief_oversized line from the resume path; captured stderr:\n${capturedLines.join('\n')}`);
    const w = warnings[0];
    assert.equal(w.context, 'resume_redispatch',
      'the resume-path warning must be distinguishable from the dispatch-path one within the shared stage');
    assert.equal(w.runId, runId);
    assert.equal(w.domain, 'only-domain');
    assert.equal(w.phase, 'health-amend-a');
    assert.equal(w.thresholdBytes, WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES,
      'one threshold, one owner — the resume site must report the SAME constant dispatch.js exports');
    assert.ok(w.byteSize > WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES,
      `byteSize (${w.byteSize}) must exceed the threshold`);

    const promptPath = report.redispatch[0].promptPath;
    assert.match(promptPath.replace(/\\/g, '/'), /wave-1-resume\//,
      'the redispatch brief must live in the wave-N-resume dir, not the original wave dir');
    assert.equal(w.byteSize, statSync(promptPath).size,
      'the logged byteSize must equal the real on-disk redispatch-brief size');

    closeDb(dbPath);
  });

  it('RESUME QUIET: an ordinary small redispatch brief writes normally with ZERO wave_brief_oversized warnings', () => {
    const runId = 'run-resume-quiet';
    const { dbPath, tmpDir } = seedFailedAmendWave(runId, 3, 40);

    const report = resume({ runId, dbPath, outputDir: tmpDir });
    assert.equal(report.action, 'redispatched');
    assert.equal(report.redispatch.length, 1);

    assert.deepEqual(oversizedLines(), [],
      `an ordinary small redispatch brief must never warn; captured stderr:\n${capturedLines.join('\n')}`);

    const promptPath = report.redispatch[0].promptPath;
    const onDiskSize = statSync(promptPath).size;
    assert.ok(onDiskSize < WAVE_BRIEF_SIZE_WARN_THRESHOLD_BYTES,
      `fixture sanity: the quiet-path redispatch brief (${onDiskSize} bytes) must actually be under the threshold, or this test proves nothing`);
    const content = readFileSync(promptPath, 'utf-8');
    assert.ok(content.length > 100, 'the quiet-path redispatch brief must be a real, non-trivial prompt');
    // Non-vacuity: the routed findings genuinely reached the rebuilt brief —
    // a redispatch brief that silently dropped its findings would pass the
    // size assertions above while proving nothing about the real write path.
    assert.match(content, /F-synthetic-000000/,
      'the rebuilt amend brief must actually carry the routed approved findings');

    closeDb(dbPath);
  });
});
