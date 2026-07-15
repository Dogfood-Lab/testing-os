/**
 * Structural regression pin for .github/dependabot.yml (F-W1-CI-032).
 *
 * F-W1-CI-032 — minimal Dependabot config to automate the floor of the
 * SHA-bump cadence. The repo pins every GitHub Action by SHA (no floating
 * `@v4` — see CLAUDE.md's $130 GitHub Actions incident memory), which makes
 * Dependabot's PR-based bump workflow especially valuable: it is the only
 * mechanism that does not require a human to remember to look. Three
 * ecosystems are covered:
 *   - root npm workspace (directory "/")
 *   - site/'s independent npm subtree (directory "/site" — a separate
 *     lockfile from the root workspace per CLAUDE.md, so it needs its own
 *     Dependabot scope)
 *   - github-actions itself (directory "/" — the SHA pins)
 * Each groups minor+patch updates into one PR per ecosystem so the repo
 * isn't flooded with one PR per dependency; majors stay ungrouped for
 * migration review (the default Dependabot behavior for anything NOT
 * matched by a group).
 *
 * Why text/structure assertions and not a YAML parse: same rationale as the
 * sibling stageA/stageC workflow-structural-pin tests in this directory —
 * parsing YAML in a regression test pulls in a dependency just for one
 * fixture.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const dependabotPath = resolve(repoRoot, '.github/dependabot.yml');

test('.github/dependabot.yml exists', () => {
  assert.ok(existsSync(dependabotPath), `expected config at ${dependabotPath}`);
});

test('F-W1-CI-032: version 2, with exactly the 3 documented ecosystem entries (root npm, site/ npm, github-actions)', () => {
  const text = readFileSync(dependabotPath, 'utf8');
  assert.match(text, /^version:\s*2\s*$/m, 'dependabot.yml must declare version: 2');

  const npmEntries = [...text.matchAll(/package-ecosystem:\s*npm\b/g)];
  assert.equal(npmEntries.length, 2, `expected exactly 2 npm ecosystem entries (root + site/) — found ${npmEntries.length} (F-W1-CI-032)`);

  const actionsEntries = [...text.matchAll(/package-ecosystem:\s*github-actions\b/g)];
  assert.equal(actionsEntries.length, 1, `expected exactly 1 github-actions ecosystem entry — found ${actionsEntries.length} (F-W1-CI-032)`);

  // Tolerate a comment block (zero or more `#`-prefixed lines) between the
  // ecosystem declaration and its `directory:` field — the site/ entry
  // carries a 3-line comment explaining why it needs its own scope, and a
  // rigid "directory is the very next line" pattern false-positived on it.
  assert.match(
    text,
    /package-ecosystem:\s*npm\s*\n(?:\s*#[^\n]*\n)*\s*directory:\s*"\/"\s*\n/,
    'the root npm entry must target directory "/" (F-W1-CI-032)',
  );
  assert.match(
    text,
    /package-ecosystem:\s*npm\s*\n(?:\s*#[^\n]*\n)*\s*directory:\s*"\/site"\s*\n/,
    'site/ is a separate npm subtree with its own lockfile (CLAUDE.md) and needs its own Dependabot scope, directory "/site" (F-W1-CI-032)',
  );
  assert.match(
    text,
    /package-ecosystem:\s*github-actions\s*\n(?:\s*#[^\n]*\n)*\s*directory:\s*"\/"\s*\n/,
    'the github-actions entry must target directory "/" — the repo pins every Action by SHA, and Dependabot is the mechanism that bumps those pins (F-W1-CI-032)',
  );
});

test('F-W1-CI-032: every ecosystem entry groups minor+patch updates into one PR rather than one PR per dependency', () => {
  const text = readFileSync(dependabotPath, 'utf8');
  const groupBlocks = [...text.matchAll(
    /groups:\s*\n\s*[\w-]+:\s*\n\s*patterns:\s*\["\*"\]\s*\n\s*update-types:\s*\["minor",\s*"patch"\]/g,
  )];
  assert.equal(
    groupBlocks.length,
    3,
    `expected all 3 ecosystem entries to group minor+patch updates (a wildcard pattern with update-types ["minor","patch"]) — found ${groupBlocks.length}. Ungrouped Dependabot config opens one PR per dependency bump, defeating the point of batching (F-W1-CI-032).`,
  );
  // Majors are intentionally NOT grouped — every groups: block above scopes
  // to ["minor","patch"] only, so a major-version bump still opens its own,
  // separately-reviewable PR.
  assert.doesNotMatch(
    text,
    /update-types:\s*\[[^\]]*"major"[^\]]*\]/,
    'no group should include "major" in update-types — majors must stay ungrouped for individual migration review (F-W1-CI-032)',
  );
});
