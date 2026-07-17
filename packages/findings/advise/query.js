/**
 * Query layer over accepted dogfood learning artifacts.
 *
 * Retrieves findings, patterns, recommendations, and doctrine
 * filtered by surface, execution mode, journey stage, issue kind,
 * and transfer scope. Respects ranking and caps.
 */

import { loadFindings } from '../reader.js';
import { loadPatterns, loadRecommendations, loadDoctrines } from '../synthesis/write-artifacts.js';

/**
 * Query accepted findings by scope.
 *
 * @param {string} rootDir
 * @param {object} scope
 * @param {string} [scope.surface]
 * @param {string} [scope.executionMode]
 * @param {string} [scope.journeyStage]
 * @param {string} [scope.issueKind]
 * @param {string} [scope.repo]
 * @param {number} [scope.limit=8]
 * @returns {Array}
 */
export function queryFindings(rootDir, scope = {}) {
  const all = loadFindings(rootDir);
  const limit = scope.limit || 8;

  const accepted = all.filter(f =>
    f.valid &&
    f.data?.status === 'accepted' &&
    !f.data?.invalidation?.is_invalidated
  );

  let results = accepted.map(f => f.data);

  if (scope.surface) results = results.filter(f => f.product_surface === scope.surface);
  if (scope.executionMode) results = results.filter(f => f.execution_mode === scope.executionMode);
  if (scope.journeyStage) results = results.filter(f => f.journey_stage === scope.journeyStage);
  if (scope.issueKind) results = results.filter(f => f.issue_kind === scope.issueKind);
  if (scope.repo) results = results.filter(f => f.repo === scope.repo);

  // Rank: more specific transfer_scope first, then by surface match
  results = rankByRelevance(results, scope);

  return results.slice(0, limit);
}

/**
 * Query accepted patterns by scope.
 */
export function queryPatterns(rootDir, scope = {}) {
  const all = loadPatterns(rootDir);
  const limit = scope.limit || 5;

  let results = all.filter(p =>
    p.status === 'accepted' &&
    !(p.review?.last_action === 'invalidate')
  );

  if (scope.surface) {
    results = results.filter(p =>
      (p.dimensions?.product_surfaces || []).includes(scope.surface)
    );
  }
  if (scope.issueKind) {
    results = results.filter(p =>
      (p.dimensions?.issue_kinds || []).includes(scope.issueKind)
    );
  }

  // Rank: strong > emerging, more specific scope first
  results.sort((a, b) => {
    const strengthOrder = { portfolio_stable: 0, strong: 1, emerging: 2 };
    const aStr = strengthOrder[a.pattern_strength] ?? 3;
    const bStr = strengthOrder[b.pattern_strength] ?? 3;
    if (aStr !== bStr) return aStr - bStr;
    return scopeSpecificity(b.transfer_scope) - scopeSpecificity(a.transfer_scope);
  });

  return results.slice(0, limit);
}

/**
 * Query accepted recommendations by scope.
 */
export function queryRecommendations(rootDir, scope = {}) {
  const all = loadRecommendations(rootDir);
  const limit = scope.limit || 5;

  let results = all.filter(r => r.status === 'accepted');

  if (scope.surface) {
    results = results.filter(r =>
      (r.applies_to?.product_surfaces || []).includes(scope.surface)
    );
  }
  if (scope.executionMode) {
    results = results.filter(r =>
      !r.applies_to?.execution_modes?.length ||
      r.applies_to.execution_modes.includes(scope.executionMode)
    );
  }

  // Rank: strong confidence > emerging
  results.sort((a, b) => {
    const confOrder = { proven: 0, strong: 1, emerging: 2 };
    return (confOrder[a.confidence] ?? 3) - (confOrder[b.confidence] ?? 3);
  });

  return results.slice(0, limit);
}

