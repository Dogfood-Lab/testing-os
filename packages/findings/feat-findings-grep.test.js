/**
 * feat: findings-free-text-search — --grep/--text substring filter.
 *
 * filterFindings gains a `text` filter: a case-insensitive, LITERAL substring
 * (not regex) match over the human-facing prose fields (title, summary,
 * doctrine_statement). It ANDs with the existing exact-enum filters. The same
 * --grep/--text flag reaches the CLI list verb and the
 * patterns/recommendations/doctrine list verbs (which previously took no
 * filters at all).
 *
 * Unit coverage exercises filterFindings + matchesText directly; CLI coverage
 * runs cli.js as a subprocess against a real temp data root (setupTestRoot
 * copy-to-disk pattern) so the wiring through the flag parser is proven, not
 * assumed.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

import { filterFindings, matchesText } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, 'cli.js');

// ── Unit: matchesText + filterFindings ─────────────────────────

describe('feat matchesText: case-insensitive literal substring', () => {
  it('matches regardless of case', () => {
    assert.equal(matchesText('Entrypoint', ['a wrong ENTRYPOINT flag']), true);
    assert.equal(matchesText('ENTRYPOINT', ['entrypoint truth']), true);
  });

  it('treats the term as literal, not regex (no throw on special chars)', () => {
    assert.equal(matchesText('c++', ['built with c++ tooling']), true);
    assert.equal(matchesText('[a-z]', ['the [a-z] glob']), true);
    assert.doesNotThrow(() => matchesText('(', ['no paren here']));
  });

  it('skips non-string fields (missing optional prose)', () => {
    assert.equal(matchesText('x', [undefined, null, 42]), false);
  });
});

describe('feat filterFindings: text filter', () => {
  const mk = (over) => ({
    data: {
      finding_id: over.id,
      repo: over.repo || 'org/repo',
      status: over.status || 'candidate',
      product_surface: 'cli',
      issue_kind: 'entrypoint_truth',
      transfer_scope: 'repo_local',
      title: over.title || '',
      summary: over.summary || '',
      doctrine_statement: over.doctrine_statement
    }
  });

  const findings = [
    mk({ id: 'a', title: 'Entrypoint truth gap', summary: 'flag mismatch' }),
    mk({ id: 'b', title: 'Unrelated title', summary: 'a note about caching behavior' }),
    mk({ id: 'c', title: 'Plain', summary: 'plain', doctrine_statement: 'Read --help before scenarios' })
  ];

  it('matches a word in the title and excludes non-matching findings', () => {
    const out = filterFindings(findings, { text: 'entrypoint' });
    assert.deepEqual(out.map(f => f.data.finding_id), ['a']);
  });

  it('matches a word in the summary', () => {
    const out = filterFindings(findings, { text: 'caching' });
    assert.deepEqual(out.map(f => f.data.finding_id), ['b']);
  });

  it('matches a word in doctrine_statement', () => {
    const out = filterFindings(findings, { text: 'scenarios' });
    assert.deepEqual(out.map(f => f.data.finding_id), ['c']);
  });

  it('ANDs with exact-enum filters (status + text)', () => {
    const mixed = [
      mk({ id: 'x', title: 'entrypoint thing', status: 'candidate' }),
      mk({ id: 'y', title: 'entrypoint thing', status: 'accepted' })
    ];
    const out = filterFindings(mixed, { text: 'entrypoint', status: 'accepted' });
    assert.deepEqual(out.map(f => f.data.finding_id), ['y']);
  });

  it('empty result when nothing matches', () => {
    assert.equal(filterFindings(findings, { text: 'nonexistentword' }).length, 0);
  });
});

// ── CLI: --grep / --text wired through list + synthesis lists ──

let TEST_ROOT;

function writeFinding(id, over = {}) {
  const finding = {
    schema_version: '1.0.0',
    finding_id: id,
    title: over.title || 'Generic finding title',
    status: over.status || 'candidate',
    repo: 'mcp-tool-shop-org/widget',
    product_surface: 'cli',
    journey_stage: 'first_run',
    issue_kind: 'entrypoint_truth',
    root_cause_kind: 'docs_code_drift',
    remediation_kind: 'scenario_change',
    transfer_scope: 'surface_archetype',
    summary: over.summary || 'A generic summary describing the finding in enough detail.',
    source_record_ids: ['widget-run-1'],
    evidence: [{ evidence_kind: 'record', record_id: 'widget-run-1' }],
    ...over.extra
  };
  const [org, repo] = finding.repo.split('/');
  const d = resolve(TEST_ROOT, 'findings', org, repo);
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(finding, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function writePattern(id, title) {
  const pattern = {
    schema_version: '1.0.0',
    pattern_id: id,
    title,
    status: 'candidate',
    pattern_kind: 'recurring_failure',
    summary: 'A pattern summary.',
    source_finding_ids: ['dfind-grep-a'],
    support: { finding_count: 1, repo_count: 1, surface_count: 1 },
    dimensions: { product_surfaces: ['cli'], issue_kinds: ['entrypoint_truth'] },
    transfer_scope: 'surface_archetype',
    pattern_strength: 'strong'
  };
  const d = resolve(TEST_ROOT, 'patterns');
  mkdirSync(d, { recursive: true });
  writeFileSync(resolve(d, `${id}.yaml`), yaml.dump(pattern, { lineWidth: 120, noRefs: true }), 'utf-8');
}

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, FINDINGS_REPO_ROOT: TEST_ROOT }
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() || '', stderr: err.stderr?.toString() || '' };
  }
}

before(() => {
  TEST_ROOT = mkdtempSync(resolve(tmpdir(), 'findings-grep-'));
  writeFinding('dfind-grep-a', { title: 'CLI entrypoint truth gap', summary: 'argparse flag mismatch', status: 'candidate' });
  writeFinding('dfind-grep-b', { title: 'Caching staleness bug', summary: 'stale index served', status: 'accepted' });
  writeFinding('dfind-grep-c', { title: 'Another entrypoint case', summary: 'also about entrypoints', status: 'accepted' });
  writePattern('dpat-grep-1', 'Recurring entrypoint failures');
  writePattern('dpat-grep-2', 'Caching drift across repos');
});

after(() => {
  if (TEST_ROOT && existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true });
});

describe('feat CLI list --grep', () => {
  it('--grep matches a word in title/summary and excludes non-matching findings', () => {
    const r = run(['list', '--grep', 'entrypoint', '--json']);
    assert.equal(r.code, 0);
    const ids = JSON.parse(r.stdout).map(p => p.finding.finding_id).sort();
    assert.deepEqual(ids, ['dfind-grep-a', 'dfind-grep-c']);
  });

  it('--text is an accepted alias for --grep', () => {
    const r = run(['list', '--text', 'caching', '--json']);
    const ids = JSON.parse(r.stdout).map(p => p.finding.finding_id);
    assert.deepEqual(ids, ['dfind-grep-b']);
  });

  it('combines with --status (AND semantics)', () => {
    const r = run(['list', '--grep', 'entrypoint', '--status', 'accepted', '--json']);
    const ids = JSON.parse(r.stdout).map(p => p.finding.finding_id);
    assert.deepEqual(ids, ['dfind-grep-c']);
  });

  it('match is case-insensitive', () => {
    const r = run(['list', '--grep', 'ENTRYPOINT', '--json']);
    const ids = JSON.parse(r.stdout).map(p => p.finding.finding_id).sort();
    assert.deepEqual(ids, ['dfind-grep-a', 'dfind-grep-c']);
  });

  it('no match prints the empty-state message (human mode)', () => {
    const r = run(['list', '--grep', 'zzznomatch']);
    assert.match(r.stdout, /No findings found\./);
  });
});

describe('feat CLI synthesis list --grep', () => {
  it('patterns list --grep filters by title substring', () => {
    const r = run(['patterns', 'list', '--grep', 'entrypoint', '--json']);
    const ids = JSON.parse(r.stdout).map(p => p.pattern_id);
    assert.deepEqual(ids, ['dpat-grep-1']);
  });

  it('patterns list --grep excludes non-matching patterns', () => {
    const r = run(['patterns', 'list', '--grep', 'caching', '--json']);
    const ids = JSON.parse(r.stdout).map(p => p.pattern_id);
    assert.deepEqual(ids, ['dpat-grep-2']);
  });
});
