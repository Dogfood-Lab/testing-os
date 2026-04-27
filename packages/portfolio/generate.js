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

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(import.meta.dirname, '..', '..');
const INDEX_PATH = join(ROOT, 'indexes', 'latest-by-repo.json');
// F-721047-004 — POLICIES_ROOT is the parent of all per-org dirs.
// loadPolicies() enumerates every subdir at runtime so newly-onboarded orgs
// (e.g. dogfood-lab/*, alongside the original mcp-tool-shop-org/*) are
// auto-picked-up without code change. The README threat model documents
// dispatches from BOTH orgs as valid; the previous hardcoded path silently
// dropped dogfood-lab/* repos from the portfolio.
const POLICIES_ROOT = join(ROOT, 'policies', 'repos');
const DEFAULT_OUTPUT = join(ROOT, 'reports', 'dogfood-portfolio.json');

const ALL_SURFACES = ['cli', 'desktop', 'web', 'api', 'mcp-server', 'npm-package', 'plugin', 'library'];
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
  const yamlFiles = entries.filter(e => e.isFile() && e.name.endsWith('.yaml'));

  // Multi-org root: enumerate every org subdir. yamlFiles at the root are
  // ignored in this mode because policies are by contract scoped to an org.
  if (subDirs.length > 0 && yamlFiles.length === 0) {
    for (const dir of subDirs) {
      const orgDir = join(policiesDir, dir.name);
      Object.assign(policies, loadPoliciesFromOrgDir(orgDir));
    }
    return policies;
  }

  // Single-org dir (legacy shape): walk yaml files directly.
  return loadPoliciesFromOrgDir(policiesDir);
}

function loadPoliciesFromOrgDir(orgDir) {
  const policies = {};
  if (!existsSync(orgDir)) return policies;

  for (const file of readdirSync(orgDir)) {
    if (!file.endsWith('.yaml')) continue;
    const text = readFileSync(join(orgDir, file), 'utf-8');
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

// --- Main generation ---

export function generatePortfolio(index, policies, { logger = console } = {}) {
  const repos = [];
  const stale = [];
  const unknownFreshness = [];
  const surfacesSeen = new Set();

  // Process index entries
  for (const [repo, surfaces] of Object.entries(index)) {
    for (const [surface, record] of Object.entries(surfaces)) {
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--output' && args[i + 1]) outputPath = args[++i];
  }

  if (!existsSync(INDEX_PATH)) {
    console.error(`Index not found: ${INDEX_PATH}`);
    process.exit(1);
  }

  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf-8'));
  const policies = loadPolicies(POLICIES_ROOT);
  const portfolio = generatePortfolio(index, policies);

  const outputDir = join(outputPath, '..');
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  writeFileSync(outputPath, JSON.stringify(portfolio, null, 2) + '\n');

  console.log(`Portfolio generated: ${outputPath}`);
  console.log(`  Repos: ${portfolio.coverage.total_repos}`);
  console.log(`  Surfaces: ${portfolio.coverage.surfaces_covered}/${portfolio.coverage.surfaces_total}`);
  console.log(`  Stale: ${portfolio.stale.length}`);
  console.log(`  Missing: ${portfolio.missing.length}`);
  console.log(`  Unknown freshness: ${portfolio.unknown_freshness.length}`);
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
