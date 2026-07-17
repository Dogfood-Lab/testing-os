/**
 * f-feeaef78-roadmap-compile-determinism.test.js
 *
 * F-feeaef78 [HIGH] — T1 (docs/trajectory-and-closure.dispatch.md) requires
 * `swarm roadmap compile <run-id>` to be a PURE function of control-plane DB
 * state: identical DB content -> byte-identical compiled artifact. The
 * specific failure class the finding names: SQLite gives no row-order
 * guarantee to a query without an explicit ORDER BY, and the compiler
 * necessarily UNIONs/JOINs across findings + waves + domains + recurrence
 * stats (drain state, per-file process signals) to build the roadmap. A
 * same-process double-call proves nothing here — V8 array/object insertion
 * order is stable within one process regardless of the underlying query
 * plan's physical row order — so the determinism claim can only be proven by
 * two SEPARATE node processes compiling the identical on-disk DB.
 *
 * STATUS: RED IN ISOLATION. This worktree has neither core's `swarm roadmap
 * compile` verb nor its compiler module — zero hits for "roadmap" anywhere
 * under packages/dogfood-swarm/commands or lib as of this write (confirmed
 * by grep before writing this file). Needed from swarm-cp-core:
 *
 *   - A CLI verb dispatched as the two positional tokens `swarm roadmap
 *     compile <run-id>` (cli.js's `commands` map is currently single-token-
 *     keyed — see cli.js's `const commands = {...}` object — so this is a NEW
 *     two-token dispatch shape, not a drop-in `commands['roadmap']` entry.
 *     This file follows docs/trajectory-and-closure.dispatch.md's T1 wording
 *     verbatim; if core picks a different verb spelling, e.g. a hyphenated
 *     `roadmap-compile`, the `runRoadmapCompile` helper below needs updating
 *     to match).
 *   - It writes `<runs.local_path>/dogfood/roadmap/<run-id>.json` and
 *     `<runs.local_path>/dogfood/roadmap/latest.json`. `dogfood/` is this
 *     repo's existing runtime-data-dir convention (CLAUDE.md: "policies/,
 *     fixtures/, records/, indexes/, reports/, swarms/, dogfood/, docs/"),
 *     and the roadmap is a per-TARGET-repo artifact (the whole point of T1 is
 *     that a future swarm on the SAME repo starts targeted), so
 *     `runs.local_path` — the target repo's checkout — is the only sensible
 *     base. Nothing in this package writes a `dogfood/`-relative path today
 *     (grep confirms zero hits), so this is a documented assumption, not a
 *     re-derivation of existing code.
 *   - A compiler module living under lib/ or commands/ with "roadmap" in its
 *     filename. The static scan below discovers it by glob rather than a
 *     hardcoded name, so either lib/roadmap-compile.js or commands/
 *     roadmap.js (or both) are picked up automatically once either lands.
 *
 * Mutation-catch note for the ORDER-BY scan (the one sub-assertion doable
 * without the feature existing): once a roadmap module lands, deleting any
 * one of its `ORDER BY` clauses is exactly the mutation this scan exists to
 * catch — the assertion is a per-SQL-string regex, so removing the clause
 * from any matched string flips this test red with that string's content and
 * line number named in the failure message.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, readdirSync, statSync, existsSync,
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { stripComments } from './test-support/strip-comments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');
const PKG_DIR = __dirname;

const RUN_ID = 'roadmap-determinism-r1';

const tmpRoots = [];
function makeTmpDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* Windows lock lag */ }
  }
});

/**
 * Seeds a control-plane DB with >=2 rows in every section T1 lists as a
 * roadmap input: open + deferred + approved findings (status diversity), a
 * SHARED fingerprint across two runs (recurrence-stats input), and
 * file_claims across >=2 files/domains (per-file process-signal input).
 * 1-row fixtures can't discriminate an ordering bug — a single row has no
 * order to get wrong — this package's own non-vacuity discipline, named
 * directly in the finding text.
 */
