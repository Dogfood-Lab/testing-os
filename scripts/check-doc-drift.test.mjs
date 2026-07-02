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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDriftChecks, expandGlobs, REGISTERED_HANDLERS, parseCheckId, countCommandMapEntries } from './check-doc-drift.mjs';

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
    'source-of-truth-cross-ref',
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

// ─────────────────────────────────────────────────────────────────────────────
// META-TEST: error-codes gate non-vacuity (Wave A2.1 FX2)
//
// The error-codes check is `source-vs-target-coverage` — it claims to extract
// every error code emitted by the listed source files and assert each one
// appears in site/src/content/docs/handbook/error-codes.md. The vacuity
// failure mode is silent: an extractor regex that matches ZERO lines in its
// declared source file produces ZERO tokens, so the handbook can drop the
// corresponding code with NO drift signal — the gate stays green forever.
//
// Pre-FX2 this happened to 6 of the 19 codes the gate claimed to enforce:
//   - VALIDATOR_FAULT_{SCHEMA,POLICY,STEPS}: extractor regex
//     `reasons\.push\(\s*\`VALIDATOR_FAULT_` matched nothing because
//     packages/verify/index.js pushes a *variable* (reasons.push(faultReason))
//     where faultReason is minted as `VALIDATOR_FAULT_${cls}` on a different
//     line, in a helper function. The mint site and the push site are
//     decoupled — the extractor watched the wrong line.
//   - DISPATCH_{RUN_NOT_FOUND,DOMAINS_NOT_FROZEN,NO_DOMAINS}: NO extractor
//     existed at all. DispatchPreconditionError uses `this.code = opts.code`
//     (variable), so the general `this.code = 'X'` literal extractor misses
//     them; the codes only appear as literals in the JSDoc @param type union
//     on the class constructor in packages/dogfood-swarm/lib/errors.js.
//
// The test STRATEGY:
//   For each code claimed to be enforced, build a fixture that mirrors the
//   live tree (same config + same source files) but with that one code's
//   mentions stripped from the handbook copy. Run `runDriftChecks` on the
//   fixture. If the gate is honestly extracting that code, the result MUST
//   report drift AND list that code in `missing[]`. If the gate stayed clean
//   the extractor is vacuous — the failure surface of this meta-test.
//
// What this test CANNOT catch: schema-level claims of what should be
// extracted vs what actually is. If a future code is added to the handbook
// without being added to EXPECTED_ENFORCED_CODES, the test won't pin it. The
// list is the test's spec; updating the handbook requires updating the spec.
// That tradeoff is deliberate — it forces a deliberate decision on whether
// a new code is gated, instead of letting "documented but un-extracted"
// codes accumulate silently.
// ─────────────────────────────────────────────────────────────────────────────

