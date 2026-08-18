/**
 * templates-python-worktree-containment.test.js — the Python half of the
 * --isolate containment contract.
 *
 * Measured in run swarm-1787033129-beab wave 2 (prompt-craft, 2026-08-18):
 * the repo's single shared `.venv` had the package installed EDITABLE against
 * the MAIN checkout, so from inside an --isolate worktree `import pcraft`
 * resolved to `<main>/src/pcraft/__init__.py`. Agents ran pytest in their
 * worktree, collected THEIR tests, and imported the main checkout's
 * unmodified source — their own fixes invisible to their own test run.
 *
 * The prompt already shipped this warning for npm workspaces (realpathSync
 * containment + the ONE forbidden repair). It had no Python equivalent, so
 * three of five agents in that wave had to be corrected mid-run after two
 * caught it independently.
 *
 * The failure is silent and BIDIRECTIONAL, which is what makes it worth a
 * contract test rather than a doc line: a correct regression test reads as a
 * failed fix, and a green suite proves nothing about the agent's changes.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from './templates.js';

let root;

function makeRepo(name) {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  return p;
}

/** A src-layout Python project: pyproject.toml + src/<pkg>/__init__.py */
function makeSrcLayoutPython(name, pkg = 'pcraft') {
  const p = makeRepo(name);
  writeFileSync(join(p, 'pyproject.toml'), '[project]\nname = "prompt-crafter"\n');
  mkdirSync(join(p, 'src', pkg), { recursive: true });
  writeFileSync(join(p, 'src', pkg, '__init__.py'), '');
  return p;
}

function auditOpts(repoPath, extra = {}) {
  return {
    repo: 'org/repo',
    repoPath,
    domainName: 'core',
    waveNumber: 1,
    phase: 'health-audit-a',
    globs: ['src/**'],
    ownershipClass: 'owned',
    domainSnapshotId: 'deadbeef',
    isolatedWorktree: true,
    ...extra,
  };
}

describe('Python worktree containment section', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'py-containment-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('warns a src-layout Python repo that its interpreter may not see the worktree', () => {
    const repoPath = makeSrcLayoutPython('proj');
    const prompt = buildAuditPrompt(auditOpts(repoPath));

    assert.match(prompt, /Python: your interpreter probably does NOT see this worktree/);
    // The detected IMPORT package, not the distribution name in pyproject.
    assert.match(prompt, /import pcraft,inspect,os/);
    assert.doesNotMatch(prompt, /import prompt-crafter/);
    // The containment assertion and the prescribed repair.
    assert.match(prompt, /IN WORKTREE:/);
    assert.match(prompt, /PYTHONPATH=/);
    assert.match(prompt, new RegExp(`PYTHONPATH=${repoPath.replace(/[\\/.]/g, '.')}.src`));
  });

  it('names the import package from src/, never the pyproject distribution name', () => {
    // The exact trap this exists for: prompt-craft ships as `prompt-crafter`
    // on PyPI and imports as `pcraft`. A prompt naming the distribution would
    // hand the agent an unimportable name.
    const repoPath = makeSrcLayoutPython('dist-vs-import', 'someimport');
    const prompt = buildAuditPrompt(auditOpts(repoPath));
    assert.match(prompt, /import someimport,inspect,os/);
  });

  it('detects a flat-layout Python package and excludes tests/ and docs/', () => {
    const p = makeRepo('flat');
    writeFileSync(join(p, 'setup.py'), '');
    for (const d of ['mypkg', 'tests', 'docs']) {
      mkdirSync(join(p, d), { recursive: true });
      writeFileSync(join(p, d, '__init__.py'), '');
    }
    const prompt = buildAuditPrompt(auditOpts(p));

    assert.match(prompt, /import mypkg,inspect,os/);
    assert.doesNotMatch(prompt, /import tests,inspect/);
    assert.doesNotMatch(prompt, /import docs,inspect/);
    // Flat layout: PYTHONPATH is the repo root, with no src/ suffix.
    assert.doesNotMatch(prompt, /PYTHONPATH=[^\n]*[\\/]src\b/);
  });

  it('forbids the repair that would corrupt every sibling agent', () => {
    const repoPath = makeSrcLayoutPython('repair');
    const prompt = buildAuditPrompt(auditOpts(repoPath));
    // Mirrors the npm half's "ONE forbidden repair": reinstalling the editable
    // rewrites the venv that every sibling agent shares.
    assert.match(prompt, /Do\s+NOT "repair" this with `pip install`/);
  });

  it('stays silent for a non-Python repo', () => {
    const p = makeRepo('nodeonly');
    writeFileSync(join(p, 'package.json'), '{"name":"n"}');
    const prompt = buildAuditPrompt(auditOpts(p));

    assert.doesNotMatch(prompt, /Python: your interpreter/);
    // The npm half must survive untouched.
    assert.match(prompt, /realpathSync/);
  });

  it('stays silent when the dispatch is not isolated', () => {
    const repoPath = makeSrcLayoutPython('shared-tree');
    const prompt = buildAuditPrompt(auditOpts(repoPath, { isolatedWorktree: false }));
    assert.doesNotMatch(prompt, /Python: your interpreter/);
    assert.doesNotMatch(prompt, /Isolated worktree \(provisioned\)/);
  });

  it('reaches amend and feature-audit prompts too, not only audit', () => {
    const repoPath = makeSrcLayoutPython('all-phases');

    const amend = buildAmendPrompt({
      ...auditOpts(repoPath),
      findings: [],
    });
    assert.match(amend, /Python: your interpreter probably does NOT see this worktree/);

    const feature = buildFeatureAuditPrompt(auditOpts(repoPath));
    assert.match(feature, /Python: your interpreter probably does NOT see this worktree/);
  });

  it('degrades to silence rather than throwing on an unreadable repoPath', () => {
    // Prompt rendering must never fail the whole dispatch over a probe.
    const missing = join(root, 'does-not-exist');
    assert.doesNotThrow(() => buildAuditPrompt(auditOpts(missing)));
    assert.doesNotMatch(buildAuditPrompt(auditOpts(missing)), /Python: your interpreter/);

    assert.doesNotThrow(() => buildAuditPrompt(auditOpts(undefined)));
  });

  it('caps the package scan so a huge directory cannot walk the filesystem', () => {
    const p = makeRepo('many');
    writeFileSync(join(p, 'pyproject.toml'), '');
    mkdirSync(join(p, 'src'), { recursive: true });
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(p, 'src', `pkg${String(i).padStart(2, '0')}`), { recursive: true });
      writeFileSync(join(p, 'src', `pkg${String(i).padStart(2, '0')}`, '__init__.py'), '');
    }
    const prompt = buildAuditPrompt(auditOpts(p));
    // First detected package drives the command; the rest are summarized, and
    // the scan stops at the cap rather than listing all 40.
    assert.match(prompt, /import pkg00,inspect,os/);
    const listed = (prompt.match(/pkg\d\d/g) || []).length;
    assert.ok(listed <= 12, `expected a capped package list, saw ${listed} references`);
  });
});
