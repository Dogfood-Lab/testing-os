/**
 * f-39aca64f-glob-intersection.test.js — F-39aca64f: the freeze-time
 * exclusive-ownership gate (findOwnedGlobOverlaps) decided glob INTERSECTION
 * by single-point sampling, and two globs can genuinely intersect without
 * either's sample landing in the other's language.
 *
 * PROVEN repro (from the finding): owned 'alpha' with globs `['src/a*\/f.js']`
 * and owned 'beta' with globs `['src/*b\/f.js']` FREEZE CLEAN under the old
 * sampler, yet both minimatch `src/ab/f.js` — alpha samples to `src/ax/f.js`
 * (rejected by beta's glob) and beta samples to `src/xb/f.js` (rejected by
 * alpha's glob), so neither probe ever sees the other. The post-freeze
 * consequence: resolveExclusiveOwner silently awards `src/ab/f.js` to
 * 'alpha' on the alphabetical tie-break, so checkOwnership flags 'beta' with
 * a VIOLATION against a glob its own frozen brief told it was its domain.
 *
 * The fix replaces sampling with exact segment-wise glob-pair intersection
 * (globsCanIntersect in lib/domains.js) for the `**`-free case this repro
 * exercises, comparing glob PAIRS' specificity directly rather than via a
 * shared sample point.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openMemoryDb } from './db/connection.js';
import {
  saveDomainDraft, freezeDomains, resolveExclusiveOwner, getDomains, detectDomains,
} from './lib/domains.js';

function setup(db, runId, domains) {
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', '/tmp/r', 'a'.repeat(40));
  saveDomainDraft(db, runId, domains);
}

describe('freezeDomains — exact glob-pair intersection closes the single-point-sampling gap', () => {
  it('REFUSES the proven repro: src/a*/f.js vs src/*b/f.js (neither sample sees the other, but the languages intersect)', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['src/a*/f.js'], ownership_class: 'owned' },
      { name: 'beta', globs: ['src/*b/f.js'], ownership_class: 'owned' },
    ]);
    assert.throws(() => freezeDomains(db, 'r1'), /overlapping owned domains/);
    db.close();
  });

  it('sanity: identical owned globs are still refused (pre-existing behavior, not regressed)', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['src/**'], ownership_class: 'owned' },
      { name: 'beta', globs: ['src/**'], ownership_class: 'owned' },
    ]);
    assert.throws(() => freezeDomains(db, 'r1'), /overlapping owned domains/);
    db.close();
  });

  it('sm-r-001: a strict-subset overlap (frontend src/ui/** inside backend src/**) still freezes clean', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'frontend', globs: ['src/ui/**'], ownership_class: 'owned' },
      { name: 'backend', globs: ['src/**'], ownership_class: 'owned' },
    ]);
    assert.doesNotThrow(() => freezeDomains(db, 'r1'));

    // And ownership arbitration resolves unambiguously to the more specific domain.
    const domains = getDomains(db, 'r1');
    assert.equal(resolveExclusiveOwner(domains, 'src/ui/App.tsx'), 'frontend');
    assert.equal(resolveExclusiveOwner(domains, 'src/server.js'), 'backend');
    db.close();
  });

  it('two globs at different segment depths (no **) never intersect — disjoint by construction', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['src/*.js'], ownership_class: 'owned' },
      { name: 'beta', globs: ['src/*/*.js'], ownership_class: 'owned' },
    ]);
    assert.doesNotThrow(() => freezeDomains(db, 'r1'));
    db.close();
  });

  it('two disjoint literal globs at the same specificity do not conflict', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['src/a*/f.js'], ownership_class: 'owned' },
      { name: 'beta', globs: ['src/z*/f.js'], ownership_class: 'owned' },
    ]);
    // src/a*/f.js and src/z*/f.js CAN share no member: segment 2 requires
    // starting with 'a' AND starting with 'z' simultaneously — impossible.
    assert.doesNotThrow(() => freezeDomains(db, 'r1'));
    db.close();
  });

  // Deletion-shaped: the fix is genuinely load-bearing, not a no-op that
  // happens to agree with the old sampler on these cases. Confirmed by
  // reverting the glob-pair comparison to point-sampling during development
  // and observing the first test above go from throwing to NOT throwing.
});

