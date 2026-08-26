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
      // ve-tc-001: detect the repo's OWN test-file type gate. The generic
      // `typecheck` step (commands() below) runs `npx tsc --noEmit` against
      // the ROOT tsconfig, which by convention EXCLUDES test files — so a type
      // error living only in a *.test.ts is invisible to it, and `npm test`
      // (vitest/ts-node) strips types before running. A repo that declares a
      // `typecheck:tests` script (e.g. `tsc -p tsconfig.tests.json`, whose
      // config INCLUDES the test files) is naming exactly where its test-file
      // type gate lives; commands() promotes that into a REQUIRED step.
      // Mirrors hasTest/hasLint/hasBuild.
      evidence.hasTypecheckTests = !!pkg.scripts?.['typecheck:tests'];
      evidence.name = pkg.name;
      if (evidence.hasTest) score += 20;
    } catch (e) {
      // DS-PROAC-02: the swallow stays non-fatal (a corrupt/oversized
      // package.json must not abort the probe), but it must not be SILENT.
      // A present-but-unparseable manifest otherwise reports the identical
      // `reason` as a healthy repo, leaving the operator to chase a phantom
      // misclassification instead of the actual broken manifest. Record a
      // non-silent evidence flag + the error kind so `reason` can name it.
      evidence.manifestUnreadable = true;
      // F-e0eebfec: prefer cause.code (fs/parse) over BoundedJsonError's stable BOUNDED_JSON_* code.
      evidence.manifestUnreadableKind = e.cause?.code || e.code || e.name || 'ParseError';
    }
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

  const reason = evidence.manifestUnreadable
    ? `package.json present but unparseable (${evidence.manifestUnreadableKind}) — fix the manifest to verify this repo`
    : score > 0
      ? `Node/TS project (${evidence.name || 'unnamed'}, ${evidence.scripts?.length || 0} scripts)`
      : 'No package.json found';

  return { score: Math.min(score, 100), reason, evidence };
}

function commands(overrides = {}, evidence = {}) {
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

  // Typecheck (test files) — ve-tc-001.
  //
  // WHY THIS EXISTS (ai-rpg-engine v2.8 incident, 2026-07-22): the generic
  // `typecheck` step above runs `npx tsc --noEmit`, which uses the ROOT
  // tsconfig. That config almost always EXCLUDES test files (it compiles src,
  // not *.test.ts), so a real TS error confined to a test file sails through
  // it — and `npm test` (vitest/ts-node) strips types before running, so the
  // `test` step passes too. The result was a false green: a genuine TS2345 in
  // a new *.test.ts passed `swarm verify` clean, caught only because a
  // concurrent session happened to run the repo's own `typecheck:tests`.
  //
  // A repo that cares about test-file types declares its own gate — by strong
  // convention a `typecheck:tests` npm script (e.g. `tsc -p tsconfig.tests.json`,
  // whose config INCLUDES the test files). When the probe found that script
  // (evidence.hasTypecheckTests) — or an explicit override is supplied — run
  // it, and make it REQUIRED (no `optional` flag): a failing test-file
  // typecheck must block the wave exactly as a failing `test` step does.
  //
  // Requiring it is safe precisely BECAUSE it is script-detected: it is added
  // only when the repo declares it, so it can never false-fail a repo (JS-only,
  // or one with no separate test tsconfig) that has no such gate — the
  // "optional-if-absent" property, achieved by omitting the step entirely when
  // absent rather than by an `optional` flag. Additive: the generic `typecheck`
  // step above is untouched; this catches exactly what that one cannot.
  const typecheckTestsStep = overrides['typecheck:tests'];
  if (typecheckTestsStep || evidence.hasTypecheckTests) {
    steps.push(typecheckTestsStep ?? {
      name: 'typecheck:tests',
      cmd: 'npm',
      args: ['run', 'typecheck:tests'],
    });
  }

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
  // ve-tc-001: probe once up front. The command list is now script-sensitive
  // (commands() adds the REQUIRED typecheck:tests gate only when the repo
  // declares that script), and the no_tests reason-refinement below reuses the
  // same evidence — so this is one probe, not the two the prior shape ran
  // (build-time commands() + a second probe() inside the no_tests branch).
  const { evidence } = probe(repoPath);
  const steps = commands(overrides, evidence);
  const result = runSteps(repoPath, steps, { continueOnError: true });

  // ve-004 / ds-verify-001: the runner now makes the pass→no_tests DECISION
  // uniformly (a required `test` step that passed but exercised nothing is not
  // a verified pass). The node adapter only REFINES the human-readable reason:
  // when its probe proves the cause is a MISSING `test` script
  // (evidence.hasTest === false), say so — a more actionable message than the
  // generic "ran zero tests" (which also covers a present-but-empty suite).
  // Only refine for the default test step; an explicit override is the
  // operator's deliberate choice and keeps the runner's generic reason.
  const usingDefaultTest = !(overrides && overrides.test);
  if (usingDefaultTest && result.verdict === 'no_tests') {
    if (evidence && evidence.hasTest === false) {
      return {
        ...result,
        reason: 'no `test` script — `npm test --if-present` ran zero tests; not a verified pass',
      };
    }
  }

  return result;
}

export const nodeAdapter = { probe, commands, run };
