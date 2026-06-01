/**
 * Regression tests for scripts/check-doc-drift.mjs.
 *
 * Why this lives at the root scripts/ tree: same reason as sync-version.test.mjs
 * — the script isn't owned by any workspace package and we don't want to grow
 * a pseudo-workspace just to host it. Run via `npm run test:scripts` (also
 * wired in CI right after `npm ci`).
 *
 * Coverage:
 *   1. Each configured check in scripts/doc-drift-patterns.json (currently 13)
 *      with a clean fixture and a drift fixture.
 *   2. Live-tree assertion: the actual repo passes all checks. This is the
 *      load-bearing test — it's the contract that the docs agents in wave 19
 *      had to land before the script could be merged.
 *   3. CLI surface: --check <id> selects one, unknown id reports config-error.
 *
 * Cleanup: every makeFixture() call registers `t.after(() => rmSync(dir, ...))`
 * at allocation time (mirroring the sync-version.test.mjs pattern that closed
 * F-651020-007).
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDriftChecks, expandGlobs, REGISTERED_HANDLERS } from './check-doc-drift.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * Allocate a temp fixture root, register cleanup, and return helpers.
 * The fixture mimics the relevant subset of the real repo layout.
 */
function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'check-doc-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    write(rel, content) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    },
    config(obj) {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'scripts/doc-drift-patterns.json'), JSON.stringify(obj, null, 2));
      return join(dir, 'scripts/doc-drift-patterns.json');
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-check unit tests (clean + drift)
// ─────────────────────────────────────────────────────────────────────────────

