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
 * Honesty note on (c)'s negative half: "no flag -> no leak" is TRUE today,
 * but only because dispatch.js has literally zero roadmap-reading code yet —
 * a vacuous pass, not a verified gate. It becomes non-vacuous only once
 * paired with its positive sibling test ("with flag -> digest present"),
 * which is genuinely RED today. Do not read the negative test's current
 * green as evidence the opt-in gate works; read the positive test's red as
 * the honest state of this claim until swarm-cp-core lands the flag.
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

function writeRoadmapArtifact(repoDir, { attentionCount, drainCount, uniqueMarkerFile }) {
  mkdirSync(join(repoDir, 'dogfood', 'roadmap'), { recursive: true });
  const attention = Array.from({ length: attentionCount }, (_, i) => ({
    file: i === 0 && uniqueMarkerFile ? uniqueMarkerFile : `packages/a/src/attn-file-${i}.js`,
    score: attentionCount - i,
  }));
  const drain = Array.from({ length: drainCount }, (_, i) => ({
    id: `F-${String(i).padStart(6, '0')}`,
    owner: 'coordinator',
    reason: `drain entry ${i}`,
  }));
  writeFileSync(join(repoDir, 'dogfood', 'roadmap', 'latest.json'), JSON.stringify({ attention, drain, notes: [] }, null, 2));
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
    artifact.attention[artifact.attention.length - 1] = { file: uniqueMarkerFile, score: -1 };
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
      `Q5 in the dispatch). NOTE: this assertion is TRUE today only because dispatch.js has no roadmap-` +
      `reading code at all yet — it is not yet evidence the opt-in GATE works. See this file's opening ` +
      `docstring.`);
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
    assert.ok(promptText.includes(uniqueMarkerFile),
      `with the explicit seed flag set, the prior run's roadmap content MUST appear in the new brief ` +
      `— awaiting swarm-cp-core to land opts.seedRoadmap (or equivalent) in dispatch(). This is the red ` +
      `half that makes the negative test above meaningful once both pass together.`);
  });
});
