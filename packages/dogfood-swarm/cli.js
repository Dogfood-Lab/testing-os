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
import { resolve, join, dirname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { init } from './commands/init.js';
import { dispatch } from './commands/dispatch.js';
import { collect, resolveAllDomainOutputs } from './commands/collect.js';
import { runDoctor, formatDoctor } from './commands/doctor.js';
import { revalidate, formatRevalidate } from './commands/revalidate.js';
import { status, formatStatus } from './commands/status.js';
import { resume, formatResume } from './commands/resume.js';
import { history, formatHistory } from './commands/history.js';
import { rewind, formatRewind } from './commands/rewind.js';
import { redrive, formatRedrive } from './commands/redrive.js';
import { clean, formatClean } from './commands/clean.js';
import { cleanClaims, formatCleanClaims } from './commands/clean-claims.js';
import { buildReceipt, exportReceipt, storeReceipt } from './commands/receipt.js';
import { escapeReasonForDisplay } from './commands/lib/escape-reason.js';
import { verify as runVerify, probeRepo, formatVerify, formatProbe } from './commands/verify.js';
import { verifyFixed as runVerifyFixed } from './commands/verify-fixed.js';
import { verifyRecurring as runVerifyRecurring } from './commands/verify-recurring.js';
import { verifyUnverified as runVerifyUnverified } from './commands/verify-unverified.js';
import { verifyApproved as runVerifyApproved } from './commands/verify-approved.js';
import { advance as runAdvance, checkGates, getPromotions } from './lib/advance.js';
import { persist as runPersist, formatPersist } from './commands/persist.js';
import {
  runAdjudicate, formatAdjudication,
  previewAdjudicate, formatAdjudicationPreview,
  undoAdjudication, formatAdjudicationUndo,
} from './commands/adjudicate.js';
import { makeOllamaJury, LOCAL_JURY_SEATS } from './lib/case-file/ollama-jury.js';
import { makePrismJury, PRISM_JURY_SEATS, PRISM_CLOUD_SEATS } from './lib/case-file/prism-jury.js';
import { DEFAULT_JURY_SEATS } from './lib/case-file/adjudicate.js';
import { CaseFileNeutralityError } from './lib/case-file/handoff.js';
import { readBoundedJson } from './lib/bounded-json-read.js';
import { openDb } from './db/connection.js';
import {
  freezeDomains, unfreezeDomains, getDomains, aredomainsFrozen,
  editDomain, addDomain, removeDomain, getDomainEvents,
} from './lib/domains.js';
import { setTimeoutPolicy, getTimeoutPolicy } from './lib/state-machine.js';
// F-19f86582: cmdFindings no longer calls the all-in-one buildDigest() —
// it needs to attach a `.code`/`.hint` to the directory-resolution throws
// (typed-error surface owned by THIS file, cli.js) and to annotate each
// finding's DB-canonical id (F-ad540b83) BEFORE rendering, and neither seam
// exists on buildDigest itself. Both are lib/findings-digest.js /
// lib/findings-render.js concerns (swarm-cp-core's domain, not this one's),
// so cmdFindings reassembles the SAME orchestration buildDigest already
// does from its individually-exported pieces instead of editing that file.
// buildDigest is untouched and still exported for lib/findings-digest.js's
// own `node findings-digest.js <run-id>` direct-execution entry point.
import { findLatestWave, loadDomainOutputs, buildDigestModel } from './lib/findings-digest.js';
import { renderDigest } from './lib/findings-render.js';
import { renderTopLevelError } from './lib/error-render.js';
import { CliInvalidGlobsError } from './lib/errors.js';
import { renderPhaseList, renderPhaseColumns } from './lib/phases.js';
import { formatDomainRow } from './lib/domain-row.js';
import {
  queryRecurringFindings,
  queryPerRepoRunHistory,
  queryFindingRecurrenceRate,
} from './lib/queries/cross-run-analytics.js';

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

/**
 * Shared value-flag parser for `--flag value` / `--flag=value`.
 *
 * d5-swarm-cli-004 (Stage A): the v1.3.2 / cli-003 hardening was applied
 * per-NAMED-flag (only the four `--reason` sites carried the
 * `!next.startsWith('--')` swallow guard, and only `--threshold`/`--globs`
 * had equals-form support). Every other value-flag — `--repo`, `--ids`,
 * `--ownership`, `--desc`, `--adapter`, `--format` — was a one-off positional
 * scan with inconsistent equals-form support and no swallow guard. This
 * single helper closes the whole family:
 *
 *   - Accepts BOTH forms: `--flag value` and `--flag=value`.
 *   - The equals-form wins if present (an explicit `=` is unambiguous).
 *   - A following token that starts with `--` is the NEXT flag, not the
 *     value — treated as a MISSING value (returns undefined), so the
 *     caller's "X is required" guard fires instead of silently swallowing
 *     a sibling flag as the value (the cli-003 swallow class).
 *   - A bare trailing `--flag` with no following token returns undefined.
 *
 * Returns undefined when the flag is absent or its value is missing/swallowed,
 * so callers keep their existing `?? default` / "required" branching.
 *
 * @param {string[]} args
 * @param {string} flag — e.g. '--format'
 * @returns {string | undefined}
 */
export function parseValueFlag(args, flag) {
  const eqPrefix = `${flag}=`;
  // equals-form: --flag=value (value may be empty string; the caller validates)
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith(eqPrefix)) {
      return a.slice(eqPrefix.length);
    }
  }
  // space-form: --flag value, but a `--`-prefixed next token is the NEXT flag.
  const idx = args.indexOf(flag);
  if (idx >= 0 && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

/**
 * The valid `--format` enum shared by the verify-* verbs and `swarm findings`.
 */
const VERIFY_FORMATS = ['text', 'markdown', 'json'];

/**
 * d5-swarm-cli-003 (Stage A): fail-loud error for an out-of-enum `--format`
 * value. Same plain-Error-with-`.code` shape as thresholdError so the
 * top-level renderTopLevelError seam prints the structured envelope and exits
 * 1 — without coupling the shared parser to a new error class.
 *
 * @param {string} raw — the value the operator passed after --format
 */
function formatError(raw) {
  const e = new Error(
    `--format expects one of ${VERIFY_FORMATS.join('|')}; got '${raw}'`
  );
  e.code = 'CLI_INVALID_FORMAT';
  e.received = raw;
  e.hint = `pass one of: ${VERIFY_FORMATS.join(', ')} — e.g. \`--format json\` or \`--format=markdown\``;
  return e;
}

const JURY_TIERS = ['local', 'prism'];

/**
 * Fail-loud error for an out-of-enum `--jury`, mirroring formatError: a typo'd tier
 * must not silently fall back to the default panel, since the tier IS the strength of
 * the evidence the wave gate then reads.
 */
function juryError(raw) {
  const e = new Error(
    `--jury expects one of ${JURY_TIERS.join('|')}; got '${raw}'`
  );
  e.code = 'CLI_INVALID_JURY';
  e.received = raw;
  e.hint = `pass one of: ${JURY_TIERS.join(', ')} — e.g. \`--jury prism\` or \`--jury=local\``;
  return e;
}

/**
 * Parse + enum-validate the `--jury` tier. Returns 'local' when absent — the free,
 * fast, family-diverse default; `prism` is the stronger, slower per-criterion tier.
 */
export function parseJuryFlag(args) {
  const raw = parseValueFlag(args, '--jury');
  if (raw === undefined) return 'local';
  if (!JURY_TIERS.includes(raw)) throw juryError(raw);
  return raw;
}

/**
 * Parse + enum-validate a `--format` flag (both space- and equals-form).
 * Returns undefined when the flag is absent (caller falls back to auto-detect).
 * Throws CLI_INVALID_FORMAT on an out-of-enum value or a swallowed following
 * flag. d5-swarm-cli-003: closes the space-form's missing enum check + the
 * `--`-swallow gap that the sibling `--reason` already had.
 *
 * @param {string[]} args
 * @returns {string | undefined}
 */
export function parseFormatFlag(args) {
  const raw = parseValueFlag(args, '--format');
  if (raw === undefined) return undefined;
  if (!VERIFY_FORMATS.includes(raw)) throw formatError(raw);
  return raw;
}

// ── Resolve DB path ──
// Default: <repo root>/swarms/control-plane.db (resolved relative to this package)
const DEFAULT_SWARM_DIR = resolve(import.meta.dirname, '../../swarms');
const DEFAULT_DB_PATH = join(DEFAULT_SWARM_DIR, 'control-plane.db');

function getDbPath() {
  return process.env.SWARM_DB || DEFAULT_DB_PATH;
}

function getOutputDir(runId) {
  // Delta/output JSON lives alongside the ACTIVE control plane, not the
  // build-relative default: dirname(getDbPath()) is the swarms dir for the DB
  // in use. Hardcoding DEFAULT_SWARM_DIR meant a run against a custom SWARM_DB
  // (a relocated control plane, or a test temp DB) wrote its delta files into
  // THIS repo's swarms/ tree — polluting the canonical backing store and
  // leaking test artifacts. Default behavior is unchanged: with no SWARM_DB,
  // getDbPath() is DEFAULT_DB_PATH and dirname() is DEFAULT_SWARM_DIR.
  return join(dirname(getDbPath()), runId);
}

/**
 * d5-swarm-cli-B001 (Stage C): the `--domain=name:path` parse loop in
 * cmdCollect / cmdRevalidate accepts only tokens matching
 * /^--domain=([^:]+):(.+)$/ and SILENTLY discarded the rest. A token that
 * starts with `--domain=` but fails the regex (missing colon, empty name/path)
 * — or a misspelled `--doman=...` flag the loop never even inspects — vanished
 * with no diagnostic; the unprovided domain's agent was then marked `failed`
 * downstream and the whole wave flipped to `failed`, leaving the operator
 * diagnosing a wave-failure that was really a CLI typo.
 *
 * This helper surfaces those dropped tokens as a non-fatal structured stderr
 * warning naming each unparseable token + the expected shape, mirroring the
 * fail-loud-on-malformed-flag posture of parseValueFlag / parseFormatFlag. It
 * deliberately does NOT throw or change the exit code — the operator keeps the
 * partial collect but is no longer left guessing.
 *
 * Scope of detection: any token whose `--domain=` prefix the operator clearly
 * intended but that the strict regex rejected. We intentionally do NOT guess at
 * arbitrary misspellings of the flag NAME (e.g. `--doman=`) — those are
 * indistinguishable from unrelated positional args — but an EMPTY name or path
 * (`--domain=:x`, `--domain=x:`) and a missing colon (`--domain=x`) are caught.
 *
 * @param {string[]} args — the post-run-id arg slice
 */
function warnUnparseableDomainTokens(args) {
  const bad = [];
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.startsWith('--domain=')) continue;
    if (!/^--domain=([^:]+):(.+)$/.test(arg)) bad.push(arg);
  }
  if (bad.length === 0) return;
  console.error(
    `WARNING: ${bad.length} --domain= argument(s) could not be parsed and were IGNORED:`
  );
  for (const t of bad) console.error(`  ${t}`);
  console.error('  Expected shape: --domain=name:path (e.g. --domain=backend:outputs/backend.json).');
  console.error('  The ignored domain(s) will be reported as `failed` (Output file not found); re-run with the corrected --domain= arg.');
}

/**
 * F4-CP-05: surface the `--all`-discovered domains whose deterministic output
 * file is MISSING on disk as a non-fatal structured stderr warning. Mirrors
 * warnUnparseableDomainTokens' fail-loud-but-non-fatal posture: it does NOT
 * change the exit code or gate — collect proceeds with the present domains and
 * the absent agent is reported `failed` (Output file not found) downstream,
 * exactly as the manual --domain path would report it. The operator is no
 * longer left guessing which agent never wrote its output.
 *
 * @param {Array<{ domain: string, path: string }>} missing
 */
function warnMissingAllOutputs(missing) {
  if (!missing || missing.length === 0) return;
  console.error(
    `WARNING: ${missing.length} dispatched domain(s) have no output file at the expected path and were SKIPPED by --all:`
  );
  for (const m of missing) console.error(`  ${m.domain} → ${m.path}`);
  console.error('  Each skipped domain will be reported as `failed` (Output file not found).');
  console.error('  Re-run the agent for that domain, or supply its output with --domain=name:path.');
}