/**
 * The sm-p-002 fix's OWN regression — caught by the wave's serial-final-verify,
 * not by this file's original tests, which is the point.
 *
 * globsCanIntersect's first draft returned `true` UNCONDITIONALLY whenever
 * either glob contained `**`, discarding the decidable information sitting in
 * the constant segments BEFORE the `**`. Since essentially every real domain
 * glob ends in `**`, freezeDomains then rejected every multi-domain map — 81
 * failures across this package, and the product's own map would not freeze.
 *
 * These tests exist because this file's original suite was VACUOUS for this
 * case: every glob pair it exercised either contained no `**` at all, or
 * differed in specificity (`src/**` [1,3,-1] vs `tests/**` [1,5,-1]) and so
 * was skipped by findOwnedGlobOverlaps before globsCanIntersect was ever
 * reached. A guard that cannot fire is this wave's whole thesis; here it was
 * mine.
 */
describe('freezeDomains — ** globs with disjoint constant prefixes freeze CLEAN (sm-p-002 regression)', () => {
  it('two sibling package domains (packages/a/** vs packages/b/**) freeze clean', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'a-domain', globs: ['packages/a/**'], ownership_class: 'owned' },
      { name: 'b-domain', globs: ['packages/b/**'], ownership_class: 'owned' },
    ]);
    // Equal specificity ([2,9,-1] for both), so the specificity skip does NOT
    // save us here — globsCanIntersect must itself prove `a` and `b` disjoint.
    assert.doesNotThrow(() => freezeDomains(db, 'r1'));
    db.close();
  });

  it("the product's own real multi-package map shape freezes clean", () => {
    // These are THIS repo's actual frozen domain globs. The pair that broke was
    // backend's `packages/schemas/**` vs docs' `swarms/templates/**`, and the
    // arithmetic is the least obvious thing here, so it is written down rather
    // than left to be re-derived:
    //
    //   globSpecificity('packages/schemas/**')  -> [2, 15, -1]
    //   globSpecificity('swarms/templates/**')  -> [2, 15, -1]
    //
    // literalChars strips */?/ and counts what is left: 'packagesschemas' and
    // 'swarmstemplates' are BOTH 15 characters — a pure coincidence. So the
    // scores tie exactly, findOwnedGlobOverlaps does NOT skip the pair on
    // specificity, and the decision falls through to globsCanIntersect. A future
    // reader will assume specificity protects unrelated top-level directories
    // from each other; it does not, and this is the only place that says so.
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'backend', globs: ['packages/schemas/**'], ownership_class: 'owned' },
      { name: 'docs', globs: ['swarms/templates/**'], ownership_class: 'owned' },
      { name: 'verify', globs: ['packages/verify/**'], ownership_class: 'owned' },
      { name: 'swarmcp', globs: ['packages/dogfood-swarm/lib/**'], ownership_class: 'owned' },
      { name: 'ingest', globs: ['packages/ingest/**'], ownership_class: 'owned' },
      { name: 'report', globs: ['packages/report/**'], ownership_class: 'owned' },
    ]);
    assert.doesNotThrow(() => freezeDomains(db, 'r1'));
    db.close();
  });

  it('a disjoint segment deep under a shared parent still freezes clean', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['packages/x/src/a/**'], ownership_class: 'owned' },
      { name: 'beta', globs: ['packages/x/src/b/**'], ownership_class: 'owned' },
    ]);
    assert.doesNotThrow(() => freezeDomains(db, 'r1'));
    db.close();
  });

  // POSITIVE CONTROL — a fix that makes EVERYTHING freeze is the opposite
  // failure and just as bad. The gate must still fire on a genuine tie.
  it('still REFUSES two domains with the identical ** glob (the gate did not become vacuous)', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['packages/a/**'], ownership_class: 'owned' },
      { name: 'beta', globs: ['packages/a/**'], ownership_class: 'owned' },
    ]);
    assert.throws(() => freezeDomains(db, 'r1'), /overlapping owned domains/);
    db.close();
  });

  it('still REFUSES when the disjoint segment sits AFTER a ** (undecidable — safe direction preserved)', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['packages/**/a/x.js'], ownership_class: 'owned' },
      { name: 'beta', globs: ['packages/**/b/x.js'], ownership_class: 'owned' },
    ]);
    // Nothing after the first `**` is decidable by constant-prefix comparison,
    // so this falls back to "possible intersection" and flags — an over-flag
    // the operator disambiguates, never a silent miss.
    assert.throws(() => freezeDomains(db, 'r1'), /overlapping owned domains/);
    db.close();
  });

  it('a leading ** (zero decidable prefix) still flags — safe direction preserved', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['**/x.js'], ownership_class: 'owned' },
      { name: 'beta', globs: ['**/y.js'], ownership_class: 'owned' },
    ]);
    assert.throws(() => freezeDomains(db, 'r1'), /overlapping owned domains/);
    db.close();
  });
});

