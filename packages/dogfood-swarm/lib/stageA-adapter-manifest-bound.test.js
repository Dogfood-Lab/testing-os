/**
 * stageA-adapter-manifest-bound.test.js
 *
 * d4-swarm-core-004 (Stage A amend wave):
 *
 * The python and rust verification probes read an UNTRUSTED target-repo
 * manifest with a bare unbounded readFileSync — python.js reads pyproject.toml,
 * rust.js reads Cargo.toml, both via `readFileSync(path,'utf-8')` with no size
 * gate. This is the same trust boundary the node adapter hardened (node.js
 * routes target-repo package.json through readBoundedJson with the 50 MB cap,
 * "because we audit arbitrary external repos"). The TOML siblings were never
 * lifted, so a hostile or bloated multi-GB manifest would be read entirely into
 * the coordinator's memory during an otherwise cheap probe.
 *
 * Both halves of the invariant:
 *   1. A normal-sized manifest is still read and its evidence flags populated
 *      (the size cap must not regress the happy path).
 *   2. An OVERSIZED manifest is NOT read into memory — the size-dependent
 *      evidence fields are absent (the bounded read skipped it) and the probe
 *      returns cleanly rather than buffering the whole file.
 *
 * Real fixtures in a TEST_ROOT temp dir — never the real records/indexes tree.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pythonAdapter } from './verify/adapters/python.js';
import { rustAdapter } from './verify/adapters/rust.js';
// The adapter manifest reads share the bounded-json constant so the three
// adapter manifest reads (node package.json, python pyproject.toml, rust
// Cargo.toml) stay in lockstep on one cap.
import { MAX_AGENT_OUTPUT_BYTES as MANIFEST_READ_MAX_BYTES } from './bounded-json-read.js';

let TEST_ROOT;
beforeEach(() => { TEST_ROOT = mkdtempSync(join(tmpdir(), 'stageA-adapter-bound-')); });
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

function bigToml(headerLine) {
  // headerLine + filler that pushes the file just past the cap. We never assert
  // on its contents being parsed (the gate must skip it), so the filler is a
  // fast single-allocation pad buffer rather than a repeated-string build.
  const header = Buffer.from(headerLine + '\n# ', 'utf-8');
  const pad = Buffer.alloc(MANIFEST_READ_MAX_BYTES + 4096 - header.length, 0x70); // 'p'
  return Buffer.concat([header, pad]);
}

describe('python adapter probe — d4-swarm-core-004 bounded manifest read', () => {
  it('reads a normal-sized pyproject.toml and populates evidence (happy path intact)', () => {
    writeFileSync(
      join(TEST_ROOT, 'pyproject.toml'),
      '[tool.ruff]\n[tool.pytest.ini_options]\n',
    );
    const { evidence, score } = pythonAdapter.probe(TEST_ROOT);
    assert.equal(evidence.pyprojectToml, true);
    assert.equal(evidence.hasRuff, true, 'normal manifest must be scanned');
    assert.equal(evidence.hasPytest, true);
    assert.ok(score >= 50);
  });

  it('does NOT read an oversized pyproject.toml into memory (bounded out)', () => {
    const p = join(TEST_ROOT, 'pyproject.toml');
    writeFileSync(p, bigToml('[tool.ruff]'));
    assert.ok(statSync(p).size > MANIFEST_READ_MAX_BYTES,
      'fixture must exceed the cap to exercise the gate');

    const { evidence, score } = pythonAdapter.probe(TEST_ROOT);
    // The marker existsSync still fires (cheap) — but the size-dependent scan
    // must have been skipped, so the content-derived flags are NOT set.
    assert.equal(evidence.pyprojectToml, true,
      'existsSync marker still counts (no file read)');
    assert.notEqual(evidence.hasRuff, true,
      'oversized manifest must NOT be scanned — hasRuff stays unset');
    assert.equal(evidence.hasPytest, undefined,
      'oversized manifest must NOT be scanned — hasPytest stays unset');
    // Probe returns cleanly (no throw, no OOM) with the marker-only score.
    assert.ok(typeof score === 'number');
  });
});

describe('rust adapter probe — d4-swarm-core-004 bounded manifest read', () => {
  it('reads a normal-sized Cargo.toml and populates evidence (happy path intact)', () => {
    mkdirSync(join(TEST_ROOT, 'src'), { recursive: true });
    writeFileSync(
      join(TEST_ROOT, 'Cargo.toml'),
      '[package]\nname = "mycrate"\n',
    );
    const { evidence } = rustAdapter.probe(TEST_ROOT);
    assert.equal(evidence.cargoToml, true);
    assert.equal(evidence.name, 'mycrate', 'normal manifest must be scanned');
  });

  it('does NOT read an oversized Cargo.toml into memory (bounded out)', () => {
    const p = join(TEST_ROOT, 'Cargo.toml');
    writeFileSync(p, bigToml('[package]\nname = "huge"'));
    assert.ok(statSync(p).size > MANIFEST_READ_MAX_BYTES);

    const { evidence } = rustAdapter.probe(TEST_ROOT);
    assert.equal(evidence.cargoToml, true,
      'existsSync marker still counts (no file read)');
    assert.equal(evidence.name, undefined,
      'oversized manifest must NOT be scanned — name stays unset');
    assert.equal(evidence.isWorkspace, undefined,
      'oversized manifest must NOT be scanned — isWorkspace stays unset');
  });
});
