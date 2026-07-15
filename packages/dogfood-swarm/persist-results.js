/**
 * persist-results.js — Bridge swarm audit results into dogfood-labs (git records)
 * and repo-knowledge (audit DB).
 *
 * Usage:
 *   node tools/swarm/persist-results.js <manifest-dir>
 *
 * Exit codes: 0 = success, 1 = dogfood ingest failure, 2 = error
 */

import { readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildSubmission } from '@dogfood-lab/report/build-submission.js';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';

import { readBoundedJson } from './lib/bounded-json-read.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

// --- Helpers ---

// F-H5 (Wave A1 D3): operator-supplied manifest dir contents (audit/* and
// remediate/* JSONs) go through the bounded helper instead of bare
// readFileSync + JSON.parse. The persist-results CLI is invoked by a
// coordinator from the command line; pointing it at a path that contains a
// huge spurious JSON file should fail loudly with a structured size-limit
// error, not silently OOM the coordinator.
function readJson(filePath) {
  return readBoundedJson(filePath);
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

// d4-swarm-core-001 (Stage A): the canonical in-flight severity is UPPERCASE.
// The agent-output schema enum is ['CRITICAL','HIGH','MEDIUM','LOW'], the DB
// STATUS.severity enum is uppercase, lib/templates.js instructs agents to emit
// "CRITICAL|HIGH|MEDIUM|LOW", and every in-package sibling
// (lib/persist/dogfood-bridge.js, lib/persist/repoknowledge-bridge.js,
// lib/advance.js, commands/receipt.js, lib/findings-digest.js) keys on
// UPPERCASE. persist-results.js reads audit/* via readJsonDir -> readBoundedJson
// (raw JSON.parse, no case transform) so those findings carry the uppercase
// agent severity. Normalize at the comparison boundary so a stray case never
// silently zeroes the release gate — every severity comparison in this file
// goes through sevUpper(), the package-wide uppercase convention.
function sevUpper(f) {
  return String(f && f.severity || '').toUpperCase();
}

function deriveVerdict(findings) {
  const criticals = findings.filter(f => sevUpper(f) === 'CRITICAL' && f.status !== 'fixed');
  const highs = findings.filter(f => sevUpper(f) === 'HIGH' && f.status !== 'fixed');
  if (criticals.length > 0) return 'fail';
  if (highs.length > 0) return 'partial';
  return 'pass';
}

/**
 * Emit a single step_result. The dogfood-record-submission schema requires
 * `step_id` (pattern `^[a-z0-9][a-z0-9-]*$`) and `status` (enum) on each item
 * AND has `additionalProperties:false` on step_results items — so the legacy
 * `{step, status}` shape was loudly rejected by `validatePayload`. F-C1 (Wave
 * A1 D3): align with the in-package sibling `lib/persist/dogfood-bridge.js`
 * which already emits `step_id`.
 */
function stepResult(name, ok) {
  return { step_id: name, status: ok ? 'pass' : 'fail' };
}

// --- Shared: remediation application (F-7545196d / F-b5cd4274) ---

/**
 * The set of finding ids any remediate result claims to have fixed.
 */
function collectFixedIds(remediateResults) {
  const fixedIds = new Set();
  for (const r of remediateResults) {
    for (const fix of (r.fixes || [])) {
      if (fix.finding_id) fixedIds.add(fix.finding_id);
    }
  }
  return fixedIds;
}

/**
 * Apply remediation fixes to findings, returning NEW audit-result objects
 * (and new finding objects within them) rather than writing through to the
 * caller's arrays.
 *
 * F-7545196d: buildScenarioResults (Path A, the published dogfood submission)
 * used to build a remediateMap but only consult it for the `remediate` step
 * flag — never for `deriveVerdict`/`openFindings`, which scored the RAW
 * pre-remediation status. buildAuditPayload (Path B, the audit DB) DID apply
 * fixes. One CRITICAL plus a matching remediate fix produced Path A
 * `overall_verdict: 'fail'` (a self-contradictory step_results 'remediate:
 * pass' next to 'verify: fail') alongside Path B `overall_status: 'pass'` for
 * the SAME data — and Path A is the one that ships to the shared records/
 * corpus other repos read over raw.githubusercontent URLs.
 *
 * F-b5cd4274: buildAuditPayload additionally MUTATED the finding objects it
 * was given in place (`f.status = 'fixed'`), and those objects are shared
 * references into the caller's auditResults array — so which of Path A/Path B
 * ran FIRST silently changed the other's answer. Deriving the fixed set once
 * and mapping to brand-new objects (never `f.status = ...` through a shared
 * reference) fixes both defects with the same edit: apply this ONCE, before
 * either path builds anything, and pass the result to BOTH.
 */
function applyRemediation(auditResults, remediateResults) {
  const fixedIds = collectFixedIds(remediateResults);
  return auditResults.map(a => ({
    ...a,
    findings: (a.findings || []).map(f => (fixedIds.has(f.id) ? { ...f, status: 'fixed' } : f)),
  }));
}

// --- Path A: Dogfood submission ---

function buildScenarioResults(auditResults, remediateResults) {
  const resolved = applyRemediation(auditResults, remediateResults);
  const remediateMap = new Map();
  for (const r of remediateResults) {
    remediateMap.set(r.component_id, r);
  }

  return resolved.map(audit => {
    const cid = audit.component_id;
    const remediation = remediateMap.get(cid);
    const findings = audit.findings || [];
    const openFindings = findings.filter(f => f.status !== 'fixed');
    const verdict = deriveVerdict(findings);

    // F-C1 (Wave A1 D3): execution_mode is REQUIRED on each scenario_result
    // by dogfood-record-submission.schema.json (line 135). Swarm audits run
    // headless via the swarm control plane — 'bot' matches the sibling
    // dogfood-bridge.js which already emits execution_mode:'bot'.
    //
    // The schema also requires `evidence` (when present) to be an ARRAY of
    // {kind, url} items. The previous shape — an OBJECT carrying counts —
    // was schema-invalid. We keep the count data inside the array item's
    // `description` so the audit-payload path (Path B) still carries the
    // counts; the scenario-results path now emits schema-clean evidence.
    const totalFindings = findings.length;
    const openCount = openFindings.length;
    const fixedCount = totalFindings - openCount;
    const sev = {
      critical: findings.filter(f => sevUpper(f) === 'CRITICAL').length,
      high: findings.filter(f => sevUpper(f) === 'HIGH').length,
      medium: findings.filter(f => sevUpper(f) === 'MEDIUM').length,
      low: findings.filter(f => sevUpper(f) === 'LOW').length,
    };
    const evidenceDescription =
      `${totalFindings} finding(s): ${openCount} open, ${fixedCount} fixed; ` +
      `severities — critical:${sev.critical} high:${sev.high} ` +
      `medium:${sev.medium} low:${sev.low}`;

    return {
      scenario_id: `swarm-audit-${cid}`,
      product_surface: surfaceFromType(audit.component_type),
      execution_mode: 'bot',
      verdict,
      step_results: [
        stepResult('explore', true),
        stepResult('audit', true),
        stepResult('remediate', !!remediation),
        stepResult('verify', verdict === 'pass'),
      ],
      evidence: [{
        kind: 'artifact',
        url: `swarm://audit/${cid}`,
        description: evidenceDescription,
      }],
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
  // F-b5cd4274: resolve remediation into NEW objects via the SAME helper
  // buildScenarioResults uses, instead of mutating `f.status` through to the
  // caller's shared finding references. Both builders are now pure functions
  // of the same (auditResults, remediateResults) pair — the order they run
  // in (or whether either runs at all) cannot change the other's answer.
  const resolved = applyRemediation(auditResults, remediateResults);
  const allControls = resolved.flatMap(a => a.controls || []);
  const allFindings = resolved.flatMap(a => a.findings || []);

  const openFindings = allFindings.filter(f => f.status !== 'fixed');
  const critical = openFindings.filter(f => sevUpper(f) === 'CRITICAL').length;
  const high = openFindings.filter(f => sevUpper(f) === 'HIGH').length;
  const medium = openFindings.filter(f => sevUpper(f) === 'MEDIUM').length;
  const low = openFindings.filter(f => sevUpper(f) === 'LOW').length;
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
atomicWriteFileSync(submissionPath, JSON.stringify(submission, null, 2) + '\n', 'utf-8');
console.error(`Wrote submission to ${submissionPath}`);

// Ingest via CLI — packages/ingest/run.js after the testing-os monorepo migration.
const ingestScript = resolve(REPO_ROOT, 'packages/ingest/run.js');
try {
  // F-1f7f9de8: argv-array form (execFileSync), never a shell-string exec —
  // sibling of F-21240958 (commands/persist.js:91, same shape, already
  // fixed). `submissionPath` derives from `absDir = resolve(manifestDir)`
  // where `manifestDir = process.argv[2]` — an operator-supplied CLI
  // positional, unvalidated for shell metacharacters — and was previously
  // embedded inside a double-quoted argument in a string handed to execSync,
  // which always invokes a shell (unlike execFileSync). A `manifestDir`
  // containing a `"` would break out of the quoted argument. execFileSync
  // with an argv array never invokes a shell to parse arguments, so there is
  // no quoting to get right and no metacharacter surface at all — matching
  // every sibling git/node invocation in this package (dispatch.js's
  // execFileSync('git', [...]), lib/worktree.js, and F-21240958's fix).
  execFileSync('node', [ingestScript, '--provenance=stub', '--file', submissionPath], {
    stdio: ['ignore', 'inherit', 'inherit'],
    // SEED-2: forward the ingest DATA root so it stays overridable. run.js
    // honors INGEST_REPO_ROOT for the records/ + indexes/ it writes; in
    // production this resolves to REPO_ROOT (the real corpus), but a test can
    // point it at a temp dir so the ingest never touches the real repo tree.
    env: { ...process.env, INGEST_REPO_ROOT: process.env.INGEST_REPO_ROOT || REPO_ROOT },
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
atomicWriteFileSync(auditPayloadPath, JSON.stringify(auditPayload, null, 2) + '\n', 'utf-8');
console.error(`Wrote audit payload to ${auditPayloadPath}`);

// Print path for coordinator to call audit_submit
console.log(auditPayloadPath);

} // end isCLI guard
