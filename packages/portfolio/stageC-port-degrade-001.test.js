/**
 * stageC-port-degrade-001.test.js
 *
 * Stage C (humanization) — PORT-DEGRADE-001.
 *
 * A valid-JSON-but-wrong-SHAPE index must not crash the portfolio with a raw
 * TypeError. Two complementary defenses, mirroring how the package already
 * handles a corrupt index (B002, top-level) and how loadPolicies/computeTrends
 * degrade one bad entry to a skip + named warn:
 *
 *   1. main() — after JSON.parse, a non-object top-level index (null, array,
 *      string, number) is treated like a corrupt index: a structured exit-1
 *      message naming INDEX_PATH + the idempotent recovery action, NOT a raw
 *      `TypeError: Cannot convert undefined or null to object` from
 *      Object.entries(index) inside generatePortfolio.
 *
 *   2. generatePortfolio() — a per-repo surfaces value that is not a plain
 *      object (e.g. "org/repo": null, or a string), and a per-surface record
 *      value that is not a plain object, are SKIPPED with a logger.warn naming
 *      the offending repo/surface. The report still generates for the healthy
 *      rows — the one-bad-entry-degrades-to-skip pattern, not a whole-portfolio
 *      abort.
 *
 * Lens: a malformed-shape index produces an actionable signal (structured error
 * OR named skip+warn) and the report for the good rows still ships — never a
 * raw TypeError and never silent data loss.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatePortfolio } from './generate.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const GENERATE_JS = resolve(__dirname, 'generate.js');

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

// ── generatePortfolio per-entry shape tolerance ──────────────────────────────
describe('generatePortfolio malformed-shape tolerance (PORT-DEGRADE-001)', () => {
  it('POSITIVE: a null surfaces value for a repo is skipped with a named warn; healthy rows still generate', () => {
    const index = {
      'org/bad-null': null,
      'org/good': {
        cli: { verified: true, run_id: 'r1', finished_at: new Date().toISOString() },
      },
    };
    const { result: portfolio, messages } = captureWarn(() =>
      generatePortfolio(index, {})
    );

    // The healthy repo's row must be present.
    const goodRow = portfolio.repos.find(r => r.repo === 'org/good' && r.surface === 'cli');
    assert.ok(goodRow, 'healthy repo row must survive a malformed sibling entry');

    // The malformed repo must NOT have produced a row.
    assert.ok(!portfolio.repos.some(r => r.repo === 'org/bad-null'),
      'a null surfaces value must not emit a portfolio row');

    // The operator must be told WHICH repo was skipped.
    const warn = messages.find(m => m.includes('org/bad-null'));
    assert.ok(warn,
      `a warn must name the skipped repo; got messages=${JSON.stringify(messages)}`);
  });

  it('POSITIVE: a string surfaces value for a repo is skipped with a named warn', () => {
    const index = {
      'org/bad-string': 'this should be an object',
      'org/good': {
        cli: { verified: true, run_id: 'r1', finished_at: new Date().toISOString() },
      },
    };
    const { result: portfolio, messages } = captureWarn(() =>
      generatePortfolio(index, {})
    );
    assert.ok(portfolio.repos.find(r => r.repo === 'org/good'),
      'healthy repo must survive a string-shaped sibling');
    assert.ok(!portfolio.repos.some(r => r.repo === 'org/bad-string'),
      'a string surfaces value must not emit a row');
    const warn = messages.find(m => m.includes('org/bad-string'));
    assert.ok(warn,
      `a warn must name the skipped repo; got messages=${JSON.stringify(messages)}`);
  });

  it('POSITIVE: a non-object record (surface -> string) is skipped with a named warn naming repo+surface', () => {
    const index = {
      'org/mixed': {
        cli: 'not-a-record',
        desktop: { verified: false, run_id: 'r2', finished_at: new Date().toISOString() },
      },
    };
    const { result: portfolio, messages } = captureWarn(() =>
      generatePortfolio(index, {})
    );
    // The good surface row survives.
    assert.ok(portfolio.repos.find(r => r.repo === 'org/mixed' && r.surface === 'desktop'),
      'healthy surface must survive a malformed sibling surface');
    // The bad surface produced no row.
    assert.ok(!portfolio.repos.some(r => r.repo === 'org/mixed' && r.surface === 'cli'),
      'a non-object record must not emit a row');
    // Warn names repo + surface.
    const warn = messages.find(m => m.includes('org/mixed') && m.includes('cli'));
    assert.ok(warn,
      `a warn must name the skipped repo+surface; got messages=${JSON.stringify(messages)}`);
  });

  it('NEGATIVE: an all-healthy index emits no skip warn and rows for every entry', () => {
    const index = {
      'org/a': { cli: { verified: true, run_id: 'r1', finished_at: new Date().toISOString() } },
      'org/b': { desktop: { verified: false, run_id: 'r2', finished_at: new Date().toISOString() } },
    };
    const { result: portfolio, messages } = captureWarn(() =>
      generatePortfolio(index, {})
    );
    assert.equal(portfolio.repos.length, 2, 'every healthy row must be present');
    const skipWarn = messages.find(m => /skip|malformed|not an object|ignoring/i.test(m));
    assert.ok(!skipWarn,
      `healthy index must emit no skip warn; got messages=${JSON.stringify(messages)}`);
  });
});

// ── main() top-level shape guard ─────────────────────────────────────────────
describe('portfolio CLI non-object index legibility (PORT-DEGRADE-001)', () => {
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

  function seedSandbox(indexContent) {
    const root = mkdtempSync(join(tmpdir(), 'stageC-port-degrade-'));
    mkdirSync(join(root, 'indexes'), { recursive: true });
    mkdirSync(join(root, 'policies', 'repos'), { recursive: true });
    writeFileSync(join(root, 'indexes', 'latest-by-repo.json'), indexContent, 'utf-8');
    return root;
  }

  for (const [label, content] of [
    ['null', 'null'],
    ['an array', '[1,2,3]'],
    ['a string', '"hello"'],
    ['a number', '42'],
  ]) {
    it(`POSITIVE: a valid-JSON index that is ${label} exits 1 with a structured message naming INDEX_PATH + recovery`, () => {
      const root = seedSandbox(content);
      try {
        const { code, stderr } = runCli(root);
        assert.equal(code, 1, `non-object index (${label}) must exit 1; stderr=${stderr}`);
        assert.ok(stderr.includes('latest-by-repo.json'),
          `error must name the index file; got stderr=${stderr}`);
        assert.ok(/re-?run|ingest|rebuild/i.test(stderr),
          `error must state the recovery action; got stderr=${stderr}`);
        // Must NOT be a raw TypeError stack from Object.entries(index).
        assert.ok(!/TypeError/.test(stderr),
          `non-object index must produce a structured message, not a raw TypeError; got stderr=${stderr}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
