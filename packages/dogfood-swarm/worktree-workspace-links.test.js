/**
 * worktree-workspace-links.test.js — npm-workspaces provisioning + the
 * workspace-realpath-containment gate for --isolate worktrees.
 *
 * Provenance: observed in run swarm-1784601601-bd4a (ai-rpg-engine,
 * npm-workspaces monorepo, Windows). Bare `git worktree add` materializes
 * tracked files only; the worktree nests INSIDE the audited repo, so Node's
 * resolver walked up and resolved every bare @scope/* import against the
 * MAIN checkout's node_modules — the agent's tests ran main's code, not the
 * worktree's edits, and stayed green ("green can be an illusion"). The
 * agent-side repair (`npm install` in the worktree) rewrote
 * package-lock.json.
 *
 * RED-PROOF DISCIPLINE (Pattern #10, permanently encoded): the two broken
 * pre-fix provisioning shapes are CONSTRUCTED here byte-for-byte —
 *   (A) bare `git worktree add`, no node_modules at all (what the old
 *       createWorktree produced), with an EXECUTABLE walk-up escape proof;
 *   (B) a partial node_modules whose absolute link targets still point at
 *       the main checkout (the observed hybrid) —
 * and checkWorkspaceRealpathContainment must report FAIL on both. Then the
 * provisioned shape must PASS, and mutating the protected links (delete one,
 * re-point one at main) must flip the gate back to FAIL. "Passes N/N" is not
 * the proof; the flip is.
 *
 * NON-NEGOTIABLE CORDONED-TEST DISCIPLINE (mirrors clean-worktree-lifecycle
 * .test.js): every test builds a fresh fixture git repo via mkdtempSync —
 * never process.cwd(), never the real repo, never a live control-plane.db.
 * afterEach/finally rmSync's the fixture (Windows-tolerant).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, unlinkSync, rmdirSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';

import { createWorktree } from './lib/worktree.js';
import {
  enumerateWorkspacePackages,
  provisionWorkspaceLinks,
  checkWorkspaceRealpathContainment,
  WORKSPACE_CONTAINMENT_CHECK_ID,
} from './lib/workspace-links.js';
import { buildAuditPrompt, buildAmendPrompt, buildFeatureAuditPrompt } from './lib/templates.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function isUnder(child, root) {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

const LOCKFILE_BYTES = JSON.stringify(
  { name: 'fx-root', version: '1.0.0', lockfileVersion: 3, packages: {} },
  null,
  2,
) + '\n';

/**
 * A committed npm-workspaces monorepo fixture with a SIMULATED main-checkout
 * install: node_modules/@fx/{alpha,beta} links pointing at the MAIN repo's
 * package dirs — exactly what `npm install` leaves in the source checkout
 * (junctions on Windows). node_modules is gitignored, as in real life.
 */
