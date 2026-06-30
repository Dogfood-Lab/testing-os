/**
 * generate-badges — F5-04 (dogfood status badge / shields.io endpoint).
 *
 * generateBadges(index, options) turns the latest-by-repo index (repo ->
 * surface -> { verified, verification_status, finished_at }) into one
 * shields.io endpoint JSON per repo+surface:
 *   { schemaVersion: 1, label: 'dogfood', message, color }
 * where message/color are:
 *   pass  -> 'pass'  / 'brightgreen'
 *   fail  -> 'fail'  / 'red'
 *   stale -> 'stale' / 'orange'   (latest finished_at older than the window)
 *
 * Returns a map of posixified, sanitized filename -> endpoint object so the
 * caller can write each to indexes/badges/<org>--<repo>--<surface>.json.
 *
 * These tests construct the index in-memory (no disk). Stale detection is
 * controlled by an injectable `now` so the test is deterministic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateBadges, AGGREGATE_BADGE_FILENAME } from './generate-badges.js';

const NOW = Date.parse('2026-04-01T00:00:00Z');
const daysBefore = (n) => new Date(NOW - n * 86400000).toISOString();

// The per-surface filename tests below assert on the repo+surface pills only;
// the org-wide aggregate (covered by serve-determinism.test.js) is a separate
// concern, so filter it out here rather than thread it through every count.
const surfaceKeys = (badges) =>
  Object.keys(badges).filter((k) => k !== AGGREGATE_BADGE_FILENAME);

describe('generateBadges — message + color mapping', () => {
  it('a passing, fresh surface -> message "pass", color "brightgreen"', () => {
    const index = {
      'mcp-tool-shop-org/shipcheck': {
        cli: { verified: 'pass', verification_status: 'accepted', finished_at: daysBefore(2) },
      },
    };
    const badges = generateBadges(index, { now: NOW });
    const [badge] = Object.values(badges);
    assert.equal(badge.schemaVersion, 1);
    assert.equal(badge.label, 'dogfood');
    assert.equal(badge.message, 'pass');
    assert.equal(badge.color, 'brightgreen');
  });

  it('a failing, fresh surface -> message "fail", color "red"', () => {
    const index = {
      'org/repo': {
        cli: { verified: 'fail', verification_status: 'accepted', finished_at: daysBefore(2) },
      },
    };
    const [badge] = Object.values(generateBadges(index, { now: NOW }));
    assert.equal(badge.message, 'fail');
    assert.equal(badge.color, 'red');
  });

  it('a passing but STALE surface (old finished_at) -> message "stale", color "orange"', () => {
    const index = {
      'org/repo': {
        cli: { verified: 'pass', verification_status: 'accepted', finished_at: daysBefore(60) },
      },
    };
    const [badge] = Object.values(generateBadges(index, { now: NOW }));
    assert.equal(badge.message, 'stale', 'old finished_at must override pass with stale');
    assert.equal(badge.color, 'orange');
  });

  it('staleness uses a configurable window (default 30 days)', () => {
    const index = {
      'org/repo': {
        cli: { verified: 'pass', verification_status: 'accepted', finished_at: daysBefore(20) },
      },
    };
    // 20 days old: fresh under the 30-day default, stale under a 14-day window.
    const fresh = Object.values(generateBadges(index, { now: NOW }))[0];
    assert.equal(fresh.message, 'pass');
    const stale = Object.values(generateBadges(index, { now: NOW, windowDays: 14 }))[0];
    assert.equal(stale.message, 'stale');
  });

  it('an unparseable finished_at is treated as stale (cannot prove freshness)', () => {
    const index = {
      'org/repo': {
        cli: { verified: 'pass', verification_status: 'accepted', finished_at: 'not-a-date' },
      },
    };
    const [badge] = Object.values(generateBadges(index, { now: NOW }));
    assert.equal(badge.message, 'stale');
    assert.equal(badge.color, 'orange');
  });
});

describe('generateBadges — filenames', () => {
  it('keys each badge by <org>--<repo>--<surface>.json, posixified + sanitized', () => {
    const index = {
      'mcp-tool-shop-org/shipcheck': {
        cli: { verified: 'pass', verification_status: 'accepted', finished_at: daysBefore(1) },
      },
    };
    const names = surfaceKeys(generateBadges(index, { now: NOW }));
    assert.deepEqual(names, ['mcp-tool-shop-org--shipcheck--cli.json']);
    for (const n of names) {
      assert.ok(!n.includes('\\'), `filename must be forward-slash/separator-free, got: ${n}`);
      assert.ok(!n.includes('/'), `org/repo slash must be sanitized out of the filename, got: ${n}`);
    }
  });

  it('sanitizes filesystem-hostile characters in repo/surface names', () => {
    const index = {
      'weird/repo name': {
        'cli:thing': { verified: 'pass', verification_status: 'accepted', finished_at: daysBefore(1) },
      },
    };
    const names = surfaceKeys(generateBadges(index, { now: NOW }));
    assert.equal(names.length, 1);
    const name = names[0];
    // No path separators, no colons, no spaces — safe for any filesystem.
    assert.ok(!/[\\/:\s]/.test(name.replace(/\.json$/, '')),
      `filename should be sanitized, got: ${name}`);
    assert.ok(name.endsWith('.json'));
  });

  it('emits one badge per surface across multiple repos', () => {
    const index = {
      'org/a': {
        cli: { verified: 'pass', verification_status: 'accepted', finished_at: daysBefore(1) },
        web: { verified: 'fail', verification_status: 'accepted', finished_at: daysBefore(1) },
      },
      'org/b': {
        cli: { verified: 'pass', verification_status: 'accepted', finished_at: daysBefore(1) },
      },
    };
    const badges = generateBadges(index, { now: NOW });
    assert.equal(surfaceKeys(badges).length, 3);
    assert.equal(badges['org--a--web.json'].message, 'fail');
  });

  it('handles an empty index without crashing', () => {
    assert.deepEqual(generateBadges({}, { now: NOW }), {});
  });
});
