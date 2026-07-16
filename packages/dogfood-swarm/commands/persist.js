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

import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';
import { openDb } from '../db/connection.js';
import { buildRunExport, computeRunVerdict } from '../lib/persist/export.js';
import { buildDogfoodSubmission } from '../lib/persist/dogfood-bridge.js';
import { buildAuditPayload } from '../lib/persist/repoknowledge-bridge.js';
import { escapeReasonForDisplay } from './lib/escape-reason.js';

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
  atomicWriteFileSync(exportPath, JSON.stringify(exportData, null, 2) + '\n', 'utf-8');
  report.artifacts.export = exportPath;

  // 2. Build + write dogfood submission
  const submission = buildDogfoodSubmission(exportData, verdict);
  const submissionPath = join(exportDir, 'dogfood-submission.json');
  atomicWriteFileSync(submissionPath, JSON.stringify(submission, null, 2) + '\n', 'utf-8');
  report.artifacts.dogfoodSubmission = submissionPath;

  // 3. Build + write repo-knowledge audit payload
  const auditPayload = buildAuditPayload(exportData);
  const auditDir = join(exportDir, 'audit');
  if (!existsSync(auditDir)) mkdirSync(auditDir, { recursive: true });

  atomicWriteFileSync(join(auditDir, 'run.json'), JSON.stringify(auditPayload.run, null, 2) + '\n', 'utf-8');
  atomicWriteFileSync(join(auditDir, 'findings.json'), JSON.stringify(auditPayload.findings, null, 2) + '\n', 'utf-8');
  atomicWriteFileSync(join(auditDir, 'metrics.json'), JSON.stringify(auditPayload.metrics, null, 2) + '\n', 'utf-8');
  report.artifacts.audit = auditDir;

  // 4. Ingest to dogfood-labs (if not dry run)
  if (opts.ingestDogfood && !opts.dryRun) {
    try {
      // Post testing-os monorepo migration: ingest lives at packages/ingest/run.js.
      // See persist-results.js:222 for the canonical pattern. F-742440-002.
      const ingestScript = resolve(REPO_ROOT, 'packages/ingest/run.js');
      if (existsSync(ingestScript)) {
        // F-21240958: argv-array form (execFileSync), never a shell-string
        // exec. `submissionPath` carries the operator-settable SWARM_DB env
        // var AND the <run-id> CLI positional (neither shell-metacharacter-
        // validated), and `ingestScript` derives from the install path.
        // execFileSync never invokes a shell, so there is no quoting to get
        // right and no metacharacter surface at all — matching every
        // sibling git/node invocation in this package (dispatch.js's
        // execFileSync('git', [...]), lib/worktree.js, and — as of
        // F-264bd9d2, wave 20 — commands/init.js's git() helper).
        //
        // F-264bd9d2 (wave 20): this comment previously claimed to be "the
        // only shell-string exec in the package's command layer". That was
        // inaccurate when written — persist-results.js's sibling instance
        // (F-1f7f9de8) and init.js's git() helper (fixed this wave) both
        // predated it — and it is not a claim this file can verify on its
        // own: there is still no mechanical gate (e.g. a meta-test grepping
        // commands/**+cli.js for `execSync(` with a template-literal
        // argument) preventing a future instance from reintroducing the
        // pattern elsewhere in this package.
        execFileSync('node', [ingestScript, '--provenance=stub', '--file', submissionPath], {
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf-8',
          // SEED-2: forward the ingest DATA root so it stays overridable. run.js
          // honors INGEST_REPO_ROOT for the records/ + indexes/ it writes;
          // defaults to REPO_ROOT (the real corpus) in production, but a test
          // can redirect it to a temp dir so the ingest never touches the real
          // repo tree.
          env: { ...process.env, INGEST_REPO_ROOT: process.env.INGEST_REPO_ROOT || REPO_ROOT },
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
  //
  // fp-p-004: this step only WROTE three local audit JSON files (run/
  // findings/metrics) into <outputDir>/persist/audit via atomicWrite. It does
  // NOT perform the `rk audit import` / `audit_submit` into the repo-knowledge
  // DB — that is the coordinator's downstream step. Reporting a bare
  // `exported: true` / `Status: pass` conflated "wrote audit files locally"
  // with "audit landed in the repo-knowledge DB" and could make an operator
  // believe the submission happened. Reflect what actually occurred: artifacts
  // written here, submission still pending. Mirrors the dogfood path's honest
  // Ingested: YES/NO phrasing so both downstream targets report consistently.
  report.repoKnowledge = {
    artifactsWritten: true,
    submitted: false,
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
    // F-bf28b667 (wave 20): r.dogfood.reason is not adversary-controlled
    // (it is either a fixed literal — 'Dry run' / 'Not requested' / 'Ingest
    // script not found' — or, on a failed ingest, a local execFileSync
    // child-process error message: `Command failed: <cmd>\n<stderr>`, per
    // Node's own child_process error shape), but that stderr CAN legitimately
    // be multi-line (packages/ingest/run.js's own validation output). Escaped
    // for display robustness so a multi-line ingest failure renders as one
    // summary line instead of visually fragmenting into several, matching
    // this package's escaping convention for every other reason-shaped
    // render site rather than leaving this one as a silent exception.
    lines.push(`  Ingested: NO — ${escapeReasonForDisplay(r.dogfood?.reason)}`);
  }
  lines.push('');

  lines.push('Repo-knowledge:');
  // fp-p-004: distinguish "artifacts written locally" from "submitted to the
  // repo-knowledge DB". The submission is the coordinator's downstream step;
  // say so rather than implying it already happened.
  if (r.repoKnowledge?.submitted) {
    lines.push(`  Submitted: YES — status ${r.repoKnowledge?.status} (${r.repoKnowledge?.posture})`);
  } else {
    lines.push(`  Submitted: NO — artifacts written, run \`rk audit import <path>\` to submit`);
    lines.push(`  Status (pending): ${r.repoKnowledge?.status} (${r.repoKnowledge?.posture})`);
  }
  lines.push(`  Path:   ${r.repoKnowledge?.path}`);

  return lines.join('\n');
}
