/**
 * Regression tests for scripts/check-doc-drift.mjs.
 *
 * Why this lives at the root scripts/ tree: same reason as sync-version.test.mjs
 * — the script isn't owned by any workspace package and we don't want to grow
 * a pseudo-workspace just to host it. Run via `npm run test:scripts` (also
 * wired in CI right after `npm ci`).
 *
 * Coverage:
 *   1. Each of the 5 checks in scripts/doc-drift-patterns.json with a clean
 *      fixture and a drift fixture.
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
import { runDriftChecks, expandGlobs } from './check-doc-drift.mjs';

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

test('LIVE TREE: actual repo passes all 6 drift checks (post-wave-18 docs + post-wave-19 PROTOCOL.md sweep + post-wave-23 fence-lang-tag sweep)', async () => {
  const result = await runDriftChecks({ repoRoot });
  assert.equal(
    result.clean,
    true,
    `Expected zero drift. Got ${result.reports.length} report(s):\n` +
      result.reports
        .map((r) => `  ${r.severity}: ${r.message}\n    hint: ${r.hint ?? '(none)'}`)
        .join('\n')
  );
  // Sanity: we should be running all six checks, not zero. The sixth check
  // (handbook-fence-lang-tags) was added in wave 23 / D-CI-001 to make
  // F-827321-010 (untagged code fences in handbook reference pages) impossible
  // to recur — every opening ``` in site/src/content/docs/handbook/*.md must
  // carry a language tag.
  assert.equal(result.checksRun, 6);
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
