/**
 * self-inspection.test.js — Tests for the swarm CLI's own reporting layer.
 *
 * These tests cover the meter we use to grade other repos: the digest, the
 * fingerprint, and the classifier. Wave 8 of swarm-1777234130-30e3 surfaced
 * three HIGH findings about silent-failure modes in this layer.
 *
 * Each test is the failing receipt for one of those findings:
 *   - digest_severity_sum_equals_total          (B-BACK-001)
 *   - fingerprint_stable_across_description_rewording (B-BACK-002)
 *   - classifier_requires_positive_evidence_for_fixed_status (B-BACK-003)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { render } from './lib/findings-digest.js';
import { computeFingerprint, classifyFindings } from './lib/fingerprint.js';

// ═══════════════════════════════════════════
// B-BACK-001 — digest severity sum must equal Total
// ═══════════════════════════════════════════

describe('Findings digest — severity accounting', () => {
  it('digest_severity_sum_equals_total', () => {
    // Two well-formed findings + one with unknown severity + one with missing severity.
    // Before the fix: Total=4, CRIT+HIGH+MED+LOW=2, silent 2-finding gap.
    // After the fix: an "Unknown" bucket appears in the Total row when nonzero,
    // and CRIT+HIGH+MED+LOW+Unknown == Total exactly.
    const outputs = [
      {
        domain: 'backend',
        parsed: {
          findings: [
            { id: 'F-1', severity: 'HIGH',     category: 'bug', description: 'a' },
            { id: 'F-2', severity: 'LOW',      category: 'bug', description: 'b' },
            { id: 'F-3', severity: 'TYPO_SEV', category: 'bug', description: 'c' },
            { id: 'F-4',                       category: 'bug', description: 'd' },
          ],
        },
      },
    ];

    // Suppress the deliberate stderr warn this digest emits.
    const origWarn = console.warn;
    const warnCalls = [];
    console.warn = (...args) => warnCalls.push(args);
    let md;
    try {
      md = render('test-run', 1, outputs);
    } finally {
      console.warn = origWarn;
    }

    const totalLine = md.split('\n').find(l => l.startsWith('**Total:**'));
    assert.ok(totalLine, 'Total row must be present');

    // Parse: **Total:** N | CRIT a | HIGH b | MED c | LOW d [| Unknown e]
    const totalMatch = totalLine.match(/\*\*Total:\*\* (\d+)/);
    assert.ok(totalMatch, `Total line shape unexpected: ${totalLine}`);
    const total = Number(totalMatch[1]);

    const sevMatches = [
      ...totalLine.matchAll(/(CRIT|HIGH|MED|LOW|Unknown) (\d+)/g),
    ].map(m => Number(m[2]));
    const sum = sevMatches.reduce((a, b) => a + b, 0);

    assert.equal(
      sum, total,
      `Per-severity counts must sum to Total. Got Total=${total}, sum=${sum}, line=${totalLine}`
    );

    // Operator signal — a stderr warn must have fired about the malformed severities.
    assert.ok(
      warnCalls.length > 0,
      'console.warn should fire when findings have unknown/missing severity'
    );
  });
});

// ═══════════════════════════════════════════
// B-BACK-002 — fingerprint must be stable across description rewording
// ═══════════════════════════════════════════

describe('Fingerprint — description rewording', () => {
  it('fingerprint_stable_across_description_rewording', () => {
    // Same defect, two different prose descriptions.
    // Before the fix: descHash differed → fingerprints differed → same defect
    // double-counted as fixed (old fp) AND new (new fp) in the next wave.
    const a = {
      category: 'bug',
      rule_id: 'NULL_CHECK',
      file: 'src/server.js',
      symbol: 'handleRequest',
      line: 42,
      description: 'handleRequest dereferences req.body without a null check',
    };
    const b = {
      ...a,
      description: 'Null-check req.body inside handleRequest before dereferencing.',
    };

    assert.equal(
      computeFingerprint(a),
      computeFingerprint(b),
      'Two findings differing only in description text MUST produce the same fingerprint'
    );
  });
});

// ═══════════════════════════════════════════
// B-BACK-003 — classifier must require positive evidence for "fixed"
// ═══════════════════════════════════════════

describe('Finding classification — fixed status requires scope coverage', () => {
  it('classifier_requires_positive_evidence_for_fixed_status', () => {
    // Wave N (prior): a backend finding at packages/backend/server.js
    // Wave N+1 (current): a different lens — looked ONLY at packages/frontend/**
    // The prior backend finding was NOT re-examined. It must NOT be marked fixed.
    const prior = new Map([
      ['fp-prior-backend', {
        id: 1,
        status: 'new',
        fingerprint: 'fp-prior-backend',
        file_path: 'packages/backend/server.js',
        category: 'bug',
        description: 'race in request handler',
      }],
    ]);

    // Current wave looked at frontend only. Backend finding's path is NOT in
    // the wave's scope.
    const currentFindings = [
      { fingerprint: 'fp-fe-1', file: 'packages/frontend/app.js', category: 'bug', description: 'unsafe innerHTML' },
    ];

    const result = classifyFindings(currentFindings, prior, {
      scopePaths: ['packages/frontend/'], // path-prefix coverage
    });

    // Hard contract: prior backend finding must NOT be in `fixed`.
    assert.equal(
      result.fixed.length, 0,
      `Prior finding outside current scope must not be marked fixed. Got fixed=${JSON.stringify(result.fixed)}`
    );

    // It must instead surface in the new `unverified` bucket so the next wave
    // can re-examine it.
    assert.ok(
      Array.isArray(result.unverified),
      'classifyFindings must return an `unverified` bucket'
    );
    assert.equal(
      result.unverified.length, 1,
      'Prior finding outside current scope must land in `unverified`'
    );
    assert.equal(result.unverified[0].fingerprint, 'fp-prior-backend');
  });

  it('classifier still marks fixed when scope DOES cover the prior finding', () => {
    // Counterpart: when current wave's scope covers the prior path AND the
    // finding is no longer rediscovered, `fixed` is the correct answer.
    const prior = new Map([
      ['fp-was-backend', {
        id: 1,
        status: 'new',
        fingerprint: 'fp-was-backend',
        file_path: 'packages/backend/server.js',
        category: 'bug',
        description: 'race in request handler',
      }],
    ]);

    const result = classifyFindings([], prior, {
      scopePaths: ['packages/backend/'],
    });

    assert.equal(result.fixed.length, 1);
    assert.equal(result.fixed[0].fingerprint, 'fp-was-backend');
    assert.equal((result.unverified || []).length, 0);
  });

  it('classifier defaults to unverified when no scope is supplied (safe default)', () => {
    // Backward-compat-safe default: if the caller passes no scope info, we
    // CANNOT prove the prior finding was looked at, so we MUST NOT claim it
    // was fixed. The safe default is `unverified`.
    const prior = new Map([
      ['fp-x', { id: 1, status: 'new', fingerprint: 'fp-x', file_path: 'a.js', category: 'bug', description: 'x' }],
    ]);

    const result = classifyFindings([], prior); // no scope arg
    assert.equal(result.fixed.length, 0);
    assert.equal((result.unverified || []).length, 1);
  });
});
