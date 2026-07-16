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
 * F-469589af (wave 20): the fixpoint below originally propagated in ONE
 * direction only — "I call a known spawner, so I'm a spawner too" — which
 * resolves a describe block that calls spawnCli()/runCli() wrappers, but
 * never a plain cleanup sink (`function teardown(dir) { rmSync(dir, ...); }`)
 * that is CALLED BY a CLI-spawning segment yet never itself calls anything
 * CLI-shaped. That shared-teardown-helper idiom is now the dominant shape for
 * newly-fixed instances of this class (redrive.test.js, rewind.test.js,
 * verify-json-purity.test.js, w3-trends-and-json-output.test.js, and every
 * wave4/6/8/10/12/14-swarm-cp-pins.test.js file, 13 files total) — every one
 * happens to already be guarded today (luck, not coverage: confirmed via a
 * synthetic fixture of the exact shape, which the pre-fix algorithm scored
 * as zero offenders despite a genuinely unguarded, genuinely reachable
 * rmSync). Closed by findCliExposedHelperNames below: a second, REVERSE
 * fixpoint that starts from every segment (named or anonymous) already known
 * to be CLI-spawning and follows bare-identifier calls OUTWARD into
 * locally-defined named segments, transitively — so a teardown() invoked
 * from a spawning block's afterEach/finally (directly, or through a chain of
 * intermediate helpers) is now treated as CLI-exposed for the rmSync check
 * even though it never calls a spawner itself. See the pinned regression
 * test below for the exact fixture that proved this red before the fix.
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
 *   3. Within each segment, resolve CLI-spawning transitively by NAME, in
 *      BOTH directions:
 *        a. CALLS-INTO (findCliSpawningHelperNames): a segment is
 *           CLI-spawning if it directly calls one of execFileSync(/
 *           execSync(/spawnSync(/spawn( with CLI_PATH in the same segment,
 *           OR if it calls a top-level helper already known (by fixpoint) to
 *           be CLI-spawning. This resolves wave12-swarm-cp-pins.test.js's
 *           actual shape: its describe block calls spawnCli(), which calls
 *           runCli(), which is the segment that directly calls
 *           execFileSync(CLI_PATH) — two levels of indirection, so a
 *           non-transitive single-pass check would still have missed it.
 *        b. CALLED-FROM (findCliExposedHelperNames, added F-469589af wave
 *           20): starting from every segment already known to be
 *           CLI-spawning (by 3a, or a bare CLI_SPAWN_SHAPE+CLI_PATH match),
 *           any locally-defined named segment it calls is ALSO CLI-exposed,
 *           transitively. This is the REVERSE of 3a and catches a plain
 *           cleanup sink (`function teardown(dir) { rmSync(dir, ...); }`)
 *           that is called by a spawning segment but never itself calls
 *           anything CLI-shaped — 3a alone can never add such a helper to
 *           the spawning set no matter how many spawning segments call it.
 *   4. Every rmSync( match inside a segment that is CLI-spawning OR
 *      CLI-exposed (3a or 3b) must be guarded by the established
 *      `try { rmSync(...) } catch { ... }` idiom (the literal token sequence
 *      `try {` immediately preceding `rmSync(`, matching every already-fixed
 *      sibling in this package).
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
 *   - Does NOT catch a CLI-spawning helper imported from ANOTHER file
 *     (F-06887676, wave 22, confirming audit): buildNamedSegments only ever
 *     inspects THIS file's own top-level segments — it has no visibility
 *     into any other module. Constructed directly: a describe block whose
 *     afterEach calls `spawnCliFromHelper(['status'], dbPath)` — imported
 *     via `import { spawnCliFromHelper } from './test-support/cli-helper.js'`,
 *     not locally defined — immediately followed by a genuinely unguarded,
 *     locally-defined `function teardown(dir) { rmSync(dir, ...); }` scores
 *     ZERO offenders: the describe block's own segment text never matches
 *     CLI_SPAWN_SHAPE+CLI_PATH (the call site is `spawnCliFromHelper(`, and
 *     CLI_PATH lives in the imported file, not this one), so neither
 *     findCliSpawningHelperNames' nor findCliExposedHelperNames' worklist is
 *     ever seeded for that segment. Not live today: test-support/ contains
 *     only strip-comments.js, no CLI-spawning export exists to import — but
 *     this file's own header above already recommends extracting
 *     walkTestFiles to test-support/ as the established next step (mirroring
 *     how strip-comments.js itself replaced five duplicated per-file
 *     copies), and that same move for a shared CLI-spawn helper would
 *     silently reopen this exact class for every importing file. Known
 *     residual, not a silent claim of completeness.
 *   - Does NOT catch a CLI-spawn call reached through an ALIASED
 *     child_process import (F-06887676, wave 22, confirming audit):
 *     CLI_SPAWN_SHAPE matches only the four literal names execFileSync/
 *     execSync/spawnSync/spawn — a file that writes
 *     `import { execFileSync as run } from 'node:child_process'` and then
 *     calls `run(process.execPath, [CLI_PATH, ...], ...)` produces a
 *     call-site text of `run(`, which cannot match under any alias. Grepped
 *     every `from 'node:child_process'` import across all 161 test files in
 *     this package during this pass (44 import execFileSync/execSync/
 *     spawnSync/spawn): zero use `as` aliasing today, so this is not live.
 *     Distinct from the already-disclosed "differently named CLI_PATH
 *     constant" residual above — that bullet discloses the PATH constant's
 *     name is load-bearing; this one discloses the CALL SHAPE's name is
 *     equally alias-fragile.
 *
 * A SECOND, sibling sweep lives at the bottom of this file (task_6026249b,
 * post-wave-22): the live-DB ISOLATION sweep — same segment machinery, the
 * other half of the same WAL-sidecar disease. This sweep polices how a
 * CLI-spawning segment CLEANS UP; that one polices what a CLI-spawning
 * segment AIMS AT (every spawn site must pin SWARM_DB, so no test can open
 * the repo-default swarms/control-plane.db). See its own header below for
 * scope and residuals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './test-support/strip-comments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;

// F-90ee1ab5 (wave 20, NOT fully closed — cross-domain, see below): this
// function is byte-for-byte identical to meta-portable-fixture-paths.test.js's
// own walkTestFiles, and near-identical (different extension filter) to
// reason-escaping-discipline.test.js's walkSync. A fix to this copy's
// directory-walk logic (a new skip-list entry, a symlink-loop edge case) has
// no mechanical reason to reach either sibling — mirror any such edit into
// BOTH. The established fix — extract to test-support/ alongside
// strip-comments.js, which this same file already imports below — is NOT
// done here: packages/dogfood-swarm/test-support/** matches no owned,
// shared, or bridge glob in this wave's frozen domain map (this domain's own
// bridge glob, packages/dogfood-swarm/*.test.js, does not cross the
// test-support/ directory boundary), so a new file there would land
// unassigned and fail this agent's own ownership check. Needs a domain-map
// amendment before it can be extracted; see this wave's swarm-cp-tests
// output.json skipped[] entry for the full mechanical proof.
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

// A top-level segment "declares a name" when it opens with `function NAME(`
// or `const NAME =` — the two shapes this file's helpers/constants use.
// Factored to one place (F-90ee1ab5 wave 20: this exact pair of alternatives
// was independently duplicated across findCliSpawningHelperNames and the new
// findCliExposedHelperNames below before this extraction) so a future third
// caller — or a future third declaration shape — has one place to change.
const NAMED_SEGMENT_DECL = [/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/, /^const\s+(\w+)\s*=/];

function declaredSegmentName(segText) {
  for (const re of NAMED_SEGMENT_DECL) {
    const m = segText.match(re);
    if (m) return m[1];
  }
  return null;
}

function buildNamedSegments(text, boundaries) {
  const namedSegments = new Map();
  for (let i = 0; i < boundaries.length - 1; i++) {
    const seg = text.slice(boundaries[i], boundaries[i + 1]);
    const name = declaredSegmentName(seg);
    if (name) namedSegments.set(name, seg);
  }
  return namedSegments;
}

// See header point 3a. Fixpoint over top-level named declarations: a segment
// name is CLI-spawning if its own body matches CLI_SPAWN_SHAPE + CLI_PATH,
// or if its own body calls a name already known to be CLI-spawning —
// repeated until no new name is added, so an N-level wrapper chain (not
// just one level) resolves correctly. This is the CALLS-INTO direction only
// — see findCliExposedHelperNames below for the complementary CALLED-FROM
// direction (F-469589af, wave 20).
function findCliSpawningHelperNames(text, boundaries) {
  const namedSegments = buildNamedSegments(text, boundaries);
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

// See header point 3b (F-469589af, wave 20). The REVERSE of
// findCliSpawningHelperNames: starting from every segment (named or
// anonymous — an anonymous describe/it block can be the ORIGIN of a
// called-from edge even though it can never be a call TARGET) already known
// to be CLI-spawning, follow bare-identifier calls outward into
// locally-defined named segments, transitively. This is what lets a plain
// cleanup sink — `function teardown(dir) { rmSync(dir, ...); }` — that is
// called BY a spawning segment but never itself calls anything CLI-shaped
// be recognized as CLI-exposed: findCliSpawningHelperNames alone can never
// add such a helper to its set, because that fixpoint only ever looks at
// what a segment itself CALLS, never at who CALLS the segment.
function findCliExposedHelperNames(text, boundaries, cliHelperNames) {
  const namedSegments = buildNamedSegments(text, boundaries);
  const exposed = new Set(cliHelperNames);
  const worklist = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const segText = text.slice(boundaries[i], boundaries[i + 1]);
    if (segmentIsCliSpawning(segText, cliHelperNames)) worklist.push(segText);
  }
  while (worklist.length > 0) {
    const segText = worklist.pop();
    for (const [name, calleeSeg] of namedSegments) {
      if (exposed.has(name)) continue;
      if (new RegExp(`\\b${name}\\s*\\(`).test(segText)) {
        exposed.add(name);
        worklist.push(calleeSeg); // chain: a helper teardown() itself calls is exposed too
      }
    }
  }
  return exposed;
}

// Extracted so the self-tests below can exercise the exact detection logic
// the real sweep uses, without writing throwaway files to disk — same
// pattern as meta-portable-fixture-paths.test.js's
// findHardcodedAbsolutePathOffenders.
function findUnguardedRmSyncOffenders(rawText) {
  const text = stripComments(rawText); // preserves line numbers
  const boundaries = findTopLevelSegmentBoundaries(text);
  const cliHelperNames = findCliSpawningHelperNames(text, boundaries);
  const cliExposedNames = findCliExposedHelperNames(text, boundaries, cliHelperNames);
  const rawLines = rawText.split('\n');
  const offenders = [];
  for (const match of text.matchAll(RMSYNC_CALL)) {
    const before = text.slice(Math.max(0, match.index - 60), match.index);
    if (GUARDED_RMSYNC_PREFIX.test(before)) continue;
    const segText = segmentTextAt(text, boundaries, match.index);
    // A segment is in scope for the guard check if it is ITSELF CLI-spawning
    // (3a), or if it is a locally-defined named segment CALLED BY a
    // CLI-spawning segment (3b, F-469589af) — e.g. a `function teardown(dir)`
    // segment that a spawning describe block invokes in its own afterEach.
    const segName = declaredSegmentName(segText);
    const isCliExposed = segmentIsCliSpawning(segText, cliHelperNames)
      || (segName !== null && cliExposedNames.has(segName));
    if (!isCliExposed) continue;
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

  it('catches an unguarded rmSync inside a shared teardown() helper CALLED BY a CLI-spawning block, even though teardown() itself never calls a spawner (F-469589af, wave 20 — the reverse of the wrapper-chain case above)', () => {
    // Before F-469589af this was a proven RED: findCliSpawningHelperNames'
    // fixpoint only ever asks "does this segment CALL a known spawner?" —
    // teardown()'s own body calls nothing but rmSync, so it could never be
    // added no matter how many spawning blocks called IT. The offender loop
    // then resolved teardown()'s own segment via segmentIsCliSpawning, which
    // also answered false, and skipped the rmSync without ever checking its
    // guard. This is the exact real-world shape (a top-level `function
    // teardown(dir)` used as a shared cleanup sink) already live in 13 files
    // in this package today (redrive.test.js, rewind.test.js,
    // verify-json-purity.test.js, w3-trends-and-json-output.test.js, every
    // wave4/6/8/10/12/14-swarm-cp-pins.test.js file) — all 13 happen to
    // already be guarded, so this closes a latent gap, not a live failure.
    const cliPathName = ['CLI', 'PATH'].join('_');
    const rmName = ['rm', 'Sync'].join('');
    const execName = ['exec', 'FileSync'].join('');
    const synthetic = [
      `const ${cliPathName} = join(__dirname, 'cli.js');`,
      ``,
      `function teardown(dir) {`,
      `  ${rmName}(dir, { recursive: true, force: true });`,
      `}`,
      ``,
      `describe('uses shared teardown helper', () => {`,
      `  afterEach(() => {`,
      `    ${execName}(process.execPath, [${cliPathName}, 'status'], { env: { SWARM_DB: dbPath } });`,
      `    teardown(dbPath);`,
      `  });`,
      `});`,
    ].join('\n');
    const offenders = findUnguardedRmSyncOffenders(synthetic);
    assert.equal(offenders.length, 1,
      `an unguarded rmSync inside a teardown() helper called by a CLI-spawning block must be caught even ` +
      `though teardown() never itself calls a spawner; got ${JSON.stringify(offenders)}`);
    assert.match(offenders[0].snippet, /rmSync/, 'the flagged offender must be the rmSync inside teardown()');
  });

  it('does NOT flag an unguarded rmSync inside a teardown()-shaped helper that no CLI-spawning segment ever calls (the called-from pass stays call-graph-precise, not "any helper named teardown")', () => {
    // Negative control for F-469589af: proves findCliExposedHelperNames
    // follows actual call edges rather than pattern-matching on the helper's
    // NAME or its rmSync body shape. If this over-flagged, the reverse pass
    // would have degraded into exactly the noisy, ignorable-guard outcome
    // this file's own header rejects for CLI_PATH anchoring.
    const rmName = ['rm', 'Sync'].join('');
    const synthetic = [
      `function teardown(dir) {`,
      `  ${rmName}(dir, { recursive: true, force: true });`,
      `}`,
      ``,
      `describe('never calls teardown or the CLI', () => {`,
      `  afterEach(() => {`,
      `    ${rmName}(otherDir, { recursive: true, force: true });`,
      `  });`,
      `});`,
    ].join('\n');
    const offenders = findUnguardedRmSyncOffenders(synthetic);
    assert.deepEqual(offenders, [],
      `an unused teardown() helper plus an unrelated non-CLI-spawning block must not be flagged; got ${JSON.stringify(offenders)}`);
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

/*
 * ─────────────────────────────────────────────────────────────────────────
 * Live-DB isolation sweep (task_6026249b, post-wave-22) — the TARGET half.
 *
 * THE DEFECT THIS CLOSES: cli-smoke.test.js's `swarm history abc` smoke test
 * spawned the CLI with no SWARM_DB in env. cmdHistory resolves getDbPath()
 * and OPENS the DB before validating that the wave-id is a positive integer
 * (cli.js:1302 → commands/history.js), so a "pure usage-error" test opened
 * the LIVE repo swarms/control-plane.db mid-suite — churning its WAL
 * -shm/-wal sidecars inside stageD-output-dir-tracks-db.test.js's
 * before/after snapshot window, an intermittent full-suite-only flake. On a
 * fresh clone it would even CREATE swarms/control-plane.db in the repo tree
 * (openDb creates file + schema). Proven by instrumenting getDbPath()/
 * openDb() and running the package suite (2026-07-16): exactly one process
 * resolved the repo default — `cli.js history abc`, swarmDbEnv: null.
 *
 * THE CLASS, NOT THE INSTANCE (swarms/PROTOCOL.md discipline): 8 more spawn
 * sites/helpers had no SWARM_DB pin and survived only because their command
 * paths happen to usage-exit before touching the DB — an ordering that
 * cmdHistory proves is NOT contractual. One refactor (resolving the DB
 * before arg validation, as history already does) silently flips every one
 * of them into a live-repo-DB opener. So the invariant is enforced at the
 * spawn CALL: every spawn of CLI_PATH must contain the SWARM_DB literal
 * inside its own argument text — i.e. the call pins (or explicitly
 * forwards) the env key itself. A helper that delegates pinning to its call
 * sites is an offender BY DESIGN: the live defect happened exactly because
 * runHistoryCli left the pin to callers and one call site forgot. A helper
 * that pins a temp-path fallback (`env: { ...process.env, SWARM_DB: <temp>,
 * ...extraEnv }`) makes call-site forgetting impossible while keeping
 * overrides expressible.
 *
 * WHY PER-CALL, NOT PER-SEGMENT (this sweep's own blind-spot lesson, caught
 * before it shipped): an early draft tested SWARM_DB presence per top-level
 * SEGMENT, the same granularity the teardown sweep above uses. Run against
 * the pre-fix tree it flagged only 5 of the 9 live sites — and MISSED the
 * one that actually opened the live DB: runHistoryCli is nested inside a
 * describe block whose SIBLING call sites pass `{ SWARM_DB: dbPath }`, so
 * the segment contained the literal while the spawn call itself pinned
 * nothing. Segment-presence is structurally blind to exactly the
 * delegated-pin shape that shipped the bug ("a detector's blind spot IS the
 * defect"). The check therefore extracts each spawn call's full argument
 * text (string-aware balanced-paren walk) and requires the pin THERE. The
 * nested-helper regression fixture below pins this red-then-green.
 *
 * SCOPE, STATED PLAINLY (disclosed residuals, same honesty contract as the
 * teardown sweep above; the CLI_PATH-anchor + literal-name + alias-fragility
 * bullets in the main header apply to this sweep unchanged — shared
 * constants):
 *   - PRESENCE of the pin, not VALUE safety: a segment that writes
 *     `SWARM_DB: DEFAULT_DB_PATH` (deliberately aiming at the repo DB), or
 *     deletes the key from a built env object after pinning it, passes this
 *     sweep. Verifying the value lands in a temp dir is data-flow analysis —
 *     the same not-cheap-enough boundary the teardown sweep draws for
 *     function-reference indirection.
 *   - A spawn whose options object is BUILT outside the call parens
 *     (`const OPTS = { env: { ...process.env, SWARM_DB: x } };` then
 *     `spawnSync(cmd, argv, OPTS)`) would over-flag: the call's own argument
 *     text lacks the literal. Likewise a spawn whose argv array inlines
 *     CLI_PATH via a variable built elsewhere escapes the CLI_PATH anchor
 *     entirely (under-flag). Neither is a live shape in this package today —
 *     all 44 CLI-spawn sites inline both the CLI_PATH argv and the options
 *     object in the call (verified this pass; this sweep ships green over
 *     the whole tree). If either arises, inline the pin in the call.
 *   - In-process openDb(path) targets are OUT of this sweep's scope — every
 *     one of the ~300 in-process openDb call sites takes an explicit path
 *     variable, and asserting those values statically is the same data-flow
 *     boundary. Ground truth was established dynamically instead
 *     (2026-07-16 instrumentation run: zero in-process opens resolved to
 *     the repo default; the history CLI child was the only one).
 * ─────────────────────────────────────────────────────────────────────────
 */

// Walk forward from an opening paren to its balanced close, skipping over
// string literals (' " `) so a paren inside a message/path argument cannot
// unbalance the walk. On this package's Prettier-formatted spawn calls this
// recovers the exact call-argument text; a truncated/unbalanced tail
// degrades to "rest of file", which can only widen the text searched (never
// silently narrow the check).
function extractCallText(text, openParenIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openParenIndex; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(openParenIndex, i + 1);
    }
  }
  return text.slice(openParenIndex);
}

function findUnpinnedCliSpawnOffenders(rawText) {
  const text = stripComments(rawText); // preserves line numbers
  const rawLines = rawText.split('\n');
  const offenders = [];
  // Per spawn CALL, not per segment — see header ("WHY PER-CALL"): the pin
  // must live inside the call's own argument text. A helper that delegates
  // the pin to its call sites is the defect shape that shipped the live
  // offender, so helper-indirected call sites are deliberately NOT what is
  // checked here; the helper's own spawn call is.
  for (const m of text.matchAll(new RegExp(CLI_SPAWN_SHAPE.source, 'g'))) {
    const callText = extractCallText(text, m.index + m[0].length - 1);
    if (!callText.includes('CLI_PATH')) continue; // not a swarm-CLI spawn
    if (callText.includes('SWARM_DB')) continue; // pinned (or forwarded) at the call
    const line = text.slice(0, m.index).split('\n').length;
    offenders.push({ line, snippet: (rawLines[line - 1] || '').trim() });
  }
  return offenders;
}

// Same interpolated-parts discipline as syntheticOffender above: this file is
// itself a *.test.js under PKG_ROOT, so every token the sweep matches on must
// arrive via interpolation, never as contiguous literal source text.
function syntheticSpawnTarget({ pinned }) {
  const cliPathName = ['CLI', 'PATH'].join('_');
  const spawnName = ['spawn', 'Sync'].join('');
  const dbKey = ['SWARM', '_DB'].join('');
  const envText = pinned
    ? `env: { ...process.env, ${dbKey}: join(tmp, 'control-plane.db') },`
    : `env: { ...process.env },`;
  return [
    `const ${cliPathName} = join(__dirname, 'cli.js');`,
    `describe('synthetic target', () => {`,
    `  it('spawns the CLI', () => {`,
    `    const r = ${spawnName}(process.execPath, [${cliPathName}, 'status'], {`,
    `      encoding: 'utf-8',`,
    `      ${envText}`,
    `    });`,
    `  });`,
    `});`,
  ].join('\n');
}

describe('meta — every CLI-spawning test segment pins SWARM_DB off the live repo control plane (task_6026249b)', () => {
  it('sweep must visit at least one test file', () => {
    // Anti-vacuity insurance, same shape as the teardown sweep's own.
    assert.ok(walkTestFiles(PKG_ROOT).length > 0, 'sweep must visit at least one test file');
  });

  it('no test segment anywhere in this package spawns the CLI without a SWARM_DB pin at the spawn site', () => {
    const offenders = [];
    for (const f of walkTestFiles(PKG_ROOT)) {
      const text = readFileSync(f, 'utf-8');
      const relPath = f.slice(PKG_ROOT.length + 1).split('\\').join('/');
      for (const { line, snippet } of findUnpinnedCliSpawnOffenders(text)) {
        offenders.push(`${relPath}:${line}: ${snippet}`);
      }
    }
    assert.deepEqual(offenders, [],
      `CLI spawned as a subprocess without SWARM_DB pinned in the same segment — the child inherits the ` +
      `repo-default swarms/control-plane.db, opens the LIVE operational DB (cmdHistory proves usage-error ` +
      `paths can open before validating args), churns its WAL sidecars under full-suite concurrency, and ` +
      `on a fresh clone CREATES the DB inside the repo tree. Pin a temp fallback at the spawn site: ` +
      `env: { ...process.env, SWARM_DB: join(<mkdtemp dir>, 'control-plane.db'), ...extraEnv } — matching ` +
      `every already-fixed sibling in this package.\n  ${offenders.join('\n  ')}`);
  });

  it('catches a direct CLI spawn whose env never pins SWARM_DB', () => {
    const offenders = findUnpinnedCliSpawnOffenders(syntheticSpawnTarget({ pinned: false }));
    assert.equal(offenders.length, 1,
      `expected exactly one offender for an unpinned CLI spawn; got ${JSON.stringify(offenders)}`);
    assert.match(offenders[0].snippet, /process\.execPath/,
      'the flagged offender must be the spawn call itself');
  });

  it('does NOT flag a CLI spawn that pins SWARM_DB in the same segment', () => {
    const offenders = findUnpinnedCliSpawnOffenders(syntheticSpawnTarget({ pinned: true }));
    assert.deepEqual(offenders, [],
      `a spawn with a SWARM_DB pin must not be flagged; got ${JSON.stringify(offenders)}`);
  });

  it('flags a spawn HELPER that delegates the SWARM_DB pin to its call sites (the exact shape that shipped the live offender)', () => {
    // runHistoryCli's pre-fix shape: `env: { ...process.env, ...extraEnv }` in
    // the helper, `{ SWARM_DB: dbPath }` at SOME call sites — and the one call
    // site that forgot (`runHistoryCli(['abc'])`) opened the live repo DB.
    // The pin belongs in the helper; the caller-side key must not satisfy the
    // sweep.
    const cliPathName = ['CLI', 'PATH'].join('_');
    const spawnName = ['spawn', 'Sync'].join('');
    const dbKey = ['SWARM', '_DB'].join('');
    const synthetic = [
      `const ${cliPathName} = join(__dirname, 'cli.js');`,
      `function runCli(args, extraEnv = {}) {`,
      `  return ${spawnName}(process.execPath, [${cliPathName}, ...args], { env: { ...process.env, ...extraEnv } });`,
      `}`,
      `describe('caller pins, helper does not', () => {`,
      `  it('x', () => { runCli(['status'], { ${dbKey}: dbPath }); });`,
      `});`,
    ].join('\n');
    const offenders = findUnpinnedCliSpawnOffenders(synthetic);
    assert.equal(offenders.length, 1,
      `the unpinned helper must be flagged even when a call site passes the key; got ${JSON.stringify(offenders)}`);
    assert.match(offenders[0].snippet, /process\.execPath/,
      'the flagged offender must be the helper spawn site, not the call site');
  });

  it('catches an unpinned spawn helper nested INSIDE a describe whose sibling call site passes SWARM_DB (the exact runHistoryCli shape the segment-granularity draft missed)', () => {
    // Pre-fix cli-smoke.test.js, distilled: the helper and a PINNED call site
    // share one top-level describe segment, so segment-level presence testing
    // sees the literal somewhere in the segment and goes blind — proven
    // against the pre-fix tree, where the segment-granularity draft flagged
    // only 5 of the 9 live sites and missed the one that actually opened the
    // live DB. Per-call extraction must flag exactly the helper's own spawn
    // call, once.
    const cliPathName = ['CLI', 'PATH'].join('_');
    const spawnName = ['spawn', 'Sync'].join('');
    const dbKey = ['SWARM', '_DB'].join('');
    const synthetic = [
      `const ${cliPathName} = join(__dirname, 'cli.js');`,
      `describe('history smoke', () => {`,
      `  function runHistoryCli(args, extraEnv = {}) {`,
      `    return ${spawnName}(process.execPath, [${cliPathName}, 'history', ...args], {`,
      `      encoding: 'utf-8',`,
      `      env: { ...process.env, ...extraEnv },`,
      `    });`,
      `  }`,
      `  it('pinned call site', () => {`,
      `    const r = runHistoryCli(['999999'], { ${dbKey}: emptyDbPath });`,
      `  });`,
      `  it('forgotten call site', () => {`,
      `    const r = runHistoryCli(['abc']);`,
      `  });`,
      `});`,
    ].join('\n');
    const offenders = findUnpinnedCliSpawnOffenders(synthetic);
    assert.equal(offenders.length, 1,
      `the nested unpinned helper must be flagged despite the sibling pinned call site; got ${JSON.stringify(offenders)}`);
    assert.match(offenders[0].snippet, /process\.execPath/,
      'the flagged offender must be the helper spawn call');
  });

  it('does NOT flag a non-CLI child-process spawn (e.g. a `git` helper) without SWARM_DB, because it never references CLI_PATH', () => {
    const execName = ['exec', 'FileSync'].join('');
    const synthetic = [
      `function git(cwd, args) { return ${execName}('git', args, { cwd, env: { ...process.env } }); }`,
    ].join('\n');
    const offenders = findUnpinnedCliSpawnOffenders(synthetic);
    assert.deepEqual(offenders, [],
      `a non-CLI child-process spawn must not be flagged; got ${JSON.stringify(offenders)}`);
  });
});
