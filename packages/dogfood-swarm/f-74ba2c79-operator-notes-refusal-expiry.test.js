/**
 * f-74ba2c79-operator-notes-refusal-expiry.test.js
 *
 * F-74ba2c79 [HIGH] — T3 (docs/trajectory-and-closure.dispatch.md) gives
 * operator notes four independently-testable refusal/expiry properties that
 * need fixtures NOW, before the compiler exists, so the feature is red-able
 * from day one (this run's own stated discipline: "a verification that
 * cannot fail is not a verification"):
 *
 *   1. An 8th note is refused (bound of 7 — Reflexion-cited in the dispatch).
 *   2. A `kind: invariant` note with no `enforced_by` is refused.
 *   3. An `enforced_by` path pointing at a file that does not exist on disk
 *      is refused (and a REAL existing path is accepted — the positive
 *      companion that proves the refusal isn't "invariant notes always
 *      refused regardless of path").
 *   4. An expired note is dropped from the LIVE notes list AND surfaced in a
 *      SEPARATE expired listing — both halves asserted in ONE test, because
 *      a compiler could satisfy either half alone while failing the other
 *      (silently drop = passes "not live" but fails "reported"; never drop =
 *      fails "not live" but a naive report-only check could still pass).
 *
 * STATUS: RED IN ISOLATION — same missing-verb situation as
 * f-feeaef78-roadmap-compile-determinism.test.js (no `swarm roadmap compile`
 * verb, no compiler module exist in this worktree). This file adds a further
 * ASSUMPTION on top of that one, needed from swarm-cp-core: operator notes
 * are authored at `<runs.local_path>/dogfood/roadmap-notes.json`, shape
 * `{ "notes": [ { "kind": "theme"|"open-question"|"invariant", "text": "...",
 * "expires": "<ISO date>", "enforced_by": "<repo-relative path>" } ] }`, and
 * compile reads it if present (absent file == zero notes, not an error). The
 * dispatch text specifies `expires: <N runs | date>` as a union; this file
 * exercises the DATE form only — the run-count form needs a fixture with a
 * defined "which run counts as run 1" convention that does not exist yet, so
 * that half is a DISCLOSED gap here, not a silent omission (this repo's own
 * soundiness-disclosure convention: an understated residual is itself a
 * finding).
 *
 * Every assertion below checks a SPECIFIC message/content, never a bare exit
 * code — "Unknown command: 'roadmap'" (today's actual output) always exits
 * 1, so a bare "exit 1 == refused" check would pass vacuously for the wrong
 * reason on every one of these fixtures. Content-checking closes that gap.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb, closeDb } from './db/connection.js';

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

let seq = 0;
/**
 * Seeds a minimal run (no findings needed — these tests are entirely about
 * the operator-notes section) plus a `dogfood/roadmap-notes.json` fixture,
 * and returns { runId, repoDir, dbPath, compile() }.
 */