function seedDeterminismFixture(dbPath, repoDir) {
  const db = openDb(dbPath);

  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(RUN_ID, 'org/repo', repoDir, 'a'.repeat(40), 'main', 'health-audit-a');
  // A second, older run sharing a fingerprint with the first — the
  // cross-run recurrence-stats input (`swarm trends` internals).
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('roadmap-determinism-r0', 'org/repo', repoDir, 'b'.repeat(40), 'main', 'complete');

  const insDomain = db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, ?, ?, ?, ?)`);
  insDomain.run(RUN_ID, 'domain-a', JSON.stringify(['packages/a/**']), 'owned', 1);
  insDomain.run(RUN_ID, 'domain-b', JSON.stringify(['packages/b/**']), 'owned', 1);

  const insWave = db.prepare(`INSERT INTO waves (run_id, phase, wave_number, status, domain_snapshot_id) VALUES (?, ?, ?, ?, ?)`);
  const wave1 = Number(insWave.run(RUN_ID, 'health-audit-a', 1, 'collected', 'snap1').lastInsertRowid);
  const wave2 = Number(insWave.run(RUN_ID, 'health-audit-a', 2, 'collected', 'snap1').lastInsertRowid);

  const insFinding = db.prepare(`
    INSERT INTO findings (run_id, finding_id, fingerprint, severity, category, file_path, line_number, description, recommendation, status, first_seen_wave, last_seen_wave)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // >=2 rows per status the roadmap's drain/attention sections care about.
  insFinding.run(RUN_ID, 'F-DET-0001', 'fp-det-1', 'HIGH', 'quality', 'packages/a/src/foo.js', 10, 'finding one', 'fix it', 'new', wave1, wave1);
  insFinding.run(RUN_ID, 'F-DET-0002', 'fp-det-2', 'MEDIUM', 'quality', 'packages/b/src/bar.js', 20, 'finding two', 'fix it', 'new', wave1, wave2);
  insFinding.run(RUN_ID, 'F-DET-0003', 'fp-det-3', 'HIGH', 'quality', 'packages/a/src/baz.js', 30, 'finding three', 'fix it', 'approved', wave1, wave2);
  insFinding.run(RUN_ID, 'F-DET-0004', 'fp-det-4', 'LOW', 'quality', 'packages/b/src/qux.js', 40, 'finding four', 'fix it', 'approved', wave1, wave2);
  insFinding.run(RUN_ID, 'F-DET-0005', 'fp-det-5', 'MEDIUM', 'quality', 'packages/a/src/quux.js', 50, 'finding five', 'fix it', 'deferred', wave1, wave1);
  insFinding.run(RUN_ID, 'F-DET-0006', 'fp-det-6', 'LOW', 'quality', 'packages/b/src/corge.js', 60, 'finding six', 'fix it', 'deferred', wave1, wave1);
  // Cross-run recurrence: same fingerprint, older run's row already 'fixed'.
  insFinding.run('roadmap-determinism-r0', 'F-DET-0007', 'fp-det-shared', 'HIGH', 'quality', 'packages/a/src/shared.js', 70, 'shared one', 'fix it', 'fixed', wave1, wave1);
  insFinding.run(RUN_ID, 'F-DET-0008', 'fp-det-shared', 'HIGH', 'quality', 'packages/a/src/shared.js', 70, 'shared one recurrence', 'fix it', 'recurring', wave1, wave2);

  const insAgentRun = db.prepare(`INSERT INTO agent_runs (wave_id, domain_id, status) VALUES (?, ?, ?)`);
  const insClaim = db.prepare(`INSERT INTO file_claims (agent_run_id, file_path, domain_id) VALUES (?, ?, ?)`);
  const domainRows = db.prepare(`SELECT id, name FROM domains WHERE run_id = ?`).all(RUN_ID);
  for (const d of domainRows) {
    const agentRunId = Number(insAgentRun.run(wave1, d.id, 'complete').lastInsertRowid);
    const prefix = d.name === 'domain-a' ? 'a' : 'b';
    insClaim.run(agentRunId, `packages/${prefix}/src/claim1.js`, d.id);
    insClaim.run(agentRunId, `packages/${prefix}/src/claim2.js`, d.id);
  }

  closeDb(dbPath);
}

function runRoadmapCompile(dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, 'roadmap', 'compile', RUN_ID], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

