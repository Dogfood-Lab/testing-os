#!/usr/bin/env node

/**
 * cli.js — Swarm Control Plane CLI
 *
 * Commands:
 *   swarm init <repo-path>           — Create run, detect domains, save draft
 *   swarm freeze <run-id>            — Freeze domain map
 *   swarm dispatch <run-id> <phase>  — Create wave + agent prompts
 *   swarm collect <run-id> [outputs] — Validate, enforce ownership, merge, dedup
 *   swarm status <run-id>            — Control plane status
 *   swarm resume <run-id>            — Redispatch incomplete agents
 *   swarm history <wave-id>          — wave_state_events transition chain
 *   swarm redrive <wave-id> --reason "<text>" [--apply]
 *                                    — Resume an in-flight wave at the same
 *                                      wave_id (preserves completed receipts)
 *   swarm approve <run-id> [ids]     — Approve findings for amend
 *   swarm findings <run-id> [wave] [--format=text|markdown|json]
 *                                    — Findings digest for a wave (default: latest).
 *                                      Format defaults to text on TTY, markdown when piped.
 *   swarm runs                       — List all runs
 */

import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { init } from './commands/init.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { revalidate, formatRevalidate } from './commands/revalidate.js';
import { status, formatStatus } from './commands/status.js';
import { resume, formatResume } from './commands/resume.js';
import { history, formatHistory } from './commands/history.js';
import { rewind, formatRewind } from './commands/rewind.js';
import { redrive, formatRedrive } from './commands/redrive.js';
import { buildReceipt, exportReceipt, storeReceipt } from './commands/receipt.js';
import { verify as runVerify, probeRepo, formatVerify, formatProbe } from './commands/verify.js';
import { verifyFixed as runVerifyFixed } from './commands/verify-fixed.js';
import { verifyRecurring as runVerifyRecurring } from './commands/verify-recurring.js';
import { verifyUnverified as runVerifyUnverified } from './commands/verify-unverified.js';
import { verifyApproved as runVerifyApproved } from './commands/verify-approved.js';
import { advance as runAdvance, checkGates, getPromotions } from './lib/advance.js';
import { persist as runPersist, formatPersist } from './commands/persist.js';
import { openDb } from './db/connection.js';
import {
  freezeDomains, unfreezeDomains, getDomains, aredomainsFrozen,
  editDomain, addDomain, removeDomain, getDomainEvents,
} from './lib/domains.js';
import { setTimeoutPolicy, getTimeoutPolicy } from './lib/state-machine.js';
import { buildDigest } from './lib/findings-digest.js';
import { renderTopLevelError } from './lib/error-render.js';
import { CliInvalidGlobsError } from './lib/errors.js';

/**
 * D3B-004 (Wave A2 Stage C): parse + shape-validate a `--globs <JSON>`
 * argument. Throws CliInvalidGlobsError (.code = CLI_INVALID_GLOBS_JSON)
 * on:
 *   - JSON.parse failure (operator typo)
 *   - parsed value is not an array
 *   - array is empty
 *   - any element is not a string
 *
 * The caller (the `domains --add` / `domains --edit` path) gets a stable
 * code that the top-level handler renders as a structured envelope with
 * an actionable hint.
 *
 * @param {string} raw — the raw arg string after `--globs`
 * @returns {string[]} — validated globs array
 */
function parseGlobsArgOrThrow(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new CliInvalidGlobsError(
      '--globs requires a JSON array of glob strings; got empty input',
      {
        received: '',
        hint: 'pass --globs \'["packages/foo/**", "packages/bar/**"]\' (note the quoting)',
      }
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CliInvalidGlobsError(
      `--globs requires a JSON array of glob strings; could not parse input: ${e.message}`,
      {
        received: raw.length > 120 ? raw.slice(0, 117) + '...' : raw,
        cause: e.message,
        hint: 'pass --globs \'["packages/foo/**"]\' — note the surrounding single quotes so the shell doesn\'t eat the JSON, and the double quotes around each glob string',
      }
    );
  }
  if (!Array.isArray(parsed)) {
    throw new CliInvalidGlobsError(
      `--globs must be a JSON array of glob strings; got ${typeof parsed === 'object' && parsed !== null ? 'an object' : typeof parsed}`,
      {
        received: raw.length > 120 ? raw.slice(0, 117) + '...' : raw,
        hint: 'wrap in [ ] — e.g. --globs \'["packages/foo/**"]\'',
      }
    );
  }
  if (parsed.length === 0) {
    throw new CliInvalidGlobsError(
      '--globs must be a non-empty array of glob strings; got []',
      {
        received: raw,
        hint: 'at least one glob is required — e.g. --globs \'["packages/foo/**"]\'',
      }
    );
  }
  for (let i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== 'string') {
      throw new CliInvalidGlobsError(
        `--globs array element at index ${i} must be a string; got ${typeof parsed[i]}`,
        {
          received: raw.length > 120 ? raw.slice(0, 117) + '...' : raw,
          hint: 'every element must be a glob string — e.g. --globs \'["packages/foo/**", "packages/bar/**"]\'',
        }
      );
    }
  }
  return parsed;
}

// ── Resolve DB path ──
// Default: F:\AI\dogfood-labs\swarms\control-plane.db
const DEFAULT_SWARM_DIR = resolve(import.meta.dirname, '../../swarms');
const DEFAULT_DB_PATH = join(DEFAULT_SWARM_DIR, 'control-plane.db');

function getDbPath() {
  return process.env.SWARM_DB || DEFAULT_DB_PATH;
}

function getOutputDir(runId) {
  return join(DEFAULT_SWARM_DIR, runId);
}

// ── Command handlers ──

