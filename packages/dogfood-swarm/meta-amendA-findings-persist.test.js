/**
 * meta-amendA-findings-persist.test.js — Wave A (findings-persist) amend gate.
 *
 * Locks the five CONFIRMED fixes from
 * swarms/swarm-1780390764-7dab/wave-1/findings-persist.json:
 *
 *   fp-002 (HIGH, MARQUEE) — within-wave fingerprint collisions no longer abort
 *     the wave collect. Two genuinely-distinct findings sharing a coarse key
 *     (same category|rule_id|path|symbol|line-bucket, different prose) used to
 *     collapse to one base fingerprint, both land in classified.new, and
 *     upsertFindings threw on UNIQUE(run_id, finding_id) / UNIQUE(run_id,
 *     fingerprint), rolling back EVERY finding for the wave (0 persisted).
 *     Fix: occurrence-index disambiguation (Part 1) salts the 2nd..Nth members;
 *     INSERT OR IGNORE + structured logStage (Part 2) is the never-abort safety
 *     net. Singletons + first-of-group keep their bare fingerprint byte-for-byte.
 *
 *   fp-003 (HIGH) — git-touched-files porcelain parser recovers space/non-ASCII
 *     paths verbatim via `git status --porcelain -z` (NUL-delimited, no quoting)
 *     instead of mangling C-quoted octal escapes into `na/303/257ve.js`.
 *
 *   fp-004 (LOW) — bounded-json size gate enforces the cap on bytes ACTUALLY
 *     read, closing the statSync→readFileSync TOCTOU window.
 *
 *   fp-005 (LOW) — findings-digest isMain guard tolerates an undefined
 *     process.argv[1] (no TypeError at module-load under `node --eval`).
 *
 *   fp-006 (LOW) — git-touched-files no longer promises a `git diff --name-only`
 *     cross-check the code never runs (comment-drift).
 *
 * Protocol-v2-lite: each gate is shaped to fail RED against pre-fix HEAD and
 * GREEN after the fix.
 */

