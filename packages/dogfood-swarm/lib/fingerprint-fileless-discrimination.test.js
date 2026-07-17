/**
 * fingerprint-fileless-discrimination.test.js — wave-41 coordinator rider
 * ("fingerprint-fusion-rider", swarm-cp-core), NOT a filed F-id — the
 * coordinator's own wave-40 forensics, not a routed finding from this run's
 * findings table. See swarms/swarm-1784091637-5127/wave-41/swarm-cp-core/
 * output.json's rider entry for the full forensic trail; no `@pins` tag is
 * used anywhere in this file because check-finding-regression-pins.mjs's
 * dangling-id check requires a REAL source-side F-id, and this fix has none
 * to point at. The tests lane is expected to author the canonical
 * root-level regression pin, once the coordinator either files a real
 * finding for this rider or establishes a convention for coordinator-
 * sourced (non-agent-filed) fixes.
 *
 * THE BUG: computeFingerprint's base fingerprint is
 * `category|rule_id|normalizePath(file)|symbol|location` — for a file-less
 * finding (no file, and typically no rule_id/symbol/line either), every
 * part except category collapses to an empty string, so the WHOLE
 * fingerprint degenerates to ~category-only. Every file-less finding
 * sharing a category collides on ONE base fingerprint. Reproduced live
 * against wave-40's real collect() (three fusion incidents named in the
 * rider) and reproduced minimally here: a throwaway worktree pinned at this
 * repo's pre-fix HEAD (a7399b7) confirmed RED — two unrelated file-less
 * 'integration' findings both hashed to f86e42eb6b8c1f33fc182757, the EXACT
 * base fp the wave-40 forensics named, and disambiguateFingerprints'
 * chooseBareKeeper picked one of them as the "keeper" of a base fp that
 * ALSO matched an unrelated, already-closed prior row — wrongly reopening
 * it as recurring while the other sibling silently absorbed nothing (salted
 * into its own row, but the reader who filed it never sees the merge).
 *
 * THE FIX: fold a normalized-description component into the base
 * fingerprint, ONLY on the file-less branch. File-bearing findings (the
 * vast majority of this module's history) are untouched byte-for-byte.
 *
 * `_declaringDomain` was DELIBERATELY NOT folded in, despite the rider text
 * offering it as an option — an earlier draft did, and running the FULL
 * fingerprint test suite (not just this file) caught it breaking
 * fingerprint-filed-by-domain-stamp.test.js's own pre-existing invariant:
 * the SAME file-less finding recurring under a DIFFERENT declaring domain
 * must still be recognized as the same finding (F-874c0683 — filed_by_domain
 * is a first-filed fact precisely because a later re-reporter is expected to
 * differ from the first). See this suite's own "domain does not participate"
 * test below.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { computeFingerprint, classifyFindings } from './fingerprint.js';

describe('computeFingerprint — file-less findings get real discrimination (fingerprint-fusion rider)', () => {
  it('two file-less findings sharing ONLY category now get DIFFERENT base fingerprints (the fusion this rider closes)', () => {
    const findingA = { category: 'integration', file: null, description: 'Totally unrelated NEW defect about missing widget X provisioning', _declaringDomain: 'backend' };
    const findingB = { category: 'integration', file: null, description: 'Totally unrelated NEW defect about missing gadget Y provisioning', _declaringDomain: 'docs' };

    assert.notEqual(computeFingerprint(findingA), computeFingerprint(findingB));
  });

  it('reproduces the exact wave-40 collision shape end-to-end: classifyFindings no longer fuses an unrelated finding into an unrelated closed prior', () => {
    const priorRow = {
      id: 1, finding_id: 'F-OLDONE', status: 'fixed', category: 'integration',
      file_path: null, description: 'ORIGINAL, already-closed finding about widget provisioning', severity: 'MEDIUM',
    };
    priorRow.fingerprint = computeFingerprint({ category: 'integration', file: null, description: priorRow.description });
    const priorFingerprints = new Map([[priorRow.fingerprint, priorRow]]);

    const findingA = { category: 'integration', file: null, severity: 'HIGH', description: 'Totally unrelated NEW defect about missing widget X provisioning', _declaringDomain: 'backend' };
    const findingB = { category: 'integration', file: null, severity: 'HIGH', description: 'Totally unrelated NEW defect about missing gadget Y provisioning', _declaringDomain: 'docs' };

    const result = classifyFindings([findingA, findingB], priorFingerprints, { full: true });
    assert.equal(result.new.length, 2, 'both unrelated findings must classify as new — neither fuses into the prior');
    assert.equal(result.recurring.length, 0, 'the unrelated closed prior must NOT be wrongly reopened');
  });

  it('a GENUINE same-content re-report of a file-less finding still dedupes correctly across waves (the fix does not break legitimate recurrence)', () => {
    const finding = { category: 'missing-feature', file: null, description: 'the schema does not conform to the artifact', _declaringDomain: 'backend' };
    const fp1 = computeFingerprint(finding);
    const priorRow = {
      id: 1, finding_id: 'F-REAL', status: 'new', category: 'missing-feature',
      file_path: null, description: finding.description, severity: 'HIGH', fingerprint: fp1,
    };
    const priorFingerprints = new Map([[fp1, priorRow]]);

    // Same domain, same (byte-identical) description, re-reported next wave.
    const result = classifyFindings([{ ...finding }], priorFingerprints, { full: true });
    assert.equal(result.recurring.length, 1, 'an identical re-report by the SAME domain must still recur, not duplicate as new');
    assert.equal(result.new.length, 0);
  });

  it('file-bearing findings are BYTE-IDENTICAL to the pre-fix computation — this fix touches only the file-less branch', () => {
    const finding = { category: 'bug', rule_id: 'no-eval', file: 'lib/foo.js', symbol: 'doThing', line: 42, description: 'anything, never read for a file-bearing finding' };

    // Hand-replicate the ORIGINAL (pre-rider) parts.join('|') shape: exactly
    // the 5-part [category, rule_id, normalizedPath, symbol, location] array
    // computeFingerprint has always used for a file-bearing finding, with NO
    // domain/description folded in — the fix's new parts.push() calls only
    // execute when `!finding.file`, which is false here.
    const expectedRaw = ['bug', 'no-eval', 'lib/foo.js', 'doThing', '40'].join('|');
    const expectedFp = createHash('sha256').update(expectedRaw).digest('hex').slice(0, 24);

    assert.equal(computeFingerprint(finding), expectedFp);
  });

  it('two file-less findings with IDENTICAL category, domain, and description still collide (a true duplicate report, not a fusion bug)', () => {
    const findingA = { category: 'integration', file: null, description: 'the exact same defect, worded identically', _declaringDomain: 'backend' };
    const findingB = { category: 'integration', file: null, description: 'the exact same defect, worded identically', _declaringDomain: 'backend' };

    assert.equal(computeFingerprint(findingA), computeFingerprint(findingB), 'a byte-identical file-less report must still collide — this is correct de-dup, not the fusion bug');
  });

  it('domain does NOT participate in file-less discrimination — same category+description, different _declaringDomain, still collides', () => {
    const findingA = { category: 'integration', file: null, description: 'the exact same defect, worded identically', _declaringDomain: 'backend' };
    const findingB = { category: 'integration', file: null, description: 'the exact same defect, worded identically', _declaringDomain: 'docs' };

    assert.equal(
      computeFingerprint(findingA),
      computeFingerprint(findingB),
      'domain attribution was deliberately excluded from the fingerprint — see this file\'s header for why (F-874c0683 conflict)',
    );
  });

  it('a genuine re-report under a DIFFERENT declaring domain still recurs end-to-end, and filed_by_domain is never overwritten (F-874c0683 preserved)', () => {
    const original = { category: 'missing-feature', file: null, description: 'stable content for fingerprint match', _declaringDomain: 'docs' };
    const fp1 = computeFingerprint(original);
    const priorRow = {
      id: 1, finding_id: 'F-003', status: 'new', category: 'missing-feature',
      file_path: null, description: original.description, severity: 'HIGH',
      filed_by_domain: 'docs', fingerprint: fp1,
    };
    const priorFingerprints = new Map([[fp1, priorRow]]);

    const result = classifyFindings([{ ...original, _declaringDomain: 'swarm-cp-tests' }], priorFingerprints, { full: true });
    assert.equal(result.recurring.length, 1, 'a different declaring domain re-reporting the SAME content must still recur');
    assert.equal(result.new.length, 0);
  });
});