test('error-codes check: clean fixture passes', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/swarm/lib/errors.js', `
    export class FooError extends Error {
      constructor() { super('x'); this.code = 'FOO_FAILED'; }
    }
    export class BarError extends Error {
      constructor() { super('x'); this.code = 'BAR_FAILED'; }
    }
  `);
  fx.write('docs/error-codes.md', `
    # Errors
    - FOO_FAILED — explained
    - BAR_FAILED — explained
  `);
  const cfg = fx.config({
    checks: [{
      id: 'error-codes',
      kind: 'source-vs-target-coverage',
      title: 'Error codes',
      sources: ['packages/swarm/lib/errors.js'],
      sourceExtractors: [{ regex: "this\\.code\\s*=\\s*['\"]([A-Z_]+)['\"]" }],
      targets: ['docs/error-codes.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('error-codes check: missing code triggers drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/swarm/lib/errors.js', `
    export class FooError extends Error {
      constructor() { super('x'); this.code = 'FOO_FAILED'; }
    }
    export class BarError extends Error {
      constructor() { super('x'); this.code = 'BAR_MISSING_FROM_DOCS'; }
    }
  `);
  fx.write('docs/error-codes.md', '# Errors\n- FOO_FAILED — explained\n');
  const cfg = fx.config({
    checks: [{
      id: 'error-codes',
      kind: 'source-vs-target-coverage',
      title: 'Error codes',
      sources: ['packages/swarm/lib/errors.js'],
      sourceExtractors: [{ regex: "this\\.code\\s*=\\s*['\"]([A-Z_]+)['\"]" }],
      targets: ['docs/error-codes.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.deepEqual(result.reports[0].missing, ['BAR_MISSING_FROM_DOCS']);
});

test('source-vs-target with expand: STATE_MACHINE_<KIND> template literal expands', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/swarm/lib/errors.js', `
    export class StateError extends Error {
      constructor(msg, opts) { super(msg); this.code = \`STATE_MACHINE_\${opts.kind}\`; }
    }
  `);
  fx.write('docs/error-codes.md', '# Errors\n- STATE_MACHINE_BLOCKED\n- STATE_MACHINE_TERMINAL\n- STATE_MACHINE_INVALID\n');
  const cfg = fx.config({
    checks: [{
      id: 'sm',
      kind: 'source-vs-target-coverage',
      title: 'sm',
      sources: ['packages/swarm/lib/errors.js'],
      sourceExtractors: [{
        regex: 'this\\.code\\s*=\\s*`STATE_MACHINE_\\$\\{opts\\.kind\\}`',
        expand: ['STATE_MACHINE_BLOCKED', 'STATE_MACHINE_TERMINAL', 'STATE_MACHINE_INVALID'],
      }],
      targets: ['docs/error-codes.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('statuses check: status-enum-evaluator extracts STATUS object', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/swarm/db/schema.js', `
    export const STATUS = {
      finding: ['new', 'recurring', 'fixed'],
      severity: ['CRITICAL'],
    };
  `);
  // Clean: all finding states mentioned, severity skipped.
  fx.write('docs/state-machines.md', '# States\nnew, recurring, fixed are states.\n');
  const cfg = fx.config({
    checks: [{
      id: 'statuses',
      kind: 'source-vs-target-coverage',
      title: 'statuses',
      sources: ['packages/swarm/db/schema.js'],
      sourceExtractors: [{
        kind: 'status-enum-evaluator',
        module: 'packages/swarm/db/schema.js',
        exportName: 'STATUS',
        skipKeys: ['severity'],
      }],
      targets: ['docs/state-machines.md'],
      matchMode: 'wholeWord',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('statuses check: drift when a status is missing from docs', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/swarm/db/schema.js', `
    export const STATUS = { finding: ['new', 'newly_added_status'] };
  `);
  fx.write('docs/state-machines.md', '# States\nnew is the only documented one.\n');
  const cfg = fx.config({
    checks: [{
      id: 'statuses',
      kind: 'source-vs-target-coverage',
      title: 'statuses',
      sources: ['packages/swarm/db/schema.js'],
      sourceExtractors: [{
        kind: 'status-enum-evaluator',
        module: 'packages/swarm/db/schema.js',
        exportName: 'STATUS',
      }],
      targets: ['docs/state-machines.md'],
      matchMode: 'wholeWord',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.deepEqual(result.reports[0].missing, ['newly_added_status']);
});

test('no-legacy-paths check: clean docs pass, legacy path triggers drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/handbook.md', '# Handbook\nUse dogfood-lab/testing-os always.\n');
  const cfg = fx.config({
    checks: [{
      id: 'no-legacy-paths',
      kind: 'forbidden-pattern-in-targets',
      title: 'no-legacy-paths',
      patterns: [{ regex: 'mcp-tool-shop-org/dogfood-labs', label: 'legacy repo' }],
      targets: ['docs/handbook.md'],
    }],
  });
  let result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true);

  // Now introduce drift.
  fx.write('docs/handbook.md', '# Handbook\nSee mcp-tool-shop-org/dogfood-labs for old stuff.\n');
  result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].file, /docs\/handbook\.md:2/);
});

test('no-version-specific-narrative check: 9-Phase reference flagged', async (t) => {
  const fx = makeFixture(t);
  fx.write('swarms/PROTOCOL.md', '# Protocol\n## The 10-Phase Play\nBody.\n');
  const cfg = fx.config({
    checks: [{
      id: 'no-version',
      kind: 'forbidden-pattern-in-targets',
      title: 'no-version',
      patterns: [{ regex: '\\b9-Phase\\b', label: 'stale 9-Phase' }],
      targets: ['swarms/PROTOCOL.md'],
    }],
  });
  let result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true);

  fx.write('swarms/PROTOCOL.md', '# Protocol\n## The 9-Phase Play\nBody.\n');
  result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].message, /stale 9-Phase/);
});

test('self-consistency check: must[] passes when present, fails when missing', async (t) => {
  const fx = makeFixture(t);
  fx.write('swarms/PROTOCOL.md', '## The 10-Phase Play\n**Stage D** — Visual Polish\n');
  const cfg = fx.config({
    checks: [{
      id: 'consistency',
      kind: 'self-consistency',
      title: 'consistency',
      target: 'swarms/PROTOCOL.md',
      rules: [{
        id: 'stage-d-defined',
        must: [
          { regex: 'Stage D[^-]*[—-][^\\n]*Visual', min: 1, label: 'Stage D Visual lens' },
        ],
        mustNot: [
          { regex: '## The 9-Phase Play', label: 'old 9-Phase header' },
        ],
      }],
    }],
  });
  let result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));

  // Drift: missing Stage D definition.
  fx.write('swarms/PROTOCOL.md', '## The 10-Phase Play\nNo Stage D body.\n');
  result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].message, /required content missing/);

  // Drift: forbidden header present.
  fx.write('swarms/PROTOCOL.md', '## The 9-Phase Play\n**Stage D** — Visual Polish\n');
  result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].message, /forbidden content present/);
});

test('allowlist exempts tokens from coverage requirement', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/swarm/db/schema.js', `
    export const STATUS = { finding: ['new', 'internal_only'] };
  `);
  fx.write('docs/state-machines.md', '# States\nnew is documented.\n');
  const cfg = fx.config({
    checks: [{
      id: 'statuses',
      kind: 'source-vs-target-coverage',
      title: 'statuses',
      sources: ['packages/swarm/db/schema.js'],
      sourceExtractors: [{
        kind: 'status-enum-evaluator',
        module: 'packages/swarm/db/schema.js',
        exportName: 'STATUS',
      }],
      targets: ['docs/state-machines.md'],
      matchMode: 'wholeWord',
      allowlist: ['internal_only'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('unknown check kind reports config-error (exit 2 territory)', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/x.md', 'x');
  const cfg = fx.config({
    checks: [{ id: 'bad', kind: 'nonexistent-handler', title: 'bad' }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].message, /unknown check kind/);
});

test('--check <id> filtering: unknown id surfaces known-id list', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/x.md', 'x');
  const cfg = fx.config({
    checks: [
      { id: 'a', kind: 'forbidden-pattern-in-targets', title: 'a', patterns: [], targets: ['docs/x.md'] },
      { id: 'b', kind: 'forbidden-pattern-in-targets', title: 'b', patterns: [], targets: ['docs/x.md'] },
    ],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg, checkId: 'nope' });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].hint, /a, b/);
});

test('missing config file reports config-error', async (t) => {
  const fx = makeFixture(t);
  // No config written.
  const result = await runDriftChecks({ repoRoot: fx.dir });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].message, /config file not found/);
});

test('expandGlobs: exact path returns single file, glob expands directory', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/a.md', 'a');
  fx.write('docs/b.md', 'b');
  fx.write('docs/c.txt', 'c');
  const exact = expandGlobs(['docs/a.md'], fx.dir);
  assert.equal(exact.length, 1);
  const glob = expandGlobs(['docs/*.md'], fx.dir);
  assert.equal(glob.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE TREE assertion — the load-bearing test
// ─────────────────────────────────────────────────────────────────────────────

test('LIVE TREE: actual repo passes all drift checks (post-wave-26 framework generalization)', async () => {
  const result = await runDriftChecks({ repoRoot });
  assert.equal(
    result.clean,
    true,
    `Expected zero drift. Got ${result.reports.length} report(s):\n` +
      result.reports
        .map((r) => `  ${r.severity}: ${r.message}\n    hint: ${r.hint ?? '(none)'}`)
        .join('\n')
  );
  // Sanity: every config entry should be running. Wave-26 / Phase 7 wave 1
  // expanded the framework: 4 original handlers (source-vs-target-coverage,
  // forbidden-pattern-in-targets, self-consistency, untagged-fence) plus 3
  // new ones (helper-adoption-sweep, schema-conformance, framework-self-test).
  // The exact count is a function of seeded check INSTANCES, not handler
  // KINDS — assert ≥10 to allow new instances to land without churning this
  // test, but catch regressions where the config got truncated.
  assert.ok(
    result.checksRun >= 10,
    `Expected at least 10 seeded checks; got ${result.checksRun}. The framework was generalized in wave 26 with 5 helper-adoption-sweep entries + 1 schema-conformance entry + 1 framework-self-test entry on top of the 6 original checks.`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// untagged-fence handler (D-CI-001 / F-827321-010, wave 23)
// ─────────────────────────────────────────────────────────────────────────────

test('untagged-fence: clean fixture (every opener tagged) passes', async (t) => {
  const fx = makeFixture(t);
  fx.write('site/src/content/docs/handbook/clean.md', [
    '# Clean',
    '',
    '```bash',
    'npm test',
    '```',
    '',
    '```text',
    'ascii diagram',
    '```',
    '',
  ].join('\n'));
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['site/src/content/docs/handbook/*.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('untagged-fence: bare ``` opener triggers drift on the OPENER line, not the closer', async (t) => {
  const fx = makeFixture(t);
  fx.write('site/src/content/docs/handbook/dirty.md', [
    '# Dirty',
    '',
    '```',                  // line 3 — untagged opener (drift)
    'output',
    '```',                  // line 5 — closer (must NOT be flagged)
    '',
    '```bash',              // line 7 — tagged opener (clean)
    'npm test',
    '```',                  // line 9 — closer (clean)
    '',
  ].join('\n'));
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['site/src/content/docs/handbook/*.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1, `Expected exactly one drift on the opener; got ${result.reports.length}`);
  assert.match(result.reports[0].file, /dirty\.md:3$/);
});

test('untagged-fence: multiple untagged openers across multiple files all surface', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/a.md', '```\nx\n```\n```\ny\n```\n');
  fx.write('docs/b.md', '```text\nok\n```\n');
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['docs/*.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 2, 'Both untagged openers in a.md should surface; b.md has none.');
});

test('untagged-fence: empty target glob reports config-error', async (t) => {
  const fx = makeFixture(t);
  // No matching files written.
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['nonexistent/*.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
});

// ─────────────────────────────────────────────────────────────────────────────
// helper-adoption-sweep handler (F-252713-016 / FT-CITOOLING-001, wave 26)
// Productizes wave22-log-stage-discipline.test.js as a generalized Class #9
// sweep. Tests cover: clean adoption, raw-primitive drift, wrapper-with-import
// allowed, allowlist exemption, helper-not-found config error, helper missing
// the named export, test files auto-excluded, comment-only hits ignored.
// ─────────────────────────────────────────────────────────────────────────────

test('helper-adoption-sweep: clean fixture (every caller imports the helper) passes', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/findings/lib/atomic-write.js', `
    import fs from 'node:fs';
    export function atomicWriteFileSync(p, c) { fs.writeFileSync(p, c); }
  `);
  fx.write('packages/findings/derive/write-findings.js', `
    import { atomicWriteFileSync } from '../lib/atomic-write.js';
    export function writeFinding(p, c) { atomicWriteFileSync(p, c); }
  `);
  fx.write('packages/dogfood-swarm/commands/persist.js', `
    import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
    export function persist(p, c) { atomicWriteFileSync(p, c); }
  `);
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('helper-adoption-sweep: raw fs.writeFileSync without helper import triggers drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/findings/lib/atomic-write.js', `
    export function atomicWriteFileSync(p, c) {}
  `);
  fx.write('packages/dogfood-swarm/commands/dispatch.js', `
    import { writeFileSync } from 'node:fs';
    export function dispatch() {
      writeFileSync('out', 'data');
    }
  `);
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1);
  assert.match(result.reports[0].file, /dispatch\.js$/);
  assert.match(result.reports[0].message, /uses raw .+ but does not import/);
});

test('helper-adoption-sweep: wrapper that imports the helper is allowed', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/dogfood-swarm/lib/log-stage.js', `
    export function logStage(stage, fields) { console.error(JSON.stringify({stage, ...fields})); }
  `);
  fx.write('packages/ingest/run.js', `
    import { logStage as sharedLogStage } from '@dogfood-lab/dogfood-swarm/lib/log-stage.js';
    function logStage(stage, fields) {
      const { stage: _drop, ...safe } = fields;
      sharedLogStage(stage, { component: 'ingest', ...safe });
    }
    logStage('start', {});
  `);
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'log-stage adoption',
      helper: 'packages/dogfood-swarm/lib/log-stage.js',
      exportName: 'logStage',
      forbiddenPattern: '(?:function|const|let|var)\\s+logStage\\b',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('helper-adoption-sweep: allowlist exempts a known violator', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/findings/lib/atomic-write.js', `
    export function atomicWriteFileSync(p, c) {}
  `);
  fx.write('packages/legacy/old.js', `
    import { writeFileSync } from 'node:fs';
    writeFileSync('x', 'y');
  `);
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'atomic-write adoption',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
      allowlist: ['packages/legacy/old.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('helper-adoption-sweep: missing helper file reports config-error', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/x.js', 'export const x = 1;');
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'missing helper',
      helper: 'packages/nonexistent/helper.js',
      exportName: 'foo',
      forbiddenPattern: 'foo',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].message, /helper file not found/);
});

test('helper-adoption-sweep: helper missing named export reports config-error', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/helper.js', 'export const otherName = 1;');
  fx.write('packages/foo/caller.js', 'import {} from "./helper.js";');
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'wrong export',
      helper: 'packages/foo/helper.js',
      exportName: 'expectedName',
      forbiddenPattern: 'foo',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].message, /does not export expectedName/);
});

test('helper-adoption-sweep: test files (.test.js) auto-excluded by default', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/findings/lib/atomic-write.js', `
    export function atomicWriteFileSync(p, c) {}
  `);
  fx.write('packages/findings/findings.test.js', `
    import { writeFileSync } from 'node:fs';
    writeFileSync('fixture', 'data');
  `);
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'sweep',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('helper-adoption-sweep: comment-only mention of forbidden pattern does not trigger drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/findings/lib/atomic-write.js', `
    export function atomicWriteFileSync(p, c) {}
  `);
  fx.write('packages/foo/no-write.js', `
    // This module historically used fs.writeFileSync(...) but now relies on
    // a different path. Seriously — no real call here.
    /* writeFileSync('also', 'commented') */
    export const noop = () => {};
  `);
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'sweep',
      helper: 'packages/findings/lib/atomic-write.js',
      exportName: 'atomicWriteFileSync',
      forbiddenPattern: 'fs\\.writeFileSync\\(|(?<![\\w.])writeFileSync\\(',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('helper-adoption-sweep: multiple violators across files all surface', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/foo/helper.js', `
    export function safeOp(x) { return x; }
  `);
  fx.write('packages/foo/a.js', `
    function rawCall(x) { return x; }
    rawCall(1);
  `);
  fx.write('packages/foo/b.js', `
    function rawCall(x) { return x + 1; }
    rawCall(2);
  `);
  fx.write('packages/foo/c-clean.js', `
    import { safeOp } from './helper.js';
    function rawCall(x) { return safeOp(x); }
    rawCall(3);
  `);
  const cfg = fx.config({
    checks: [{
      id: 'sweep',
      kind: 'helper-adoption-sweep',
      title: 'sweep',
      helper: 'packages/foo/helper.js',
      exportName: 'safeOp',
      forbiddenPattern: 'rawCall\\(',
      callers: ['packages/**/*.js'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 2, 'a.js + b.js fail; c-clean.js imports the helper');
});

// ─────────────────────────────────────────────────────────────────────────────
// schema-conformance handler (F-252713-017 / FT-CITOOLING-002, wave 26)
// Validates target JSON files against scripts/agent-output.schema.json (or
// any JSON Schema declared in the check). Tests cover: valid output, each
// required field missing, invalid enum value, malformed JSON, allowlist,
// allowEmpty gate, schema-not-found config error.
// ─────────────────────────────────────────────────────────────────────────────

const VALID_AMEND_OUTPUT = {
  domain: 'ci-tooling',
  fixes: [
    { finding_id: 'F-001', file: 'a.js', description: 'fixed' },
  ],
  files_changed: ['a.js'],
  skipped: [],
  summary: 'Fixed one finding.',
};

const SIMPLE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['domain', 'summary'],
  properties: {
    domain: { type: 'string', minLength: 1 },
    summary: { type: 'string', minLength: 1 },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding_id', 'description'],
        properties: {
          finding_id: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
};

test('schema-conformance: valid output passes', async (t) => {
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  fx.write('outputs/agent.json', JSON.stringify(VALID_AMEND_OUTPUT));
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['outputs/*.json'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('schema-conformance: missing required `domain` triggers drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  const broken = { ...VALID_AMEND_OUTPUT };
  delete broken.domain;
  fx.write('outputs/agent.json', JSON.stringify(broken));
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['outputs/*.json'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].message, /schema validation failed/);
  assert.equal(result.reports[0].error?.name, 'AgentOutputValidationError');
});

test('schema-conformance: missing required `summary` triggers drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  const broken = { ...VALID_AMEND_OUTPUT };
  delete broken.summary;
  fx.write('outputs/agent.json', JSON.stringify(broken));
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['outputs/*.json'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].message, /schema validation failed/);
});

test('schema-conformance: missing fix `finding_id` field triggers drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  fx.write('outputs/agent.json', JSON.stringify({
    domain: 'x',
    summary: 'y',
    fixes: [{ description: 'no finding_id' }],
  }));
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['outputs/*.json'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].message, /finding_id|required/);
});

test('schema-conformance: malformed JSON reports drift with INVALID_JSON code', async (t) => {
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  fx.write('outputs/agent.json', '{ not valid json');
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['outputs/*.json'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].error?.code, 'INVALID_JSON');
});

test('schema-conformance: allowlist exempts a target file', async (t) => {
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  fx.write('outputs/legacy.json', '{}'); // missing required fields, but allowlisted
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['outputs/*.json'],
      allowlist: ['outputs/legacy.json'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('schema-conformance: allowEmpty gate allows zero-target glob', async (t) => {
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  // No matching files written.
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['nonexistent/*.json'],
      allowEmpty: true,
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('schema-conformance: schema file missing reports config-error', async (t) => {
  const fx = makeFixture(t);
  fx.write('outputs/agent.json', JSON.stringify(VALID_AMEND_OUTPUT));
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/missing-schema.json',
      targets: ['outputs/*.json'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].message, /schema file not found/);
});

// ─────────────────────────────────────────────────────────────────────────────
// schema-conformance — negative-fixture discrimination (D4-004, Wave A2)
// ─────────────────────────────────────────────────────────────────────────────

test('schema-conformance: negative fixture (basename matches negativeFilenamePattern) MUST fail validation (D4-004)', async (t) => {
  // A file matching the negative-filename pattern that DOES validate must
  // be reported as drift — the gate is asserting "this fixture intentionally
  // violates the schema; if it passes, the schema loosened".
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  // A negative fixture that *accidentally* passes the schema:
  fx.write(
    'fixtures/invalid-broken-on-purpose.json',
    JSON.stringify(VALID_AMEND_OUTPUT),
  );
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['fixtures/*.json'],
      negativeFilenamePattern: '^invalid-',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].message, /NEGATIVE fixture passed validation/);
  assert.equal(result.reports[0].error?.code, 'NEGATIVE_FIXTURE_PASSED');
});

test('schema-conformance: negative fixture that FAILS validation passes the gate (the happy path) (D4-004)', async (t) => {
  // The correct shape of a negative fixture: it intentionally violates the
  // schema. The handler silently accepts that as the expected outcome.
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  fx.write(
    'fixtures/invalid-missing-domain.json',
    JSON.stringify({ summary: 'no domain field — must fail' }),
  );
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['fixtures/*.json'],
      negativeFilenamePattern: '^invalid-',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('schema-conformance: positive + negative fixtures wired together (D4-004 end-to-end)', async (t) => {
  // Mixed-mode test: one positive fixture that validates + one negative
  // fixture that does not. The gate stays clean.
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  fx.write('fixtures/valid-basic.json', JSON.stringify(VALID_AMEND_OUTPUT));
  fx.write(
    'fixtures/invalid-missing-summary.json',
    JSON.stringify({ domain: 'x' }),
  );
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['fixtures/*.json'],
      negativeFilenamePattern: '^invalid-',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('schema-conformance: default negativeFilenamePattern is `^invalid-` (D4-004 default)', async (t) => {
  // No explicit pattern; the default fires. Confirms the live config
  // (which sets negativeFilenamePattern explicitly for documentation
  // purposes) and the default behavior stay aligned.
  const fx = makeFixture(t);
  fx.write('scripts/agent-output.schema.json', JSON.stringify(SIMPLE_SCHEMA));
  fx.write(
    'fixtures/invalid-no-summary.json',
    JSON.stringify({ domain: 'x' }),
  );
  fx.write('fixtures/valid.json', JSON.stringify(VALID_AMEND_OUTPUT));
  const cfg = fx.config({
    checks: [{
      id: 'sc',
      kind: 'schema-conformance',
      title: 'sc',
      schema: 'scripts/agent-output.schema.json',
      targets: ['fixtures/*.json'],
      // No negativeFilenamePattern set → default ^invalid- applies.
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

// ─────────────────────────────────────────────────────────────────────────────
// Live-tree wiring for the agent-output-schema check (D4-004 — behavioral
// assertion, not just structural).
//
// Before Wave A2, the live `agent-output-schema` check carried `allowEmpty:
// true` and both globs matched zero committed files. The framework-self-
// test only checked STRUCTURE (required fields present) — vacuous gates
// stayed vacuous forever. These tests assert the BEHAVIOR: the live check
// matches positive + negative committed fixtures, the positives validate,
// the negative validates-as-rejected, and `allowEmpty` is GONE so a future
// zero-match (someone deletes the fixtures directory) fails loud.
// ─────────────────────────────────────────────────────────────────────────────

test('LIVE WIRING: agent-output-schema check has at least one positive AND one negative fixture committed (D4-004)', async () => {
  const cfgPath = resolve(repoRoot, 'scripts/doc-drift-patterns.json');
  const { readFileSync: read } = await import('node:fs');
  const config = JSON.parse(read(cfgPath, 'utf8'));
  const entry = config.checks.find((c) => c.id === 'agent-output-schema');
  assert.ok(entry, 'expected an agent-output-schema check entry in scripts/doc-drift-patterns.json');

  // The first target glob is the canonical hand-curated fixture path.
  // Read it via the same expandGlobs helper the framework uses.
  const matched = expandGlobs(entry.targets, repoRoot, { recursive: true });
  const basenames = matched.map((f) => f.replace(/\\/g, '/').split('/').pop());

  const negPattern = new RegExp(entry.negativeFilenamePattern ?? '^invalid-');
  const positives = basenames.filter((b) => !negPattern.test(b));
  const negatives = basenames.filter((b) => negPattern.test(b));

  assert.ok(
    positives.length >= 1,
    `expected at least 1 POSITIVE fixture matching ${entry.targets.join(' | ')}; got 0. ` +
      `D4-004 invariant: hand-curated fixtures live under swarms/__schema-fixtures__/ — ` +
      `a positive shape proves the schema's required[] passes for legitimate envelopes.`,
  );
  assert.ok(
    negatives.length >= 1,
    `expected at least 1 NEGATIVE fixture matching ${entry.targets.join(' | ')} ` +
      `(basename starts with 'invalid-'); got 0. D4-004 invariant: at least one fixture ` +
      `must intentionally violate the schema so a future schema-loosening is caught.`,
  );
});

test('LIVE WIRING: agent-output-schema check does NOT carry allowEmpty:true (D4-004 — vacuous-gate root cause closed)', async () => {
  const cfgPath = resolve(repoRoot, 'scripts/doc-drift-patterns.json');
  const { readFileSync: read } = await import('node:fs');
  const config = JSON.parse(read(cfgPath, 'utf8'));
  const entry = config.checks.find((c) => c.id === 'agent-output-schema');
  assert.ok(entry);
  assert.notEqual(
    entry.allowEmpty,
    true,
    'D4-004: `allowEmpty: true` was the vacuous-gate enabler. Drop it. ' +
      'If both target globs match zero files, the gate must fail loud — that is the whole point.',
  );
});

test('LIVE WIRING: running the agent-output-schema check validates the committed positive fixtures (D4-004)', async () => {
  // Behavior assertion: the live check, run against the live tree, passes.
  // This is the operator-facing contract — `npm run check-doc-drift` stays
  // green only as long as positives validate AND negatives fail.
  const result = await runDriftChecks({ repoRoot, checkId: 'agent-output-schema' });
  assert.equal(
    result.clean,
    true,
    `agent-output-schema check should pass against the committed fixtures. ` +
      `Reports: ${JSON.stringify(result.reports, null, 2)}`,
  );
  assert.equal(result.checksRun, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// framework-self-test handler — meta-check
// ─────────────────────────────────────────────────────────────────────────────

test('framework-self-test: every config entry has a registered handler', async (t) => {
  const fx = makeFixture(t);
  const cfg = fx.config({
    checks: [
      {
        id: 'good',
        kind: 'untagged-fence',
        title: 'good',
        targets: ['docs/*.md'],
      },
      {
        id: 'self',
        kind: 'framework-self-test',
        title: 'self',
        configPath: 'scripts/doc-drift-patterns.json',
      },
    ],
  });
  fx.write('docs/x.md', '# x\n');
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg, checkId: 'self' });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('framework-self-test: orphaned check kind without handler triggers drift', async (t) => {
  const fx = makeFixture(t);
  const cfg = fx.config({
    checks: [
      {
        id: 'orphan',
        kind: 'no-such-handler',
        title: 'orphan',
      },
      {
        id: 'self',
        kind: 'framework-self-test',
        title: 'self',
        configPath: 'scripts/doc-drift-patterns.json',
      },
    ],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg, checkId: 'self' });
  assert.equal(result.clean, false);
  assert.match(result.reports[0].message, /unknown kind 'no-such-handler'/);
});

test('framework-self-test: missing required field in config entry triggers drift', async (t) => {
  const fx = makeFixture(t);
  const cfg = fx.config({
    checks: [
      {
        id: 'incomplete',
        kind: 'helper-adoption-sweep',
        title: 'incomplete',
        // Missing helper, exportName, forbiddenPattern, callers.
      },
      {
        id: 'self',
        kind: 'framework-self-test',
        title: 'self',
        configPath: 'scripts/doc-drift-patterns.json',
      },
    ],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg, checkId: 'self' });
  assert.equal(result.clean, false);
  // Should flag at least one missing required field.
  const fields = result.reports.map((r) => r.message);
  assert.ok(
    fields.some((m) => m.includes('helper')),
    `Expected a report mentioning missing 'helper' field. Got: ${fields.join('; ')}`,
  );
});

test('framework-self-test: REGISTERED_HANDLERS exposes all handler kinds', () => {
  const kinds = Object.keys(REGISTERED_HANDLERS).sort();
  // Lock the expected set so accidental handler removal surfaces.
  assert.deepEqual(kinds, [
    'forbidden-pattern-in-targets',
    'framework-self-test',
    'helper-adoption-sweep',
    'schema-conformance',
    'self-consistency',
    'source-vs-target-coverage',
    'untagged-fence',
  ]);
  for (const [kind, mod] of Object.entries(REGISTERED_HANDLERS)) {
    assert.equal(mod.kind, kind, `handler at ${kind} must declare matching kind`);
    assert.equal(typeof mod.run, 'function', `handler at ${kind} must export run()`);
    assert.equal(typeof mod.description, 'string', `handler at ${kind} must declare description`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-segment glob expansion (added in wave 26 to support
// 'swarms/swarm-*/wave-*/*.json' for schema-conformance targets)
// ─────────────────────────────────────────────────────────────────────────────

test('expandGlobs: multi-segment glob expands across multiple directory levels', async (t) => {
  const fx = makeFixture(t);
  fx.write('swarms/swarm-001/wave-1/backend.json', '{}');
  fx.write('swarms/swarm-001/wave-2/backend.json', '{}');
  fx.write('swarms/swarm-002/wave-1/backend.json', '{}');
  fx.write('swarms/templates/example.json', '{}');  // not a swarm-* dir
  const matched = expandGlobs(['swarms/swarm-*/wave-*/*.json'], fx.dir);
  assert.equal(matched.length, 3, JSON.stringify(matched));
});

test('expandGlobs: doublestar glob (recursive) walks subtrees when opts.recursive=true', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/a/lib/x.js', '');
  fx.write('packages/a/sub/deep/y.js', '');
  fx.write('packages/b/z.js', '');
  fx.write('packages/c/skip.txt', '');
  const matched = expandGlobs(['packages/**/*.js'], fx.dir, { recursive: true });
  assert.equal(matched.length, 3, JSON.stringify(matched));
});
