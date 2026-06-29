/**
 * python.js — Python verification adapter.
 *
 * Probe: looks for pyproject.toml, setup.py, requirements.txt, ruff.toml.
 * Commands: ruff check, pytest, mypy (optional).
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runSteps } from '../runner.js';
import { MAX_AGENT_OUTPUT_BYTES } from '../../bounded-json-read.js';

// d4-swarm-core-004 (Stage A): the target-repo manifest is UNTRUSTED — we probe
// arbitrary external repos. A hostile or accidentally-bloated multi-GB
// pyproject.toml would otherwise be read entirely into the coordinator's memory
// by a bare readFileSync during an otherwise cheap probe. The node sibling
// already bounds its package.json read (node.js routes through readBoundedJson
// with the same 50 MB cap); this lifts the TOML sibling into lockstep. A
// statSync size check is sufficient here because the manifest is consumed with
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
