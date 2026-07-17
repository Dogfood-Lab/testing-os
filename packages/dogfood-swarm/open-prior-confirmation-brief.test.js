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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuditPrompt } from './lib/templates.js';
import { isOpenFinding, CLOSED_FINDING_STATUSES } from './lib/finding-status.js';

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