function cmdInit(args) {
  const repoPath = args[0];
  if (!repoPath) {
    console.error('Usage: swarm init <repo-path> [--repo org/name]');
    process.exit(1);
  }

  const repo = args.find((a, i) => args[i - 1] === '--repo') || undefined;

  const result = init({
    repoPath: resolve(repoPath),
    repo,
    dbPath: getDbPath(),
  });

  console.log(`\nRun created: ${result.runId}`);
  console.log(`Repo: ${result.repo}`);
  console.log(`Save point: ${result.savePointTag}`);
  console.log(`Commit: ${result.commitSha.slice(0, 8)} on ${result.branch}\n`);

  console.log('Domain draft (review before freezing):');
  for (const d of result.domains) {
    console.log(`  ${d.name} (${d.ownership_class}) — ${d.matched_files} files`);
  }
  if (result.unmatched.length > 0) {
    console.log(`\n  ${result.unmatched.length} unmatched files (will go to "shared" or remain unassigned)`);
  }
  console.log(`\nNext: review domains, then run: swarm freeze ${result.runId}`);
}

function cmdDomains(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm domains <run-id> [--freeze | --unfreeze --reason "..." | --edit <name> [opts] | --add <name> [opts] | --remove <name> | --history]');
    process.exit(1);
  }

  const db = openDb(getDbPath());

  // --freeze
  if (args.includes('--freeze')) {
    freezeDomains(db, runId);
    const domains = getDomains(db, runId);
    console.log(`Domains frozen for ${runId}:`);
    for (const d of domains) {
      console.log(`  [FROZEN] ${d.name} (${d.ownership_class})${d.description ? ' — ' + d.description : ''}`);
    }
    console.log('\nNext: swarm dispatch ' + runId + ' health-audit-a');
    return;
  }

  // --unfreeze --reason "..."
  if (args.includes('--unfreeze')) {
    const reasonIdx = args.indexOf('--reason');
    const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : null;
    if (!reason) {
      console.error('--unfreeze requires --reason "explanation"');
      process.exit(1);
    }
    unfreezeDomains(db, runId, reason);
    console.log(`Domains unfrozen for ${runId} (reason: ${reason})`);
    return;
  }

  // --edit <name> [--globs "..." --ownership owned|shared|bridge --desc "..."]
  const editIdx = args.indexOf('--edit');
  if (editIdx >= 0) {
    const domainName = args[editIdx + 1];
    if (!domainName) { console.error('--edit requires a domain name'); process.exit(1); }

    const changes = {};
    const globsIdx = args.indexOf('--globs');
    // D3B-004 (Wave A2 Stage C): structured guard around operator JSON input.
    if (globsIdx >= 0) changes.globs = parseGlobsArgOrThrow(args[globsIdx + 1]);
    const ownerIdx = args.indexOf('--ownership');
    if (ownerIdx >= 0) changes.ownership_class = args[ownerIdx + 1];
    const descIdx = args.indexOf('--desc');
    if (descIdx >= 0) changes.description = args[descIdx + 1];

    editDomain(db, runId, domainName, changes);
    console.log(`Domain "${domainName}" updated.`);
    return;
  }

  // --add <name> --globs "[...]" [--ownership owned|shared|bridge]
  const addIdx = args.indexOf('--add');
  if (addIdx >= 0) {
    const domainName = args[addIdx + 1];
    const globsIdx = args.indexOf('--globs');
    if (!domainName || globsIdx < 0) {
      console.error('--add requires: <name> --globs "[...]"');
      process.exit(1);
    }
    // D3B-004 (Wave A2 Stage C): structured guard around operator JSON input.
    const globs = parseGlobsArgOrThrow(args[globsIdx + 1]);
    const ownerIdx = args.indexOf('--ownership');
    const ownership = ownerIdx >= 0 ? args[ownerIdx + 1] : 'owned';
    addDomain(db, runId, { name: domainName, globs, ownership_class: ownership });
    console.log(`Domain "${domainName}" added.`);
    return;
  }

  // --remove <name>
  const removeIdx = args.indexOf('--remove');
  if (removeIdx >= 0) {
    const domainName = args[removeIdx + 1];
    if (!domainName) { console.error('--remove requires a domain name'); process.exit(1); }
    removeDomain(db, runId, domainName);
    console.log(`Domain "${domainName}" removed.`);
    return;
  }

  // --history
  if (args.includes('--history')) {
    const events = getDomainEvents(db, runId);
    if (events.length === 0) {
      console.log('No domain events.');
      return;
    }
    console.log('Domain events:');
    for (const e of events) {
      console.log(`  ${e.created_at} | ${e.domain_name} | ${e.event_type}${e.reason ? ' — ' + e.reason : ''}`);
    }
    return;
  }

  // Default: show current domain map
  const domains = getDomains(db, runId);
  const frozen = aredomainsFrozen(db, runId);

  console.log(`Domains for ${runId} [${frozen ? 'FROZEN' : 'DRAFT'}]:\n`);
  for (const d of domains) {
    const icon = d.frozen ? 'FROZEN' : 'DRAFT';
    console.log(`  [${icon.padEnd(6)}] ${d.name} (${d.ownership_class})${d.description ? ' — ' + d.description : ''}`);
    if (d.globs.length <= 5) {
      for (const g of d.globs) console.log(`           ${g}`);
    } else {
      for (const g of d.globs.slice(0, 3)) console.log(`           ${g}`);
      console.log(`           ... and ${d.globs.length - 3} more`);
    }
  }

  if (!frozen) {
    console.log(`\nNext: review, then run: swarm domains ${runId} --freeze`);
  }
}

function cmdDispatch(args) {
  const runId = args[0];
  const phase = args[1];
  if (!runId || !phase) {
    console.error('Usage: swarm dispatch <run-id> <phase>');
    console.error('Phases: health-audit-a, health-audit-b, health-audit-c, health-amend-a, health-amend-b, health-amend-c, stage-d-audit, stage-d-amend, feature-audit, feature-execute');
    process.exit(1);
  }

  const autoFreeze = args.includes('--auto-freeze');
  const isolate = args.includes('--isolate');
  // Item 5: parallel-wave verification discipline. When set, agent prompts
  // include the directive to skip per-agent `npm test`/`npm run verify` and
  // emit `verification_skipped: true` in their output JSON. Coordinator runs
  // ONE serial verify after `swarm collect` against the cumulative tree.
  const skipVerify = args.includes('--skip-verify');

  const result = dispatch({
    runId,
    phase,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    autoFreeze,
    isolate,
    skipVerify,
  });

  console.log(`\nWave ${result.waveNumber} dispatched (${result.phase})`);
  console.log(`Prompts written to: ${result.promptDir}\n`);
  for (const a of result.agents) {
    const wt = a.worktreePath ? ` [worktree: ${a.worktreePath}]` : '';
    console.log(`  ${a.domain} → ${a.promptPath}${wt}`);
  }
  console.log(`\nDispatch ${result.agents.length} agents with these prompts.`);
  console.log(`When done, run: swarm collect ${runId}`);
}

