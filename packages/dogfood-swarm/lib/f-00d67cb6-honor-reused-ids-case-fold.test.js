/**
 * f-00d67cb6-honor-reused-ids-case-fold.test.js — F-00d67cb6 (MEDIUM, wave 37):
 * honorReusedFindingIds's ownership check called matchesAnyGlob with
 * `priorFile = prior.file_path || prior.file || ''` RAW, never normalized,
 * even though the file-mismatch check three lines above it already compares
 * BOTH sides through normalizePath() first. A prior row whose file_path
 * carries a capitalized directory segment (a realistic LLM-transcription
 * variant of the real, all-lowercase file on disk) made a faithful same-id
 * re-report wrongly fail the ownership check: minimatch is case-sensitive,
 * so the raw mismatch made an otherwise-owned file look unowned, and the
 * re-report was never honored (confirm_id_reuse_unowned instead).
 *
 * Fix: normalize priorFile through normalizePath() (already used at the
 * file-mismatch check) before the matchesAnyGlob ownership check — the
 * same normalize-then-match shape as that check immediately above it, and
 * the same shape used to close the sibling gap this wave at
 * commands/collect.js's scopeConfirmedToOwningDomain (F-f347d858, a
 * different domain's file, not edited here).
 *
 * Drives the REAL, unmutated honorReusedFindingIds() — never a
 * reimplementation of its ownership/matching logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { honorReusedFindingIds } from './fingerprint.js';

const DOMAINS = [{ name: 'swarm-cp-core', globs: ['packages/dogfood-swarm/lib/**'] }];

function priorMap(row) {
  return new Map([[row.fingerprint, row]]);
}

describe('F-00d67cb6 — honorReusedFindingIds normalizes the prior file_path before the ownership glob match', () => {
  /** @pins F-00d67cb6 */
  it('GATE: a prior row with a capitalized directory segment is still recognized as owned by a lowercase-glob domain', () => {
    const prior = {
      finding_id: 'F-100',
      file_path: 'Packages/Dogfood-Swarm/lib/log-stage.js', // LLM-transcription-variant casing
      status: 'recurring',
      fingerprint: 'prior-fp-0000000000000000',
    };
    const findings = [{
      id: 'F-100',
      file: 'Packages/Dogfood-Swarm/lib/log-stage.js', // same raw casing as prior -> passes the file-mismatch check
      _declaringDomain: 'swarm-cp-core',
      fingerprint: 'new-content-fp-000000000000', // differs from prior's -> exercises confirm_id_reuse_applied
      severity: 'MEDIUM',
      description: 'a faithful re-report',
    }];

    const result = honorReusedFindingIds(findings, priorMap(prior), DOMAINS);

    assert.equal(result.length, 1);
    assert.equal(result[0]._idReuseHonored, true,
      'pre-fix: the raw (unnormalized) prior file_path failed the case-sensitive minimatch ownership check, ' +
      'so a faithful re-report of an owned file was wrongly refused as confirm_id_reuse_unowned');
    assert.equal(result[0].fingerprint, prior.fingerprint,
      'an honored reuse takes the prior fingerprint so the re-report dedupes to the prior row');
  });

  it('non-regression: a prior row genuinely outside the domain\'s globs is still refused (fails closed, not wide open)', () => {
    const prior = {
      finding_id: 'F-101',
      file_path: 'packages/other-package/lib/x.js',
      status: 'recurring',
      fingerprint: 'prior-fp-1111111111111111',
    };
    const findings = [{
      id: 'F-101',
      file: 'packages/other-package/lib/x.js',
      _declaringDomain: 'swarm-cp-core',
      fingerprint: 'new-content-fp-111111111111',
      severity: 'MEDIUM',
      description: 'an out-of-domain re-report',
    }];

    const result = honorReusedFindingIds(findings, priorMap(prior), DOMAINS);

    assert.equal(result.length, 1);
    assert.notEqual(result[0]._idReuseHonored, true,
      'a genuinely out-of-domain file must still be refused — normalization must only fold case/slashes, never widen ownership');
  });

  it('non-regression: an exact-case prior row was already owned before this fix and remains so', () => {
    const prior = {
      finding_id: 'F-102',
      file_path: 'packages/dogfood-swarm/lib/log-stage.js',
      status: 'recurring',
      fingerprint: 'prior-fp-2222222222222222',
    };
    const findings = [{
      id: 'F-102',
      file: 'packages/dogfood-swarm/lib/log-stage.js',
      _declaringDomain: 'swarm-cp-core',
      fingerprint: 'new-content-fp-222222222222',
      severity: 'MEDIUM',
      description: 'an exact-case re-report',
    }];

    const result = honorReusedFindingIds(findings, priorMap(prior), DOMAINS);

    assert.equal(result[0]._idReuseHonored, true);
  });

  it('non-regression: an approved prior is still never honored, case-fold notwithstanding', () => {
    const prior = {
      finding_id: 'F-103',
      file_path: 'Packages/Dogfood-Swarm/lib/log-stage.js',
      status: 'approved',
      fingerprint: 'prior-fp-3333333333333333',
    };
    const findings = [{
      id: 'F-103',
      file: 'Packages/Dogfood-Swarm/lib/log-stage.js',
      _declaringDomain: 'swarm-cp-core',
      fingerprint: 'new-content-fp-333333333333',
      severity: 'MEDIUM',
      description: 'a re-confirmation while queued for amend',
    }];

    const result = honorReusedFindingIds(findings, priorMap(prior), DOMAINS);

    assert.notEqual(result[0]._idReuseHonored, true,
      'the approved-window rule must still short-circuit before the ownership check ever runs');
  });
});
