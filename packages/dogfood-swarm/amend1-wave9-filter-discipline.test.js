/**
 * amend1-wave9-filter-discipline.test.js
 *
 * Wave A1 D3 — mechanical completeness gate for the wave-9 family.
 *
 * Scans every `FROM agent_runs` site under `packages/dogfood-swarm/**` and
 * FAILS on any site that should go through the wave-9 latest-per-(wave,
 * domain) filter but doesn't.
 *
 * The fix lives in lib/queries/latest-agent-runs.js (the helper). The guard
 * enforces that:
 *
 *   1. The fragment text `AND ar.id = (` (the marker of the manual
 *      latest-per-domain pattern) appears in source ONLY inside
 *      lib/queries/latest-agent-runs.js — the single source of truth.
 *      Any other file containing that fragment has divided the helper.
 *
 *   2. Each `FROM agent_runs` site under packages/dogfood-swarm/**
 *      (excluding the helper, tests, and explicitly-allowlisted shapes)
 *      either:
 *        (a) imports `LATEST_AGENT_RUN_PER_DOMAIN` / `latestAgentRunsForWave`
 *            from the helper, AND
 *        (b) the surrounding query uses one of those names,
 *      OR is allowlisted in the patterns below (single-row lookups by id,
 *      timeout-policy in-flight loop, redrive scan-all-rows-for-rollback).
 *
 * The allowlist is INTENTIONALLY narrow. New `FROM agent_runs` sites in
 * source must either adopt the helper or add a documented allowlist entry.
 * Forces a thinking step on the next maintainer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = __dirname;
const HELPER_PATH = 'lib/queries/latest-agent-runs.js';

// Manual fragment marker — any file containing this string (other than the
// helper itself) has divided the wave-9 filter.
const MANUAL_FRAGMENT_MARKER = 'AND ar.id = (';

// Files that legitimately reference `FROM agent_runs` WITHOUT needing the
// wave-9 filter. Each entry MUST have a `reason` so a future maintainer can
// audit. Keep this list minimal.
//
// Convention: paths are relative to packages/dogfood-swarm/, forward slashes.
const ALLOWLIST = [
  // Single-row lookups by agent_run id — no wave/domain semantics.
  {
    file: 'lib/state-machine.js',
    reason: 'state-machine line 112 fetches by id for transition check; line 188 iterates dispatched/running with in-flight WHERE clause (timeout policy) — both legitimate single-row / in-flight paths.',
  },
  {
    file: 'commands/collect.js',
    reason: 'collect.js line 75 fetches by id inside tryTransition (single-row lookup); main agent-run loop at line ~175 uses LATEST_AGENT_RUN_PER_DOMAIN.',
  },
  {
    file: 'commands/redrive.js',
    reason: 'redrive scans ALL agent_runs for a wave on purpose — its contract is to classify EVERY row (preserved/eligible/refused) into the rewind plan, including the stale historical rows the wave-9 filter normally hides.',
  },
  {
    file: 'commands/rewind.js',
    reason: 'rewind scans ALL non-terminal agent_runs across runs to build the destructive plan; the wave-9 filter is irrelevant — every row, terminal or not, is what the plan must enumerate.',
  },
  {
    file: 'commands/clean-claims.js',
    reason: 'clean-claims deliberately sweeps EVERY agent_run\'s violation claims (its main query anchors on file_claims) — stale claims on SUPERSEDED agent_runs are exactly its target, and its --agent-run owner check is a single-row-by-id lookup that must resolve superseded rows too. Its one latest-per-domain site (the revalidate-jurisdiction refusal) does adopt LATEST_AGENT_RUN_PER_DOMAIN.',
  },
];

const TEST_FILE_PATTERN = /\.test\.(js|mjs)$/;

function walkSync(dir, files = []) {
  // F-af78bb29: skip node_modules / dist / dot-dirs (guard mirrored from
  // meta-amendA-readme-contract.test.js#envVarsReadInSource) so an npm
  // hoisting change that materializes a package-local node_modules cannot
  // make this discipline gate sweep third-party sources. withFileTypes
  // avoids a follow-up statSync, so a broken symlink is skipped instead of
  // crashing the sweep.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkSync(p, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(p);
  }
  return files;
}

function relativeFromPkg(absPath) {
  return absPath.slice(PKG_ROOT.length + 1).replace(/\\/g, '/');
}

function isAllowlisted(relPath) {
  return ALLOWLIST.some(entry => entry.file === relPath);
}

describe('Wave-9 SQL family filter discipline (mechanical guard)', () => {
  it('the manual fragment text appears ONLY in the shared helper', () => {
    const all = walkSync(PKG_ROOT);
    const sourceFiles = all.filter(p => {
      const rel = relativeFromPkg(p);
      // Skip test files: the integration test inlines the helper's fragment
      // export as a STRING — the source-of-truth helper itself is the only
      // place the literal fragment text should appear.
      if (TEST_FILE_PATTERN.test(rel)) return false;
      return true;
    });

    const offenders = [];
    for (const f of sourceFiles) {
      const rel = relativeFromPkg(f);
      if (rel === HELPER_PATH) continue;
      const text = readFileSync(f, 'utf-8');
      if (text.includes(MANUAL_FRAGMENT_MARKER)) {
        offenders.push(rel);
      }
    }

    assert.deepEqual(offenders, [],
      `wave-9 fragment text leaked outside ${HELPER_PATH}:\n  ${offenders.join('\n  ')}\n` +
      `Adopt LATEST_AGENT_RUN_PER_DOMAIN from ${HELPER_PATH} instead of inlining the fragment.`);
  });

  it('every FROM agent_runs template literal in non-allowlisted files contains the wave-9 filter (per-query, not per-file)', () => {
    // F-L1-004 fix-up (Wave A1 D3): the previous version of this test was
    // per-FILE — if a file imported the helper for query A, query B in the
    // same file could omit the filter and the test still passed. That's
    // exactly what advisor Lens 1 caught at commands/status.js:80 (the
    // violations subquery — F-L1-001 same-file unlisted sibling). This
    // stricter check inspects every template literal containing
    // `FROM agent_runs` and requires it ALSO contain LATEST_AGENT_RUN_PER_DOMAIN
    // unless the surrounding file is on the (file-level) allowlist.
    const all = walkSync(PKG_ROOT);
    const sourceFiles = all.filter(p => !TEST_FILE_PATTERN.test(relativeFromPkg(p)));

    const offenders = [];
    for (const f of sourceFiles) {
      const rel = relativeFromPkg(f);
      if (rel === HELPER_PATH) continue;
      if (isAllowlisted(rel)) continue;
      const text = readFileSync(f, 'utf-8');

      // Walk every top-level template literal in the file. Naive backtick-
      // pair scan: a backtick that isn't escaped opens; the next non-escaped
      // backtick closes. ${…} interpolation contents may contain backticks
      // in theory, but the swarm code's SQL literals don't nest like that,
      // and the cost of a false positive is just a clearer error message.
      const literals = [];
      let inBacktick = false;
      let start = -1;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '`' && text[i - 1] !== '\\') {
          if (!inBacktick) {
            inBacktick = true;
            start = i + 1;
          } else {
            literals.push({ start, end: i, body: text.slice(start, i) });
            inBacktick = false;
          }
        }
      }

      for (const lit of literals) {
        if (!/FROM\s+agent_runs/.test(lit.body)) continue;
        if (lit.body.includes('LATEST_AGENT_RUN_PER_DOMAIN')) continue;
        // Compute the 1-based line number of the literal start for the
        // error message — saves a second pass to find the offending site.
        const line = text.slice(0, lit.start).split('\n').length;
        offenders.push(`${rel}:${line} — template literal with FROM agent_runs missing LATEST_AGENT_RUN_PER_DOMAIN`);
      }
    }

    assert.deepEqual(offenders, [],
      `wave-9 filter discipline violation (per-query):\n  ${offenders.join('\n  ')}\n` +
      `Add \${LATEST_AGENT_RUN_PER_DOMAIN} inside the template literal — ` +
      `the helper from ${HELPER_PATH} — OR add the file to the (file-level) ` +
      `allowlist with a documented reason if the entire file is by-design ` +
      `outside the wave-9 family (e.g. single-row-by-id lookups).`);
  });

  it('helper file exists and exports the expected names', async () => {
    const mod = await import('./lib/queries/latest-agent-runs.js');
    assert.equal(typeof mod.LATEST_AGENT_RUN_PER_DOMAIN, 'string');
    assert.ok(mod.LATEST_AGENT_RUN_PER_DOMAIN.includes('AND ar.id = ('),
      'helper must export the canonical fragment');
    assert.equal(typeof mod.latestAgentRunsForWave, 'function');
    assert.ok(Array.isArray(mod.WAVE9_FAMILY_CALL_SITES));
    assert.ok(mod.WAVE9_FAMILY_CALL_SITES.length >= 6,
      'registry should list every site that intentionally uses the helper');
  });
});
