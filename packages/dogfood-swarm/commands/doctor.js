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
 *   (5) disk-free               — F-2fa28353: free space on the volume that
 *                                 holds SWARM_DB / the control-plane dir (and
 *                                 therefore the .swarm worktrees that land on
 *                                 the same volume under the default layout).
 *                                 WARN below DISK_FREE_WARN_BYTES. Isolate
 *                                 dispatch copies whole worktrees; a nearly-
 *                                 full volume fails mid-wave rather than at
 *                                 preflight. Read-only (fs.statfsSync).
 *   (6) control-plane-size      — F-2fa28353: combined size of control-plane.db
 *                                 + sibling .db-wal / .db-shm. WARN at/above
 *                                 CONTROL_PLANE_SIZE_WARN_BYTES. Does not
 *                                 vacuum or truncate — doctor discloses;
 *                                 operators investigate / relocate. Folded in
 *                                 from the claude-guardian job without forking
 *                                 that repo.
 *   (7) stranded-worktrees      — F-2fa28353: --isolate residue under
 *                                 <repo>/.swarm/worktrees via listWorktrees +
 *                                 worktreeDisposition (lib/worktree.js), plus
 *                                 fs-only orphan dirs git no longer lists
 *                                 (Windows junction strand). WARN when any
 *                                 remain. Repair stays `swarm clean <run-id>`
 *                                 (dry-run by default); doctor never removes.
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
  statSync, readdirSync, statfsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SCHEMA_VERSION } from '../db/schema.js';
import { listWorktrees, worktreeDisposition } from '../lib/worktree.js';

/** The package `engines.node` floor — keep in lockstep with package.json. */
const MIN_NODE_MAJOR = 22;

/**
 * F-2fa28353 documented WARN floors. Soft — never gate exit. Tunable via
 * runDoctor opts so tests can force WARN/PASS without PATH or volume surgery.
 *
 * Disk: isolate worktrees need headroom; 1 GiB is the soft floor measured
 * against the trajectory preflight (healthy boxes report TB-scale free).
 * Control-plane payload: live healthy was ~10 MB; 50 MiB for db+wal+shm is
 * the soft ceiling before the operator should investigate bloat.
 */
export const DISK_FREE_WARN_BYTES = 1 * 1024 * 1024 * 1024;
export const CONTROL_PLANE_SIZE_WARN_BYTES = 50 * 1024 * 1024;

/**
 * Infer the repo root that hosts `.swarm/worktrees` from the control-plane
 * DB path. Default layout is `<repo>/swarms/control-plane.db`; a relocated
 * SWARM_DB falls back to cwd (operator typically runs doctor from the repo).
 *
 * @param {string} dbPath
 * @returns {string}
 */
function inferRepoPath(dbPath) {
  const cpDir = dirname(dbPath);
  if (basename(cpDir) === 'swarms') return dirname(cpDir);
  // Isolated/temp DBs are not under swarms/: residue is next to the DB,
  // never process.cwd() (that would scan the live clone's isolate trees).
  return cpDir;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : (n >= 10 ? 1 : 2);
  return `${n.toFixed(digits)} ${units[i]}`;
}

/**
 * Best-effort size of a path; missing files contribute 0 (sidecars often
 * absent when the DB has never been opened in WAL mode).
 * @param {string} path
 * @returns {number}
 */