function cmdCollect(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm collect <run-id> --domain=name:path [--domain=name:path ...]');
    process.exit(1);
  }

  // Parse --domain=name:path pairs
  const outputs = {};
  for (const arg of args.slice(1)) {
    const match = arg.match(/^--domain=([^:]+):(.+)$/);
    if (match) {
      outputs[match[1]] = resolve(match[2]);
    }
  }

  if (Object.keys(outputs).length === 0) {
    console.error('No outputs provided. Use --domain=name:path for each agent output.');
    console.error('Example: swarm collect <run-id> --domain=backend:outputs/backend.json --domain=tests:outputs/tests.json');
    process.exit(1);
  }

  const result = collect({
    runId,
    dbPath: getDbPath(),
    outputs,
  });

  console.log(result.summary);
  console.log('');

  if (result.violations.length > 0) {
    console.log('OWNERSHIP VIOLATIONS:');
    for (const v of result.violations) {
      console.log(`  ${v.file} — agent "${v.agent_domain}" touched file owned by "${v.actual_owner}"`);
    }
    console.log('');
  }

  if (result.validation_errors.length > 0) {
    console.log('VALIDATION ERRORS:');
    for (const e of result.validation_errors) {
      console.log(`  ${e.domain}: ${e.errors ? e.errors.join('; ') : e.error}`);
    }
    console.log('');
  }

  // Item 5 (Phase 2-B verification-discipline): when any amend agent dispatched
  // with --skip-verify carried `verification_skipped: true`, the per-agent
  // verify pass was deliberately deferred so parallel agents do not observe
  // cumulative-tree measurement artifacts. The coordinator now runs ONE
  // serial verify against the post-merge tree before promoting.
  //
  // D-STRUCT-003: replace the prior bare `SERIAL VERIFY REQUIRED:` header
  // (which competed with the trailing `Next: swarm status` line for the
  // operator's scan-anchor) with a heavy `[!]`-sigiled banner that matches
  // the FAILED-class assessment frame used in `swarm status`. When the
  // serial-verify gate is live, the canonical `Next:` token is REPLACED
  // with an `Action required:` line that names the actual obligation
  // (`npm run verify` against the cumulative tree). The `Next:` token must
  // carry the GATING step or carry NONE.
  if (result.serial_verify_required) {
    console.log('===== [!] SERIAL VERIFY REQUIRED [!] =====');
    console.log('  One or more agents skipped per-agent verification per the parallel-wave');
    console.log('  discipline. Run a single `npm run verify` against the cumulative tree');
    console.log('  before advancing the wave. See swarms/PROTOCOL.md §Serial final verification.');
    console.log('');
    console.log(`Action required: npm run verify  (then: swarm status ${runId})`);
  } else {
    console.log(`Next: swarm status ${runId}`);
  }
}

function cmdRevalidate(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm revalidate <run-id> --reason "<text>" --domain=name:path [--domain=name:path ...] [--apply]');
    process.exit(1);
  }

  const outputs = {};
  for (const arg of args.slice(1)) {
    const m = arg.match(/^--domain=([^:]+):(.+)$/);
    if (m) outputs[m[1]] = resolve(m[2]);
  }

  let reason = '';
  const reasonIdx = args.indexOf('--reason');
  // cli-003: a following token that starts with `--` is the NEXT flag, not the
  // reason text. Without this guard, `--reason --apply` silently captured
  // '--apply' as the reason (polluting the mandatory audit field) while the
  // irreversible mutation still fired. Treat that as a missing reason so the
  // "reason required" guard below errors out instead.
  if (reasonIdx >= 0 && args[reasonIdx + 1] && !args[reasonIdx + 1].startsWith('--')) {
    reason = args[reasonIdx + 1];
  }
  for (const a of args) {
    const m = a.match(/^--reason=(.+)$/s);
    if (m) reason = m[1];
  }

  const apply = args.includes('--apply');

  if (!reason || !reason.trim()) {
    console.error('revalidate: --reason "<text>" is required (non-empty)');
    process.exit(1);
  }

  if (Object.keys(outputs).length === 0) {
    console.error('revalidate: at least one --domain=name:path is required');
    process.exit(1);
  }

  const result = revalidate({
    runId,
    dbPath: getDbPath(),
    outputs,
    reason,
    apply,
  });

  process.stdout.write(formatRevalidate(result));

  if (apply) {
    console.log(`\nNext: swarm status ${runId}`);
  } else {
    console.log('\nDry-run only — re-run with --apply to mutate the control plane.');
  }
}

function cmdStatus(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm status <run-id>');
    process.exit(1);
  }

  const s = status({ runId, dbPath: getDbPath() });
  console.log(formatStatus(s));
}

function cmdResume(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm resume <run-id>');
    process.exit(1);
  }

  const r = resume({
    runId,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
  });
  console.log(formatResume(r));
}

