/**
 * F-d433f8a4 — dogfood-report --status must refuse absolute / protocol-relative
 * / `..` entry.path values and keep resolved fetches under records/.
 *
 * Pre-fix `new URL(relPath, base)` trusted the served index path as-is, so a
 * poisoned latest-by-repo.json could send consumer CI to an attacker origin
 * when surfacing rejection_reasons for a non-pass verified entry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runStatus,
  assertSafeRecordPath,
  DEFAULT_INDEX_BASE,
} from '@dogfood-lab/report/status.js';

const REPO = 'acme/widgets';
const FRESH_ISO = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

function indexWithPath(path) {
  return {
    [REPO]: {
      cli: {
        run_id: 'widgets-123-1',
        verified: 'fail',
        verification_status: 'accepted',
        finished_at: FRESH_ISO,
        path,
      },
    },
  };
}

function trackingFetch(files) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [name, body] of Object.entries(files)) {
      if (url.endsWith(name) || url === name || url.includes(name)) {
        return {
          ok: true,
          status: 200,
          async json() { return body; },
        };
      }
    }
    return { ok: false, status: 404, async json() { throw new Error('not json'); } };
  };
  return { fetchImpl, calls };
}

describe('F-d433f8a4: assertSafeRecordPath refuses off-base entry.path', () => {
  const base = DEFAULT_INDEX_BASE;

  it('ACCEPTS a normal repo-relative records/ path', () => {
    assert.doesNotThrow(() =>
      assertSafeRecordPath('records/acme/widgets/2026/06/29/run-widgets-123-1.json', base)
    );
  });

  it('REJECTS an absolute https URL', () => {
    assert.throws(
      () => assertSafeRecordPath('https://evil.example/x.json', base),
      (err) => err && err.code === 'INDEX_MALFORMED'
    );
  });

  it('REJECTS a protocol-relative URL', () => {
    assert.throws(
      () => assertSafeRecordPath('//evil.example/x.json', base),
      (err) => err && err.code === 'INDEX_MALFORMED'
    );
  });

  it('REJECTS a path containing ..', () => {
    assert.throws(
      () => assertSafeRecordPath('records/../indexes/latest-by-repo.json', base),
      (err) => err && err.code === 'INDEX_MALFORMED'
    );
  });

  it('REJECTS a rooted absolute path that would leave the repo prefix', () => {
    assert.throws(
      () => assertSafeRecordPath('/etc/passwd', base),
      (err) => err && err.code === 'INDEX_MALFORMED'
    );
  });

  it('REJECTS a relative path that does not stay under records/', () => {
    assert.throws(
      () => assertSafeRecordPath('indexes/latest-by-repo.json', base),
      (err) => err && err.code === 'INDEX_MALFORMED'
    );
  });
});

describe('F-d433f8a4: runStatus does not fetch off-base entry.path', () => {
  it('throws INDEX_MALFORMED and never fetches an absolute evil URL', async () => {
    const evil = 'https://evil.example/x.json';
    const { fetchImpl, calls } = trackingFetch({
      'latest-by-repo.json': indexWithPath(evil),
    });

    await assert.rejects(
      () => runStatus({ repo: REPO, fetchImpl }),
      (err) => err && err.code === 'INDEX_MALFORMED'
    );
    assert.ok(
      !calls.some(u => u.includes('evil.example')),
      `must not fetch attacker URL; calls=${JSON.stringify(calls)}`
    );
  });

  it('still fetches a safe records/ path for rejection_reasons detail', async () => {
    const safePath = 'records/acme/widgets/2026/06/29/run-widgets-123-1.json';
    const servedRecord = {
      run_id: 'widgets-123-1',
      verification: { rejection_reasons: ['policy: downgraded'] },
    };
    const { fetchImpl, calls } = trackingFetch({
      'latest-by-repo.json': indexWithPath(safePath),
      'run-widgets-123-1.json': servedRecord,
    });

    const result = await runStatus({ repo: REPO, fetchImpl });
    assert.notEqual(result.exitCode, 0);
    assert.ok(calls.some(u => u.includes('records/acme/widgets')));
    assert.match(result.message + result.reasons.join(' '), /downgraded/);
  });
});
