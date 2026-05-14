#!/usr/bin/env node
/**
 * check-finding-regression-pins.mjs — always-on CI gate for Class #14
 * (claimed-fixed without verification).
 *
 * Consumes the parser at packages/portfolio/lib/parse-regression-pins.js to
 * scan the repo for `F-NNNNNN-NNN` finding-id pins, then asserts the
 * asymmetric invariant the gate cares about: every F-id pinned in source
 * has at least one F-id pin in a test file. Test-only pins are NOT a
 * failure — a test that documents a regression whose source reference has
 * been refactored away still earns its keep.
 *
 * Companion to FT-BACKEND-002 (`swarm verify-fixed` runtime check). This
 * commit-time gate runs in CI on every push; the runtime check runs after
 * a swarm declares a fix is in.
 *
 * Allowlist:
 *   scripts/regression-pin-allowlist.json captures the legitimate prose-
 *   reference cases (an F-id mentioned in source as a cross-reference,
 *   not as a fix pin). The parser is intentionally permissive about
 *   prose vs pin (see parse-regression-pins.js JSDoc); the allowlist is
 *   how this gate disambiguates.
 *
 * Exit codes:
 *   0 — no orphan source pins (after allowlist filter)
 *   1 — at least one orphan source pin (Class #14 violation)
 *   2 — internal error (parser threw, allowlist malformed, etc.)
 *
 * Usage:
 *   node scripts/check-finding-regression-pins.mjs
 *   node scripts/check-finding-regression-pins.mjs --json
 *   node scripts/check-finding-regression-pins.mjs --write-index docs/regression-pin-index.json
 *   node scripts/check-finding-regression-pins.mjs --root <dir>     # alternate scan root (tests)
 *   node scripts/check-finding-regression-pins.mjs --allowlist <path>
 *
 * Programmatic API:
 *   import { runRegressionPinGate } from './check-finding-regression-pins.mjs';
 *   const result = await runRegressionPinGate({ repoRoot, allowlistPath, writeIndexPath });
 *   // result = { ok: boolean, json, orphans, allowlistApplied, indexWritten }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseRegressionPins,
  toJSON,
} from '../packages/portfolio/lib/parse-regression-pins.js';

const here = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(here, '..');
const defaultAllowlistPath = resolve(here, 'regression-pin-allowlist.json');

/**
 * Load the allowlist JSON at `path`. Returns an object whose `allow` key is a
 * map from F-id to a reason record. Throws on malformed JSON or missing
 * `allow` field — better to fail loud than silently let an orphan through.
 *
 * @param {string} path
 * @returns {{ allow: Record<string, { reason: string, file?: string }> }}
 */
export function loadAllowlist(path) {
  if (!existsSync(path)) return { allow: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`regression-pin-allowlist at ${path} is not valid JSON: ${err.message}`);
  }
  if (parsed.allow === undefined) {
    throw new Error(
      `regression-pin-allowlist at ${path} missing required "allow" field. Shape: { "allow": { "F-NNNNNN-NNN": { "reason": "...", "file": "..." } } }`,
    );
  }
  if (parsed.allow === null || typeof parsed.allow !== 'object' || Array.isArray(parsed.allow)) {
    throw new Error(
      `regression-pin-allowlist at ${path} "allow" must be an object map (got ${Array.isArray(parsed.allow) ? 'array' : typeof parsed.allow}).`,
    );
  }
  for (const [id, entry] of Object.entries(parsed.allow)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`regression-pin-allowlist entry for ${id} must be an object with at least { reason }.`);
    }
    if (!entry.reason || typeof entry.reason !== 'string') {
      throw new Error(`regression-pin-allowlist entry for ${id} missing "reason" string.`);
    }
  }
  return parsed;
}

/**
 * Apply the allowlist to a parsed JSON result, returning the filtered
 * orphan list and the set of allowlist entries that were actually used
 * (so we can warn about stale entries that match no orphan).
 *
 * @param {ReturnType<typeof toJSON>} json
 * @param {{ allow: Record<string, unknown> }} allowlist
 * @returns {{ orphansAfterAllowlist: string[], applied: string[], unusedAllowEntries: string[] }}
 */
export function applyAllowlist(json, allowlist) {
  const allowed = new Set(Object.keys(allowlist.allow));
  const orphansAfter = [];
  const applied = [];
  for (const id of json.summary.orphan_source_ids) {
    if (allowed.has(id)) {
      applied.push(id);
    } else {
      orphansAfter.push(id);
    }
  }
  const unused = [...allowed].filter((id) => !applied.includes(id));
  return { orphansAfterAllowlist: orphansAfter, applied, unusedAllowEntries: unused };
}

/**
 * Run the gate.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]      - directory to scan (default: repo root inferred from this script)
 * @param {string} [opts.allowlistPath] - path to allowlist JSON
 * @param {string} [opts.writeIndexPath]- if set, write the JSON index here
 * @returns {Promise<{
 *   ok: boolean,
 *   json: ReturnType<typeof toJSON>,
 *   orphans: string[],
 *   allowlistApplied: string[],
 *   unusedAllowEntries: string[],
 *   indexWritten: string | null
 * }>}
 */
