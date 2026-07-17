/**
 * open-prior-confirmation-brief.test.js — the audit brief must never tell an
 * agent to ignore an OPEN finding.
 *
 * THE DEFECT. classifyFindings (lib/fingerprint.js) closes an absent prior as
 * `fixed` when the wave had full domain coverage — deliberately, and pinned by
 * three separate findings (B-BACK-003, CP4-SCOPE-WIRING, F-2c6d825d). That
 * inference is sound on exactly one condition: the agent WOULD have re-reported
 * the defect had it still been there. buildAuditPrompt used to emit every prior
 * — open and closed alike — under one flat heading:
 *
 *     ## Prior Findings (do NOT re-report these)
 *
 * which makes the condition unsatisfiable. The agent is ordered not to report
 * the open ones, its silence is therefore guaranteed, and the classifier reads
 * that guaranteed silence as positive evidence of a fix. The evidence is
 * manufactured by the instruction that forbids the evidence.
 *
 * WHAT IT COST. Run swarm-1784091637-5127, wave 28: an audit-only Stage B wave
 * with NO amend wave between it and wave 27. Nothing could have been fixed —
 * exactly one commit separated the two collects and it touched two doc files.
 * The wave closed all 11 open priors anyway. Two were genuinely fixed (the doc
 * pair); nine were untouched code findings that silently left the queue, and
 * Stage C would never have amended them because the system believed they were
 * done. Audited against that run's entire history: of 297 rows marked `fixed`,
 * exactly those 11 carried no `approved` event and the other 286 all did.
 *
 * NOT THE FIRST TIME. F-bd8b4353 caught this same lie as a one-off ("a false
 * entry in the swarm's own fix ledger... the exact 'self-reported pass, not
 * provenance-confirmed' failure mode this repo's whole product thesis exists to
 * prevent") and it was closed by correcting the two affected template files —
 * the instance — while the mechanism that invented the entry went untouched. It
 * then did it again, to nine findings. This file is the mechanism half.
 *
 * WHY THE FIX IS IN THE BRIEF AND NOT THE CLASSIFIER. Gating the classifier on
 * "was this ever approved for amend?" was tried first and is wrong: under a
 * corrected brief, an agent that genuinely verifies a never-approved finding is
 * gone SHOULD be able to close it (defects do get fixed incidentally by a
 * sibling's amend). Gating on approval would strand those as permanent zombies.
 * The classifier's contract is coherent; the brief was breaking its premise.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAuditPrompt } from './lib/templates.js';
import { isOpenFinding, CLOSED_FINDING_STATUSES } from './lib/finding-status.js';
import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';

const BASE = {
  repo: 'org/r',
  repoPath: '/tmp/r',
  domainName: 'backend',
  globs: ['packages/verify/**'],
  phase: 'health-audit-b',
  waveNumber: 28,
};

const line = (status, id) => `- [${status}] ${id}: something is wrong (packages/verify/x.js)`;

/** The prompt's two prior blocks, sliced apart at their headings. */
function sections(prompt) {
  const closedIdx = prompt.indexOf('## Prior Findings');
  const openIdx = prompt.indexOf('## Known OPEN findings');
  const lensIdx = prompt.indexOf('## Output Contract') >= 0
    ? prompt.indexOf('## Output Contract')
    : prompt.indexOf('## Output Format');
  return {
    closed: closedIdx < 0 ? '' : prompt.slice(closedIdx, openIdx > closedIdx ? openIdx : lensIdx),
    open: openIdx < 0 ? '' : prompt.slice(openIdx, lensIdx > openIdx ? lensIdx : undefined),
  };
}

