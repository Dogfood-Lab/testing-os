#!/usr/bin/env node

/**
 * Portfolio generator.
 *
 * Reads indexes/latest-by-repo.json + policies/repos/ to produce
 * reports/dogfood-portfolio.json — a queryable org-level summary
 * of dogfood coverage, freshness, and enforcement state.
 *
 * Usage:
 *   node tools/portfolio/generate.js
 *   node tools/portfolio/generate.js --output /tmp/portfolio.json
 */

import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import yaml from 'js-yaml';

import { computeTrends } from './lib/compute-trends.js';
import { generateBadges } from './lib/generate-badges.js';
// FT-f — the served trends/badges artifacts go out under the same temp+rename
// discipline the rest of testing-os uses for indexes/, so a torn write never
// leaves a half-written endpoint JSON that a consumer's shields.io fetch (or the
// raw.githubusercontent.com read API) would choke on. atomicWriteFileSync is the
// extracted leaf helper from @dogfood-lab/findings; reaching it via the
// `./lib/*` subpath export (not the package root) keeps this a single-purpose
// cross-package edge, the same seam discipline the dependency-graph cycle note
// in CLAUDE.md prescribes. portfolio is not in that cycle, so this adds no new one.
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';

// d3-ingest-B002 (Stage C humanization) — PORTFOLIO_REPO_ROOT lets a test
// harness redirect every read/write (INDEX_PATH, POLICIES_ROOT, the output
// report) into a sandbox instead of the REAL working tree, so the corrupt-index
// branch can be exercised without touching real indexes/. A production caller
// leaves it unset and gets the historical `../..` walk. resolve() makes a
// relative override absolute so the downstream join()s stay anchored. Mirrors
// the INGEST_REPO_ROOT override in packages/ingest/run.js.
const ROOT = process.env.PORTFOLIO_REPO_ROOT
  ? resolve(process.env.PORTFOLIO_REPO_ROOT)
  : resolve(import.meta.dirname, '..', '..');
const INDEX_PATH = join(ROOT, 'indexes', 'latest-by-repo.json');
// F-721047-004 — POLICIES_ROOT is the parent of all per-org dirs.
// loadPolicies() enumerates every subdir at runtime so newly-onboarded orgs
// (e.g. dogfood-lab/*, alongside the original mcp-tool-shop-org/*) are
// auto-picked-up without code change. The README threat model documents
// dispatches from BOTH orgs as valid; the previous hardcoded path silently
// dropped dogfood-lab/* repos from the portfolio.
const POLICIES_ROOT = join(ROOT, 'policies', 'repos');
const DEFAULT_OUTPUT = join(ROOT, 'reports', 'dogfood-portfolio.json');
// F3-001 / F5-04 / FT-f — read-API artifacts SERVED out of indexes/ alongside
// latest-by-repo.json. indexes/ is the committed shared backing store consumers
// read over raw.githubusercontent.com/dogfood-lab/testing-os/main/...; these two
// surfaces (the trend/regression history and the per-repo+surface shields.io
// endpoints) are the served read API for trends + badges. They were previously
// git-ignored (the deliverable was framed as the GENERATOR, not a snapshot), but
// an endpoint that is computed and never committed cannot be fetched by a README
// badge or a dashboard — FT-f redirects them to the served location. The
// matching .gitignore entries are removed by the ci-tooling agent so they commit.
const TRENDS_OUTPUT = join(ROOT, 'indexes', 'trends.json');
const BADGES_DIR = join(ROOT, 'indexes', 'badges');

