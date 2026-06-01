/**
 * Doctrine derivation from strong accepted patterns.
 *
 * Doctrine is the most conservative artifact in the system.
 * Requirements:
 *   - At least 1 accepted pattern (2+ for org_wide scope)
 *   - Pattern strength must be 'strong' or 'portfolio_stable'
 *   - Statement must be rule-like, not advisory
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import yaml from 'js-yaml';
import { loadAcceptedPatterns, loadAcceptedPatternsWithSkips } from './recommendation-derivation.js';

/**
 * Derive doctrine from strong accepted patterns.
 *
 * D2B-001 — return shape carries a `skipped: [{path, error}]` field so the
 * silent-loader signal propagates through the derive API. A torn pattern
 * that WOULD have been considered for doctrine synthesis no longer
 * disappears with no signal. Legacy callers reading `doctrines` / `stats`
 * are unaffected.
 *
 * @param {string} rootDir - dogfood-labs repo root
 * @returns {{ doctrines: Array, skipped: Array<{path: string, error: string}>, stats: { patternsConsidered: number, doctrinesEmitted: number, belowThreshold: number, patternsSkipped: number } }}
 */
export function deriveDoctrine(rootDir) {
  const { entries, skipped } = loadAcceptedPatternsWithSkips(rootDir);
  const patterns = entries.map(e => e.data);
  const strong = patterns.filter(p =>
    p.pattern_strength === 'strong' || p.pattern_strength === 'portfolio_stable'
  );

  const doctrines = [];
  let belowThreshold = 0;

  // Group strong patterns by shared doctrine theme
  const themes = groupByDoctrineTheme(strong);

  for (const [theme, themePatterns] of themes) {
    // org_wide doctrine requires 2+ patterns
    const maxScope = widestScope(themePatterns);
    if (maxScope === 'org_wide' && themePatterns.length < 2) {
      belowThreshold++;
      continue;
    }

    doctrines.push(buildDoctrineCandidate(theme, themePatterns));
  }

  return {
    doctrines,
    skipped, // D2B-001: structured skip list for operator legibility
    stats: {
      patternsConsidered: patterns.length,
      doctrinesEmitted: doctrines.length,
      belowThreshold,
      patternsSkipped: skipped.length
    }
  };
}

/**
 * Group patterns by doctrine theme (shared root cause family).
 */
function groupByDoctrineTheme(patterns) {
  const themes = new Map();
  for (const p of patterns) {
    const rootCauses = p.dimensions?.root_cause_kinds || [];
    const theme = rootCauses[0] || 'general';
    if (!themes.has(theme)) themes.set(theme, []);
    themes.get(theme).push(p);
  }
  return themes;
}

function widestScope(patterns) {
  const order = ['repo_local', 'surface_local', 'surface_archetype', 'execution_mode', 'org_wide'];
  let widest = 0;
  for (const p of patterns) {
    const idx = order.indexOf(p.transfer_scope);
    if (idx > widest) widest = idx;
  }
  return order[widest];
}

function buildDoctrineCandidate(theme, patterns) {
  const now = new Date().toISOString();
  const issueKinds = [...new Set(patterns.flatMap(p => p.dimensions?.issue_kinds || []))];
  const surfaces = [...new Set(patterns.flatMap(p => p.dimensions?.product_surfaces || []))];
  const scope = widestScope(patterns);

  const kind = classifyDoctrineKind(issueKinds, theme);
  const slug = `${theme}-${kind}`.replace(/_/g, '-');

  return {
    schema_version: '1.0.0',
    doctrine_id: `ddoc-${slug}`,
    title: buildDoctrineTitle(theme, issueKinds, surfaces),
    status: 'candidate',
    doctrine_kind: kind,
    statement: buildDoctrineStatement(theme, issueKinds, surfaces),
    rationale: buildDoctrineRationale(patterns, theme),
    based_on_pattern_ids: patterns.map(p => p.pattern_id),
    transfer_scope: scope === 'repo_local' || scope === 'surface_local' ? 'surface_archetype' : scope,
    strength: patterns.length >= 3 ? 'foundational' : 'proven',
    created_at: now,
    updated_at: now
  };
}

function classifyDoctrineKind(issueKinds, theme) {
  if (/evidence/.test(theme) || issueKinds.some(k => /evidence/.test(k))) return 'evidence_law';
  if (/surface|interface/.test(theme)) return 'surface_law';
  if (/policy|calibration/.test(theme)) return 'calibration_law';
  if (/verification|provenance/.test(theme)) return 'verification_law';
  return 'rollout_law';
}

function buildDoctrineTitle(theme, issueKinds, surfaces) {
  const label = theme.replace(/_/g, ' ');
  const surfaceStr = surfaces.length ? surfaces.join(', ') : 'all surfaces';
  return `${label}: verified rule for ${surfaceStr}`;
}

function buildDoctrineStatement(theme, issueKinds, surfaces) {
  const issueLabel = issueKinds.map(k => k.replace(/_/g, ' ')).join(' and ');
  const surfaceStr = surfaces.length ? surfaces.join(', ') : 'all product surfaces';
  return `Verify ${issueLabel} truth before authoring rollout assumptions for ${surfaceStr}. This is a proven recurring failure class — do not skip this step.`;
}

function buildDoctrineRationale(patterns, theme) {
  const findingCount = patterns.reduce((sum, p) => sum + (p.support?.finding_count || 0), 0);
  const repoCount = patterns.reduce((sum, p) => sum + (p.support?.repo_count || 0), 0);
  return `Backed by ${patterns.length} accepted pattern(s) covering ${findingCount} findings across ${repoCount} repo(s). The ${theme.replace(/_/g, ' ')} root cause recurs independently across multiple contexts, confirming this is structural, not incidental.`;
}