/**
 * swarm-cli-B-001 (Stage C carry-over): build the per-agent degraded-probe
 * lines for `swarm collect` stdout. collect.js sets
 * `agentReport.ownership_probe_degraded` (and `files_changed_divergence`) on
 * every non-isolated amend agent, but the only operator surface was the
 * wave-level banner — which fires ONLY for `multi_domain` (≥2 degraded
 * domains). A SINGLE degraded domain reached no surface at all, so the
 * operator never learned that re-dispatching with --isolate would restore full
 * cross-domain attribution. This renders one scannable `[degraded]` line per
 * affected agent so the weakened guarantee is visible at any domain count.
 *
 * Pure (returns lines; the caller prints) so the render path is unit-testable
 * without spawning the CLI. Observability only — like the banner it never
 * changes the exit code or the wave gate.
 *
 * @param {{ agents?: Array<object> }} result — the collect() report
 * @returns {string[]} zero or more stdout lines
 */
export function renderProbeDegradedAgents(result) {
  const lines = [];
  for (const a of (result?.agents || [])) {
    if (!a.ownership_probe_degraded) continue;
    lines.push(
      `[degraded] ${a.domain}: ownership probe restricted to domain globs — ` +
      're-dispatch with --isolate for full cross-domain attribution'
    );
    // The independent-diff divergence is the partner signal: when present it
    // tells the operator WHICH files the narrowed probe could/could not see.
    const div = a.files_changed_divergence;
    if (div && !div.unavailable) {
      const missing = (div.missing_from_report || []).length;
      const extra = (div.extra_in_report || []).length;
      if (missing || extra) {
        lines.push(
          `             files_changed divergence: ${missing} unreported, ${extra} phantom`
        );
      }
    }
  }
  return lines;
}

// ── Command handlers ──

function cmdInit(args) {
  const repoPath = args[0];
  if (!repoPath) {
    console.error('Usage: swarm init <repo-path> [--repo org/name]');
    process.exit(1);
  }

  // d5-swarm-cli-004 (Stage A): route through the shared value-flag parser so
  // `--repo=org/name` (equals-form) is supported like every sibling flag, and
  // a swallowed `--repo --next-flag` is treated as missing (→ auto-detect)
  // rather than capturing the following flag as the repo slug.
  const repo = parseValueFlag(args, '--repo') ?? undefined;

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
    console.log(formatDomainRow(d, { trailer: `${d.matched_files} files` }));
  }
  if (result.unmatched.length > 0) {
    console.log(`\n  ${result.unmatched.length} unmatched files (will go to "shared" or remain unassigned)`);
  }
  console.log(`\nNext: review domains, then run: swarm freeze ${result.runId}`);
}