function fileSizeOrZero(path) {
  try {
    if (!existsSync(path)) return 0;
    return statSync(path).size;
  } catch {
    return 0;
  }
}

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
  let rawValue;
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT value FROM kv WHERE key = 'schema_version'").get();
    rawValue = row ? row.value : undefined;
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

  // F-4f7b2e53: onDisk parses from an external, hand-editable kv.value column
  // via parseInt — exactly the same "external numeric input" shape this
  // file's OWN checkNodeVersion (line 70) already guards with
  // Number.isFinite, and the shape history.js:43 / redrive.js:178 guard for
  // a CLI-supplied wave-id. Unguarded, a corrupted schema_version parses to
  // NaN, and `NaN > SCHEMA_VERSION` is always false — the only branch
  // capable of reporting FAIL — so the corrupted-value case fell through to
  // a lying "pass" ("schema vNaN is understood by this build") instead of
  // being surfaced. Reported as 'warn', matching the sibling branch just
  // above (an unreadable DB): doctor is read-only preflight, not a repair
  // tool, so it discloses the corruption without pretending to fail-closed
  // for a case it cannot itself resolve.
  if (!Number.isFinite(onDisk)) {
    return {
      id: 'schema-version',
      status: 'warn',
      message: `control-plane.db at ${dbPath} has a corrupted kv.schema_version value: ${JSON.stringify(rawValue)} — expected a finite number`,
      hint: 'run the intended command to get the precise control-plane error, or inspect the DB file',
    };
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
 * Check (5): free space on the SWARM_DB / control-plane volume. WARN-class.
 * F-2fa28353 — folded from the claude-guardian job into doctor (do not fork).
 *
 * @param {string} cpDir
 * @param {object} opts
 * @param {number} opts.warnBytes
 * @param {typeof statfsSync} [opts.statfsSync]
 * @returns {{ id, status, message, hint? }}
 */
function checkDiskFree(cpDir, opts) {
  const warnBytes = opts.warnBytes;
  let probeDir = cpDir;
  while (probeDir && !existsSync(probeDir)) {
    const parent = dirname(probeDir);
    if (parent === probeDir) break;
    probeDir = parent;
  }

  const statfs = opts.statfsSync || statfsSync;
  let fsStat;
  try {
    fsStat = statfs(probeDir);
  } catch (e) {
    return {
      id: 'disk-free',
      status: 'warn',
      message: `could not probe free space on ${probeDir} (${e.code || e.message})`,
      hint: 'confirm the SWARM_DB volume is mounted and readable; isolate dispatch needs free headroom for worktree copies',
    };
  }

  const bavail = Number(fsStat.bavail);
  const bsize = Number(fsStat.bsize);
  if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bsize <= 0) {
    return {
      id: 'disk-free',
      status: 'warn',
      message: `statfs returned non-numeric geometry for ${probeDir} (bavail=${fsStat.bavail}, bsize=${fsStat.bsize})`,
      hint: 'confirm the SWARM_DB volume reports usable free space before an isolate dispatch',
    };
  }

  const freeBytes = bavail * bsize;
  if (freeBytes < warnBytes) {
    return {
      id: 'disk-free',
      status: 'warn',
      message: `only ${formatBytes(freeBytes)} free on ${probeDir} (warn floor ${formatBytes(warnBytes)})`,
      hint: 'free space on the SWARM_DB / .swarm worktrees volume before an isolate dispatch — worktree copies need headroom',
    };
  }
  return {
    id: 'disk-free',
    status: 'pass',
    message: `${formatBytes(freeBytes)} free on ${probeDir} (floor ${formatBytes(warnBytes)})`,
  };
}

/**
 * Check (6): control-plane.db + .db-wal + .db-shm combined size. WARN-class.
 * F-2fa28353 — disclose bloat; never vacuum/truncate from doctor.
 *
 * @param {string} dbPath
 * @param {object} opts
 * @param {number} opts.warnBytes
 * @returns {{ id, status, message, hint? }}
 */
function checkControlPlaneSize(dbPath, opts) {
  const warnBytes = opts.warnBytes;
  const dbSize = fileSizeOrZero(dbPath);
  const walSize = fileSizeOrZero(`${dbPath}-wal`);
  const shmSize = fileSizeOrZero(`${dbPath}-shm`);
  const total = dbSize + walSize + shmSize;

  if (!existsSync(dbPath) && total === 0) {
    return {
      id: 'control-plane-size',
      status: 'pass',
      message: `no control-plane.db yet at ${dbPath} — nothing to size`,
    };
  }

  const detail = `db ${formatBytes(dbSize)} + wal ${formatBytes(walSize)} + shm ${formatBytes(shmSize)} = ${formatBytes(total)}`;
  if (total >= warnBytes) {
    return {
      id: 'control-plane-size',
      status: 'warn',
      message: `control-plane payload is ${detail} (warn ceiling ${formatBytes(warnBytes)})`,
      hint: 'investigate control-plane.db / WAL growth; doctor does not vacuum — relocate or compact out-of-band if the size is unexpected',
    };
  }
  return {
    id: 'control-plane-size',
    status: 'pass',
    message: `control-plane payload is ${detail} (ceiling ${formatBytes(warnBytes)})`,
  };
}

/**
 * Check (7): stranded --isolate worktree residue. WARN-class. F-2fa28353.
 * Reuses listWorktrees + worktreeDisposition; repair stays `swarm clean`.
 *
 * @param {string} repoPath
 * @param {object} opts
 * @param {typeof listWorktrees} [opts.listWorktrees]
 * @param {typeof worktreeDisposition} [opts.worktreeDisposition]
 * @returns {{ id, status, message, hint? }}
 */