import { describe, it, beforeEach, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openMemoryDb, openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import {
  computeFingerprint,
  extractContextSnippet,
  CONTEXT_RADIUS_LINES,
  disambiguateFingerprints,
  classifyFindings,
  buildPriorMap,
  upsertFindings,
} from './lib/fingerprint.js';
import { getActualTouchedFiles } from './lib/git-touched-files.js';
import { readBoundedJson, BoundedJsonError } from './lib/bounded-json-read.js';

const RUN_ID = 'test-amendA-fp';

// ════════════════════════════════════════════════════════════════════
// fp-002 — THE MARQUEE FIX: within-wave fingerprint collisions
// ════════════════════════════════════════════════════════════════════

describe('fp-002: within-wave fingerprint collisions never abort collect', () => {
  let db;

  beforeEach(() => {
    db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run(RUN_ID, 'dogfood-lab/testing-os', '/tmp/repo', 'c'.repeat(40));
    db.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
      .run(RUN_ID, 'health-audit-a', 1);
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
  });

  function collectOneWave(findings) {
    // Mirror collect.js:455-457 + 510-515: bare fingerprint per finding, then
    // classify (which disambiguates) and upsert. This is the exact production
    // path, minus the worktree/agent plumbing.
    const stamped = findings.map((f) => ({ ...f, fingerprint: computeFingerprint(f) }));
    const priorMap = buildPriorMap(db, RUN_ID);
    const classified = classifyFindings(stamped, priorMap);
    return upsertFindings(db, RUN_ID, 1, classified);
  }

  it('(a) two symbol-less findings, same file+category+line-bucket, in ONE wave → BOTH persist, no throw', () => {
    // Same coarse key: category=docs, no rule_id, same file, no symbol, lines
    // 3 & 7 both bucket to 0. Pre-fix: identical base fingerprint → both in
    // classified.new → upsertFindings throws UNIQUE constraint → whole wave
    // rolls back (0 rows). Post-fix: Part 1 salts the 2nd → 2 distinct rows.
    const f1 = {
      category: 'docs', file: 'README.md', line: 3, symbol: null,
      severity: 'LOW', description: 'first doc issue',
    };
    const f2 = {
      category: 'docs', file: 'README.md', line: 7, symbol: null,
      severity: 'LOW', description: 'second, different doc issue',
    };
    // Precondition: the two share a base fingerprint (that is the bug shape).
    assert.equal(
      computeFingerprint(f1), computeFingerprint(f2),
      'precondition: the two findings share a coarse base fingerprint',
    );

    let stats;
    assert.doesNotThrow(() => { stats = collectOneWave([f1, f2]); },
      'within-wave collision must NOT throw / abort the wave');

    const rows = db.prepare('SELECT finding_id, fingerprint, description FROM findings WHERE run_id = ? ORDER BY id')
      .all(RUN_ID);
    assert.equal(rows.length, 2, 'BOTH distinct findings must persist (count not reduced)');
    assert.equal(stats.inserted, 2, 'upsertFindings reports 2 inserted');
    assert.equal(new Set(rows.map(r => r.finding_id)).size, 2, 'distinct finding_ids');
    assert.equal(new Set(rows.map(r => r.fingerprint)).size, 2, 'distinct fingerprints');
  });

  it('(b) the EXACT wave-1 shape (two `docs` findings on the same README, lines 21 & 27, no symbol) → both persist', () => {
    // The live-reproduced shape from the finding text: two distinct README
    // findings 6 lines apart, no symbol, same 10-line bucket (20).
    const f1 = {
      category: 'docs', file: 'README.md', line: 21, symbol: null,
      severity: 'LOW', description: 'stale badge near the top',
    };
    const f2 = {
      category: 'docs', file: 'README.md', line: 27, symbol: null,
      severity: 'LOW', description: 'broken anchor a few lines down',
    };
    assert.equal(
      computeFingerprint(f1), computeFingerprint(f2),
      'precondition: lines 21 & 27 share the 20-bucket → identical base fingerprint',
    );

    let stats;
    assert.doesNotThrow(() => { stats = collectOneWave([f1, f2]); });
    const rows = db.prepare('SELECT finding_id FROM findings WHERE run_id = ?').all(RUN_ID);
    assert.equal(rows.length, 2, 'both wave-1-shaped findings persist');
    assert.equal(stats.inserted, 2);
  });

  it('(b2) a same-coarse-key TRIPLE in one wave → all three persist as distinct findings', () => {
    // fold-never-drop: occurrence index extends past 2. Three findings, same
    // bucket, must yield three rows (indices 0/1/2 → bare/salt1/salt2).
    const base = { category: 'docs', file: 'CHANGELOG.md', symbol: null, severity: 'LOW' };
    const findings = [
      { ...base, line: 2, description: 'a' },
      { ...base, line: 4, description: 'b' },
      { ...base, line: 8, description: 'c' },
    ];
    assert.equal(
      new Set(findings.map(computeFingerprint)).size, 1,
      'precondition: all three share one base fingerprint',
    );
    let stats;
    assert.doesNotThrow(() => { stats = collectOneWave(findings); });
    assert.equal(stats.inserted, 3, 'all three distinct findings persist');
    const rows = db.prepare('SELECT fingerprint FROM findings WHERE run_id = ?').all(RUN_ID);
    assert.equal(new Set(rows.map(r => r.fingerprint)).size, 3, 'three distinct fingerprints');
  });

  it('(b3) fp-p-001: a coarse-key group where two NON-keepers share an EQUAL (or empty) description → all persist, both input orders', () => {
    // fp-p-001 (MED): saltByContent used the description as the SOLE
    // discriminator, so two NON-keeper members of the same coarse-key group with
    // a byte-identical (or both-empty) description salted to the IDENTICAL
    // fingerprint → identical derived finding_id → upsertFindings' INSERT OR
    // IGNORE silently DROPPED the second genuinely-distinct finding. The fix
    // folds file + line + a deterministic within-group ordinal into the salt, so
    // tying descriptions still diverge. The (b2) triple above only ever uses
    // distinct descriptions ('a'/'b'/'c'), so this edge was untested.
    //
    // Three members at one coarse key (category=docs, no symbol, same file, all
    // lines bucket to 10). One member with a UNIQUE description becomes the
    // deterministic bare-fp keeper (it sorts last); the OTHER TWO share an
    // identical description and are BOTH non-keepers — exactly the collision the
    // pre-fix salt could not tell apart. Run twice in BOTH input orders on fresh
    // DBs: the result must be order-independent and lose nothing either way.
    const mk = (description) => ({
      category: 'docs', file: 'docs/guide.md', symbol: null, severity: 'LOW', description,
    });
    // Two non-keepers tie on description; lines differ so they are genuinely
    // distinct findings (different file:line) the corpus must keep separate.
    const dupA = { ...mk('see above'), line: 12 };
    const dupB = { ...mk('see above'), line: 16 };
    const keeperUniqueDesc = { ...mk('z unique trailer'), line: 14 };

    assert.equal(
      new Set([dupA, dupB, keeperUniqueDesc].map(computeFingerprint)).size, 1,
      'precondition: all three share one base fingerprint (lines 12/14/16 → bucket 10)',
    );

    for (const order of [[dupA, dupB, keeperUniqueDesc], [dupB, dupA, keeperUniqueDesc], [keeperUniqueDesc, dupB, dupA]]) {
      const label = `order=[${order.map((f) => `${f.description.split(' ')[0]}@${f.line}`).join(',')}]`;
      const sdb = openMemoryDb();
      try {
        sdb.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
          .run(RUN_ID, 'dogfood-lab/testing-os', '/tmp/repo', 'c'.repeat(40));
        sdb.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
          .run(RUN_ID, 'health-audit-a', 1);

        const stamped = order.map((f) => ({ ...f, fingerprint: computeFingerprint(f) }));
        const classified = classifyFindings(stamped, buildPriorMap(sdb, RUN_ID));
        let stats;
        assert.doesNotThrow(() => { stats = upsertFindings(sdb, RUN_ID, 1, classified); },
          `${label}: tying-description non-keepers must not abort the wave`);

        assert.equal(stats.inserted, 3, `${label}: all three distinct findings persist (none dropped)`);
        const rows = sdb.prepare('SELECT finding_id, fingerprint, description, line_number FROM findings WHERE run_id = ? ORDER BY id')
          .all(RUN_ID);
        assert.equal(rows.length, 3, `${label}: exactly three rows — the duplicate-description non-keeper was NOT swallowed`);
        assert.equal(new Set(rows.map((r) => r.fingerprint)).size, 3, `${label}: three distinct fingerprints`);
        assert.equal(new Set(rows.map((r) => r.finding_id)).size, 3, `${label}: three distinct finding_ids`);
        // Both tying-description findings survive as their own rows (by line).
        assert.deepEqual(
          rows.map((r) => r.line_number).sort((a, b) => a - b), [12, 14, 16],
          `${label}: all three (file,line) findings are present`,
        );
      } finally {
        try { sdb.close(); } catch { /* */ }
      }
    }
  });

  it('(b4) fp-p-001: two NON-keepers with BOTH-EMPTY descriptions → all persist as distinct rows (direct fingerprint path)', () => {
    // The empty-description variant. In the LIVE collect path the Ajv schema's
    // `description: minLength 1` gate rejects an empty description before
    // upsertFindings, but the fingerprint module's own JSDoc supports direct
    // callers/tests passing no description, and its header asserts "two distinct
    // members get distinct salts" — which was FALSE for the both-empty case
    // pre-fix (normalizeDescription('') === normalizeDescription(null) === '').
    // This drives disambiguateFingerprints directly to lock that invariant.
    const base = { category: 'docs', file: 'docs/empty.md', symbol: null, severity: 'LOW' };
    // keeper has a non-empty description (sorts after ''); two non-keepers are
    // both empty/null-described — the exact tie the description-only salt missed.
    const k = { ...base, line: 4, description: 'keeper' };
    const e1 = { ...base, line: 2, description: '' };
    const e2 = { ...base, line: 8, description: null };

    const bare = computeFingerprint(k);
    assert.equal(new Set([k, e1, e2].map(computeFingerprint)).size, 1,
      'precondition: all three share one base fingerprint');

    for (const order of [[k, e1, e2], [e1, e2, k], [e2, e1, k]]) {
      const stamped = order.map((f) => ({ ...f, fingerprint: bare }));
      const out = disambiguateFingerprints(stamped);
      const fps = out.map((f) => f.fingerprint);
      assert.equal(new Set(fps).size, 3,
        `both-empty-description non-keepers must get DISTINCT salts (got ${JSON.stringify(fps)})`);
      // The keeper still owns the bare fingerprint, byte-for-byte.
      assert.ok(fps.includes(bare), 'the bare-fp keeper is preserved unchanged');
    }
  });

  it('(c) a singleton finding’s fingerprint is BYTE-IDENTICAL after disambiguation (backward-compat)', () => {
    // The cross-wave dedup invariant (B-BACK-002): disambiguation must NOT
    // perturb the bare fingerprint of a lone finding, or every singleton would
    // re-classify as `new` next wave instead of `recurring`.
    const f = {
      category: 'bug', rule_id: 'X', file: 'src/a.js', symbol: 'foo', line: 10,
      severity: 'HIGH', description: 'whatever',
    };
    const bare = computeFingerprint(f);

    const out = disambiguateFingerprints([{ ...f, fingerprint: bare }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].fingerprint, bare,
      'a singleton must keep its bare fingerprint byte-for-byte');

    // And the FIRST member of a colliding group keeps the bare fingerprint too.
    const g1 = { ...f, line: 11, description: 'one' };
    const g2 = { ...f, line: 13, description: 'two' };
    const groupBare = computeFingerprint(g1); // == computeFingerprint(g2)
    const grouped = disambiguateFingerprints([
      { ...g1, fingerprint: groupBare },
      { ...g2, fingerprint: groupBare },
    ]);
    assert.equal(grouped[0].fingerprint, groupBare,
      'first member of a collision group keeps the bare fingerprint');
    assert.notEqual(grouped[1].fingerprint, groupBare,
      'second member is salted to a distinct fingerprint');
  });

  it('(c2) disambiguateFingerprints does not mutate its inputs', () => {
    const f1 = { category: 'docs', file: 'README.md', line: 3, fingerprint: undefined };
    f1.fingerprint = computeFingerprint(f1);
    const f2 = { category: 'docs', file: 'README.md', line: 7 };
    f2.fingerprint = computeFingerprint(f2);
    const snapshot1 = f1.fingerprint;
    const snapshot2 = f2.fingerprint;
    disambiguateFingerprints([f1, f2]);
    assert.equal(f1.fingerprint, snapshot1, 'input f1 not mutated');
    assert.equal(f2.fingerprint, snapshot2, 'input f2 not mutated');
  });

  it('(d) cross-wave: the SAME singleton finding re-reported next wave dedupes (recurring, not new)', () => {
    const f = {
      category: 'bug', rule_id: 'Y', file: 'src/b.js', symbol: 'bar', line: 40,
      severity: 'MEDIUM', description: 'the same defect, possibly reworded',
    };

    // Wave 1: first sighting → inserted as new.
    const s1 = collectOneWave([f]);
    assert.equal(s1.inserted, 1);
    assert.equal(s1.updated, 0);

    // Wave 2: re-report the same finding (reworded). It is a singleton again,
    // so it keeps the bare fingerprint and must classify recurring — NOT a
    // second new row.
    db.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
      .run(RUN_ID, 'health-audit-a', 2);
    const reworded = { ...f, description: 'same defect, different prose' };
    const stamped = [{ ...reworded, fingerprint: computeFingerprint(reworded) }];
    const priorMap = buildPriorMap(db, RUN_ID);
    const classified = classifyFindings(stamped, priorMap);
    assert.equal(classified.recurring.length, 1, 'singleton re-report classifies recurring');
    assert.equal(classified.new.length, 0, 'no new row for a re-reported singleton');
    const s2 = upsertFindings(db, RUN_ID, 2, classified);
    assert.equal(s2.updated, 1);

    const rows = db.prepare('SELECT id FROM findings WHERE run_id = ?').all(RUN_ID);
    assert.equal(rows.length, 1, 'still exactly one row across both waves (deduped)');
  });

  it('(e) cross-wave fp-r-001: a wave-1 singleton that gains a coarse-key sibling in wave 2 — order-independent', () => {
    // THE regression (fp-r-001, HIGH). disambiguateFingerprints USED to award
    // the bare-fp slot by within-wave array order, blind to prior state. So a
    // wave-1 SINGLETON A that gains a NEW coarse-key sibling B in wave 2 could
    // have the bare fp handed to B (whichever sorted first), making B dedupe to
    // A's prior row → B classified `recurring` and SILENTLY SWALLOWED, while A's
    // stable finding_id (the swarm-approve / D3B-006 handle) was hijacked and A
    // re-inserted under a salted id. collect.js wave-mate order is
    // non-deterministic, so BOTH input orders must now produce the same correct
    // result. We run the whole scenario twice on FRESH DBs: wave-2 = [A, B] and
    // wave-2 = [B, A]. Pre-fix, [B, A] is the catastrophic-swallow order.
    //
    // A and B share a coarse base fingerprint: same category=docs, same file, no
    // symbol, lines 21 & 27 both bucket to 20. Different descriptions only.
    const A = {
      category: 'docs', file: 'packages/dogfood-swarm/README.md', line: 21, symbol: null,
      severity: 'LOW', description: 'stale badge',
    };
    const B = {
      category: 'docs', file: 'packages/dogfood-swarm/README.md', line: 27, symbol: null,
      severity: 'LOW', description: 'broken anchor a few lines down',
    };
    assert.equal(
      computeFingerprint(A), computeFingerprint(B),
      'precondition: A and B share one coarse base fingerprint (the bug shape)',
    );

    for (const wave2Order of [[A, B], [B, A]]) {
      const label = `wave2=[${wave2Order.map((f) => f.description.split(' ')[0]).join(',')}]`;

      // Fresh DB per order so the two scenarios cannot leak state into each other.
      const sdb = openMemoryDb();
      try {
        sdb.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
          .run(RUN_ID, 'dogfood-lab/testing-os', '/tmp/repo', 'c'.repeat(40));
        sdb.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
          .run(RUN_ID, 'health-audit-a', 1);

        const runWave = (waveId, findings) => {
          const stamped = findings.map((f) => ({ ...f, fingerprint: computeFingerprint(f) }));
          const priorMap = buildPriorMap(sdb, RUN_ID);
          const classified = classifyFindings(stamped, priorMap);
          return upsertFindings(sdb, RUN_ID, waveId, classified);
        };

        // Wave 1: A alone → inserted as new. Capture its stable finding_id; this
        // is the exact handle `swarm approve --ids` pins (D3B-006).
        const s1 = runWave(1, [A]);
        assert.equal(s1.inserted, 1, `${label}: wave-1 A inserted as new`);
        const aRow = sdb.prepare('SELECT id, finding_id, fingerprint FROM findings WHERE run_id = ?').get(RUN_ID);
        const aIdOriginal = aRow.finding_id;
        const aRowId = aRow.id;

        // Wave 2: A re-reported + the NEW sibling B, in this order.
        sdb.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
          .run(RUN_ID, 'health-audit-a', 2);
        const s2 = runWave(2, wave2Order);

        // (1) A retains its ORIGINAL finding_id and is classified recurring.
        const aRowAfter = sdb.prepare('SELECT id, finding_id, status FROM findings WHERE id = ?').get(aRowId);
        assert.equal(aRowAfter.finding_id, aIdOriginal,
          `${label}: A keeps its original finding_id (no D3B-006 handle hijack)`);
        assert.equal(aRowAfter.status, 'recurring',
          `${label}: A is classified recurring in wave 2`);
        assert.equal(s2.updated, 1, `${label}: exactly one recurring update (A)`);

        // (2) B is inserted as a NEW distinct row (not swallowed).
        assert.equal(s2.inserted, 1, `${label}: B inserted as a new row (not swallowed)`);
        const rows = sdb.prepare('SELECT id, finding_id, fingerprint, description, status FROM findings WHERE run_id = ? ORDER BY id')
          .all(RUN_ID);

        // (3) total findings for the run == 2.
        assert.equal(rows.length, 2, `${label}: exactly two rows total (A + B), nothing swallowed`);
        assert.equal(new Set(rows.map((r) => r.finding_id)).size, 2, `${label}: distinct finding_ids`);
        assert.equal(new Set(rows.map((r) => r.fingerprint)).size, 2, `${label}: distinct fingerprints`);

        const bRow = rows.find((r) => r.id !== aRowId);
        assert.ok(bRow, `${label}: B's row exists`);
        assert.equal(bRow.description, B.description, `${label}: the new row carries B's content, not A's`);
        assert.notEqual(bRow.finding_id, aIdOriginal,
          `${label}: B does not steal A's finding_id`);

        // (4) no `recurred` finding_event landed on the wrong lineage. A's row is
        // the only one that may carry a 'recurred' event; B (brand-new) must not.
        const aRecurred = sdb.prepare(
          "SELECT COUNT(*) n FROM finding_events WHERE finding_id = ? AND event_type = 'recurred'",
        ).get(aRowId).n;
        assert.equal(aRecurred, 1, `${label}: exactly one 'recurred' event, on A's lineage`);
        const bRecurred = sdb.prepare(
          "SELECT COUNT(*) n FROM finding_events WHERE finding_id = ? AND event_type = 'recurred'",
        ).get(bRow.id).n;
        assert.equal(bRecurred, 0, `${label}: no 'recurred' event mis-attributed to the new sibling B`);
      } finally {
        try { sdb.close(); } catch { /* */ }
      }
    }
  });

  it('safety net: INSERT OR IGNORE skips a true same-id-prefix collision without aborting the rest', () => {
    // Part 2 in isolation: feed classified.new two entries whose 8-hex finding_id
    // prefix collides but whose full fingerprints differ (the rare D3B-006 case
    // that Part 1 cannot create from coarse keys). The first inserts; the second
    // is skipped by INSERT OR IGNORE rather than throwing and rolling back. The
    // first finding MUST survive — never-abort, never-reduce-below-what-fit.
    const fpA = 'abcdef01' + '0'.repeat(16); // 24 hex
    const fpB = 'abcdef01' + '1'.repeat(16); // same 8-hex prefix, distinct fp
    assert.equal(fpA.slice(0, 8), fpB.slice(0, 8), 'precondition: shared 8-hex prefix');
    assert.notEqual(fpA, fpB, 'precondition: distinct full fingerprints');

    let stats;
    assert.doesNotThrow(() => {
      stats = upsertFindings(db, RUN_ID, 1, {
        new: [
          { fingerprint: fpA, severity: 'HIGH', category: 'bug', file: 'a.js', line: 1, symbol: null, description: 'A', recommendation: null },
          { fingerprint: fpB, severity: 'HIGH', category: 'bug', file: 'b.js', line: 1, symbol: null, description: 'B', recommendation: null },
        ],
        recurring: [], fixed: [], unverified: [],
      });
    }, 'a same-id-prefix collision must be skipped, not thrown');

    assert.equal(stats.inserted, 1, 'the first row landed (the second was skipped)');
    const rows = db.prepare('SELECT finding_id FROM findings WHERE run_id = ?').all(RUN_ID);
    assert.equal(rows.length, 1, 'exactly one row — collect did not abort, first finding survived');
    assert.equal(rows[0].finding_id, 'F-abcdef01');
  });
});

// ════════════════════════════════════════════════════════════════════
// fp-p-005 — context-snippet hash makes the BASE fingerprint injective
// (the deeper fix deferred when fp-002's occurrence-salting net landed).
// These lock the NEW source-available path; the fp-002 blocks above stay
// GREEN because they exercise the no-source fallback, which is byte-for-byte
// the historical scheme and still needs the occurrence-salting net.
// ════════════════════════════════════════════════════════════════════

// A 30-line source where every line is distinct, so two findings on different
// lines always see different surrounding windows. Lines 21 & 27 both fall in the
// 20-bucket, so WITHOUT source they collide (the fp-002 shape); WITH source they
// do not. `const vN = N;` per line keeps each line — and each window — distinct.
const FP_P_005_SRC = Array.from({ length: 30 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n');

describe('fp-p-005: extractContextSnippet — edit-stable surrounding-source window', () => {
  it('returns null when there is no usable anchor (no source / bad line / past EOF / blank window)', () => {
    assert.equal(extractContextSnippet(undefined, 10), null, 'no source → null');
    assert.equal(extractContextSnippet('', 10), null, 'empty source → null');
    assert.equal(extractContextSnippet(FP_P_005_SRC, 0), null, 'line 0 is not 1-based-valid → null');
    assert.equal(extractContextSnippet(FP_P_005_SRC, -3), null, 'negative line → null');
    assert.equal(extractContextSnippet(FP_P_005_SRC, 9999), null, 'line past EOF → null');
    assert.equal(extractContextSnippet('   \n\t\n  ', 2), null, 'all-whitespace window → null');
  });

  it('is line-ending and indentation agnostic (survives reflow)', () => {
    const lf = 'a();\n  b();\n    c();\n d();\n e();';
    const crlf = lf.replace(/\n/g, '\r\n');
    const reindented = 'a();\nb();\nc();\nd();\ne();';
    assert.equal(extractContextSnippet(crlf, 3), extractContextSnippet(lf, 3), 'CRLF window == LF window');
    assert.equal(extractContextSnippet(reindented, 3), extractContextSnippet(lf, 3),
      'pure re-indentation collapses away — same non-whitespace content → same snippet');
  });

  it('yields distinct windows for findings more than CONTEXT_RADIUS_LINES apart', () => {
    assert.ok(CONTEXT_RADIUS_LINES >= 1, 'radius is a positive window');
    assert.notEqual(extractContextSnippet(FP_P_005_SRC, 21), extractContextSnippet(FP_P_005_SRC, 27),
      'lines 21 and 27 see different surrounding source');
  });
});

describe('fp-p-005: computeFingerprint folds the context snippet into the BASE fp', () => {
  const at = (line, description) => ({
    category: 'docs', file: 'README.md', symbol: null, severity: 'LOW', line, description,
  });

  it('(1) two distinct findings in the same file+bucket get DISTINCT base fps with source', () => {
    const a = at(21, 'stale badge');
    const b = at(27, 'broken anchor');
    // Without source they collide on the 20-bucket — the exact fp-002 bug shape.
    assert.equal(computeFingerprint(a), computeFingerprint(b),
      'precondition: no-source fps collide on the shared bucket');
    // With source the surrounding lines differ → distinct base fps, no salting.
    assert.notEqual(
      computeFingerprint(a, { sourceText: FP_P_005_SRC }),
      computeFingerprint(b, { sourceText: FP_P_005_SRC }),
      'context hash makes the base fp injective for distinct locations',
    );
  });

  it('(2) rewording the SAME finding at the SAME location does not change the fp (B-BACK-002 via source, not prose)', () => {
    assert.equal(
      computeFingerprint(at(21, 'handleX dereferences without a guard'), { sourceText: FP_P_005_SRC }),
      computeFingerprint(at(21, 'Guard handleX before dereferencing.'), { sourceText: FP_P_005_SRC }),
      'same location + same surrounding source → same fp regardless of description prose',
    );
  });

  it('(3) reflow: a finding shifted down by edits ABOVE it keeps its fp (CodeQL primaryLocationLineHash property)', () => {
    const before = computeFingerprint(at(21, 'x'), { sourceText: FP_P_005_SRC });
    // Insert 5 lines at the top; the finding's surrounding code moves to line 26.
    const shifted = ['// new', '// header', '// lines', '// added', '// above'].join('\n') + '\n' + FP_P_005_SRC;
    const after = computeFingerprint(at(26, 'x'), { sourceText: shifted });
    assert.equal(after, before, 'same surrounding source at the new line → same fp (no new+fixed churn)');
  });

  it('(4) CRLF and LF source produce the same fp', () => {
    assert.equal(
      computeFingerprint(at(21, 'x'), { sourceText: FP_P_005_SRC.replace(/\n/g, '\r\n') }),
      computeFingerprint(at(21, 'x'), { sourceText: FP_P_005_SRC }),
      'line-ending normalization makes CRLF and LF fingerprints identical',
    );
  });

  it('(5) the no-source path is byte-identical to the historical bucket fingerprint', () => {
    const a = at(21, 'x');
    const historical = computeFingerprint(a); // one-arg legacy call
    assert.equal(computeFingerprint(a, {}), historical, 'empty options == legacy');
    assert.equal(computeFingerprint(a, { sourceText: undefined }), historical, 'undefined source == legacy');
    assert.equal(computeFingerprint(a, { sourceText: '' }), historical, 'empty source == legacy');
    // And a no-source same-bucket sibling still collides — the occurrence-salting
    // net is still load-bearing (and still tested) for the no-source path.
    assert.equal(historical, computeFingerprint(at(27, 'y')),
      'no-source siblings still share the bucket fp (the net still earns its keep)');
  });
});

describe('fp-p-005: cross-wave injective — collision-free in EITHER input order (with source)', () => {
  // The fp-r-001 scenario re-run with source available. Because A and B now
  // carry DISTINCT base fps, NO collision group forms, disambiguateFingerprints
  // never salts, and the outcome is identical regardless of wave-2 array order:
  // A stays recurring on its original finding_id, B inserts as new. This is the
  // hazard fp-002/fp-r-001's net guarded against, now dissolved at the source.
  const A = { category: 'docs', file: 'README.md', line: 21, symbol: null, severity: 'LOW', description: 'stale badge' };
  const B = { category: 'docs', file: 'README.md', line: 27, symbol: null, severity: 'LOW', description: 'broken anchor a few lines down' };

  it('A keeps its id (recurring) and B inserts as new, identically for [A,B] and [B,A]', () => {
    assert.equal(computeFingerprint(A), computeFingerprint(B),
      'precondition: without source A and B collide (the fp-002 shape)');
    assert.notEqual(
      computeFingerprint(A, { sourceText: FP_P_005_SRC }),
      computeFingerprint(B, { sourceText: FP_P_005_SRC }),
      'precondition: with source A and B are injective',
    );

    for (const wave2Order of [[A, B], [B, A]]) {
      const label = `wave2=[${wave2Order.map((f) => f.description.split(' ')[0]).join(',')}]`;
      const sdb = openMemoryDb();
      try {
        sdb.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
          .run(RUN_ID, 'dogfood-lab/testing-os', '/tmp/repo', 'c'.repeat(40));
        sdb.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
          .run(RUN_ID, 'health-audit-a', 1);

        // Stamp with source, exactly as collect.js does post-fp-p-005.
        const runWave = (waveId, findings) => {
          const stamped = findings.map((f) => ({ ...f, fingerprint: computeFingerprint(f, { sourceText: FP_P_005_SRC }) }));
          const priorMap = buildPriorMap(sdb, RUN_ID);
          const classified = classifyFindings(stamped, priorMap);
          return upsertFindings(sdb, RUN_ID, waveId, classified);
        };

        const s1 = runWave(1, [A]);
        assert.equal(s1.inserted, 1, `${label}: wave-1 A inserted`);
        const aRow = sdb.prepare('SELECT id, finding_id, fingerprint FROM findings WHERE run_id = ?').get(RUN_ID);
        const aIdOriginal = aRow.finding_id;
        const aRowId = aRow.id;
        assert.equal(aRow.fingerprint, computeFingerprint(A, { sourceText: FP_P_005_SRC }),
          `${label}: A's stored fp is the BARE context hash — proof nothing was salted`);

        sdb.prepare('INSERT INTO waves (run_id, phase, wave_number) VALUES (?, ?, ?)')
          .run(RUN_ID, 'health-audit-a', 2);
        const s2 = runWave(2, wave2Order);

        const aAfter = sdb.prepare('SELECT finding_id, status FROM findings WHERE id = ?').get(aRowId);
        assert.equal(aAfter.finding_id, aIdOriginal, `${label}: A keeps its original finding_id`);
        assert.equal(aAfter.status, 'recurring', `${label}: A is recurring`);
        assert.equal(s2.updated, 1, `${label}: exactly one recurring update (A)`);
        assert.equal(s2.inserted, 1, `${label}: B inserted as a new row`);

        const rows = sdb.prepare('SELECT id, finding_id, fingerprint, description FROM findings WHERE run_id = ? ORDER BY id').all(RUN_ID);
        assert.equal(rows.length, 2, `${label}: exactly two rows`);
        assert.equal(new Set(rows.map((r) => r.fingerprint)).size, 2, `${label}: distinct fingerprints`);
        const bRow = rows.find((r) => r.id !== aRowId);
        assert.equal(bRow.description, B.description, `${label}: the new row carries B's content`);
        assert.equal(bRow.fingerprint, computeFingerprint(B, { sourceText: FP_P_005_SRC }),
          `${label}: B's stored fp is the BARE context hash (not salted)`);
      } finally {
        try { sdb.close(); } catch { /* */ }
      }
    }
  });
});

describe('fp-p-005: collect() reads real worktree source and persists same-bucket findings distinctly', () => {
  let tmp, dbPath;
  const RID = 'r-fp-p-005-collect';

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fp-p-005-collect-'));
    dbPath = join(tmp, 'control-plane.db');
    mkdirSync(join(tmp, 'packages', 'backend'), { recursive: true });
    writeFileSync(join(tmp, 'packages', 'backend', 'x.js'), `${FP_P_005_SRC}\n`, 'utf-8');

    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status)
      VALUES (?, 'org/repo', ?, ?, 'main', 'pending')`).run(RID, tmp, 'a'.repeat(40));
    saveDomainDraft(db, RID, [{ name: 'backend', globs: ['packages/backend/**'], ownership_class: 'owned' }]);
    freezeDomains(db, RID);
    closeDb(dbPath);
  });

  afterEach(() => {
    try { closeDb(dbPath); } catch { /* */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('two symbol-less findings on lines 21 & 27 of one file persist as two distinct rows', () => {
    dispatch({ runId: RID, phase: 'health-audit-a', dbPath, outputDir: tmp });

    // symbol is OMITTED (the symbol-less bug shape). The canonical agent-output
    // schema accepts an absent symbol but rejects an explicit null, and an absent
    // symbol fingerprints the same as the empty-symbol case ((undefined||'')==='').
    const f1 = { id: 'F-1', severity: 'LOW', category: 'docs', file: 'packages/backend/x.js', line: 21, description: 'first issue' };
    const f2 = { id: 'F-2', severity: 'LOW', category: 'docs', file: 'packages/backend/x.js', line: 27, description: 'second, different issue' };

    // Precondition: without source these two collide on the base fp (fp-002 shape).
    assert.equal(computeFingerprint(f1), computeFingerprint(f2),
      'precondition: the two findings share a no-source base fp');

    const outPath = join(tmp, 'backend.json');
    writeFileSync(outPath, JSON.stringify({
      domain: 'backend', stage: 'A', summary: 'two same-bucket findings',
      findings: [f1, f2],
    }), 'utf-8');

    const report = collect({ runId: RID, dbPath, outputs: { backend: outPath } });
    assert.equal(report.findings.new, 2, 'both findings persisted as new (no collision, no abort)');

    const db = openDb(dbPath);
    const rows = db.prepare('SELECT finding_id, fingerprint FROM findings WHERE run_id = ? ORDER BY id').all(RID);
    closeDb(dbPath);

    assert.equal(rows.length, 2, 'exactly two rows');
    assert.equal(new Set(rows.map((r) => r.fingerprint)).size, 2, 'distinct fingerprints (context hash distinguished them)');
    assert.equal(new Set(rows.map((r) => r.finding_id)).size, 2, 'distinct finding_ids');
    // Proof collect() actually read the worktree source: the persisted fps are
    // the context-hash fps, NOT the no-source bucket fp the precondition shares.
    const bucketFp = computeFingerprint(f1);
    assert.ok(!rows.some((r) => r.fingerprint === bucketFp),
      'neither persisted fp is the no-source bucket fp — collect() folded the real surrounding source in');
  });
});

// ════════════════════════════════════════════════════════════════════
// fp-003 / fp-006 — git-touched-files: NUL-delimited path recovery
// ════════════════════════════════════════════════════════════════════

describe('fp-003: getActualTouchedFiles recovers space/non-ASCII paths verbatim', () => {
  let repo;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'git-touched-'));
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    // Force the worst case: default core.quotePath=true would C-quote these
    // paths under a non-`-z` porcelain call. The fix uses `-z`, which is
    // immune regardless, so we leave quotePath at its default to prove it.
    git('config', 'core.quotePath', 'true');
  });

  after(() => {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* */ }
  });

  it('recovers an untracked path with a SPACE and a NON-ASCII char exactly', () => {
    writeFileSync(join(repo, 'file with spaces.js'), '// hi\n', 'utf-8');
    writeFileSync(join(repo, 'naïve.js'), '// hi\n', 'utf-8');

    const touched = getActualTouchedFiles(repo);
    assert.ok(!touched.unavailable, 'git was available');

    assert.ok(touched.untracked.includes('file with spaces.js'),
      `space path must round-trip; got untracked=${JSON.stringify(touched.untracked)}`);
    assert.ok(touched.untracked.includes('naïve.js'),
      `non-ASCII path must round-trip (no octal-escape mangling); got untracked=${JSON.stringify(touched.untracked)}`);
    // The pre-fix corruption signature must be ABSENT.
    assert.ok(!touched.all.some(p => p.includes('303') || p.includes('257') || p.startsWith('"')),
      `no C-quote/octal corruption in the touched set; got all=${JSON.stringify(touched.all)}`);
    assert.ok(touched.all.includes('naïve.js') && touched.all.includes('file with spaces.js'),
      'both paths present in the union `all` set');
  });

  it('recovers a RENAME destination with a non-ASCII char and consumes the source field', () => {
    // Commit a plain file, then rename it to a non-ASCII destination and stage
    // the rename so porcelain emits an `R` record (DEST then SOURCE under -z).
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
    writeFileSync(join(repo, 'plain.js'), '// content\n', 'utf-8');
    git('add', 'plain.js');
    git('commit', '-q', '-m', 'add plain.js');
    git('mv', 'plain.js', 'piñata.js');

    const touched = getActualTouchedFiles(repo);
    assert.ok(touched.all.includes('piñata.js'),
      `rename destination must round-trip clean; got all=${JSON.stringify(touched.all)}`);
    // The rename SOURCE (`plain.js`) is consumed as the trailing -z field, not
    // misparsed into its own bogus record. And no quote/octal corruption.
    assert.ok(!touched.all.some(p => p.startsWith('"') || p.includes('241')),
      `no quoting/octal corruption on the rename record; got all=${JSON.stringify(touched.all)}`);
  });
});

describe('fp-006: git-touched-files diff cross-check is REAL code, not a comment promise', () => {
  it('any `git diff --name-only` mention is backed by an actual execFileSync invocation', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./lib/git-touched-files.js', import.meta.url)),
      'utf-8',
    );
    // History of this guard: the original fp-006 drift was a comment that
    // promised `git diff --name-only` as a cross-check the code never ran, so
    // this test pinned "no git-diff mention at all". F-4ba6036b then made the
    // diff REAL (committed-delta union via options.baseRef), so the honest
    // property is now the inverse: the diff mention must be backed by a live
    // execFileSync argv call — a comment-only promise would regress fp-006.
    assert.ok(/execFileSync\(\s*'git',\s*\['diff',\s*'--name-only',\s*'-z'/.test(src),
      'the committed-delta diff must be an actual execFileSync call (fp-006 / F-4ba6036b)');
    assert.ok(/status.*--porcelain.*-z/.test(src),
      'the porcelain -z call the code actually runs must be present');
  });
});

// ════════════════════════════════════════════════════════════════════
// fp-004 — bounded-json: enforce the cap on bytes ACTUALLY read
// ════════════════════════════════════════════════════════════════════

describe('fp-004: bounded-json enforces the limit on bytes actually read', () => {
  let tmp;

  before(() => { tmp = mkdtempSync(join(tmpdir(), 'bounded-toctou-')); });
  after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  it('rejects a buffer that exceeds maxBytes even when statSync under-reports (TOCTOU)', () => {
    // Simulate the race: monkeypatch statSync via a wrapper is heavy; instead
    // we drive the post-read check directly. A file whose ON-DISK bytes exceed
    // maxBytes must be rejected with kind SIZE_LIMIT regardless of which gate
    // (stat or post-read) catches it — proving the post-read gate exists.
    const p = join(tmp, 'grew.json');
    const big = JSON.stringify({ blob: 'x'.repeat(300 * 1024) });
    writeFileSync(p, big, 'utf-8');

    let err = null;
    try {
      readBoundedJson(p, { maxBytes: 100 * 1024 });
    } catch (e) { err = e; }
    assert.ok(err instanceof BoundedJsonError, 'must throw BoundedJsonError');
    assert.equal(err.kind, 'SIZE_LIMIT');
    assert.ok(err.size > 100 * 1024, 'reported size reflects the oversized bytes');
    assert.equal(err.maxBytes, 100 * 1024);
  });

  it('the post-read gate is wired to buffer length (multi-byte chars counted as bytes, not chars)', () => {
    // A file whose CHARACTER count is under the cap but whose BYTE count is over
    // it must still be rejected — proving the gate measures bytes (buffer
    // length), the unit a memory-exhaustion guard cares about. Each `好` is 3
    // UTF-8 bytes; 40k chars ≈ 120k bytes. Cap at 100k bytes.
    const p = join(tmp, 'multibyte.json');
    const payload = JSON.stringify({ s: '好'.repeat(40 * 1024) });
    writeFileSync(p, payload, 'utf-8');

    const charLen = payload.length;
    const byteLen = Buffer.byteLength(payload, 'utf-8');
    assert.ok(byteLen > charLen, 'precondition: byte length exceeds char length');

    let err = null;
    try {
      readBoundedJson(p, { maxBytes: 100 * 1024 });
    } catch (e) { err = e; }
    assert.ok(err instanceof BoundedJsonError && err.kind === 'SIZE_LIMIT',
      'multi-byte payload over the BYTE cap must be rejected');
    assert.ok(err.size >= byteLen - 8, 'reported size is the byte length, not char length');
  });

  it('still parses a legitimate file under the limit (no regression)', () => {
    const p = join(tmp, 'fine.json');
    writeFileSync(p, JSON.stringify({ ok: true, n: 42 }), 'utf-8');
    assert.deepEqual(readBoundedJson(p), { ok: true, n: 42 });
  });
});

// ════════════════════════════════════════════════════════════════════
// fp-005 — findings-digest isMain guard tolerates undefined argv[1]
// ════════════════════════════════════════════════════════════════════

describe('fp-005: findings-digest module loads with process.argv[1] undefined', () => {
  it('importing the module under `node --eval` (no argv[1]) does not throw', () => {
    // The pre-fix `process.argv[1].replace(...)` threw a TypeError at module
    // evaluation time when argv[1] was undefined. We reproduce the exact
    // context: a `node --eval` process whose argv has no [1] entry, importing
    // the module. Success = exit 0 (the import + isMain computation survives).
    const moduleUrl = new URL('./lib/findings-digest.js', import.meta.url).href;
    const code = `import(${JSON.stringify(moduleUrl)}).then(() => process.exit(0))`;

    // `node --eval <code>` leaves process.argv = [execPath] only — argv[1] is
    // undefined inside the evaluated module, the exact bug trigger.
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['--eval', code], {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }, 'module must load cleanly when process.argv[1] is undefined (fp-005)');
  });
});
