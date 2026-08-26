/**
 * F-998fb547 — safe-yaml-load must parse with CORE_SCHEMA so YAML merge keys
 * (`<<`) cannot drive the O(depth) mergeMappings DoS (GHSA-h67p-54hq-rp68 /
 * COORD-001). Size cap alone is not enough: a merge-chain is small by
 * construction. Do NOT bump js-yaml to v5 (Dependabot #50 held).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';

import { loadYamlFile, MAX_YAML_BYTES } from './safe-yaml-load.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = resolve(__dirname, '__test_f_998fb547__');

function buildMergeChainYaml(levels) {
  const lines = ['base0: &base0', '  k0: v0'];
  for (let i = 1; i <= levels; i++) {
    lines.push(`base${i}: &base${i}`);
    lines.push(`  <<: *base${i - 1}`);
    lines.push(`  k${i}: v${i}`);
  }
  lines.push('name: bomb');
  lines.push(`<<: *base${levels}`);
  return lines.join('\n') + '\n';
}

const SIMPLE_MERGE_PROBE = [
  'base: &base',
  '  legit_key: legit_value',
  'name: probe',
  '<<: *base',
  ''
].join('\n');

/** @pins F-998fb547 */
describe('F-998fb547: safe-yaml-load CORE_SCHEMA merge-key seal', () => {
  before(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
    mkdirSync(TEST_ROOT, { recursive: true });
  });
  after(() => {
    if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
  });

  it('PRECONDITION: DEFAULT_SCHEMA still merges `<<` on this js-yaml', () => {
    const simple = yaml.load(SIMPLE_MERGE_PROBE);
    assert.equal(simple.legit_key, 'legit_value',
      'precondition failed: DEFAULT_SCHEMA must still merge — otherwise the CORE_SCHEMA pin is vacuous');
  });

  it('loadYamlFile does not resolve `<<` as a merge key', () => {
    const path = resolve(TEST_ROOT, 'merge-probe.yaml');
    writeFileSync(path, SIMPLE_MERGE_PROBE, 'utf-8');
    const { data, error } = loadYamlFile(path);
    assert.equal(error, null, `unexpected parse error: ${error}`);
    assert.equal(data.legit_key, undefined,
      'merge key resolved — CORE_SCHEMA guard is not firing in loadYamlFile');
    assert.ok(Object.hasOwn(data, '<<'),
      'the `<<` key must survive as a literal property under CORE_SCHEMA');
  });

  it('a small (n=400) merge-chain fixture stays fast under CORE_SCHEMA', () => {
    const bomb = buildMergeChainYaml(400);
    assert.ok(bomb.length < MAX_YAML_BYTES / 10,
      `fixture must stay small by construction; got ${bomb.length} bytes`);
    const path = resolve(TEST_ROOT, 'merge-chain.yaml');
    writeFileSync(path, bomb, 'utf-8');

    const start = process.hrtime.bigint();
    const { data, error } = loadYamlFile(path);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    assert.equal(error, null, `unexpected parse error: ${error}`);
    assert.ok(data && typeof data === 'object');
    assert.equal(data.legit_key, undefined);
    assert.ok(elapsedMs < 1000,
      `merge-key chain took ${elapsedMs.toFixed(1)}ms — expected well under 1000ms under CORE_SCHEMA`);
  });

  it('GREEN: ordinary YAML without merge keys still loads', () => {
    const path = resolve(TEST_ROOT, 'plain.yaml');
    writeFileSync(path, 'name: ok\nvalue: 42\n', 'utf-8');
    const { data, error } = loadYamlFile(path);
    assert.equal(error, null);
    assert.deepEqual(data, { name: 'ok', value: 42 });
  });
});
