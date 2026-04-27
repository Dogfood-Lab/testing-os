/**
 * persist.js — `swarm persist <run-id>`
 *
 * Exports canonical truth from the control plane and bridges it to:
 *   1. Dogfood-labs evidence store (submission → ingest)
 *   2. Repo-knowledge audit DB (run + findings + metrics)
 *   3. Local export directory (JSON artifacts)
 *
 * Only persists canonical, review-worthy truth. Not raw agent chatter.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { openDb } from '../db/connection.js';
import { buildRunExport, computeRunVerdict } from '../lib/persist/export.js';
import { buildDogfoodSubmission } from '../lib/persist/dogfood-bridge.js';
import { buildAuditPayload } from '../lib/persist/repoknowledge-bridge.js';

// Resolve REPO_ROOT off this file (commands/persist.js → packages/dogfood-swarm → repo root).
// Mirrors the pattern in persist-results.js so the ingest path survives the consumer's cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

/**
 * @param {object} opts
 * @param {string} opts.runId
 * @param {string} opts.dbPath
 * @param {string} opts.outputDir — where to write export artifacts
 * @param {boolean} [opts.ingestDogfood] — run dogfood-labs ingest
 * @param {boolean} [opts.dryRun] — export only, don't ingest
 * @returns {object} — persist report
 */
export function persist(opts) {
  const db = openDb(opts.dbPath);

  // Build canonical export
  const exportData = buildRunExport(db, opts.runId);
  const verdict = computeRunVerdict(exportData);

  const exportDir = join(opts.outputDir, 'persist');
  if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

  const report = {
    runId: opts.runId,
    verdict,
    artifacts: {},
    dogfood: null,
    repoKnowledge: null,
  };

  // 1. Write canonical export
  const exportPath = join(exportDir, 'run-export.json');
  writeFileSync(exportPath, JSON.stringify(exportData, null, 2) + '\n', 'utf-8');
  report.artifacts.export = exportPath;

  // 2. Build + write dogfood submission
  const submission = buildDogfoodSubmission(exportData, verdict);
  const submissionPath = join(exportDir, 'dogfood-submission.json');
  writeFileSync(submissionPath, JSON.stringify(submission, null, 2) + '\n', 'utf-8');
  report.artifacts.dogfoodSubmission = submissionPath;

  // 3. Build + write repo-knowledge audit payload
  const auditPayload = buildAuditPayload(exportData);
  const auditDir = join(exportDir, 'audit');
  if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true });

  writeFileSync(join(auditDir, 'run.json'), JSON.stringify(auditPayload.run, null, 2) + '\n', 'utf-8');
  writeFileSync(join(auditDir, 'findings.json'), JSON.stringify(auditPayload.findings, null, 2) + '\n', 'utf-8');
  writeFileSync(join(auditDir, 'metrics.json'), JSON.stringify(auditPayload.metrics, null, 2) + '\n', 'utf-8');
  report.artifacts.audit = auditDir;

  // 4. Ingest to dogfood-labs (if not dry run)
  if (opts.ingestDogfood && !opts.dryRun) {
    try {
      // Post testing-os monorepo migration: ingest lives at packages/ingest/run.js.
      // See persist-results.js:222 for the canonical pattern. F-742440-002.
      const ingestScript = resolve(REPO_ROOT, 'packages/ingest/run.js');
      if (existsSync(ingestScript)) {
        execSync(`node "${ingestScript}" --provenance=stub --file "${submissionPath}"`, {
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf-8',
        });
        report.dogfood = { ingested: true, path: submissionPath };
      } else {
        report.dogfood = { ingested: false, reason: 'Ingest script not found' };
      }
    } catch (e) {
      report.dogfood = { ingested: false, reason: e.message };
    }
  } else {
    report.dogfood = { ingested: false, reason: opts.dryRun ? 'Dry run' : 'Not requested' };
  }

  // 5. Summary
  report.repoKnowledge = {
    exported: true,
    path: auditDir,
    status: auditPayload.run.overall_status,
    posture: auditPayload.run.overall_posture,
  };

  return report;
}

/**
 * Format persist report for CLI output.
 */
export function formatPersist(r) {
  const lines = [];

  lines.push(`Persist — ${r.runId}`);
  lines.push(`Verdict: ${r.verdict}`);
  lines.push('');

  lines.push('Artifacts:');
  lines.push(`  Export:      ${r.artifacts.export}`);
  lines.push(`  Submission:  ${r.artifacts.dogfoodSubmission}`);
  lines.push(`  Audit dir:   ${r.artifacts.audit}`);
  lines.push('');

  lines.push('Dogfood-labs:');
  if (r.dogfood?.ingested) {
    lines.push(`  Ingested: YES`);
  } else {
    lines.push(`  Ingested: NO — ${r.dogfood?.reason}`);
  }
  lines.push('');

  lines.push('Repo-knowledge:');
  lines.push(`  Status: ${r.repoKnowledge?.status} (${r.repoKnowledge?.posture})`);
  lines.push(`  Path:   ${r.repoKnowledge?.path}`);

  return lines.join('\n');
}
