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
    // F-f3bef3a1: the reason above vouches for a PER-QUERY fact — "its one
    // latest-per-domain site... does adopt LATEST_AGENT_RUN_PER_DOMAIN" —
    // but a bare file-level entry blanket-skips the WHOLE file from the
    // per-query sweep below, so a regression that silently drops the filter
    // from THAT query would go undetected here AND by clean-claims.test.js's
    // pin suite (the fixture seeds only one agent_run per domain, so "all
    // agent_runs on the latest wave" and "latest-per-domain agent_runs on
    // the latest wave" coincide in every scenario either suite exercises).
    // exemptQueryMarkers narrows the skip to ONLY the query shape named
    // here (the --agent-run owner-by-id lookup, which has no wave/domain
    // semantics to filter) — every OTHER `FROM agent_runs` template literal
    // in this file, including the latestPerDomainOnLatestWave query the
    // reason vouches for, is still checked exactly like a non-allowlisted
    // file. See the mutation proof in the describe block below.
    exemptQueryMarkers: ['SELECT ar.id, w.run_id FROM agent_runs ar'],
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

function allowlistEntryFor(relPath) {
  return ALLOWLIST.find(entry => entry.file === relPath) || null;
}

/**
 * Classify every `FROM agent_runs` template literal in `text` against the
 * wave-9 filter requirement. `entry` is this file's ALLOWLIST entry (or
 * null for a non-allowlisted file). Returns an array of offender
 * description strings — empty means compliant.
 *
 * F-f3bef3a1: an entry with `exemptQueryMarkers` does NOT blanket-skip the
 * file — only literals matching one of the declared markers are exempt;
 * every OTHER `FROM agent_runs` literal in that file is checked exactly
 * like a non-allowlisted file. An entry with no `exemptQueryMarkers` (the
 * pre-existing shape — state-machine.js / collect.js / redrive.js /
 * rewind.js) keeps the original whole-file skip, unchanged by this fix; the
 * caller is responsible for that skip (see the two call sites below), not
 * this function, so this function's behavior for a bare entry and for null
 * only differ in which markers apply.
 *
 * This is the SAME function both the discipline test and the F-f3bef3a1
 * mutation-proof tests call — a mutated STRING run through this real
 * function, not a re-derived stand-in, so the proof exercises production
 * logic.
 */
function findFilterDisciplineOffenders(rel, text, entry) {
  const offenders = [];

  // Walk every top-level template literal in the file. Naive backtick-pair
  // scan: a backtick that isn't escaped opens; the next non-escaped
  // backtick closes. ${…} interpolation contents may contain backticks in
  // theory, but the swarm code's SQL literals don't nest like that, and the
  // cost of a false positive is just a clearer error message.
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
    if (entry?.exemptQueryMarkers?.some(marker => lit.body.includes(marker))) continue;
    // Compute the 1-based line number of the literal start for the error
    // message — saves a second pass to find the offending site.
    const line = text.slice(0, lit.start).split('\n').length;
    offenders.push(`${rel}:${line} — template literal with FROM agent_runs missing LATEST_AGENT_RUN_PER_DOMAIN`);
  }
  return offenders;
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
      const entry = allowlistEntryFor(rel);
      // F-f3bef3a1: a bare file-level entry (no exemptQueryMarkers) keeps
      // the original blanket-skip behavior — state-machine.js / collect.js
      // / redrive.js / rewind.js are untouched by this fix. An entry that
      // DECLARES exemptQueryMarkers (currently only commands/clean-claims.js)
      // is NOT skipped here — findFilterDisciplineOffenders narrows the
      // exemption to just the literals matching one of those markers, so
      // every other FROM agent_runs literal in the file is still checked.
      if (entry && !entry.exemptQueryMarkers) continue;
      const text = readFileSync(f, 'utf-8');
      offenders.push(...findFilterDisciplineOffenders(rel, text, entry));
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

// ──────────────────────────────────────────────────────────────
// F-f3bef3a1 — mutation proof: the commands/clean-claims.js allowlist
// exemption is narrowed to its vouched query shape, not the whole file.
// Before this fix, ANY FROM agent_runs query in an allowlisted file was
// invisible to the per-query sweep above — including the
// latestPerDomainOnLatestWave query the allowlist reason vouches for.
// clean-claims.test.js's own 25-pin suite gave no independent signal either
// (its fixture seeds one agent_run per domain, so "all agent_runs on the
// latest wave" and "latest-per-domain agent_runs on the latest wave"
// coincide in every scenario it exercises).
// ──────────────────────────────────────────────────────────────

