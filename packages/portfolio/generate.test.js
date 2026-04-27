import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generatePortfolio, computeFreshnessDays, parsePolicy, loadPolicies } from './generate.js';

const REPORT_PATH = resolve(import.meta.dirname, '..', '..', 'reports', 'dogfood-portfolio.json');

const freshDate = new Date(Date.now() - 2 * 86400000).toISOString(); // 2 days ago
const staleDate = new Date(Date.now() - 60 * 86400000).toISOString(); // 60 days ago

const sampleIndex = {
  'mcp-tool-shop-org/shipcheck': {
    cli: {
      run_id: 'shipcheck-1-1',
      verified: 'pass',
      verification_status: 'accepted',
      finished_at: freshDate,
      path: 'records/mcp-tool-shop-org/shipcheck/run-shipcheck-1-1.json',
    },
  },
  'mcp-tool-shop-org/glyphstudio': {
    desktop: {
      run_id: 'glyphstudio-1-1',
      verified: 'pass',
      verification_status: 'accepted',
      finished_at: staleDate,
      path: 'records/mcp-tool-shop-org/glyphstudio/run-glyphstudio-1-1.json',
    },
  },
};

const samplePolicies = {
  'mcp-tool-shop-org/shipcheck': {
    enforcement: { mode: 'required', reason: null, review_after: null },
    surfaces: {
      cli: { scenario: 'self-gate-real-repo', max_age_days: 14, warn_age_days: 7 },
    },
  },
  'mcp-tool-shop-org/glyphstudio': {
    enforcement: { mode: 'required', reason: null, review_after: null },
    surfaces: {
      desktop: { scenario: 'export-roundtrip-16x16', max_age_days: 30, warn_age_days: 14 },
    },
  },
  'mcp-tool-shop-org/missing-repo': {
    enforcement: { mode: 'warn-only', reason: 'new repo', review_after: null },
    surfaces: {
      cli: { scenario: 'test-scenario', max_age_days: 30, warn_age_days: 14 },
    },
  },
};

describe('computeFreshnessDays', () => {
  it('returns 0 for now', () => {
    assert.equal(computeFreshnessDays(new Date().toISOString()), 0);
  });

  it('returns correct days for past date', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    assert.equal(computeFreshnessDays(threeDaysAgo), 3);
  });
});

describe('generatePortfolio', () => {
  it('produces correct coverage counts', () => {
    const result = generatePortfolio(sampleIndex, samplePolicies);
    assert.equal(result.coverage.total_repos, 2);
    assert.equal(result.coverage.surfaces_covered, 2); // cli + desktop
    assert.equal(result.coverage.surfaces_total, 8);
  });

  it('includes all repos from index', () => {
    const result = generatePortfolio(sampleIndex, samplePolicies);
    const repos = result.repos.map(r => r.repo);
    assert.ok(repos.includes('mcp-tool-shop-org/shipcheck'));
    assert.ok(repos.includes('mcp-tool-shop-org/glyphstudio'));
  });

  it('populates entry fields correctly', () => {
    const result = generatePortfolio(sampleIndex, samplePolicies);
    const shipcheck = result.repos.find(r => r.repo.includes('shipcheck'));
    assert.equal(shipcheck.surface, 'cli');
    assert.equal(shipcheck.verified, 'pass');
    assert.equal(shipcheck.enforcement, 'required');
    assert.equal(shipcheck.scenario, 'self-gate-real-repo');
    assert.equal(shipcheck.run_id, 'shipcheck-1-1');
    assert.ok(shipcheck.freshness_days <= 2);
  });

  it('detects stale repos', () => {
    const result = generatePortfolio(sampleIndex, samplePolicies);
    assert.equal(result.stale.length, 1);
    assert.equal(result.stale[0].repo, 'mcp-tool-shop-org/glyphstudio');
    assert.ok(result.stale[0].freshness_days >= 59);
  });

  it('detects missing repos (policy but no index entry)', () => {
    const result = generatePortfolio(sampleIndex, samplePolicies);
    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].repo, 'mcp-tool-shop-org/missing-repo');
    assert.equal(result.missing[0].surface, 'cli');
    assert.equal(result.missing[0].enforcement, 'warn-only');
  });

  it('handles empty index', () => {
    const result = generatePortfolio({}, samplePolicies);
    assert.equal(result.coverage.total_repos, 0);
    assert.equal(result.missing.length, 3); // all 3 surfaces from policies
  });

  it('handles empty policies', () => {
    const result = generatePortfolio(sampleIndex, {});
    assert.equal(result.coverage.total_repos, 2);
    assert.equal(result.stale.length, 1); // glyphstudio at 60d > default 30d
    assert.equal(result.missing.length, 0);
  });

  it('defaults enforcement to required when no policy', () => {
    const result = generatePortfolio(sampleIndex, {});
    const shipcheck = result.repos.find(r => r.repo.includes('shipcheck'));
    assert.equal(shipcheck.enforcement, 'required');
  });

  it('includes generatedAt timestamp', () => {
    const result = generatePortfolio(sampleIndex, samplePolicies);
    assert.ok(result.generatedAt);
    assert.ok(new Date(result.generatedAt).getTime() > 0);
  });
});