// d3-ingest-B003 (Stage C humanization) — ALL_SURFACES is DERIVED from the
// authoritative product_surface enum in dogfood-record-submission.schema.json,
// not a hand-maintained duplicate. It is load-bearing twice (parsePolicy drops
// any surface not in this list; coverage.surfaces_total reports its length), so
// a hand list would silently shrink the portfolio the moment a future schema
// bump adds a surface (e.g. 'mobile') — the same "unknown surface names
// silently dropped" brittleness F-246817-003 set out to kill, reintroduced one
// layer up. We read the canonical JSON via createRequire on the schemas
// package's `./json/*` subpath export — the exact single-source-of-truth seam
// dogfood-swarm/lib/templates.js + validate-agent-output.js already use, so the
// list cannot drift from the wire contract the verifier enforces.
const require = createRequire(import.meta.url);
const SUBMISSION_SCHEMA_PATH = require.resolve(
  '@dogfood-lab/schemas/json/dogfood-record-submission.schema.json'
);
const ALL_SURFACES = (() => {
  const schema = JSON.parse(readFileSync(SUBMISSION_SCHEMA_PATH, 'utf-8'));
  const surfaces =
    schema?.properties?.scenario_results?.items?.properties?.product_surface?.enum;
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    // Fail LOUD with a coded, actionable message rather than silently degrading
    // to an empty surface list (which would zero the coverage denominator).
    throw new Error(
      `portfolio: could not derive product_surface enum from ${SUBMISSION_SCHEMA_PATH} ` +
      `— expected properties.scenario_results.items.properties.product_surface.enum to be a ` +
      `non-empty array. The @dogfood-lab/schemas contract may have moved; update the derivation path.`
    );
  }
  return surfaces;
})();
const DEFAULT_MAX_AGE = 30;
const DEFAULT_WARN_AGE = 14;

// --- Policy parsing (real YAML parser via js-yaml) ---
//
// F-246817-003 — replaced the hand-rolled regex parser with js-yaml.
// The regex parser had several documented brittleness modes:
//   - enforcement.reason could match a `reason:` from a sibling block
//   - duplicate `repo:` keys would silently take the first match
//   - non-numeric max_age_days became NaN, breaking stale comparisons
//   - unknown surface names were silently dropped without signal
// js-yaml is an existing workspace dep used by the verify, findings, and
// ingest packages.

export function parsePolicy(rawText) {
  let doc;
  try {
    doc = yaml.load(rawText);
  } catch (err) {
    // Malformed YAML — return empty policy so the caller can decide whether
    // to skip the file or surface the error. Mirrors the original
    // tolerant-parse contract.
    return { enforcement: { mode: 'required', reason: null, review_after: null }, surfaces: {} };
  }

  if (!doc || typeof doc !== 'object') {
    return { enforcement: { mode: 'required', reason: null, review_after: null }, surfaces: {} };
  }

  const rawEnforcement = (doc.enforcement && typeof doc.enforcement === 'object') ? doc.enforcement : {};
  const enforcement = {
    mode: typeof rawEnforcement.mode === 'string' ? rawEnforcement.mode : 'required',
    reason: typeof rawEnforcement.reason === 'string' ? rawEnforcement.reason.trim() : null,
    review_after: rawEnforcement.review_after != null ? String(rawEnforcement.review_after) : null,
  };

  const surfaces = {};
  const rawSurfaces = (doc.surfaces && typeof doc.surfaces === 'object') ? doc.surfaces : {};
  for (const [name, raw] of Object.entries(rawSurfaces)) {
    if (!ALL_SURFACES.includes(name)) continue;
    if (!raw || typeof raw !== 'object') continue;

    const scenariosRaw = Array.isArray(raw.required_scenarios) ? raw.required_scenarios : [];
    const scenarios = scenariosRaw.map(s => String(s).trim()).filter(Boolean);

    const maxAge = Number.isFinite(Number(raw.max_age_days))
      ? Math.trunc(Number(raw.max_age_days))
      : DEFAULT_MAX_AGE;
    const warnAge = Number.isFinite(Number(raw.warn_age_days))
      ? Math.trunc(Number(raw.warn_age_days))
      : DEFAULT_WARN_AGE;

    surfaces[name] = {
      scenario: scenarios.length > 0 ? scenarios[0] : null,
      scenarios,
      max_age_days: maxAge,
      warn_age_days: warnAge,
    };
  }

  return { enforcement, surfaces };
}