/**
 * (A) DEFAULT_BUCKETS entry-point globs must not claim frontend extensions.
 *
 * Exposed BY the sm-p-002 exact-intersection gate: backend's entry-point
 * heuristics (`main.*`, `index.*`, `app.*`, `server.*`, `cli.*`) matched ANY
 * extension, including frontend's. Measured against globSpecificity, the damage
 * was not uniform and "both globs match" is NOT the same as "the gate flags it":
 *
 *   index.*  [0,6,0] vs *.html [0,5,0] -> backend WINS OUTRIGHT. No tie, so the
 *                                         freeze gate never fires: `index.html`,
 *                                         the most canonical frontend file there
 *                                         is, was SILENTLY assigned to backend.
 *   main.*   [0,5,0] vs *.html [0,5,0] -> a genuine tie ('main.' and '.html' are
 *                                         coincidentally both 5 literal chars),
 *                                         so this one the gate DOES flag.
 *   app.*    [0,4,0] vs *.html [0,5,0] -> frontend already won; never broken.
 *   server.* [0,7,0] vs *.html [0,5,0] -> backend WINS OUTRIGHT, silently.
 *
 * So the silent mis-assignments (index.html, server.html) were strictly worse
 * than the loud one (main.html): a tie at least fails the freeze. Nothing should
 * have to ADJUDICATE whether index.html is frontend — the map was simply wrong,
 * and the old point-sampler is why it shipped unseen.
 */