describe('Wave-9 filter discipline — F-f3bef3a1: clean-claims.js exemption is narrowed to its vouched query', () => {
  const CLEAN_CLAIMS_REL = 'commands/clean-claims.js';
  const cleanClaimsEntry = allowlistEntryFor(CLEAN_CLAIMS_REL);

  it('the allowlist entry declares exemptQueryMarkers (a bare file-level entry would revert to the pre-fix blanket skip)', () => {
    assert.ok(cleanClaimsEntry, 'commands/clean-claims.js must stay on the allowlist — see its documented reason');
    assert.ok(
      Array.isArray(cleanClaimsEntry.exemptQueryMarkers) && cleanClaimsEntry.exemptQueryMarkers.length > 0,
      'F-f3bef3a1: exemptQueryMarkers must be present and non-empty, or this entry silently reverts to a whole-file skip',
    );
  });

  it('today\'s real file is fully compliant: the vouched query passes and the by-id lookup is correctly exempt', () => {
    const text = readFileSync(join(PKG_ROOT, CLEAN_CLAIMS_REL), 'utf-8');
    const offenders = findFilterDisciplineOffenders(CLEAN_CLAIMS_REL, text, cleanClaimsEntry);
    assert.deepEqual(offenders, [],
      'clean-claims.js must be fully compliant today — this describe block only proves red-capability on a mutant below, not a live defect');
  });

  it('PIN: dropping the filter from the vouched latestPerDomainOnLatestWave query trips the guard (mutation proof)', () => {
    const text = readFileSync(join(PKG_ROOT, CLEAN_CLAIMS_REL), 'utf-8');
    // The exact interpolation the allowlist reason vouches for ("its one
    // latest-per-domain site... does adopt LATEST_AGENT_RUN_PER_DOMAIN").
    // This form (WITH the ${} wrapper) is the ONLY occurrence outside the
    // plain-identifier import statement, so stripping it cannot accidentally
    // corrupt the import and silently produce a no-op mutant.
    const marker = '${LATEST_AGENT_RUN_PER_DOMAIN}';
    assert.ok(text.includes(marker), 'latestPerDomainOnLatestWave interpolation not found — mutation-proof pin is stale, update the marker');
    assert.equal(text.split(marker).length - 1, 1,
      'expected exactly ONE occurrence of the interpolation form — mutant patch is stale, update it');
    const mutated = text.replace(marker, '');
    assert.notEqual(mutated, text, 'mutant text must differ from the real file');

    const offenders = findFilterDisciplineOffenders(CLEAN_CLAIMS_REL, mutated, cleanClaimsEntry);
    assert.equal(offenders.length, 1,
      'F-f3bef3a1: dropping the vouched query\'s filter must trip exactly one offender (the vouched query itself); ' +
      `a bare file-level allowlist entry would have produced ZERO — got: ${JSON.stringify(offenders)}`);

    // Lens the other direction: the offender must be the vouched
    // latestPerDomainOnLatestWave query, not the (still legitimately exempt,
    // untouched-by-this-mutation) --agent-run by-id lookup — proving
    // exemptQueryMarkers doesn't over-correct into flagging the query it's
    // actually supposed to exempt. Computed relative to the owner-lookup's
    // own line (not a hardcoded number) so this stays robust to unrelated
    // edits elsewhere in the file.
    const ownerMarker = cleanClaimsEntry.exemptQueryMarkers[0];
    const ownerLine = mutated.slice(0, mutated.indexOf(ownerMarker)).split('\n').length;
    const offenderLine = Number(offenders[0].match(/:(\d+)\s+—/)[1]);
    assert.ok(offenderLine > ownerLine,
      `expected the offender to be the latestPerDomainOnLatestWave query (after the exempt owner lookup at line ${ownerLine}), got line ${offenderLine}`);
  });

  it('control: today\'s UNMODIFIED file stays fully compliant (isolates the mutant above as the cause)', () => {
    const text = readFileSync(join(PKG_ROOT, CLEAN_CLAIMS_REL), 'utf-8');
    const offenders = findFilterDisciplineOffenders(CLEAN_CLAIMS_REL, text, cleanClaimsEntry);
    assert.deepEqual(offenders, []);
  });
});
