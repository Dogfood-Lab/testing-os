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
 *   swarm approve <run-id> [ids]     — Approve findings for amend
 *   swarm findings <run-id> [wave] [--format=text|markdown|json]
 *                                    — Findings digest for a wave (default: latest).
 *                                      Format defaults to text on TTY, markdown when piped.
 *   swarm runs                       — List all runs
 */

import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';

import { init } from './commands/init.js';
import { dispatch } from './commands/dispatch.js';
import { collect } from './commands/collect.js';
import { status, formatStatus } from './commands/status.js';
import { resume, formatResume } from './commands/resume.js';
import { buildReceipt, exportReceipt, storeReceipt } from './commands/receipt.js';
import { verify as runVerify, probeRepo, formatVerify, formatProbe } from './commands/verify.js';
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
    if (globsIdx >= 0) changes.globs = JSON.parse(args[globsIdx + 1]);
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
    const globs = JSON.parse(args[globsIdx + 1]);
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

  const result = dispatch({
    runId,
    phase,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    autoFreeze,
    isolate,
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

  console.log(`Next: swarm status ${runId}`);
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
  const overrideReason = reasonIdx >= 0 ? args[reasonIdx + 1] : undefined;

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

  let updated;
  if (approveAll) {
    updated = db.prepare(
      "UPDATE findings SET status = 'approved' WHERE run_id = ? AND status IN ('new', 'recurring')"
    ).run(runId);
  } else if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    updated = db.prepare(
      `UPDATE findings SET status = 'approved' WHERE run_id = ? AND finding_id IN (${placeholders}) AND status IN ('new', 'recurring')`
    ).run(runId, ...ids);
  } else {
    console.error('Specify --all or --ids F-001,F-002');
    process.exit(1);
  }

  console.log(`Approved ${updated.changes} findings for ${runId}`);

  // Record events
  const approved = db.prepare(
    "SELECT id FROM findings WHERE run_id = ? AND status = 'approved'"
  ).all(runId);
  const insertEvent = db.prepare(
    "INSERT INTO finding_events (finding_id, event_type, notes) VALUES (?, 'approved', 'bulk approve')"
  );
  for (const f of approved) insertEvent.run(f.id);
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

const command = process.argv[2];
const commandArgs = process.argv.slice(3);

const commands = {
  init: cmdInit,
  domains: cmdDomains,
  dispatch: cmdDispatch,
  collect: cmdCollect,
  verify: cmdVerify,
  receipt: cmdReceipt,
  advance: cmdAdvance,
  status: cmdStatus,
  resume: cmdResume,
  approve: cmdApprove,
  persist: cmdPersist,
  findings: cmdFindings,
  runs: cmdRuns,
};

if (!command || !commands[command]) {
  console.log(`swarm — Truthful swarm control plane for repo work

Commands:
  init <repo-path>           Create run, detect domains
  domains <run-id> [opts]    Show, edit, freeze, unfreeze domain map
  dispatch <run-id> <phase>  Create wave + agent prompts
  collect <run-id> [opts]    Validate, enforce ownership, merge
  verify <run-id> [opts]     Run build verification (auto-detect or --adapter)
  receipt <run-id> [wave]    Export durable wave receipt (JSON + markdown)
  advance <run-id> [opts]    Check gates and advance to next phase
  persist <run-id> [opts]    Export canonical truth to downstream systems
  status <run-id>            Control plane status
  resume <run-id>            Redispatch incomplete agents
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
