/**
 * persist-results.js — Bridge swarm audit results into dogfood-labs (git records)
 * and repo-knowledge (audit DB).
 *
 * Usage:
 *   node tools/swarm/persist-results.js <manifest-dir>
 *
 * Exit codes: 0 = success, 1 = dogfood ingest failure, 2 = error
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildSubmission } from '@dogfood-lab/report/build-submission.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

// --- Helpers ---

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function readJsonDir(dirPath) {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(dirPath, f)));
}

function surfaceFromType(componentType) {
  const map = {
    backend: 'cli', service: 'cli', cli: 'cli', api: 'cli',
    frontend: 'web', web: 'web', ui: 'web', site: 'web',
    library: 'cli', package: 'cli', plugin: 'cli',
  };
  return map[(componentType || '').toLowerCase()] || 'cli';
}

function deriveVerdict(findings) {
  const criticals = findings.filter(f => f.severity === 'critical' && f.status !== 'fixed');
  const highs = findings.filter(f => f.severity === 'high' && f.status !== 'fixed');
  if (criticals.length > 0) return 'fail';
  if (highs.length > 0) return 'partial';
  return 'pass';
}

function stepResult(name, ok) {
  return { step: name, status: ok ? 'pass' : 'fail' };
}

// --- Path A: Dogfood submission ---

function buildScenarioResults(auditResults, remediateResults) {
  const remediateMap = new Map();
  for (const r of remediateResults) {
    remediateMap.set(r.component_id, r);
  }

  return auditResults.map(audit => {
    const cid = audit.component_id;
    const remediation = remediateMap.get(cid);
    const findings = audit.findings || [];
    const openFindings = findings.filter(f => f.status !== 'fixed');
    const verdict = deriveVerdict(findings);

    return {
      scenario_id: `swarm-audit-${cid}`,
      product_surface: surfaceFromType(audit.component_type),
      verdict,
      step_results: [
        stepResult('explore', true),
        stepResult('audit', true),
        stepResult('remediate', !!remediation),
        stepResult('verify', verdict === 'pass'),
      ],
      evidence: {
        total_findings: findings.length,
        open_findings: openFindings.length,
        fixed: findings.length - openFindings.length,
        severities: {
          critical: findings.filter(f => f.severity === 'critical').length,
          high: findings.filter(f => f.severity === 'high').length,
          medium: findings.filter(f => f.severity === 'medium').length,
          low: findings.filter(f => f.severity === 'low').length,
        },
      },
    };
  });
}

function computeOverallVerdict(scenarioResults) {
  if (scenarioResults.some(s => s.verdict === 'fail')) return 'fail';
  if (scenarioResults.some(s => s.verdict === 'partial')) return 'partial';
  return 'pass';
}

// --- Path B: Audit DB payload ---

function buildAuditPayload(manifest, auditResults, remediateResults) {
  const allControls = auditResults.flatMap(a => a.controls || []);
  const allFindings = auditResults.flatMap(a => a.findings || []);

  // Apply remediation fixes to findings
  const fixedIds = new Set();
  for (const r of remediateResults) {
    for (const fix of (r.fixes || [])) {
      if (fix.finding_id) fixedIds.add(fix.finding_id);
    }
  }
  for (const f of allFindings) {
    if (fixedIds.has(f.id)) f.status = 'fixed';
  }

  const openFindings = allFindings.filter(f => f.status !== 'fixed');
  const critical = openFindings.filter(f => f.severity === 'critical').length;
  const high = openFindings.filter(f => f.severity === 'high').length;
  const medium = openFindings.filter(f => f.severity === 'medium').length;
  const low = openFindings.filter(f => f.severity === 'low').length;
  const controlsPassed = allControls.filter(c => c.status === 'pass').length;

  const domains = new Set();
  for (const c of allControls) if (c.domain) domains.add(c.domain);
  for (const f of allFindings) if (f.domain) domains.add(f.domain);

  const fixedCount = allFindings.filter(f => f.status === 'fixed').length;
  const overallStatus = critical > 0 ? 'fail' : openFindings.length > 0 ? 'pass_with_findings' : 'pass';
  const overallPosture = critical > 0 ? 'critical' : (high > 0 ? 'needs_attention' : 'healthy');

  return {
    run: {
      slug: manifest.repo,
      commit_sha: manifest.commit_sha,
      overall_status: overallStatus,
      overall_posture: overallPosture,
      scope_level: 'full',
      domains_checked: [...domains].sort(),
      summary: `Swarm audit: ${allFindings.length} findings (${critical} critical, ${high} high). ${fixedCount} fixed.`,
      blocking_release: critical > 0,
    },
    controls: allControls,
    findings: allFindings,
    metrics: {
      critical_count: critical,
      high_count: high,
      medium_count: medium,
      low_count: low,
      controls_passed: controlsPassed,
      controls_total: allControls.length,
      pass_rate: allControls.length > 0
        ? Math.round((controlsPassed / allControls.length) * 10000) / 10000
        : 0,
    },
  };
}

// --- Exports (for testing) ---

export { surfaceFromType, deriveVerdict, buildScenarioResults, computeOverallVerdict, buildAuditPayload };

// --- Main ---

const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (!isCLI) { /* imported as module — skip CLI */ } else {

const manifestDir = process.argv[2];
if (!manifestDir) {
  console.error('Usage: node tools/swarm/persist-results.js <manifest-dir>');
  process.exit(2);
}

const absDir = resolve(manifestDir);
const manifestPath = join(absDir, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(`ERROR: manifest.json not found in ${absDir}`);
  process.exit(2);
}

const manifest = readJson(manifestPath);
const required = ['repo', 'commit_sha', 'branch', 'swarm_id', 'started_at', 'finished_at'];
for (const field of required) {
  if (!manifest[field]) {
    console.error(`ERROR: manifest.json missing required field "${field}"`);
    process.exit(2);
  }
}

const auditResults = readJsonDir(join(absDir, 'audit'));
if (auditResults.length === 0) {
  console.error('ERROR: no audit result files found in audit/');
  process.exit(2);
}

const remediateResults = readJsonDir(join(absDir, 'remediate'));

// Path A: Build and ingest dogfood submission
const scenarioResults = buildScenarioResults(auditResults, remediateResults);
const overallVerdict = computeOverallVerdict(scenarioResults);

const submission = buildSubmission({
  repo: manifest.repo,
  commitSha: manifest.commit_sha,
  branch: manifest.branch,
  workflow: 'swarm-audit',
  providerRunId: manifest.swarm_id,
  runUrl: `https://github.com/${manifest.repo}`,
  startedAt: manifest.started_at,
  finishedAt: manifest.finished_at,
  scenarioResults,
  overallVerdict,
});

const submissionPath = join(absDir, 'submission.json');
writeFileSync(submissionPath, JSON.stringify(submission, null, 2) + '\n', 'utf-8');
console.error(`Wrote submission to ${submissionPath}`);

// Ingest via CLI — packages/ingest/run.js after the testing-os monorepo migration.
const ingestScript = resolve(REPO_ROOT, 'packages/ingest/run.js');
try {
  execSync(`node "${ingestScript}" --provenance=stub --file "${submissionPath}"`, {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} catch (e) {
  // F-091578-012 (wave-17): bare 'ERROR: dogfood ingest failed' scrolled past
  // the operator's eye after the underlying ingest output. Surface the
  // submission path + a copy-pasteable reproduce command so the operator can
  // replay the failure with full output isolation.
  console.error('ERROR [INGEST_FAILED]: dogfood ingest exited non-zero');
  console.error(`  Submission: ${submissionPath}`);
  console.error(`  Reproduce:  node "${ingestScript}" --provenance=stub --file "${submissionPath}"`);
  if (e && e.status != null) console.error(`  Exit code:  ${e.status}`);
  if (e && e.message) console.error(`  Cause:      ${e.message}`);
  process.exit(1);
}

// Path B: Build audit DB payload
const auditPayload = buildAuditPayload(manifest, auditResults, remediateResults);
const auditPayloadPath = join(absDir, 'audit-payload.json');
writeFileSync(auditPayloadPath, JSON.stringify(auditPayload, null, 2) + '\n', 'utf-8');
console.error(`Wrote audit payload to ${auditPayloadPath}`);

// Print path for coordinator to call audit_submit
console.log(auditPayloadPath);

} // end isCLI guard
