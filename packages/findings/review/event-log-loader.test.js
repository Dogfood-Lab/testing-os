/**
 * event-log-loader.test.js — H1 invariant: walkYaml must NOT silently swallow
 * torn YAML files (F-721047-010 silent-loader family).
 *
 * AT HEAD: `walkYaml` in event-log.js wraps the entire read/parse/walk loop
 * in a single `try { ... } catch { /* skip bad files * / }`. A torn YAML file
 * in `reviews/` disappears from `getAllEvents()` with no signal that
 * anything went wrong. The next reviewer sees a clean event log and may
 * conclude "no events for this finding" when in fact a torn log file
 * silently dropped them.
 *
 * AFTER FIX: `getAllEventsWithSkips()` returns `{ events, skipped }` where
 * `skipped` is a list of `{ path, error }`. A torn file shows up there. The
 * legacy `getAllEvents()` keeps returning the events array for backward-
 * compat with existing callers, but goes through the structured loader so
 * the torn file no longer silently vanishes — its events are absent (because
 * the file is unreadable), but a sibling discovery API surfaces it.
 *
 * This test seeds a torn YAML file alongside a good one and asserts:
 *   - The good file's events surface.
 *   - The torn file is reported in `skipped`, not silently dropped.
 *   - `getAllEvents` does not throw.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import { getAllEvents, getAllEventsWithSkips } from './event-log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_event_log_loader__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'reviews', '2026'), { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

describe('walkYaml — H1 silent-loader closure (F-721047-010)', () => {
  before(setup);
  after(teardown);

  it('surfaces good events AND reports torn YAML files in skipped (not silently dropped)', () => {
    const dir = resolve(TEST_ROOT, 'reviews', '2026');

    // A good log file with one event.
    writeFileSync(
      resolve(dir, '2026-05-31-finding-review-log.yaml'),
      [
        '- review_event_id: rev-good-0001',
        '  finding_id: dfind-test-good',
        '  timestamp: 2026-05-31T12:00:00Z',
        '  actor: tester',
        '  action: review',
        '  from_status: candidate',
        '  to_status: reviewed',
        '',
      ].join('\n'),
      'utf-8'
    );

    // A torn log file in the same directory.
    writeFileSync(
      resolve(dir, '2026-05-30-finding-review-log.yaml'),
      'this: : is :: invalid yaml\n  : :\n',
      'utf-8'
    );

    // Legacy API: must NOT throw — but the torn file no longer disappears
    // silently because the new API exposes it.
    const events = getAllEvents(TEST_ROOT);
    assert.ok(Array.isArray(events), 'getAllEvents must return an array');
    assert.equal(events.length, 1, 'good event surfaces');
    assert.equal(events[0].review_event_id, 'rev-good-0001');

    // The load-bearing invariant: the torn file is REPORTED, not silently
    // dropped. At HEAD this assertion fails because `getAllEventsWithSkips`
    // does not exist (and the silent catch in walkYaml drops the error).
    const withSkips = getAllEventsWithSkips(TEST_ROOT);
    assert.ok(Array.isArray(withSkips.events), 'withSkips.events array');
    assert.ok(Array.isArray(withSkips.skipped), 'withSkips.skipped array');
    assert.equal(withSkips.events.length, 1);
    assert.equal(withSkips.skipped.length, 1, 'torn file must be reported in skipped');
    assert.match(withSkips.skipped[0].path, /2026-05-30-finding-review-log\.yaml$/);
    assert.ok(withSkips.skipped[0].error, 'skipped entry must include error string');
  });

  it('returns empty events + empty skipped when reviews/ does not exist', () => {
    const dir = resolve(TEST_ROOT, 'empty-root');
    mkdirSync(dir, { recursive: true });
    const result = getAllEventsWithSkips(dir);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.skipped, []);
  });
});
