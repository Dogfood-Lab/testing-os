/**
 * f-8a97a700-roadmap-digest-injection.test.js
 *
 * F-8a97a700 [HIGH] — T4 (docs/trajectory-and-closure.dispatch.md) bundles
 * three distinct, separately-testable claims about how a compiled roadmap
 * gets consumed by a NEW run's dispatch:
 *
 *   (a) POSITION — the digest renders at the TOP of a generated audit brief,
 *       not merely somewhere in it (Lost in the Middle, arXiv:2307.03172,
 *       cited directly in the dispatch).
 *   (b) BOUNDS — the injected digest stays small (top-K + unexpired notes +
 *       drain summary) even when the underlying roadmap artifact is large,
 *       with the full artifact addressable on disk (MemGPT paging).
 *   (c) OPT-IN ONLY — a new run must NOT read or inject anything from a
 *       prior run's roadmap absent an explicit flag, even when
 *       `dogfood/roadmap/latest.json` exists on disk. This is the highest-
 *       value test in the dispatch: it is structurally identical to this
 *       run's own worst-repeated bug shape (F-18d0ef6d / F-a9c399ce — a
 *       boundary silently trusting shared state it should not), moved from
 *       cross-DOMAIN to cross-RUN.
 *
 * STATUS split by sub-claim:
 *
 *   (a) is tested against `buildAuditPrompt` (packages/dogfood-swarm/lib/
 *       templates.js), a REAL, already-shipped, pure function — no guessing
 *       about core's future file layout. The ONE assumption: a new
 *       `opts.roadmapDigest` string parameter, prepended before the existing
 *       "## Your Scope" section. RED today because buildAuditPrompt does not
 *       read that option at all yet (confirmed by reading its full source
 *       before writing this test).
 *
 *   (b) and (c) are tested against `dispatch()` (commands/dispatch.js),
 *       likewise real and already-shipped (proven working, non-isolated,
 *       non-git-dependent, in dispatch-amend-filter.test.js's own pattern,
 *       reused here). The ADDITIONAL assumption: a new boolean
 *       `opts.seedRoadmap` that gates whether dispatch reads
 *       `<runs.local_path>/dogfood/roadmap/latest.json` before rendering
 *       prompts. If core's real flag name differs (e.g. a CLI
 *       `--seed-roadmap` surfaced as a different opts key), update the
 *       `dispatch({ ... })` calls below to match — the CONTRACT property
 *       under test (opt-in, not the exact key spelling) is what's load-
 *       bearing.
 *
 * Honesty note on (c)'s negative half, UPDATED (wave 43 — the original claim
 * below is now STALE and is corrected here, not deleted, per this repo's
 * own doc-drift discipline): dispatch.js no longer has "literally zero
 * roadmap-reading code" — commands/dispatch.js#loadRoadmapDigestSource /
 * #buildRoadmapDigest shipped in a later wave, gated on opts.seedRoadmap.
 * "no flag -> no leak" is now a REAL, non-vacuous negative (dispatch simply
 * never calls buildRoadmapDigest without the flag) — it was the (b)/(c)-
 * positive halves that were vacuous-until-paired, and per the reading below
 * those are the halves this wave's A3 fixture rewrite affects.
 *
 * A3 DEPENDENCY, DISCLOSED (docs/trajectory-and-closure.dispatch.md,
 * Amendment 3, wave 42): this file's fixture-writing helper below is
 * rewritten to A3's artifact shapes (attention {advisory, items}, drain_
 * queue.{entries, overdue_ids}) — a CONTRACT PIN. Unlike f-1cd5de59/
 * f-74ba2c79, whose only dependency is commands/roadmap.js's COMPILE-side
 * emitter (explicitly in A3's scope), (b)/(c)-positive ALSO depend on
 * commands/dispatch.js's buildRoadmapDigest/loadRoadmapDigestSource — the
 * CONSUME-side reader — being updated to read `.attention.items` and
 * `.drain_queue.entries` instead of the flat shapes it reads today. A3's
 * own text (T1-T6, A3.1-A3.6) is scoped to the COMPILED ARTIFACT, never
 * mentions dispatch.js's digest-consumption code, and neither this wave's
 * brief names an owner for that update. Verified directly (this worktree,
 * pre-fix): with this file's new fixture shape, buildRoadmapDigest's
 * `Array.isArray(source.attention)` / `Array.isArray(source.drain)` checks
 * both go false (attention is now an object, drain is now named drain_
 * queue), so BOTH sections render empty and (b)/(c)-positive fail — for
 * that reason, not a typo. This is a genuine open dependency, not an
 * assumption I could privately resolve from this domain's own glob
 * (packages/dogfood-swarm/*.test.js does not include commands/dispatch.js)
 * — flagged in this wave's output.json rather than silently assumed covered.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb } from './db/connection.js';
import { saveDomainDraft, freezeDomains } from './lib/domains.js';
import { dispatch } from './commands/dispatch.js';
import { buildAuditPrompt } from './lib/templates.js';

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

/** @pins F-8a97a700 */
describe('F-8a97a700(a) — roadmap digest POSITION in the audit brief', () => {
  it('the digest appears BEFORE the first substantive section ("## Your Scope"), not merely present somewhere in the brief', () => {
    const marker = 'ROADMAP_DIGEST_MARKER_f8a97a700';
    const baseOpts = {
      repoPath: '/fake/repo',
      repo: 'org/repo',
      domainName: 'domain-a',
      globs: ['packages/a/**'],
      phase: 'health-audit-a',
      waveNumber: 1,
      ownershipClass: 'owned',
      domainSnapshotId: 'snap1',
    };

    const withDigest = buildAuditPrompt({ ...baseOpts, roadmapDigest: marker });

    // Presence FIRST, as its own assertion — indexOf returns -1 for an absent
    // marker, and -1 < (any positive offset) is mathematically true, which
    // would make a bare position comparison pass vacuously for a digest that
    // was never rendered at all. This is the exact trap cli-smoke.test.js's
    // F-cb350c90 fix separates content-presence from position/alignment for.
    const digestOffset = withDigest.indexOf(marker);
    assert.notEqual(digestOffset, -1,
      `roadmap digest marker must appear in the rendered brief at all (awaiting swarm-cp-core to ` +
      `thread opts.roadmapDigest through buildAuditPrompt); got brief:\n${withDigest.slice(0, 400)}...`);

    const scopeOffset = withDigest.indexOf('## Your Scope');
    assert.notEqual(scopeOffset, -1, 'sanity: "## Your Scope" must exist in every audit brief');

    assert.ok(digestOffset < scopeOffset,
      `roadmap digest (offset ${digestOffset}) must render BEFORE "## Your Scope" (offset ${scopeOffset}) ` +
      `— Lost in the Middle (arXiv:2307.03172): early position is the whole point of a "top of brief" digest.`);
  });
});

