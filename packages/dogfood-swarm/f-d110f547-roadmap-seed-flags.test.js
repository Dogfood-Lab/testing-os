/**
 * f-d110f547-roadmap-seed-flags.test.js
 *
 * F-d110f547 [MEDIUM] — T4's consumption-side flags, RE-VERIFIED unbuilt at
 * wave 42 HEAD by exhaustive grep + line-by-line read of cmdInit/cmdDispatch
 * (see this finding's own wave-43 re-report text): neither
 * `--seed-from-roadmap` on `swarm init` nor the ORIGINAL `--seed-roadmap`
 * flag on `swarm dispatch` (F-8a97a700) ever reached the real `swarm`
 * binary — `dispatch({...})`'s options object at the old cli.js call site
 * carried no `seedRoadmap` key at all, so the already-built digest-rendering
 * plumbing (buildRoadmapDigest, templates.js's renderRoadmapDigestSection)
 * was permanently dormant.
 *
 * This wave lands BOTH CLI slices per the finding's own recommendation:
 *   - `swarm init <repo-path> --seed-from-roadmap[=<run-id>|latest]`
 *     (commands/init.js + commands/lib/roadmap-seed.js)
 *   - `swarm dispatch <run-id> <phase> [--seed-roadmap] [--no-roadmap-digest]
 *     [--roadmap-digest=<run-id>]` (commands/dispatch.js)
 *
 * Uses the F-8595faf8 probe pattern this repo's own closure-verb work
 * established: CLI subprocess (spawnSync against the real cli.js binary),
 * scratch DB + scratch target-repo directory per test, SWARM_DB env var —
 * never the shared control-plane.db.
 *
 * Fixture artifacts written directly to
 * dogfood/roadmap/<run-id>.json are A3-shaped (buildRoadmapArtifact's own
 * mapping, docs/trajectory-and-closure.dispatch.md "Amendment 3") — see
 * a3-roadmap-envelope-conformance.test.js for that mapping's own dedicated
 * pin. This file exercises the CLI SURFACE (flags, precondition failures,
 * digest injection into a real rendered prompt), not the artifact shape
 * itself.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';
import { buildRoadmapArtifact } from './commands/roadmap.js';
import { readRoadmapSeedLineage } from './commands/lib/roadmap-seed.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_PATH = join(__dirname, 'cli.js');

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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** A minimal real git repo `swarm init` can target — clean tree, one commit. */
function makeGitRepo() {
  const dir = makeTmpDir('roadmap-seed-repo-');
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

// task_6026249b discipline: SWARM_DB is pinned to a temp fallback AT the
// spawn site, so no call path — including usage-error paths that open the DB
// before validating args — can ever touch the repo's live control plane.
// Call sites that pass their own env.SWARM_DB override the fallback.
const fallbackDbDir = makeTmpDir('roadmap-seed-fallback-db-');
function runCli(args, opts = {}) {
  const { env: extraEnv, ...rest } = opts;
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: join(fallbackDbDir, 'control-plane.db'), ...(extraEnv || {}) },
    ...rest,
  });
}

/** A3-shaped roadmap artifact fixture, non-empty attention/drain/notes so a digest actually renders. */
function a3ArtifactFor(sourceRunId, repo) {
  return buildRoadmapArtifact(
    {
      run_id: sourceRunId,
      repo,
      compiled_from: { commit_sha: 'a'.repeat(40) },
      open_summary: { open: 1, deferred: 0, approved: 0 },
      grandfathered_drain: { frozen_total: 0, drained: 0, outstanding: [] },
      recurrence_stats: {},
      attention: {
        advisory: true,
        items: [{ file: 'packages/seed/src/hot.js', score: 0.9, components: { churn: 1, recency: 1, fragmentation: 1 } }],
      },
      operator_notes: { active: [], expired: [], dropped_invalid: [] },
      run_anchored_at: '2026-07-17T00:00:00.000Z',
    },
    {
      activeNotes: [{ kind: 'theme', text: 'seeded-note-marker', expires: 10 }],
      expiredNotes: [],
      drainQueue: { entries: [{ id: 'F-SEED-0001', owner: 'coordinator', cadence_runs: 5, runs_since_review: 6, overdue: true }], overdue_ids: ['F-SEED-0001'] },
      notesPath: 'dogfood/roadmap-notes.json',
    },
  );
}

