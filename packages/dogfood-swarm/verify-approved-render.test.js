/**
 * verify-approved-render.test.js
 *
 * F-VERIFYCLI-001 — verify-approved INVERTS the offending semantic. Its
 * real offending set is drift = summary.verified + summary.regressed, and
 * it overrides thresholdExceeded + exitCode via approvalExitCode(). But it
 * reused renderVerifyFixedDelta verbatim, which computed offending for the
 * verify-fixed semantic (regressed + claimedButStillPresent). The result:
 * an operator running `swarm verify-approved` in a TTY saw a contradictory
 * report — a non-zero/EXCEEDED verdict next to "offending 0" and a "zero
 * claims failed" headline. Exit code was correct; the human-facing text
 * was self-contradictory.
 *
 * These tests pin the FULL invariant: for a verify-approved drift model
 * (verified=1 → exitCode 1 → thresholdExceeded), the rendered offending
 * count and the headline must MATCH the non-zero / EXCEEDED verdict. The
 * verify-fixed path must stay unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderVerifyFixedText,
  renderVerifyFixedMarkdown,
} from './lib/findings-render.js';

// A verify-approved drift model: the approved finding's anchor is gone
// (`verified` = drift), so exitCode is 1 and the threshold is exceeded.
function approvedDriftModel() {
  return {
    schema: 'verify-approved-delta/v1',
    verb: 'verify-approved',
    runId: 'r1',
    waveNumber: 9,
    checkedAt: '2026-06-29T00:00:00.000Z',
    summary: { total: 1, verified: 1, regressed: 0, claimedButStillPresent: 0, unverifiable: 0 },
    threshold: 0,
    thresholdExceeded: true,
    exitCode: 1,
    findings: [{
      finding_id: 'F-DRIFT', fingerprint: 'fpD', classification: 'verified',
      file: 'src/a.js', line: 42, symbol: 'gonePhantom', severity: 'HIGH',
      description: 'leak', evidence: 'anchor /\\bgonePhantom\\b/ no longer present',
    }],
  };
}

describe('verify-approved render — offending semantic is verb-aware (F-VERIFYCLI-001)', () => {
  it('text: drift verdict (exit 1 / EXCEEDED) is not contradicted by offending 0', () => {
    const out = renderVerifyFixedText(approvedDriftModel());

    // The non-zero verdict must be present.
    assert.match(out, /EXCEEDED/, 'EXCEEDED verdict must appear');

    // The threshold line must report the offending DRIFT count (1), not 0.
    const thresholdLine = out.split('\n').find((l) => /^Threshold:/.test(l));
    assert.ok(thresholdLine, 'a Threshold: line must be rendered');
    assert.match(thresholdLine, /offending[^:]*:\s*1\b/, `offending count must be 1, got: ${thresholdLine}`);

    // The headline must NOT claim everything verified / zero failures.
    assert.doesNotMatch(out, /All 1 fix claim\(s\) verified/);
    assert.doesNotMatch(out, /VERDICT:\s*All\b/);
    // It must reflect the drift count.
    assert.match(out, /VERDICT:.*\b1\b/);
  });

  it('markdown: drift verdict (EXCEEDED) is not contradicted by offending 0', () => {
    const out = renderVerifyFixedMarkdown(approvedDriftModel());
    assert.match(out, /EXCEEDED/, 'EXCEEDED verdict must appear');
    const thresholdLine = out.split('\n').find((l) => /\*\*Threshold:\*\*/.test(l));
    assert.ok(thresholdLine, 'a Threshold line must be rendered');
    assert.match(thresholdLine, /offending[^:]*:\s*1\b/, `offending count must be 1, got: ${thresholdLine}`);
    assert.doesNotMatch(out, /All 1 fix claim\(s\) verified/);
  });
});

describe('verify-fixed render — offending semantic unchanged (regression guard)', () => {
  // verify-fixed: regressed + claimedButStillPresent IS the offending set;
  // `verified` is the boring success case and must NOT count as offending.
  function fixedModel() {
    return {
      schema: 'verify-fixed-delta/v1',
      verb: 'verify-fixed',
      runId: 'r1', waveNumber: 5, checkedAt: '2026-06-29T00:00:00.000Z',
      summary: { total: 3, verified: 1, regressed: 1, claimedButStillPresent: 1, unverifiable: 0 },
      threshold: 0, thresholdExceeded: true, exitCode: 1,
      findings: [
        { finding_id: 'F-A', classification: 'regressed', file: 'src/a.js', line: 1,
          symbol: 's', severity: 'HIGH', description: 'd', evidence: 'e' },
        { finding_id: 'F-B', classification: 'claimed-but-still-present', file: 'src/b.js', line: 2,
          symbol: 's', severity: 'HIGH', description: 'd', evidence: 'e' },
        { finding_id: 'F-C', classification: 'verified', file: 'src/c.js', line: 3,
          symbol: 's', severity: 'LOW', description: 'd', evidence: 'e' },
      ],
    };
  }

  it('text: offending count is regressed + claimed (2), not verified', () => {
    const out = renderVerifyFixedText(fixedModel());
    const thresholdLine = out.split('\n').find((l) => /^Threshold:/.test(l));
    assert.match(thresholdLine, /offending[^:]*:\s*2\b/, `offending count must be 2, got: ${thresholdLine}`);
    assert.match(out, /2 fix claim\(s\) failed verification/);
  });

  it('markdown: offending count is regressed + claimed (2)', () => {
    const out = renderVerifyFixedMarkdown(fixedModel());
    const thresholdLine = out.split('\n').find((l) => /\*\*Threshold:\*\*/.test(l));
    assert.match(thresholdLine, /offending[^:]*:\s*2\b/, `offending count must be 2, got: ${thresholdLine}`);
  });
});
