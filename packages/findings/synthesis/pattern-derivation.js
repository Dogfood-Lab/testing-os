/**
 * Deterministic pattern derivation from accepted findings.
 *
 * Clusters accepted, non-invalidated findings by shared dimensions:
 *   issue_kind + root_cause_kind + (optionally) product_surface
 *
 * A pattern candidate forms when 2+ accepted findings share these dimensions.
 */

import { loadFindings } from '../reader.js';

/**
 * Derive candidate patterns from accepted findings.
 *
 * D2B-001 — return shape carries a `skipped: [{ path, error }]` field so the
 * silent-loader signal that the recommendation/doctrine derive stages already
 * surface now also propagates through pattern derivation. `loadFindings`
 * (reader.js) returns a torn / unparseable finding YAML as
 * `{ valid: false, errors: [{ message }] }`; a torn file that on disk WAS an
 * accepted finding would otherwise be filtered out of clustering with zero
 * operator signal, quietly shrinking the evidence base behind a pattern's
 * strength or threshold. The `skipped` list documents that partial-completion
 * honestly. Legacy callers reading only `patterns` / `stats` are unaffected —
 * the field is additive.
 *
 * @param {string} rootDir - dogfood-labs repo root
 * @param {{ includeFixtures?: boolean }} opts
 * @returns {{ patterns: Array, skipped: Array<{path: string, error: string}>, stats: { findingsConsidered: number, clustersFound: number, belowThreshold: number, findingsSkipped: number } }}
 */
export function derivePatterns(rootDir, opts = {}) {
  // Load only accepted, non-invalidated findings
  const allFindings = loadFindings(rootDir);
  if (opts.includeFixtures) {
    allFindings.push(...loadFindings(rootDir, { fixtures: true, fixtureKind: 'valid' }));
  }

  // D2B-001 — partition torn / unreadable findings into a structured skip list
  // BEFORE the accepted filter drops them. A `valid:false` record is a finding
  // YAML that failed parse (reader.js sets errors[0].message to the parse error)
  // or schema validation; its on-disk status is unknowable, so a torn file that
  // WAS an accepted finding must not vanish silently from clustering.
  const skipped = allFindings
    .filter(f => f.valid === false)
    .map(f => ({ path: f.path, error: f.errors?.[0]?.message || 'unknown read/parse error' }));

  const accepted = allFindings.filter(f =>
    f.valid &&
    f.data?.status === 'accepted' &&
    !f.data?.invalidation?.is_invalidated
  );

  // Cluster by shared dimensions
  const clusters = new Map();

  for (const f of accepted) {
    const d = f.data;
    const key = buildClusterKey(d);

    if (!clusters.has(key)) {
      clusters.set(key, {
        issue_kind: d.issue_kind,
        root_cause_kind: d.root_cause_kind,
        remediation_kind: d.remediation_kind,
        findings: []
      });
    }
    clusters.get(key).findings.push(d);
  }

  // Filter clusters to those meeting threshold (2+ findings)
  const patterns = [];
  let belowThreshold = 0;

  for (const [key, cluster] of clusters) {
    if (cluster.findings.length < 2) {
      belowThreshold++;
      continue;
    }

    // Check for false recurrence: all from same repo AND same source record
    if (isFalseRecurrence(cluster.findings)) {
      belowThreshold++;
      continue;
    }

    patterns.push(buildPatternCandidate(cluster));
  }

  return {
    patterns,
    skipped, // D2B-001: structured skip list for operator legibility
    stats: {
      findingsConsidered: accepted.length,
      clustersFound: clusters.size,
      belowThreshold,
      findingsSkipped: skipped.length
    }
  };
}

/**
 * Build a cluster key from shared dimensions.
 */
function buildClusterKey(finding) {
  return `${finding.issue_kind}::${finding.root_cause_kind}`;
}

/**
 * Check for false recurrence: all findings from same root incident.
 */
