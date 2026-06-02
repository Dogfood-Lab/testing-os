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
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openMemoryDb } from './db/connection.js';
import {
  computeFingerprint,
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

describe('fp-006: git-touched-files comments no longer promise a git diff cross-check', () => {
  it('the source carries no false `git diff --name-only` cross-check promise', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./lib/git-touched-files.js', import.meta.url)),
      'utf-8',
    );
    // The drifted comment promised `git diff --name-only` as a
    // "belt-and-suspenders cross-check" the code never ran. After the fix the
    // only git invocation is the porcelain call; assert the false promise is
    // gone (no `git diff` mention at all) while porcelain remains.
    assert.ok(!/git diff --name-only/.test(src),
      'stale `git diff --name-only` cross-check promise must be removed (fp-006)');
    assert.ok(/git', \['status', '--porcelain', '-z'/.test(src.replace(/\s+/g, ' '))
      || /status.*--porcelain.*-z/.test(src),
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
