/**
 * f-8f44c67f-confirm-queue-scope-honesty.test.js — F-8f44c67f (MEDIUM, wave
 * 30): buildAuditPrompt's CONFIRM-queue heading read "## Known OPEN findings
 * in your scope — CONFIRM each one" (lib/templates.js) — an unconditional
 * scope claim that commands/dispatch.js never enforces. dispatch.js builds
 * openPriorContext ONCE per wave from the ENTIRE run's prior map (no domain
 * or glob filter — buildPriorMap(db, runId) has no WHERE on file_path) and
 * splices the IDENTICAL string into every domain agent's prompt. Empirically
 * (wave 30's own confirm queue): of 33 entries, only 4 (12%) were inside the
 * receiving domain's owned globs — the other 29 named files that domain
 * structurally cannot read or act on, while the heading told it otherwise.
 *
 * THE FIX IS IN THIS DOMAIN'S OWNED FILE ONLY. Filtering openPriorContext by
 * domain.globs is commands/dispatch.js's call — out of packages/dogfood-swarm/
 * lib/**'s owned globs, flagged rather than fixed here (see this wave's
 * output.json). Instead this pins the OTHER lawful fix named by the finding:
 * the heading and body now describe what dispatch.js actually does (a
 * run-wide queue) and instruct the agent to self-filter and disclose the
 * out-of-domain remainder in its summary, rather than asserting a
 * pre-filtered fact that is false for most of a typical wave's queue.
 *
 * CROSS-DOMAIN TEST-HOME NOTE: the finding's own suggested fix names
 * open-prior-confirmation-brief.test.js as the place to pin a cross-domain
 * fixture. That file lives at the package ROOT, outside this domain's owned
 * globs (packages/dogfood-swarm/lib/**, db/**, persist-results.js) — this
 * wave's brief is explicit that lib/*.test.js is this domain's test surface,
 * so the pin lives here instead, against the same exported buildAuditPrompt
 * that file already exercises. Read-verified this does not collide with or
 * duplicate that file's own assertions (it asserts wording this fix does not
 * touch: "Still present"/"recurring"/"confirmed"/"omit"/"closes it"/"Did not
 * check"/no "do NOT re-report" bleed/no "silence is the ONLY thing" — all
 * still true post-fix, see the non-regression test below).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuditPrompt } from './templates.js';

const BASE = {
  repo: 'org/r',
  repoPath: '/tmp/r',
  domainName: 'swarm-cp-core',
  globs: ['packages/verify/**'],
  phase: 'health-audit-b',
  waveNumber: 30,
};

// A finding whose path sits OUTSIDE BASE.globs — mirrors the finding's own
// live proof (a domain scoped to packages/verify/** confirming a queue entry
// that names packages/report/status.js).
const CROSS_DOMAIN_LINE = '- [approved] F-19d78ede: something is wrong (packages/report/status.js)';

/** @pins F-8f44c67f */
describe('F-8f44c67f — the CONFIRM-queue heading does not claim a scope dispatch.js never filters to', () => {
  it('GATE: the heading no longer asserts the queue below is "in your scope" as an unconditional fact', () => {
    const prompt = buildAuditPrompt({ ...BASE, openPriorContext: CROSS_DOMAIN_LINE });

    assert.ok(
      !/## Known OPEN findings in your scope — CONFIRM each one/.test(prompt),
      'pre-fix: the heading claimed domain-scoping that commands/dispatch.js (unfiltered buildPriorMap) never performs',
    );
    assert.match(
      prompt, /## Known OPEN findings across the run/,
      'the heading must describe the queue as run-wide, matching what dispatch.js actually builds',
    );
  });

  it('the body tells the agent a listed id may belong to another domain, and what to do about it', () => {
    const prompt = buildAuditPrompt({ ...BASE, openPriorContext: CROSS_DOMAIN_LINE });
    assert.match(
      prompt, /outside your domain|outside the globs/i,
      'must disclose that entries outside this domain\'s own globs are expected, not an error',
    );
    assert.match(
      prompt, /different agent|another (agent|domain)|domain owns/i,
      'must say the out-of-domain entries belong to a different agent/domain, not silently drop the point',
    );
    assert.match(
      prompt, /summary/i,
      'must still give the agent a way to disclose an out-of-domain (or unchecked) id',
    );
  });

  it('non-regression: the wave-28/CP4 confirm mechanism this heading sits above is untouched by the wording fix', () => {
    const prompt = buildAuditPrompt({ ...BASE, openPriorContext: CROSS_DOMAIN_LINE });
    // Same load-bearing wording open-prior-confirmation-brief.test.js pins
    // (package-root, out of this domain) — re-asserted here as a guard against
    // this file's own edit accidentally regressing them, not a duplicate of
    // that file's ownership.
    assert.match(prompt, /[Ss]till present/);
    assert.match(prompt, /recurring/);
    assert.match(prompt, /`confirmed`/);
    assert.match(prompt, /omit/i);
    assert.match(prompt, /closes it/);
    assert.match(prompt, /[Dd]id not check/);
    assert.ok(!/do NOT re-report/i.test(prompt.slice(prompt.indexOf('## Known OPEN findings'))));
    assert.ok(!/silence is the ONLY thing that closes it/i.test(prompt));
  });

  it('healthy path: an in-domain entry still renders under the corrected heading (no vacuous match)', () => {
    const prompt = buildAuditPrompt({
      ...BASE,
      openPriorContext: '- [approved] F-IN-DOMAIN: something is wrong (packages/verify/x.js)',
    });
    assert.match(prompt, /## Known OPEN findings across the run/);
    assert.ok(prompt.includes('F-IN-DOMAIN'));
  });
});
