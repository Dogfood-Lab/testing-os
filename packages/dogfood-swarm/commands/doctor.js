/**
 * doctor.js — `swarm doctor`
 *
 * F5-09 (LOW): cheap, read-only PREFLIGHT checks an operator can run before a
 * real dispatch wastes their time on a misconfigured environment. Every check
 * is grounded in a REAL dependency of the running `swarm` control plane — no
 * fictional probes:
 *
 *   (1) node-version            — Node >= 22 (the package `engines.node` floor;
 *                                 better-sqlite3 + the ESM surface assume it).
 *   (2) control-plane-writable  — the dir that will hold control-plane.db is
 *                                 writable AND hardlink-capable. The cross-
 *                                 process file lock in @dogfood-lab/findings/
 *                                 lib/file-lock.js claims the lock via
 *                                 linkSync (a hardlink CAS). link() throws
 *                                 ENOTSUP on exFAT/FAT32 — the documented FS
 *                                 trap (docs/m5-validation-2026-04-29.md). A
 *                                 dispatch on such a volume fails opaquely; this
 *                                 surfaces it up front.
 *   (3) schema-version          — the on-disk control-plane.db is NOT a NEWER
 *                                 schema than this build understands. openDb
 *                                 fail-closes (ControlPlaneSchemaTooNewError)
 *                                 against a too-new DB; doctor reads the version
 *                                 READ-ONLY (never throws) and reports it as a
 *                                 hard FAIL with the "upgrade the tool" hint.
 *   (4) git-available           — git is on PATH (`git --version`). WARN-class,
 *                                 NOT a hard FAIL: the core SQLite control plane
 *                                 runs without git, but two features degrade
 *                                 silently when it is absent — the independent
 *                                 ownership-attribution probe (collect.js →
 *                                 lib/git-touched-files.js: git status / git diff)
 *                                 reports ownership_probe_degraded on every wave,
 *                                 and --isolate per-agent worktrees (lib/
 *                                 worktree.js → git worktree) fail opaquely at
 *                                 dispatch. doctor surfaces the dependency up
 *                                 front (DS-PROAC-01).
 *
 * Deliberately ABSENT (verified against source, not invented):
 *   - No DOGFOOD_TOKEN check — that env var does not exist anywhere in the
 *     codebase.
 *   - No GITHUB_TOKEN check — the github provenance adapter
 *     (packages/verify/validators/provenance.js) takes the token as an
 *     explicit function argument and reads nothing from process.env, so the
 *     `swarm` control plane has no provenance env dependency to probe. (The
 *     GITHUB_TOKEN read lives in packages/ingest/run.js, a different binary.)
 *
 * Exit-code contract: exit non-zero ONLY on a hard FAIL. A WARN does not gate
 * (the environment is usable, just sub-ideal) — warns exit 0.
 */

import Database from 'better-sqlite3';
import {
  existsSync, mkdtempSync, openSync, closeSync, linkSync, rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SCHEMA_VERSION } from '../db/schema.js';

/** The package `engines.node` floor — keep in lockstep with package.json. */
const MIN_NODE_MAJOR = 22;

/**
 * Check (1): the running Node major satisfies the `engines.node` floor.
 * @returns {{ id, status, message, hint }}
 */
function checkNodeVersion() {
  const raw = process.versions.node; // e.g. "22.22.3"
  const major = parseInt(raw.split('.')[0], 10);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return {
      id: 'node-version',
      status: 'pass',
      message: `Node ${raw} satisfies the >=${MIN_NODE_MAJOR} engines floor`,
    };
  }
  return {
    id: 'node-version',
    status: 'fail',
    message: `Node ${raw} is below the >=${MIN_NODE_MAJOR} engines floor`,
    hint: `install Node ${MIN_NODE_MAJOR}+ (the control plane uses better-sqlite3 + an ESM surface that assume it)`,
  };
}

/**
 * Check (2): the directory that will hold control-plane.db is writable AND
 * hardlink-capable. Probes by creating a temp subdir, writing a temp file, and
 * attempting linkSync() to a second name — the exact mechanism the file-lock
 * CAS uses. ENOTSUP/EPERM/EXDEV on the link is the exFAT/FAT32 trap.
 *
 * @param {string} cpDir — the directory control-plane.db lives in
 * @returns {{ id, status, message, hint }}
 */