/**
 * Query accepted doctrine by scope.
 *
 * F-d022c023: the surface-scoping filter below used to end in a bare `true`
 * — since doctrine.transfer_scope is a closed 3-value enum
 * (packages/schemas/src/json/dogfood-doctrine.schema.json: org_wide,
 * execution_mode, surface_archetype) and the first two branches already
 * matched two of the three values explicitly, the trailing `true` made the
 * WHOLE expression unconditionally true for every doctrine record — a
 * structural no-op covering 100% of the enum, not a rare edge case.
 * Replacing that `true` with a third literal `transfer_scope ===
 * 'surface_archetype'` comparison would be an equally-complete no-op (the
 * three literal branches would still exhaust the closed enum and always be
 * true) — so it does NOT satisfy this fix; it would just move the dead code
 * one line over. doctrine itself carries NO per-record surface field to
 * compare against (the schema's `additionalProperties: false` rules one out
 * without a schema/version bump), so a REAL surface_archetype check has to
 * reach through `based_on_pattern_ids` to the patterns' own
 * `dimensions.product_surfaces` — the same signal `queryPatterns` above
 * already uses, and the literal thing this function's own (correct) comment
 * about org_wide/execution_mode always says: "surface_archetype applies if
 * pattern surfaces match."
 */
export function queryDoctrine(rootDir, scope = {}) {
  const all = loadDoctrines(rootDir);
  const limit = scope.limit || 5;

  let results = all.filter(d => d.status === 'accepted');

  if (scope.surface) {
    // org_wide and execution_mode are surface-agnostic BY DEFINITION (their
    // whole point is applying beyond any single surface), so they always
    // pass once ANY surface is requested — that part of the original intent
    // was correct and is unchanged. surface_archetype is the one scope tied
    // to a specific surface lineage: does the requested surface appear in
    // the dimensions.product_surfaces of AT LEAST ONE pattern this doctrine
    // is based_on_pattern_ids-derived from?
    const patternSurfacesById = new Map(
      loadPatterns(rootDir).map(p => [p.pattern_id, p.dimensions?.product_surfaces || []])
    );
    results = results.filter(d => {
      if (d.transfer_scope === 'org_wide' || d.transfer_scope === 'execution_mode') return true;
      return (d.based_on_pattern_ids || []).some(
        pid => patternSurfacesById.get(pid)?.includes(scope.surface)
      );
    });
  }

  results.sort((a, b) => {
    const strOrder = { foundational: 0, proven: 1, emerging: 2 };
    return (strOrder[a.strength] ?? 3) - (strOrder[b.strength] ?? 3);
  });

  return results.slice(0, limit);
}

/**
 * Extract top failure classes from accepted findings for a scope.
 */
export function queryFailureClasses(rootDir, scope = {}) {
  const findings = queryFindings(rootDir, { ...scope, limit: 50 });
  const counts = new Map();

  for (const f of findings) {
    const key = f.issue_kind;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([issueKind, count]) => ({ issueKind, count }));
}

// ─── Ranking helpers ────────────────────────────────────────

const SCOPE_ORDER = ['repo_local', 'surface_local', 'surface_archetype', 'execution_mode', 'org_wide'];

function scopeSpecificity(scope) {
  const idx = SCOPE_ORDER.indexOf(scope);
  return idx >= 0 ? SCOPE_ORDER.length - idx : 0; // higher = more specific
}

function rankByRelevance(findings, scope) {
  return findings.sort((a, b) => {
    // Exact surface match first
    const aSurface = scope.surface && a.product_surface === scope.surface ? 1 : 0;
    const bSurface = scope.surface && b.product_surface === scope.surface ? 1 : 0;
    if (aSurface !== bSurface) return bSurface - aSurface;

    // More specific scope first
    const aSpec = scopeSpecificity(a.transfer_scope);
    const bSpec = scopeSpecificity(b.transfer_scope);
    if (aSpec !== bSpec) return bSpec - aSpec;

    return 0;
  });
}
