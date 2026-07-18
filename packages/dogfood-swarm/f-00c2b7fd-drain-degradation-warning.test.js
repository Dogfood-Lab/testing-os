/**
 * f-00c2b7fd-drain-degradation-warning.test.js
 *
 * F-00c2b7fd [MEDIUM] — lib/roadmap/drain.js's compileGrandfatherManifestDrainState
 * and compileAuthoredDrainState both compute a real `available` boolean, but
 * compile.js's schema-narrowing assembly (grandfathered_drain/drain_queue are
 * both additionalProperties:false, with no `available` slot) dropped it
 * before the section reached the persisted artifact — a degraded read
 * (backing file present but unreadable/malformed) was indistinguishable from
 * a genuinely empty/unfed one (backing file simply absent, the NORMAL state:
 * this repo's own dogfood/roadmap-drain-state.json does not exist on disk
 * today, and a foreign audited repo genuinely has no grandfather-manifest
 * concept — see each producer's own doc comment).
 *
 * ABSENT-VS-DEGRADED DETERMINATION (this finding's own design nuance, read
 * directly from drain.js before writing any fix): NEITHER producer
 * distinguished the two cases in its return value — both collapsed
 * "repoRoot/local_path missing", "file does not exist", "file unreadable",
 * and "file parses but has the wrong top-level shape" into the identical
 * `available:false` shape. The fix makes the minimal change: both producers
 * now attach an in-memory-only `degraded_reason` ('unreadable' |
 * 'invalid_shape') on exactly the two "file exists but is broken" return
 * sites, and leave the "repoRoot/local_path missing" and "file does not
 * exist" sites returning the byte-identical pre-existing `unavailable` shape
 * — so the existing absent-file pins in lib/roadmap-drain.test.js (outside
 * this domain's globs, including one
 * `assert.deepEqual(result, { available: false, frozen_total: 0, drained: 0,
 * outstanding: [] })` exact-shape pin) keep passing unchanged. compile.js
 * reads `degraded_reason` to fire exactly one logStage warning per degraded
 * section, then narrows it away with everything else before the artifact is
 * assembled — never persisted, matching this finding's own scoping (a
 * persisted signal is a schema amendment, out of this domain's call).
 *
 * PROVEN LIVE below, both at the producer level (drain.js, direct calls) and
 * end-to-end (compile.js, real compileRoadmap() calls with console.error
 * captured) — against temp-dir fixtures only, never the live dogfood/ tree:
 * (a) a repoRoot with the backing file simply ABSENT compiles quietly, zero
 * `roadmap_drain_section_degraded` lines; (b) a repoRoot with a MALFORMED or
 * WRONG-SHAPE backing file produces exactly one such line, naming the right
 * section and reason. RED/GREEN mutation proof (manual, not left in the
 * tree): with compile.js's two warnIfDrainStateDegraded call sites
 * temporarily commented out, every WARN-* test below failed (no line
 * captured) while every QUIET-* test kept passing trivially; restoring the
 * calls returned the suite to green. Separately, with drain.js's
 * "file absent" return sites temporarily changed to also attach
 * degraded_reason, the QUIET-* tests failed as expected. Both mutations were
 * reverted before this file was left in its final state — see this lane's
 * final report for the exact commands.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openMemoryDb } from './db/connection.js';
import { compileRoadmap } from './lib/roadmap/compile.js';
import { compileGrandfatherManifestDrainState, compileAuthoredDrainState } from './lib/roadmap/drain.js';

const ORIGINAL_CONSOLE_ERROR = console.error;
const ORIGINAL_DOGFOOD_LOG_HUMAN = process.env.DOGFOOD_LOG_HUMAN;
let capturedLines;

beforeEach(() => {
  capturedLines = [];
  // Isolate the NDJSON line from the human-banner companion (log-stage.js's
  // own convention, matching lib/f-36fdebca-log-stage-write-guard.test.js) so
  // each logStage call captures as exactly one parseable line here.
  process.env.DOGFOOD_LOG_HUMAN = '0';
  console.error = (...args) => capturedLines.push(args.join(' '));
});

afterEach(() => {
  console.error = ORIGINAL_CONSOLE_ERROR;
  if (ORIGINAL_DOGFOOD_LOG_HUMAN === undefined) delete process.env.DOGFOOD_LOG_HUMAN;
  else process.env.DOGFOOD_LOG_HUMAN = ORIGINAL_DOGFOOD_LOG_HUMAN;
});

/** Only this fix's own stage — logStage may print other NDJSON lines during a real compile. */
function degradationLines() {
  return capturedLines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((l) => l && l.stage === 'roadmap_drain_section_degraded');
}