function cmdRewind(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: swarm rewind <save-point-tag> --reason "<text>" [--apply] [--force] [--force-arbitrary-ref]');
    console.log('');
    console.log('Restore the working tree to a named save-point AND lawfully abort orphaned');
    console.log('in-flight waves/agent_runs (status -> aborted_for_rewind) with full audit');
    console.log('visibility in wave_state_events / agent_state_events (reason prefixed with');
    console.log('"rewind: "). Dry-run by default; --apply mutates.');
    console.log('');
    console.log('Required:');
    console.log('  <save-point-tag>          A git tag (default: must match swarm-save-*)');
    console.log('  --reason "<text>"         Non-empty audit reason (recorded in state events)');
    console.log('');
    console.log('Optional:');
    console.log('  --apply                   Mutate (default: dry-run preview)');
    console.log('  --force                   Discard uncommitted changes in the working tree');
    console.log('  --force-arbitrary-ref     Allow tags outside the swarm-save-* glob');
    return;
  }

  const savePointTag = args[0];
  if (!savePointTag || savePointTag.startsWith('--')) {
    console.error('Usage: swarm rewind <save-point-tag> --reason "<text>" [--apply] [--force] [--force-arbitrary-ref]');
    process.exit(1);
  }

  let reason = '';
  const reasonIdx = args.indexOf('--reason');
  // cli-003: a following token starting with `--` is the next flag, not the
  // reason. `--reason --apply` must NOT capture '--apply' as the audit reason
  // (and rewind is irreversible — the polluted reason would land in the
  // wave/agent_state_events record). Treat it as missing so the guard fires.
  if (reasonIdx >= 0 && args[reasonIdx + 1] && !args[reasonIdx + 1].startsWith('--')) {
    reason = args[reasonIdx + 1];
  }
  for (const a of args) {
    const m = a.match(/^--reason=(.+)$/s);
    if (m) reason = m[1];
  }

  if (!reason || !reason.trim()) {
    console.error('rewind: --reason "<text>" is required (non-empty)');
    process.exit(1);
  }

  const apply = args.includes('--apply');
  const force = args.includes('--force');
  const forceArbitraryRef = args.includes('--force-arbitrary-ref');

  // The CLI wrapper is the ONLY place we resolve real paths. The rewind()
  // function never defaults to process.cwd() / DEFAULT_DB_PATH so tests can
  // safely point at fixture trees + fixture DBs. The wrapper here resolves
  // the operator's invocation context.
  const result = rewind({
    savePointTag,
    reason,
    cwd: process.cwd(),
    dbPath: getDbPath(),
    apply,
    force,
    forceArbitraryRef,
  });

  process.stdout.write(formatRewind(result));

  if (apply) {
    console.log('\nRewind applied. Inspect with `swarm status <run-id>` / `swarm history <wave-id>`.');
  } else {
    console.log('\nDry-run only — re-run with --apply to rewind the working tree + abort orphaned rows.');
  }
}

function cmdRedrive(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: swarm redrive <wave-id> --reason "<text>" [--apply]');
    console.log('');
    console.log('Lawful Redrive: Step Functions Redrive semantics on the swarm control plane.');
    console.log('Same wave_id, completed work preserved byte-identical, only eligible failed/');
    console.log('unstarted agent_runs made re-dispatchable. Dry-run by default; --apply mutates.');
    console.log('');
    console.log('Required:');
    console.log('  <wave-id>                 Positive integer (waves.id)');
    console.log('  --reason "<text>"         Non-empty audit reason (recorded with redrive: prefix)');
    console.log('');
    console.log('Optional:');
    console.log('  --apply                   Mutate (default: dry-run preview)');
    console.log('');
    console.log('Eligibility (per agent_run source status):');
    console.log('  complete             -> PRESERVED (receipt unchanged)');
    console.log('  pending, dispatched  -> ELIGIBLE (redriven to dispatched)');
    console.log('  failed, timed_out    -> ELIGIBLE (redriven to dispatched)');
    console.log('  invalid_output       -> REFUSED  (use `swarm revalidate` instead)');
    console.log('  ownership_violation  -> REFUSED  (operator unblocks first)');
    console.log('  aborted_for_rewind   -> REFUSED  (terminal; run a fresh wave)');
    console.log('  running              -> REFUSED  (let timeout fire, then redrive)');
    return;
  }

  const waveIdArg = args[0];
  if (!waveIdArg || waveIdArg.startsWith('--')) {
    console.error('Usage: swarm redrive <wave-id> --reason "<text>" [--apply]');
    process.exit(1);
  }

  let reason = '';
  const reasonIdx = args.indexOf('--reason');
  // cli-003: a following token starting with `--` is the next flag, not the
  // reason. `--reason --apply` must NOT capture '--apply' as the redrive audit
  // reason. Treat it as missing so the "reason required" guard fires.
  if (reasonIdx >= 0 && args[reasonIdx + 1] && !args[reasonIdx + 1].startsWith('--')) {
    reason = args[reasonIdx + 1];
  }
  for (const a of args) {
    const m = a.match(/^--reason=(.+)$/s);
    if (m) reason = m[1];
  }

  if (!reason || !reason.trim()) {
    console.error('redrive: --reason "<text>" is required (non-empty)');
    process.exit(1);
  }

  const apply = args.includes('--apply');

  let result;
  try {
    result = redrive({
      waveId: waveIdArg,
      reason,
      dbPath: getDbPath(),
      apply,
    });
  } catch (e) {
    if (e.code === 'WAVE_NOT_FOUND' || e.code === 'WAVE_TERMINAL' || /wave-id.*positive integer/.test(e.message)) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  process.stdout.write(formatRedrive(result));

  if (apply) {
    console.log('\nRedrive applied. Inspect with `swarm status <run-id>` / `swarm history <wave-id>`.');
  } else {
    console.log('\nDry-run only — re-run with --apply to mutate the control plane.');
  }
}

function cmdHistory(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: swarm history <wave-id>');
    console.log('');
    console.log('Render the full wave_state_events transition chain for <wave-id>.');
    console.log('Each row shows: from_status -> to_status, when, and the operator-');
    console.log('supplied reason text (override transitions via `swarm revalidate`');
    console.log('carry their --reason text here prefixed with `revalidate:`).');
    return;
  }

  const waveIdArg = args[0];
  if (!waveIdArg) {
    console.error('Usage: swarm history <wave-id>');
    process.exit(1);
  }

  try {
    const report = history({ waveId: waveIdArg, dbPath: getDbPath() });
    console.log(formatHistory(report));
  } catch (e) {
    if (e.code === 'WAVE_NOT_FOUND' || /wave id must be/.test(e.message)) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

function cmdVerify(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm verify <run-id> [--adapter node|python|rust] [--probe-only]');
    process.exit(1);
  }

  // --probe-only: just show probe results
  if (args.includes('--probe-only')) {
    const probes = probeRepo({ runId, dbPath: getDbPath() });
    console.log(formatProbe(probes));
    return;
  }

  const adapterIdx = args.indexOf('--adapter');
  const override = adapterIdx >= 0 ? args[adapterIdx + 1] : undefined;

  const result = runVerify({
    runId,
    dbPath: getDbPath(),
    override,
  });

  console.log(formatVerify(result));

  // cli-p-002: `swarm verify` is billed as a wave gate, yet it used to exit
  // 0 on every verdict — a CI step (or a `swarm verify <run> && swarm
  // advance <run>` chain) saw a green light on a hard FAIL. Exit 0 ONLY on a
  // clean pass; every other verdict (fail / no_tests / skip / tool_missing)
  // is "not a verified pass" and MUST surface as a non-zero exit so the
  // machine signal matches the human-readable one. This aligns `verify` with
  // its four verify-* sibling verbs, which already propagate exit codes.
  if (result.verdict !== 'pass') {
    // A `fail` verdict has no top-level `reason` (the runner only attaches
    // one for skip/no_tests), so derive a why-line from the first failing
    // required step. The operator always gets an explanation alongside the
    // non-zero exit, never a bare verdict.
    const failedStep = result.steps?.find(s => !s.passed && !s.optional);
    const why = result.reason
      || (failedStep
        ? `required step '${failedStep.name}' failed (exit ${failedStep.exit_code})`
        : 'not a verified pass');
    console.error(`swarm verify: ${result.verdict.toUpperCase()} — ${why}`);
    process.exit(1);
  }
}