export async function runRegressionPinGate({ repoRoot = defaultRepoRoot, allowlistPath = defaultAllowlistPath, writeIndexPath = null } = {}) {
  const result = parseRegressionPins(repoRoot);
  const json = toJSON(result);
  const allowlist = loadAllowlist(allowlistPath);
  const { orphansAfterAllowlist, applied, unusedAllowEntries } = applyAllowlist(json, allowlist);

  let indexWritten = null;
  if (writeIndexPath) {
    const absPath = resolve(repoRoot, writeIndexPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, `${JSON.stringify(json, null, 2)}\n`, 'utf-8');
    indexWritten = absPath;
  }

  return {
    ok: orphansAfterAllowlist.length === 0,
    json,
    orphans: orphansAfterAllowlist,
    allowlistApplied: applied,
    unusedAllowEntries,
    indexWritten,
  };
}

/**
 * Pretty-print a gate result for terminal consumption.
 */
export function formatHuman(result, repoRoot) {
  const lines = [];
  const { json, orphans, allowlistApplied, unusedAllowEntries, indexWritten } = result;
  lines.push(`[check-finding-regression-pins] scanned ${json.files_scanned} files`);
  lines.push(`  source pins: ${json.summary.source_ids} F-id(s)`);
  lines.push(`  test pins:   ${json.summary.test_ids} F-id(s)`);
  if (allowlistApplied.length > 0) {
    lines.push(`  allowlist applied: ${allowlistApplied.length} F-id(s) (${allowlistApplied.join(', ')})`);
  }
  if (unusedAllowEntries.length > 0) {
    lines.push(`  WARN — stale allowlist entries (no longer match any orphan): ${unusedAllowEntries.join(', ')}`);
  }
  if (orphans.length === 0) {
    lines.push(`  OK — every source-pinned F-id has at least one test pin (Class #14 invariant holds).`);
  } else {
    lines.push(`  FAIL — ${orphans.length} orphan source pin(s) without matching test pin:`);
    for (const id of orphans) {
      const files = json.source_pins[id] ?? [];
      lines.push(`    ${id}`);
      for (const f of files) {
        lines.push(`      in ${relative(repoRoot, f) || f}`);
      }
    }
    lines.push('');
    lines.push('  How to fix: add a regression test that pins the F-id (e.g. // F-NNNNNN-NNN — what this guards),');
    lines.push('  OR — if the source mention is a cross-reference rather than a fix pin — add an entry to');
    lines.push('  scripts/regression-pin-allowlist.json with a justification.');
  }
  if (indexWritten) {
    lines.push(`  Wrote index to ${relative(repoRoot, indexWritten) || indexWritten}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { json: false, writeIndexPath: null, root: null, allowlistPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--write-index') {
      out.writeIndexPath = argv[++i] ?? null;
      if (!out.writeIndexPath) throw new Error('--write-index requires a path argument');
    } else if (a === '--root') {
      out.root = argv[++i] ?? null;
      if (!out.root) throw new Error('--root requires a path argument');
    } else if (a === '--allowlist') {
      out.allowlistPath = argv[++i] ?? null;
      if (!out.allowlistPath) throw new Error('--allowlist requires a path argument');
    } else if (a === '-h' || a === '--help') {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/check-finding-regression-pins.mjs [options]

Always-on CI gate for Class #14 (claimed-fixed without verification). Asserts
every F-NNNNNN-NNN pinned in a source file has at least one matching pin in
a test file.

Options:
  --json                    machine-readable JSON output (parser result + gate)
  --write-index <path>      after parsing, write the JSON index to <path>
                            (recommended canonical location: docs/regression-pin-index.json)
  --root <dir>              scan a directory other than the repo root (tests use this)
  --allowlist <path>        use a different allowlist file
  -h, --help                this message

Exit codes: 0 (clean) | 1 (orphan source pins) | 2 (internal error)
`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  const repoRoot = args.root ? resolve(args.root) : defaultRepoRoot;
  const allowlistPath = args.allowlistPath ? resolve(args.allowlistPath) : defaultAllowlistPath;

  let result;
  try {
    result = await runRegressionPinGate({
      repoRoot,
      allowlistPath,
      writeIndexPath: args.writeIndexPath,
    });
  } catch (err) {
    process.stderr.write(`[check-finding-regression-pins] internal error: ${err.message}\n`);
    process.exit(2);
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: result.ok,
      orphans: result.orphans,
      allowlist_applied: result.allowlistApplied,
      unused_allow_entries: result.unusedAllowEntries,
      index_written: result.indexWritten,
      parser: result.json,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(result, repoRoot)}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

// F-W1-CI-006: ESM main detection — only run main() when invoked as a script,
// not when imported by tests. Previous heuristic used a hand-built
// `file://${process.argv[1]}` plus an `endsWith` fallback; both fail on
// Windows because process.argv[1] uses backslashes while import.meta.url is
// always POSIX/URL form. `pathToFileURL(process.argv[1]).href` is the
// canonical Node cross-platform pattern (matches apply-finding-migration.mjs
// W31-BACK-001 fix).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main();
}
