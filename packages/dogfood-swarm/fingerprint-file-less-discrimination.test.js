/**
 * fingerprint-file-less-discrimination.test.js — wave-41 rider (swarm-cp-tests
 * domain), regression pin for the fingerprint-fusion bug wave-40's collect run
 * actually hit against the real control-plane.db.
 *
 * NOT TAGGED. This fix has no canonical finding id yet — it is off-the-books
 * rider work this wave (mirroring swarm-cp-core's own wave-41 brief, which
 * likewise does not list it as an approved finding), not a `swarm approve`d
 * item. The wave-42 audit is expected to mint an id and retro-tag the fix's
 * covering test at that point. Per this run's own regression-pin gate
 * (scripts/check-finding-regression-pins.mjs), an `@pins` tag with no
 * matching source-side pin is a dangling-id tag issue — a gate FAIL, not a
 * grant — so leaving this untagged is the honest choice, not an oversight.
 * Do NOT route this through scripts/regression-pin-allowlist.json either:
 * that allowlist exists for prose cross-references, not for a real fix
 * pin, and laundering an untagged fix through it would be exactly the
 * "gate that can't go red is theater" failure swarms/CLAUDE.md warns about.
 *
 * THE BUG (proven live against this worktree's own lib/fingerprint.js,
 * unmutated, via the exported API — no internal mechanism assumed):
 *
 *   computeFingerprint() intentionally excludes description (B-BACK-002 —
 *   cross-wave dedup must survive a rewording) and degrades LOCATION to ''
 *   when a finding has neither a resolvable source file nor a line number
 *   (the documented no-source fallback path). For a file-less finding with
 *   no rule_id and no symbol either — the common shape for a repo-level
 *   audit finding, e.g. every one of this run's ~40 approved feature
 *   findings — the ENTIRE fingerprint collapses to a pure function of
 *   `category` alone:
 *
 *     computeFingerprint({ category: 'integration', description: 'A' })
 *       === computeFingerprint({ category: 'integration', description: 'B' })
 *       === 'f86e42eb6b8c1f33fc182757'  (the REAL F-f86e42eb's own fingerprint)
 *
 *   Two genuinely distinct file-less findings sharing a category are a
 *   same-wave collision group of size >= 2. disambiguateFingerprints()
 *   already salts every NON-keeper member of such a group — that part
 *   works. What is unguarded is chooseBareKeeper(): when a prior row
 *   ALREADY occupies that exact degenerate fingerprint (because the prior
 *   is ITSELF an old file-less same-category finding — proven true for the
 *   real F-f86e42eb/F-b4799d13/F-49940082 rows read from the control-plane
 *   DB this wave), the "does this member's (file, line) match the prior's"
 *   check at lib/fingerprint.js's chooseBareKeeper degenerates to
 *   "both sides are empty" — true for every member of the group,
 *   regardless of whether any of them is actually a re-report of that
 *   prior. The keeper is picked by content sort, not identity, and
 *   inherits the prior's bare fingerprint anyway. Two live, distinct
 *   failure modes follow, both reproduced below:
 *
 *     (1) keeper-donation against a FIXED prior — classifyFindings() routes
 *         the unrelated new finding into `result.recurring` against the
 *         prior's finding_id, wrongly REOPENING a closed, unrelated defect
 *         (the F-f86e42eb shape this wave's coordinator observed).
 *     (2) keeper-donation against a DEFERRED prior — classifyFindings()
 *         routes the unrelated new finding into `result.recurred_while_closed`
 *         instead, which is worse: upsertFindings' handling for that bucket
 *         only bumps `last_seen_wave` on the PRIOR's row and never creates
 *         any row for the new finding's own content — a silent, total data
 *         loss of a genuinely new defect (the F-b4799d13/F-49940082 shape).
 *
 * THE FIX (not visible to this worktree — lands in a sibling worktree this
 * same wave): a fingerprint-discrimination change scoped to the file-less
 * path in lib/fingerprint.js. This pin does NOT assume how — it asserts the
 * CONTRACT the fix must satisfy, via the exported computeFingerprint /
 * classifyFindings API only:
 *
 *   (a) two distinct file-less findings sharing a category must not fuse
 *       onto one base fingerprint that also matches an unrelated prior —
 *       neither the wrongful-reopen mode nor the silent-swallow mode may
 *       fire for either finding, and both must land in `result.new`.
 *   (b) a file-bearing finding's fingerprint is UNCHANGED — the fix is
 *       scoped to the no-source fallback path, so context-hash dedup for
 *       real source (including cross-wave recurrence of a reworded
 *       description) must keep working exactly as it does today.
 *
 * RED-NOW, GREEN-POST-MERGE: every assertion in the "(a)" describe block
 * below is RED on this worktree's current HEAD (verified: see this domain's
 * wave-41 output.json for the scratch-worktree proof run) because the bug
 * is real and unfixed here. The "(b)" describe block is already GREEN today
 * and MUST STAY green post-merge — it is the dedup-preservation half of the
 * contract, pinned so a fix that overshoots into salting file-bearing
 * findings too gets caught going red, not celebrated as "extra safety."
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeFingerprint, classifyFindings } from './lib/fingerprint.js';

describe('fingerprint-fusion: distinct file-less findings must not fuse onto an unrelated prior', () => {
  // Two genuinely different defects. Nothing in common except category —
  // no file, no line, no rule_id, no symbol. This is the real shape: every
  // one of this run's ~40 approved file-less feature findings has exactly
  // this profile (verified live against swarms/control-plane.db this wave).
  const findingA = {
    id: 'F-NEWA', category: 'integration', severity: 'MEDIUM',
    description: 'brand new unrelated integration gap: A talks to B with no timeout',
  };
  const findingB = {
    id: 'F-NEWB', category: 'integration', severity: 'MEDIUM',
    description: 'brand new unrelated integration gap: C never retries a transient failure',
  };

  it('computeFingerprint() must not collapse two distinct file-less same-category findings onto one base fingerprint', () => {
    const fpA = computeFingerprint(findingA);
    const fpB = computeFingerprint(findingB);
    assert.notEqual(fpA, fpB,
      'two independently-authored, differently-described file-less findings that merely share a category ' +
      'must not compute the identical fingerprint — description is deliberately excluded from the fingerprint ' +
      '(B-BACK-002), but SOME discriminator must survive when file/line/rule_id/symbol are all absent too, ' +
      'or every file-less finding in a category is indistinguishable from every other');
  });

  it('a wrongly-shared fingerprint must not reopen an unrelated FIXED prior (keeper-donation mode 1)', () => {
    // An unrelated, already-closed defect occupies the exact degenerate
    // fingerprint the fix must stop A/B from colliding into.
    const priorFp = computeFingerprint({ category: 'integration', description: 'an old, unrelated, already-fixed defect' });
    const priorRow = {
      id: 501, finding_id: 'F-OLDFIXED', fingerprint: priorFp,
      status: 'fixed', severity: 'HIGH', category: 'integration',
      file_path: null, description: 'an old, unrelated, already-fixed defect',
    };
    const priorFingerprints = new Map([[priorFp, priorRow]]);

    const result = classifyFindings([findingA, findingB], priorFingerprints, { full: true, confirmed: [] });

    const reopenedOldFixed = result.recurring.find(f => f.prior?.finding_id === 'F-OLDFIXED');
    assert.equal(reopenedOldFixed, undefined,
      'neither new finding may reopen F-OLDFIXED — they are unrelated defects that merely happen to share a ' +
      'degenerate (file-less, category-only) fingerprint with it; pre-fix this is exactly what happens: the ' +
      'within-wave collision keeper inherits the prior\'s bare fingerprint and classifyFindings treats it as a ' +
      'regression recurrence of a closed, unrelated bug');
    assert.equal(result.new.length, 2,
      'both A and B are genuinely new — neither should be swallowed into any prior\'s identity');
    const newIds = result.new.map(f => f.id).sort();
    assert.deepEqual(newIds, ['F-NEWA', 'F-NEWB']);
  });

  it('a wrongly-shared fingerprint must not silently swallow into an unrelated DEFERRED prior (keeper-donation mode 2)', () => {
    // Same shape, but the unrelated prior is deferred rather than fixed —
    // the recurred_while_closed path, which is a SILENT DATA LOSS mode:
    // upsertFindings only bumps the prior's last_seen_wave and never
    // persists the swallowed finding's own content anywhere.
    const priorFp = computeFingerprint({ category: 'integration', description: 'an old, unrelated, deliberately-deferred defect' });
    const priorRow = {
      id: 777, finding_id: 'F-OLDDEFER', fingerprint: priorFp,
      status: 'deferred', severity: 'HIGH', category: 'integration',
      file_path: null, description: 'an old, unrelated, deliberately-deferred defect',
    };
    const priorFingerprints = new Map([[priorFp, priorRow]]);

    const result = classifyFindings([findingA, findingB], priorFingerprints, { full: true, confirmed: [] });

    const swallowedIntoOldDeferred = result.recurred_while_closed.find(f => f.prior?.finding_id === 'F-OLDDEFER');
    assert.equal(swallowedIntoOldDeferred, undefined,
      'neither new finding may be silently folded into F-OLDDEFER\'s recurred_while_closed record — that path ' +
      'discards the incoming finding\'s own content entirely (only the PRIOR row\'s last_seen_wave is touched), ' +
      'so this failure mode is a genuine, silent loss of a real defect, not merely a mis-filed one');
    assert.equal(result.new.length, 2,
      'both A and B are genuinely new and must be visible as their own rows, not folded into F-OLDDEFER');
  });
});

describe('fingerprint-fusion fix must not touch file-bearing dedup (backward-compat half of the contract)', () => {
  const sourceText = [
    'function retryWithBackoff(fn, attempts) {',
    '  for (let i = 0; i < attempts; i++) {',
    '    try {',
    '      return fn();',
    '    } catch (err) {',
    '      if (i === attempts - 1) throw err;',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const findingV1 = {
    category: 'bug', rule_id: 'no-unhandled-retry', file: 'packages/dogfood-swarm/lib/retry.js',
    symbol: 'retryWithBackoff', line: 4, description: 'v1 wording of the same defect',
  };

  it('a file-bearing finding still computes the exact pre-existing context-hash fingerprint', () => {
    // Literal pin (content-addressed, not a headcount): this is the file-less
    // discrimination fix's blast-radius boundary. If a future change to the
    // no-source fallback path leaks into the context-hash path too, this
    // goes red immediately instead of silently drifting cross-wave dedup for
    // every REAL, file-bearing finding in the repo.
    const fp = computeFingerprint(findingV1, { sourceText });
    assert.equal(fp, '0e7536e1919240be9b33c15f');
  });

  it('dedup preservation: the SAME file-bearing defect reworded across waves still fingerprints identically and recurs (not "new")', () => {
    const fp1 = computeFingerprint(findingV1, { sourceText });
    const findingV2 = { ...findingV1, description: 'v2 wording, totally different prose, same underlying defect' };
    const fp2 = computeFingerprint(findingV2, { sourceText });
    assert.equal(fp1, fp2,
      'description must stay excluded from the file-bearing fingerprint (B-BACK-002) — a rewording of the ' +
      'identical defect must not mint a new fingerprint');

    const priorRow = {
      id: 42, finding_id: 'F-RETRYBUG', fingerprint: fp1, status: 'recurring',
      severity: 'MEDIUM', category: 'bug', file_path: findingV1.file, description: findingV1.description,
    };
    const result = classifyFindings(
      [{ ...findingV2, fingerprint: fp2 }],
      new Map([[fp1, priorRow]]),
      { full: true, confirmed: [] },
    );
    assert.equal(result.new.length, 0, 'a genuinely-recurring file-bearing defect must not be misclassified as new');
    assert.equal(result.recurring.length, 1);
    assert.equal(result.recurring[0].prior.finding_id, 'F-RETRYBUG');
  });

  it('two genuinely different file-bearing findings (different locations in the same file) still get different fingerprints', () => {
    const findingElsewhere = {
      ...findingV1, line: 2, symbol: undefined, description: 'an unrelated defect elsewhere in the same file',
    };
    const fpHere = computeFingerprint(findingV1, { sourceText });
    const fpElsewhere = computeFingerprint(findingElsewhere, { sourceText });
    assert.notEqual(fpHere, fpElsewhere,
      'the context-hash path\'s existing discrimination for real source must be untouched by a fix scoped to ' +
      'the no-source fallback');
  });
});