describe('the audit brief must never order an agent to ignore an OPEN finding', () => {
  it('an open prior lands in the CONFIRM block and NEVER inside the do-not-re-report block', () => {
    const prompt = buildAuditPrompt({
      ...BASE,
      priorContext: line('fixed', 'F-CLOSED-1'),
      openPriorContext: line('new', 'F-OPEN-1'),
    });
    const { closed, open } = sections(prompt);

    assert.ok(open.includes('F-OPEN-1'), 'the open prior must reach the agent as a confirmation item');
    assert.ok(
      !closed.includes('F-OPEN-1'),
      'THE BUG: an open prior inside the do-not-re-report block makes its absence '
        + 'guaranteed, and classifyFindings then reads that silence as proof of a fix',
    );
    assert.ok(closed.includes('F-CLOSED-1'), 'a closed prior still belongs in the do-not-re-report block');
    assert.ok(!open.includes('F-CLOSED-1'), 'a closed prior must not be queued for confirmation');
  });

  it('the CONFIRM block states all three outcomes, and names the DECLARATION as what closes a finding', () => {
    const { open } = sections(buildAuditPrompt({ ...BASE, openPriorContext: line('new', 'F-OPEN-1') }));

    assert.match(open, /[Ss]till present/, 'must tell the agent what to do when the defect is still there');
    assert.match(open, /recurring/, 'must say a re-report is recorded as recurring, not rejected as a duplicate');
    assert.match(open, /`confirmed`/, 'must name the declaration field — it is the mechanism, not prose');
    assert.match(open, /omit/i, 'must tell the agent to omit a verified-gone finding from `findings`');
    assert.match(open, /closes it/, 'must say plainly what the declaration does');
    assert.match(open, /[Dd]id not check/, 'must give the agent an explicit not-checked path');
    assert.ok(
      !/do NOT re-report/i.test(open),
      'the confirm block must not inherit the do-not-report instruction it exists to undo',
    );

    // The contract INVERTED when scope stopped being lens-blind, and this
    // assertion is what stops the old one creeping back in a future reword.
    // The brief used to say silence closes a finding — true then, and the
    // reason a typography-hunting stage-d agent could close a defensive-coding
    // finding by never looking at it. Now the DECLARATION closes it and silence
    // is inert (classifyFindings: an id absent from `confirmed` goes
    // `unverified`, not `fixed`). A brief that still promises an agent its
    // silence is authoritative is lying to it about its own leverage.
    assert.ok(
      !/silence is the ONLY thing that closes it/i.test(open),
      'the brief must not tell an agent that silence closes a finding — it no longer does',
    );
    assert.ok(
      !/on your authority/i.test(open) || /`confirmed`/.test(open),
      'any "on your authority" framing must be attached to the declaration, never to silence',
    );
  });

  it('the closed block keeps its do-not-re-report instruction (this fix must not invert it)', () => {
    const { closed } = sections(buildAuditPrompt({ ...BASE, priorContext: line('fixed', 'F-CLOSED-1') }));
    assert.match(closed, /do NOT re-report/i);
    assert.match(closed, /CLOSED/,
      'the heading must say WHICH priors it covers — the unqualified original is what swept open ones in');
  });

  it('every CLOSED status routes to the closed block and every open status to the confirm block', () => {
    // Bound to finding-status.js rather than a hand-written list, so a new
    // status cannot silently pick the wrong block. This IS the routing rule
    // dispatch.js applies (`isOpenFinding(f.status) ? openLines : closedLines`).
    for (const status of CLOSED_FINDING_STATUSES) {
      assert.equal(isOpenFinding(status), false, `${status} must route to the do-not-re-report block`);
    }
    for (const status of ['new', 'recurring', 'approved', 'unverified']) {
      assert.equal(
        isOpenFinding(status), true,
        `${status} is OPEN and must reach the agent as a confirmation item — `
          + 'routing it to the do-not-re-report block re-creates the false-fixed defect',
      );
    }
  });

  it('omitting openPriorContext emits no confirm block at all (no empty-section noise)', () => {
    const prompt = buildAuditPrompt({ ...BASE, priorContext: line('fixed', 'F-CLOSED-1') });
    assert.ok(!prompt.includes('## Known OPEN findings'));
  });

  it('the two blocks stay separate even when both are populated (non-vacuity of the split)', () => {
    const prompt = buildAuditPrompt({
      ...BASE,
      priorContext: [line('fixed', 'F-C1'), line('deferred', 'F-C2')].join('\n'),
      openPriorContext: [line('new', 'F-O1'), line('recurring', 'F-O2')].join('\n'),
    });
    const { closed, open } = sections(prompt);
    assert.ok(closed.includes('F-C1') && closed.includes('F-C2'));
    assert.ok(open.includes('F-O1') && open.includes('F-O2'));
    for (const openId of ['F-O1', 'F-O2']) {
      assert.ok(!closed.includes(openId), `${openId} leaked into the do-not-re-report block`);
    }
  });
});

/**
 * F-1a877be1 — the integration seam: a REAL dispatch() call, not a
 * hand-built priorContext/openPriorContext string.
 *
 * Every test above proves buildAuditPrompt slots pre-built strings into the
 * right heading (the template layer), and isOpenFinding's classification is
 * exhaustively checked elsewhere (wave12-swarm-cp-pins.test.js). Nothing
 * anywhere drove the actual production wiring that PRODUCES those two
 * strings from real DB rows — dispatch.js:499-511's
 * `(isOpenFinding(f.status) ? openLines : closedLines).push(line)` inside
 * `if (isAudit) { const priorMap = buildPriorMap(db, opts.runId); ... }` —
 * end to end: seed real findings rows with mixed status, call the real
 * exported dispatch() in an audit phase, read the prompt file it actually
 * wrote to disk, and assert the routing there. The mechanism is proven
 * correct in isolation by every test above; this is the one call site that
 * wires it to production data — the exact site that already shipped the
 * "wave 28 closed 9 untouched findings" defect this file exists to catch —
 * and it had zero coverage. An accidental revert of dispatch.js:508's
 * ternary (or a future refactor of the surrounding loop) would silently
 * recreate that defect undetected by any test in this package.
 */

