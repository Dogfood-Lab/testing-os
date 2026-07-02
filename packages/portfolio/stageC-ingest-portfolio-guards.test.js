/**
 * stageC-ingest-portfolio-guards.test.js
 *
 * Stage C (humanization) — three portfolio-generator IO/legibility guards.
 * Each guard's failure must HELP the operator: name the offending file/path
 * AND the recovery action, via the package's existing structured channels
 * (console.warn for per-file degradation, a structured exit-1 message for the
 * corrupt-index CLI branch). A bare silent try/catch is NOT the fix.
 *
 *   d3-ingest-B001 — loadPoliciesFromOrgDir's readFileSync sat OUTSIDE the
 *     try/catch that wraps yaml.load. Only PARSE failure was tolerated; a
 *     read-time IO error (EACCES/EBUSY/EISDIR/transient lock) on a single
 *     policy YAML propagated up and dropped ALL repos from the portfolio.
 *     Fix: the read joins the parse-failure path — one bad file → continue +
 *     a console.warn naming the file, matching loadRecord's one-bad-file
 *     tolerance in rebuild-indexes.js.
 *
 *   d3-ingest-B002 — main() guarded a MISSING index (existsSync → clean
 *     message + exit 1) but JSON.parse(readFileSync(INDEX_PATH)) had no guard
 *     for a CORRUPT/truncated index. A crash-mid-write left the operator with
 *     a raw `SyntaxError: Unexpected end of JSON input` and no hint. Fix: a
 *     try/catch printing a structured message naming INDEX_PATH + the recovery
 *     action ('re-run any ingest to rebuild indexes/ — idempotent'), then
 *     process.exit(1), mirroring the existsSync branch above it.
 *
 *   d3-ingest-B003 — ALL_SURFACES was a hand-maintained duplicate of the
 *     authoritative product_surface enum in
 *     dogfood-record-submission.schema.json, with no drift gate. A future
 *     schema-added surface would be silently dropped by parsePolicy and shrink
 *     the coverage denominator. Fix: derive ALL_SURFACES from the schema enum
 *     via createRequire on @dogfood-lab/schemas's `./json/*` subpath export —
 *     the same single-source-of-truth seam dogfood-swarm/lib/templates.js uses.
 *
 * Lens: every degradation path emits a structured, greppable, file-naming
 * signal; the corrupt-index CLI fails CLOSED with a recovery hint, never a raw
 * stack.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { loadPolicies } from './generate.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const GENERATE_JS = resolve(__dirname, 'generate.js');

// ── d3-ingest-B001 — per-file read-time IO error degrades to skip, not abort ──
//
// The read sits in loadPoliciesFromOrgDir. We trigger a genuine read-time IO
// error WITHOUT a permission trick (which is unreliable on Windows): a policy
// entry whose name ends in `.yaml` but is a DIRECTORY makes readFileSync throw
// EISDIR — exactly the read-time-failure class (EACCES/EBUSY/lock) the finding
// is about, distinct from a YAML *parse* error. Pre-fix this propagated out of
// loadPoliciesFromOrgDir and blanked the whole portfolio; post-fix it skips the
// one offending file and the healthy sibling policy still loads.
describe('loadPolicies per-file read-IO tolerance (d3-ingest-B001)', () => {
  function captureWarn(fn) {
    const messages = [];
    const orig = console.warn;
    console.warn = (...args) => messages.push(args.map(String).join(' '));
    try {
      return { result: fn(), messages };
    } finally {
      console.warn = orig;
    }
  }

  it('POSITIVE: an unreadable policy YAML is skipped, healthy siblings still load, warn names the file', () => {
    const root = mkdtempSync(join(tmpdir(), 'stageC-b001-'));
    try {
      const orgDir = join(root, 'mcp-tool-shop-org');
      mkdirSync(orgDir, { recursive: true });

      // Healthy sibling policy — must survive the bad neighbour.
      writeFileSync(join(orgDir, 'healthy.yaml'), [
        'repo: mcp-tool-shop-org/healthy',
        'enforcement:',
        '  mode: required',
        'surfaces:',
        '  cli:',
        '    required_scenarios: [self-gate]',
        '    freshness:',
        '      max_age_days: 14',
        '      warn_age_days: 7',
        '',
      ].join('\n'));

      // The offending entry: name ends in .yaml but it's a DIRECTORY, so
      // readFileSync throws EISDIR (a read-time IO error, NOT a parse error).
      mkdirSync(join(orgDir, 'unreadable.yaml'));

      const { result: policies, messages } = captureWarn(() => loadPolicies(root));

      // The healthy sibling must still be present — the whole portfolio must
      // NOT be blanked by the one bad file.
      assert.ok(policies['mcp-tool-shop-org/healthy'],
        'healthy policy must survive a sibling read-IO failure (was: whole portfolio aborted)');

      // The bad file must not have crashed the load.
      assert.equal(typeof policies, 'object');

      // The operator must be told WHICH file was skipped (humanization lens).
      const warn = messages.find(m => m.includes('unreadable.yaml'));
      assert.ok(warn,
        `a warn must name the skipped policy file; got messages=${JSON.stringify(messages)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a fully-healthy org dir loads every policy and emits no skip warn', () => {
    const root = mkdtempSync(join(tmpdir(), 'stageC-b001-ok-'));
    try {
      const orgDir = join(root, 'mcp-tool-shop-org');
      mkdirSync(orgDir, { recursive: true });
      writeFileSync(join(orgDir, 'a.yaml'), [
        'repo: mcp-tool-shop-org/a',
        'enforcement:',
        '  mode: required',
        'surfaces:',
        '  cli:',
        '    required_scenarios: [s]',
        '    freshness:',
        '      max_age_days: 14',
        '      warn_age_days: 7',
        '',
      ].join('\n'));
      writeFileSync(join(orgDir, 'b.yaml'), [
        'repo: mcp-tool-shop-org/b',
        'enforcement:',
        '  mode: required',
        'surfaces:',
        '  desktop:',
        '    required_scenarios: [t]',
        '    freshness:',
        '      max_age_days: 30',
        '      warn_age_days: 14',
        '',
      ].join('\n'));

      const { result: policies, messages } = captureWarn(() => loadPolicies(root));
      assert.ok(policies['mcp-tool-shop-org/a']);
      assert.ok(policies['mcp-tool-shop-org/b']);
      const skipWarn = messages.find(m => /skip|unreadable|could not read/i.test(m));
      assert.ok(!skipWarn,
        `healthy dir must emit no skip warn; got messages=${JSON.stringify(messages)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── d3-ingest-B002 — corrupt index → structured exit-1 message, not raw stack ─
//
// main() reads INDEX_PATH and JSON.parse's it. We run generate.js as a
// subprocess with PORTFOLIO_REPO_ROOT pointed at a sandbox so the test never
// touches the REAL indexes/ tree, seed a corrupt index, and assert the
// operator gets a structured message naming the index path + recovery action,
// plus exit code 1 — NOT a raw `SyntaxError: Unexpected end of JSON input`.
describe('portfolio CLI corrupt-index legibility (d3-ingest-B002)', () => {
  function runCli(repoRoot) {
    try {
      const stdout = execFileSync(process.execPath, [GENERATE_JS], {
        env: { ...process.env, PORTFOLIO_REPO_ROOT: repoRoot },
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        code: err.status ?? 1,
        stdout: err.stdout ? err.stdout.toString() : '',
        stderr: err.stderr ? err.stderr.toString() : '',
      };
    }
  }

  function seedSandbox({ indexContent }) {
    const root = mkdtempSync(join(tmpdir(), 'stageC-b002-'));
    mkdirSync(join(root, 'indexes'), { recursive: true });
    mkdirSync(join(root, 'policies', 'repos'), { recursive: true });
    writeFileSync(join(root, 'indexes', 'latest-by-repo.json'), indexContent, 'utf-8');
    return root;
  }

  it('POSITIVE: a truncated/corrupt index exits 1 with a message naming INDEX_PATH + recovery', () => {
    // Truncated JSON — the classic crash-mid-write shape.
    const root = seedSandbox({ indexContent: '{ "org/repo": { "cli": ' });
    try {
      const { code, stderr } = runCli(root);
      assert.equal(code, 1, `corrupt index must exit 1; stderr=${stderr}`);
      assert.ok(stderr.includes('latest-by-repo.json'),
        `error must name the index file; got stderr=${stderr}`);
      // Recovery action must be present (humanization lens).
      assert.ok(/re-?run|ingest|rebuild/i.test(stderr),
        `error must state the recovery action (re-run ingest to rebuild); got stderr=${stderr}`);
      // Must NOT be a raw uncaught stack.
      assert.ok(!/^\s*at\s+.*\(.*:\d+:\d+\)/m.test(stderr) || /re-?run|ingest|rebuild/i.test(stderr),
        `corrupt index must produce a structured message, not a raw stack; got stderr=${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a healthy (empty) index generates a portfolio with exit 0', () => {
    const root = seedSandbox({ indexContent: '{}\n' });
    try {
      const { code, stdout, stderr } = runCli(root);
      assert.equal(code, 0, `healthy index must exit 0; stderr=${stderr}`);
      assert.ok(/Portfolio generated/i.test(stdout),
        `healthy run must report generation; got stdout=${stdout}`);
      // And it wrote into the sandbox, not the real tree.
      const out = readFileSync(join(root, 'reports', 'dogfood-portfolio.json'), 'utf-8');
      const parsed = JSON.parse(out);
      assert.equal(parsed.coverage.total_repos, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('NEGATIVE: a MISSING index still exits 1 with the existing clean message', () => {
    // Sandbox with NO indexes/latest-by-repo.json — the pre-existing
    // existsSync branch must continue to fire (regression guard).
    const root = mkdtempSync(join(tmpdir(), 'stageC-b002-missing-'));
    mkdirSync(join(root, 'policies', 'repos'), { recursive: true });
    try {
      const { code, stderr } = runCli(root);
      assert.equal(code, 1, `missing index must exit 1; stderr=${stderr}`);
      assert.ok(/Index not found/i.test(stderr),
        `missing index must keep its existing message; got stderr=${stderr}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── d3-ingest-B003 — ALL_SURFACES derived from schema, drift-sealed ──────────
//
// The portfolio's ALL_SURFACES must equal the authoritative product_surface
// enum in dogfood-record-submission.schema.json. We read the enum the SAME way
// the production code now does (createRequire on the `./json/*` export) and
// assert the portfolio's derived list deep-equals it. This goes RED the moment
// the schema adds a surface that a hand-maintained array would miss — the drift
// the finding is about.
describe('ALL_SURFACES schema-derivation drift seal (d3-ingest-B003)', () => {
  const require = createRequire(import.meta.url);

  function schemaSurfaces() {
    const schemaPath = require.resolve(
      '@dogfood-lab/schemas/json/dogfood-record-submission.schema.json'
    );
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    return schema.properties.scenario_results.items.properties.product_surface.enum;
  }

  it('coverage.surfaces_total equals the schema enum length (no hand-drift)', async () => {
    const { generatePortfolio } = await import('./generate.js?b003-' + Date.now());
    const portfolio = generatePortfolio({}, {});
    const expected = schemaSurfaces();
    assert.equal(portfolio.coverage.surfaces_total, expected.length,
      `surfaces_total must equal the schema enum length (${expected.length}); ` +
      `a hand-maintained array would drift when the schema adds a surface`);
  });

  it('parsePolicy accepts EVERY surface name in the schema enum', async () => {
    const { parsePolicy } = await import('./generate.js?b003b-' + Date.now());
    const expected = schemaSurfaces();
    // Build a policy that declares all schema surfaces; every one must survive
    // the ALL_SURFACES gate in parsePolicy. A hand-maintained list missing a
    // future surface would silently drop it here.
    const lines = ['repo: org/all-surfaces', 'enforcement:', '  mode: required', 'surfaces:'];
    for (const s of expected) {
      lines.push(`  ${s}:`);
      lines.push('    required_scenarios: [s]');
      lines.push('    freshness:');
      lines.push('      max_age_days: 14');
      lines.push('      warn_age_days: 7');
    }
    const policy = parsePolicy(lines.join('\n') + '\n');
    assert.deepEqual(Object.keys(policy.surfaces).sort(), [...expected].sort(),
      `parsePolicy must accept every schema surface; dropped: ` +
      `${expected.filter(s => !(s in policy.surfaces)).join(', ')}`);
  });
});