test('error-codes META: removing any enforced code from the handbook MUST trigger drift (no vacuous extractors)', async (t) => {
  // The 19 codes the live `error-codes` check is documented to enforce. Pre-
  // FX2, 6 of these (VALIDATOR_FAULT_* + DISPATCH_*) were vacuous — the
  // extractor regex matched nothing in its declared source file, so the
  // gate let an operator silently delete the heading from the handbook.
  // This array is the contract. Adding a new code to the handbook without
  // adding it here will not fail this test; that's the spec — explicit
  // opt-in to enforcement, no implicit "if it's documented it must be
  // enforced" leaks. Removing a code here without removing it from the
  // handbook ALSO won't fail this test directly, but that combination will
  // surface as a stale-config smell in review.
  const EXPECTED_ENFORCED_CODES = [
    'RECORD_SCHEMA_INVALID',
    'DUPLICATE_RUN_ID',
    'ISOLATION_FAILED',
    'COLLECT_UPSERT_FAILED',
    'DISPATCH_RUN_NOT_FOUND',
    'DISPATCH_DOMAINS_NOT_FROZEN',
    'DISPATCH_NO_DOMAINS',
    'CLI_INVALID_GLOBS_JSON',
    'FINDING_ID_COLLISION',
    'PATTERN_ID_COLLISION',
    'RECOMMENDATION_ID_COLLISION',
    'DOCTRINE_ID_COLLISION',
    'FINDING_SCHEMA_INVALID',
    'PATTERN_SCHEMA_INVALID',
    'RECOMMENDATION_SCHEMA_INVALID',
    'DOCTRINE_SCHEMA_INVALID',
    'VALIDATOR_FAULT_SCHEMA',
    'VALIDATOR_FAULT_POLICY',
    'VALIDATOR_FAULT_STEPS',
  ];
  assert.equal(EXPECTED_ENFORCED_CODES.length, 19,
    'spec invariant: 19 enforced codes (3 STATE_MACHINE_* expansions live elsewhere)');

  // Read the live config + live handbook + live source files. The config is
  // the contract under test — we copy it into the fixture verbatim.
  const liveCfgPath = resolve(repoRoot, 'scripts/doc-drift-patterns.json');
  const liveCfg = JSON.parse(readFileSync(liveCfgPath, 'utf8'));
  const ecEntry = liveCfg.checks.find((c) => c.id === 'error-codes');
  assert.ok(ecEntry, 'expected an error-codes check entry in scripts/doc-drift-patterns.json');
  assert.equal(ecEntry.kind, 'source-vs-target-coverage');

  const liveHandbookPath = resolve(repoRoot, 'site/src/content/docs/handbook/error-codes.md');
  const liveHandbook = readFileSync(liveHandbookPath, 'utf8');

  // Sanity: the targets array in the config should resolve to the handbook
  // path. We mirror just that one target file into the fixture.
  assert.ok(
    ecEntry.targets.includes('site/src/content/docs/handbook/error-codes.md'),
    `expected error-codes.md in targets[]; got ${JSON.stringify(ecEntry.targets)}`,
  );

  // Snapshot every source file the live entry reads so the fixture's
  // extractors see identical input to the real ones. Source paths are
  // concrete (no globs) in the error-codes entry.
  const sourceSnapshots = new Map();
  for (const src of ecEntry.sources ?? []) {
    sourceSnapshots.set(src, readFileSync(resolve(repoRoot, src), 'utf8'));
  }

  const vacuous = [];
  for (const code of EXPECTED_ENFORCED_CODES) {
    const fx = makeFixture(t);
    // Mirror source files verbatim.
    for (const [src, content] of sourceSnapshots) {
      fx.write(src, content);
    }
    // Mirror the config verbatim — we want to exercise the LIVE extractor
    // regexes, not a hand-picked subset.
    fx.write('scripts/doc-drift-patterns.json', JSON.stringify(liveCfg, null, 2));
    // Strip the code from the handbook. Use word boundaries so we don't
    // accidentally damage substrings (irrelevant for the canonical names
    // since they're all distinct identifiers, but defensible if a future
    // code shares a prefix with another).
    const stripped = liveHandbook.replace(
      new RegExp(`\\b${code}\\b`, 'g'),
      '__REMOVED_BY_META_TEST__',
    );
    assert.notEqual(stripped, liveHandbook,
      `precondition: handbook must contain at least one literal mention of ${code} before stripping`);
    fx.write('site/src/content/docs/handbook/error-codes.md', stripped);

    const result = await runDriftChecks({
      repoRoot: fx.dir,
      configPath: resolve(fx.dir, 'scripts/doc-drift-patterns.json'),
      checkId: 'error-codes',
    });

    // The gate must fail AND `missing[]` must contain THIS code. A "fails
    // for other reasons" pass is not OK — the contract is per-code.
    const allMissing = result.reports.flatMap((r) => r.missing ?? []);
    const enforced = !result.clean && allMissing.includes(code);
    if (!enforced) {
      vacuous.push({
        code,
        clean: result.clean,
        missing: allMissing,
        reports: result.reports.map((r) => ({ severity: r.severity, message: r.message })),
      });
    }
  }

  assert.equal(
    vacuous.length,
    0,
    `Vacuous error-codes extractors detected (${vacuous.length} of ${EXPECTED_ENFORCED_CODES.length} codes are not actually enforced).\n` +
    `Each vacuous code can be deleted from the handbook with NO drift signal — the gate is silently broken for it.\n` +
    `Details:\n${vacuous.map((v) => `  - ${v.code}: clean=${v.clean} missing=${JSON.stringify(v.missing)}`).join('\n')}\n` +
    `Fix in scripts/doc-drift-patterns.json: ensure every code has an extractor whose regex matches AT LEAST ONE line in its declared source file. ` +
    `For codes minted via a variable (e.g. \`this.code = opts.code\`), match at the MINT site (template literal definition, JSDoc type union, or object-literal callsite), not the assignment site.`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// R9: source-of-truth-cross-ref handler (v1.3.1 fast-follow, productizing the
// post-release honesty sweep that fixed stale v1.2.3 references on SHIP_GATE /
// SCORECARD / CLAUDE / site-config after the v1.3.0 bump).
//
// The gate cross-references current-version + publishable-state + verb-count
// claims on honesty surfaces against authoritative resolvers (package.json,
// cli.js). It distinguishes current-state assertions from historical references
// by anchoring each claim to an explicit per-surface pattern rather than
// classifying free-floating version mentions heuristically.
//
// Two load-bearing properties this block proves (mirroring the error-codes
// META test pattern at the choke-point: a gate is NOT verified until a meta-
// test mutates the protected thing and asserts the gate fires):
//
//   1. Mutation fires RED: changing a current-version assertion in any
//      configured surface produces a drift report naming that surface.
//   2. Vacuity is detected: a claim whose pattern matches zero lines in its
//      target reports as config-error, so silent-truncation-by-rename can't
//      land a "clean" gate that protects nothing.
//
// The two failure modes the v1.3.0 swarm caught at the FIX layer (L2-003,
// H3-first-seal) both passed N/N test runs while being structurally vacuous.
// These tests are the structural insurance against that recurring twice more.
// ─────────────────────────────────────────────────────────────────────────────

test('source-of-truth-cross-ref handler is registered', () => {
  assert.ok(
    REGISTERED_HANDLERS['source-of-truth-cross-ref'],
    'R9 handler must be registered in HANDLERS so config entries with this kind dispatch to it.',
  );
  const handler = REGISTERED_HANDLERS['source-of-truth-cross-ref'];
  assert.equal(handler.kind, 'source-of-truth-cross-ref');
  assert.ok(Array.isArray(handler.requiredFields), 'handler must declare requiredFields');
  assert.ok(handler.requiredFields.includes('resolvers'), 'requiredFields must include "resolvers"');
  assert.ok(handler.requiredFields.includes('claims'), 'requiredFields must include "claims"');
});

test('R9: clean fixture (doc version matches package.json) passes', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9', private: true }, null, 2));
  fx.write('SHIP_GATE.md', '- [x] root + 4 packages all at `9.9.9`, tag `v9.9.9`\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        version: { source: 'package-json-field', file: 'package.json', path: 'version' },
      },
      claims: [{
        id: 'ship-gate-version-row',
        target: 'SHIP_GATE.md',
        pattern: 'packages all at `([0-9]+\\.[0-9]+\\.[0-9]+)`',
        captureGroup: 1,
        resolver: 'version',
        title: 'SHIP_GATE manifest-version row',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('R9 META: staled version in SHIP_GATE produces drift naming the surface', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9', private: true }, null, 2));
  fx.write('SHIP_GATE.md', '- [x] root + 4 packages all at `1.2.3`, tag `v1.2.3`\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        version: { source: 'package-json-field', file: 'package.json', path: 'version' },
      },
      claims: [{
        id: 'ship-gate-version-row',
        target: 'SHIP_GATE.md',
        pattern: 'packages all at `([0-9]+\\.[0-9]+\\.[0-9]+)`',
        captureGroup: 1,
        resolver: 'version',
        title: 'SHIP_GATE manifest-version row',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false, JSON.stringify(result.reports));
  // The drift report must NAME the surface so the operator can fix it.
  const drift = result.reports.find((r) => r.severity === 'drift');
  assert.ok(drift, `expected a drift report; got: ${JSON.stringify(result.reports)}`);
  assert.match(drift.file ?? '', /SHIP_GATE\.md/, 'drift must name SHIP_GATE.md');
  assert.match(drift.message, /1\.2\.3.*9\.9\.9|9\.9\.9.*1\.2\.3/, 'drift message must surface both the asserted and resolver-truth values');
});

test('R9 META: vacuous pattern (zero matches in target) reports as config-error', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  // Target file exists but contains nothing matching the claim's anchor pattern.
  // This is the v1.3.0 swarm lesson #3 / H3-first-seal pattern: a gate that
  // matches no lines is silently green — the protected assertion could be
  // renamed or removed and the gate would never fire again.
  fx.write('SHIP_GATE.md', '- [x] no version assertions here\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        version: { source: 'package-json-field', file: 'package.json', path: 'version' },
      },
      claims: [{
        id: 'ship-gate-version-row',
        target: 'SHIP_GATE.md',
        pattern: 'packages all at `([0-9]+\\.[0-9]+\\.[0-9]+)`',
        captureGroup: 1,
        resolver: 'version',
        title: 'SHIP_GATE manifest-version row',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  const cfgErr = result.reports.find((r) => r.severity === 'config-error');
  assert.ok(cfgErr, `expected a config-error report; got: ${JSON.stringify(result.reports)}`);
  assert.match(cfgErr.message, /vacuous|zero matches/i,
    'config-error message must explicitly identify the gate as vacuous so silent truncation is impossible to land');
  assert.match(cfgErr.message, /SHIP_GATE\.md/,
    'config-error message must name the target surface so the operator knows where to look');
});

test('R9 META: missing target file reports config-error', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  // SHIP_GATE.md NOT written.
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        version: { source: 'package-json-field', file: 'package.json', path: 'version' },
      },
      claims: [{
        id: 'ship-gate-version-row',
        target: 'SHIP_GATE.md',
        pattern: 'packages all at `([0-9]+\\.[0-9]+\\.[0-9]+)`',
        captureGroup: 1,
        resolver: 'version',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].message, /target.*not found.*SHIP_GATE\.md/i);
});

test('R9 META: unknown resolver reference reports config-error', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  fx.write('SHIP_GATE.md', '- [x] packages all at `9.9.9`\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        // version intentionally not declared.
      },
      claims: [{
        id: 'orphan',
        target: 'SHIP_GATE.md',
        pattern: 'packages all at `([0-9]+\\.[0-9]+\\.[0-9]+)`',
        captureGroup: 1,
        resolver: 'version',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports[0].severity, 'config-error');
  assert.match(result.reports[0].message, /resolver.*'version'.*not declared/i);
});

test('R9: pattern-count resolver counts cli.js verbs and matches a current claim', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  fx.write('packages/cli/cli.js', [
    'function cmdA() {}',
    'function cmdB() {}',
    'function cmdC() {}',
    'const command = process.argv[2];',
  ].join('\n'));
  fx.write('SHIP_GATE.md', '- [x] `swarm` bin documents its 3 subcommands\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        verbCount: { source: 'pattern-count', file: 'packages/cli/cli.js', pattern: '^function cmd[A-Z]', flags: 'gm' },
      },
      claims: [{
        id: 'ship-gate-verb-count',
        target: 'SHIP_GATE.md',
        pattern: '`swarm` bin documents its (\\d+) subcommands',
        captureGroup: 1,
        resolver: 'verbCount',
        title: 'SHIP_GATE swarm-verb count',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('R9 META: wrong verb count in SHIP_GATE produces drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  // 3 cmdX functions in cli.js, but doc claims 99 — drift.
  fx.write('packages/cli/cli.js', [
    'function cmdA() {}',
    'function cmdB() {}',
    'function cmdC() {}',
  ].join('\n'));
  fx.write('SHIP_GATE.md', '- [x] `swarm` bin documents its 99 subcommands\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        verbCount: { source: 'pattern-count', file: 'packages/cli/cli.js', pattern: '^function cmd[A-Z]', flags: 'gm' },
      },
      claims: [{
        id: 'ship-gate-verb-count',
        target: 'SHIP_GATE.md',
        pattern: '`swarm` bin documents its (\\d+) subcommands',
        captureGroup: 1,
        resolver: 'verbCount',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  const drift = result.reports.find((r) => r.severity === 'drift');
  assert.ok(drift, 'expected a drift report');
  assert.match(drift.message, /99.*3|3.*99/, 'drift must surface both the asserted and the resolved counts');
});

test('R9: package-json-publishable resolver returns true for `publishConfig: { access: public }` + not private', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/published/package.json', JSON.stringify({
    name: '@scope/published',
    version: '9.9.9',
    publishConfig: { access: 'public' },
  }, null, 2));
  fx.write('README.md', 'Available on npm: yes\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        published: { source: 'package-json-publishable', file: 'packages/published/package.json' },
      },
      claims: [{
        id: 'readme-publishable',
        target: 'README.md',
        pattern: 'Available on npm: (yes|no)',
        captureGroup: 1,
        resolver: 'published',
        // Map resolver booleans onto the captured string vocabulary.
        valueMap: { true: 'yes', false: 'no' },
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('R9 META: README claims publishable but package.json is private → drift', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/closed/package.json', JSON.stringify({
    name: '@scope/closed',
    version: '9.9.9',
    private: true,
  }, null, 2));
  fx.write('README.md', 'Available on npm: yes\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        published: { source: 'package-json-publishable', file: 'packages/closed/package.json' },
      },
      claims: [{
        id: 'readme-publishable',
        target: 'README.md',
        pattern: 'Available on npm: (yes|no)',
        captureGroup: 1,
        resolver: 'published',
        valueMap: { true: 'yes', false: 'no' },
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  const drift = result.reports.find((r) => r.severity === 'drift');
  assert.ok(drift, 'expected drift for lying-about-publishability');
  assert.match(drift.file ?? '', /README\.md/);
});

test('R9 LIVE META: every configured source-of-truth claim fires drift when its target is staled', async (t) => {
  // The choke-point invariant for this gate. Each entry in the LIVE config's
  // source-of-truth-cross-ref check is mutated in a fresh fixture (the
  // captured value replaced with a deliberately-stale stand-in) and the gate
  // is re-run against just that surface. Every claim must produce a drift
  // report naming the surface — otherwise the claim is silently vacuous and
  // the v1.3.0 honesty-sweep recurrence is back on the table at the next bump.
  //
  // This is the test the kickoff specifically calls "load-bearing." Without
  // it, R9 joins the treadmill it was built to stop.
  const liveCfgRaw = readFileSync(resolve(repoRoot, 'scripts/doc-drift-patterns.json'), 'utf8');
  const liveCfg = JSON.parse(liveCfgRaw);
  const sotEntry = liveCfg.checks.find((c) => c.kind === 'source-of-truth-cross-ref');
  assert.ok(sotEntry, 'the live config must declare a source-of-truth-cross-ref check (R9 production wiring)');
  assert.ok(Array.isArray(sotEntry.claims) && sotEntry.claims.length > 0,
    'R9 entry must declare at least one claim');

  // Snapshot every resolver source and every claim target so the fixture
  // sees identical input to the live framework.
  const liveSourceSnapshots = new Map();
  for (const [, spec] of Object.entries(sotEntry.resolvers ?? {})) {
    if (spec.file) {
      liveSourceSnapshots.set(spec.file, readFileSync(resolve(repoRoot, spec.file), 'utf8'));
    }
  }
  const liveTargetSnapshots = new Map();
  for (const claim of sotEntry.claims) {
    if (!liveTargetSnapshots.has(claim.target)) {
      liveTargetSnapshots.set(claim.target, readFileSync(resolve(repoRoot, claim.target), 'utf8'));
    }
  }

  const vacuous = [];
  for (const claim of sotEntry.claims) {
    const fx = makeFixture(t);
    // Mirror every resolver source verbatim.
    for (const [src, content] of liveSourceSnapshots) {
      fx.write(src, content);
    }
    // Find the LIVE match line-by-line — mirrors the handler's per-line
    // semantics so `^`-anchored patterns work the same way they do in
    // production (the handler walks lines; running `re.exec()` against the
    // full file would only match `^` at byte 0).
    const targetSrc = liveTargetSnapshots.get(claim.target);
    const targetLines = targetSrc.split(/\r?\n/);
    let foundIdx = -1;
    let foundMatch = null;
    for (let i = 0; i < targetLines.length; i++) {
      const lineRe = new RegExp(claim.pattern);
      const m = lineRe.exec(targetLines[i]);
      if (m) { foundIdx = i; foundMatch = m; break; }
    }
    if (foundMatch === null) {
      // Live pattern matches zero lines — the gate is already vacuous on the
      // clean tree, which is a different (and worse) failure mode than what
      // this test is checking. Surface it so the operator sees it here too.
      vacuous.push({
        claim: claim.id,
        target: claim.target,
        reason: 'pattern matched zero lines on live target — gate is structurally vacuous before any mutation',
      });
      continue;
    }
    const capturedIdx = claim.captureGroup ?? 1;
    const capturedValue = foundMatch[capturedIdx];

    // Pick a stale stand-in that (a) is GUARANTEED different from the live
    // captured value AND (b) keeps the pattern matching. Appending an arbitrary
    // suffix breaks (b) — the pattern stops matching, the gate reports
    // config-error (vacuous), which is a DIFFERENT failure mode than drift.
    // For shape-typed captures (version, integer count) we substitute another
    // value of the same shape; for anything else we fall back to a suffix and
    // accept that the gate may report vacuous-config-error rather than drift.
    let staleValue;
    if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(capturedValue)) {
      staleValue = capturedValue === '0.0.0' ? '9.9.9' : '0.0.0';
    } else if (/^[0-9]+$/.test(capturedValue)) {
      staleValue = parseInt(capturedValue, 10) === 0 ? '999' : '0';
    } else {
      staleValue = `${capturedValue}-STALE`;
    }
    assert.notEqual(staleValue, capturedValue,
      `precondition: stale stand-in must differ from live value`);

    const mutatedLine = targetLines[foundIdx].replace(
      foundMatch[0],
      foundMatch[0].replace(capturedValue, staleValue),
    );
    assert.notEqual(mutatedLine, targetLines[foundIdx],
      `precondition: line mutation must change the line content`);
    const mutatedTargetLines = [...targetLines];
    mutatedTargetLines[foundIdx] = mutatedLine;
    const mutated = mutatedTargetLines.join('\n');

    for (const [target, content] of liveTargetSnapshots) {
      fx.write(target, target === claim.target ? mutated : content);
    }

    fx.write('scripts/doc-drift-patterns.json', liveCfgRaw);
    const result = await runDriftChecks({
      repoRoot: fx.dir,
      configPath: resolve(fx.dir, 'scripts/doc-drift-patterns.json'),
      checkId: sotEntry.id,
    });

    const namedTarget = (result.reports ?? []).some(
      (r) => r.severity === 'drift' && (r.file ?? '').includes(claim.target),
    );
    if (!namedTarget) {
      vacuous.push({
        claim: claim.id,
        target: claim.target,
        reason: `mutation did not fire drift naming the target (stale='${staleValue}')`,
        reports: (result.reports ?? []).map((r) => ({ severity: r.severity, message: r.message })),
      });
    }
  }

  assert.equal(
    vacuous.length,
    0,
    `Vacuous source-of-truth-cross-ref claims detected (${vacuous.length} of ${sotEntry.claims.length} claims do NOT fire drift on mutation).\n` +
    `Each vacuous claim could allow its honesty surface to drift silently between releases — exactly the failure mode this gate exists to prevent.\n` +
    `Details:\n${vacuous.map((v) => `  - ${v.claim} @ ${v.target}: ${v.reason}`).join('\n')}\n` +
    `Fix in scripts/doc-drift-patterns.json: ensure each claim's pattern + captureGroup actually anchor to a current-state assertion in its declared target. ` +
    `A pattern that matches zero lines today, OR matches but the captured value is still equal after mutation, means the gate protects nothing.`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// parseCheckId — `--check <id>` argument validation (ci-tooling-B-002)
//
// A bare `--check` (or `--check --json`) used to yield checkId=undefined and
// silently run ALL checks — an operator who fat-fingers the id gets a green
// full run and assumes their single check passed. parseCheckId fails loud
// instead, matching the sibling check-finding-regression-pins.mjs which
// validates its value-taking flags.
// ─────────────────────────────────────────────────────────────────────────────

test('parseCheckId: valid `--check <id>` returns the id', () => {
  assert.deepEqual(parseCheckId(['--check', 'error-codes']), { checkId: 'error-codes' });
});

test('parseCheckId: no `--check` flag returns undefined (run-all path)', () => {
  assert.deepEqual(parseCheckId(['--json']), { checkId: undefined });
});

test('parseCheckId: bare trailing `--check` (no id) returns an error, not undefined', () => {
  const result = parseCheckId(['--check']);
  assert.equal(result.checkId, undefined);
  assert.match(result.error, /--check requires a check id/);
});

test('parseCheckId: `--check` immediately followed by another flag returns an error', () => {
  const result = parseCheckId(['--check', '--json']);
  assert.equal(result.checkId, undefined);
  assert.match(result.error, /--check requires a check id/);
});

// ─────────────────────────────────────────────────────────────────────────────
// FT-g: command-map-count resolver + relative-offset claims.
//
// The verbCount resolver used to count `^function cmd[A-Z]` definitions, which
// is NOT the authoritative verb count — the authority is the keys of the
// `commands = { ... }` dispatch map in packages/dogfood-swarm/cli.js. The two
// happen to agree today (24 == 24), but they diverge the moment a cmd*
// function exists that isn't wired into the map, or two verbs alias one
// handler. These tests pin the resolver to the map and exercise the
// relative-count claims (sibling = total-1, "the other N" = total-K).
// ─────────────────────────────────────────────────────────────────────────────

test('FT-g: countCommandMapEntries counts the real cli.js commands map as 24', () => {
  const cliSrc = readFileSync(
    resolve(repoRoot, 'packages/dogfood-swarm/cli.js'),
    'utf8',
  );
  assert.equal(
    countCommandMapEntries(cliSrc, 'commands', 'packages/dogfood-swarm/cli.js'),
    24,
    'The authoritative verb count is the key count of the `commands` dispatch map. ' +
      'If this changed, every prose surface stating the count (and its offsets) must follow.',
  );
});

test('FT-g: command-map-count counts map keys, not cmd* function definitions', () => {
  // A source where the cmd*-function count and the map-key count DIVERGE:
  // 4 cmd functions defined, but only 3 wired into the map (cmdOrphan is a
  // private helper), plus one quoted alias key. The old `^function cmd[A-Z]`
  // resolver would report 4; the authoritative map count is 3.
  const src = [
    'function cmdAlpha() {}',
    'function cmdBeta() {}',
    'function cmdGamma() {}',
    'function cmdOrphan() {}', // defined but NOT registered
    'const commands = {',
    '  alpha: cmdAlpha,',
    "  'beta-verb': cmdBeta,", // quoted key with a hyphen
    '  gamma: cmdGamma,', // trailing comma — must not produce a phantom key
    '};',
  ].join('\n');
  assert.equal(
    countCommandMapEntries(src, 'commands', 'fixture.js'),
    3,
    'Only registered verbs count. cmdOrphan is defined but unwired; a trailing ' +
      'comma must not inflate the count; quoted hyphenated keys must count.',
  );
});

test('FT-g: command-map-count ignores braces/commas inside nested values and comments', () => {
  const src = [
    'const commands = {',
    '  a: makeHandler({ retries: 3, tags: ["x", "y"] }),', // nested object + array
    '  b: cmdB, // inline comment with a stray : colon and , comma',
    '  /* block , comment : with punctuation */',
    "  c: () => ({ ok: true }),", // arrow returning an object literal
    '};',
  ].join('\n');
  assert.equal(
    countCommandMapEntries(src, 'commands', 'fixture.js'),
    3,
    'Nested object/array literals, arrow-returned objects, and punctuation ' +
      'inside comments must not be miscounted as top-level keys.',
  );
});

test('FT-g: command-map-count throws on a missing binding (surfaces as config-error)', () => {
  assert.throws(
    () => countCommandMapEntries('const other = { a: 1 };', 'commands', 'fixture.js'),
    /binding 'commands = \{' not found/,
  );
});

test('FT-g: command-map-count resolver wires into source-of-truth-cross-ref and matches a current claim', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  fx.write('packages/dogfood-swarm/cli.js', [
    'function cmdA() {}',
    'function cmdB() {}',
    'function cmdC() {}',
    'function cmdHidden() {}', // unwired helper — old resolver would have counted 4
    'const commands = {',
    '  a: cmdA,',
    '  b: cmdB,',
    '  c: cmdC,',
    '};',
  ].join('\n'));
  fx.write('SHIP_GATE.md', '- [x] `swarm` bin documents its 3 subcommands\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        verbCount: { source: 'command-map-count', file: 'packages/dogfood-swarm/cli.js', bindingName: 'commands' },
      },
      claims: [{
        id: 'ship-gate-verb-count',
        target: 'SHIP_GATE.md',
        pattern: '`swarm` bin documents its (\\d+) subcommands',
        captureGroup: 1,
        resolver: 'verbCount',
        title: 'SHIP_GATE swarm-verb count',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('FT-g META: a deliberately-wrong verb count is caught (drift surfaces 3 vs 99)', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  fx.write('packages/dogfood-swarm/cli.js', [
    'const commands = {',
    '  a: cmdA,',
    '  b: cmdB,',
    '  c: cmdC,',
    '};',
  ].join('\n'));
  fx.write('SHIP_GATE.md', '- [x] `swarm` bin documents its 99 subcommands\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        verbCount: { source: 'command-map-count', file: 'packages/dogfood-swarm/cli.js', bindingName: 'commands' },
      },
      claims: [{
        id: 'ship-gate-verb-count',
        target: 'SHIP_GATE.md',
        pattern: '`swarm` bin documents its (\\d+) subcommands',
        captureGroup: 1,
        resolver: 'verbCount',
      }],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  const drift = result.reports.find((r) => r.severity === 'drift');
  assert.ok(drift, 'expected a drift report');
  assert.match(drift.message, /99.*3|3.*99/, 'drift must surface both the asserted and the resolved counts');
});

test('FT-g: relative-offset claims resolve total-1 (sibling) and total-K (other) correctly', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  // 5 registered verbs.
  fx.write('packages/dogfood-swarm/cli.js', [
    'const commands = {',
    '  a: cmdA, b: cmdB, c: cmdC, d: cmdD, e: cmdE,',
    '};',
  ].join('\n'));
  fx.write('total.md', 'all 5 verbs\n');
  fx.write('sibling.md', 'all 4 sibling verbs\n');     // total - 1
  fx.write('other.md', 'and the other 3 verbs\n');     // total - 2
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        verbCount: { source: 'command-map-count', file: 'packages/dogfood-swarm/cli.js', bindingName: 'commands' },
      },
      claims: [
        { id: 'total', target: 'total.md', pattern: 'all (\\d+) verbs', captureGroup: 1, resolver: 'verbCount' },
        { id: 'sibling', target: 'sibling.md', pattern: 'all (\\d+) sibling verbs', captureGroup: 1, resolver: 'verbCount', offset: -1 },
        { id: 'other', target: 'other.md', pattern: 'and the other (\\d+) verbs', captureGroup: 1, resolver: 'verbCount', offset: -2 },
      ],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, JSON.stringify(result.reports));
});

test('FT-g META: a wrong offset value drifts (sibling says total instead of total-1)', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  fx.write('packages/dogfood-swarm/cli.js', [
    'const commands = {',
    '  a: cmdA, b: cmdB, c: cmdC, d: cmdD, e: cmdE,',
    '};',
  ].join('\n'));
  // Says "all 5 sibling verbs" but the resolver-with-offset expects 4.
  fx.write('sibling.md', 'all 5 sibling verbs\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        verbCount: { source: 'command-map-count', file: 'packages/dogfood-swarm/cli.js', bindingName: 'commands' },
      },
      claims: [
        { id: 'sibling', target: 'sibling.md', pattern: 'all (\\d+) sibling verbs', captureGroup: 1, resolver: 'verbCount', offset: -1 },
      ],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  const drift = result.reports.find((r) => r.severity === 'drift');
  assert.ok(drift, 'expected a drift report');
  assert.match(drift.message, /'5'.*'4'|'4'.*'5'/, 'drift must surface the asserted (5) vs the offset-resolved (4) value');
});

test('FT-g: offset on a non-numeric resolver value reports config-error', async (t) => {
  const fx = makeFixture(t);
  fx.write('package.json', JSON.stringify({ name: 'fx', version: '9.9.9' }, null, 2));
  fx.write('doc.md', 'version 9.9.8\n');
  const cfg = fx.config({
    checks: [{
      id: 'sot',
      kind: 'source-of-truth-cross-ref',
      title: 'sot',
      resolvers: {
        version: { source: 'package-json-field', file: 'package.json', path: 'version' },
      },
      claims: [
        // Offset on a version string is nonsensical — must be a config-error.
        { id: 'bad', target: 'doc.md', pattern: 'version ([0-9.]+)', captureGroup: 1, resolver: 'version', offset: -1 },
      ],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  const cfgErr = result.reports.find((r) => r.severity === 'config-error');
  assert.ok(cfgErr, 'expected a config-error report');
  assert.match(cfgErr.message, /offset.*non-integer|non-integer.*offset/i);
});

test('FT-g LIVE: the real config\'s verbCount resolver uses command-map-count, not pattern-count', async () => {
  const config = JSON.parse(
    readFileSync(resolve(repoRoot, 'scripts/doc-drift-patterns.json'), 'utf8'),
  );
  const sot = config.checks.find((c) => c.id === 'source-of-truth-cross-ref');
  assert.ok(sot, 'source-of-truth-cross-ref check must exist');
  assert.equal(
    sot.resolvers.verbCount.source,
    'command-map-count',
    'FT-g: the verbCount resolver must count the `commands` dispatch map, not `function cmd*` definitions. ' +
      'The two can diverge; the map is the authoritative surface.',
  );
  assert.equal(sot.resolvers.verbCount.bindingName, 'commands');

  // The four prose surfaces FT-g extended coverage to must each have a claim.
  const claimTargets = sot.claims.map((c) => c.target);
  for (const surface of [
    'site/src/content/docs/handbook/index.md',
    'site/src/content/docs/handbook/cli-reference.md',
    'site/src/content/docs/handbook/swarm-history.md',
    'site/src/content/docs/handbook/operating-guide.md',
  ]) {
    assert.ok(
      claimTargets.includes(surface),
      `FT-g: ${surface} states the verb count and must be guarded by a verbCount claim.`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Wave-2 amend (ci-tooling): F-cca3ed17 / F-ae195c1d / F-1ca7b818 /
// F-1b9456a0 / F-de02ea22 — vacuity guards and fail-loud contracts for the
// framework internals. Every guard added here has a META case proving the
// gate FIRES on a mutated input (the non-vacuity discipline).
// ─────────────────────────────────────────────────────────────────────────────

test('F-cca3ed17 META: forbidden-pattern-in-targets with a zero-match target glob reports config-error, not silent green', async (t) => {
  const fx = makeFixture(t);
  // No file matches — e.g. the handbook dir was renamed out from under the glob.
  const cfg = fx.config({
    checks: [{
      id: 'no-legacy',
      kind: 'forbidden-pattern-in-targets',
      title: 'no-legacy',
      patterns: [{ regex: 'legacy', label: 'legacy ref' }],
      targets: ['docs/renamed-away/*.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false, 'zero matched targets must NOT be a silent pass — that is the D4-004 vacuous-gate class');
  const cfgErr = result.reports.find((r) => r.severity === 'config-error');
  assert.ok(cfgErr, 'expected a config-error report');
  assert.match(cfgErr.message, /no target files matched/, 'the config-error must name the unmatched globs');
});

test('F-cca3ed17: forbidden-pattern-in-targets allowEmpty escape hatch permits a zero-match glob explicitly', async (t) => {
  const fx = makeFixture(t);
  const cfg = fx.config({
    checks: [{
      id: 'no-legacy',
      kind: 'forbidden-pattern-in-targets',
      title: 'no-legacy',
      patterns: [{ regex: 'legacy', label: 'legacy ref' }],
      targets: ['docs/renamed-away/*.md'],
      allowEmpty: true,
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, 'allowEmpty:true must permit a zero-match target list (parity with schema-conformance)');
});

test('F-ae195c1d META: a `**` glob WITHOUT recursive mode is a loud config-error, not a silent single-level match', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/a/deep/nested.md', '```js\nx\n```\n');
  // untagged-fence does NOT enable opts.recursive — pre-fix, `packages/**/*.md`
  // fell through to the segmented expander where `**` degraded to a
  // single-segment wildcard, silently narrowing the gate's coverage.
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['packages/**/*.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  const cfgErr = result.reports.find((r) => r.severity === 'config-error');
  assert.ok(cfgErr, 'expected a config-error report (the handler throw surfaces as config-error)');
  assert.match(cfgErr.message, /\*\*/, 'the error must name the doublestar glob');
});

test('F-ae195c1d META: expandGlobs throws directly on `**` without opts.recursive', async (t) => {
  const fx = makeFixture(t);
  fx.write('packages/a/x.js', '');
  assert.throws(
    () => expandGlobs(['packages/**/*.js'], fx.dir),
    /\*\*/,
    '`**` without recursive mode must throw, not degrade to single-segment matching',
  );
});

test('F-ae195c1d META: a TRAILING `**` in recursive mode matches files at every depth (previously matched zero files)', async (t) => {
  const fx = makeFixture(t);
  fx.write('outputs/top.json', '{}');
  fx.write('outputs/deep/nested.json', '{}');
  fx.write('other/skip.json', '{}');
  const matched = expandGlobs(['outputs/**'], fx.dir, { recursive: true });
  assert.equal(
    matched.length,
    2,
    `'outputs/**' must match files at any depth under outputs/ — pre-fix it compiled to a regex requiring the path to END at a slash boundary and matched ZERO files. Got: ${JSON.stringify(matched)}`,
  );
});

test('F-1ca7b818 META: countCommandMapEntries throws on a ternary value at depth 1 (no phantom second key)', () => {
  const src = [
    'const commands = {',
    '  a: cmdA,',
    '  b: cond ? cmdB1 : cmdB2,',
    '  c: cmdC,',
    '};',
  ].join('\n');
  // Pre-fix this counted 4 (the ternary\'s `:` after `cmdB1` minted a phantom
  // key). The doc-comment promises unsupported shapes THROW — hold it to that.
  assert.throws(
    () => countCommandMapEntries(src, 'commands', 'fixture.js'),
    /ternary|\?/i,
    'a ternary value must throw (fail-loud), not silently over-count',
  );
});

test('F-1ca7b818 META: countCommandMapEntries throws on a method-shorthand entry at depth 1 (no silent undercount)', () => {
  const src = [
    'const commands = {',
    '  a: cmdA,',
    '  b(args) { return args; },',
    '  c: cmdC,',
    '};',
  ].join('\n');
  // Pre-fix this counted 2 — the shorthand entry has no depth-1 `:` and was
  // silently skipped, so the R9 verb-count claims would drift-fail with a
  // misleading count (or coincidentally still match).
  assert.throws(
    () => countCommandMapEntries(src, 'commands', 'fixture.js'),
    /method|shorthand/i,
    'a method-shorthand entry must throw (fail-loud), not silently under-count',
  );
});

test('F-1ca7b818: value-position call expressions and arrows still count correctly (no false throw)', () => {
  const src = [
    'const commands = {',
    '  a: wrap(cmdA),',
    '  b: (args) => run(args),',
    '  c: cmdC,',
    '};',
  ].join('\n');
  assert.equal(countCommandMapEntries(src, 'commands', 'fixture.js'), 3);
});

test('F-1b9456a0 META: schema-conformance refuses a silent downgrade when Ajv is unavailable (config-error by default)', async (t) => {
  const fx = makeFixture(t);
  fx.write('schema.json', JSON.stringify({ type: 'object', required: ['domain'] }));
  fx.write('out/good.json', JSON.stringify({ domain: 'x' }));
  const cfg = fx.config({
    checks: [{
      id: 'conformance',
      kind: 'schema-conformance',
      title: 'conformance',
      schema: 'schema.json',
      targets: ['out/*.json'],
      // Test lever: point the Ajv import at a module that cannot resolve, the
      // same failure shape as node_modules corruption / a dep restructure.
      ajvModule: './this-module-does-not-exist.js',
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false, 'Ajv-unavailable must NOT silently run the weaker structural validator');
  const cfgErr = result.reports.find((r) => r.severity === 'config-error');
  assert.ok(cfgErr, 'expected a config-error report');
  assert.match(cfgErr.message, /Ajv unavailable/i);
});

test('F-1b9456a0: allowStructuralFallback:true opts into the degraded validator explicitly (and it still catches missing required)', async (t) => {
  const fx = makeFixture(t);
  fx.write('schema.json', JSON.stringify({ type: 'object', required: ['domain'] }));
  fx.write('out/good.json', JSON.stringify({ domain: 'x' }));
  fx.write('out/bad.json', JSON.stringify({ nope: true }));
  const cfg = fx.config({
    checks: [{
      id: 'conformance',
      kind: 'schema-conformance',
      title: 'conformance',
      schema: 'schema.json',
      targets: ['out/*.json'],
      ajvModule: './this-module-does-not-exist.js',
      allowStructuralFallback: true,
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false, 'bad.json must still drift under the structural validator');
  const drift = result.reports.find((r) => r.severity === 'drift');
  assert.ok(drift);
  assert.match(drift.file, /out\/bad\.json/);
  assert.equal(result.reports.length, 1, 'good.json must pass; only bad.json drifts');
});

test('F-de02ea22 META: an untagged fence indented inside a list item is flagged (previously invisible to the column-0 state machine)', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/list.md', [
    '# Doc',
    '',
    '- step one:',
    '',
    '  ```',       // line 5 — untagged opener, indented list continuation
    '  code',
    '  ```',
    '',
    '- step two:',
    '',
    '  ```js',     // tagged — fine
    '  more',
    '  ```',
    '',
  ].join('\n'));
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['docs/list.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false, 'the indented untagged opener must be flagged');
  assert.equal(result.reports.length, 1, `only the untagged opener should surface: ${JSON.stringify(result.reports)}`);
  assert.match(result.reports[0].file, /docs\/list\.md:5/, 'drift must anchor to the opener line');
});

test('F-de02ea22: a fence opened directly on a list-marker line (`- ```) is flagged when untagged', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/marker.md', [
    '- ```',    // line 1 — untagged opener on the marker line
    '  x',
    '  ```',
    '- ```sh',  // tagged on marker line — fine
    '  y',
    '  ```',
    '',
  ].join('\n'));
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['docs/marker.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false);
  assert.equal(result.reports.length, 1, JSON.stringify(result.reports));
  assert.match(result.reports[0].file, /docs\/marker\.md:1/);
});

test('F-1c99c064 META: a four-backtick fence wrapping bare ``` examples closes correctly and does not false-flag the inner lines', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/nested.md', [
    '# Doc',            // line 1
    '',
    '````markdown',     // line 3 — tagged 4-backtick opener (the CommonMark way to SHOW fences)
    '```',              // line 4 — CONTENT (an example fence), not an opener
    'example fence',
    '```',              // line 6 — content, not a closer of the outer block
    '````',             // line 7 — the real closer (>= opener length)
    '',
    '```',              // line 9 — a REAL untagged opener after the block
    'untagged real fence',
    '```',              // line 11 — its closer
    '',
  ].join('\n'));
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['docs/nested.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, false, 'the real untagged opener at line 9 must surface');
  assert.equal(
    result.reports.length,
    1,
    `exactly ONE drift expected — the pre-fix state machine could not close the 4-backtick block, so it false-flagged the inner example lines and went blind to everything after: ${JSON.stringify(result.reports)}`,
  );
  assert.match(result.reports[0].file, /docs\/nested\.md:9$/, 'drift must anchor to the real opener, not the example lines inside the 4-backtick block');
});

test('F-1c99c064: an opener whose info string contains a backtick is not a fence (CommonMark)', async (t) => {
  const fx = makeFixture(t);
  fx.write('docs/notafence.md', [
    '# Doc',
    '',
    '``` `weird` ```',  // info string contains backticks — NOT a fence opener per CommonMark
    '',
    '```js',            // real tagged fence — must still be tracked normally
    'code',
    '```',
    '',
  ].join('\n'));
  const cfg = fx.config({
    checks: [{
      id: 'fences',
      kind: 'untagged-fence',
      title: 'fences',
      targets: ['docs/notafence.md'],
    }],
  });
  const result = await runDriftChecks({ repoRoot: fx.dir, configPath: cfg });
  assert.equal(result.clean, true, `a backtick-bearing info string must not open a fence (and must not trip state for the real fence below): ${JSON.stringify(result.reports)}`);
});