// F-882513-001 — surface required_scenarios must capture ALL list items, not just the first
describe('parsePolicy required_scenarios (F-882513-001)', () => {
  it('captures all required_scenarios entries (>1) for a surface', () => {
    const yaml = [
      'repo: org/example',
      'enforcement:',
      '  mode: required',
      'surfaces:',
      '  cli:',
      '    required_scenarios:',
      '      - scenario_a',
      '      - scenario_b',
      '      - scenario_c',
      '    max_age_days: 14',
      '    warn_age_days: 7',
      ''
    ].join('\n');

    const policy = parsePolicy(yaml);
    const scenarios = policy.surfaces.cli.scenarios;
    assert.ok(Array.isArray(scenarios), 'surface.scenarios should be an array');
    assert.deepEqual(scenarios, ['scenario_a', 'scenario_b', 'scenario_c']);
  });

  it('still captures a single required_scenarios entry as one-item array', () => {
    const yaml = [
      'repo: org/example',
      'enforcement:',
      '  mode: required',
      'surfaces:',
      '  cli:',
      '    required_scenarios:',
      '      - only_scenario',
      '    max_age_days: 14',
      '    warn_age_days: 7',
      ''
    ].join('\n');

    const policy = parsePolicy(yaml);
    assert.deepEqual(policy.surfaces.cli.scenarios, ['only_scenario']);
  });

  it('preserves backward-compat scenario field as the first item', () => {
    const yaml = [
      'repo: org/example',
      'enforcement:',
      '  mode: required',
      'surfaces:',
      '  cli:',
      '    required_scenarios:',
      '      - scenario_a',
      '      - scenario_b',
      '    max_age_days: 14',
      '    warn_age_days: 7',
      ''
    ].join('\n');

    const policy = parsePolicy(yaml);
    assert.equal(policy.surfaces.cli.scenario, 'scenario_a');
  });
});

// ── F-246817-003 — replace regex YAML parser with js-yaml ───────────────
//
// Pre-fix the regex parser produced silent-failure modes the audit found:
// non-numeric max_age_days became NaN, enforcement.reason could leak from a
// sibling block's `reason:` line, etc. js-yaml is the real parser; these
// tests pin the cases the regex got wrong.
describe('parsePolicy real-YAML semantics (F-246817-003)', () => {
  it('non-numeric max_age_days falls back to DEFAULT_MAX_AGE rather than NaN', () => {
    const yamlText = [
      'repo: org/example',
      'enforcement:',
      '  mode: required',
      'surfaces:',
      '  cli:',
      '    required_scenarios:',
      '      - test_a',
      '    max_age_days: not-a-number',
      '    warn_age_days: 7',
      ''
    ].join('\n');

    const policy = parsePolicy(yamlText);
    assert.equal(policy.surfaces.cli.max_age_days, 30);
    assert.ok(Number.isFinite(policy.surfaces.cli.max_age_days),
      'max_age_days must be a finite number, never NaN');
  });

  it('enforcement.reason is scoped to the enforcement block (no leakage)', () => {
    // Pre-fix the regex `enforcement:[\s\S]*?reason:\s*(.+)` would match the
    // FIRST `reason:` line anywhere in the file, including ones inside a
    // surfaces block or a sibling top-level key.
    const yamlText = [
      'repo: org/example',
      'enforcement:',
      '  mode: required',
      'surfaces:',
      '  cli:',
      '    required_scenarios:',
      '      - scenario_with_reason',
      '    max_age_days: 14',
      '    warn_age_days: 7',
      '    reason: this-is-a-surface-level-note',
      ''
    ].join('\n');

    const policy = parsePolicy(yamlText);
    assert.equal(policy.enforcement.reason, null,
      `enforcement.reason should be null, got ${JSON.stringify(policy.enforcement.reason)}`);
  });

  it('unknown surface names are dropped (intentional, ALL_SURFACES gate)', () => {
    const yamlText = [
      'repo: org/example',
      'enforcement:',
      '  mode: required',
      'surfaces:',
      '  unknown-surface:',
      '    required_scenarios:',
      '      - whatever',
      '    max_age_days: 14',
      '    warn_age_days: 7',
      '  cli:',
      '    required_scenarios:',
      '      - real_scenario',
      '    max_age_days: 14',
      '    warn_age_days: 7',
      ''
    ].join('\n');

    const policy = parsePolicy(yamlText);
    assert.deepEqual(Object.keys(policy.surfaces), ['cli']);
  });

  it('returns empty policy for malformed YAML (no crash)', () => {
    const policy = parsePolicy('::not: valid: yaml: at: all:::');
    assert.deepEqual(Object.keys(policy.surfaces), []);
    assert.equal(policy.enforcement.mode, 'required');
  });
});