/**
 * Seeds a run + 1 frozen domain whose local_path is a REAL temp directory
 * (required so a real `dogfood/roadmap/latest.json` can be planted for
 * dispatch to conditionally read), and returns enough to call dispatch().
 */
function setupDispatchFixture(runId) {
  const dbDir = makeTmpDir('digest-db-');
  const dbPath = join(dbDir, 'control-plane.db');
  const repoDir = makeTmpDir('digest-repo-');

  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(runId, 'org/repo', repoDir, 'a'.repeat(40), 'main', 'pending');
  saveDomainDraft(db, runId, [{ name: 'domain-a', globs: ['packages/a/**'], ownership_class: 'owned' }]);
  freezeDomains(db, runId);
  closeDb(dbPath);

  return { dbPath, repoDir };
}

/**
 * A3 UPDATE (docs/trajectory-and-closure.dispatch.md, Amendment 3, wave 42;
 * MERGE-RECONCILED wave 43 — both the tests lane and the verbs lane
 * re-authored this fixture to the same contract independently): the fixture
 * writes A3.1/A3.2's actual schema shapes — `attention` is `{advisory,
 * items[+components]}`, never a flat array; the drain half this file
 * exercises is `drain_queue.{entries, overdue_ids}` (A3.2(a),
 * compileAuthoredDrainState's runs-ordinal shape); the SEPARATE
 * `grandfathered_drain.{frozen_total, drained, outstanding}` section
 * (A3.2(b)) is also present, structurally valid but empty, so the fixture
 * carries BOTH of "the two drain sections". `notes` -> `operator_notes`.
 * The same wave updated commands/dispatch.js's digest reader
 * (buildRoadmapDigest/loadRoadmapDigestSource) to read these shapes —
 * against the OLD flat shape it silently produced an EMPTY digest, the
 * "seeded-digest feature ships reading nothing" defect. Neither (b) nor
 * (c) below asserts drain CONTENT — drainCount only bulks the artifact for
 * truncation testing; the sub-claims under test (position, bounds/
 * truncation, opt-in gating) are unchanged.
 */