/** @pins F-feeaef78 */
describe('F-feeaef78 — swarm roadmap compile: cross-process determinism', () => {
  it('two separate node processes compiling the identical DB produce byte-identical artifacts', () => {
    const dbDir = makeTmpDir('roadmap-det-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeTmpDir('roadmap-det-repo-');
    mkdirSync(join(repoDir, 'scripts'), { recursive: true });
    // A minimal, REAL-shaped grandfathered-pins.json (owner + revalidate_by —
    // this repo's own scripts/grandfathered-pins.json field shape, not an
    // invented one) so the drain-state section has something non-trivial to
    // read from the target repo checkout.
    writeFileSync(join(repoDir, 'scripts', 'grandfathered-pins.json'), JSON.stringify({
      grandfathered: {
        'F-DET-0005': { owner: 'coordinator', revalidate_by: '2026-10-14' },
        'F-DET-0006': { owner: 'coordinator', revalidate_by: '2026-10-14' },
      },
    }, null, 2));

    seedDeterminismFixture(dbPath, repoDir);

    const first = runRoadmapCompile(dbPath);
    if (first.status !== 0) {
      assert.fail(
        `swarm roadmap compile is not implemented yet (awaiting swarm-cp-core's T1) — ` +
        `first invocation exited ${first.status}. stderr:\n${first.stderr}`
      );
    }

    const artifactPath = join(repoDir, 'dogfood', 'roadmap', `${RUN_ID}.json`);
    const latestPath = join(repoDir, 'dogfood', 'roadmap', 'latest.json');
    assert.ok(existsSync(artifactPath), `expected compiled artifact at ${artifactPath}`);
    assert.ok(existsSync(latestPath), `expected latest.json pointer at ${latestPath}`);

    const firstArtifact = readFileSync(artifactPath);
    const firstLatest = readFileSync(latestPath);

    // Compile a SECOND time, in a SEPARATE process, against the byte-identical
    // DB file on disk — a same-process double-call cannot discriminate a
    // query-plan row-order bug (V8 preserves insertion order regardless of
    // physical scan order); only a fresh process/connection exercises a fresh
    // query plan.
    const second = runRoadmapCompile(dbPath);
    assert.equal(second.status, 0, `second compile invocation must also succeed; stderr:\n${second.stderr}`);

    const secondArtifact = readFileSync(artifactPath);
    const secondLatest = readFileSync(latestPath);

    assert.ok(firstArtifact.equals(secondArtifact),
      '<run-id>.json must be byte-identical across two separate compile processes against the ' +
      'identical DB (T1\'s determinism claim). If this fails because of a wall-clock field (e.g. a ' +
      '"compiled_at" timestamp), that field itself is the bug this test found: T1 promises byte-' +
      'identical output for identical DB state, so any wall-clock content must be omitted or derived ' +
      'from the DB\'s own data (e.g. the latest wave\'s created_at), never datetime(\'now\').');
    // ADJUDICATED at the wave-39 merge: this test's draft demanded latest.json
    // byte-identity too, which contradicts T5's own text — a recompile
    // "supersedes with a new sequence number", and latest.json is the pointer
    // that CARRIES the sequence. T1's determinism claim lives on the
    // sequence-free <run-id>.json content mirror (asserted above); the
    // pointer's job is to CHANGE monotonically, which is what this asserts.
    const firstSeq = JSON.parse(firstLatest.toString()).sequence;
    const secondSeq = JSON.parse(secondLatest.toString()).sequence;
    assert.equal(secondSeq, firstSeq + 1,
      `latest.json's sequence must increment monotonically per compile (T5 supersession); got ${firstSeq} -> ${secondSeq}`);
  });
});

/**
 * Walk the dogfood-swarm package recursively, returning JS source files.
 * Mirrors wave-state-machine.test.js's Pattern #10 walker exactly (skip
 * node_modules/dist/.git/swarms/.swarm; test files are handled by the
 * caller, not here, since this walker is reused for a name-glob filter).
 */
function* walkJs(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'swarms' || entry === '.swarm') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkJs(full);
    } else if (st.isFile() && /\.(js|mjs|cjs)$/.test(entry)) {
      yield full;
    }
  }
}

/**
 * F-2ba518c2 (wave-42 audit, this domain's own wave-42 HIGH): discover the
 * roadmap-compile-path files BY RELATIVE PATH, not by basename. The prior
 * version of this scan tested only `rel.slice(rel.lastIndexOf('/') + 1)`
 * (the basename) against /roadmap/i — every file under lib/roadmap/
 * (artifacts.js, attention.js, compile.js, compiler.js, drain.js, notes.js)
 * was silently excluded, because none of THEIR basenames contain "roadmap"
 * even though the directory does; only commands/roadmap.js and
 * commands/lib/roadmap-notes.js ever matched. PROVEN LIVE (red-proof, see
 * this wave's output.json): in a throwaway scratch worktree, deleting
 * lib/roadmap/drain.js's real `LEFT JOIN waves ... ORDER BY f.finding_id
 * ASC` left the OLD scan green at 0 offenders — it never looked at the
 * file. relative(PKG_DIR, file) (not an absolute-path substring test) means
 * this can never accidentally match on an unrelated ancestor directory
 * name, mirroring the intent (though not the no-filter breadth — see below)
 * of the safe full-tree-walk-plus-content-match shape f-a3af1ac5/
 * f-c0b12add already use correctly. A path filter is kept, rather than
 * dropping it entirely like those two siblings, because THIS scan's own
 * name and purpose is specifically "the roadmap compiler module" — widening
 * it to the whole package would catch unrelated SQL elsewhere with no
 * bearing on T1's determinism claim, which is scope creep, not a fix.
 */