// ── F-246817-005 — computeFreshnessDays returns null, propagates safely ──
describe('computeFreshnessDays unparseable input (F-246817-005)', () => {
  it('returns null for undefined input (was Infinity)', () => {
    assert.equal(computeFreshnessDays(undefined), null);
  });

  it('returns null for non-date string (was Infinity)', () => {
    assert.equal(computeFreshnessDays('not-a-date'), null);
  });

  it('JSON-serializes as null without an Infinity-via-stringify trap', () => {
    const json = JSON.stringify({ d: computeFreshnessDays(undefined) });
    assert.equal(json, '{"d":null}');
  });
});

describe('generatePortfolio unknown_freshness bucket (F-246817-005)', () => {
  it('routes corrupt finished_at into unknown_freshness, not stale', () => {
    const corruptIndex = {
      'org/corrupt-repo': {
        cli: {
          run_id: 'corrupt-1',
          verified: 'pass',
          finished_at: 'not-a-real-date',
        },
      },
    };
    // Suppress the warn() call so test output stays clean.
    const silentLogger = { warn: () => {} };
    const result = generatePortfolio(corruptIndex, {}, { logger: silentLogger });

    assert.equal(result.unknown_freshness.length, 1);
    assert.equal(result.unknown_freshness[0].repo, 'org/corrupt-repo');
    assert.equal(result.unknown_freshness[0].surface, 'cli');
    assert.equal(result.stale.length, 0,
      'corrupt freshness must NOT silently flag entry as stale');

    const entry = result.repos.find(r => r.repo === 'org/corrupt-repo');
    assert.equal(entry.freshness_days, null,
      'freshness_days must be null (not Infinity) so JSON round-trips cleanly');
  });

  it('emits a warning when an entry is routed to unknown_freshness', () => {
    const corruptIndex = {
      'org/corrupt-repo': {
        cli: { run_id: 'x', verified: 'pass', finished_at: undefined },
      },
    };
    const messages = [];
    const captureLogger = { warn: (msg) => messages.push(String(msg)) };
    generatePortfolio(corruptIndex, {}, { logger: captureLogger });
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes('org/corrupt-repo'),
      `warning should name the repo: ${messages[0]}`);
  });
});