// No `@pins F-1a877be1` tag, deliberately, and the gate is right to demand
// that. F-1a877be1 was a MISSING-COVERAGE finding: the routing at
// dispatch.js:508 was already correct (proven by reverting it and watching this
// suite go red), so the amend added a test and changed no source. A declared
// tag cross-references a SOURCE pin; with no source change there is no pin to
// match, and the tag dangles — which is exactly what the gate reported on this
// wave's merge. Same disposition as F-7d4ac5ce.
describe('the real dispatch() pipeline routes DB-sourced priors the same way the template layer promises', () => {
  const INTEGRATION_RUN_ID = 'test-open-prior-integration';
  let tmpDir;
  let dbPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'open-prior-integration-'));
    dbPath = join(tmpDir, 'control-plane.db');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, ?, ?, ?, 'main', 'pending')`)
      .run(INTEGRATION_RUN_ID, 'org/repo', tmpDir, 'a'.repeat(40));
    saveDomainDraft(db, INTEGRATION_RUN_ID, [
      { name: 'backend', globs: ['packages/verify/**'], ownership_class: 'owned' },
    ]);
    freezeDomains(db, INTEGRATION_RUN_ID);

    // buildPriorMap (lib/fingerprint.js) selects every findings row for this
    // run regardless of domain, and dispatch.js:499-511 buckets ALL of them
    // by isOpenFinding(status) ONCE, before the per-domain loop -- every
    // agent in the dispatch gets the identical priorContext/openPriorContext
    // pair. One owned domain is enough to prove the routing end to end.
    const insertFinding = db.prepare(`
      INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, description, status)
      VALUES (?, ?, ?, 'MEDIUM', 'proactive', ?, ?, ?)
    `);
    insertFinding.run(INTEGRATION_RUN_ID, 'F-OPEN-NEW', 'fp-open-new', 'packages/verify/x.js', 'still-open new finding', 'new');
    insertFinding.run(INTEGRATION_RUN_ID, 'F-OPEN-APPROVED', 'fp-open-approved', 'packages/verify/y.js', 'still-open approved finding', 'approved');
    insertFinding.run(INTEGRATION_RUN_ID, 'F-CLOSED-FIXED', 'fp-closed-fixed', 'packages/verify/z.js', 'genuinely fixed finding', 'fixed');
    insertFinding.run(INTEGRATION_RUN_ID, 'F-CLOSED-DEFERRED', 'fp-closed-deferred', 'packages/verify/w.js', 'consciously deferred finding', 'deferred');
    closeDb(dbPath);
  });

  afterEach(() => {
    closeDb(dbPath);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a real dispatch() audit call routes DB-sourced findings into the correct section on disk', () => {
    const result = dispatch({
      runId: INTEGRATION_RUN_ID,
      phase: 'health-audit-b',
      dbPath,
      outputDir: tmpDir,
    });
    assert.equal(result.agents.length, 1, 'expected exactly one agent for the single owned domain');

    const prompt = readFileSync(result.agents[0].promptPath, 'utf-8');
    const { closed, open } = sections(prompt);

    assert.ok(open.includes('F-OPEN-NEW'), 'a real "new" DB row must reach the CONFIRM block');
    assert.ok(open.includes('F-OPEN-APPROVED'), 'a real "approved" DB row must reach the CONFIRM block');
    assert.ok(closed.includes('F-CLOSED-FIXED'), 'a real "fixed" DB row belongs in the do-not-re-report block');
    assert.ok(closed.includes('F-CLOSED-DEFERRED'), 'a real "deferred" DB row belongs in the do-not-re-report block');

    // THE PROOF this gap was about: neither open finding may ALSO appear in
    // the closed block (and vice versa), driven through the real DB ->
    // dispatch() -> disk seam instead of a hand-built string.
    assert.ok(!closed.includes('F-OPEN-NEW'), 'THE BUG: an open finding must never leak into the do-not-re-report block');
    assert.ok(!closed.includes('F-OPEN-APPROVED'), 'THE BUG: an open finding must never leak into the do-not-re-report block');
    assert.ok(!open.includes('F-CLOSED-FIXED'), 'a closed finding must not be queued for re-confirmation');
    assert.ok(!open.includes('F-CLOSED-DEFERRED'), 'a closed finding must not be queued for re-confirmation');
  });
});
