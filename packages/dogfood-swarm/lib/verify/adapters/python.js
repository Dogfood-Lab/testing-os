/**
 * python.js — Python verification adapter.
 *
 * Probe: looks for pyproject.toml, setup.py, requirements.txt, ruff.toml.
 * Commands: ruff check, pytest, mypy (optional).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runSteps } from '../runner.js';
import { readBoundedText, BoundedJsonError } from '../../bounded-json-read.js';

// d4-swarm-core-004 (Stage A): the target-repo manifest is UNTRUSTED — we probe
// arbitrary external repos. A hostile or accidentally-bloated multi-GB
// pyproject.toml would otherwise be read entirely into the coordinator's memory
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
// with .includes() string scans, not JSON.parse, so a skip is simply unset
// evidence, never buffered); any other error (missing file, EISDIR, ...)
// propagates to the caller's manifestUnreadable signal below, same as before
// — BoundedJsonError surfaces the underlying fs `.code` so that signal stays
// just as specific as the raw readFileSync error it replaces.
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

  if (existsSync(join(repoPath, 'pyproject.toml'))) {
    score += 50;
    evidence.pyprojectToml = true;
    try {
      const content = readBoundedManifest(join(repoPath, 'pyproject.toml'));
      if (content !== null) {
        evidence.hasRuff = content.includes('[tool.ruff]') || content.includes('ruff');
        evidence.hasPytest = content.includes('pytest') || content.includes('[tool.pytest');
        evidence.hasMypy = content.includes('mypy');
        if (evidence.hasPytest) score += 20;
      }
    } catch (e) {
      // DS-PROAC-02: mirror the node sibling — a present-but-unreadable
      // pyproject.toml must produce a non-silent signal (evidence flag +
      // named reason), not the same `reason` a healthy project gets. The
      // swallow stays non-fatal; it just stops being silent.
      evidence.manifestUnreadable = true;
      evidence.manifestUnreadableKind = e.code || e.name || 'ReadError';
    }
  }

  if (existsSync(join(repoPath, 'setup.py'))) {
    score += 30;
    evidence.setupPy = true;
  }

  if (existsSync(join(repoPath, 'requirements.txt'))) {
    score += 10;
    evidence.requirements = true;
  }

  if (existsSync(join(repoPath, 'ruff.toml'))) {
    score += 10;
    evidence.ruffToml = true;
    evidence.hasRuff = true;
  }

  // Check for tests/ directory
  if (existsSync(join(repoPath, 'tests'))) {
    evidence.testsDir = true;
    score += 10;
  }

  // Check for venv
  if (existsSync(join(repoPath, '.venv')) || existsSync(join(repoPath, 'venv'))) {
    evidence.venv = true;
  }

  const reason = evidence.manifestUnreadable
    ? `pyproject.toml present but unreadable (${evidence.manifestUnreadableKind}) — fix the manifest to verify this repo`
    : score > 0
      ? `Python project (${[evidence.pyprojectToml && 'pyproject', evidence.setupPy && 'setup.py'].filter(Boolean).join(', ')})`
      : 'No Python project markers found';

  return { score: Math.min(score, 100), reason, evidence };
}

function commands(overrides = {}) {
  const steps = [];

  // Lint
  steps.push(overrides.lint ?? {
    name: 'lint',
    cmd: 'ruff',
    args: ['check', '.'],
    optional: true,
  });

  // Typecheck
  steps.push(overrides.typecheck ?? {
    name: 'typecheck',
    cmd: 'mypy',
    args: ['.'],
    optional: true,
  });

  // Test
  steps.push(overrides.test ?? {
    name: 'test',
    cmd: 'pytest',
    args: ['-v'],
  });

  return steps.filter(Boolean);
}

function run(repoPath, overrides) {
  const steps = commands(overrides);
  return runSteps(repoPath, steps, { continueOnError: true });
}

export const pythonAdapter = { probe, commands, run };
