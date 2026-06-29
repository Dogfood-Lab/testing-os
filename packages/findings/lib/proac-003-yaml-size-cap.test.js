/**
 * proac-003-yaml-size-cap.test.js — FIND-PROAC-003.
 *
 * THE INVARIANT: `loadYamlFile` read the whole file and handed it to
 * `yaml.load` with no size guard. A pathologically large (or corrupt-and-huge)
 * YAML file would drive an unbounded parse — a silent resource cliff for every
 * loader in the silent-loader family that delegates here (record/finding/
 * artifact loaders). The structured-skip contract exists precisely so one bad
 * file degrades to a named skip instead of taking the process down.
 *
 * AFTER FIX: `loadYamlFile` stats the file first and, above a generous
 * threshold, returns a structured `{ data: null, error }` skip naming the size
 * and cap — same shape as a parse error — instead of attempting an unbounded
 * parse. Files under the cap parse exactly as before.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import { loadYamlFile, MAX_YAML_BYTES } from './safe-yaml-load.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_proac_003__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

describe('FIND-PROAC-003 — loadYamlFile size cap', () => {
  before(setup);
  after(teardown);

  it('exports a generous (multi-MB) byte cap', () => {
    assert.equal(typeof MAX_YAML_BYTES, 'number');
    assert.ok(MAX_YAML_BYTES >= 1024 * 1024, 'cap should be at least 1 MB (generous)');
  });

  it('returns a structured skip — not an unbounded parse — for an over-threshold file', () => {
    const path = resolve(TEST_ROOT, 'huge.yaml');
    // One byte over the cap. Valid YAML content shape (a long string) so the
    // ONLY reason for a skip is the size guard, not a parse error.
    const body = 'big: "' + 'a'.repeat(MAX_YAML_BYTES) + '"\n';
    writeFileSync(path, body, 'utf-8');

    const { data, error } = loadYamlFile(path);
    assert.equal(data, null, 'over-cap file must not parse');
    assert.ok(error, 'a structured error must be returned');
    assert.match(error, /too large|size|cap|exceeds/i, 'error must name the size problem');
  });

  it('still parses a normal under-cap file unchanged', () => {
    const path = resolve(TEST_ROOT, 'normal.yaml');
    writeFileSync(path, 'name: ok\nvalue: 42\n', 'utf-8');
    const { data, error } = loadYamlFile(path);
    assert.equal(error, null);
    assert.deepEqual(data, { name: 'ok', value: 42 });
  });
});