/**
 * ve-002 guard: build a fail-loud error for a non-numeric / negative
 * `--threshold` value. A plain Error carrying `.code` + `.hint` so the
 * top-level `renderTopLevelError` seam prints the structured envelope and
 * exits 1 — mirroring CliInvalidGlobsError's shape without coupling the
 * shared verify-flag parser to a new error class. Exported-via-throw so the
 * unit test can assert the parser rejects rather than yielding NaN.
 *
 * @param {string} raw — the value the operator passed after --threshold
 */
function thresholdError(raw) {
  const e = new Error(
    `--threshold expects a non-negative integer; got '${raw}'`
  );
  e.code = 'CLI_INVALID_THRESHOLD';
  e.received = raw;
  e.hint = 'pass an integer >= 0, e.g. `--threshold 0` or `--threshold=3`';
  return e;
}

/**
 * Parse the shared verify-* CLI flags: --threshold=N, --format=text|markdown|json,
 * --legacy-v1. Returned values are plain JS so each verb's wrapper can
 * spread directly into its impl call.
 *
 * ve-002: the space form `--threshold <value>` is validated with
 * Number.isFinite (and a non-negative check) so a typo like `--threshold foo`
 * fails loud instead of yielding NaN. A NaN threshold silently disabled the
 * gate: `offending > NaN` is always false, so the command exited 0 ("clean")
 * even with real regressions, on all four verify-* verbs. The `--threshold=N`
 * equals-form was already digit-guarded by its `^--threshold=(\d+)$` regex;
 * this closes the space-form hole and keeps both forms consistent.
 *
 * @throws when the space-form value is not a finite non-negative integer.
 */
export function parseVerifyFlags(args) {
  let threshold = 0;
  for (const a of args.slice(1)) {
    const m = a.match(/^--threshold=(\d+)$/);
    if (m) { threshold = parseInt(m[1], 10); break; }
  }
  const tIdx = args.indexOf('--threshold');
  if (tIdx >= 0 && args[tIdx + 1] !== undefined) {
    const raw = args[tIdx + 1];
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0 || !/^\d+$/.test(String(raw).trim())) {
      throw thresholdError(raw);
    }
    threshold = n;
  }

  let format;
  for (const a of args.slice(1)) {
    const m = a.match(/^--format=(text|markdown|json)$/);
    if (m) { format = m[1]; break; }
  }
  const fIdx = args.indexOf('--format');
  if (fIdx >= 0 && args[fIdx + 1]) {
    format = args[fIdx + 1];
  }

  const legacyV1 = args.includes('--legacy-v1');

  return { threshold, format, legacyV1 };
}

function cmdVerifyFixed(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm verify-fixed <run-id> [--threshold=N] [--format=text|markdown|json] [--legacy-v1]');
    process.exit(1);
  }

  const { threshold, format, legacyV1 } = parseVerifyFlags(args);

  const result = runVerifyFixed({
    runId,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    threshold,
    format,
    legacyV1,
  });

  console.log(result.output);
  console.log('');
  console.log(`Delta written to: ${result.deltaPath}`);

  // Exit with the 3-way state: 0 clean / 1 threshold exceeded /
  // 2 pipeline broken. The CLI seam preserves this signal so CI gates
  // can use `swarm verify-fixed` as a check.
  process.exit(result.exitCode);
}

function cmdVerifyRecurring(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm verify-recurring <run-id> [--threshold=N] [--format=text|markdown|json]');
    process.exit(1);
  }
  const { threshold, format } = parseVerifyFlags(args);
  const result = runVerifyRecurring({
    runId,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    threshold,
    format,
  });
  console.log(result.output);
  console.log('');
  console.log(`Delta written to: ${result.deltaPath}`);
  process.exit(result.exitCode);
}

function cmdVerifyUnverified(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm verify-unverified <run-id> [--threshold=N] [--format=text|markdown|json]');
    process.exit(1);
  }
  const { threshold, format } = parseVerifyFlags(args);
  const result = runVerifyUnverified({
    runId,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    threshold,
    format,
  });
  console.log(result.output);
  console.log('');
  console.log(`Delta written to: ${result.deltaPath}`);
  process.exit(result.exitCode);
}

function cmdVerifyApproved(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm verify-approved <run-id> [--threshold=N] [--format=text|markdown|json]');
    process.exit(1);
  }
  const { threshold, format } = parseVerifyFlags(args);
  const result = runVerifyApproved({
    runId,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    threshold,
    format,
  });
  console.log(result.output);
  console.log('');
  console.log(`Delta written to: ${result.deltaPath}`);
  // Exit code 2 on broken anchor blocks subsequent amend dispatch — the
  // CLI seam carries the signal so a CI step can gate dispatch on it.
  process.exit(result.exitCode);
}