// F-721047-004 — `policiesDir` may be either:
//   - a per-org directory (legacy callers, tests): walk only that dir
//   - the policies/repos/ root (default CLI path): enumerate every org subdir
// The shape is detected by reading the directory's entries — if any subdir
// exists, treat the input as the root and recurse one level. This keeps the
// existing single-dir callers working while making multi-org onboarding a
// no-code-change operation.
export function loadPolicies(policiesDir) {
  const policies = {};
  if (!existsSync(policiesDir)) return policies;

  const entries = readdirSync(policiesDir, { withFileTypes: true });
  const subDirs = entries.filter(e => e.isDirectory());

  // Multi-org root: the presence of ANY org subdir defines the shape. A stray
  // yaml at the root (misplaced file, accidental save) must not flip this back
  // to single-org mode — doing so silently drops every org subdir's policies
  // while coverage still reports healthy. Root-level yamls are by contract not
  // policies (policies are scoped to an org dir), so they are ignored here.
  if (subDirs.length > 0) {
    for (const dir of subDirs) {
      const orgDir = join(policiesDir, dir.name);
      Object.assign(policies, loadPoliciesFromOrgDir(orgDir));
    }
    return policies;
  }

  // Single-org dir (legacy shape): no subdirs, walk yaml files directly.
  return loadPoliciesFromOrgDir(policiesDir);
}