function withScratchRepo(setup, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'drain-degradation-'));
  try {
    setup(repoRoot);
    return fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function seedRunWithWave(db, runId, localPath) {
  db.prepare(
    `INSERT INTO runs (id, repo, local_path, commit_sha, status) VALUES (?, 'org/repo', ?, ?, 'feature-audit')`
  ).run(runId, localPath, 'a'.repeat(40));
  db.prepare(
    `INSERT INTO waves (run_id, phase, wave_number, status) VALUES (?, 'feature-audit', 1, 'collected')`
  ).run(runId);
}

function writeGrandfatherManifest(repoRoot, rawBody) {
  mkdirSync(join(repoRoot, 'scripts'), { recursive: true });
  writeFileSync(join(repoRoot, 'scripts', 'grandfathered-pins.json'), rawBody);
}

function writeDrainState(repoRoot, rawBody) {
  mkdirSync(join(repoRoot, 'dogfood'), { recursive: true });
  writeFileSync(join(repoRoot, 'dogfood', 'roadmap-drain-state.json'), rawBody);
}

/** @pins F-00c2b7fd */
describe('drain.js producers — degraded_reason distinguishes absent from broken (F-00c2b7fd)', () => {
  it('compileGrandfatherManifestDrainState: no degraded_reason when the manifest is simply absent', () => {
    withScratchRepo(() => {}, (repoRoot) => {
      const result = compileGrandfatherManifestDrainState(repoRoot);
      assert.equal(result.available, false);
      assert.equal(Object.hasOwn(result, 'degraded_reason'), false,
        'a merely-absent manifest must not be flagged degraded — this file\'s own doc comment already calls '
          + 'this "a legitimate state for any audited repo OTHER than dogfood-lab/testing-os itself"');
    });
  });

  it('compileGrandfatherManifestDrainState: no degraded_reason when repoRoot itself is omitted', () => {
    const result = compileGrandfatherManifestDrainState(undefined);
    assert.equal(result.available, false);
    assert.equal(Object.hasOwn(result, 'degraded_reason'), false);
  });

  it('compileGrandfatherManifestDrainState: degraded_reason="unreadable" when the manifest file exists but is malformed JSON', () => {
    withScratchRepo((repoRoot) => writeGrandfatherManifest(repoRoot, '{ not valid json'), (repoRoot) => {
      const result = compileGrandfatherManifestDrainState(repoRoot);
      assert.equal(result.available, false);
      assert.equal(result.degraded_reason, 'unreadable');
    });
  });

  it('compileGrandfatherManifestDrainState: degraded_reason="invalid_shape" when the manifest parses but .grandfathered is not an object map', () => {
    withScratchRepo((repoRoot) => writeGrandfatherManifest(repoRoot, JSON.stringify({ grandfathered: [] })), (repoRoot) => {
      const result = compileGrandfatherManifestDrainState(repoRoot);
      assert.equal(result.available, false);
      assert.equal(result.degraded_reason, 'invalid_shape');
    });
  });

  it('compileAuthoredDrainState: no degraded_reason when the drain-state file is simply absent', () => {
    const db = openMemoryDb();
    withScratchRepo(() => {}, (repoRoot) => {
      seedRunWithWave(db, 'run-absent', repoRoot);
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('run-absent');
      const result = compileAuthoredDrainState(db, run);
      assert.equal(result.available, false);
      assert.equal(Object.hasOwn(result, 'degraded_reason'), false);
    });
  });

  it('compileAuthoredDrainState: no degraded_reason when `run` has no local_path', () => {
    const db = openMemoryDb();
    assert.equal(Object.hasOwn(compileAuthoredDrainState(db, {}), 'degraded_reason'), false);
    assert.equal(Object.hasOwn(compileAuthoredDrainState(db, null), 'degraded_reason'), false);
  });

  it('compileAuthoredDrainState: degraded_reason="unreadable" when the drain-state file exists but is malformed JSON', () => {
    const db = openMemoryDb();
    withScratchRepo((repoRoot) => writeDrainState(repoRoot, '{ not valid json'), (repoRoot) => {
      seedRunWithWave(db, 'run-unreadable', repoRoot);
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('run-unreadable');
      const result = compileAuthoredDrainState(db, run);
      assert.equal(result.available, false);
      assert.equal(result.degraded_reason, 'unreadable');
    });
  });

  it('compileAuthoredDrainState: degraded_reason="invalid_shape" when the drain-state file parses but .entries is not an array', () => {
    const db = openMemoryDb();
    withScratchRepo((repoRoot) => writeDrainState(repoRoot, JSON.stringify({ entries: 'nope' })), (repoRoot) => {
      seedRunWithWave(db, 'run-invalid-shape', repoRoot);
      const run = db.prepare('SELECT * FROM runs WHERE id = ?').get('run-invalid-shape');
      const result = compileAuthoredDrainState(db, run);
      assert.equal(result.available, false);
      assert.equal(result.degraded_reason, 'invalid_shape');
    });
  });
});

/** @pins F-00c2b7fd */
describe('compileRoadmap — logStage warns only on genuine drain-section degradation, never on absent (F-00c2b7fd)', () => {
  it('QUIET: both backing files absent — the honest, today-live state for this very repo — produces zero degradation warnings', () => {
    const db = openMemoryDb();
    withScratchRepo(() => {}, (repoRoot) => {
      seedRunWithWave(db, 'run-quiet', repoRoot);

      compileRoadmap(db, 'run-quiet', { repoRoot, now: new Date('2026-07-18T00:00:00Z') });

      assert.deepEqual(degradationLines(), [],
        'a repo with neither drain backing file present must compile silently — this IS this repo\'s own live '
          + 'state today (dogfood/roadmap-drain-state.json does not exist on disk)');
    });
  });

  it('QUIET: repoRoot omitted from opts entirely still produces zero degradation warnings for grandfathered_drain', () => {
    const db = openMemoryDb();
    seedRunWithWave(db, 'run-no-root', '/nonexistent/never-read');

    compileRoadmap(db, 'run-no-root', { now: new Date('2026-07-18T00:00:00Z') });

    assert.deepEqual(degradationLines(), []);
  });

  it('WARN: a malformed grandfather manifest produces exactly one degradation line naming section=grandfathered_drain reason=unreadable', () => {
    const db = openMemoryDb();
    withScratchRepo((repoRoot) => writeGrandfatherManifest(repoRoot, '{ not valid json'), (repoRoot) => {
      seedRunWithWave(db, 'run-gf-bad', repoRoot);

      compileRoadmap(db, 'run-gf-bad', { repoRoot, now: new Date('2026-07-18T00:00:00Z') });

      const lines = degradationLines();
      assert.equal(lines.length, 1, `expected exactly one degradation line, got: ${JSON.stringify(lines)}`);
      assert.equal(lines[0].section, 'grandfathered_drain');
      assert.equal(lines[0].reason, 'unreadable');
      assert.equal(lines[0].run_id, 'run-gf-bad');
      assert.equal(lines[0].component, 'dogfood-swarm');
    });
  });

  it('WARN: a wrong-shape grandfather manifest produces exactly one degradation line naming reason=invalid_shape', () => {
    const db = openMemoryDb();
    withScratchRepo((repoRoot) => writeGrandfatherManifest(repoRoot, JSON.stringify({ grandfathered: [] })), (repoRoot) => {
      seedRunWithWave(db, 'run-gf-shape', repoRoot);

      compileRoadmap(db, 'run-gf-shape', { repoRoot, now: new Date('2026-07-18T00:00:00Z') });

      const lines = degradationLines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0].section, 'grandfathered_drain');
      assert.equal(lines[0].reason, 'invalid_shape');
    });
  });

  it('WARN: a malformed authored drain-state file produces exactly one degradation line naming section=drain_queue reason=unreadable', () => {
    const db = openMemoryDb();
    withScratchRepo((repoRoot) => writeDrainState(repoRoot, '{ not valid json'), (repoRoot) => {
      seedRunWithWave(db, 'run-dq-bad', repoRoot);

      compileRoadmap(db, 'run-dq-bad', { repoRoot, now: new Date('2026-07-18T00:00:00Z') });

      const lines = degradationLines();
      assert.equal(lines.length, 1, `expected exactly one degradation line, got: ${JSON.stringify(lines)}`);
      assert.equal(lines[0].section, 'drain_queue');
      assert.equal(lines[0].reason, 'unreadable');
      assert.equal(lines[0].run_id, 'run-dq-bad');
    });
  });

  it('WARN: a wrong-shape authored drain-state file produces exactly one degradation line naming reason=invalid_shape', () => {
    const db = openMemoryDb();
    withScratchRepo((repoRoot) => writeDrainState(repoRoot, JSON.stringify({ entries: 'nope' })), (repoRoot) => {
      seedRunWithWave(db, 'run-dq-shape', repoRoot);

      compileRoadmap(db, 'run-dq-shape', { repoRoot, now: new Date('2026-07-18T00:00:00Z') });

      const lines = degradationLines();
      assert.equal(lines.length, 1);
      assert.equal(lines[0].section, 'drain_queue');
      assert.equal(lines[0].reason, 'invalid_shape');
    });
  });

  it('WARN: both sections degraded at once produces exactly two independently-correct lines, not one collapsing the other', () => {
    const db = openMemoryDb();
    withScratchRepo((repoRoot) => {
      writeGrandfatherManifest(repoRoot, '{ not valid json');
      writeDrainState(repoRoot, '{ not valid json');
    }, (repoRoot) => {
      seedRunWithWave(db, 'run-both-bad', repoRoot);

      compileRoadmap(db, 'run-both-bad', { repoRoot, now: new Date('2026-07-18T00:00:00Z') });

      const lines = degradationLines();
      assert.equal(lines.length, 2);
      assert.deepEqual(lines.map((l) => l.section).sort(), ['drain_queue', 'grandfathered_drain']);
    });
  });

  it('non-regression: the persisted artifact never carries degraded_reason or available on either section, even when degraded', () => {
    const db = openMemoryDb();
    withScratchRepo((repoRoot) => writeGrandfatherManifest(repoRoot, '{ not valid json'), (repoRoot) => {
      seedRunWithWave(db, 'run-narrow', repoRoot);

      const artifact = compileRoadmap(db, 'run-narrow', { repoRoot, now: new Date('2026-07-18T00:00:00Z') });

      assert.equal(Object.hasOwn(artifact.grandfathered_drain, 'available'), false);
      assert.equal(Object.hasOwn(artifact.grandfathered_drain, 'degraded_reason'), false);
      assert.equal(Object.hasOwn(artifact.drain_queue, 'available'), false);
      assert.equal(Object.hasOwn(artifact.drain_queue, 'degraded_reason'), false);
    });
  });
});