function checkControlPlaneWritable(cpDir) {
  // The dir may not exist yet (openDb mkdir's it on first use); probe the
  // nearest existing ancestor so a fresh path still gets a real answer.
  let probeDir = cpDir;
  while (probeDir && !existsSync(probeDir)) {
    const parent = dirname(probeDir);
    if (parent === probeDir) break;
    probeDir = parent;
  }

  let scratch = null;
  try {
    scratch = mkdtempSync(join(probeDir, '.swarm-doctor-'));
  } catch (e) {
    return {
      id: 'control-plane-writable',
      status: 'fail',
      message: `control-plane dir is not writable (${e.code || e.message}): ${probeDir}`,
      hint: 'point SWARM_DB at a writable location, or fix the directory permissions',
    };
  }

  try {
    const src = join(scratch, `probe-${randomBytes(4).toString('hex')}.tmp`);
    const link = join(scratch, `probe-${randomBytes(4).toString('hex')}.link`);
    // Create an empty probe file (no content needed — this probes link(2)
    // capability, not torn-write semantics, so it intentionally does NOT route
    // through the atomic-write helper; an empty inode is all linkSync needs).
    closeSync(openSync(src, 'w'));
    try {
      linkSync(src, link);
    } catch (e) {
      const code = e.code || '';
      return {
        id: 'control-plane-writable',
        status: 'fail',
        message: `control-plane dir is writable but NOT hardlink-capable (link() ${code || e.message}): ${probeDir}`,
        hint: 'the cross-process file lock needs hardlink support; exFAT/FAT32 do not support link(2) — use an NTFS/APFS/ext4 volume (SWARM_DB) for the control plane',
      };
    }
    return {
      id: 'control-plane-writable',
      status: 'pass',
      message: `control-plane dir is writable and hardlink-capable: ${probeDir}`,
    };
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Check (3): the on-disk control-plane.db schema version is not NEWER than this
 * build understands. Read-only — opens the DB `readonly` and reads the kv
 * version directly; NEVER calls openDb (which throws ControlPlaneSchemaTooNewError
 * on a too-new DB and would mutate/migrate an older one). A missing DB file is a
 * PASS (openDb will create it fresh at the current version on first real use).
 *
 * @param {string} dbPath
 * @returns {{ id, status, message, hint }}
 */
function checkSchemaVersion(dbPath) {
  if (!existsSync(dbPath)) {
    return {
      id: 'schema-version',
      status: 'pass',
      message: `no control-plane.db yet at ${dbPath} — it will be created fresh at schema v${SCHEMA_VERSION}`,
    };
  }

  let onDisk = 0;
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
    onDisk = row ? parseInt(row.value, 10) : 0;
  } catch (e) {
    // A DB we cannot even read for its version (corrupt, locked exclusively) is
    // a WARN, not a FAIL — doctor is a preflight, not a repair tool, and the
    // real openDb path will surface a precise error.
    return {
      id: 'schema-version',
      status: 'warn',
      message: `could not read schema version from ${dbPath} (${e.code || e.message})`,
      hint: 'run the intended command to get the precise control-plane error, or inspect the DB file',
    };
  } finally {
    if (db) { try { db.close(); } catch { /* */ } }
  }

  if (onDisk > SCHEMA_VERSION) {
    return {
      id: 'schema-version',
      status: 'fail',
      message: `control-plane.db is schema v${onDisk} but this build only understands v${SCHEMA_VERSION}`,
      hint: 'pull the latest @dogfood-lab/dogfood-swarm — its state is the newer build\'s correctly migrated state, NOT corruption; do not hand-edit or delete the DB',
    };
  }
  return {
    id: 'schema-version',
    status: 'pass',
    message: `control-plane.db schema v${onDisk} is understood by this build (v${SCHEMA_VERSION})`,
  };
}

/**
 * Check (4): git is on PATH. WARN-class — a missing git does NOT gate the exit
 * code (the SQLite control plane runs without it), but the operator must know
 * that the independent ownership-attribution probe and --isolate worktrees will
 * degrade. Probes with `git --version` (argv-array, no shell). DS-PROAC-01.
 *
 * @returns {{ id, status, message, hint? }}
 */
function checkGitAvailable() {
  let version;
  try {
    version = execFileSync('git', ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return {
      id: 'git-available',
      status: 'warn',
      message: `git is not available on PATH (${e.code || e.message})`,
      hint: 'install git: the ownership-attribution probe (collect) degrades to self-report and --isolate per-agent worktrees fail without it; the SQLite control plane still works',
    };
  }
  return {
    id: 'git-available',
    status: 'pass',
    message: `${version} on PATH — ownership-attribution probe + --isolate worktrees available`,
  };
}

/**
 * Run every preflight check and roll up an overall verdict + exit code.
 *
 * @param {object} opts
 * @param {string} opts.dbPath — the control-plane DB path (CLI passes getDbPath()).
 * @returns {{ checks: Array<{id,status,message,hint?}>, overallStatus: 'pass'|'warn'|'fail', exitCode: 0|1 }}
 */
export function runDoctor(opts) {
  const cpDir = dirname(opts.dbPath);
  const checks = [
    checkNodeVersion(),
    checkControlPlaneWritable(cpDir),
    checkSchemaVersion(opts.dbPath),
    checkGitAvailable(),
  ];

  const anyFail = checks.some(c => c.status === 'fail');
  const anyWarn = checks.some(c => c.status === 'warn');
  const overallStatus = anyFail ? 'fail' : anyWarn ? 'warn' : 'pass';
  // Exit non-zero ONLY on a hard FAIL — a WARN does not gate (warns exit 0).
  const exitCode = anyFail ? 1 : 0;

  return { checks, overallStatus, exitCode };
}

const STATUS_SIGIL = { pass: '[PASS]', warn: '[WARN]', fail: '[FAIL]' };

/**
 * Render the doctor report as scan-first plain ASCII (matches formatStatus /
 * the runs listing posture — no color, renders identically under CI logs).
 *
 * @param {{ checks, overallStatus }} report
 * @returns {string}
 */
export function formatDoctor(report) {
  const lines = ['swarm doctor — preflight checks', ''];
  for (const c of report.checks) {
    lines.push(`${STATUS_SIGIL[c.status] || '[????]'} ${c.id} — ${c.message}`);
    if (c.hint && c.status !== 'pass') lines.push(`         hint: ${c.hint}`);
  }
  lines.push('');
  lines.push(`Overall: ${report.overallStatus.toUpperCase()}`);
  return lines.join('\n');
}
