/**
 * rust.js — Rust verification adapter.
 *
 * Probe: looks for Cargo.toml, src/, target/.
 * Commands: cargo check, cargo clippy, cargo test, cargo build.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runSteps } from '../runner.js';
import { MAX_AGENT_OUTPUT_BYTES } from '../../bounded-json-read.js';

// d4-swarm-core-004 (Stage A): the target-repo manifest is UNTRUSTED — we probe
// arbitrary external repos. A hostile or accidentally-bloated multi-GB
// Cargo.toml would otherwise be read entirely into the coordinator's memory by
// a bare readFileSync during an otherwise cheap probe. The node sibling already
// bounds its package.json read (node.js routes through readBoundedJson with the
// same 50 MB cap); this lifts the TOML sibling into lockstep. A statSync size
// check is sufficient here because the manifest is consumed with .match() /
// .includes() string scans, not a JSON.parse — so an oversized file is simply
// skipped (size-dependent evidence stays unset), never buffered.
function readBoundedManifest(filePath) {
  if (statSync(filePath).size > MAX_AGENT_OUTPUT_BYTES) {
    return null; // oversized untrusted manifest — skip the read, do not buffer
  }
  return readFileSync(filePath, 'utf-8');
}

function probe(repoPath) {
  const evidence = {};
  let score = 0;

  const cargoPath = join(repoPath, 'Cargo.toml');
  if (existsSync(cargoPath)) {
    score += 60;
    evidence.cargoToml = true;
    try {
      const content = readBoundedManifest(cargoPath);
      if (content !== null) {
        const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
        if (nameMatch) evidence.name = nameMatch[1];
        evidence.isWorkspace = content.includes('[workspace]');
      }
    } catch { /* */ }
  }

  if (existsSync(join(repoPath, 'src'))) {
    score += 20;
    evidence.srcDir = true;
  }

  if (existsSync(join(repoPath, 'target'))) {
    evidence.targetDir = true;
    score += 10;
  }

  if (existsSync(join(repoPath, 'clippy.toml')) || existsSync(join(repoPath, '.cargo/config.toml'))) {
    evidence.cargoConfig = true;
    score += 10;
  }

  const reason = score > 0
    ? `Rust project (${evidence.name || 'unnamed'}${evidence.isWorkspace ? ', workspace' : ''})`
    : 'No Cargo.toml found';

  return { score: Math.min(score, 100), reason, evidence };
}

function commands(overrides = {}) {
  const steps = [];

  // Check (fast compile check)
  steps.push(overrides.check ?? {
    name: 'check',
    cmd: 'cargo',
    args: ['check'],
  });

  // Clippy (lint)
  steps.push(overrides.lint ?? {
    name: 'lint',
    cmd: 'cargo',
    args: ['clippy', '--', '-D', 'warnings'],
    optional: true,
  });

  // Test
  steps.push(overrides.test ?? {
    name: 'test',
    cmd: 'cargo',
    args: ['test'],
  });

  // Build (optional — cargo check is usually enough for verification)
  steps.push(overrides.build ?? {
    name: 'build',
    cmd: 'cargo',
    args: ['build'],
    optional: true,
  });

  return steps.filter(Boolean);
}

function run(repoPath, overrides) {
  const steps = commands(overrides);
  return runSteps(repoPath, steps, { continueOnError: true });
}

export const rustAdapter = { probe, commands, run };
