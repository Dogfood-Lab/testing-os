/**
 * Stage C B-001 — torn-file hint on the artifact not-found path.
 *
 * `findArtifactById` / `getArtifactReviewQueue` / `reviewArtifact` load
 * patterns/recommendations/doctrine through the with-skips loaders but
 * historically discarded `skipped[]`. A torn artifact YAML for the very id
 * the operator asked to accept/show therefore produced a bare
 * "<type> not found: <id>" with no hint that a file was unreadable — the
 * exact opposite of the derive CLI, which prints "N pattern(s) skipped
 * (torn/unreadable)". This proves the not-found path now names torn files on
 * stderr so a torn file can never silently masquerade as an absent id.
 *
 * TEST_ROOT temp dirs only — never the real artifact tree.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import { findArtifactById, getArtifactReviewQueue, reviewArtifact } from './review-artifacts.js';
import { resetSeenArtifactWrites } from '../synthesis/write-artifacts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_b001_torn__');

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'patterns'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'recommendations'), { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'doctrine'), { recursive: true });
  resetSeenArtifactWrites(TEST_ROOT);
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  resetSeenArtifactWrites(TEST_ROOT);
}

/** Write a syntactically-broken YAML so loadYamlDir surfaces it in skipped[]. */
function writeTornArtifact(dir, name) {
  const d = resolve(TEST_ROOT, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${name}.yaml`), 'pattern_id: "unterminated\n  : : :\n', 'utf-8');
}

/** Capture everything written to process.stderr during `fn`. */
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += String(chunk);
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

describe('Stage C B-001: torn artifact YAML surfaces a hint on not-found', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('findArtifactById names the torn file on stderr when the id is absent', () => {
    writeTornArtifact('patterns', 'dpat-torn');

    let found;
    const err = captureStderr(() => {
      found = findArtifactById(TEST_ROOT, 'pattern', 'dpat-wanted');
    });

    assert.equal(found, null, 'a torn file is not a match');
    assert.match(err, /torn|unreadable|skipped/i, 'must hint at the torn file, not stay silent');
    assert.match(err, /dpat-torn/, 'must name the offending file');
  });

  it('reviewArtifact surfaces the torn-file hint on the not-found path', () => {
    writeTornArtifact('recommendations', 'drec-torn');

    let res;
    const err = captureStderr(() => {
      res = reviewArtifact(TEST_ROOT, { type: 'recommendation', id: 'drec-wanted', action: 'accept', actor: 'mike' });
    });

    assert.equal(res.success, false);
    assert.match(res.error, /not found/i);
    assert.match(err, /torn|unreadable|skipped/i, 'accept on a missing id must hint at torn files');
    assert.match(err, /drec-torn/);
  });

  it('getArtifactReviewQueue surfaces torn files via stderr while still returning clean entries', () => {
    writeTornArtifact('doctrine', 'ddoc-torn');

    let queue;
    const err = captureStderr(() => {
      queue = getArtifactReviewQueue(TEST_ROOT, 'doctrine');
    });

    assert.deepEqual(queue, [], 'no clean candidates, but the queue still returns');
    assert.match(err, /torn|unreadable|skipped/i, 'a torn artifact must not silently shrink the queue');
    assert.match(err, /ddoc-torn/);
  });

  it('a clean tree with no torn files emits no torn-file hint', () => {
    const err = captureStderr(() => {
      findArtifactById(TEST_ROOT, 'pattern', 'dpat-wanted');
    });
    assert.doesNotMatch(err, /torn|unreadable|skipped/i, 'no skips → no noise');
  });
});