function cmdReceipt(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm receipt <run-id> [wave-number]');
    process.exit(1);
  }

  const waveNumber = args[1] ? parseInt(args[1], 10) : undefined;

  const receipt = buildReceipt({
    runId,
    waveNumber,
    dbPath: getDbPath(),
  });

  const outputDir = getOutputDir(runId);
  const { jsonPath, mdPath } = exportReceipt(receipt, outputDir);

  // Store in control plane
  const db = openDb(getDbPath());
  storeReceipt(db, receipt.wave.id, jsonPath, mdPath);

  console.log(`Receipt exported for wave ${receipt.wave.number} (${receipt.wave.phase}):`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log('');
  console.log(`Recommendation: ${receipt.recommendation.action}${receipt.recommendation.reason ? ' — ' + receipt.recommendation.reason : ''}`);
}

function cmdAdvance(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm advance <run-id> [--override --reason "..."] [--check-only]');
    process.exit(1);
  }

  const db = openDb(getDbPath());

  // --check-only: just show gate results
  if (args.includes('--check-only')) {
    const result = checkGates(db, runId);
    console.log(`Verdict: ${result.verdict}`);
    if (result.nextPhase) console.log(`Next phase: ${result.nextPhase}`);
    if (result.reason) console.log(`Reason: ${result.reason}`);
    console.log('');
    console.log('Gates:');
    for (const g of result.gates) {
      console.log(`  [${g.passed ? 'PASS' : 'FAIL'}] ${g.name} — ${g.reason}`);
    }
    if (result.overridable) console.log('\nThis block is overridable with --override --reason "..."');
    return;
  }

  // --history: show promotion history
  if (args.includes('--history')) {
    const promotions = getPromotions(db, runId);
    if (promotions.length === 0) {
      console.log('No promotions yet.');
      return;
    }
    console.log('Promotion history:');
    for (const p of promotions) {
      const gates = p.gates_checked.filter(g => g.passed).length;
      const total = p.gates_checked.length;
      const override = p.overrides ? ` [OVERRIDE: ${p.overrides.map(o => o.reason).join('; ')}]` : '';
      console.log(`  ${p.created_at} | ${p.from_phase} → ${p.to_phase} | ${gates}/${total} gates | ${p.authorized_by}${override}`);
    }
    return;
  }

  const override = args.includes('--override');
  const reasonIdx = args.indexOf('--reason');
  // cli-003: a following token that starts with `--` is the NEXT flag, not the
  // reason text. `--override --reason <flag>` captured the flag as overrideReason
  // (truthy), so the override proceeded with a junk audit reason — advance.js
  // persists it into the promotion/override record as overrides:[{reason}]. No
  // irreversible side effect here (why the amend agent declined to file it), but
  // a polluted audit reason is still wrong. Treat a `--`-prefixed value as missing.
  const reasonCandidate = reasonIdx >= 0 ? args[reasonIdx + 1] : undefined;
  const overrideReason = (reasonCandidate && !reasonCandidate.startsWith('--')) ? reasonCandidate : undefined;

  if (override && !overrideReason) {
    console.error('--override requires --reason "explanation"');
    process.exit(1);
  }

  const result = runAdvance(db, runId, {
    override,
    overrideReason,
    authorizedBy: 'coordinator',
  });

  if (result.promoted) {
    console.log(`PROMOTED: ${result.fromPhase} → ${result.toPhase}`);
    console.log(`Verdict: ${result.verdict}`);
    console.log(`Promotion ID: ${result.promotionId}`);
    console.log('');
    console.log(`Next: swarm dispatch ${runId} ${result.toPhase}`);
  } else {
    console.log(`BLOCKED: ${result.verdict}`);
    if (result.reason) console.log(`Reason: ${result.reason}`);
    console.log('');
    console.log('Gates:');
    for (const g of (result.gates || [])) {
      console.log(`  [${g.passed ? 'PASS' : 'FAIL'}] ${g.name} — ${g.reason}`);
    }
    if (result.verdict === 'AMEND') {
      console.log(`\nNext: swarm approve ${args[0]} --all && swarm dispatch ${args[0]} ${result.nextPhase}`);
    }
  }
}

function cmdApprove(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm approve <run-id> [--all | --ids F-001,F-002]');
    process.exit(1);
  }

  const db = openDb(getDbPath());
  const approveAll = args.includes('--all');
  const idsArg = args.find((a, i) => args[i - 1] === '--ids');
  const ids = idsArg ? idsArg.split(',').map(s => s.trim()) : [];

  if (!approveAll && ids.length === 0) {
    console.error('Specify --all or --ids F-001,F-002');
    process.exit(1);
  }

  // cli-002 fix: record `approved` events only for findings THIS call moves
  // new/recurring → approved, not for every already-approved finding in the
  // run. finding_events is append-only with no unique constraint, so the old
  // `SELECT ... WHERE status = 'approved'` (which returned rows approved by
  // earlier invocations too) inserted a duplicate `approved` event on every
  // re-run of `swarm approve`, over-counting the event-sourced audit trail.
  //
  // Capture the about-to-flip ids BEFORE the UPDATE, then insert one event
  // per captured id — all inside one transaction so the UPDATE and its audit
  // rows land together (Stripe Ledger pattern, mirrors transitionWave).
  const selectPending = approveAll
    ? db.prepare(
        "SELECT id FROM findings WHERE run_id = ? AND status IN ('new', 'recurring')"
      )
    : db.prepare(
        `SELECT id FROM findings WHERE run_id = ? AND finding_id IN (${ids.map(() => '?').join(',')}) AND status IN ('new', 'recurring')`
      );

  const insertEvent = db.prepare(
    "INSERT INTO finding_events (finding_id, event_type, notes) VALUES (?, 'approved', 'bulk approve')"
  );

  let changes = 0;
  const tx = db.transaction(() => {
    const pending = approveAll
      ? selectPending.all(runId)
      : selectPending.all(runId, ...ids);

    let updated;
    if (approveAll) {
      updated = db.prepare(
        "UPDATE findings SET status = 'approved' WHERE run_id = ? AND status IN ('new', 'recurring')"
      ).run(runId);
    } else {
      const placeholders = ids.map(() => '?').join(',');
      updated = db.prepare(
        `UPDATE findings SET status = 'approved' WHERE run_id = ? AND finding_id IN (${placeholders}) AND status IN ('new', 'recurring')`
      ).run(runId, ...ids);
    }

    for (const f of pending) insertEvent.run(f.id);
    return updated.changes;
  });

  changes = tx();
  console.log(`Approved ${changes} findings for ${runId}`);
}