function checkStrandedWorktrees(repoPath, opts = {}) {
  const listFn = opts.listWorktrees || listWorktrees;
  const dispositionFn = opts.worktreeDisposition || worktreeDisposition;
  const wtRoot = join(repoPath, '.swarm', 'worktrees');

  let tracked = [];
  try {
    tracked = listFn(repoPath) || [];
  } catch (e) {
    return {
      id: 'stranded-worktrees',
      status: 'warn',
      message: `could not list swarm worktrees under ${repoPath} (${e.code || e.message})`,
      hint: 'reclaim residue with `swarm clean <run-id>` (dry-run by default; --apply to remove)',
    };
  }

  // Only --isolate residue under THIS repo's .swarm/worktrees. git worktree
  // list from a nested cwd still returns the whole clone's worktrees.
  const rootNorm = wtRoot.replace(/\\/g, '/').toLowerCase();
  tracked = tracked.filter((w) => {
    const p = (w.path || '').replace(/\\/g, '/').toLowerCase();
    return p === rootNorm || p.startsWith(`${rootNorm}/`);
  });

  let atRisk = 0;
  const runShorts = new Set();
  for (const wt of tracked) {
    const branch = (wt.branch || '').replace(/^refs\/heads\//, '');
    const m = branch.match(/^swarm\/([^/]+)\//);
    if (m) runShorts.add(m[1]);
    let disposition = { dirty: false, unmerged: false };
    try {
      disposition = dispositionFn(repoPath, wt.path, branch);
    } catch { /* disposition probe is advisory */ }
    if (disposition.dirty || disposition.unmerged) atRisk++;
  }

  // Windows --isolate strand: git worktree list is already clean but the
  // directory remains under .swarm/worktrees. Count dirs that are not among
  // the porcelain paths (normalize for separator / case differences).
  const trackedPaths = new Set(
    tracked.map((w) => (w.path || '').replace(/\\/g, '/').toLowerCase()),
  );
  let orphanDirs = 0;
  if (existsSync(wtRoot)) {
    let entries = [];
    try {
      entries = readdirSync(wtRoot, { withFileTypes: true });
    } catch { /* advisory */ }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = join(wtRoot, ent.name).replace(/\\/g, '/').toLowerCase();
      if (!trackedPaths.has(full)) orphanDirs++;
    }
  }

  const trackedCount = tracked.length;
  if (trackedCount === 0 && orphanDirs === 0) {
    return {
      id: 'stranded-worktrees',
      status: 'pass',
      message: `no --isolate worktree residue under ${wtRoot}`,
    };
  }

  const parts = [];
  if (trackedCount > 0) {
    parts.push(
      `${trackedCount} git-tracked swarm worktree${trackedCount === 1 ? '' : 's'}` +
      (atRisk > 0 ? ` (${atRisk} dirty/unmerged)` : ''),
    );
  }
  if (orphanDirs > 0) {
    parts.push(
      `${orphanDirs} fs-only orphan dir${orphanDirs === 1 ? '' : 's'} (not in git worktree list)`,
    );
  }

  const shortHint = runShorts.size > 0
    ? ` (seen run-short${runShorts.size === 1 ? '' : 's'}: ${[...runShorts].sort().join(', ')})`
    : '';

  return {
    id: 'stranded-worktrees',
    status: 'warn',
    message: `${parts.join('; ')} under ${wtRoot}${shortHint}`,
    hint: 'reclaim with `swarm clean <run-id>` (dry-run by default; --apply to remove; add --force for dirty/unmerged). Doctor never deletes worktrees.',
  };
}

/**
 * Run every preflight check and roll up an overall verdict + exit code.
 *
 * @param {object} opts
 * @param {string} opts.dbPath — the control-plane DB path (CLI passes getDbPath()).
 * @param {string} [opts.repoPath] — repo hosting `.swarm/worktrees` (default: infer from dbPath / cwd).
 * @param {number} [opts.diskFreeWarnBytes] — override DISK_FREE_WARN_BYTES (tests).
 * @param {number} [opts.controlPlaneSizeWarnBytes] — override CONTROL_PLANE_SIZE_WARN_BYTES (tests).
 * @param {typeof statfsSync} [opts.statfsSync] — inject fs.statfsSync (tests).
 * @param {typeof listWorktrees} [opts.listWorktrees] — inject listWorktrees (tests).
 * @param {typeof worktreeDisposition} [opts.worktreeDisposition] — inject disposition (tests).
 * @returns {{ checks: Array<{id,status,message,hint?}>, overallStatus: 'pass'|'warn'|'fail', exitCode: 0|1 }}
 */
export function runDoctor(opts) {
  const cpDir = dirname(opts.dbPath);
  const repoPath = opts.repoPath || inferRepoPath(opts.dbPath);
  const checks = [
    checkNodeVersion(),
    checkControlPlaneWritable(cpDir),
    checkSchemaVersion(opts.dbPath),
    checkGitAvailable(),
    checkDiskFree(cpDir, {
      warnBytes: opts.diskFreeWarnBytes ?? DISK_FREE_WARN_BYTES,
      statfsSync: opts.statfsSync,
    }),
    checkControlPlaneSize(opts.dbPath, {
      warnBytes: opts.controlPlaneSizeWarnBytes ?? CONTROL_PLANE_SIZE_WARN_BYTES,
    }),
    checkStrandedWorktrees(repoPath, {
      listWorktrees: opts.listWorktrees,
      worktreeDisposition: opts.worktreeDisposition,
    }),
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