function discoverRoadmapCandidates() {
  const candidates = [];
  for (const file of walkJs(PKG_DIR)) {
    const rel = file.replace(/\\/g, '/');
    if (/\.test\.(js|mjs|cjs)$/.test(rel)) continue;
    if (rel.endsWith('/f-feeaef78-roadmap-compile-determinism.test.js')) continue;
    const relFromPkg = relative(PKG_DIR, file).replace(/\\/g, '/');
    if (!/roadmap/i.test(relFromPkg)) continue;
    candidates.push(file);
  }
  return candidates;
}

describe('F-feeaef78 — roadmap compiler ORDER BY static scan', () => {
  it('discovery: the candidate filter finds every known roadmap-compile-path file (PROTOCOL.md sub-law 2 — enumerate the population independently, diff against the detector)', () => {
    // Independent enumeration, NOT reusing discoverRoadmapCandidates' own
    // logic: an explicit directory listing of lib/roadmap/ (whatever files
    // happen to live there today) plus the two commands/-layer files named
    // directly in F-2ba518c2's own text. If a future regression narrows the
    // discovery filter again (or someone adds a new lib/roadmap/*.js file
    // the filter somehow doesn't catch), this fails HERE with the specific
    // missing filename — not silently, and not by coincidence of the same
    // logic checking itself.
    const knownRoadmapDir = join(PKG_DIR, 'lib', 'roadmap');
    const independentlyEnumerated = existsSync(knownRoadmapDir)
      ? readdirSync(knownRoadmapDir)
          .filter((f) => /\.(js|mjs|cjs)$/.test(f) && !/\.test\.(js|mjs|cjs)$/.test(f))
          .map((f) => `lib/roadmap/${f}`)
      : [];
    for (const known of ['commands/roadmap.js', 'commands/lib/roadmap-notes.js']) {
      if (existsSync(join(PKG_DIR, known))) independentlyEnumerated.push(known);
    }
    assert.ok(independentlyEnumerated.length > 0,
      'sanity: the independent enumeration itself found nothing — either lib/roadmap/ is missing or ' +
      'this test is running against the wrong package directory; a scan that cannot enumerate a known ' +
      'population cannot prove the detector is complete.');

    const candidateRelSet = new Set(
      discoverRoadmapCandidates().map((f) => relative(PKG_DIR, f).replace(/\\/g, '/'))
    );
    const missedByDetector = independentlyEnumerated.filter((f) => !candidateRelSet.has(f));

    assert.deepEqual(
      missedByDetector,
      [],
      `the ORDER BY scan's discovery filter misses known roadmap-compile-path file(s): ` +
      `${JSON.stringify(missedByDetector)} — a detector's blind spot IS the defect (PROTOCOL.md, ` +
      `"Fixing a class, not an instance", sub-law 2).`
    );
  });

  it('every JOIN/UNION/GROUP BY SQL string in the roadmap compiler module carries an explicit ORDER BY', () => {
    const candidates = discoverRoadmapCandidates();

    if (candidates.length === 0) {
      assert.fail(
        'No roadmap-compiler module found under packages/dogfood-swarm (searched every non-test ' +
        '.js/.mjs/.cjs file whose RELATIVE PATH contains "roadmap"). This assertion needs swarm-cp-core ' +
        'to land T1\'s compiler (e.g. lib/roadmap/compile.js or commands/roadmap.js) before it can scan ' +
        'its SQL for ORDER BY clauses — awaiting that lane.'
      );
    }

    // Heuristic SQL-string finder: any quoted/template string containing a
    // SELECT keyword AND at least one JOIN/UNION/GROUP BY — the specific
    // shapes T1 names as the actual reordering risk (a single-table SELECT
    // with no JOIN/UNION/GROUP BY has nothing to reorder). Comments are
    // stripped first so a comment mentioning "SELECT ... JOIN" cannot false-
    // positive (mirrors this package's Pattern #10 discipline of stripping
    // comments/strings before pattern-matching source).
    const stringRe = /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
    const offenders = [];
    for (const file of candidates) {
      const raw = readFileSync(file, 'utf-8');
      const stripped = stripComments(raw);
      let m;
      while ((m = stringRe.exec(stripped))) {
        const s = m[0];
        if (!/\bSELECT\b/i.test(s)) continue;
        if (!/\bJOIN\b|\bUNION\b|\bGROUP\s+BY\b/i.test(s)) continue;
        if (!/\bORDER\s+BY\b/i.test(s)) {
          const line = stripped.slice(0, m.index).split('\n').length;
          offenders.push(`${file.replace(/\\/g, '/')}:${line}: ${s.slice(0, 100).replace(/\n/g, ' ')}...`);
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'every JOIN/UNION/GROUP BY SQL string in the roadmap compiler must carry an explicit ORDER BY ' +
      '(T1\'s determinism claim depends on it — SQLite gives no row-order guarantee otherwise):\n' +
      offenders.map(o => `  ${o}`).join('\n')
    );
  });
});