function cmdPersist(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm persist <run-id> [--ingest] [--dry-run]');
    process.exit(1);
  }

  const ingestDogfood = args.includes('--ingest');
  const dryRun = args.includes('--dry-run');

  const result = runPersist({
    runId,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    ingestDogfood,
    dryRun,
  });

  console.log(formatPersist(result));

  // cli-p-001 / fp-p-002: when --ingest was requested (and not a dry run), the
  // ingest is an irreversible write to the dogfood corpus. persist() catches a
  // failed ingest into report.dogfood.reason and returns a success-shaped
  // report, so cmdPersist used to exit 0 even when nothing was ingested — a CI
  // step gating on $? saw a failed corpus write as green. The sibling
  // persist-results.js exits 1 on the identical failure; align the two corpus-
  // write surfaces on one exit-code contract. Surface the reason + a copy-
  // pasteable reproduce line (mirroring persist-results.js) so the operator
  // can replay the ingest with full output.
  if (ingestDogfood && !dryRun && result.dogfood && result.dogfood.ingested !== true) {
    console.error(`ERROR [INGEST_FAILED]: dogfood ingest did not complete — ${result.dogfood.reason}`);
    if (result.artifacts?.dogfoodSubmission) {
      console.error(`  Submission: ${result.artifacts.dogfoodSubmission}`);
      console.error(`  Reproduce:  node "<repo>/packages/ingest/run.js" --provenance=stub --file "${result.artifacts.dogfoodSubmission}"`);
    }
    process.exit(1);
  }
}

function cmdFindings(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm findings <run-id> [wave-number] [--format=text|markdown|json]');
    process.exit(1);
  }
  // First positional after run-id is the wave number ONLY when it's numeric.
  // Anything else (e.g. a stray `--format=...` if the operator forgets the
  // wave) is parsed below as a flag rather than misread as a wave id.
  const waveArg = args[1] && /^\d+$/.test(args[1]) ? args[1] : undefined;

  // F-827321-002 (wave-23) — TTY-aware multi-format renderer.
  //   --format=text|markdown|json overrides the auto-detect.
  //   DOGFOOD_FINDINGS_FORMAT env var overrides both (raw|human|json,
  //   symmetric to wave-17's DOGFOOD_LOG_HUMAN).
  // Default: text on TTY, markdown when piped/redirected (back-compat for
  // `swarm findings <run> > digest.md` and CI scrapers).
  let format;
  for (const a of args.slice(1)) {
    const m = a.match(/^--format=(text|markdown|json)$/);
    if (m) { format = m[1]; break; }
  }
  const formatIdx = args.indexOf('--format');
  if (formatIdx >= 0 && args[formatIdx + 1]) {
    format = args[formatIdx + 1];
  }

  const { output, exitCode } = buildDigest({
    runId,
    waveNumber: waveArg ? parseInt(waveArg, 10) : undefined,
    format,
    stream: process.stdout,
  });
  console.log(output);
  // F-091578-034 — exit codes propagate the 3-way digest state so CI gates
  // can distinguish clean (0), findings-present (1), and audit-pipeline-broken
  // (2). Operator using `swarm findings` as a CI gate needs the machine
  // signal AND the visual signal, not just the visual.
  process.exit(exitCode);
}

function cmdRuns() {
  const db = openDb(getDbPath());
  const runs = db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all();

  if (runs.length === 0) {
    console.log('No runs found.');
    return;
  }

  console.log('Swarm runs:\n');
  for (const r of runs) {
    const waveCnt = db.prepare('SELECT COUNT(*) as cnt FROM waves WHERE run_id = ?').get(r.id);
    const findCnt = db.prepare('SELECT COUNT(*) as cnt FROM findings WHERE run_id = ?').get(r.id);
    console.log(`  ${r.id}`);
    console.log(`    ${r.repo} [${r.status}] — ${waveCnt.cnt} waves, ${findCnt.cnt} findings`);
    console.log(`    Created: ${r.created_at}`);
    console.log('');
  }
}

// ── Dispatch ──

const commands = {
  init: cmdInit,
  domains: cmdDomains,
  dispatch: cmdDispatch,
  collect: cmdCollect,
  revalidate: cmdRevalidate,
  rewind: cmdRewind,
  redrive: cmdRedrive,
  verify: cmdVerify,
  'verify-fixed': cmdVerifyFixed,
  'verify-recurring': cmdVerifyRecurring,
  'verify-unverified': cmdVerifyUnverified,
  'verify-approved': cmdVerifyApproved,
  receipt: cmdReceipt,
  advance: cmdAdvance,
  status: cmdStatus,
  resume: cmdResume,
  history: cmdHistory,
  approve: cmdApprove,
  persist: cmdPersist,
  findings: cmdFindings,
  runs: cmdRuns,
};

/**
 * Direct-execution guard. cli.js historically ran its argv dispatch at module
 * load unconditionally, which means importing anything from this file (e.g.
 * parseVerifyFlags for a unit test) would execute the dispatch under the test
 * runner's argv and `process.exit`. The guard makes the file importable: the
 * dispatch only runs when cli.js is the process entry point (node cli.js ...,
 * or the `swarm` bin), not when it is imported. The subprocess smoke tests
 * (cli-smoke.test.js, rewind.test.js) still exercise the real dispatch because
 * they spawn `node cli.js` where argv[1] resolves to this file.
 */
function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return entry === fileURLToPath(import.meta.url);
  }
}

/**
 * cli-r-002: the argv dispatch body lives in main() rather than inline under
 * `if (isDirectExecution())`. The previous inline form left the help-text
 * console.log + trailing process.exit indented one level shallower than their
 * enclosing `if (!command || !commands[command])` body. Hoisting the body into
 * a named function lets every statement sit at one consistent indentation
 * level without a deep-nesting re-indent, and reads as a normal entry point.
 * Behavior is identical: main() is invoked only when cli.js is the process
 * entry point (the subprocess smoke tests still spawn `node cli.js`).
 */
