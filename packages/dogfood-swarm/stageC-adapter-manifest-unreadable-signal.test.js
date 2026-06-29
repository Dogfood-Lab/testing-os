/**
 * stageC-adapter-manifest-unreadable-signal.test.js
 *
 * DS-PROAC-02 (LOW, Stage C amend — humanization lens):
 *
 * All three verify probes already DETECT a manifest's presence (existsSync)
 * and then attempt to read/parse it for evidence flags. When that read or
 * parse throws — a present-but-corrupt package.json, an unparseable
 * pyproject.toml, an unreadable Cargo.toml — the catch swallowed the error
 * silently. The probe reported the same `reason` as a perfectly healthy
 * project, so an operator staring at a misclassified repo had zero signal
 * that the manifest was the problem.
 *
 * The humanization fix: a present-but-unreadable manifest must produce a
 * NON-SILENT signal — an `evidence.manifestUnreadable` flag (with the error
 * kind) AND a `reason` string that names the degradation, so the operator
 * can FIX the actual problem (the broken manifest) instead of chasing a
 * phantom misclassification.
 *
 * The swallow stays NON-FATAL (the probe must still return cleanly with its
 * marker-only score) — it just stops being SILENT.
 *
 * Real fixtures in a TEST_ROOT temp dir — never the real records/indexes tree.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeAdapter } from './lib/verify/adapters/node.js';
import { pythonAdapter } from './lib/verify/adapters/python.js';
import { rustAdapter } from './lib/verify/adapters/rust.js';

let TEST_ROOT;
beforeEach(() => { TEST_ROOT = mkdtempSync(join(tmpdir(), 'stageC-manifest-unreadable-')); });
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

describe('node adapter probe — DS-PROAC-02 present-but-unreadable manifest is non-silent', () => {
  it('a corrupt package.json sets manifestUnreadable + names it in reason', () => {
    writeFileSync(join(TEST_ROOT, 'package.json'), '{ this is : not, valid json ]');

    const { evidence, reason } = nodeAdapter.probe(TEST_ROOT);

    assert.equal(evidence.packageJson, true, 'existsSync marker still fires');
    assert.equal(evidence.manifestUnreadable, true,
      'corrupt manifest must raise a non-silent evidence flag');
    assert.ok(evidence.manifestUnreadableKind,
      'the error kind must be recorded for the operator');
    assert.match(reason, /unparseable|unreadable/i,
      'reason must tell the operator the manifest is the problem');
  });

  it('a well-formed package.json does NOT raise the unreadable flag (happy path intact)', () => {
    writeFileSync(
      join(TEST_ROOT, 'package.json'),
      JSON.stringify({ name: 'ok-pkg', scripts: { test: 'node --test' } }),
    );
    const { evidence, reason } = nodeAdapter.probe(TEST_ROOT);
    assert.equal(evidence.name, 'ok-pkg');
    assert.notEqual(evidence.manifestUnreadable, true);
    assert.doesNotMatch(reason, /unparseable|unreadable/i);
  });
});

describe('python adapter probe — DS-PROAC-02 present-but-unreadable manifest is non-silent', () => {
  it('an unreadable pyproject.toml (path is a directory) sets manifestUnreadable + names it in reason', () => {
    // A directory at the manifest path makes readBoundedManifest's statSync
    // succeed but readFileSync throw EISDIR — a present-but-unreadable manifest.
    mkdirSync(join(TEST_ROOT, 'pyproject.toml'));

    const { evidence, reason } = pythonAdapter.probe(TEST_ROOT);

    assert.equal(evidence.pyprojectToml, true, 'existsSync marker still fires');
    assert.equal(evidence.manifestUnreadable, true,
      'unreadable manifest must raise a non-silent evidence flag');
    assert.ok(evidence.manifestUnreadableKind);
    assert.match(reason, /unreadable|unparseable/i);
  });

  it('a well-formed pyproject.toml does NOT raise the unreadable flag (happy path intact)', () => {
    writeFileSync(
      join(TEST_ROOT, 'pyproject.toml'),
      '[tool.ruff]\n[tool.pytest.ini_options]\n',
    );
    const { evidence, reason } = pythonAdapter.probe(TEST_ROOT);
    assert.equal(evidence.hasRuff, true);
    assert.notEqual(evidence.manifestUnreadable, true);
    assert.doesNotMatch(reason, /unreadable|unparseable/i);
  });
});

describe('rust adapter probe — DS-PROAC-02 present-but-unreadable manifest is non-silent', () => {
  it('an unreadable Cargo.toml (path is a directory) sets manifestUnreadable + names it in reason', () => {
    mkdirSync(join(TEST_ROOT, 'Cargo.toml'));

    const { evidence, reason } = rustAdapter.probe(TEST_ROOT);

    assert.equal(evidence.cargoToml, true, 'existsSync marker still fires');
    assert.equal(evidence.manifestUnreadable, true,
      'unreadable manifest must raise a non-silent evidence flag');
    assert.ok(evidence.manifestUnreadableKind);
    assert.match(reason, /unreadable|unparseable/i);
  });

  it('a well-formed Cargo.toml does NOT raise the unreadable flag (happy path intact)', () => {
    mkdirSync(join(TEST_ROOT, 'src'), { recursive: true });
    writeFileSync(join(TEST_ROOT, 'Cargo.toml'), '[package]\nname = "ok-crate"\n');
    const { evidence, reason } = rustAdapter.probe(TEST_ROOT);
    assert.equal(evidence.name, 'ok-crate');
    assert.notEqual(evidence.manifestUnreadable, true);
    assert.doesNotMatch(reason, /unreadable|unparseable/i);
  });
});