function writeRoadmapArtifact(repoDir, { attentionCount, drainCount, uniqueMarkerFile }) {
  mkdirSync(join(repoDir, 'dogfood', 'roadmap'), { recursive: true });
  const attention = {
    advisory: true,
    items: Array.from({ length: attentionCount }, (_, i) => ({
      file: i === 0 && uniqueMarkerFile ? uniqueMarkerFile : `packages/a/src/attn-file-${i}.js`,
      score: attentionCount - i,
      components: { churn: 1, recency: 1, fragmentation: 1 },
    })),
  };
  const drainEntries = Array.from({ length: drainCount }, (_, i) => ({
    id: `F-${String(i).padStart(6, '0')}`,
    owner: 'coordinator',
    cadence_runs: 5,
    runs_since_review: 1,
    overdue: false,
    reason: `drain entry ${i}`,
  }));
  writeFileSync(join(repoDir, 'dogfood', 'roadmap', 'latest.json'), JSON.stringify({
    attention,
    drain_queue: { entries: drainEntries, overdue_ids: [] },
    grandfathered_drain: { frozen_total: 0, drained: 0, outstanding: [] },
    operator_notes: [],
  }, null, 2));
}

describe('F-8a97a700(b) — roadmap digest BOUNDS when the underlying artifact is large', () => {
  it('a 200-file attention list + 500-entry drain queue is injected TRUNCATED with a "+N more, see <path>" pointer, never a raw dump', () => {
    const runId = 'digest-bounds-r1';
    const { dbPath, repoDir } = setupDispatchFixture(runId);
    const uniqueMarkerFile = 'packages/a/src/zzz-attn-file-should-be-truncated-away.js';
    // Fixture adjudication (wave-39 merge): the first draft ALSO passed
    // uniqueMarkerFile into writeRoadmapArtifact, which plants it at index 0
    // with the MAXIMUM score — so the marker existed twice, once at top rank,
    // and no correct top-K truncation could exclude it. The marker belongs
    // only at the tail with the worst score, which is what this override does.
    writeRoadmapArtifact(repoDir, { attentionCount: 200, drainCount: 500 });
    const artifact = JSON.parse(readFileSync(join(repoDir, 'dogfood', 'roadmap', 'latest.json'), 'utf-8'));
    // A3 contract pin: attention is {advisory, items[+components]} (A3.1),
    // never a flat array — the marker override reaches into .items now.
    const lastIdx = artifact.attention.items.length - 1;
    artifact.attention.items[lastIdx] = { file: uniqueMarkerFile, score: -1, components: { churn: 0, recency: 0, fragmentation: 0 } };
    writeFileSync(join(repoDir, 'dogfood', 'roadmap', 'latest.json'), JSON.stringify(artifact, null, 2));

    const result = dispatch({
      runId, phase: 'health-audit-a', dbPath, outputDir: makeTmpDir('digest-out-'),
      seedRoadmap: true,
    });

    assert.equal(result.agents.length, 1, 'one agent prompt written');
    const promptText = readFileSync(result.agents[0].promptPath, 'utf-8');

    assert.ok(!promptText.includes(uniqueMarkerFile),
      `the LOWEST-ranked attention entry must be truncated away, not dumped in full; found ` +
      `"${uniqueMarkerFile}" in the rendered prompt (awaiting swarm-cp-core's T4 bounding — this is ` +
      `RED until dispatch actually reads and truncates the roadmap digest)`);
    assert.match(promptText, /\+\s*\d+\s*more/i,
      `truncated digest must carry an explicit "+N more" pointer so the operator knows content was ` +
      `cut, not silently dropped; prompt did not contain one`);
    assert.match(promptText, /dogfood[\\/]roadmap/i,
      'truncated digest must point at the full artifact on disk (MemGPT-style paging) so the operator ' +
      'can retrieve everything that was cut');
  });
});