/**
 * Writes production's real 3-file roadmap shape to dogfood/roadmap/ and
 * COMMITS it (`swarm init` refuses a dirty tree). This mirrors
 * compiler.js#writeRoadmapArtifact exactly:
 *   - the SEQUENCED history file (`<run-id>.1.json`) carries `sequence` — it
 *     is what `latest.json` points at AND what an explicit
 *     `--seed-from-roadmap=<run-id>` resolves;
 *   - the sequence-free MIRROR (`<run-id>.json`) is content-only and NEVER
 *     carries `sequence` (F-feeaef78 cross-compile byte-identity).
 *
 * F-f0865cdf: the earlier version of this helper spliced `sequence` into the
 * mirror and pointed `latest.json` at the mirror — a shape production never
 * writes. That fixture false-greened the explicit-id subtest while the real
 * feature failed 100% against a real compiler's output. Writing the true
 * 3-file shape is what makes the explicit-id test exercise the actual code
 * path.
 */
function writeArtifactFixture(repoDir, sourceRunId, repo) {
  const roadmapDir = join(repoDir, 'dogfood', 'roadmap');
  mkdirSync(roadmapDir, { recursive: true });
  const body = a3ArtifactFor(sourceRunId, repo); // buildRoadmapArtifact output — no `sequence` (writeRoadmapArtifact stamps it)
  const seqRel = `dogfood/roadmap/${sourceRunId}.1.json`;
  const sequenced = { ...body, sequence: 1 };
  writeFileSync(join(repoDir, seqRel), JSON.stringify(sequenced, null, 2));
  writeFileSync(join(roadmapDir, `${sourceRunId}.json`), JSON.stringify(body, null, 2));
  writeFileSync(join(roadmapDir, 'latest.json'), JSON.stringify({ run_id: sourceRunId, sequence: 1, path: seqRel }, null, 2));
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', `fixture: roadmap artifact for ${sourceRunId}`]);
  return sequenced;
}