function main() {
  const command = process.argv[2];
  const commandArgs = process.argv.slice(3);

  if (!command || !commands[command]) {
    console.log(`swarm — Truthful swarm control plane for repo work

Commands:
  init <repo-path>           Create run, detect domains
  domains <run-id> [opts]    Show, edit, freeze, unfreeze domain map
  dispatch <run-id> <phase>  Create wave + agent prompts
                             Flags: --auto-freeze, --isolate, --skip-verify
                             --skip-verify (amend phases): append the parallel-
                             wave directive to amend prompts so agents skip
                             per-agent npm test. Coordinator runs one serial
                             verify after 'swarm collect' instead. Eliminates
                             cumulative-tree measurement artifacts when N
                             agents run verify concurrently. PROTOCOL.md
                             §Serial final verification.
  collect <run-id> [opts]    Validate, enforce ownership, merge
  revalidate <run-id> [opts] Lawful recovery for blocked agent_runs
                             (invalid_output / ownership_violation).
                             Usage: swarm revalidate <run-id> [flags]
                               --reason "<text>"   Required: non-empty audit reason
                               --domain=name:path  Required: repeatable, one per agent
                               --apply             Required to mutate (default: dry-run)
                             Wraps the override path that exists in state-
                             machine.js but had no operator surface. Re-runs
                             the same validators as 'collect'; on pass,
                             transitions agent to 'complete' with override and
                             reason recorded in agent_state_events. If every
                             agent_run in the wave is then 'complete' and the
                             wave was 'failed', flips wave to 'collected' in
                             the same transaction.
  rewind <save-point-tag> --reason "<text>" [opts]
                             Lawful rewind: git reset --hard <tag> PLUS lawful
                             abort of orphaned in-flight waves + agent_runs via
                             transitionAgent/transitionWave (override path) with
                             rewind: prefix on every audit row. Dry-run by
                             default.
                               --reason "<text>"       Required: non-empty audit reason
                               --apply                 Required to mutate (default: dry-run)
                               --force                 Allow rewind despite uncommitted changes
                               --force-arbitrary-ref   Allow tags outside swarm-save-* glob
                             Audit visibility: wave_state_events and
                             agent_state_events both gain a row per affected
                             row (status -> aborted_for_rewind, reason prefix
                             rewind:). Terminal rows (advanced waves, complete
                             agents) are preserved unchanged.
  redrive <wave-id> --reason "<text>" [--apply]
                             Lawful Redrive: Step Functions Redrive semantics on
                             the swarm control plane. Same wave_id, completed
                             receipts preserved byte-identical, only eligible
                             failed/unstarted agent_runs made re-dispatchable
                             (status -> dispatched). Refused for invalid_output
                             (use revalidate), ownership_violation (operator
                             unblocks), aborted_for_rewind (run a fresh wave),
                             running (let timeout fire). Dry-run by default;
                             --apply mutates. Audit row in wave_state_events +
                             agent_state_events with redrive: reason prefix.
  verify <run-id> [opts]     Run build verification (auto-detect or --adapter)
  verify-fixed <run-id> [opts]
                             Re-audit findings marked [fixed]; classify into
                             verified / regressed / claimed-but-still-present
                             / unverifiable. Writes delta JSON to swarms/
                             <run>/verify-fixed-<wave>.json. Schema v2 by
                             default (verified_via vantage-point disclosure);
                             use --legacy-v1 for backward-compat consumers.
                             Format auto-detects (text on TTY, markdown when
                             piped). --threshold=N fails non-zero when
                             regressed + claimed-but-still-present > N
                             (default 0).
  verify-recurring <run-id> [opts]
                             Audit findings with multiple [fixed] events
                             (regression-and-reclaim pattern). Writes delta
                             JSON to swarms/<run>/verify-recurring-<wave>.json.
                             Output schema verify-recurring-delta/v1.
  verify-unverified <run-id> [opts]
                             Re-classify findings deferred as 'unverified'
                             against the current code state. Writes delta
                             JSON to swarms/<run>/verify-unverified-<wave>.json.
                             Output schema verify-unverified-delta/v1.
  verify-approved <run-id> [opts]
                             Pre-amend gate: confirm approved findings still
                             have valid anchors. Exit 2 (broken anchor) blocks
                             subsequent amend dispatch. Writes delta JSON to
                             swarms/<run>/verify-approved-<wave>.json.
                             Output schema verify-approved-delta/v1.
  receipt <run-id> [wave]    Export durable wave receipt (JSON + markdown)
  advance <run-id> [opts]    Check gates and advance to next phase
  persist <run-id> [opts]    Export canonical truth to downstream systems
  status <run-id>            Control plane status
  resume <run-id>            Redispatch incomplete agents
  history <wave-id>          Render the wave_state_events transition chain for
                             a wave. Deep audit verb for the override-and-reason
                             record written by \`swarm revalidate --apply\` (and
                             any future override-bearing transition). \`swarm
                             status\` surfaces a one-line breadcrumb pointing at
                             this verb when the wave has interesting history.
  approve <run-id> [opts]    Approve findings for amend
  findings <run-id> [wave] [--format=text|markdown|json]
                             Findings digest for a wave (default: latest).
                             Format auto-detects: text on TTY, markdown when
                             piped/redirected. DOGFOOD_FINDINGS_FORMAT env var
                             (raw|human|json) overrides both.
  runs                       List all runs

Domain commands:
  domains <run-id>                          Show current map
  domains <run-id> --freeze                 Lock for the run
  domains <run-id> --unfreeze --reason "."  Unlock (requires reason)
  domains <run-id> --edit <name> [opts]     Modify globs/ownership/desc
  domains <run-id> --add <name> --globs ... Add new domain
  domains <run-id> --remove <name>          Remove domain
  domains <run-id> --history                Show change events

Phases:
  health-audit-a   health-amend-a
  health-audit-b   health-amend-b
  health-audit-c   health-amend-c
  stage-d-audit    stage-d-amend
  feature-audit    feature-execute`);
    process.exit(command ? 1 : 0);
  }

  try {
    commands[command](commandArgs);
  } catch (e) {
    renderTopLevelError(e);
    process.exit(1);
  }
}

if (isDirectExecution()) main();
