/**
 * node.js — Node/TypeScript verification adapter.
 *
 * Probe: looks for package.json, tsconfig.json, node_modules.
 * Commands: npm run lint, tsc --noEmit, npm test, npm run build.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runSteps } from '../runner.js';
import { readBoundedJson } from '../../bounded-json-read.js';

function probe(repoPath) {
  const evidence = {};
  let score = 0;

  const pkgPath = join(repoPath, 'package.json');
  if (existsSync(pkgPath)) {
    score += 50;
    evidence.packageJson = true;
    try {
      // F-H5 (Wave A1 D3): UNTRUSTED target-repo package.json (the most
      // exotic input — we audit arbitrary external repos). A malicious or
      // accidentally bloated package.json would otherwise hang the probe's
      // JSON.parse. The size gate caps reads at 50 MB by default; any sane
      // package.json is <1 MB.
      const pkg = readBoundedJson(pkgPath);
      evidence.scripts = Object.keys(pkg.scripts || {});
      evidence.hasTest = !!pkg.scripts?.test;
      evidence.hasLint = !!(pkg.scripts?.lint || pkg.scripts?.['lint:check']);
      evidence.hasBuild = !!pkg.scripts?.build;
      evidence.name = pkg.name;
      if (evidence.hasTest) score += 20;
    } catch { /* corrupt or oversized package.json */ }
  }

  const tsconfigPath = join(repoPath, 'tsconfig.json');
  if (existsSync(tsconfigPath)) {
    score += 20;
    evidence.tsconfig = true;
  }

  if (existsSync(join(repoPath, 'node_modules'))) {
    evidence.nodeModules = true;
    score += 10;
  }

  // Check for common TS/JS markers
  if (existsSync(join(repoPath, 'biome.json')) || existsSync(join(repoPath, '.eslintrc.json'))) {
    evidence.linter = true;
  }

  const reason = score > 0
    ? `Node/TS project (${evidence.name || 'unnamed'}, ${evidence.scripts?.length || 0} scripts)`
    : 'No package.json found';

  return { score: Math.min(score, 100), reason, evidence };
}

function commands(overrides = {}) {
  const steps = [];

  // Lint
  steps.push(overrides.lint ?? {
    name: 'lint',
    cmd: 'npm',
    args: ['run', 'lint', '--if-present'],
    optional: true,
  });

  // Typecheck
  steps.push(overrides.typecheck ?? {
    name: 'typecheck',
    cmd: 'npx',
    args: ['tsc', '--noEmit'],
    optional: true,
  });

  // Test
  steps.push(overrides.test ?? {
    name: 'test',
    cmd: 'npm',
    args: ['test', '--if-present'],
  });

  // Build (optional — not all repos need it)
  steps.push(overrides.build ?? {
    name: 'build',
    cmd: 'npm',
    args: ['run', 'build', '--if-present'],
    optional: true,
  });

  return steps.filter(Boolean);
}

function run(repoPath, overrides) {
  const steps = commands(overrides);
  return runSteps(repoPath, steps, { continueOnError: true });
}

export const nodeAdapter = { probe, commands, run };
