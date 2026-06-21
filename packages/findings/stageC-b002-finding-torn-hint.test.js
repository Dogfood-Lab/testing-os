/**
 * Stage C B-002 — torn-file hint on the finding not-found path.
 *
 * `findById` (reader.js) walks finding YAML via `parseFinding`, which returns
 * `{ data, error }`. The old loop ignored `error`: a torn finding YAML for the
 * requested id was indistinguishable from the id simply not existing, so the
 * operator got a flat "Finding not found: <id>". The derive CLI already
 * surfaces torn findings ("N finding(s) skipped (torn/unreadable)"); this
 * proves the lookup path now matches that honesty — a torn file is named on
 * stderr rather than masquerading as an absent id.
 *
 * TEST_ROOT temp dirs only — never the real findings tree.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import { findById } from './reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_b002_finding_torn__');

function setupTestRoot() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(resolve(TEST_ROOT, 'findings', 'acme', 'widget'), { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

function writeTornFinding(name) {
  const d = resolve(TEST_ROOT, 'findings', 'acme', 'widget');
  writeFileSync(resolve(d, `${name}.yaml`), 'finding_id: "unterminated\n  : : :\n', 'utf-8');
}

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk) => {
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

describe('Stage C B-002: torn finding YAML surfaces a hint on not-found', () => {
  beforeEach(setupTestRoot);
  after(teardown);

  it('findById names the torn finding file on stderr when the id is absent', () => {
    writeTornFinding('dfind-torn');

    let result;
    const err = captureStderr(() => {
      result = findById(TEST_ROOT, 'dfind-wanted');
    });

    assert.equal(result, null, 'a torn file is not a match');
    assert.match(err, /torn|unreadable|skipped/i, 'must hint at the torn file, not stay silent');
    assert.match(err, /dfind-torn/, 'must name the offending file');
  });

  it('a clean tree with no torn files emits no torn-file hint', () => {
    const err = captureStderr(() => {
      findById(TEST_ROOT, 'dfind-wanted');
    });
    assert.doesNotMatch(err, /torn|unreadable|skipped/i, 'no torn files → no noise');
  });
});