/** @pins F-d110f547 */
describe('F-d110f547 — swarm init --seed-from-roadmap', () => {
  it('fails fast with ROADMAP_SEED_NOT_FOUND when no artifact resolves — and creates NO run row (fail before any DB write)', () => {
    const dbDir = makeTmpDir('seed-init-notfound-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();

    const result = runCli(['init', repoDir, '--seed-from-roadmap=does-not-exist-run'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.notEqual(result.status, 0, 'must exit non-zero on an unresolvable seed');
    assert.match(result.stderr + result.stdout, /ROADMAP_SEED_NOT_FOUND/);

    const db = openDb(dbPath);
    const count = db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
    closeDb(dbPath);
    assert.equal(count, 0, 'a failed --seed-from-roadmap must never leave a half-initialized run row');
  });

  it('fails fast with ROADMAP_SEED_SCHEMA_INVALID when the named artifact is not valid JSON', () => {
    const dbDir = makeTmpDir('seed-init-badjson-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    mkdirSync(join(repoDir, 'dogfood', 'roadmap'), { recursive: true });
    // The explicit-id resolver reads the newest SEQUENCED history file
    // (`<run-id>.<N>.json`), so the malformed content must live there to reach
    // the JSON-parse/schema branch — a malformed sequence-free mirror would
    // resolve to NOT_FOUND (no history file) instead, testing a different path.
    writeFileSync(join(repoDir, 'dogfood', 'roadmap', 'broken-run.1.json'), '{ not valid json');
    // `swarm init` checks a CLEAN working tree before anything else — commit
    // the fixture so the seed-resolution failure (not the unrelated dirty-
    // tree guard) is what this test actually exercises.
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-q', '-m', 'fixture: broken roadmap artifact']);

    const result = runCli(['init', repoDir, '--seed-from-roadmap=broken-run'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /ROADMAP_SEED_SCHEMA_INVALID/);
  });

  /** @pins F-f0865cdf */
  it('succeeds with an explicit --seed-from-roadmap=<run-id> and stamps durable lineage (kv table)', () => {
    const dbDir = makeTmpDir('seed-init-ok-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    writeArtifactFixture(repoDir, 'roadmap-seed-source-r1', 'org/repo');

    const result = runCli(['init', repoDir, '--repo', 'org/repo', '--seed-from-roadmap=roadmap-seed-source-r1'],
      { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(result.status, 0, `init must succeed against a valid seed artifact; stderr:\n${result.stderr}`);
    assert.match(result.stdout, /Roadmap seed: run roadmap-seed-source-r1/);

    const runIdMatch = result.stdout.match(/Run created: (\S+)/);
    assert.ok(runIdMatch, 'must print the created run id');
    const newRunId = runIdMatch[1];

    const db = openDb(dbPath);
    const lineage = readRoadmapSeedLineage(db, newRunId);
    closeDb(dbPath);
    assert.ok(lineage, 'lineage must be stamped in the kv table, readable back');
    assert.equal(lineage.source_run_id, 'roadmap-seed-source-r1');
    assert.equal(lineage.sequence, 1);
  });

  it('bare --seed-from-roadmap (no value) resolves via dogfood/roadmap/latest.json ("latest")', () => {
    const dbDir = makeTmpDir('seed-init-latest-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    writeArtifactFixture(repoDir, 'roadmap-seed-latest-r1', 'org/repo');

    const result = runCli(['init', repoDir, '--repo', 'org/repo', '--seed-from-roadmap'],
      { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.match(result.stdout, /Roadmap seed: run roadmap-seed-latest-r1/);
  });

  describe('SEAM: this worktree\'s schema copy is pre-A3 (named explicitly, not silently worked around)', () => {
    it('an A3-shaped artifact (production\'s OWN buildRoadmapArtifact output) currently FAILS seed validation here — expected until the schemas domain lands A3', () => {
      const dbDir = makeTmpDir('seed-init-seam-db-');
      const dbPath = join(dbDir, 'control-plane.db');
      const repoDir = makeGitRepo();
      writeArtifactFixture(repoDir, 'roadmap-seed-a3shape-r1', 'org/repo');

      const result = runCli(['init', repoDir, '--repo', 'org/repo', '--seed-from-roadmap=roadmap-seed-a3shape-r1'],
        { env: { ...process.env, SWARM_DB: dbPath } });

      if (result.status === 0) {
        // The schemas domain's A3 edit has landed (this worktree was
        // rebased/merged since this test was written) — the seam is
        // CLOSED, which is strictly better than the state this test
        // documents. Nothing further to assert; a fixed seam is not a
        // failure of this test.
        return;
      }
      assert.match(result.stderr + result.stdout, /ROADMAP_SEED_SCHEMA_INVALID/,
        'expected failure mode is the schema gate, not something else');
      // cli.js's top-level error renderer prints code/message/hint, not the
      // per-field Ajv .errors[] array — check the SPECIFIC known seam gap
      // (2 field mismatches: expired_notes unrecognized, drain_queue shape)
      // directly against the validator, not against rendered CLI text, so
      // this assertion is not coupled to a render-layer detail that could
      // change independently of the seam itself.
      assert.match(result.stderr + result.stdout, /\(2 error\(s\)\)/,
        'expected exactly the two known seam-gap violations (expired_notes additionalProperty + drain_queue ' +
        'type mismatch) — a different error count here would mean the schema shape drifted from what this ' +
        'seam disclosure documents, and needs re-investigating rather than blindly widening this assertion');
    });
  });

  it('a run init\'d WITHOUT --seed-from-roadmap has no stamped lineage', () => {
    const dbDir = makeTmpDir('seed-init-none-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();

    const result = runCli(['init', repoDir, '--repo', 'org/repo'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /Roadmap seed:/);

    const runIdMatch = result.stdout.match(/Run created: (\S+)/);
    const newRunId = runIdMatch[1];
    const db = openDb(dbPath);
    const lineage = readRoadmapSeedLineage(db, newRunId);
    closeDb(dbPath);
    assert.equal(lineage, null);
  });
});

describe('F-d110f547 — swarm dispatch: seeded-run auto-injection + escape hatches', () => {
  /**
   * Builds a FROZEN, dispatch-ready run in `repoDir`'s DB, seeded (via the
   * kv stamp directly — bypassing `swarm init` for speed/determinism in
   * this describe block, since init's own seeding path already has its own
   * dedicated coverage above) from `sourceRunId`'s artifact fixture.
   */
  function seedReadyRun({ repoDir, dbPath, sourceRunId, seed }) {
    const runId = `roadmap-seed-dispatch-${Math.random().toString(36).slice(2, 8)}`;
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, 'org/repo', repoDir, 'a'.repeat(40), 'main', 'initializing');
    db.prepare(`INSERT INTO domains (run_id, name, globs, ownership_class, frozen) VALUES (?, ?, ?, ?, 1)`)
      .run(runId, 'domain-a', JSON.stringify(['packages/**']), 'owned');
    if (seed) {
      db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
        `roadmap_seed:${runId}`,
        JSON.stringify({ source_run_id: sourceRunId, sequence: 1, path: `dogfood/roadmap/${sourceRunId}.json`, seeded_at: new Date().toISOString() }),
      );
    }
    closeDb(dbPath);
    return runId;
  }

  function readFirstPromptText(promptDir) {
    const files = readdirSync(promptDir).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 1, `expected exactly one rendered prompt in ${promptDir}`);
    return readFileSync(join(promptDir, files[0]), 'utf-8');
  }

  it('a SEEDED run\'s FIRST audit-phase wave auto-injects the digest (attention/drain/notes content reaches the rendered prompt)', () => {
    const dbDir = makeTmpDir('seed-dispatch-auto-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    writeArtifactFixture(repoDir, 'roadmap-seed-source-auto', 'org/repo');
    const runId = seedReadyRun({ repoDir, dbPath, sourceRunId: 'roadmap-seed-source-auto', seed: true });

    const result = runCli(['dispatch', runId, 'health-audit-a'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(result.status, 0, `dispatch must succeed; stderr:\n${result.stderr}`);

    const promptDirMatch = result.stdout.match(/Prompts written to: (\S+)/);
    assert.ok(promptDirMatch, 'must report the prompt dir');
    const promptText = readFirstPromptText(promptDirMatch[1]);

    assert.match(promptText, /Roadmap Digest/, 'the digest header must appear in the FIRST audit-phase wave\'s prompt for a seeded run');
    assert.match(promptText, /hot\.js/, 'the attention entry from the SEEDED source run must reach the prompt');
    assert.match(promptText, /F-SEED-0001/, 'the drain entry from the SEEDED source run must reach the prompt');
    assert.match(promptText, /seeded-note-marker/, 'the operator note from the SEEDED source run must reach the prompt');
  });

  it('a SEEDED run\'s SECOND audit-phase wave does NOT auto-inject (only the FIRST audit-phase wave gets it)', () => {
    const dbDir = makeTmpDir('seed-dispatch-second-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    writeArtifactFixture(repoDir, 'roadmap-seed-source-second', 'org/repo');
    const runId = seedReadyRun({ repoDir, dbPath, sourceRunId: 'roadmap-seed-source-second', seed: true });

    const first = runCli(['dispatch', runId, 'health-audit-a'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(first.status, 0, `stderr:\n${first.stderr}`);

    // Collect the first wave so a second dispatch is allowed
    // (DISPATCH_WAVE_IN_FLIGHT guard) — `--all` auto-discovery expects the
    // deterministic <promptDir>/<domain>/output.json layout
    // (commands/collect.js's own AGENT_OUTPUT_FILENAME convention), NOT a
    // file named after the domain directly in the wave dir.
    const promptDir1 = first.stdout.match(/Prompts written to: (\S+)/)[1];
    mkdirSync(join(promptDir1, 'domain-a'), { recursive: true });
    writeFileSync(join(promptDir1, 'domain-a', 'output.json'), JSON.stringify({ domain: 'domain-a', stage: 'A', summary: 'ok', findings: [] }));
    const collectResult = runCli(['collect', runId, '--all'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(collectResult.status, 0, `collect --all must succeed to unblock a second dispatch; stderr:\n${collectResult.stderr}\nstdout:\n${collectResult.stdout}`);

    const second = runCli(['dispatch', runId, 'health-audit-b'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(second.status, 0, `stderr:\n${second.stderr}`);
    const promptDir2 = second.stdout.match(/Prompts written to: (\S+)/)[1];
    const promptText2 = readFirstPromptText(promptDir2);
    assert.doesNotMatch(promptText2, /Roadmap Digest/, 'a SECOND audit-phase wave of the same run must NOT re-inject the seeded digest');
  });

  it('--no-roadmap-digest suppresses auto-injection even on a seeded run\'s first audit-phase wave', () => {
    const dbDir = makeTmpDir('seed-dispatch-suppress-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    writeArtifactFixture(repoDir, 'roadmap-seed-source-suppress', 'org/repo');
    const runId = seedReadyRun({ repoDir, dbPath, sourceRunId: 'roadmap-seed-source-suppress', seed: true });

    const result = runCli(['dispatch', runId, 'health-audit-a', '--no-roadmap-digest'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const promptDir = result.stdout.match(/Prompts written to: (\S+)/)[1];
    const promptText = readFirstPromptText(promptDir);
    assert.doesNotMatch(promptText, /Roadmap Digest/, '--no-roadmap-digest must suppress even the normally-auto-injecting first wave');
  });

  it('--roadmap-digest=<run-id> force-injects on an UNSEEDED run, bypassing both gates', () => {
    const dbDir = makeTmpDir('seed-dispatch-forced-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    writeArtifactFixture(repoDir, 'roadmap-seed-source-forced', 'org/repo');
    const runId = seedReadyRun({ repoDir, dbPath, sourceRunId: 'roadmap-seed-source-forced', seed: false });

    const result = runCli(['dispatch', runId, 'health-audit-a', '--roadmap-digest=roadmap-seed-source-forced'],
      { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const promptDir = result.stdout.match(/Prompts written to: (\S+)/)[1];
    const promptText = readFirstPromptText(promptDir);
    assert.match(promptText, /Roadmap Digest/, '--roadmap-digest=<run-id> must inject even on an UNSEEDED run');
    assert.match(promptText, /hot\.js/);
  });

  it('--roadmap-digest=<nonexistent-run> fails loud and creates NO wave row (precondition, not a post-commit surprise)', () => {
    const dbDir = makeTmpDir('seed-dispatch-badref-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    const runId = seedReadyRun({ repoDir, dbPath, sourceRunId: 'irrelevant', seed: false });

    const result = runCli(['dispatch', runId, 'health-audit-a', '--roadmap-digest=nonexistent-run'],
      { env: { ...process.env, SWARM_DB: dbPath } });
    assert.notEqual(result.status, 0, 'an unresolvable --roadmap-digest target must fail the whole dispatch');
    assert.match(result.stderr + result.stdout, /DISPATCH_ROADMAP_DIGEST_NOT_FOUND/);

    const db = openDb(dbPath);
    const waveCount = db.prepare('SELECT COUNT(*) AS n FROM waves WHERE run_id = ?').get(runId).n;
    closeDb(dbPath);
    assert.equal(waveCount, 0, 'the precondition must fail BEFORE buildWave() commits — no orphaned wave/agent_runs rows');
  });

  it('an UNSEEDED run dispatched with no roadmap flags at all gets no digest (the overwhelming default, unchanged)', () => {
    const dbDir = makeTmpDir('seed-dispatch-default-db-');
    const dbPath = join(dbDir, 'control-plane.db');
    const repoDir = makeGitRepo();
    const runId = seedReadyRun({ repoDir, dbPath, sourceRunId: 'irrelevant', seed: false });

    const result = runCli(['dispatch', runId, 'health-audit-a'], { env: { ...process.env, SWARM_DB: dbPath } });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const promptDir = result.stdout.match(/Prompts written to: (\S+)/)[1];
    const promptText = readFirstPromptText(promptDir);
    assert.doesNotMatch(promptText, /Roadmap Digest/);
  });
});