// ── F-721047-004 — multi-org enumeration ────────────────────────────────
//
// Pre-fix POLICIES_DIR was hardcoded to `policies/repos/mcp-tool-shop-org`.
// The README threat model documents dispatches from BOTH `mcp-tool-shop-org/*`
// AND `dogfood-lab/*` as valid, so any dogfood-lab/* policy file (including
// the obvious testing-os self-submission) was silently invisible to the
// portfolio generator. Post-fix loadPolicies enumerates every per-org subdir
// under policies/repos/ at runtime; new orgs are auto-picked-up.
describe('loadPolicies multi-org enumeration (F-721047-004)', () => {
  it('discovers policies across multiple org dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'portfolio-multi-org-'));
    try {
      // Two org dirs, each with one policy yaml — exactly the shape the
      // production policies/repos/ tree will have once dogfood-lab/* onboards.
      const orgA = join(root, 'mcp-tool-shop-org');
      const orgB = join(root, 'dogfood-lab');
      mkdirSync(orgA, { recursive: true });
      mkdirSync(orgB, { recursive: true });

      writeFileSync(join(orgA, 'shipcheck.yaml'), [
        'repo: mcp-tool-shop-org/shipcheck',
        'enforcement:',
        '  mode: required',
        'surfaces:',
        '  cli:',
        '    required_scenarios: [self-gate-real-repo]',
        '    max_age_days: 14',
        '    warn_age_days: 7',
        ''
      ].join('\n'));

      writeFileSync(join(orgB, 'testing-os.yaml'), [
        'repo: dogfood-lab/testing-os',
        'enforcement:',
        '  mode: required',
        'surfaces:',
        '  cli:',
        '    required_scenarios: [ingest-roundtrip]',
        '    max_age_days: 30',
        '    warn_age_days: 14',
        ''
      ].join('\n'));

      const policies = loadPolicies(root);

      assert.ok(policies['mcp-tool-shop-org/shipcheck'],
        'mcp-tool-shop-org/shipcheck policy should be discovered');
      assert.ok(policies['dogfood-lab/testing-os'],
        'dogfood-lab/testing-os policy should be discovered (was invisible pre-fix)');
      assert.equal(policies['dogfood-lab/testing-os'].surfaces.cli.scenario,
        'ingest-roundtrip');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dogfood-lab/testing-os self-submission appears in portfolio output', () => {
    const root = mkdtempSync(join(tmpdir(), 'portfolio-self-'));
    try {
      const orgB = join(root, 'dogfood-lab');
      mkdirSync(orgB, { recursive: true });
      writeFileSync(join(orgB, 'testing-os.yaml'), [
        'repo: dogfood-lab/testing-os',
        'enforcement:',
        '  mode: required',
        'surfaces:',
        '  cli:',
        '    required_scenarios: [self]',
        '    max_age_days: 30',
        '    warn_age_days: 14',
        ''
      ].join('\n'));

      const policies = loadPolicies(root);
      const index = {
        'dogfood-lab/testing-os': {
          cli: {
            run_id: 'self-1',
            verified: 'pass',
            finished_at: new Date(Date.now() - 86400000).toISOString(),
          },
        },
      };
      const portfolio = generatePortfolio(index, policies);
      const entry = portfolio.repos.find(r => r.repo === 'dogfood-lab/testing-os');
      assert.ok(entry, 'dogfood-lab/testing-os should appear in portfolio repos');
      assert.equal(entry.scenario, 'self',
        'scenario should resolve from the dogfood-lab policy, not be null');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still works for a single-org dir (legacy callers)', () => {
    const root = mkdtempSync(join(tmpdir(), 'portfolio-single-'));
    try {
      // Yaml files directly under the dir (no subdirs) = legacy single-org shape.
      writeFileSync(join(root, 'one.yaml'), [
        'repo: only-org/one',
        'enforcement:',
        '  mode: required',
        'surfaces:',
        '  cli:',
        '    required_scenarios: [a]',
        '    max_age_days: 14',
        '    warn_age_days: 7',
        ''
      ].join('\n'));
      const policies = loadPolicies(root);
      assert.ok(policies['only-org/one'],
        'single-org-dir callers should still see their policies');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// F-002109-016 — importing this module must NOT execute main() as a side effect.
// Pre-fix, `import './generate.js'` triggered a full CLI run: it walked the policies
// dir and overwrote reports/dogfood-portfolio.json (visible as an mtime bump on every
// `npm test`). Worse, on a checkout without indexes/latest-by-repo.json it called
// process.exit(1) and killed the test process before any assertions ran.
describe('module-import side effects (F-002109-016)', () => {
  it('does not mutate reports/dogfood-portfolio.json when imported', async () => {
    if (!existsSync(REPORT_PATH)) {
      // If the artifact does not exist on disk, the only thing the test can assert
      // is that the import itself does not create one. This is also the fresh-clone
      // case where the pre-fix code would have called process.exit(1) instead.
      await import('./generate.js?fresh-clone-' + Date.now());
      assert.equal(existsSync(REPORT_PATH), false,
        'fresh import should not create reports/dogfood-portfolio.json');
      return;
    }

    const before = statSync(REPORT_PATH).mtimeMs;
    // Cache-busting query param forces Node to re-evaluate the module so any
    // top-level side effects would fire again, exactly like the pre-fix bug.
    await import('./generate.js?side-effect-check-' + Date.now());
    const after = statSync(REPORT_PATH).mtimeMs;

    assert.equal(after, before,
      `importing generate.js mutated ${REPORT_PATH} (mtime ${before} -> ${after}) — main() ran on import`);
  });
});
