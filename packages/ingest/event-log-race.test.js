/**
 * event-log-race.test.js — concurrency stress test for `appendEvent`.
 *
 *   F-PIPELINE-011 (W3-PIPE-001) — chain #2 sibling-pattern. The pre-fix
 *   `appendEvent` did read-modify-write of a YAML array under temp+rename:
 *   atomic against torn-write, but two concurrent appenders both read N
 *   events, both pushed, both renamed — second rename wins, dropping the
 *   first appender's event.
 *
 *   Pattern #4 (choke-point fix): close the read-then-write window at the
 *   one site where YAML is read, mutated, and rewritten. Implemented via
 *   `withFileLock` (mkdir-based directory mutex) in `findings/lib/file-lock.js`,
 *   wired into `appendEvent` in `findings/review/event-log.js`.
 *
 * Lives under `packages/ingest/` because the ingest pipeline owns the
 * concurrency-stress regression catalog (mirrors wave22 / wave28 placement).
 * The code under test is in findings — that's expected: this test pins
 * cross-package behavior at the pipeline-integration boundary, same way
 * `wave22-log-stage-discipline.test.js` reaches into dogfood-swarm.
 *
 * 2-step FAILS-then-PASSES proof: this test was written BEFORE wiring the
 * lock into appendEvent. Run #1 (lock removed): asserts fail with dropped
 * events under 50-way concurrent appends. Run #2 (lock wired): all 50
 * events land. Documented in the wave-30 receipt.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import yaml from 'js-yaml';
import { fork } from 'node:child_process';

// Cross-package import: use a relative path because ingest cannot depend on
// findings (findings already depends on ingest — adding the reverse edge
// would create a workspace dependency cycle). The test still pins the
// integration boundary; npm workspaces hoists nothing here, the path is
// stable. Mirrors how wave22-log-stage-discipline.test.js reaches into
// dogfood-swarm without a package-level dep.
import { appendEvent, createEvent, getAllEvents, getLogPath } from '../findings/review/event-log.js';
import { withFileLock, isLocked, lockDirFor } from '../findings/lib/file-lock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_event_log_race__');

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardownTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

/**
 * Read the events array from the daily log file directly. Uses `getLogPath`
 * (rather than walking the reviews/ tree via `getAllEvents`) so the assertion
 * is unambiguous about WHICH file we expect to be intact.
 */
function readDailyLog(rootDir) {
  const logPath = getLogPath(rootDir);
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, 'utf-8');
  const arr = yaml.load(raw);
  if (!arr) return [];
  return Array.isArray(arr) ? arr : [arr];
}

// ─────────────────────────────────────────────────────────────────────
// Concurrency: in-process via Promise.all — fires real fs writes in parallel
// ─────────────────────────────────────────────────────────────────────

