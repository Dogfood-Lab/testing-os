/**
 * rust.js — Rust verification adapter.
 *
 * Probe: looks for Cargo.toml, src/, target/.
 * Commands: cargo check, cargo clippy, cargo test, cargo build.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runSteps } from '../runner.js';
import { readBoundedText, BoundedJsonError } from '../../bounded-json-read.js';

// d4-swarm-core-004 (Stage A): the target-repo manifest is UNTRUSTED — we probe
// arbitrary external repos. A hostile or accidentally-bloated multi-GB
// Cargo.toml would otherwise be read entirely into the coordinator's memory
// during an otherwise cheap probe. The node sibling already bounds its
// package.json read (node.js routes through readBoundedJson with the same
// 50 MB cap); this lifts the TOML sibling into lockstep.
//
// F-a89f89f7 (Wave 18, class fix): this used to be a PRIVATE
// statSync-then-readFileSync copy — the exact TOCTOU gap bounded-json-read.js
// exists to close (a file that grows past the cap between the two calls was
// still read in full before any check could reject it), reproduced here
// WORSE (no post-read recheck at all). Now routes through the shared
// readBoundedText, which bounds the READ ITSELF via chunked fs.readSync, not
// just a post-hoc length check. A SIZE_LIMIT error means "oversized
// untrusted manifest" and is swallowed to a skip (the manifest is consumed
// with .match() / .includes() string scans, not JSON.parse, so a skip is
// simply unset evidence, never buffered); any other error (missing file,
// EISDIR, ...) propagates to the caller's manifestUnreadable signal below,
// same as before — F-e0eebfec: BoundedJsonError's stable `.code` is
// BOUNDED_JSON_*; the underlying fs signal lives on `.cause.code`.
function readBoundedManifest(filePath) {
  try {
    return readBoundedText(filePath);
  } catch (e) {
    if (e instanceof BoundedJsonError && e.kind === 'SIZE_LIMIT') {
      return null; // oversized untrusted manifest — skip the read, do not buffer
    }
    throw e;
  }
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
    } catch (e) {
      // DS-PROAC-02: mirror the node sibling — a present-but-unreadable
      // Cargo.toml must produce a non-silent signal (evidence flag + named
      // reason), not the same `reason` a healthy crate gets. The swallow
      // stays non-fatal; it just stops being silent.
      evidence.manifestUnreadable = true;
      evidence.manifestUnreadableKind = e.cause?.code || e.code || e.name || 'ReadError';
    }
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

  const reason = evidence.manifestUnreadable
    ? `Cargo.toml present but unreadable (${evidence.manifestUnreadableKind}) — fix the manifest to verify this repo`
    : score > 0
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