function setupWorkspacesFixture({ workspaces = ['packages/*'], installMain = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'wslinks-fixture-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  git(repo, ['config', 'user.name', 'Fixture']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  // The lockfile byte-identity assertion compares the WORKTREE'S checkout to
  // the source working file. A global core.autocrlf=true would CRLF-smudge
  // the worktree checkout on Windows and fail the comparison for reasons
  // that have nothing to do with provisioning — pin it off in the fixture.
  git(repo, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, '.gitignore'), '.swarm/\nnode_modules/\n', 'utf-8');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'fx-root', private: true, version: '1.0.0', workspaces,
  }, null, 2) + '\n', 'utf-8');
  writeFileSync(join(repo, 'package-lock.json'), LOCKFILE_BYTES, 'utf-8');
  for (const short of ['alpha', 'beta']) {
    const dir = join(repo, 'packages', short);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@fx/${short}`, version: '1.0.0', main: 'index.js',
    }, null, 2) + '\n', 'utf-8');
    writeFileSync(join(dir, 'index.js'), 'module.exports = { home: __dirname };\n', 'utf-8');
  }
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'root']);

  if (installMain) {
    const scopeDir = join(repo, 'node_modules', '@fx');
    mkdirSync(scopeDir, { recursive: true });
    for (const short of ['alpha', 'beta']) {
      symlinkSync(join(repo, 'packages', short), join(scopeDir, short), 'junction');
    }
  }
  return repo;
}

/** The PRE-FIX provisioning shape: what old createWorktree did — a bare
 * `git worktree add`, nothing else. Constructed with raw git so the red
 * proof stays valid no matter what createWorktree does now. */
function bareWorktreeAdd(repo, name) {
  const wtDir = join(repo, '.swarm', 'worktrees', name);
  mkdirSync(join(repo, '.swarm', 'worktrees'), { recursive: true });
  git(repo, ['worktree', 'add', '-b', `swarm/test/${name}`, wtDir]);
  return wtDir;
}

function teardown(repo) {
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('workspace-links — RED proof against the pre-fix provisioning shapes', () => {
  it('shape A (bare git worktree add): containment FAILS with missing-link for every workspace, and resolution demonstrably escapes into the main checkout', () => {
    const repo = setupWorkspacesFixture();
    try {
      const wt = bareWorktreeAdd(repo, 'w1-backend-red');

      const check = checkWorkspaceRealpathContainment(wt);
      assert.equal(check.id, WORKSPACE_CONTAINMENT_CHECK_ID);
      assert.equal(check.status, 'fail', 'the gate MUST go red on the pre-fix shape');
      assert.equal(check.violations.length, 2);
      assert.ok(check.violations.every(v => v.kind === 'missing-link'));
      assert.match(check.hint, /npm install/, 'hint names the forbidden repair');

      // Executable escape proof — the green-illusion mechanism itself, pinned
      // as a fact: a bare workspace import from INSIDE the worktree resolves
      // to the MAIN checkout's copy via ancestor-directory walk-up.
      const req = createRequire(join(wt, 'packages', 'alpha', 'index.js'));
      const resolved = realpathSync(req.resolve('@fx/beta'));
      const wtReal = realpathSync(wt);
      const repoReal = realpathSync(repo);
      assert.ok(!isUnder(resolved, wtReal), `resolved OUT of the worktree: ${resolved}`);
      assert.equal(resolved, join(repoReal, 'packages', 'beta', 'index.js'),
        'walk-up lands on the MAIN checkout\'s package — the code under test is not the worktree\'s');
    } finally {
      teardown(repo);
    }
  });

  it('shape B (partial node_modules, absolute targets into main): containment FAILS with escapes-worktree + missing-link', () => {
    const repo = setupWorkspacesFixture();
    try {
      const wt = bareWorktreeAdd(repo, 'w1-backend-hybrid');
      // The observed hybrid: a partial worktree node_modules whose one link
      // carries an absolute target into the MAIN checkout; the other
      // workspace is absent entirely.
      const scopeDir = join(wt, 'node_modules', '@fx');
      mkdirSync(scopeDir, { recursive: true });
      symlinkSync(join(repo, 'packages', 'alpha'), join(scopeDir, 'alpha'), 'junction');

      const check = checkWorkspaceRealpathContainment(wt);
      assert.equal(check.status, 'fail');
      const byName = Object.fromEntries(check.violations.map(v => [v.name, v]));
      assert.equal(byName['@fx/alpha'].kind, 'escapes-worktree');
      assert.ok(isUnder(byName['@fx/alpha'].resolvedPath, realpathSync(repo)));
      assert.ok(!isUnder(byName['@fx/alpha'].resolvedPath, realpathSync(wt)));
      assert.equal(byName['@fx/beta'].kind, 'missing-link');
    } finally {
      teardown(repo);
    }
  });
});

describe('workspace-links — provisioning turns the gate green, mutation flips it back', () => {
  it('provisionWorkspaceLinks on shape A: realpath through every link stays under the worktree root', () => {
    const repo = setupWorkspacesFixture();
    try {
      const wt = bareWorktreeAdd(repo, 'w1-backend-green');
      const result = provisionWorkspaceLinks(wt);
      assert.equal(result.isWorkspacesRepo, true);
      assert.deepEqual(result.linked.map(l => l.name).sort(), ['@fx/alpha', '@fx/beta']);
      assert.deepEqual(result.unsupportedPatterns, []);

      const wtReal = realpathSync(wt);
      // The constraint-2 assertion verbatim: fs.realpathSync through the link
      // must stay under the worktree root.
      const alphaReal = realpathSync(join(wt, 'node_modules', '@fx', 'alpha'));
      assert.ok(isUnder(alphaReal, wtReal), `${alphaReal} must sit under ${wtReal}`);
      assert.equal(alphaReal, join(wtReal, 'packages', 'alpha'));

      const check = checkWorkspaceRealpathContainment(wt);
      assert.equal(check.status, 'pass');
      assert.equal(check.violations.length, 0);

      // Resolution proof: the same bare import that escaped in the red proof
      // now lands inside the worktree.
      const req = createRequire(join(wt, 'packages', 'alpha', 'index.js'));
      const resolved = realpathSync(req.resolve('@fx/beta'));
      assert.equal(resolved, join(wtReal, 'packages', 'beta', 'index.js'));

      // Idempotent: a second provisioning replaces links cleanly.
      const again = provisionWorkspaceLinks(wt);
      assert.equal(again.linked.length, 2);
      assert.equal(checkWorkspaceRealpathContainment(wt).status, 'pass');
    } finally {
      teardown(repo);
    }
  });

  it('mutating the protected links makes the gate fire again (delete → missing-link; re-point at main → escapes-worktree)', () => {
    const repo = setupWorkspacesFixture();
    try {
      const wt = bareWorktreeAdd(repo, 'w1-backend-mutate');
      provisionWorkspaceLinks(wt);
      assert.equal(checkWorkspaceRealpathContainment(wt).status, 'pass', 'precondition: green');

      const betaLink = join(wt, 'node_modules', '@fx', 'beta');
      try { unlinkSync(betaLink); } catch { rmdirSync(betaLink); }
      let check = checkWorkspaceRealpathContainment(wt);
      assert.equal(check.status, 'fail', 'deleting a link MUST re-fire the gate');
      assert.equal(check.violations[0].kind, 'missing-link');

      // Restore beta, then re-point alpha at the MAIN checkout.
      symlinkSync(join(wt, 'packages', 'beta'), betaLink, 'junction');
      const alphaLink = join(wt, 'node_modules', '@fx', 'alpha');
      try { unlinkSync(alphaLink); } catch { rmdirSync(alphaLink); }
      symlinkSync(join(repo, 'packages', 'alpha'), alphaLink, 'junction');
      check = checkWorkspaceRealpathContainment(wt);
      assert.equal(check.status, 'fail', 're-pointing a link at main MUST re-fire the gate');
      assert.equal(check.violations[0].kind, 'escapes-worktree');
    } finally {
      teardown(repo);
    }
  });
});

describe('workspace-links — createWorktree end-to-end (the wired production path)', () => {
  it('createWorktree provisions links, passes containment, leaves the worktree clean, and never touches package-lock.json', () => {
    const repo = setupWorkspacesFixture();
    try {
      const lockBefore = readFileSync(join(repo, 'package-lock.json'));

      const { worktreePath } = createWorktree(repo, {
        runId: 'swarm-wslinks00001', waveNumber: 1, domainName: 'backend',
      });

      const check = checkWorkspaceRealpathContainment(worktreePath);
      assert.equal(check.status, 'pass', check.message);
      const wtReal = realpathSync(worktreePath);
      for (const short of ['alpha', 'beta']) {
        const linkPath = join(worktreePath, 'node_modules', '@fx', short);
        assert.ok(lstatSync(linkPath).isSymbolicLink(), `${short} link exists`);
        assert.equal(realpathSync(linkPath), join(wtReal, 'packages', short));
      }

      // Constraint: the lockfile stays byte-identical — in the SOURCE repo
      // (no npm subprocess ran) and in the worktree (same HEAD content).
      const lockAfter = readFileSync(join(repo, 'package-lock.json'));
      assert.ok(lockBefore.equals(lockAfter), 'source package-lock.json must be byte-identical');
      const wtLock = readFileSync(join(worktreePath, 'package-lock.json'));
      assert.ok(wtLock.equals(lockBefore), 'worktree package-lock.json must be byte-identical to source');

      // Links live under gitignored node_modules — the worktree must read
      // CLEAN or the ownership probe (git status --porcelain) would blame
      // provisioning scaffolding on the agent.
      assert.equal(git(worktreePath, ['status', '--porcelain']).trim(), '');
    } finally {
      teardown(repo);
    }
  });

  it('non-workspaces repo: no-op — no node_modules materialized, containment reports not-applicable pass', () => {
    const repo = mkdtempSync(join(tmpdir(), 'wslinks-plain-'));
    try {
      git(repo, ['init', '-q', '-b', 'main']);
      git(repo, ['config', 'user.email', 'fixture@example.test']);
      git(repo, ['config', 'user.name', 'Fixture']);
      git(repo, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(join(repo, '.gitignore'), '.swarm/\n', 'utf-8');
      writeFileSync(join(repo, 'README.md'), '# plain\n', 'utf-8');
      git(repo, ['add', '.']);
      git(repo, ['commit', '-q', '-m', 'root']);

      const { worktreePath } = createWorktree(repo, {
        runId: 'swarm-wslinks00002', waveNumber: 1, domainName: 'docs',
      });
      assert.ok(!existsSync(join(worktreePath, 'node_modules')));
      const check = checkWorkspaceRealpathContainment(worktreePath);
      assert.equal(check.status, 'pass');
      assert.match(check.message, /not applicable/);
    } finally {
      teardown(repo);
    }
  });
});

describe('workspace-links — enumeration hardening (audited-repo trust class)', () => {
  it('supports the { packages: [...] } object form', () => {
    const repo = setupWorkspacesFixture({ workspaces: { packages: ['packages/*'] }, installMain: false });
    try {
      const e = enumerateWorkspacePackages(repo);
      assert.deepEqual(e.workspaces.map(w => w.name).sort(), ['@fx/alpha', '@fx/beta']);
    } finally {
      teardown(repo);
    }
  });

  it('unsupported pattern shapes are DISCLOSED, not silently expanded and not false containment failures', () => {
    const repo = setupWorkspacesFixture({ workspaces: ['packages/**'], installMain: false });
    try {
      const wt = bareWorktreeAdd(repo, 'w1-unsupported');
      const result = provisionWorkspaceLinks(wt);
      assert.equal(result.isWorkspacesRepo, true);
      assert.deepEqual(result.linked, []);
      assert.deepEqual(result.unsupportedPatterns, ['packages/**']);
      // Same expander on both sides: a disclosed blind spot must not read as
      // a containment violation.
      assert.equal(checkWorkspaceRealpathContainment(wt).status, 'pass');
    } finally {
      teardown(repo);
    }
  });

  it('a hostile workspace "name" (path traversal) is skipped — no link lands outside node_modules', () => {
    const repo = setupWorkspacesFixture({ installMain: false });
    try {
      const evil = join(repo, 'packages', 'evil');
      mkdirSync(evil, { recursive: true });
      writeFileSync(join(evil, 'package.json'), JSON.stringify({ name: '../../pwn', version: '1.0.0' }) + '\n', 'utf-8');

      const result = provisionWorkspaceLinks(repo);
      assert.deepEqual(result.linked.map(l => l.name).sort(), ['@fx/alpha', '@fx/beta']);
      assert.ok(result.skipped.some(s => /unsafe or missing package name/.test(s.reason)));
      assert.ok(!existsSync(join(repo, 'pwn')), 'no traversal artifact outside node_modules');
      assert.ok(!existsSync(join(repo, '..', 'pwn')), 'no traversal artifact above the root');
    } finally {
      teardown(repo);
    }
  });
});

describe('workspace-links — agent-prompt setup note (isolatedWorktree)', () => {
  const base = {
    repoPath: 'X:/wt', repo: 'org/r', domainName: 'backend', globs: ['src/**'],
    ownershipClass: 'owned', domainSnapshotId: 'snap-1', waveNumber: 2,
  };

  it('all three builders render the provisioned-worktree note only when isolatedWorktree is set', () => {
    const audit = buildAuditPrompt({ ...base, phase: 'health-audit-a', isolatedWorktree: true });
    const amend = buildAmendPrompt({ ...base, phase: 'health-amend-a', findings: [], isolatedWorktree: true });
    const feature = buildFeatureAuditPrompt({ ...base, phase: 'feature-audit', isolatedWorktree: true });
    for (const prompt of [audit, amend, feature]) {
      assert.match(prompt, /## Isolated worktree \(provisioned\)/);
      assert.match(prompt, /Do NOT "repair" resolution with/);
      assert.match(prompt, /realpathSync/);
    }
    const shared = buildAuditPrompt({ ...base, phase: 'health-audit-a' });
    assert.ok(!/Isolated worktree/.test(shared), 'shared-tree prompts carry no worktree note');
  });
});
