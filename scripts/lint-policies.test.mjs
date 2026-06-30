/**
 * lint-policies.test.mjs (VERIFY-F3) — the author-time policy lint, run as an
 * `npm run verify` gate over the LIVE policies/ tree.
 *
 * Why a scripts/*.test.mjs and not a 5th workflow: `test:scripts` already runs in
 * BOTH `npm run verify` (local pre-commit) and ci.yml — so wiring the policy lint
 * here gates every shipped policy file with no new workflow (the repo caps at 4;
 * see .claude/rules/github-actions.md). ci.yml's `policies/**` path filter ensures
 * a policy-only edit still triggers this run.
 *
 * Contract: every committed policy file under policies/ must lint with ZERO errors
 * (a structural/schema fault, an unknown leading field, over-depth, or node-budget
 * overrun fails CI). Footgun WARNINGS are advisory — surfaced, never fatal — because
 * a legitimate existential-negative is a real rule the author has confirmed.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { lintPolicy } from '@dogfood-lab/verify/validators/lint-policy.js';
import { originForPath } from '@dogfood-lab/verify/cli-lint.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const POLICIES = resolve(REPO_ROOT, 'policies');

/** Recursively collect every .yaml policy file under policies/. */
function policyFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...policyFiles(full));
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
  }
  return out;
}

test('every committed policy lints with zero errors (footgun warnings are advisory)', () => {
  const files = policyFiles(POLICIES);

  // Guard against a silent pass if the glob ever finds nothing (path moved, etc.).
  assert.ok(files.length >= 2, `expected to find policy files under ${POLICIES}, found ${files.length}`);

  const failures = [];
  let warnCount = 0;
  for (const file of files) {
    let doc;
    try {
      doc = yaml.load(readFileSync(file, 'utf-8'));
    } catch (e) {
      failures.push(`${file}: YAML failed to parse — ${e.message}`);
      continue;
    }
    const res = lintPolicy(doc, { origin: originForPath(file) });
    for (const e of res.errors) {
      failures.push(`${file}: [${e.label} ${e.code}] ${e.location}${e.field ? ` field "${e.field}"` : ''} — ${e.message}`);
    }
    for (const w of res.warnings) {
      warnCount++;
      // Surface advisories on the test runner's stderr without failing the gate.
      console.warn(`::warning:: policy footgun in ${file}: ${w.location} field "${w.field}" — ${w.message}`);
    }
  }

  assert.equal(
    failures.length, 0,
    `policy lint found ${failures.length} error(s) across ${files.length} file(s):\n  ${failures.join('\n  ')}`
  );
  // Informational: how many advisories the live tree currently carries.
  console.log(`policy lint: ${files.length} file(s) clean, ${warnCount} advisory warning(s).`);
});
