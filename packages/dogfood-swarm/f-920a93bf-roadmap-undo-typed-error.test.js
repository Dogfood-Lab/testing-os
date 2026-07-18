/**
 * f-920a93bf-roadmap-undo-typed-error.test.js — F-920a93bf (MEDIUM): the
 * documented (site/src/content/docs/handbook/error-codes.md,
 * "verified live") ROADMAP_UNDO_INVALID_SEQUENCE error, thrown as a typed
 * roadmapError inside commands/roadmap.js#undoRoadmapCompile
 * (`!Number.isInteger(sequence) || sequence <= 0`), was UNREACHABLE through
 * the real `swarm` binary: cli.js's `sub === 'compile'` handler for
 * `--undo` duplicated the EXACT SAME condition first, as an untyped
 * `console.error` + `process.exit(1)` guard, so no value could ever reach
 * the function's own internal check in a state that would trip it. The one
 * existing pin for this code
 * (wave41-4091637-5127-swarm-cp-pins.test.js:570-579) called
 * `undoRoadmapCompile()` directly as a JS function, never through the CLI —
 * it would keep passing even if the internal check were deleted entirely,
 * because the CLI-level guard alone already produced every observable
 * effect (non-zero exit, a clear message) an operator or automation script
 * grepping for the literal string `ERROR [ROADMAP_UNDO_INVALID_SEQUENCE]`
 * would notice.
 *
 * Fixed per the finding's option (a): the redundant CLI-level guard
 * (cli.js, inside the `--undo` branch of `sub === 'compile'`) is deleted;
 * the typed throw now reaches main()'s `renderTopLevelError` seam like
 * every other typed roadmap error already does — matching the single-
 * validation-layer shape this package already uses for `adjudicate --undo`
 * and `roadmap show --version`.
 *
 * PROVEN BY EXECUTION before this fix landed (see the amend lane's report
 * for the exact pre-fix transcript): `--undo 0`, `--undo -5`,
 * `--undo abc --apply` each printed the bare untyped message with no
 * `ERROR [ROADMAP_UNDO_INVALID_SEQUENCE]:` envelope. This file pins the
 * POST-fix behavior through the real CLI subprocess — the only surface the
 * pre-fix defect was ever reachable from, and the one the sole existing
 * pin never drove.
 *
 * Uses the F-8595faf8 / f-d110f547 probe pattern this repo's own closure-
 * verb work established: CLI subprocess (spawnSync against the real
 * cli.js), scratch DB + scratch target-repo directory per test, SWARM_DB
 * env var pinned to a temp path at every spawn site — never the shared
 * control-plane.db.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
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

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf-8',
    cwd: __dirname,
    env: { ...process.env, SWARM_DB: dbPath },
  });
}

function seedRoadmapRun(dbPath, runId, repoDir) {
  const db = openDb(dbPath);
  db.prepare('INSERT INTO runs (id, repo, local_path, commit_sha) VALUES (?, ?, ?, ?)')
    .run(runId, 'org/r', repoDir, 'a'.repeat(40));
  closeDb(dbPath);
}

function seedRoadmapArtifact(dbPath, runId, repoDir, sequence) {
  const relPath = `dogfood/roadmap/${runId}.${sequence}.json`;
  mkdirSync(join(repoDir, 'dogfood', 'roadmap'), { recursive: true });
  writeFileSync(join(repoDir, relPath), JSON.stringify({ runId, repo: 'org/r', sequence }, null, 2));
  const db = openDb(dbPath);
  db.prepare(
    'INSERT INTO roadmap_artifacts (run_id, sequence_number, path, content_hash) VALUES (?, ?, ?, ?)'
  ).run(runId, sequence, relPath, `fake-hash-${sequence}`);
  closeDb(dbPath);
  return relPath;
}

/** @pins F-920a93bf */
describe('F-920a93bf — `swarm roadmap compile --undo` surfaces the typed ROADMAP_UNDO_INVALID_SEQUENCE error, not a bare untyped message', () => {
  let tmp, dbPath, repoDir;

  before(() => {
    tmp = makeTmpDir('f920a93bf-roadmap-undo-');
    dbPath = join(tmp, 'control-plane.db');
    repoDir = join(tmp, 'repo');
    mkdirSync(repoDir, { recursive: true });
    seedRoadmapRun(dbPath, 'r-undo', repoDir);
  });

  for (const bad of ['0', '-5', 'abc', '1.5']) {
    it(`--undo ${bad} renders the typed ERROR [ROADMAP_UNDO_INVALID_SEQUENCE]: envelope (not the old bare message) and still exits 1`, () => {
      const r = runCli(['roadmap', 'compile', 'r-undo', '--undo', bad, '--apply'], dbPath);

      assert.equal(r.status, 1, `expected exit 1 for --undo ${bad}; got ${r.status}. stderr:\n${r.stderr}`);

      // The defect this finding describes is specifically the MISSING typed
      // envelope — pre-fix, this exact string never appeared anywhere in
      // stderr for any of these four values (proven live against
      // pre-fix HEAD; see this file's header). The plain message text
      // ("sequence must be a positive integer") appears in BOTH the old
      // untyped guard AND the typed error's own .message, so asserting on
      // the CODED PREFIX is what actually discriminates fixed from unfixed
      // — a test that only checked the plain text would pass unchanged
      // before this fix too, which is exactly the trap this package's own
      // PROTOCOL.md warns a vacuous verification falls into.
      assert.match(
        r.stderr,
        /ERROR \[ROADMAP_UNDO_INVALID_SEQUENCE\]:/,
        `--undo ${bad} must surface the typed error envelope; got stderr:\n${r.stderr}`,
      );
      assert.match(
        r.stderr,
        /sequence must be a positive integer/,
        `the underlying explanation must still be present; got stderr:\n${r.stderr}`,
      );
      // renderTopLevelError prints a "Next:" hint line whenever e.hint is
      // set — roadmapError's caller passes one explicitly for this code.
      assert.match(
        r.stderr,
        /Next: pass the sequence number named in a ROADMAP_ARTIFACT_MISSING error/,
        `the typed error's .hint must render; got stderr:\n${r.stderr}`,
      );
      assert.equal(r.stdout, '', `no report should print to stdout on a rejected --undo; got:\n${r.stdout}`);
    });
  }

  it('a WELL-FORMED but nonexistent sequence still surfaces the (unrelated, already-working) ROADMAP_UNDO_NOT_FOUND typed error, unaffected by this fix', () => {
    const r = runCli(['roadmap', 'compile', 'r-undo', '--undo', '999', '--apply'], dbPath);
    assert.equal(r.status, 1);
    assert.match(
      r.stderr,
      /ERROR \[ROADMAP_UNDO_NOT_FOUND\]:/,
      `expected the sibling typed error for a valid-shaped, nonexistent sequence; got stderr:\n${r.stderr}`,
    );
  });

  it('REGRESSION GUARD: a genuinely valid --undo sequence still works end-to-end (dry-run, then --apply) — deleting the redundant guard did not collateral-damage the happy path', () => {
    seedRoadmapArtifact(dbPath, 'r-undo', repoDir, 1);

    const dry = runCli(['roadmap', 'compile', 'r-undo', '--undo', '1'], dbPath);
    assert.equal(dry.status, 0, `dry-run undo must exit 0; stderr:\n${dry.stderr}`);
    assert.match(dry.stdout, /Undo \(DRY-RUN\) — run r-undo, sequence 1/);

    const applied = runCli(['roadmap', 'compile', 'r-undo', '--undo', '1', '--apply'], dbPath);
    assert.equal(applied.status, 0, `applied undo must exit 0; stderr:\n${applied.stderr}`);
    assert.match(applied.stdout, /Undo \(APPLIED\) — run r-undo, sequence 1/);
    assert.match(applied.stdout, /Removed: yes/);
  });

  it('--format=json on a rejected --undo still routes through the typed-error stderr envelope, not a malformed JSON stdout payload', () => {
    const r = runCli(['roadmap', 'compile', 'r-undo', '--undo', 'abc', '--apply', '--format=json'], dbPath);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '', `a rejected --undo must never print a partial/invalid JSON report to stdout; got:\n${r.stdout}`);
    assert.match(r.stderr, /ERROR \[ROADMAP_UNDO_INVALID_SEQUENCE\]:/);
  });
});