function cmdDomains(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm domains <run-id> [--freeze | --unfreeze --reason "..." [--force] | --edit <name> [opts] | --add <name> [opts] | --remove <name> | --history]');
    process.exit(1);
  }

  const db = openDb(getDbPath());

  // --freeze
  if (args.includes('--freeze')) {
    freezeDomains(db, runId);
    const domains = getDomains(db, runId);
    console.log(`Domains frozen for ${runId}:`);
    for (const d of domains) {
      console.log(formatDomainRow(d, { frozen: true }));
    }
    console.log('\nNext: swarm dispatch ' + runId + ' health-audit-a');
    return;
  }

  // --unfreeze --reason "..."
  if (args.includes('--unfreeze')) {
    // d5-swarm-cli-NEW (Stage A): this is the FIFTH `--reason` value-flag site
    // and it lacked the cli-003 `--`-swallow guard applied to revalidate /
    // rewind / redrive / advance. Without it, `--unfreeze --reason --freeze`
    // captured '--freeze' as the audit reason and unfroze with a junk reason
    // recorded into domain_events (the reason is a mandatory non-empty audit
    // field). parseValueFlag rejects a `--`-prefixed following token (→
    // undefined → the "requires --reason" guard fires) and adds equals-form
    // (`--reason=...`) support to match the sibling sites.
    const reason = parseValueFlag(args, '--reason');
    if (!reason || !reason.trim()) {
      console.error('--unfreeze requires --reason "explanation"');
      process.exit(1);
    }
    // F-b66306c5: unfreezeDomains (lib/domains.js) refuses while a wave is
    // in flight and its own thrown message names `{ force: true }` as the
    // documented escape hatch for an operator who has already halted the
    // wave by hand — but nothing here ever parsed --force, so that escape
    // hatch was unreachable from the CLI surface that prints the message.
    const force = args.includes('--force');
    unfreezeDomains(db, runId, reason, { force });
    // F-7c3e91a4 class (wave 18): immediate echo of the operator's own
    // just-typed --reason, same family as rewind/redrive/revalidate/
    // clean-claims's "Reason recorded" lines — see commands/lib/escape-reason.js.
    console.log(`Domains unfrozen for ${runId} (reason: ${escapeReasonForDisplay(reason)})`);
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
    // d5-swarm-cli-004 (Stage A): the edit-path `--ownership`/`--desc` took the
    // next token raw with no `--`-swallow guard, so e.g.
    // `--edit x --ownership --globs '[...]'` captured '--globs' as the
    // ownership_class. parseValueFlag rejects a `--`-prefixed following token
    // (and adds equals-form support) so a swallowed value is treated as absent.
    const ownership = parseValueFlag(args, '--ownership');
    if (ownership !== undefined) changes.ownership_class = ownership;
    const desc = parseValueFlag(args, '--desc');
    if (desc !== undefined) changes.description = desc;

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
    // d5-swarm-cli-004 (Stage A): the add-path `--ownership` took the next
    // token raw, so a swallowed `--globs` would persist as a garbage
    // ownership_class (addDomain does not validate it). parseValueFlag rejects
    // a `--`-prefixed value (→ undefined → default 'owned') and adds
    // equals-form support.
    const ownership = parseValueFlag(args, '--ownership') ?? 'owned';
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
      // F-7c3e91a4 class (wave 18): domain_events.reason is the SAME
      // stored-audit-trail shape as wave_state_events/agent_state_events
      // (clean-claims's file_claims_cleaned rows and unfreezeDomains both
      // write here with a raw operator --reason) — a read-later verb exactly
      // like `swarm history`/`swarm status`, so the same forged-row hazard
      // applies. See commands/lib/escape-reason.js.
      const reasonClause = e.reason ? ' — ' + escapeReasonForDisplay(e.reason) : '';
      console.log(`  ${e.created_at} | ${e.domain_name} | ${e.event_type}${reasonClause}`);
    }
    return;
  }

  // Default: show current domain map
  const domains = getDomains(db, runId);
  const frozen = aredomainsFrozen(db, runId);

  console.log(`Domains for ${runId} [${frozen ? 'FROZEN' : 'DRAFT'}]:\n`);
  for (const d of domains) {
    console.log(formatDomainRow(d, { frozen: !!d.frozen }));
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
    console.error('Usage: swarm dispatch <run-id> <phase> [--auto-freeze] [--isolate] [--skip-verify] [--dry-run|--preview]');
    console.error(`Phases: ${renderPhaseList()}`);
    process.exit(1);
  }

  const autoFreeze = args.includes('--auto-freeze');
  const isolate = args.includes('--isolate');
  // Item 5: parallel-wave verification discipline. When set, agent prompts
  // include the directive to skip per-agent `npm test`/`npm run verify` and
  // emit `verification_skipped: true` in their output JSON. Coordinator runs
  // ONE serial verify after `swarm collect` against the cumulative tree.
  const skipVerify = args.includes('--skip-verify');
  // --dry-run / --preview: compute the wave shape (which domains become agents,
  // the prompt paths that WOULD be written, per-domain approved-finding routing
  // counts for amend phases, the worktrees that WOULD be created under
  // --isolate) with ZERO control-plane write, file write, or worktree creation.
  // The operator's "what will this dispatch do?" preview before committing the
  // wave. --preview is an alias so the verb reads naturally either way.
  const dryRun = args.includes('--dry-run') || args.includes('--preview');

  const result = dispatch({
    runId,
    phase,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    autoFreeze,
    isolate,
    skipVerify,
    dryRun,
  });

  // F-aa32371b: approved findings routed to ZERO domain agents (file-less or
  // no-glob-match) silently block the finding-severity gate forever if the
  // operator never learns about them. Loud on BOTH the dry-run and apply
  // paths, before the per-agent listing.
  // F-7970a30b: dispatching over a failed wave with blocked agents closes the
  // `swarm revalidate` window (revalidate reads the LATEST wave). Warn before
  // the per-agent listing so the narrowing recovery path is never silent.
  if (result.supersededFailedWave) {
    console.log(`\n[!] ${result.supersededFailedWave.message}`);
  }

  const unrouted = result.unroutedApprovedFindings || [];
  if (unrouted.length > 0) {
    console.log(`\n===== [!] ${unrouted.length} APPROVED FINDING(S) ROUTED TO NO AGENT [!] =====`);
    for (const f of unrouted) {
      console.log(`  ${f.finding_id} [${f.severity}] ${f.file_path || '(no file_path — cannot match any domain glob)'}`);
    }
    console.log('  These findings stay OPEN and block the severity gate, but no amend agent will receive them.');
    console.log('  Close them via the coordinator_resolved path: land the fix yourself, and for anchorless (architectural/doc-level) ones attach `coordinator_resolved: true` + a one-line `verified_via_evidence` so `swarm verify-fixed <run-id>` classifies the closure as allowlist instead of unverifiable.');
    console.log('  Or dispose without a fix: `swarm defer <run-id> --ids F-001,F-002 --reason "<text>"` (accepted/postponed) / `swarm reject <run-id> --ids F-001,F-002 --reason "<text>"` (not-a-defect) — both close the finding for the gate.');
  }

  if (result.dryRun) {
    console.log(`\nDISPATCH DRY-RUN — wave ${result.waveNumber} would be dispatched (${result.phase})`);
    console.log(`Prompts would be written to: ${result.promptDir}\n`);
    for (const a of result.agents) {
      const wt = a.worktreePath ? ` [worktree would be: ${a.worktreePath}]` : '';
      const findings = a.approvedFindingCount !== undefined
        ? ` — ${a.approvedFindingCount} approved finding(s) routed`
        : '';
      console.log(`  ${a.domain} (${a.ownershipClass}) → ${a.promptPath}${findings}${wt}`);
    }
    console.log(`\nWould dispatch ${result.agents.length} agents. No control-plane write, no file write, no worktree creation.`);
    console.log(`Re-run without --dry-run to commit the wave.`);
    return;
  }

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
    console.error('Usage: swarm collect <run-id> (--all | --domain=name:path [--domain=name:path ...])');
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

  const hasExplicitDomain = Object.keys(outputs).length > 0;
  const wantsAll = args.includes('--all');

  // F4-CP-05: `--all` and explicit `--domain` are mutually exclusive — an
  // explicit `--domain` OVERRIDES `--all` so the manual path stays byte-for-
  // byte unchanged. Only when NO `--domain` was parsed does `--all` resolve the
  // map from the control plane (latest dispatched wave's domains → the
  // deterministic swarms/<run>/wave-N/<domain>/output.json layout). A domain
  // whose output file is absent is a non-fatal structured warning (reuses the
  // cli-B001 warn discipline) — collect proceeds with the present ones.
  if (wantsAll && !hasExplicitDomain) {
    let resolved;
    try {
      resolved = resolveAllDomainOutputs({
        runId,
        dbPath: getDbPath(),
        swarmDir: dirname(getDbPath()),
      });
    } catch (e) {
      console.error(`collect --all: ${e.message}`);
      process.exit(1);
    }
    warnMissingAllOutputs(resolved.missing);
    Object.assign(outputs, resolved.outputs);
  }

  // d5-swarm-cli-B001 (Stage C): warn loudly on any `--domain=` token that
  // failed the parse regex (missing colon, misspelled flag). The pre-fix loop
  // SILENTLY discarded these, and the sole `Object.keys(outputs).length === 0`
  // guard below fires only on a ZERO-parse — a PARTIAL drop (N args, one
  // malformed) passed through, the unprovided domain's agent was later marked
  // `failed` ('Output file not found' in collect.js), the wave flipped to
  // `failed`, and the operator had no error pointing at the fat-fingered arg.
  // This is the same fail-loud-on-malformed-flag discipline the parseValueFlag
  // `--`-swallow guard and parseFormatFlag enum check already enforce. It is a
  // non-fatal observability warning — it does NOT change the exit code or gate.
  warnUnparseableDomainTokens(args.slice(1));

  if (Object.keys(outputs).length === 0) {
    console.error('No outputs provided. Use --all to auto-discover, or --domain=name:path for each agent output.');
    console.error('Example: swarm collect <run-id> --all');
    console.error('     or: swarm collect <run-id> --domain=backend:outputs/backend.json --domain=tests:outputs/tests.json');
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

  // d3b-collect-A-002 (Stage B follow-up): a multi-domain amend wave that ran
  // WITHOUT --isolate gets a wave-level banner. Each agent's independent
  // ownership probe was narrowed to its own domain globs (the shared-worktree
  // diff is not attributable per-agent), so cross-domain enforcement holds only
  // for self-reported edits. The per-agent `ownership_probe_degraded` note
  // already records this; the banner surfaces it once, loudly, so the operator
  // does not have to read every agent record to discover the weakened
  // guarantee. Observability only — like the divergence note, it never changes
  // the exit code or the wave gate. See swarms/PROTOCOL.md §Ownership
  // attribution in non-isolated parallel amend waves.
  // swarm-cli-B-001 (Stage C carry-over): per-agent degraded-probe lines. These
  // render at ANY domain count — including the single-degraded-domain case the
  // wave-level multi_domain banner below skips — so the weakened cross-domain
  // attribution is never silent. Printed before the banner so the operator sees
  // which domains are affected, then the once-loud --isolate recommendation.
  const degradedLines = renderProbeDegradedAgents(result);
  if (degradedLines.length > 0) {
    for (const line of degradedLines) console.log(line);
    console.log('');
  }

  const probeDegraded = result.ownership_probe_degraded;
  if (probeDegraded && probeDegraded.multi_domain) {
    console.log('===== [!] OWNERSHIP PROBE DEGRADED [!] =====');
    console.log('  This amend wave ran without --isolate across multiple domains');
    console.log(`  (${probeDegraded.domains.join(', ')}). The independent git probe`);
    console.log('  cannot attribute a shared-worktree edit to a single agent, so each');
    console.log("  agent's cross-domain ownership check covers only its SELF-REPORTED");
    console.log('  files_changed. A silent out-of-domain edit an agent also omits from');
    console.log('  files_changed is NOT independently caught. Re-dispatch with --isolate');
    console.log('  for full cross-domain attribution. See swarms/PROTOCOL.md §Ownership');
    console.log('  attribution in non-isolated parallel amend waves.');
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

/**
 * F5-09: `swarm doctor` preflight. Runs the read-only environment checks in
 * commands/doctor.js (Node floor, control-plane dir writable + hardlink-capable,
 * on-disk schema not newer than this build) and prints a structured pass/warn/
 * fail report. Exits non-zero ONLY on a hard FAIL — a WARN does not gate (the
 * environment is usable, just sub-ideal), so warns exit 0. No run-id required:
 * doctor probes the environment + the control-plane DB path (getDbPath()),
 * which exist independent of any specific run.
 */
function cmdDoctor(_args) {
  const report = runDoctor({ dbPath: getDbPath() });
  console.log(formatDoctor(report));
  if (report.exitCode !== 0) process.exit(report.exitCode);
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

  // d5-swarm-cli-B001 (Stage C): cmdRevalidate shares cmdCollect's silent-drop
  // loop and the same zero-match-only guard below. Same fix: name every
  // unparseable `--domain=` token on stderr so a fat-fingered recovery arg
  // does not vanish. Non-fatal; the exit code / gate behaviour is unchanged.
  warnUnparseableDomainTokens(args.slice(1));

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

/**
 * F4-CP-02: project the rich object `status()` already returns into a stable
 * JSON payload for `swarm status --format=json`. status() RETURNS the
 * structured object (run/domains/waves/agents/findings/assessment) but
 * cmdStatus only ever printed the text formatter — a machine consumer had no
 * structured surface. The object is already JSON-serializable, so this is the
 * identity projection; the helper exists as the named seam (mirroring the
 * buildRunsJSON sibling) and pins the contract that the JSON path emits the
 * SAME object the text formatter consumes — no divergent shape.
 *
 * @param {object} s — the object from status()
 * @returns {object}
 */
function buildStatusJSON(s) {
  return s;
}

function cmdStatus(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm status <run-id> [--format=text|json]');
    process.exit(1);
  }

  // F4-CP-02: --format=json emits the structured object status() returns
  // instead of the text frame. parseFormatFlag enum-validates (throw
  // CLI_INVALID_FORMAT on a bad value) + carries the `--`-swallow guard, same
  // as the verify-* / findings sites. Default (undefined) stays text. Note:
  // status carries no 'markdown' renderer, so 'markdown' falls through to the
  // text formatter — the shared enum allows it, the verb just has no distinct
  // markdown shape. Exit code is unchanged (status is informational, exit 0).
  const format = parseFormatFlag(args);

  const s = status({ runId, dbPath: getDbPath() });
  if (format === 'json') {
    console.log(JSON.stringify(buildStatusJSON(s), null, 2));
    return;
  }
  console.log(formatStatus(s));
}

function cmdResume(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm resume <run-id> [--force]');
    process.exit(1);
  }

  // F-058f4d54: resume()'s COORD-002 guard (resume.js:204) refuses to
  // redispatch over a dirty/unmerged --isolate worktree and its own error
  // message tells the operator to pass `{ force: true } (CLI: --force)` —
  // but until this fix nothing here ever parsed --force, so the advertised
  // escape hatch was unreachable and the refusal fired identically every
  // time, with the flag silently discarded.
  const force = args.includes('--force');

  const r = resume({
    runId,
    dbPath: getDbPath(),
    outputDir: getOutputDir(runId),
    force,
  });
  console.log(formatResume(r));

  // F-3c489002 (Stage C): the SUCCESS actions used to end with no next verb,
  // breaking the "every terminal surface hands the operator the next step"
  // discipline `swarm dispatch` ("When done, run: swarm collect") and `swarm
  // collect` ("Next: swarm status") uphold. Print an action-specific Next line
  // so a just-resumed operator is told exactly what to run — the redispatched
  // case additionally names the agent-execution step so collect is not run
  // before the redispatched agents finish. Both route to `swarm collect`.
  if (r.action === 'redispatched') {
    const n = r.redispatch.length;
    console.log(`\nNext: run the ${n} redispatched agent(s) with the prompts above, then swarm collect ${runId}`);
  } else if (r.action === 'all_complete') {
    console.log(`\nNext: swarm collect ${runId}`);
  } else if (r.action === 'rewound') {
    // ds-lib-002: the wave was rewound — re-dispatch the phase, do NOT collect.
    console.log(`\nNext: swarm dispatch ${runId} ${r.phase} (the rewound wave's tree was reset — not collectable)`);
  }

  // d5-swarm-cli-B002 (Stage C): `swarm resume` sits in the same scripted
  // operator chain as the verify/persist/findings gate verbs (`swarm resume &&
  // swarm collect`), yet it used to exit 0 on EVERY action — including
  // `blocked` (agents in invalid_output / ownership_violation that need manual
  // fix or `swarm revalidate`) and `unknown` (an unexpected state-combination).
  // A CI step gating on $? then advanced past a wave that cannot proceed.
  // formatResume already prints BLOCKED + the revalidate recovery hint to a
  // human, so this aligns the MACHINE signal with the human-readable one — the
  // same 'CI must see the gate fail' contract pinned for `swarm verify` by
  // cli-p-002. redispatched / waiting / all_complete / none stay at exit 0.
  // ds-lib-002: a `rewound` wave is not collectable (its tree was reset by
  // `swarm rewind`), so — like `blocked`/`unknown` — its machine signal must
  // halt a scripted `swarm resume && swarm collect` chain rather than let it
  // proceed into a wave that cannot be collected. redispatched / waiting /
  // all_complete / none stay at exit 0.
  if (r.action === 'blocked' || r.action === 'unknown' || r.action === 'rewound') {
    process.exit(1);
  }
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

function cmdClean(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: swarm clean <run-id> [--apply] [--force] [--format=text|json]');
    console.log('');
    console.log('Reclaim the stranded --isolate worktrees + swarm/* branches for a run.');
    console.log('Under --isolate, dispatch creates a per-agent git worktree; recordPromotion');
    console.log('tears them down on the run\'s terminal `complete` transition. A run abandoned,');
    console.log('rewound, or interrupted before `complete` strands those worktrees on disk —');
    console.log('`swarm clean` is the operator reclaim. Dry-run by default; --apply removes.');
    console.log('');
    console.log('Required:');
    console.log('  <run-id>             The run whose worktrees to reclaim');
    console.log('');
    console.log('Optional:');
    console.log('  --apply              Remove (default: dry-run preview)');
    console.log('  --force              Required IN ADDITION to --apply to remove a');
    console.log('                       DIRTY or UNMERGED worktree (uncommitted/unpushed');
    console.log('                       agent work). --apply alone SKIPS those, mirroring');
    console.log('                       `swarm rewind`\'s --force-on-top-of---apply contract.');
    console.log('  --format=text|json   Output format (default: text)');
    console.log('');
    console.log('--apply refuses while this run\'s latest wave is still `dispatched`/');
    console.log('`collecting` — finish it first (`swarm collect` / `swarm redrive` /');
    console.log('`swarm rewind`) so a live agent\'s worktree is never reclaimed mid-flight.');
    return;
  }

  const runId = args[0];
  if (!runId || runId.startsWith('--')) {
    console.error('Usage: swarm clean <run-id> [--apply] [--force] [--format=text|json]');
    process.exit(1);
  }

  const format = parseFormatFlag(args);
  const apply = args.includes('--apply');
  // F-d2025a4d(b): --force is required in ADDITION to --apply to remove a
  // dirty/unmerged worktree — mirrors rewind's --force-on-top-of---apply.
  const force = args.includes('--force');

  // F-d2025a4d(a): an in-flight-wave refusal (CLEAN_WAVE_IN_FLIGHT) propagates
  // to main()'s top-level renderTopLevelError seam, which prints the coded
  // envelope (message + named recovery verbs) and exits 1 — same as every
  // other typed CLI error in this file; no bespoke catch needed here.
  const result = clean({ runId, dbPath: getDbPath(), apply, force });

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  process.stdout.write(formatClean(result));

  if (apply) {
    const skippedNote = result.skippedAtRisk > 0
      ? `, ${result.skippedAtRisk} skipped (dirty/unmerged — re-run with --force)`
      : '';
    console.log(`\nClean applied. ${result.removed} removed, ${result.stranded} stranded${skippedNote}.`);
  } else {
    console.log('\nDry-run only — re-run with --apply to remove the worktrees.');
  }
}

function cmdCleanClaims(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: swarm clean-claims <run-id> [--wave=N] [--agent-run=ID] [--apply --reason "<text>"] [--format=text|json]');
    console.log('');
    console.log('Delete phantom violation=1 file_claims rows stranded on TERMINAL waves');
    console.log('(advanced / aborted_for_rewind) — rows no lawful verb can revisit:');
    console.log('collect only runs on a dispatched wave, revalidate only repairs blocked');
    console.log('agents on the run\'s latest wave, redrive refuses terminal waves.');
    console.log('');
    console.log('file_claims rows are CLAIMS about what a pass observed, not audit');
    console.log('events — deleting a superseded claim is the lawful write. The');
    console.log('agent_state_events audit trail is NEVER touched. Dry-run by default;');
    console.log('the preview shows each agent_run\'s claims plus the state-event');
    console.log('evidence that supersedes them.');
    console.log('');
    console.log('Required:');
    console.log('  <run-id>             The run whose phantom claims to clean');
    console.log('');
    console.log('Required to mutate:');
    console.log('  --apply              Delete (default: dry-run preview)');
    console.log('  --reason "<text>"    Non-empty audit reason, required with --apply;');
    console.log('                       recorded in domain_events with the clean-claims:');
    console.log('                       prefix (one restorable audit row per domain)');
    console.log('');
    console.log('Optional:');
    console.log('  --wave=N             Only wave N (wave_number within this run)');
    console.log('  --agent-run=ID       Only this agent_runs.id (must belong to this run)');
    console.log('  --format=text|json   Output format (default: text)');
    console.log('');
    console.log('Scope guards: rows on non-terminal waves are REFUSED with the verb that');
    console.log('still owns them (collect / revalidate / redrive); violation=0 rows and');
    console.log('other runs\' rows are never touched (re-verified inside the delete');
    console.log('transaction — a violated invariant rolls everything back).');
    return;
  }

  const runId = args[0];
  if (!runId || runId.startsWith('--')) {
    console.error('Usage: swarm clean-claims <run-id> [--wave=N] [--agent-run=ID] [--apply --reason "<text>"] [--format=text|json]');
    process.exit(1);
  }

  const format = parseFormatFlag(args);
  const apply = args.includes('--apply');
  const reason = parseValueFlag(args, '--reason');
  const wave = parseValueFlag(args, '--wave');
  const agentRun = parseValueFlag(args, '--agent-run');

  if (apply && (!reason || !reason.trim())) {
    console.error('clean-claims: --reason "<text>" is required with --apply (non-empty)');
    process.exit(1);
  }

  // Typed errors (RUN_NOT_FOUND, WAVE_NOT_FOUND, AGENT_RUN_NOT_IN_RUN, the
  // in-tx CLEAN_CLAIMS_* guards) propagate to main()'s renderTopLevelError
  // seam — same posture as cmdClean.
  const result = cleanClaims({ runId, dbPath: getDbPath(), wave, agentRun, reason, apply });

  if (format === 'json') {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  process.stdout.write(formatCleanClaims(result));

  if (apply) {
    console.log(`\nClean-claims applied. ${result.totals.deleted} row(s) deleted. ` +
      `Inspect with \`swarm status ${runId}\` / \`swarm domains ${runId} --history\`.`);
  } else {
    console.log('\nDry-run only — re-run with --apply --reason "<text>" to delete the eligible rows.');
  }
}

function cmdHistory(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: swarm history <wave-id> [--format=text|json]');
    console.log('');
    console.log('Render the full wave_state_events transition chain for <wave-id>.');
    console.log('Each row shows: from_status -> to_status, when, and the operator-');
    console.log('supplied reason text (override transitions via `swarm revalidate`');
    console.log('carry their --reason text here prefixed with `revalidate:`).');
    console.log('--format=json emits the structured {waveId,wave,events} report.');
    return;
  }

  const waveIdArg = args[0];
  if (!waveIdArg) {
    console.error('Usage: swarm history <wave-id> [--format=text|json]');
    process.exit(1);
  }

  // --format=json emits the structured history() report ({waveId,wave,events})
  // instead of the text table. The report is already JSON-serializable — the
  // identity-projection seam matches the status/runs sites. parseFormatFlag
  // enum-validates + carries the `--`-swallow guard.
  const format = parseFormatFlag(args);

  try {
    const report = history({ waveId: waveIdArg, dbPath: getDbPath() });
    if (format === 'json') {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
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

  // d5-swarm-cli-004 (Stage A): `--adapter` took the next token raw, so
  // `--adapter --probe-only` would capture '--probe-only' as the adapter
  // override. parseValueFlag rejects a `--`-prefixed following token (→
  // undefined → adapter auto-detect) and adds equals-form support.
  const override = parseValueFlag(args, '--adapter') ?? undefined;

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
    // F-5dabf101: process.exitCode + return, NOT process.exit() — exit()
    // terminates without waiting for the pending async write of the
    // formatVerify(result) console.log above to drain. stdout is async
    // whenever it's a pipe (every `swarm verify ... | ...`) and, per Node's
    // own docs, on Windows even for a TTY — this repo's own platform. Node
    // exits naturally with the set code once stdout drains. Mirrors
    // cmdAdjudicate, the one verb in this file that already did this right.
    process.exitCode = 1;
    return;
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
 * ve-002 + d5-swarm-cli-002: BOTH the space form (`--threshold <value>`) and the
 * equals form (`--threshold=<value>`) route through parseValueFlag and the SAME
 * non-negative-integer validation, so a typo like `--threshold foo` or
 * `--threshold=1O` (letter O, not a digit) fails loud instead of silently
 * disabling the gate. A NaN/0-coerced threshold silently disabled it: `offending
 * > NaN` (or `> 0` from a 0-coercion) let the command exit 0 ("clean") even with
 * real regressions, on all four verify-* verbs. NOTE: pre-fix the equals-form was
 * NOT digit-guarded — `^--threshold=(\d+)$` simply failed to match a malformed
 * value and left threshold at the strictest default 0; d5-swarm-cli-002 closed
 * that hole by validating both forms identically (see the inline note below).
 *
 * @throws when either form's value is not a finite non-negative integer.
 */
export function parseVerifyFlags(args) {
  let threshold = 0;

  // d5-swarm-cli-002 (Stage A): the equals-form previously matched only
  // `^--threshold=(\d+)$` and SILENTLY left threshold at the default 0 on a
  // malformed value (`--threshold=abc` → 0, no throw) while the space-form
  // threw CLI_INVALID_THRESHOLD. A typo like `--threshold=1O` (letter O)
  // silently became the strictest gate (0), failing on findings the operator
  // meant to allow. Route the equals-form through the SAME validation as the
  // space-form so both reject malformed input identically.
  const thresholdRaw = parseValueFlag(args.slice(1), '--threshold');
  if (thresholdRaw !== undefined) {
    const n = parseInt(thresholdRaw, 10);
    if (!Number.isFinite(n) || n < 0 || !/^\d+$/.test(String(thresholdRaw).trim())) {
      throw thresholdError(thresholdRaw);
    }
    threshold = n;
  }

  // d5-swarm-cli-003 (Stage A): the space-form `--format` took the next token
  // raw with no enum check and no `--`-swallow guard. parseFormatFlag closes
  // both: enum-validate (throw CLI_INVALID_FORMAT) + reject a swallowed flag.
  const format = parseFormatFlag(args.slice(1));

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
  // DSW-D-001: under --format=json the output IS the JSON contract — emit it
  // pure (mirror cmdStatus/cmdRuns, which return after the JSON). The human
  // `Delta written to:` footer would corrupt `... --format=json | jq`. The
  // delta path still goes to the operator on the text/TTY path below.
  if (format !== 'json') {
    console.log('');
    console.log(`Delta written to: ${result.deltaPath}`);
  }

  // Exit with the 3-way state: 0 clean / 1 threshold exceeded /
  // 2 pipeline broken. The CLI seam preserves this signal so CI gates
  // can use `swarm verify-fixed` as a check.
  //
  // F-5dabf101: process.exitCode + return, not process.exit() — the
  // `console.log(result.output)` above (and the `Delta written to:`
  // footer) are pending async stdout writes that process.exit() does not
  // wait to drain (pipes always, Windows TTY too). A large digest exceeding
  // the pipe buffer would truncate mid-write for every
  // `swarm verify-fixed ... --format=json | jq` consumer — defeating the
  // JSON-purity work this exact verb exists to protect (see the format
  // note above cmdVerifyFixed).
  process.exitCode = result.exitCode;
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
  if (format !== 'json') {
    console.log('');
    console.log(`Delta written to: ${result.deltaPath}`);
  }
  // F-5dabf101: process.exitCode, not process.exit() — see cmdVerifyFixed's
  // note; identical truncation hazard on the same JSON-purity contract.
  process.exitCode = result.exitCode;
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
  if (format !== 'json') {
    console.log('');
    console.log(`Delta written to: ${result.deltaPath}`);
  }
  // F-5dabf101: process.exitCode, not process.exit() — see cmdVerifyFixed's
  // note; identical truncation hazard on the same JSON-purity contract.
  process.exitCode = result.exitCode;
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
  if (format !== 'json') {
    console.log('');
    console.log(`Delta written to: ${result.deltaPath}`);
  }
  // Exit code 2 on broken anchor blocks subsequent amend dispatch — the
  // CLI seam carries the signal so a CI step can gate dispatch on it.
  // F-5dabf101: process.exitCode, not process.exit() — see cmdVerifyFixed's
  // note; identical truncation hazard on the same JSON-purity contract.
  process.exitCode = result.exitCode;
}

function cmdReceipt(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm receipt <run-id> [wave-number] [--format=json]');
    process.exit(1);
  }

  // The first positional after run-id is the wave number ONLY when numeric, so
  // a stray `--format=json` (operator omits the wave) is parsed as a flag, not
  // misread as the wave id — same guard as cmdFindings.
  const waveNumber = args[1] && /^\d+$/.test(args[1]) ? parseInt(args[1], 10) : undefined;

  // --format=json emits the receipt object as PURE JSON to stdout (no human
  // footer that would corrupt `... --format=json | jq`). The export-to-disk +
  // control-plane store still happen — those are the verb's durable artifacts
  // and write to files/DB, not stdout, so stdout stays parseable. Mirrors the
  // DSW-D-001 verify-* purity rule. parseFormatFlag enum-validates.
  const format = parseFormatFlag(args);

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

  if (format === 'json') {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  console.log(`Receipt exported for wave ${receipt.wave.number} (${receipt.wave.phase}):`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log('');
  // F-d6cf96e4 (wave 20) class-completion: receipt.recommendation.reason is
  // the SAME computeRecommendation() value commands/receipt.js's
  // formatReceiptMarkdown now escapes (see that file's Recommendation
  // section) — this is the CLI's own separate text render of that field
  // (the --format=json branch above already returned with the raw object).
  // Escaping only the .md artifact and leaving this stdout render bare would
  // be exactly the single-instance-patch shape wave 19's audit exists to
  // catch, applied to a field this wave already touched once.
  console.log(`Recommendation: ${receipt.recommendation.action}${receipt.recommendation.reason ? ' — ' + escapeReasonForDisplay(receipt.recommendation.reason) : ''}`);
}

/**
 * Identity-projection seam for `swarm advance --check-only --format=json`.
 * checkGates() already returns the structured
 * {verdict,nextPhase,reason,gates[],overridable} object the text branch
 * consumes; this names the seam (mirroring buildStatusJSON / buildRunsJSON) and
 * pins the contract that the JSON path emits the SAME object — no divergent
 * shape between the human and machine surfaces.
 *
 * @param {object} g — the object from checkGates()
 * @returns {object}
 */
function buildCheckGatesJSON(g) {
  return g;
}

async function cmdAdjudicate(args) {
  const runId = args[0];

  // F-fa047531: --undo is the compensator CLI surface for
  // lib/adjudication-store.js#deleteAdjudication — pre-fix that function
  // was wired to NOTHING (no CLI verb reached it), so the only way an
  // operator could invoke it was raw SQL surgery, exactly what its own
  // docstring says the compensator exists to prevent. Checked first,
  // before the --case-file requirement below, since undo needs no
  // case-file. Dry-run by default like every other recovery verb.
  const undoRaw = parseValueFlag(args, '--undo');
  if (undoRaw !== undefined) {
    if (!runId) {
      console.error('Usage: swarm adjudicate <run-id> --undo <adjudication-id> [--apply]');
      process.exit(1);
    }
    const adjudicationId = Number(undoRaw);
    if (!Number.isInteger(adjudicationId) || adjudicationId <= 0) {
      console.error(`adjudicate --undo: <adjudication-id> must be a positive integer (got ${JSON.stringify(undoRaw)})`);
      process.exit(1);
    }
    const applyUndo = args.includes('--apply');
    const db = openDb(getDbPath());
    // F-482629a9: forward runId so undoAdjudication can refuse a cross-run
    // undo — pre-fix this was dropped on the floor here, so the required
    // <run-id> positional above enforced nothing past its own presence check.
    const undoReport = undoAdjudication(db, { adjudicationId, apply: applyUndo, runId });
    console.log(formatAdjudicationUndo(undoReport));
    return;
  }

  const caseFilePath = parseValueFlag(args, '--case-file');
  if (!runId || !caseFilePath) {
    console.error('Usage: swarm adjudicate <run-id> --case-file <path> [--jury=local|prism] [--cloud] [--format=json] [--dry-run]');
    console.error('   or: swarm adjudicate <run-id> --undo <adjudication-id> [--apply]');
    process.exit(1);
  }

  // F-a7eb2d09: parse + enum-validate EVERY flag up front, before ANY work
  // (DB open, case-file read, jury dispatch) runs — mirrors every sibling
  // verb (cmdClean, cmdStatus, cmdHistory, parseVerifyFlags). adjudicate's
  // own --jury/--cloud were already parsed here; --format was the lone
  // straggler, validated AFTER runAdjudicate — a --format typo burned the
  // entire (slow, and under --cloud BILLED) jury run and mutated the
  // control plane before the CLI_INVALID_FORMAT throw ever fired.
  const cloud = args.includes('--cloud');
  const tier = parseJuryFlag(args);
  const format = parseFormatFlag(args);
  const dryRun = args.includes('--dry-run');

  const db = openDb(getDbPath());
  const caseFile = readBoundedJson(resolve(caseFilePath));

  // Two tiers behind ONE injected boundary. `local` is the free family-diverse panel
  // (one judgment per seat). `prism` routes each seat through prism-verify per
  // criterion, adding L3/L4 WITHIN the seat — stronger evidence, but slower and more
  // abstention-prone (prism caps a call at 30s). Both default to free seats; --cloud
  // opts into the paid cloud seats on either tier.
  const seats = tier === 'prism'
    ? (cloud ? PRISM_CLOUD_SEATS : PRISM_JURY_SEATS)
    : (cloud ? DEFAULT_JURY_SEATS : LOCAL_JURY_SEATS);

  // F-fa047531: --dry-run — resolves the wave and runs the SAME fail-closed
  // neutrality gate the apply path runs first, reporting seats/tier/billing
  // WITHOUT dispatching the jury or persisting. The highest-value preview
  // in the verb set: adjudicate is the only verb that spends real money.
  if (dryRun) {
    let preview;
    try {
      preview = previewAdjudicate(db, { runId, caseFile, seats, tier, cloud });
    } catch (e) {
      if (e instanceof CaseFileNeutralityError) {
        console.error(`ADJUDICATION REFUSED: ${e.message}`);
        if (e.hint) console.error(`Hint: ${e.hint}`);
        process.exit(1);
      }
      throw e;
    }
    if (format === 'json') {
      console.log(JSON.stringify(preview, null, 2));
    } else {
      console.log(formatAdjudicationPreview(preview));
    }
    return;
  }

  const log = (m) => console.error(`  · ${m}`);
  const runJury = tier === 'prism' ? makePrismJury({ log }) : makeOllamaJury({ log });
  // F-18a5579c: run-scoped output dir, matching every other artifact-writing
  // verb — receipt (getOutputDir), persist, all four verify-*. Pre-fix this
  // was dirname(getDbPath()), the swarms/ ROOT: every run's receipts piled
  // into one flat swarms/adjudications/ dir (wave-1 receipts from every run
  // of every repo sharing one directory), un-navigable and unreachable by
  // run-scoped tooling like `swarm clean`.
  const swarmDir = getOutputDir(runId);
  console.error(`Jury tier: ${tier}${cloud ? ' (--cloud: paid seats)' : ' (free seats)'}`);

  let out;
  try {
    out = await runAdjudicate(db, { runId, caseFile, runJury, seats, swarmDir });
  } catch (e) {
    // A biasing case-file is refused before the jury runs — render it cleanly
    // (the neutrality error is handled here rather than graduated to the central
    // error table, since the verb renders it directly).
    if (e instanceof CaseFileNeutralityError) {
      console.error(`ADJUDICATION REFUSED: ${e.message}`);
      if (e.hint) console.error(`Hint: ${e.hint}`);
      process.exit(1);
    }
    throw e;
  }

  if (format === 'json') {
    console.log(JSON.stringify(
      { adjudication_id: out.adjudicationId, receipt_path: out.receiptPath, ...out.result },
      null,
      2,
    ));
  } else {
    console.log(formatAdjudication(out));
  }
  // Exit 0 ONLY on corroborate — a non-corroborate verdict is a non-zero signal
  // for CI, mirroring `swarm verify`'s pass-only-exit-0 contract. The advisory
  // nature lives in the (overridable) ADVANCE gate, not in this verb's exit code.
  process.exitCode = out.result.overall === 'corroborate' ? 0 : 1;
}

/**
 * escapeReasonForDisplay (F-fa23cc37 / F-11f0e453 / F-7c3e91a4+F-463c7179
 * wave-18) now lives in commands/lib/escape-reason.js — every reason-
 * rendering site in this package (this file's formatOverrideGroups plus the
 * `--unfreeze`/`--history` sites in cmdDomains below, history.js, status.js,
 * rewind.js, redrive.js, revalidate.js, clean-claims.js, receipt.js) routes
 * through that ONE shared helper so the escaping contract cannot drift
 * between call sites again — wave 16 hardened exactly this one call site
 * while seven near-identical siblings shipped unescaped. See that file's
 * docstring for the full escaping-contract history and the C0/C1/line-
 * separator control-byte class it now covers.
 */

/**
 * Render a promotion's `overrides` (each `{gate, reason}` — recordPromotion in
 * lib/advance.js always applies ONE --reason string to every gate an override
 * masks) as an operator-facing tag. Groups gate names sharing an IDENTICAL
 * reason into a single clause instead of repeating the reason once per gate:
 * pre-fix this rendered `o.reason` alone (dropping `.gate` entirely), so two
 * concurrently-overridden gates sharing one reason printed the SAME string
 * twice joined by the same '; ' delimiter used elsewhere to separate DISTINCT
 * items — indistinguishable from two different justifications, and with no
 * way to tell which gate either one applied to (F-51fa8e13).
 *
 * F-fa23cc37: F-51fa8e13's fix still joined `${gates.join(', ')}: ${reason}`
 * clauses with the SAME '; ' used as the reason's OWN internal punctuation —
 * a reason containing the literal substrings '; ' or ': ' (unrestricted free
 * text, no character validation) read ambiguously, indistinguishable in
 * shape from a genuine second clause. Each reason is now visually fenced in
 * double quotes (escapeReasonForDisplay), so the reason's own punctuation —
 * including a raw '"' — can never be misread as clause structure: the only
 * UNESCAPED quote in a clause is its true closing one. `--format=json`
 * (buildPromotionsJSON) is untouched by this — it stays the lossless,
 * unescaped canonical form; this escaping exists only in the text view.
 *
 * F-11f0e453: the clause-boundary escaping above stops a reason from
 * forging fake STRUCTURE within the one line this function's output gets
 * printed on. It does nothing about a reason forging an entire fake LINE —
 * that hazard lives one level below clause grammar, in whether the string
 * this function returns can itself contain a raw newline. escapeReasonForDisplay
 * now closes that gap too (see its own docstring); this function needed no
 * changes because it was already correctly delegating ALL reason-rendering
 * through that one escape seam.
 *
 * @param {Array<{gate: string, reason: string}>} overrides
 * @returns {string}
 */
function formatOverrideGroups(overrides) {
  const gatesByReason = new Map();
  for (const o of overrides) {
    if (!gatesByReason.has(o.reason)) gatesByReason.set(o.reason, []);
    gatesByReason.get(o.reason).push(o.gate);
  }
  return [...gatesByReason.entries()]
    .map(([reason, gates]) => `${gates.join(', ')}: "${escapeReasonForDisplay(reason)}"`)
    .join('; ');
}

/**
 * Identity-projection seam for `swarm advance --history --format=json`.
 * getPromotions() (lib/advance.js) already returns each promotion with
 * gates_checked/overrides/finding_snapshot parsed into real arrays/objects,
 * not JSON-string columns — this names the seam (mirroring buildCheckGatesJSON
 * / buildRunsJSON) and pins the contract that the JSON path emits the SAME
 * array the text formatter reads. Always an array, even when empty, matching
 * buildRunsJSON's `[]` contract rather than the text branch's "No promotions
 * yet." string — a scraper needs a parseable empty list. F-51fa8e13: pre-fix
 * --history had no --format=json at all, so the only way to recover which
 * gate(s) a past override named was raw SQL against promotions.overrides.
 *
 * @param {Array} promotions — the array from getPromotions()
 * @returns {Array}
 */
function buildPromotionsJSON(promotions) {
  return promotions;
}

function cmdAdvance(args) {
  const runId = args[0];
  if (!runId) {
    console.error('Usage: swarm advance <run-id> [--override --reason "..."] [--check-only] [--history] [--format=json]');
    process.exit(1);
  }

  const db = openDb(getDbPath());

  // --check-only: just show gate results. --format=json emits the structured
  // checkGates() object ({verdict,nextPhase,reason,gates[],overridable}) instead
  // of the text frame — the identity-projection seam (the object is already
  // JSON-serializable; buildCheckGatesJSON pins that the JSON path emits the
  // SAME object the text formatter consumes). parseFormatFlag enum-validates +
  // carries the `--`-swallow guard, same as the status/runs sites.
  if (args.includes('--check-only')) {
    const format = parseFormatFlag(args);
    const result = checkGates(db, runId);
    if (format === 'json') {
      console.log(JSON.stringify(buildCheckGatesJSON(result), null, 2));
      return;
    }
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

  // --history: show promotion history. --format=json emits the getPromotions()
  // array as-is (buildPromotionsJSON) instead of the text table — see that
  // function's docstring and F-51fa8e13 for why this branch previously had no
  // machine-readable escape hatch.
  if (args.includes('--history')) {
    const format = parseFormatFlag(args);
    const promotions = getPromotions(db, runId);
    if (format === 'json') {
      console.log(JSON.stringify(buildPromotionsJSON(promotions), null, 2));
      return;
    }
    if (promotions.length === 0) {
      console.log('No promotions yet.');
      return;
    }
    console.log('Promotion history:');
    for (const p of promotions) {
      const gates = p.gates_checked.filter(g => g.passed).length;
      const total = p.gates_checked.length;
      // F-51fa8e13: name WHICH gate(s) each override reason consented to —
      // pre-fix this rendered `o.reason` alone, discarding `o.gate` entirely.
      const override = p.overrides ? ` [OVERRIDE: ${formatOverrideGroups(p.overrides)}]` : '';
      console.log(`  ${p.created_at} | ${p.from_phase} → ${p.to_phase} | ${gates}/${total} gates | ${p.authorized_by}${override}`);
    }
    return;
  }

  const override = args.includes('--override');
  // d5-swarm-cli-004 sibling (Stage A re-audit): route --reason through the shared
  // parseValueFlag so this site has the same equals-form (`--reason=text`) +
  // space-form + `--`-swallow handling as the revalidate/rewind/redrive --reason
  // sites. The pre-fix bare indexOf matched only the space-form token, so
  // `--override --reason=text` was missed and the override wrongly refused despite
  // a reason being supplied; a `--`-prefixed value was also (correctly) treated as
  // the next flag — parseValueFlag preserves that guard.
  const overrideReason = parseValueFlag(args, '--reason');

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
    // F-0a888394: an operator who just typed `--override --reason '...'` must
    // see, in this SAME terminal output, exactly which named gates their
    // reason consented to overriding — not just that promotion happened.
    // Pre-fix this Gates breakdown only rendered in the BLOCKED/AMEND branch
    // below; the override-ADVANCE path's gatesChecked (with `overridden: true`
    // on the masked gates, set by the F-f33081a2 fix) was computed and
    // durably recorded in promotions.gates_checked/overrides but never echoed
    // here — recoverable only via a second `swarm advance <run> --history`
    // call the operator has no prompt to run. Mirrors the BLOCKED branch's
    // per-gate PASS/FAIL line below and adds the `overridden` tag the
    // override path uniquely produces, so finding_severity's deliberate
    // exclusion from an amend-reroute override (F-f33081a2) is visible at
    // the moment of action, not just on a follow-up --history query.
    if (result.gates && result.gates.length > 0) {
      console.log('Gates:');
      for (const g of result.gates) {
        const overrideTag = g.overridden ? ' [OVERRIDDEN]' : '';
        console.log(`  [${g.passed ? 'PASS' : 'FAIL'}] ${g.name} — ${g.reason}${overrideTag}`);
      }
      console.log('');
    }
    console.log(`Next: swarm dispatch ${runId} ${result.toPhase}`);
  } else {
    console.log(`BLOCKED: ${result.verdict}`);
    if (result.reason) console.log(`Reason: ${result.reason}`);
    // F-1c0188c9: an operator who explicitly passed --override and expected
    // promotion must see that their override was honored-then-refused because a
    // non-overridable gate outranked it — not the same BLOCKED an operator who
    // never attempted an override sees. advance() marks the refusal; surface it.
    if (result.overrideRefused) {
      const gates = (result.refusedBy || []).join(', ') || 'a gate';
      console.log(`Override refused — ${gates} is non-overridable; the block stands.`);
    }
    console.log('');
    console.log('Gates:');
    for (const g of (result.gates || [])) {
      console.log(`  [${g.passed ? 'PASS' : 'FAIL'}] ${g.name} — ${g.reason}`);
    }
    if (result.verdict === 'AMEND') {
      console.log(`\nNext: swarm approve ${args[0]} --all && swarm dispatch ${args[0]} ${result.nextPhase}`);
    }
    // advance-exit-0: a HARD block must surface as a non-zero exit so a scripted
    // `swarm advance <run> && swarm dispatch <run> <next>` halts instead of
    // proceeding past the block — matching cmdVerify (cli-p-002) and cmdResume
    // (B002). BLOCK / VERIFY, and a refused override (a non-overridable gate
    // outranked --override), are hard failures. AMEND is an actionable next-step
    // verdict, not a failure, and stays at exit 0.
    if (result.verdict === 'BLOCK' || result.verdict === 'VERIFY' || result.overrideRefused) {
      process.exit(1);
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
  // d5-swarm-cli-004 (Stage A): route `--ids` through the shared value-flag
  // parser so `--ids=F-001,F-002` (equals-form) works like every sibling flag,
  // and a swallowed `--ids --reason` is treated as missing (→ the "Specify
  // --all or --ids" guard fires) rather than capturing the following flag as a
  // finding id.
  const idsArg = parseValueFlag(args, '--ids');
  const ids = idsArg ? idsArg.split(',').map(s => s.trim()).filter(Boolean) : [];

  if (!approveAll && ids.length === 0) {
    console.error('Specify --all or --ids F-001,F-002');
    process.exit(1);
  }

  // F-ad540b83: `--ids` matches findings.finding_id CASE-INSENSITIVELY
  // (UPPER() on both sides, not just lower-casing the input — a legacy or
  // test-seeded finding_id is not guaranteed lowercase, only the canonical
  // `F-${fingerprint.slice(0,8)}` mint shape is). The canonical id is always
  // lowercase hex (lib/fingerprint.js), but an operator retyping or pasting
  // it should not be tripped by casing, the same way a git short-hash
  // comparison would not be.
  const idsUpper = ids.map(s => s.toUpperCase());

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
        `SELECT id FROM findings WHERE run_id = ? AND UPPER(finding_id) IN (${idsUpper.map(() => '?').join(',')}) AND status IN ('new', 'recurring')`
      );

  const insertEvent = db.prepare(
    "INSERT INTO finding_events (finding_id, event_type, notes) VALUES (?, 'approved', 'bulk approve')"
  );

  let changes = 0;
  const tx = db.transaction(() => {
    const pending = approveAll
      ? selectPending.all(runId)
      : selectPending.all(runId, ...idsUpper);

    let updated;
    if (approveAll) {
      updated = db.prepare(
        "UPDATE findings SET status = 'approved' WHERE run_id = ? AND status IN ('new', 'recurring')"
      ).run(runId);
    } else {
      const placeholders = idsUpper.map(() => '?').join(',');
      updated = db.prepare(
        `UPDATE findings SET status = 'approved' WHERE run_id = ? AND UPPER(finding_id) IN (${placeholders}) AND status IN ('new', 'recurring')`
      ).run(runId, ...idsUpper);
    }

    for (const f of pending) insertEvent.run(f.id);
    return updated.changes;
  });

  changes = tx();

  // F-ad540b83: refuse loudly when NONE of the supplied --ids exist in this
  // run's findings AT ALL — the exact shape of pasting a `swarm findings`
  // digest's agent-local id (a disjoint namespace: computeFingerprint's
  // F-<8 hex> minted at collect() time, never the raw agent-authored `id`
  // field pre-fix) into --ids. Pre-fix this printed the textually-identical
  // "Approved 0 findings" a legitimate no-op prints, at exit 0 — no signal
  // an operator could act on. An id that EXISTS but is simply not currently
  // open (already approved/deferred/rejected/fixed) is a DIFFERENT, benign
  // case — re-approving an already-approved finding is intentionally
  // idempotent (cli-002) and must keep exiting 0 with its own "Approved 0"
  // line, so this check is existence, not open-match. --all matching zero
  // (nothing pending) is a normal, expected state and is never refused.
  if (!approveAll && changes === 0) {
    refuseIfNoIdsExist(db, runId, ids, idsUpper);
  }

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
    // F-bf28b667 (wave 20) class-completion: result.dogfood.reason is the
    // SAME value commands/persist.js's formatPersist now escapes (see that
    // file's "Ingested: NO" line) — this is cmdPersist's own SEPARATE
    // render of it on the exit-1 error path. A local execFileSync
    // child-process error message can legitimately be multi-line (see
    // persist.js); escaping only the summary render and leaving this error
    // render bare would repeat the single-instance-patch shape this wave
    // exists to close.
    console.error(`ERROR [INGEST_FAILED]: dogfood ingest did not complete — ${escapeReasonForDisplay(result.dogfood.reason)}`);
    if (result.artifacts?.dogfoodSubmission) {
      console.error(`  Submission: ${result.artifacts.dogfoodSubmission}`);
      console.error(`  Reproduce:  node "<repo>/packages/ingest/run.js" --provenance=stub --file "${result.artifacts.dogfoodSubmission}"`);
    }
    process.exit(1);
  }
}

/**
 * F-ad540b83: shared zero-match refusal for the three targeted (--ids)
 * finding-disposition verbs (`approve --ids`, `defer`, `reject`). Fires
 * ONLY when NONE of the supplied ids exist in this run's
 * findings.finding_id AT ALL — not when they exist but simply are not
 * currently open (that is the ordinary, intentionally idempotent no-op the
 * cli-002 / wave12-swarm-cp-pins defer-idempotency pins already cover: a
 * re-run naming an already-terminal but genuinely-canonical id must keep
 * exiting 0). Pre-fix, both cases printed the identical "N findings" (N=0)
 * line at exit 0 — indistinguishable from "you asked to flip 0 findings on
 * purpose". The proven-live harm this closes is specifically the id-
 * namespace confusion: pasting a `swarm findings` digest's agent-local id
 * (disjoint from findings.finding_id, minted by computeFingerprint at
 * collect() time) into --ids.
 *
 * `idsUpper` must already be upper-cased by the caller (mirrors the
 * UPPER(finding_id) comparison the caller's own SELECT/UPDATE used) so the
 * existence probe agrees with the case-insensitive match that already ran.
 */
function refuseIfNoIdsExist(db, runId, ids, idsUpper) {
  const existing = db.prepare(
    `SELECT COUNT(*) as cnt FROM findings WHERE run_id = ? AND UPPER(finding_id) IN (${idsUpper.map(() => '?').join(',')})`
  ).get(runId, ...idsUpper).cnt;
  if (existing > 0) return;

  console.error(
    `ERROR [CLI_FINDINGS_ID_NO_MATCH]: 0 of ${ids.length} --ids value(s) matched any finding in run ${runId}.`
  );
  console.error(
    '  Next: findings.finding_id is the canonical id (e.g. F-c63c7498) minted by `swarm collect` — not the ' +
    'agent-local `id` a not-yet-collected `swarm findings` digest may still be showing from raw output.json. ' +
    // F-1d972160: this used to also suggest `swarm status --format=json` —
    // proven live to be a dead end: status()'s findings block (commands/
    // status.js) is aggregate COUNTS only (total/bySeverity/byStatus/open/
    // thisWave) and never emits an individual finding_id, in text or JSON,
    // under any run state. `swarm findings --format=json` is the real
    // remedy: its `id` field is annotateCanonicalFindingIds' best-effort
    // resolution to the DB-canonical finding_id (see that function's doc
    // comment), which now also tolerates a drifted line for a recurring
    // finding (widened by this same fix) — so the common case this hint
    // exists for actually resolves, not just the first-seen-this-wave case.
    `Run \`swarm findings ${runId} --format=json\` (after collect) — its \`id\` field resolves to the real ` +
    'finding_id whenever the match is unambiguous.'
  );
  process.exit(1);
}

/**
 * F-SWARMCP-001 / F-SWARMCP-002: shared core for the two terminal-disposition
 * verbs `swarm defer` and `swarm reject`. Both take a targeted `--ids` set plus
 * a MANDATORY `--reason` and flip the named findings to a terminal status,
 * writing one reason-bearing finding_events row per finding actually moved.
 *
 * These are STANDALONE verbs, deliberately NOT disposition flags on
 * `swarm approve` — the honesty pin (wave8-approve-disposition-honesty.test.js)
 * requires cmdApprove to stay disposition-flag-free and every operator hint to
 * name the standalone `swarm defer` / `swarm reject` verbs.
 *
 * `deferred`/`rejected` are already canonical (STATUS.finding / finding_event)
 * and already CLOSED (finding-status.js) + terminal in classifyFindings, so
 * this is purely the lawful WRITE path onto that existing foundation.
 *
 * Only OPEN rows (new/recurring/approved/unverified) are captured and flipped;
 * rows already in a terminal state are skipped, so a re-run is idempotent — no
 * duplicate event, matching cmdApprove's capture-before-update discipline
 * (Stripe Ledger pattern: the audit row lands in the same transaction as the
 * UPDATE).
 *
 * @param {string} verb — 'defer' | 'reject'
 * @param {string} status — 'deferred' | 'rejected'
 * @param {string} label — 'Deferred' | 'Rejected' (stdout verb)
 * @param {string[]} args
 */
function disposeFindings(verb, status, label, args) {
  const runId = args[0];
  if (!runId) {
    console.error(`Usage: swarm ${verb} <run-id> --ids F-001,F-002 --reason "<text>"`);
    process.exit(1);
  }

  // Same shared value-flag parser as cmdApprove: equals-form, space-form, and
  // the `--`-swallow guard (a swallowed `--ids --reason` reads as missing).
  const idsArg = parseValueFlag(args, '--ids');
  const ids = idsArg ? idsArg.split(',').map(s => s.trim()).filter(Boolean) : [];

  if (ids.length === 0) {
    console.error('Specify --ids F-001,F-002 (defer/reject are targeted — there is no --all)');
    process.exit(1);
  }

  const reason = parseValueFlag(args, '--reason');
  if (!reason || !reason.trim()) {
    console.error(`${verb}: --reason "<text>" is required (non-empty)`);
    process.exit(1);
  }

  const db = openDb(getDbPath());

  // F-ad540b83: same case-insensitive UPPER(finding_id) matching as
  // cmdApprove — see that call site's comment for the rationale.
  const idsUpper = ids.map(s => s.toUpperCase());
  const placeholders = idsUpper.map(() => '?').join(',');
  // Open statuses only — terminal fixed/deferred/rejected are skipped so the
  // flip is idempotent and never re-events an already-disposed finding.
  const selectOpen = db.prepare(
    `SELECT id FROM findings WHERE run_id = ? AND UPPER(finding_id) IN (${placeholders}) ` +
    `AND status IN ('new', 'recurring', 'approved', 'unverified')`
  );
  const update = db.prepare(
    `UPDATE findings SET status = ? WHERE run_id = ? AND UPPER(finding_id) IN (${placeholders}) ` +
    `AND status IN ('new', 'recurring', 'approved', 'unverified')`
  );
  const insertEvent = db.prepare(
    `INSERT INTO finding_events (finding_id, event_type, notes) VALUES (?, ?, ?)`
  );

  const tx = db.transaction(() => {
    const pending = selectOpen.all(runId, ...idsUpper);
    const updated = update.run(status, runId, ...idsUpper);
    for (const f of pending) insertEvent.run(f.id, status, reason);
    return updated.changes;
  });

  const changes = tx();

  // F-ad540b83: existence-based zero-match refusal — see
  // refuseIfNoIdsExist's doc comment. defer/reject have no --all path, so
  // (unlike cmdApprove) every call reaches this check when changes === 0.
  if (changes === 0) {
    refuseIfNoIdsExist(db, runId, ids, idsUpper);
  }

  console.log(`${label} ${changes} findings for ${runId}`);
}

function cmdDefer(args) {
  disposeFindings('defer', 'deferred', 'Deferred', args);
}

function cmdReject(args) {
  disposeFindings('reject', 'rejected', 'Rejected', args);
}

/**
 * F-ad540b83 (half 1/2): best-effort resolution of each digest finding's
 * DB-canonical `finding_id`, so an id an operator copies from `swarm
 * findings` output actually matches `swarm approve/defer/reject --ids`
 * (which key ONLY on findings.finding_id — the fingerprint-derived id
 * minted at collect() time, lib/fingerprint.js:672 — a namespace completely
 * disjoint from the agent's own `id` field this digest otherwise renders
 * straight off output.json).
 *
 * Resolution is by EXACT field-equality against this run+wave's collected
 * DB rows (file_path/line_number/symbol/category/severity — the same raw
 * fields upsertFindings() persists verbatim off the identical output.json
 * this digest reads, lib/fingerprint.js:671-677), NOT by recomputing the
 * fingerprint hash. Recomputing would risk silently diverging from whatever
 * sourceText collect() actually hashed against at collect time (fp-p-005:
 * the fingerprint folds in a source-context hash this function has no
 * access to and must not guess at) — a WRONG resolved id would be worse
 * than none. `description` is deliberately excluded from the match tuple:
 * B-BACK-002's contract (d3b-006-finding-id-collision.test.js) is that
 * description is NOT part of a finding's identity, and a RECURRING row's
 * description stays frozen at its first-seen wording (upsertFindings'
 * updateRecurring only bumps status/last_seen_wave) while the current
 * wave's raw output.json may have reworded it — comparing description
 * would false-negative on exactly the recurring findings this is meant to
 * help with.
 *
 * Fails CLOSED, never wrong: a wave not yet collected has no DB rows to
 * match against (findings keep their plain agent-local id — today's
 * behavior, unchanged) and a field tuple shared by more than one DB row (a
 * true duplicate — the rare case disambiguateFingerprints exists for)
 * resolves to nothing rather than guessing. A `new` finding (first reported
 * THIS wave) always matches the full 5-field tuple exactly, because the DB
 * row was inserted THIS SAME collect() from THIS SAME output.json — zero
 * drift is possible for that case.
 *
 * F-1d972160: a RECURRING finding's file/line/symbol CAN drift off its
 * collect-time row — plausible whenever a nearby edit shifts a line number
 * — and updateRecurring (lib/fingerprint.js) only ever bumps status/
 * last_seen_wave, never the location columns, so the drift is permanent,
 * not transient. Pre-fix the 5-field tuple then missed FOREVER and the
 * operator was permanently stranded on the agent-local id with no CLI verb
 * anywhere able to supply the real one (the zero-match refusal's own hint,
 * just above this function's call site, names the dead end this caused).
 * A second, line-DROPPED index (file/symbol/category/severity) is now
 * tried as a fallback — ONLY when the full tuple found zero rows (an
 * ambiguous full-tuple match is not widened further; widening can only
 * ever grow the candidate set) — and ONLY resolves when that narrower
 * tuple is still unambiguous. Same fails-CLOSED contract as the primary
 * match: a ghost id is worse than none, so two-or-more rows sharing
 * (file, symbol, category, severity) resolve to nothing, same as today.
 */
function annotateCanonicalFindingIds(model, { runId, waveNumber, dbPath }) {
  if (!model.findings || model.findings.length === 0) return;

  let db;
  try {
    db = openDb(dbPath);
  } catch {
    return; // control plane unreachable — leave agent-local ids as-is.
  }

  const wave = db.prepare('SELECT id FROM waves WHERE run_id = ? AND wave_number = ?').get(runId, waveNumber);
  if (!wave) return; // this run/wave was never dispatched through THIS control plane.

  const rows = db.prepare(
    'SELECT finding_id, file_path, line_number, symbol, category, severity FROM findings WHERE run_id = ? AND last_seen_wave = ?'
  ).all(runId, wave.id);
  if (rows.length === 0) return;

  const tupleKey = (file, line, symbol, category, severity) =>
    JSON.stringify([file ?? null, line ?? null, symbol ?? null, category ?? null, severity ?? null]);
  const driftedLineKey = (file, symbol, category, severity) =>
    JSON.stringify([file ?? null, symbol ?? null, category ?? null, severity ?? null]);

  const byTuple = new Map();
  const byTupleDriftedLine = new Map();
  for (const r of rows) {
    const key = tupleKey(r.file_path, r.line_number, r.symbol, r.category, r.severity);
    const bucket = byTuple.get(key);
    if (bucket) bucket.push(r); else byTuple.set(key, [r]);

    const looseKey = driftedLineKey(r.file_path, r.symbol, r.category, r.severity);
    const looseBucket = byTupleDriftedLine.get(looseKey);
    if (looseBucket) looseBucket.push(r); else byTupleDriftedLine.set(looseKey, [r]);
  }

  for (const f of model.findings) {
    const file = f.file || null;
    const symbol = f.symbol || null;
    const category = f.category || null;
    const severity = String(f.severity || '').toUpperCase() || null;

    const key = tupleKey(file, f.line || null, symbol, category, severity);
    const bucket = byTuple.get(key);
    if (bucket && bucket.length === 1) {
      f.id = bucket[0].finding_id;
      continue;
    }
    if (bucket) continue; // ambiguous even with line included — do not widen.

    const looseKey = driftedLineKey(file, symbol, category, severity);
    const looseBucket = byTupleDriftedLine.get(looseKey);
    if (looseBucket && looseBucket.length === 1) {
      f.id = looseBucket[0].finding_id;
    }
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
  // d5-swarm-cli-003 (Stage A): same enum-validate + `--`-swallow guard as
  // parseVerifyFlags — the space-form `--format` here previously took the next
  // token raw, silently emitting a DIFFERENT format than requested (or
  // swallowing a following flag). parseFormatFlag closes both gaps.
  const format = parseFormatFlag(args.slice(1));

  // F-19f86582: resolve digest artifacts relative to the ACTIVE control
  // plane (dirname(getDbPath())) — mirrors cmdCollect's --all
  // auto-discovery (swarmDir: dirname(getDbPath()), cmdCollect's --all branch) and
  // getOutputDir's identical derivation. Pre-fix, this was the ONE
  // output-consuming verb that skipped the seam: buildDigest's own
  // SWARMS_DIR default (lib/findings-digest.js) is always this installed
  // package's build-relative swarms/ dir, independent of SWARM_DB — so a
  // run collected against a relocated SWARM_DB was invisible here even
  // though `swarm collect --all` under the identical SWARM_DB found the
  // same run's artifacts fine.
  //
  // The directory-resolution logic below is buildDigest's own
  // (lib/findings-digest.js:279-288, findLatestWave), reimplemented here —
  // not wrapped — so the "Run/Wave/no-waves directory not found" throws can
  // carry a `.code` + `.hint`. That file lives under this package's lib
  // directory, swarm-cp-core's domain, not this one's, so the type is
  // attached at this call site instead of editing it. Everything past
  // directory resolution (parsing, counting, sorting, rendering) still goes
  // through the shared, UNMODIFIED buildDigestModel/renderDigest exports —
  // no business logic is duplicated, only the directory-existence checks.
  const swarmsDir = dirname(getDbPath());
  const runDir = join(swarmsDir, runId);
  if (!existsSync(runDir)) {
    const e = new Error(`Run directory not found: ${runDir}`);
    e.code = 'FINDINGS_RUN_DIR_NOT_FOUND';
    e.runId = runId;
    e.hint = `swarm findings looks for this run's artifacts under ${swarmsDir} (dirname of $SWARM_DB, ` +
      `or the default swarms/ dir when SWARM_DB is unset) — confirm SWARM_DB matches whatever \`swarm collect\` ` +
      `used for this run`;
    throw e;
  }

  let waveNumber;
  if (waveArg) {
    waveNumber = parseInt(waveArg, 10);
  } else {
    try {
      waveNumber = findLatestWave(runDir);
    } catch (e) {
      if (!e.code) {
        e.code = 'FINDINGS_NO_WAVES_FOUND';
        e.runId = runId;
        e.hint = `no wave-N directories exist under ${runDir} — confirm SWARM_DB (${swarmsDir}) matches ` +
          `whatever \`swarm collect\`/\`swarm dispatch\` used for this run`;
      }
      throw e;
    }
  }

  const waveDir = join(runDir, `wave-${waveNumber}`);
  if (!existsSync(waveDir)) {
    const e = new Error(`Wave directory not found: ${waveDir}`);
    e.code = 'FINDINGS_WAVE_DIR_NOT_FOUND';
    e.runId = runId;
    e.hint = `wave ${waveNumber} has no artifacts under ${runDir} — run \`swarm status ${runId}\` to see which ` +
      `wave numbers exist under this SWARM_DB`;
    throw e;
  }

  const outputs = loadDomainOutputs(waveDir);
  const model = buildDigestModel(runId, waveNumber, outputs);
  annotateCanonicalFindingIds(model, { runId, waveNumber, dbPath: getDbPath() });
  const output = renderDigest(model, format, process.stdout);

  console.log(output);
  // F-091578-034 — exit codes propagate the 3-way digest state so CI gates
  // can distinguish clean (0), findings-present (1), and audit-pipeline-broken
  // (2). Operator using `swarm findings` as a CI gate needs the machine
  // signal AND the visual signal, not just the visual.
  //
  // F-5dabf101: process.exitCode, not process.exit() — the console.log(output)
  // above renders the full findings text/markdown/JSON, exactly the
  // large-payload case the finding names; truncation risk is identical to the
  // four verify-* siblings.
  process.exitCode = model.exitCode;
}

/**
 * F4-CP-02: build the per-run rollup array `swarm runs` displays, as a stable
 * JSON-serializable shape. cmdRuns previously only printed the text listing;
 * this is the named seam the JSON path emits so the listing has a machine
 * surface. Field names mirror the structured camelCase convention used by
 * status() (`waveCount` / `findingCount`) rather than the SQL snake_case, so a
 * consumer reading `swarm status --format=json` and `swarm runs --format=json`
 * sees one naming convention.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ id, repo, status, branch, waveCount, findingCount, created }>}
 */
function buildRunsJSON(db) {
  const runs = db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all();
  const waveStmt = db.prepare('SELECT COUNT(*) as cnt FROM waves WHERE run_id = ?');
  const findStmt = db.prepare('SELECT COUNT(*) as cnt FROM findings WHERE run_id = ?');
  return runs.map(r => ({
    id: r.id,
    repo: r.repo,
    status: r.status,
    branch: r.branch,
    waveCount: waveStmt.get(r.id).cnt,
    findingCount: findStmt.get(r.id).cnt,
    created: r.created_at,
  }));
}

function cmdRuns(args = []) {
  const db = openDb(getDbPath());

  // F4-CP-02: --format=json emits the per-run rollup as a JSON array (always
  // an array, even when empty — `[]` rather than the human "No runs found."
  // text, so a scraper gets a parseable empty list). parseFormatFlag enum-
  // validates + carries the `--`-swallow guard. Default stays text. status is
  // informational so the exit code is unchanged.
  const format = parseFormatFlag(args);
  if (format === 'json') {
    console.log(JSON.stringify(buildRunsJSON(db), null, 2));
    return;
  }

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

/**
 * F4-CP-01: the valid `--query` modes for `swarm trends`.
 */
const TRENDS_QUERIES = ['recurring', 'history', 'recurrence'];

/**
 * F4-CP-01 — `swarm trends --query <recurring|history|recurrence>`.
 *
 * The first cross-run-scoped verb. Every other verb is single-runId scoped,
 * but the DB persists cross-run signal (content-addressed fingerprints under
 * UNIQUE(run_id, fingerprint); per-run wave/finding rollups). This verb routes
 * to the pure read fns in lib/queries/cross-run-analytics.js and renders text
 * (default) or JSON (--format json, via the shared parseFormatFlag enum
 * guard).
 *
 *   recurring   — fingerprints seen in > 1 run
 *   history     — per-run rollup, newest first (optional --repo LIKE filter)
 *   recurrence  — recurrence-rate stats (optional --window-days trailing window)
 *
 * Informational verb → exit 0 on success; an unknown --query / out-of-enum
 * --format fail loud with exit 1 (the same fail-loud-on-bad-flag posture as
 * the verify-* family).
 */
function cmdTrends(args) {
  const query = parseValueFlag(args, '--query');
  if (!query) {
    console.error('Usage: swarm trends --query <recurring|history|recurrence> [--format=text|json]');
    console.error('                    [--repo <substring>]    (history only)');
    console.error('                    [--window-days N]       (recurrence only)');
    process.exit(1);
  }
  if (!TRENDS_QUERIES.includes(query)) {
    console.error(`swarm trends: --query expects one of ${TRENDS_QUERIES.join('|')}; got '${query}'`);
    process.exit(1);
  }

  // Shared --format enum guard (throws CLI_INVALID_FORMAT on a bad value,
  // rejects a swallowed following flag). Default undefined → text.
  const format = parseFormatFlag(args);

  const db = openDb(getDbPath());

  let payload;
  if (query === 'recurring') {
    payload = queryRecurringFindings(db);
  } else if (query === 'history') {
    const repoPattern = parseValueFlag(args, '--repo');
    payload = queryPerRepoRunHistory(db, repoPattern);
  } else {
    // recurrence
    const windowRaw = parseValueFlag(args, '--window-days');
    let windowDays;
    if (windowRaw !== undefined) {
      const n = parseInt(windowRaw, 10);
      if (!/^\d+$/.test(String(windowRaw).trim()) || !Number.isFinite(n) || n < 0) {
        console.error(`swarm trends: --window-days expects a non-negative integer; got '${windowRaw}'`);
        process.exit(1);
      }
      windowDays = n;
    }
    payload = queryFindingRecurrenceRate(db, windowDays);
  }

  if (format === 'json') {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(formatTrends(query, payload));
}

/**
 * F4-CP-01: human-readable text rendering for the three trends queries.
 * Mirrors the scan-first plain-ASCII posture of formatStatus / the runs
 * listing — no color, renders identically under CI plaintext logs.
 */
function formatTrends(query, payload) {
  const lines = [];
  if (query === 'recurring') {
    lines.push('Recurring findings (seen in more than one run):');
    lines.push('');
    if (payload.length === 0) {
      lines.push('  (none — no fingerprint has recurred across runs)');
    } else {
      for (const r of payload) {
        lines.push(`  [${r.severity}] ${r.fingerprint} — ${r.run_count} runs`);
        lines.push(`    ${r.description}`);
        lines.push(`    first seen ${r.first_seen} · last seen ${r.last_seen}`);
        lines.push('');
      }
    }
  } else if (query === 'history') {
    lines.push('Per-run history (newest first):');
    lines.push('');
    if (payload.length === 0) {
      lines.push('  (no runs match)');
    } else {
      for (const r of payload) {
        lines.push(`  ${r.run_id}  [${r.status}]`);
        lines.push(`    ${r.repo} — ${r.wave_count} waves, ${r.finding_count} findings`);
        lines.push(`    created ${r.created_at}`);
        lines.push('');
      }
    }
  } else {
    // recurrence
    const pct = (payload.recurrence_rate * 100).toFixed(1);
    lines.push('Finding recurrence rate:');
    lines.push('');
    lines.push(`  Runs considered:        ${payload.total_runs}${payload.window_days != null ? ` (last ${payload.window_days} days)` : ''}`);
    lines.push(`  Distinct fingerprints:  ${payload.distinct_fingerprints}`);
    lines.push(`  Recurring (> 1 run):    ${payload.recurring_fingerprints}`);
    lines.push(`  Recurrence rate:        ${pct}%`);
  }
  return lines.join('\n');
}

// ── Dispatch ──

const commands = {
  init: cmdInit,
  domains: cmdDomains,
  dispatch: cmdDispatch,
  collect: cmdCollect,
  doctor: cmdDoctor,
  revalidate: cmdRevalidate,
  rewind: cmdRewind,
  redrive: cmdRedrive,
  clean: cmdClean,
  'clean-claims': cmdCleanClaims,
  verify: cmdVerify,
  'verify-fixed': cmdVerifyFixed,
  'verify-recurring': cmdVerifyRecurring,
  'verify-unverified': cmdVerifyUnverified,
  'verify-approved': cmdVerifyApproved,
  receipt: cmdReceipt,
  advance: cmdAdvance,
  adjudicate: cmdAdjudicate,
  status: cmdStatus,
  resume: cmdResume,
  history: cmdHistory,
  approve: cmdApprove,
  defer: cmdDefer,
  reject: cmdReject,
  persist: cmdPersist,
  findings: cmdFindings,
  runs: cmdRuns,
  trends: cmdTrends,
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
                             Flags: --auto-freeze, --isolate, --skip-verify,
                             --dry-run (alias --preview)
                             --isolate: give each agent its own git worktree so
                             its edits are independently attributable (collect
                             diffs the agent's branch, not just self-reported
                             files_changed). This is the remediation for the
                             OWNERSHIP PROBE DEGRADED banner: a non-isolated
                             multi-domain amend wave cannot independently catch a
                             cross-domain write, so re-dispatch with --isolate to
                             restore full cross-domain ownership attribution.
                             Requires git (see swarm doctor's git-available
                             check).
                             --dry-run: preview the wave shape (which domains
                             become agents, the prompt paths that WOULD be
                             written, amend-phase approved-finding routing
                             counts, and under --isolate the worktrees that
                             WOULD be created) with NO control-plane write, file
                             write, or worktree creation.
                             --skip-verify (amend phases): append the parallel-
                             wave directive to amend prompts so agents skip
                             per-agent npm test. Coordinator runs one serial
                             verify after 'swarm collect' instead. Eliminates
                             cumulative-tree measurement artifacts when N
                             agents run verify concurrently. PROTOCOL.md
                             §Serial final verification.
  collect <run-id> [opts]    Validate, enforce ownership, merge
                             --all: auto-discover the latest dispatched wave's
                             agent outputs from the deterministic layout
                             (swarms/<run>/wave-N/<domain>/output.json) instead
                             of hand-typing one --domain=name:path per agent. A
                             domain whose output file is missing is a non-fatal
                             warning; collect proceeds with the present ones.
                             --all and --domain are mutually exclusive (an
                             explicit --domain overrides --all).
  doctor                     Preflight environment checks (read-only). Verifies
                             Node >= 22, the control-plane dir is writable +
                             hardlink-capable (the file-lock CAS needs link(2);
                             exFAT/FAT32 fail), and the on-disk control-plane.db
                             schema is not newer than this build. Structured
                             pass/warn/fail report; exits non-zero only on a
                             hard FAIL (warns exit 0). No run-id required.
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
  clean <run-id> [opts]      Reclaim stranded --isolate worktrees + swarm
                             branches for a run (the residue of a run abandoned/
                             rewound/interrupted before its complete teardown).
                             Run-scoped (not repo-wide). Dry-run by default;
                             --apply removes. Reports a {removed, stranded,
                             total} rollup. --format=text|json.
  clean-claims <run-id> [opts]
                             Delete phantom violation=1 file_claims rows
                             stranded on TERMINAL waves (advanced /
                             aborted_for_rewind) — rows no lawful verb can
                             revisit (collect: wave not dispatched; revalidate:
                             agents not blocked on the latest wave; redrive:
                             terminal waves refused). Claims are what a pass
                             OBSERVED, not audit events — the agent_state_events
                             trail is never touched. Dry-run by default (lists
                             rows + the superseding state-event evidence);
                             --apply --reason "<text>" deletes, writing one
                             restorable domain_events audit row per domain.
                             --wave=N / --agent-run=ID narrow scope; refusals
                             name the verb that still owns the row.
                             --format=text|json.
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
  receipt <run-id> [wave] [--format=json]
                             Export durable wave receipt (JSON + markdown).
                             --format=json emits the receipt object to stdout
                             (pure JSON; the disk artifacts still write).
  advance <run-id> [opts]    Check gates and advance to next phase.
                             advance --check-only --format=json emits the
                             checkGates() {verdict,nextPhase,reason,gates[],
                             overridable} object for machine consumers.
                             advance --history [--format=json] lists past
                             promotions; each [OVERRIDE: ...] tag now names
                             the gate(s) its reason consented to, and
                             --format=json emits the full getPromotions()
                             array (gates_checked/overrides included) with
                             no raw SQL needed.
  adjudicate <run-id> --case-file <path> [--jury=local|prism] [--cloud] [--format=json] [--dry-run]
                             Dispatch a case-file to the cross-family jury and
                             record the advisory verdict on the current wave (the
                             checkAdjudication gate reads it). Free local panel by
                             default; --cloud opts into paid gpt-oss/glm seats.
                             --jury=prism routes each seat through prism-verify per
                             criterion, adding decorrelated multi-lens +
                             submodularity within a seat: stronger evidence, but
                             slower and more abstention-prone (prism caps a call at
                             30s). Needs prism-verify importable by python
                             (PRISM_PYTHON overrides the interpreter).
                             --dry-run: resolve the wave, run the neutrality gate,
                             and print seats/tier/billing WITHOUT dispatching the
                             jury or persisting — adjudicate is the only verb that
                             spends real money, so preview before you pay.
  adjudicate <run-id> --undo <adjudication-id> [--apply]
                             Compensator: remove a persisted adjudication row so
                             a mis-run or superseded verdict can be rolled back
                             without raw SQL. Dry-run by default; the gate then
                             falls back to the prior adjudication for the wave
                             (or none). The full receipt artifact on disk is left
                             in place — only the gate-readable summary row goes.
  persist <run-id> [opts]    Export canonical truth to downstream systems
  status <run-id> [--format=text|json]
                             Control plane status. --format=json emits the
                             structured status object (run/waves/agents/
                             findings/assessment) for machine consumers;
                             default is the text frame.
  resume <run-id> [--force]  Redispatch incomplete agents. --force: proceed
                             even when a redispatch candidate's --isolate
                             worktree has uncommitted/unmerged work that
                             recreation would destroy (default: refuse and
                             name the at-risk worktree(s); no undo once
                             --force accepts the loss).
  history <wave-id> [--format=text|json]
                             Render the wave_state_events transition chain for
                             a wave. Deep audit verb for the override-and-reason
                             record written by \`swarm revalidate --apply\` (and
                             any future override-bearing transition). \`swarm
                             status\` surfaces a one-line breadcrumb pointing at
                             this verb when the wave has interesting history.
                             --format=json emits the {waveId,wave,events} report.
  approve <run-id> [opts]    Approve findings for amend (--all | --ids). To
                             DISPOSE of a finding without a fix, use the
                             standalone \`swarm defer\` / \`swarm reject\` verbs.
  defer <run-id> --ids F-001,F-002 --reason "<text>"
                             Mark targeted findings 'deferred' (consciously
                             accepted/postponed — closed for the gate). --ids
                             and --reason both required; no --all. Idempotent.
  reject <run-id> --ids F-001,F-002 --reason "<text>"
                             Mark targeted findings 'rejected' (triaged away as
                             not-a-defect — closed for the gate). Same contract
                             as defer.
  findings <run-id> [wave] [--format=text|markdown|json]
                             Findings digest for a wave (default: latest).
                             Format auto-detects: text on TTY, markdown when
                             piped/redirected. DOGFOOD_FINDINGS_FORMAT env var
                             (raw|human|json) overrides both.
  runs [--format=text|json]  List all runs. --format=json emits a JSON array
                             of per-run rollups (id/repo/status/waveCount/
                             findingCount/created); default is text.
  trends --query <q> [opts]  Cross-run analytics (the only cross-run verb).
                             --query recurring   fingerprints seen in >1 run
                             --query history     per-run rollup, newest first
                                                 (optional --repo <substring>)
                             --query recurrence  recurrence-rate stats
                                                 (optional --window-days N)
                             --format=text|json  (default text)

Domain commands:
  domains <run-id>                          Show current map
  domains <run-id> --freeze                 Lock for the run
  domains <run-id> --unfreeze --reason "."  Unlock (requires reason). Refuses
                                             while a wave is in flight
                                             (dispatched/collecting/failed);
                                             add --force to override once
                                             you've halted the wave by hand.
  domains <run-id> --edit <name> [opts]     Modify globs/ownership/desc
  domains <run-id> --add <name> --globs ... Add new domain
  domains <run-id> --remove <name>          Remove domain
  domains <run-id> --history                Show change events

Phases:
${renderPhaseColumns('  ')}`);
    process.exit(command ? 1 : 0);
  }

  try {
    // Most verbs are synchronous. `adjudicate` is async (it awaits the
    // cross-family jury), so route a returned promise's rejection through the
    // same top-level renderer. A sync verb returns undefined and this is a no-op.
    const ret = commands[command](commandArgs);
    if (ret && typeof ret.then === 'function') {
      ret.catch((e) => { renderTopLevelError(e); process.exit(1); });
    }
  } catch (e) {
    renderTopLevelError(e);
    process.exit(1);
  }
}

if (isDirectExecution()) main();
