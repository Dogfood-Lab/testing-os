/**
 * meta-wal-sidecar-teardown-guard.test.js — closes the DETECTOR gap behind
 * the WAL-sidecar teardown race (F-8ad2d58d, then F-60942f46 as an eighth
 * live instance in wave 16, then F-f8798fd7 as a ninth in wave 18).
 *
 * The mechanism (re-confirmed directly against db/connection.js, unchanged
 * since F-8ad2d58d): every real (non-`:memory:`) openDb() connection sets
 * `journal_mode = WAL` (connection.js:140), and closeDb(dbPath) only ever
 * releases THIS process's own pooled connection (connection.js:152-159, a
 * process-local Map) — it cannot release a just-exited CHILD process's
 * OS-level lock on the sqlite -wal/-shm sidecar files. A test that spawns
 * the CLI as a real subprocess against a real file-backed dbPath, then
 * rmSync's that dbPath's directory in teardown WITHOUT tolerating a brief
 * Windows lock-lag window, is exposed to an intermittent EBUSY/EPERM.
 *
 * WHY THIS FILE EXISTS (the actual defect this sweep closes): F-f8798fd7's
 * own evidence states the PRIOR sweep (the one behind F-60942f46) missed
 * wave12-swarm-cp-pins.test.js's F-SWARMCP-001/002 block for two full waves
 * because its methodology searched for the literal string `spawnSync` only
 * — which does not text-match that block's `execFileSync` call shape. The
 * bug was never "one more file slipped through"; it was that the DETECTOR
 * itself was call-shape-narrow. A meta-test that greps for one literal name
 * is exactly the "authoritative value + a second path that re-derives it
 * incompletely" disease this repo's other sweeps exist to avoid. This file
 * replaces manual, ad-hoc, call-shape-specific grepping with a standing,
 * call-shape-agnostic, self-proving assertion.
 *
 * PROOF THE GAP WAS REAL, NOT JUST THE SPAWNSYNC/EXECFILESYNC SPELLING: the
 * detector below — built and scoped independently of any specific prior
 * finding — found a TENTH live instance while this file was being written:
 * stageD-output-dir-tracks-db.test.js's lone test spawns the CLI via
 * spawnSync (the SAME call name F-60942f46's own sweep searched for) against
 * a real dbPath, then rmSync's it unguarded in a `finally` block — missed by
 * every prior sweep AND by the wave-18 audit that produced F-f8798fd7,
 * because no prior sweep ever actually enumerated every CLI-spawning file;
 * each was a targeted look at the specific sibling files a finding named.
 * Fixed alongside this sweep (same one-line established guard idiom) so the
 * sweep ships green as a real, live-tree-enforced assertion rather than
 * red-and-suppressed — a sweep that cannot go red is theater, and a sweep
 * shipped red is a build breakage; neither is acceptable.
 *
 * DETECTION STRATEGY:
 *   1. Comment-strip each file via this package's own test-support/
 *      strip-comments.js (the shared scanner that already replaced five
 *      per-file regex duplicates for exactly this reason: prose mentioning
 *      a call shape in a doc comment must not produce a phantom offender).
 *   2. Split the comment-stripped text into top-level segments — this
 *      package's consistently Prettier-formatted style means every
 *      describe()/test()/function/const declaration starts at column 0, so
 *      a column-0 line that is not merely a closer (`}`/`)`/`]`) reliably
 *      marks a new segment boundary. This is the property that keeps the
 *      sweep from over-flagging: wave12-swarm-cp-pins.test.js's OTHER two
 *      describe blocks (F-SWARMCP-004, revalidate) call buildSummary()/
 *      revalidate() directly in-process with no subprocess spawn anywhere
 *      in their own bodies (confirmed by F-f8798fd7's own grep) — a
 *      whole-FILE sweep would flag their structurally-identical teardown
 *      too, which would be wrong (not exposed to this race) and would have
 *      widened this fix beyond its approved scope. Segment scoping is not
 *      an optional nicety here — an early whole-file draft of this sweep
 *      was verified against this exact live tree and DID over-flag those
 *      two blocks plus one further unrelated block in a different file,
 *      before segment scoping was added.
 *   3. Within each segment, resolve CLI-spawning transitively by NAME: a
 *      segment is CLI-spawning if it directly calls one of execFileSync(/
 *      execSync(/spawnSync(/spawn( with CLI_PATH in the same segment, OR if
 *      it calls a top-level helper already known (by fixpoint) to be
 *      CLI-spawning. This resolves wave12-swarm-cp-pins.test.js's actual
 *      shape: its describe block calls spawnCli(), which calls runCli(),
 *      which is the segment that directly calls execFileSync(CLI_PATH) —
 *      two levels of indirection, so a non-transitive single-pass check
 *      would still have missed it.
 *   4. Every rmSync( match inside a CLI-spawning segment must be guarded by
 *      the established `try { rmSync(...) } catch { ... }` idiom (the
 *      literal token sequence `try {` immediately preceding `rmSync(`,
 *      matching every already-fixed sibling in this package).
 *
 * SCOPE, STATED PLAINLY (a narrow, honest guard beats a broad, noisy one —
 * same principle meta-portable-fixture-paths.test.js states for its class):
 *   - Anchored to the CLI_PATH constant specifically, not "spawns any child
 *     process." An unanchored version was checked against this exact
 *     package during development: ~18 files spawn `git`/`python`/a
 *     standalone script via execFileSync/spawnSync but never touch CLI_PATH
 *     or a swarm control-plane db at all — none of those child processes
 *     can hold a lock on OUR sqlite -wal/-shm files, so flagging them would
 *     be exactly the noisy, ignorable-guard outcome the sibling sweep
 *     rejected for its own class.
 *   - Does NOT catch a CLI-spawning helper referenced under a differently
 *     named path constant (only the literal identifier `CLI_PATH` is
 *     recognized — the established, universal name for this across every
 *     file in this package today; a future file that spawns the swarm CLI
 *     under a different constant name would need this sweep updated, the
 *     same class of gap F-f8798fd7 itself named for a future audit).
 *   - Does NOT catch a guard shape other than `try { rmSync(` as the
 *     immediately preceding token sequence (e.g. rmSync as a LATER
 *     statement inside a try block that opens with something else first).
 *     Not a live shape anywhere in this package today (verified: every
 *     guarded instance has rmSync as its try block's first statement) —
 *     a documented residual, not a silent claim of completeness.
 *   - Does NOT catch indirection through a helper referenced only via a
 *     variable holding a function reference, rather than a static top-level
 *     name — real data-flow analysis, scoped out, matching this package's
 *     established "not-cheap-enough" boundary for this exact class of gap.
 *   - Relies on this package's consistent column-0-top-level formatting to
 *     find segment boundaries cheaply. Verified against all files in this
 *     package's flat root during development; a future file that does not
 *     follow this formatting would degrade toward coarser, file-level-like
 *     grouping rather than silently passing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;

function walkTestFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { walkTestFiles(p, files); continue; }
    if (entry.name.endsWith('.test.js')) files.push(p);
  }
  return files;
}

// Call-shape-agnostic by construction: F-f8798fd7 shipped specifically
// because a prior sweep's methodology searched for the literal `spawnSync`
// only. `spawn` is not live anywhere in this package today (verified during
// development) but is included so a future async-spawn CLI invocation is
// covered from day one, not after an eleventh instance.
const CLI_SPAWN_SHAPE = /\b(?:execFileSync|execSync|spawnSync|spawn)\(/;
const RMSYNC_CALL = /\brmSync\(/g;
const GUARDED_RMSYNC_PREFIX = /\btry\s*\{\s*$/;

// See header point 2. A column-0 line that does not open with a closer
// (`}`/`)`/`]`) starts a new top-level segment.
function findTopLevelSegmentBoundaries(text) {
  const boundaries = [0];
  let offset = 0;
  for (const line of text.split('\n')) {
    const isNewTopLevelStatement = line.length > 0 && !/^[\s}\)\]]/.test(line);
    if (isNewTopLevelStatement && offset > 0) boundaries.push(offset);
    offset += line.length + 1; // +1 for the split-off '\n'
  }
  boundaries.push(text.length);
  return boundaries;
}

function segmentTextAt(text, boundaries, index) {
  for (let i = 0; i < boundaries.length - 1; i++) {
    if (index >= boundaries[i] && index < boundaries[i + 1]) return text.slice(boundaries[i], boundaries[i + 1]);
  }
  return text;
}

// See header point 3. Fixpoint over top-level named declarations: a segment
// name is CLI-spawning if its own body matches CLI_SPAWN_SHAPE + CLI_PATH,
// or if its own body calls a name already known to be CLI-spawning —
// repeated until no new name is added, so an N-level wrapper chain (not
// just one level) resolves correctly.
function findCliSpawningHelperNames(text, boundaries) {
  const namedSegments = new Map();
  for (let i = 0; i < boundaries.length - 1; i++) {
    const seg = text.slice(boundaries[i], boundaries[i + 1]);
    const m = seg.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/) || seg.match(/^const\s+(\w+)\s*=/);
    if (m) namedSegments.set(m[1], seg);
  }
  const cliHelpers = new Set();
  for (const [name, seg] of namedSegments) {
    if (CLI_SPAWN_SHAPE.test(seg) && seg.includes('CLI_PATH')) cliHelpers.add(name);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, seg] of namedSegments) {
      if (cliHelpers.has(name)) continue;
      for (const known of cliHelpers) {
        if (new RegExp(`\\b${known}\\s*\\(`).test(seg)) { cliHelpers.add(name); changed = true; break; }
      }
    }
  }
  return cliHelpers;
}

function segmentIsCliSpawning(segText, cliHelperNames) {
  if (CLI_SPAWN_SHAPE.test(segText) && segText.includes('CLI_PATH')) return true;
  for (const name of cliHelperNames) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(segText)) return true;
  }
  return false;
}

// Extracted so the self-tests below can exercise the exact detection logic
// the real sweep uses, without writing throwaway files to disk — same
// pattern as meta-portable-fixture-paths.test.js's
// findHardcodedAbsolutePathOffenders.
function findUnguardedRmSyncOffenders(rawText) {
  const text = stripComments(rawText); // preserves line numbers
  const boundaries = findTopLevelSegmentBoundaries(text);
  const cliHelperNames = findCliSpawningHelperNames(text, boundaries);
  const rawLines = rawText.split('\n');
  const offenders = [];
  for (const match of text.matchAll(RMSYNC_CALL)) {
    const before = text.slice(Math.max(0, match.index - 60), match.index);
    if (GUARDED_RMSYNC_PREFIX.test(before)) continue;
    const segText = segmentTextAt(text, boundaries, match.index);
    if (!segmentIsCliSpawning(segText, cliHelperNames)) continue;
    const line = text.slice(0, match.index).split('\n').length;
    offenders.push({ line, snippet: (rawLines[line - 1] || '').trim() });
  }
  return offenders;
}

// Builds a synthetic CLI-spawning-then-unguarded-teardown snippet entirely
// from parts (every token this sweep matches on — the call-shape name,
// CLI_PATH, rmSync — arrives via template interpolation, never as
// contiguous literal source text). This file is itself a *.test.js under
// PKG_ROOT, so the live-tree sweep below visits it too; an un-obfuscated
// fixture would flag itself, exactly the hazard
// meta-portable-fixture-paths.test.js's wrapped/backtick fixtures already
// document and avoid for its own class.
function syntheticOffender(callShapeName, { guarded = false, wrapperLevels = 0 } = {}) {
  const cliPathName = ['CLI', 'PATH'].join('_');
  const rmName = ['rm', 'Sync'].join('');
  const lines = [
    `const ${cliPathName} = join(__dirname, 'cli.js');`,
    `function runIt(args, dbPath) {`,
    `  return ${callShapeName}(process.execPath, [${cliPathName}, ...args], { env: { SWARM_DB: dbPath } });`,
    `}`,
  ];
  // Each extra wrapper level adds one more named function calling the
  // previous one, mirroring wave12-swarm-cp-pins.test.js's real shape
  // (describe block -> spawnCli() -> runCli() -> execFileSync(CLI_PATH)).
  let innermost = 'runIt';
  for (let i = 0; i < wrapperLevels; i++) {
    const wrapperName = `wrap${i}`;
    lines.push(`function ${wrapperName}(args, dbPath) { return ${innermost}(args, dbPath); }`);
    innermost = wrapperName;
  }
  const teardownCall = guarded
    ? `try { ${rmName}(tmp, { recursive: true, force: true }); } catch { /* Windows lock lag */ }`
    : `${rmName}(tmp, { recursive: true, force: true });`;
  lines.push(
    `describe('synthetic', () => {`,
    `  afterEach(() => {`,
    `    ${innermost}(['status'], dbPath);`,
    `    ${teardownCall}`,
    `  });`,
    `});`,
  );
  return lines.join('\n');
}

describe('meta — every CLI-spawning test segment tolerates Windows teardown lock-lag (closes the F-8ad2d58d / F-60942f46 / F-f8798fd7 class)', () => {
  it('sweep must visit at least one test file', () => {
    // Anti-vacuity insurance, same shape as meta-portable-fixture-paths.test.js's
    // own: PKG_ROOT is __dirname and always contains *.test.js files today
    // (this file included), so this is currently unreachable — but a future
    // refactor that hands walkTestFiles the wrong root must not pass this
    // gate by visiting nothing.
    assert.ok(walkTestFiles(PKG_ROOT).length > 0, 'sweep must visit at least one test file');
  });

  it('no CLI-spawning test segment anywhere in this package has an unguarded rmSync teardown', () => {
    const offenders = [];
    for (const f of walkTestFiles(PKG_ROOT)) {
      const text = readFileSync(f, 'utf-8');
      const relPath = f.slice(PKG_ROOT.length + 1).split('\\').join('/');
      for (const { line, snippet } of findUnguardedRmSyncOffenders(text)) {
        offenders.push(`${relPath}:${line}: ${snippet}`);
      }
    }
    assert.deepEqual(offenders, [],
      `rmSync() called without a Windows-tolerant try/catch guard in a test segment that also spawns ` +
      `the CLI as a real subprocess (execFileSync/execSync/spawnSync/spawn, any call shape) against a ` +
      `real dbPath — this is the F-8ad2d58d/F-60942f46/F-f8798fd7 WAL-sidecar teardown race: closeDb ` +
      `only releases this process's own pooled connection, never the just-exited child process's ` +
      `OS-level lock on the -wal/-shm sidecar files. Guard it: try { rmSync(...) } catch { /* Windows ` +
      `lock lag */ }, matching every already-fixed sibling in this package.\n  ${offenders.join('\n  ')}`);
  });

  it('catches an unguarded rmSync after an execFileSync-based CLI spawn (the exact call shape F-f8798fd7 itself missed)', () => {
    const offenders = findUnguardedRmSyncOffenders(syntheticOffender('execFileSync'));
    assert.equal(offenders.length, 1,
      `expected exactly one offender for an execFileSync-shaped CLI spawn; got ${JSON.stringify(offenders)}`);
  });

  it('catches an unguarded rmSync after an execSync-based CLI spawn', () => {
    const offenders = findUnguardedRmSyncOffenders(syntheticOffender('execSync'));
    assert.equal(offenders.length, 1,
      `expected exactly one offender for an execSync-shaped CLI spawn; got ${JSON.stringify(offenders)}`);
  });

  it('catches an unguarded rmSync after a spawnSync-based CLI spawn', () => {
    const offenders = findUnguardedRmSyncOffenders(syntheticOffender('spawnSync'));
    assert.equal(offenders.length, 1,
      `expected exactly one offender for a spawnSync-shaped CLI spawn; got ${JSON.stringify(offenders)}`);
  });

  it('catches an unguarded rmSync after a bare (non-Sync) spawn-based CLI invocation — proves the detector is call-shape-agnostic, not hardcoded to the two call shapes live in this package today', () => {
    const offenders = findUnguardedRmSyncOffenders(syntheticOffender('spawn'));
    assert.equal(offenders.length, 1,
      `expected exactly one offender for a bare spawn-shaped CLI invocation; got ${JSON.stringify(offenders)}`);
  });

  it('does NOT flag an rmSync that is already guarded by the established try/catch idiom', () => {
    const offenders = findUnguardedRmSyncOffenders(syntheticOffender('execFileSync', { guarded: true }));
    assert.deepEqual(offenders, [],
      `a properly try/catch-guarded rmSync must not be flagged; got ${JSON.stringify(offenders)}`);
  });

  it('catches an unguarded rmSync reached only through a two-level helper wrapper, not just a direct call (matches the real indirection depth in wave12-swarm-cp-pins.test.js: spawnCli -> runCli -> execFileSync)', () => {
    const offenders = findUnguardedRmSyncOffenders(syntheticOffender('execFileSync', { wrapperLevels: 2 }));
    assert.equal(offenders.length, 1,
      `a two-level indirect CLI-spawning wrapper chain must still be resolved by the fixpoint reachability ` +
      `pass, matching the real defect shape F-f8798fd7 fixed; got ${JSON.stringify(offenders)}`);
  });

  it('does NOT flag an unguarded rmSync in a top-level block that never spawns the CLI, even when a SIBLING top-level block in the same file does (segment scoping, not whole-file)', () => {
    // This is the property that specifically prevents a regression: an early
    // whole-file draft of this sweep, checked against this package's own
    // live tree during development, over-flagged wave12-swarm-cp-pins.test.js's
    // F-SWARMCP-004 and revalidate describe blocks (neither spawns the CLI —
    // confirmed by F-f8798fd7's own grep) purely because a THIRD, unrelated
    // block in that same file does. Segment scoping is pinned directly here
    // so that regression cannot silently reappear.
    const cliPathName = ['CLI', 'PATH'].join('_');
    const rmName = ['rm', 'Sync'].join('');
    const execName = ['exec', 'FileSync'].join('');
    const synthetic = [
      `const ${cliPathName} = join(__dirname, 'cli.js');`,
      `describe('spawns the CLI', () => {`,
      `  afterEach(() => { ${execName}(process.execPath, [${cliPathName}], {}); ${rmName}(tmpA, { recursive: true, force: true }); });`,
      `});`,
      `describe('never spawns anything', () => {`,
      `  afterEach(() => { ${rmName}(tmpB, { recursive: true, force: true }); });`,
      `});`,
    ].join('\n');
    const offenders = findUnguardedRmSyncOffenders(synthetic);
    assert.equal(offenders.length, 1, `expected exactly one offender (the CLI-spawning block only); got ${JSON.stringify(offenders)}`);
    assert.match(offenders[0].snippet, /tmpA/, 'the flagged offender must belong to the CLI-spawning block, not the unrelated sibling block');
  });

  it('does NOT flag a non-CLI child-process spawn (e.g. a `git` helper) even with an adjacent unguarded rmSync, because it never references CLI_PATH', () => {
    // Precision proof for the CLI_PATH anchor: ~18 files in this package
    // spawn `git`/`python`/a standalone script via execFileSync/spawnSync
    // without ever touching a swarm control-plane db, and flagging them
    // would be exactly the noisy, ignorable-guard outcome
    // meta-portable-fixture-paths.test.js's own header rejects for its class.
    const rmName = ['rm', 'Sync'].join('');
    const execName = ['exec', 'FileSync'].join('');
    const synthetic = [
      `function git(cwd, args) { return ${execName}('git', args, { cwd }); }`,
      `describe('git fixture setup', () => {`,
      `  afterEach(() => { ${rmName}(tmp, { recursive: true, force: true }); });`,
      `});`,
    ].join('\n');
    const offenders = findUnguardedRmSyncOffenders(synthetic);
    assert.deepEqual(offenders, [], `a non-CLI child-process spawn must not be flagged; got ${JSON.stringify(offenders)}`);
  });
});