function setupNotesFixture(notes) {
  seq += 1;
  const runId = `notes-fixture-r${seq}`;
  const dbDir = makeTmpDir('notes-db-');
  const dbPath = join(dbDir, 'control-plane.db');
  const repoDir = makeTmpDir('notes-repo-');

  const db = openDb(dbPath);
  db.prepare(`INSERT INTO runs (id, repo, local_path, commit_sha, branch, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(runId, 'org/repo', repoDir, 'a'.repeat(40), 'main', 'health-audit-a');
  closeDb(dbPath);

  mkdirSync(join(repoDir, 'dogfood'), { recursive: true });
  writeFileSync(join(repoDir, 'dogfood', 'roadmap-notes.json'), JSON.stringify({ notes }, null, 2));

  function compile() {
    return spawnSync(process.execPath, [CLI_PATH, 'roadmap', 'compile', runId], {
      encoding: 'utf-8',
      cwd: __dirname,
      env: { ...process.env, SWARM_DB: dbPath },
    });
  }

  return { runId, repoDir, dbPath, compile };
}

function readArtifact(repoDir, runId) {
  const p = join(repoDir, 'dogfood', 'roadmap', `${runId}.json`);
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function themeNote(n) {
  return { kind: 'theme', text: `boundary theme note #${n}`, expires: '2099-01-01' };
}

/** @pins F-74ba2c79 */
describe('F-74ba2c79 — operator notes: bound of 7', () => {
  it('exactly 7 notes are accepted (all present in the compiled artifact)', () => {
    const notes = Array.from({ length: 7 }, (_, i) => themeNote(i + 1));
    const { repoDir, runId, compile } = setupNotesFixture(notes);
    const r = compile();
    assert.equal(r.status, 0,
      `7 operator notes (at the documented bound) must be accepted; stderr:\n${r.stderr}`);
    const artifact = readArtifact(repoDir, runId);
    assert.ok(artifact, `expected a compiled artifact at ${repoDir}/dogfood/roadmap/${runId}.json`);
    assert.equal(Array.isArray(artifact.notes) && artifact.notes.length, 7,
      `all 7 notes must appear in the compiled artifact's notes list; got: ${JSON.stringify(artifact.notes)}`);
  });

  it('an 8th note is refused (bound of 7 exceeded)', () => {
    const notes = Array.from({ length: 8 }, (_, i) => themeNote(i + 1));
    const { compile } = setupNotesFixture(notes);
    const r = compile();
    assert.notEqual(r.status, 0,
      `8 operator notes must be REFUSED, not silently truncated to 7; got exit 0. stdout:\n${r.stdout}`);
    assert.match(r.stderr, /\b7\b/,
      `refusal message must name the bound (7) so the operator knows why; got stderr:\n${r.stderr}`);
    assert.match(r.stderr, /note/i,
      `refusal message must mention "note(s)" specifically, not just fail generically; got stderr:\n${r.stderr}`);
  });
});

describe('F-74ba2c79 — operator notes: invariant requires enforced_by', () => {
  it('a kind:invariant note with no enforced_by is refused', () => {
    const notes = [{ kind: 'invariant', text: 'this invariant has no verifier', expires: '2099-01-01' }];
    const { compile } = setupNotesFixture(notes);
    const r = compile();
    assert.notEqual(r.status, 0,
      `an invariant note with no enforced_by must be REFUSED; got exit 0. stdout:\n${r.stdout}`);
    assert.match(r.stderr, /enforced_by/,
      `refusal message must name the missing field "enforced_by"; got stderr:\n${r.stderr}`);
    assert.match(r.stderr, /invariant/i,
      `refusal message must name the offending note kind "invariant"; got stderr:\n${r.stderr}`);
  });
});

describe('F-74ba2c79 — operator notes: enforced_by must resolve on disk', () => {
  it('an enforced_by path naming a nonexistent file is refused', () => {
    const notes = [{
      kind: 'invariant',
      text: 'this invariant points at nothing',
      expires: '2099-01-01',
      enforced_by: 'packages/dogfood-swarm/this-file-does-not-exist-anywhere.test.js',
    }];
    const { compile } = setupNotesFixture(notes);
    const r = compile();
    assert.notEqual(r.status, 0,
      `an enforced_by path that does not resolve on disk must be REFUSED; got exit 0. stdout:\n${r.stdout}`);
    assert.match(r.stderr, /this-file-does-not-exist-anywhere\.test\.js/,
      `refusal message must name the unresolvable path so the operator can fix it; got stderr:\n${r.stderr}`);
  });

  it('an enforced_by path naming a REAL file is accepted (proves the refusal above checks the filesystem, not just non-emptiness)', () => {
    const { repoDir, runId, compile } = setupNotesFixture([]);
    // Point enforced_by at a real, pre-existing file inside the target repo
    // checkout, mirroring how a real invariant would reference an actual gate.
    mkdirSync(join(repoDir, 'scripts'), { recursive: true });
    writeFileSync(join(repoDir, 'scripts', 'real-gate.test.js'), '// a real file that exists on disk\n');
    writeFileSync(join(repoDir, 'dogfood', 'roadmap-notes.json'), JSON.stringify({
      notes: [{
        kind: 'invariant',
        text: 'this invariant points at a real gate',
        expires: '2099-01-01',
        enforced_by: 'scripts/real-gate.test.js',
      }],
    }, null, 2));

    const r = compile();
    assert.equal(r.status, 0,
      `an invariant note whose enforced_by resolves to a REAL file must be ACCEPTED; stderr:\n${r.stderr}`);
    const artifact = readArtifact(repoDir, runId);
    assert.ok(artifact, `expected a compiled artifact at ${repoDir}/dogfood/roadmap/${runId}.json`);
    assert.equal(artifact.notes?.length, 1,
      `the valid invariant note must appear in the compiled artifact; got: ${JSON.stringify(artifact.notes)}`);
  });
});

describe('F-74ba2c79 — operator notes: expiry drops loudly (both halves)', () => {
  it('an expired note is excluded from live notes AND listed in a separate expired section, while an unexpired note stays live', () => {
    const notes = [
      { kind: 'theme', text: 'this note expired long ago', expires: '2020-01-01' },
      { kind: 'theme', text: 'this note is still alive', expires: '2099-01-01' },
    ];
    const { repoDir, runId, compile } = setupNotesFixture(notes);
    const r = compile();
    assert.equal(r.status, 0, `compile must succeed even with an expired note present; stderr:\n${r.stderr}`);

    const artifact = readArtifact(repoDir, runId);
    assert.ok(artifact, `expected a compiled artifact at ${repoDir}/dogfood/roadmap/${runId}.json`);

    // Half 1: the expired note must NOT be in the live notes list.
    const liveTexts = (artifact.notes || []).map(n => n.text);
    assert.ok(!liveTexts.includes('this note expired long ago'),
      `expired note must be excluded from live notes; live notes were: ${JSON.stringify(liveTexts)}`);
    assert.ok(liveTexts.includes('this note is still alive'),
      `unexpired note must remain in live notes; live notes were: ${JSON.stringify(liveTexts)}`);

    // Half 2: the expired note must be reported, with enough identifying
    // detail (kind/text/expires) to audit what was dropped — a compiler that
    // silently drops it (passing half 1 alone) must fail THIS half.
    assert.ok(Array.isArray(artifact.expired) && artifact.expired.length > 0,
      `compile must report expired notes in a separate "expired" list; got: ${JSON.stringify(artifact.expired)}`);
    const expiredEntry = artifact.expired.find(n => n.text === 'this note expired long ago');
    assert.ok(expiredEntry,
      `the expired listing must identify the dropped note by its text; got: ${JSON.stringify(artifact.expired)}`);
    assert.equal(expiredEntry.kind, 'theme', 'expired listing must preserve the note\'s kind');
    assert.equal(expiredEntry.expires, '2020-01-01', 'expired listing must preserve the note\'s expires value');
  });
});