function isFalseRecurrence(findings) {
  // If all findings share exact same source_record_ids set, it's likely one incident split by extraction
  if (findings.length < 2) return true;

  const recordSets = findings.map(f => (f.source_record_ids || []).sort().join(','));
  const unique = new Set(recordSets);
  return unique.size === 1; // All from same records = false recurrence
}

/**
 * Build a pattern candidate from a cluster.
 */
function buildPatternCandidate(cluster) {
  const { findings, issue_kind, root_cause_kind, remediation_kind } = cluster;
  const now = new Date().toISOString();

  // Compute support dimensions
  const repos = new Set(findings.map(f => f.repo));
  const surfaces = new Set(findings.map(f => f.product_surface));
  const modes = new Set(findings.flatMap(f => f.execution_mode ? [f.execution_mode] : []));
  const remediations = new Set(findings.map(f => f.remediation_kind));

  // Determine transfer scope (widest from findings)
  const scopes = findings.map(f => f.transfer_scope);
  const transfer_scope = widenScope(scopes);

  // Determine pattern kind
  const pattern_kind = classifyPatternKind(issue_kind);

  // Build slug — must include every dimension in the cluster key (issue_kind + root_cause_kind),
  // otherwise two clusters that differ only by root_cause_kind collide on pattern_id and the
  // second writePattern() silently overwrites the first on disk. Surface is added for readability,
  // not for uniqueness.
  const surfaceStr = surfaces.size === 1 ? [...surfaces][0] : 'multi-surface';
  const slug = `${surfaceStr}-${issue_kind}-${root_cause_kind}`.replace(/_/g, '-');

  // Determine strength
  const strength = repos.size >= 3 ? 'strong' : repos.size >= 2 ? 'emerging' : 'emerging';

  return {
    schema_version: '1.0.0',
    pattern_id: `dpat-${slug}`,
    title: buildPatternTitle(issue_kind, surfaces, repos.size),
    status: 'candidate',
    pattern_kind,
    summary: buildPatternSummary(findings, issue_kind, root_cause_kind),
    source_finding_ids: findings.map(f => f.finding_id),
    support: {
      finding_count: findings.length,
      repo_count: repos.size,
      surface_count: surfaces.size,
      ...(modes.size > 0 ? { execution_modes: [...modes] } : {})
    },
    dimensions: {
      product_surfaces: [...surfaces],
      issue_kinds: [issue_kind],
      root_cause_kinds: [root_cause_kind],
      remediation_kinds: [...remediations]
    },
    transfer_scope,
    pattern_strength: strength,
    lineage_note: `Derived from ${findings.length} accepted findings across ${repos.size} repo(s).`,
    created_at: now,
    updated_at: now
  };
}

function classifyPatternKind(issueKind) {
  if (/evidence/.test(issueKind)) return 'evidence_calibration';
  if (/verification|provenance/.test(issueKind)) return 'verification_seam';
  if (/policy|freshness/.test(issueKind)) return 'calibration_signal';
  if (/build|entrypoint|flag|interface|surface/.test(issueKind)) return 'recurring_failure';
  return 'recurring_failure';
}

function widenScope(scopes) {
  const order = ['repo_local', 'surface_local', 'surface_archetype', 'execution_mode', 'org_wide'];
  let widest = 0;
  for (const s of scopes) {
    const idx = order.indexOf(s);
    if (idx > widest) widest = idx;
  }
  return order[widest];
}

function buildPatternTitle(issueKind, surfaces, repoCount) {
  const surfaceStr = surfaces.size === 1 ? `${[...surfaces][0]}` : `${surfaces.size} surfaces`;
  const label = issueKind.replace(/_/g, ' ');
  return `${label} recurs across ${repoCount} repo(s) on ${surfaceStr}`;
}

function buildPatternSummary(findings, issueKind, rootCause) {
  const repos = [...new Set(findings.map(f => f.repo))];
  const repoNames = repos.map(r => r.split('/').pop()).join(', ');
  return `Multiple accepted findings show ${issueKind.replace(/_/g, ' ')} caused by ${rootCause.replace(/_/g, ' ')} across repos: ${repoNames}. This recurrence indicates a structural pattern, not isolated incidents.`;
}