describe('F-8a97a700(c) — roadmap digest is OPT-IN, never silently read from a prior run', () => {
  it('a new run dispatched WITHOUT the seed flag shows zero trace of an existing dogfood/roadmap/latest.json', () => {
    const runId = 'digest-optin-negative-r1';
    const { dbPath, repoDir } = setupDispatchFixture(runId);
    const uniqueMarkerFile = 'packages/a/src/zzz-prior-run-marker-should-never-leak.js';
    writeRoadmapArtifact(repoDir, { attentionCount: 3, drainCount: 3, uniqueMarkerFile });

    const result = dispatch({
      runId, phase: 'health-audit-a', dbPath, outputDir: makeTmpDir('digest-out-'),
      // seedRoadmap deliberately omitted — this is the default path.
    });

    const promptText = readFileSync(result.agents[0].promptPath, 'utf-8');
    assert.ok(!promptText.includes(uniqueMarkerFile),
      `a prior run's roadmap content must NEVER leak into a new run's brief absent an explicit opt-in ` +
      `flag — found "${uniqueMarkerFile}" anyway (Semgrep's explicit opt-in triage-propagation precedent, ` +
      `Q5 in the dispatch). This IS a real, non-vacuous negative today (dispatch.js only calls ` +
      `buildRoadmapDigest when opts.seedRoadmap is set) — see this file's opening docstring for the ` +
      `wave-43 correction of an earlier, now-stale "vacuous because unimplemented" claim here.`);
  });

  it('the SAME prior roadmap DOES inject when the run opts in — so the negative test above is not vacuous in either direction', () => {
    const runId = 'digest-optin-positive-r1';
    const { dbPath, repoDir } = setupDispatchFixture(runId);
    const uniqueMarkerFile = 'packages/a/src/zzz-prior-run-marker-should-appear-when-seeded.js';
    writeRoadmapArtifact(repoDir, { attentionCount: 3, drainCount: 3, uniqueMarkerFile });

    const result = dispatch({
      runId, phase: 'health-audit-a', dbPath, outputDir: makeTmpDir('digest-out-'),
      seedRoadmap: true,
    });

    const promptText = readFileSync(result.agents[0].promptPath, 'utf-8');
    // A3 contract pin — goes green at wave-43 merge, dependent on
    // commands/dispatch.js's buildRoadmapDigest/loadRoadmapDigestSource
    // being updated to read attention.items instead of a flat attention
    // array (this file's opening docstring's "A3 DEPENDENCY, DISCLOSED"
    // note has the full reasoning). opts.seedRoadmap itself already exists
    // and works — the marker fails to appear because the digest's attention
    // section renders empty against the new fixture shape, not because the
    // flag is unimplemented.
    assert.ok(promptText.includes(uniqueMarkerFile),
      `with the explicit seed flag set, the prior run's roadmap content MUST appear in the new brief ` +
      `— awaiting commands/dispatch.js's digest reader to be updated to A3's attention.items/` +
      `drain_queue.entries shapes (opts.seedRoadmap itself already works). This is the red half that ` +
      `makes the negative test above meaningful once both pass together.`);
  });
});