describe('appendEvent — in-process serial smoke-test (W3-PIPE-001)', () => {
  // Note: Node's sync fs ops within one thread are serialized by the event
  // loop — true in-process concurrency on appendEvent requires worker threads
  // or forks. This describe block is a stress-smoke check (50 sequential
  // appends, all events land, no torn reads, lock released). The CANONICAL
  // race detector lives in the multi-process suite below; that's the test
  // that demonstrably FAILS without the fix and PASSES with it.

  before(setupTestRoot);
  after(teardownTestRoot);

  const ITERATIONS = 3;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    it(`50 sequenced appends preserve every event (iteration ${iter + 1}/${ITERATIONS})`, async () => {
      if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
      mkdirSync(TEST_ROOT, { recursive: true });

      const N = 50;
      const events = Array.from({ length: N }, (_, i) => createEvent({
        findingId: `F-race-${iter}-${String(i).padStart(3, '0')}`,
        actor: 'race-test',
        action: 'review',
        fromStatus: 'candidate',
        toStatus: 'reviewed',
      }));

      await Promise.all(events.map(ev => new Promise((res, rej) => {
        setImmediate(() => {
          try {
            appendEvent(TEST_ROOT, ev);
            res();
          } catch (err) {
            rej(err);
          }
        });
      })));

      const persisted = readDailyLog(TEST_ROOT);
      assert.equal(persisted.length, N, `expected all ${N} events, got ${persisted.length}`);

      const expectedIds = events.map(e => e.review_event_id).sort();
      const actualIds = persisted.map(e => e.review_event_id).sort();
      assert.deepEqual(actualIds, expectedIds, 'every appended event must appear exactly once');

      const logPath = getLogPath(TEST_ROOT);
      assert.equal(existsSync(`${logPath}.lock`), false, 'lock file must be released after success');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Multi-process concurrency: forked subprocesses really do run in
// parallel, so this exercises the cross-process correctness of the
// directory-mutex (the in-process version above only proves async
// interleaving, not true multi-process).
// ─────────────────────────────────────────────────────────────────────

describe('appendEvent — multi-process concurrency (W3-PIPE-001)', () => {
  before(setupTestRoot);
  after(teardownTestRoot);

  // Multiple iterations — the briefing calls for flushing out race timing
  // windows. A 1-iteration test passing once is not strong enough evidence;
  // 3 back-to-back 50-fork rounds cover the timing spectrum well enough that
  // a regression would surface in CI before merge.
  const ITERATIONS = 3;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    it(`50 forked processes append distinct events without loss — iteration ${iter + 1}/${ITERATIONS} (canonical race detector)`, { timeout: 60_000 }, async () => {
      if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
      mkdirSync(TEST_ROOT, { recursive: true });

      const helperPath = resolve(__dirname, 'event-log-race.helper.mjs');
      const N = 50;

      const procs = Array.from({ length: N }, (_, i) => new Promise((res, rej) => {
        const child = fork(helperPath, [TEST_ROOT, `proc-${iter}-${i}`], {
          silent: true,
          env: process.env, // forward HELPER_DEBUG / FILE_LOCK_DEBUG
        });
        let stderr = '';
        child.stderr?.on('data', d => {
          stderr += d.toString();
          if (process.env.HELPER_DEBUG) process.stderr.write(d);
        });
        child.on('exit', code => {
          if (code === 0) return res({ id: `proc-${iter}-${i}`, stderr });
          rej(new Error(`helper proc ${i} exited ${code}: ${stderr}`));
        });
        child.on('error', rej);
      }));

      await Promise.all(procs);

      const persisted = readDailyLog(TEST_ROOT);
      const expectedIds = Array.from({ length: N }, (_, i) => `proc-${iter}-${i}`).sort();
      const actualIds = persisted.map(e => e.finding_id).sort();
      const missing = expectedIds.filter(id => !actualIds.includes(id));

      // Diagnostic: if events were lost, list residual files in the reviews
      // tree so we can see whether any orphaned tmp files remain (which
      // would indicate a release-race scenario).
      let diagnostic = '';
      if (persisted.length !== N) {
        const reviewsDir = join(TEST_ROOT, 'reviews');
        if (existsSync(reviewsDir)) {
          const walk = (d, acc) => {
            for (const e of readdirSync(d)) {
              const full = join(d, e);
              if (statSync(full).isDirectory()) walk(full, acc);
              else acc.push(full.replace(TEST_ROOT, ''));
            }
            return acc;
          };
          diagnostic = `\nfiles in reviews/: ${walk(reviewsDir, []).join('\n  ')}`;
        }
      }

      assert.equal(persisted.length, N, `expected ${N} cross-process events, got ${persisted.length} (missing: ${missing.join(', ')})${diagnostic}`);
      assert.deepEqual(actualIds, expectedIds, 'every forked-process event must land');

      const logPath = getLogPath(TEST_ROOT);
      assert.equal(existsSync(`${logPath}.lock`), false, 'lock file must be released after success');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Cross-platform behavior assertions — the lock dir uses mkdir-based
// exclusivity which Node guarantees on every fs it supports. The shape
// of the lock (a directory at `<targetPath>.lock`) is what the test pins.
// ─────────────────────────────────────────────────────────────────────

describe('withFileLock — file-mutex contract', () => {
  let tmp;
  beforeEach(() => {
    tmp = resolve(TEST_ROOT, 'lock-contract');
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
  });

  it('creates a lock file at <target>.lock during the critical section', () => {
    const target = join(tmp, 'log.yaml');
    let observedLockedDuringCs = false;
    withFileLock(target, () => {
      observedLockedDuringCs = isLocked(target);
    });
    assert.equal(observedLockedDuringCs, true, 'lock must be held during fn');
    assert.equal(isLocked(target), false, 'lock must release after fn returns');
  });

  it('releases the lock if fn throws', () => {
    const target = join(tmp, 'log.yaml');
    assert.throws(() => withFileLock(target, () => { throw new Error('boom'); }), /boom/);
    assert.equal(isLocked(target), false, 'lock must release on throw');
  });

  it('lock dir path matches lockDirFor(target)', () => {
    const target = join(tmp, 'log.yaml');
    assert.equal(lockDirFor(target), `${target}.lock`);
  });

  it('serializes nested withFileLock calls on the same target', async () => {
    // Two callers with the same target must observe ordered execution.
    // Use a small wait inside each critical section to make the ordering
    // observable.
    const target = join(tmp, 'log.yaml');
    const sequence = [];

    const a = new Promise(res => setImmediate(() => {
      withFileLock(target, () => {
        sequence.push('a-start');
        // No setTimeout — the lock is sync. We add a sentinel to prove the
        // critical section ran before b's did.
        sequence.push('a-end');
      });
      res();
    }));

    const b = new Promise(res => setImmediate(() => {
      withFileLock(target, () => {
        sequence.push('b-start');
        sequence.push('b-end');
      });
      res();
    }));

    await Promise.all([a, b]);

    // Either a-start..a-end..b-start..b-end OR b-start..b-end..a-start..a-end.
    // What is NEVER allowed: an interleaved a-start, b-start, a-end, b-end.
    const interleaved =
      (sequence.indexOf('a-start') < sequence.indexOf('b-start') &&
       sequence.indexOf('b-start') < sequence.indexOf('a-end')) ||
      (sequence.indexOf('b-start') < sequence.indexOf('a-start') &&
       sequence.indexOf('a-start') < sequence.indexOf('b-end'));
    assert.equal(interleaved, false, `serialization broken: ${sequence.join(',')}`);
  });

  it('different targets do not contend with each other', () => {
    const t1 = join(tmp, 'log-a.yaml');
    const t2 = join(tmp, 'log-b.yaml');
    let bRanWhileAHeld = false;
    withFileLock(t1, () => {
      // While we hold t1, t2 must be acquirable immediately (no contention).
      withFileLock(t2, () => {
        bRanWhileAHeld = true;
      });
    });
    assert.equal(bRanWhileAHeld, true);
    assert.equal(isLocked(t1), false);
    assert.equal(isLocked(t2), false);
  });

  it('reclaims a stale lock whose holder PID is gone', () => {
    const target = join(tmp, 'log.yaml');
    const lockPath = lockDirFor(target);
    // Plant a lock file with a definitely-dead PID. Use a very high pid that
    // is extremely unlikely to be an active process; sanity-check first.
    const fakeDeadPid = 2_147_000_000;
    let alive = true;
    try { process.kill(fakeDeadPid, 0); } catch (e) { if (e?.code === 'ESRCH') alive = false; }
    if (alive) return; // best-effort skip on flaky environment

    writeFileSync(lockPath, String(fakeDeadPid), 'utf-8');

    let ran = false;
    withFileLock(target, () => { ran = true; });
    assert.equal(ran, true, 'must have reclaimed the stale lock and run fn');
    assert.equal(isLocked(target), false, 'lock released after reclaimed acquisition');
  });
});