function loadPoliciesFromOrgDir(orgDir) {
  const policies = {};
  if (!existsSync(orgDir)) return policies;

  for (const file of readdirSync(orgDir)) {
    if (!file.endsWith('.yaml')) continue;
    const filePath = join(orgDir, file);
    // d3-ingest-B001 (Stage C humanization) — the READ joins the parse-failure
    // path. Pre-fix only yaml.load() was wrapped; a read-time IO error (EACCES
    // on a permission-restricted file, EBUSY/EISDIR/transient lock from a
    // Windows AV/Search-Indexer/editor handle — the very class renameWithRetry
    // defends against) on a SINGLE policy YAML propagated up through
    // loadPolicies → main and dropped ALL repos from the portfolio. Now one bad
    // file degrades to a skip + a console.warn naming the file, matching
    // loadRecord's one-bad-file tolerance in rebuild-indexes.js, so the
    // operator knows which policy went missing and why instead of getting a raw
    // EACCES/EBUSY stack and no portfolio at all.
    let text;
    try {
      text = readFileSync(filePath, 'utf-8');
    } catch (err) {
      const reason = err && err.message ? err.message : String(err);
      console.warn(
        `portfolio: skipping unreadable policy file ${filePath}: ${reason} ` +
        `(other repos still included; re-run once the file is readable)`
      );
      continue;
    }
    let doc;
    try {
      doc = yaml.load(text);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object' || typeof doc.repo !== 'string') continue;
    const repo = doc.repo.trim();
    if (!repo) continue;
    policies[repo] = parsePolicy(text);
  }
  return policies;
}

// --- Freshness ---
//
// F-246817-005 — return `null` (not Infinity) for unparseable input. The
// previous Infinity sentinel got JSON.stringify'd to `null` downstream
// anyway, but the comparison `Infinity > maxAge` was always true so corrupt
// records were silently flagged stale instead of surfaced as data-quality
// issues. We now return null and the caller (generatePortfolio) routes the
// entry into the `unknown_freshness` bucket with a console.warn instead of
// silently treating the row as both serializable AND stale.

export function computeFreshnessDays(finishedAt) {
  if (finishedAt == null) return null;
  const ts = new Date(finishedAt).getTime();
  if (isNaN(ts)) return null;
  return Math.floor((Date.now() - ts) / 86400000);
}

// --- Deterministic serialization for the served read-API artifacts ---
//
// badge-serving-loop-incomplete — indexes/trends.json is regenerated and
// committed at ingest time, so its bytes must be STABLE across runs and
// machines: a churned key order produces a noisy, misleading diff. The trend
// object's repo keys come from computeTrends' records/ walk (readdirSync order,
// which is filesystem-dependent and NOT guaranteed sorted), so we sort keys
// recursively at the serialization boundary — the same "normalize once, at the
// boundary" discipline compute-trends.js applies to path separators. Arrays
// (the per-surface `history`) keep their order: it is the chronological order
// computeTrends already establishes deterministically, and reordering it would
// destroy meaning. Only plain-object keys are sorted.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

// --- Main generation ---

export function generatePortfolio(index, policies, { logger = console } = {}) {
  const repos = [];
  const stale = [];
  const unknownFreshness = [];
  const surfacesSeen = new Set();

  // Process index entries
  for (const [repo, surfaces] of Object.entries(index)) {
    // PORT-DEGRADE-001 (Stage C humanization) — a per-repo value that is not a
    // plain object (e.g. "org/repo": null, or a string from a hand-edit slip)
    // would throw a raw TypeError at the inner Object.entries(surfaces). Degrade
    // to a skip + a named warn — the same one-bad-entry tolerance loadPolicies
    // and computeTrends already use — so the report still generates for the
    // healthy rows and the operator learns WHICH repo's index entry is malformed.
    if (surfaces === null || typeof surfaces !== 'object' || Array.isArray(surfaces)) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(
          `portfolio: skipping malformed index entry for ${repo}: expected a ` +
          `surface->record object, got ${Array.isArray(surfaces) ? 'an array' : typeof surfaces} ` +
          `(other repos still included; re-run any ingest to rebuild indexes/)`
        );
      }
      continue;
    }

    for (const [surface, record] of Object.entries(surfaces)) {
      // PORT-DEGRADE-001 — likewise a per-surface value that is not a plain
      // object would crash at record.finished_at / record.verified below. Skip
      // it with a warn naming repo+surface; the healthy sibling surfaces survive.
      if (record === null || typeof record !== 'object' || Array.isArray(record)) {
        if (logger && typeof logger.warn === 'function') {
          logger.warn(
            `portfolio: skipping malformed record for ${repo}/${surface}: expected a ` +
            `record object, got ${Array.isArray(record) ? 'an array' : typeof record} ` +
            `(other surfaces still included; re-run any ingest to rebuild indexes/)`
          );
        }
        continue;
      }

      surfacesSeen.add(surface);

      const policy = policies[repo];
      const surfacePolicy = policy?.surfaces?.[surface];
      const maxAge = surfacePolicy?.max_age_days ?? DEFAULT_MAX_AGE;
      const freshnessDays = computeFreshnessDays(record.finished_at);

      const entry = {
        repo,
        surface,
        verified: record.verified,
        enforcement: policy?.enforcement?.mode ?? 'required',
        freshness_days: freshnessDays,
        scenario: surfacePolicy?.scenario ?? null,
        scenarios: surfacePolicy?.scenarios ?? [],
        run_id: record.run_id,
        finished_at: record.finished_at,
      };

      repos.push(entry);

      // F-246817-005 — null freshness means the upstream finished_at was
      // unparseable; route into a separate bucket rather than silently
      // treating the record as both serializable AND stale.
      if (freshnessDays === null) {
        unknownFreshness.push({ repo, surface, raw_finished_at: record.finished_at ?? null });
        if (logger && typeof logger.warn === 'function') {
          logger.warn(`portfolio: unparseable finished_at for ${repo}/${surface}: ${JSON.stringify(record.finished_at)}`);
        }
      } else if (freshnessDays > maxAge) {
        stale.push({ repo, surface, freshness_days: freshnessDays, max_age_days: maxAge });
      }
    }
  }

  // Find missing: repos with policies but no index entry
  const missing = [];
  for (const [repo, policy] of Object.entries(policies)) {
    for (const surface of Object.keys(policy.surfaces)) {
      const inIndex = index[repo]?.[surface];
      if (!inIndex) {
        missing.push({ repo, surface, enforcement: policy.enforcement.mode });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    coverage: {
      total_repos: new Set(repos.map(r => r.repo)).size,
      surfaces_covered: surfacesSeen.size,
      surfaces_total: ALL_SURFACES.length,
    },
    repos: repos.sort((a, b) => a.repo.localeCompare(b.repo)),
    stale,
    missing,
    unknown_freshness: unknownFreshness,
  };
}

// --- CLI ---

function main() {
  const args = process.argv.slice(2);
  let outputPath = DEFAULT_OUTPUT;
  let emitTrends = true;
  let emitBadges = true;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
    // F3-001 / F5-04 — opt out of the side artifacts. The `trends` key is
    // always merged into the report; these flags only gate the separate
    // indexes/trends.json + indexes/badges/ writes (both git-ignored).
    else if (args[i] === '--no-trends') emitTrends = false;
    else if (args[i] === '--no-badges') emitBadges = false;
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(
        [
          'Usage: portfolio [--output <path>] [--no-trends] [--no-badges]',
          '',
          'Generate the cross-repo dogfood portfolio report from indexes/latest-by-repo.json',
          'and policies/repos/. Also emits two git-ignored runtime artifacts:',
          '',
          '  --output <path>   Portfolio report path (default reports/dogfood-portfolio.json)',
          '  --no-trends       Skip writing indexes/trends.json (the per-repo+surface run',
          '                    history, regression/recovery flags, and windowed pass-rate',
          '                    are still merged into the report under the "trends" key)',
          '  --no-badges       Skip writing indexes/badges/<org>--<repo>--<surface>.json',
          '                    shields.io endpoint files (plus the _aggregate.json',
          '                    fleet-wide rollup pill)',
          '  -h, --help        Show this help',
        ].join('\n')
      );
      process.exit(0);
    }
  }

  if (!existsSync(INDEX_PATH)) {
    console.error(`Index not found: ${INDEX_PATH}`);
    process.exit(1);
  }

  // d3-ingest-B002 (Stage C humanization) — guard a CORRUPT/truncated index the
  // same way the existsSync branch above guards a MISSING one. rebuild-indexes.js
  // is engineered to keep emitting indexes/latest-by-repo.json under
  // crash/partial-failure pressure, so a half-written file is a realistic state.
  // Pre-fix this threw a raw `SyntaxError: Unexpected end of JSON input` and the
  // operator had to reverse-engineer that the INDEX (not their command) was the
  // problem. Now they get a structured message naming the file + the idempotent
  // recovery action — mirroring the recovery hint run.js prints when
  // rebuildIndexes throws.
  let index;
  try {
    index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    console.error(
      `Index is corrupt or truncated: ${INDEX_PATH}: ${reason}`
    );
    console.error(
      'Recovery: re-run any ingest to trigger a full rebuild of indexes/ (the rebuild is idempotent — it scans records/ end-to-end).'
    );
    process.exit(1);
  }

  // PORT-DEGRADE-001 (Stage C humanization) — a SHAPE guard joins the B002
  // syntax guard above. latest-by-repo.json is contractually a `{ repo:
  // { surface: record } }` map; a valid-JSON-but-wrong-shape top level (null,
  // an array, a bare string/number — a hand-edit slip or a half-written file
  // that happened to parse) reached Object.entries(index) in generatePortfolio
  // and threw a raw `TypeError: Cannot convert undefined or null to object`
  // (or, for an array, walked index-keyed garbage). The operator could not tell
  // the INDEX was the problem, not their command. Treat it exactly like the
  // corrupt-index branch: name the file + the idempotent recovery action, fail
  // CLOSED. (Per-entry wrong shapes — one repo whose value is malformed — are
  // handled inside generatePortfolio as a degrade-to-skip + named warn, so a
  // single bad row never sinks the whole report.)
  if (index === null || typeof index !== 'object' || Array.isArray(index)) {
    console.error(
      `Index is corrupt or truncated: ${INDEX_PATH}: expected a JSON object ` +
      `mapping repo -> surface -> record, got ${Array.isArray(index) ? 'an array' : typeof index}.`
    );
    console.error(
      'Recovery: re-run any ingest to trigger a full rebuild of indexes/ (the rebuild is idempotent — it scans records/ end-to-end).'
    );
    process.exit(1);
  }
  const policies = loadPolicies(POLICIES_ROOT);
  const portfolio = generatePortfolio(index, policies);

  // F3-001 — compute the trend surface from the FULL dated records/ history
  // (generatePortfolio only sees the collapsed latest-by-repo index, so it
  // cannot express a trend). Merge it into the report under `trends` and,
  // unless opted out, emit indexes/trends.json (git-ignored runtime artifact).
  //
  // d3-portfolio-B001 — capture computeTrends' degradation tally so the summary
  // below can report how many records the trend scan had to exclude. A partial
  // trend that reads "no regressions" is dangerous if the operator can't see it
  // skipped corrupt records or an unreadable subtree.
  const trendSkips = {};
  const trends = computeTrends(ROOT, { skipTally: trendSkips });
  portfolio.trends = trends;

  const outputDir = join(outputPath, '..');
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  atomicWriteFileSync(outputPath, JSON.stringify(portfolio, null, 2) + '\n');

  if (emitTrends) {
    const trendsDir = join(TRENDS_OUTPUT, '..');
    if (!existsSync(trendsDir)) mkdirSync(trendsDir, { recursive: true });
    // Sort keys so the committed served artifact diffs minimally on regenerate.
    atomicWriteFileSync(TRENDS_OUTPUT, JSON.stringify(sortKeysDeep(trends), null, 2) + '\n');
  }

  // F5-04 — emit one shields.io endpoint JSON per repo+surface so any repo
  // README can render a live dogfood pass/fail/stale pill. Written after the
  // portfolio so a failed portfolio write surfaces before we fan out files.
  let badgeCount = 0;
  if (emitBadges) {
    const badges = generateBadges(index);
    if (!existsSync(BADGES_DIR)) mkdirSync(BADGES_DIR, { recursive: true });
    // Fan out in sorted filename order so the write sequence is stable across
    // runs — each endpoint file's bytes are already deterministic, this keeps
    // the per-file content sorted too (schemaVersion/label/message/color).
    for (const filename of Object.keys(badges).sort()) {
      atomicWriteFileSync(
        join(BADGES_DIR, filename),
        JSON.stringify(sortKeysDeep(badges[filename]), null, 2) + '\n',
      );
      badgeCount++;
    }
  }

  // Count repos/surfaces with a regression flagged in the trend surface.
  const regressedCount = Object.values(trends)
    .flatMap((surfaces) => Object.values(surfaces))
    .filter((t) => t.regressed).length;

  console.log(`Portfolio generated: ${outputPath}`);
  console.log(`  Repos: ${portfolio.coverage.total_repos}`);
  console.log(`  Surfaces: ${portfolio.coverage.surfaces_covered}/${portfolio.coverage.surfaces_total}`);
  console.log(`  Stale: ${portfolio.stale.length}`);
  console.log(`  Missing: ${portfolio.missing.length}`);
  console.log(`  Unknown freshness: ${portfolio.unknown_freshness.length}`);
  console.log(`  Regressed (pass→fail): ${regressedCount}`);
  // d3-portfolio-B001 — only surface the skip line when the trend scan actually
  // dropped something; a clean corpus stays quiet. When it did degrade, name the
  // breakdown so the operator can weigh the trend's completeness.
  if (trendSkips.corruptRecords || trendSkips.unreadableSubtrees || trendSkips.droppedRecords) {
    console.log(
      `  Trend records skipped: ${trendSkips.corruptRecords} corrupt, ` +
      `${trendSkips.unreadableSubtrees} unreadable subtrees, ` +
      `${trendSkips.droppedRecords} dropped (non-accepted/malformed)`
    );
  }
  if (emitTrends) console.log(`  Trends written: ${TRENDS_OUTPUT}`);
  if (emitBadges) console.log(`  Badges written: ${badgeCount} → ${BADGES_DIR}`);
}

// F-002109-016 — only run main() when invoked directly as a CLI, not on import.
// Without this guard, importing anything from this module (e.g. from generate.test.js)
// triggers a full CLI execution: reads INDEX_PATH, walks POLICIES_DIR, and overwrites
// reports/dogfood-portfolio.json. Worse, if INDEX_PATH is missing, process.exit(1) kills
// the importing process. Sibling packages/report/build-submission.js uses an endsWith
// guard; we use the stricter file-URL form because the bin entry resolves through a
// shim and `process.argv[1]` may be the absolute path, not the package-relative one.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