describe('DEFAULT_BUCKETS — backend entry points do not claim frontend extensions', () => {
  function makeTree() {
    const root = mkdtempSync(join(tmpdir(), 'bucket-ext-'));
    mkdirSync(join(root, 'src/ui'), { recursive: true });
    mkdirSync(join(root, 'src/server'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    // Frontend entry points — the defect.
    writeFileSync(join(root, 'index.html'), '<html></html>\n');
    writeFileSync(join(root, 'main.html'), '<html></html>\n');
    writeFileSync(join(root, 'app.html'), '<html></html>\n');
    // Backend entry points — the control.
    writeFileSync(join(root, 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(root, 'main.py'), 'print(1)\n');
    writeFileSync(join(root, 'server.go'), 'package main\n');
    // Enough shape for the full-stack map to detect.
    writeFileSync(join(root, 'src/ui/App.tsx'), 'export default function App(){}\n');
    writeFileSync(join(root, 'src/server/api.ts'), 'export const api = 1;\n');
    writeFileSync(join(root, 'tests/app.test.js'), 'export {};\n');
    writeFileSync(join(root, 'README.md'), '# repo\n');
    return root;
  }

  function seeded(root) {
    const db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', root, 'a'.repeat(40));
    const { domains } = detectDomains(root);
    saveDomainDraft(db, 'r1', domains.map(d => ({
      name: d.name, globs: d.globs, ownership_class: d.ownership_class,
    })));
    return db;
  }

  it('the default full-stack map with real .html entry points FREEZES clean', () => {
    const root = makeTree();
    const db = seeded(root);
    try {
      assert.doesNotThrow(() => freezeDomains(db, 'r1'));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('index.html / main.html / app.html resolve to FRONTEND', () => {
    const root = makeTree();
    const db = seeded(root);
    try {
      const domains = getDomains(db, 'r1');
      for (const f of ['index.html', 'main.html', 'app.html']) {
        assert.equal(resolveExclusiveOwner(domains, f), 'frontend', `${f} must be frontend`);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // THE CONTROL — handing the entry points to frontend is the opposite failure
  // and just as bad. Server-side entry points must still be backend.
  it('index.js / main.py / server.go still resolve to BACKEND', () => {
    const root = makeTree();
    const db = seeded(root);
    try {
      const domains = getDomains(db, 'r1');
      for (const f of ['index.js', 'main.py', 'server.go']) {
        assert.equal(resolveExclusiveOwner(domains, f), 'backend', `${f} must stay backend`);
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The gate this change must NOT soften.
  it('a genuine equal-specificity tie still THROWS after the bucket change', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r2', 'org/r', '/tmp/nonexistent-probe', 'a'.repeat(40));
    saveDomainDraft(db, 'r2', [
      { name: 'alpha', globs: ['packages/a/**'], ownership_class: 'owned' },
      { name: 'beta', globs: ['packages/a/**'], ownership_class: 'owned' },
    ]);
    assert.throws(() => freezeDomains(db, 'r2'), /overlapping owned domains/);
    db.close();
  });
});

/**
 * (B) When the run's real file list is reachable, a glob-language tie is
 * promoted to a PROVEN claim: the gate names the actual colliding file.
 *
 * This retires the caveat (A)'s sibling fix had to ship with — "an assumed
 * intersection has no witness to name". With a witness on disk there is
 * nothing assumed, so the message can go back to naming a file, honestly this
 * time.
 *
 * NOTE ON THE SPEC: the witness pair is deliberately NOT the default map +
 * `main.html`. After (A) that tie no longer exists — backend's
 * `main.{js,...}` does not match `main.html`, so only frontend claims it and
 * there is nothing to witness (verified with minimatch). A test written that
 * way would pass for the wrong reason: no tie, rather than a witnessed tie.
 * The fixture below uses a tie that genuinely survives (A) —
 * `src/a*\/f.js` vs `src/*b\/f.js`, which intersect at `src/ab/f.js` — so
 * both directions of the deletion-proof actually exercise the witness path.
 */
describe('freezeDomains — a real file list promotes an assumed tie to a witnessed one', () => {
  function repoWith(files) {
    const root = mkdtempSync(join(tmpdir(), 'witness-'));
    for (const f of files) {
      mkdirSync(join(root, f.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(root, f), 'x\n');
    }
    return root;
  }

  function seeded(localPath) {
    const db = openMemoryDb();
    db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
      .run('r1', 'org/r', localPath, 'a'.repeat(40));
    saveDomainDraft(db, 'r1', [
      { name: 'alpha', globs: ['src/a*/f.js'], ownership_class: 'owned' },
      { name: 'beta', globs: ['src/*b/f.js'], ownership_class: 'owned' },
    ]);
    return db;
  }

  it('WITH the colliding file on disk: THROWS and names the real witness', () => {
    const root = repoWith(['src/ab/f.js']);
    const db = seeded(root);
    try {
      assert.throws(
        () => freezeDomains(db, 'r1'),
        (err) => {
          assert.match(err.message, /overlapping owned domains/);
          assert.match(err.message, /src\/ab\/f\.js/, 'must name the ACTUAL colliding file');
          return true;
        },
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('WITHOUT it: FREEZES — no witness, no conflict', () => {
    // Same globs, same domains; only the colliding file is absent. Any
    // difference in verdict is attributable to the witness and nothing else.
    const root = repoWith(['src/ax/f.js', 'src/xb/f.js']);
    const db = seeded(root);
    try {
      assert.doesNotThrow(() => freezeDomains(db, 'r1'));
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to the glob-pair message when local_path is unreachable', () => {
    const db = seeded('/tmp/definitely-not-a-real-checkout-path');
    try {
      assert.throws(
        () => freezeDomains(db, 'r1'),
        (err) => {
          assert.match(err.message, /src\/a\*\/f\.js/, 'names the glob pair');
          assert.match(err.message, /src\/\*b\/f\.js/);
          assert.match(err.message, /overlap at equal specificity/, 'the honest no-witness wording');
          return true;
        },
      );
    } finally {
      db.close();
    }
  });
});

describe('freezeDomains — the conflict message names evidence it can justify', () => {
  it('reports the offending GLOB PAIR, not a sampled path only one glob matches', () => {
    const db = openMemoryDb();
    setup(db, 'r1', [
      { name: 'alpha', globs: ['src/a*/f.js'], ownership_class: 'owned' },
      { name: 'beta', globs: ['src/*b/f.js'], ownership_class: 'owned' },
    ]);
    // Pre-fix the message read "both claim src/ax/f.js" — a path sampled from
    // alpha's glob that beta's glob does NOT match, i.e. a witness that
    // disproves the very claim it is cited for. The glob pair is evidence
    // that is always accurate AND is the thing the operator has to edit.
    // Note this is unfixable-by-sampling in general: when the `**` branch
    // returns true it has ASSUMED intersection rather than proven it, so
    // there is no witness file to name.
    assert.throws(
      () => freezeDomains(db, 'r1'),
      (err) => {
        assert.match(err.message, /src\/a\*\/f\.js/, "names alpha's actual glob");
        assert.match(err.message, /src\/\*b\/f\.js/, "names beta's actual glob");
        assert.doesNotMatch(err.message, /src\/ax\/f\.js/, 'must not fabricate a witness only one glob matches');
        return true;
      },
    );
    db.close();
  });
});
