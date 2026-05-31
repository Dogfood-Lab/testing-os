/**
 * safe-yaml-load.test.js — invariants for the structured-skip loader helper.
 *
 * The full invariant being proved: when a directory contains BOTH good and
 * torn files, the loader returns the good entries AND a structured skip
 * record naming each torn file. No silent disappearance. This is the
 * counter-test to the F-721047-010 silent-loader family.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import {
  loadYamlFile,
  loadJsonFile,
  loadYamlDir,
  loadJsonDir,
} from './safe-yaml-load.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_safe_yaml_load__');

function setup() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  mkdirSync(TEST_ROOT, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
}

// ============================================================
// loadYamlFile
// ============================================================

describe('loadYamlFile', () => {
  before(setup);
  after(teardown);

  it('returns {data, error: null} for valid YAML', () => {
    const path = resolve(TEST_ROOT, 'good.yaml');
    writeFileSync(path, 'name: ok\nvalue: 42\n', 'utf-8');
    const { data, error } = loadYamlFile(path);
    assert.equal(error, null);
    assert.deepEqual(data, { name: 'ok', value: 42 });
  });

  it('returns {data: null, error} for torn YAML — never throws', () => {
    const path = resolve(TEST_ROOT, 'torn.yaml');
    writeFileSync(path, 'this: : is :: invalid yaml\n  : :\n', 'utf-8');
    const { data, error } = loadYamlFile(path);
    assert.equal(data, null);
    assert.ok(error, 'expected a structured error');
    assert.match(error, /YAML parse error/);
  });

  it('returns {data: null, error} for missing file — never throws', () => {
    const { data, error } = loadYamlFile(resolve(TEST_ROOT, 'missing.yaml'));
    assert.equal(data, null);
    assert.ok(error);
    assert.match(error, /Read error/);
  });
});

// ============================================================
// loadJsonFile
// ============================================================

describe('loadJsonFile', () => {
  before(setup);
  after(teardown);

  it('returns {data, error: null} for valid JSON', () => {
    const path = resolve(TEST_ROOT, 'good.json');
    writeFileSync(path, '{"name":"ok","value":42}', 'utf-8');
    const { data, error } = loadJsonFile(path);
    assert.equal(error, null);
    assert.deepEqual(data, { name: 'ok', value: 42 });
  });

  it('returns {data: null, error} for torn JSON — never throws', () => {
    const path = resolve(TEST_ROOT, 'torn.json');
    writeFileSync(path, '{this is not json', 'utf-8');
    const { data, error } = loadJsonFile(path);
    assert.equal(data, null);
    assert.match(error, /JSON parse error/);
  });
});

// ============================================================
// loadYamlDir — the load-bearing invariant
// ============================================================

describe('loadYamlDir — structured skip vs silent disappearance', () => {
  before(setup);
  after(teardown);

  it('returns BOTH good entries AND structured skip records for torn files', () => {
    const dir = resolve(TEST_ROOT, 'mixed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'a-good.yaml'), 'name: a\n', 'utf-8');
    writeFileSync(resolve(dir, 'b-torn.yaml'), 'this: : invalid ::\n  : :\n', 'utf-8');
    writeFileSync(resolve(dir, 'c-good.yaml'), 'name: c\n', 'utf-8');

    const { entries, skipped } = loadYamlDir(dir);

    // Good entries surface — both of them.
    const names = entries.map(e => e.data?.name).sort();
    assert.deepEqual(names, ['a', 'c'], 'good entries must surface');

    // Torn file does NOT silently disappear — it shows up in skipped.
    assert.equal(skipped.length, 1, 'expected exactly one structured skip');
    assert.match(skipped[0].path, /b-torn\.yaml$/);
    assert.match(skipped[0].error, /YAML parse error/);
  });

  it('recurses into subdirectories by default', () => {
    const dir = resolve(TEST_ROOT, 'tree');
    mkdirSync(resolve(dir, 'sub'), { recursive: true });
    writeFileSync(resolve(dir, 'top.yaml'), 'level: top\n', 'utf-8');
    writeFileSync(resolve(dir, 'sub', 'nested.yaml'), 'level: nested\n', 'utf-8');

    const { entries, skipped } = loadYamlDir(dir);
    const levels = entries.map(e => e.data?.level).sort();
    assert.deepEqual(levels, ['nested', 'top']);
    assert.equal(skipped.length, 0);
  });

  it('returns empty result when directory does not exist (not an error)', () => {
    const { entries, skipped } = loadYamlDir(resolve(TEST_ROOT, 'no-such-dir'));
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, []);
  });

  it('ignores non-yaml extensions', () => {
    const dir = resolve(TEST_ROOT, 'mixed-ext');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'kept.yaml'), 'kept: true\n', 'utf-8');
    writeFileSync(resolve(dir, 'ignored.json'), '{"ignored":true}', 'utf-8');
    writeFileSync(resolve(dir, 'README.md'), '# nope', 'utf-8');

    const { entries, skipped } = loadYamlDir(dir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data.kept, true);
    assert.equal(skipped.length, 0);
  });
});

describe('loadJsonDir — structured skip vs silent disappearance', () => {
  before(setup);
  after(teardown);

  it('returns BOTH good entries AND structured skip records for torn JSON', () => {
    const dir = resolve(TEST_ROOT, 'mixed-json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'a-good.json'), '{"id":"a"}', 'utf-8');
    writeFileSync(resolve(dir, 'b-torn.json'), '{this is not json', 'utf-8');
    writeFileSync(resolve(dir, 'c-good.json'), '{"id":"c"}', 'utf-8');

    const { entries, skipped } = loadJsonDir(dir);

    const ids = entries.map(e => e.data?.id).sort();
    assert.deepEqual(ids, ['a', 'c']);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].path, /b-torn\.json$/);
    assert.match(skipped[0].error, /JSON parse error/);
  });
});
