#!/usr/bin/env node
/**
 * build.mjs — wave-tolerant root builder.
 *
 * Skips `tsc --build` when `packages/` has no real package (e.g. fresh clone
 * before any package scaffold), otherwise invokes it. Keeping this guard is
 * cheap and avoids `error TS18002: The files list in config file is empty`
 * on an empty workspace. Drift-detection: also asserts every TS-bearing
 * package under packages/ is registered in the root tsconfig.json's
 * `references` list and exits non-zero on drift (closes audit-coverage gap
 * #11 — hand-maintained list duplicating an authoritative source).
 *
 * The drift logic is exported as pure functions (`hasRealPackage`,
 * `findTsconfigReferenceDrift`) so scripts/build.test.mjs can exercise the
 * missing[]-filter, the posix.normalize() reference comparison, and the
 * empty-packages early-skip without spawning `tsc --build`. This mirrors the
 * `syncVersion()` / `runDriftChecks()` separation in the sibling script gates
 * — the gate was previously module-top-level and therefore untestable
 * (d6-infra-002).
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * True when `path` is a stat-able directory. The stat is the one IO boundary in
 * this builder that can throw on an abnormal-but-not-impossible filesystem
 * state: a broken symlink (ENOENT/ELOOP), a permission-denied entry (EACCES),
 * or a TOCTOU race where the entry vanishes between readdirSync and statSync
 * (ENOENT). Pre-fix (d6-infra-B002) both `hasRealPackage` and
 * `findTsconfigReferenceDrift` called statSync(entry) unconditionally, so a
 * single stray broken symlink under packages/ — e.g. from a partially-cloned or
 * interrupted scaffold — aborted `npm run build` with a raw Node fs stack trace
 * instead of the structured `[testing-os build]` guidance the rest of the
 * script emits.
 *
 * The humanization fix: on a stat failure, emit ONE structured, operator-legible
 * warning naming the offending path AND the fs error code, then return false so
 * the entry is skipped (it cannot be a real package or a TS package — both
 * predicates require a readable directory). This degrades a stray bad entry to
 * "ignored that entry" rather than crashing the wave-tolerant builder. Skip-
 * with-a-logged-reason, not a silent swallow: the operator still sees exactly
 * which entry was unreadable and why.
 *
 * @param {string} path — absolute path to a packages/<entry>
 * @returns {boolean} true iff `path` stats as a directory; false (with a logged
 *   reason) if it is not a directory or could not be stat-ed.
 */
function isReadableDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch (err) {
    console.error(
      `[testing-os build] skipped unreadable entry under packages/: ${path} — ${err.code ?? err.message}. ` +
        `A broken symlink, a permission-denied entry, or an entry removed mid-scan can cause this; ` +
        `remove or repair the entry, then re-run \`npm run build\`.`
    );
    return false;
  }
}

/**
 * True when `packages/` holds at least one real package (a directory, not
 * dot-prefixed, with a package.json). Mirrors the `hasRealPackage` guard so an
 * empty/fresh workspace skips `tsc --build` rather than tripping TS18002.
 *
 * @param {string} packagesDir — absolute path to the packages/ dir
 * @returns {boolean}
 */
export function hasRealPackage(packagesDir) {
  return (
    existsSync(packagesDir) &&
    readdirSync(packagesDir).some((entry) => {
      if (entry.startsWith('.')) return false;
      const p = resolve(packagesDir, entry);
      if (!isReadableDirectory(p)) return false;
      return existsSync(resolve(p, 'package.json'));
    })
  );
}

/**
 * Drift gate: every packages/<name>/tsconfig.json must be registered in the
 * root tsconfig.json `references` array, AND every root reference must point
 * at a packages/<name> that still has a tsconfig.json. Same drift class as
 * STATUS.run / AUDIT_PHASES (F-693631-010 / F-375053-005) — a hand-maintained
 * list duplicating an authoritative source. A new TS package added without
 * updating root tsconfig.json would otherwise silently skip type-check from
 * the root (the `missing` direction); a package renamed or removed without
 * updating root tsconfig.json leaves a dangling reference (the `stale`
 * direction, F-af5e8919).
 *
 * F-af5e8919: pre-fix, this function only computed `missing` (forward
 * direction) — a root reference pointing at a packages/<name> directory that
 * no longer has a tsconfig.json (package rename/removal, an ordinary future
 * event for a growing monorepo) reported ZERO drift. `tsc --build` itself
 * still catches this (fails with `TS5083: Cannot read file '.../tsconfig.json'`,
 * a non-zero exit, no false green) — the gap was diagnostic QUALITY, not
 * silence: the dedicated gate this file exists to give BETTER guidance than
 * raw tsc output never fired for this direction, so the operator got a
 * generic TS5083 plus a "fix the reported type errors" hint that is actively
 * wrong for this specific failure (the real fix is removing a stale
 * references[] entry, not fixing a type error). `stale` is reported and
 * acted on BEFORE ever reaching `execSync('tsc --build', ...)` — see the CLI
 * entry block below — so this direction gets the same operator-friendly
 * message the forward direction already had.
 *
 * Reference paths are canonicalized on BOTH sides (`posix.normalize` plus a
 * trailing-slash strip) so all three valid tsconfig reference spellings —
 * `packages/x`, `./packages/x`, and `packages/x/` — match the discovered
 * `packages/x`. `posix.normalize` alone collapses `./` and `//` but PRESERVES
 * a trailing slash, so a `packages/x/` reference would otherwise false-positive
 * as drift; `normalizeRef` strips it. Applies identically to both directions —
 * `stale` reuses the same normalized `referenced` list `missing` already did.
 *
 * @param {object} opts
 * @param {string} opts.packagesDir — absolute path to packages/
 * @param {string} opts.rootTsconfigPath — absolute path to root tsconfig.json
 * @returns {{ tsPackages: string[], referenced: string[], missing: string[], stale: string[] }}
 */
export function findTsconfigReferenceDrift({ packagesDir, rootTsconfigPath }) {
  const tsPackages = readdirSync(packagesDir)
    .filter((entry) => {
      if (entry.startsWith('.')) return false;
      const p = resolve(packagesDir, entry);
      return isReadableDirectory(p) && existsSync(resolve(p, 'tsconfig.json'));
    })
    .map((entry) => normalizeRef(`packages/${entry}`));

  const rootTsconfig = JSON.parse(readFileSync(rootTsconfigPath, 'utf8'));
  const referenced = (rootTsconfig.references ?? []).map((r) => normalizeRef(r.path));
  const referencedSet = new Set(referenced);
  const tsPackagesSet = new Set(tsPackages);
  const missing = tsPackages.filter((p) => !referencedSet.has(p));
  // F-af5e8919: the reverse direction. Scoped to references that at least
  // LOOK like a packages/<name> path (the only shape this gate has any
  // authority over) — a root tsconfig.json could in principle reference
  // something outside packages/ entirely, which is not this gate's concern
  // and must not be reported as a false "stale" drift.
  const stale = referenced.filter((r) => r.startsWith('packages/') && !tsPackagesSet.has(r));

  return { tsPackages, referenced, missing, stale };
}

/**
 * Canonicalize a tsconfig reference path for comparison: posix-normalize
 * (collapses `./` and `//`) then strip a single trailing slash so
 * `packages/x/` and `packages/x` compare equal. The root path `/` is left
 * intact (never a valid package reference, but a defensive guard).
 *
 * @param {string} p
 * @returns {string}
 */
function normalizeRef(p) {
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

// CLI entry — only run when invoked directly, not when imported by tests.
// `pathToFileURL(process.argv[1]).href === import.meta.url` is the canonical
// cross-platform entrypoint check (matches sync-version.mjs / F-W1-CI-007);
// on Windows a raw string compare can disagree on drive-letter casing or
// 8.3-vs-long-name resolution and silently no-op.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');
  const packagesDir = resolve(repoRoot, 'packages');

  if (!hasRealPackage(packagesDir)) {
    console.log('[testing-os build] No packages yet — skipping tsc --build.');
    process.exit(0);
  }

  const rootTsconfigPath = resolve(repoRoot, 'tsconfig.json');
  // Sibling of F-016e7a8c (scripts/check-doc-drift.mjs), found sweeping this
  // domain's unguarded-JSON.parse class: findTsconfigReferenceDrift's own
  // JSON.parse(readFileSync(rootTsconfigPath, ...)) is unguarded. A malformed
  // root tsconfig.json (an ordinary hand-edit slip) is exactly the kind of
  // drift this file's OWN docstring says a growing monorepo will eventually
  // hit — pre-fix it crashed `npm run build` with a raw, uncaught SyntaxError
  // stack (JSON.parse / findTsconfigReferenceDrift / ModuleJob.run frames),
  // the one failure mode every OTHER branch in this file (isReadableDirectory,
  // the missing/stale reports below, the execSync catch) already avoids via a
  // structured '[testing-os build] ...' message. Caught at the call site
  // (not inside the pure function itself) so findTsconfigReferenceDrift's
  // tested contract — a function of its inputs, throws on malformed JSON,
  // exercised directly by scripts/build.test.mjs — is unchanged; only the
  // real CLI entry point gets the humanized failure.
  let driftResult;
  try {
    driftResult = findTsconfigReferenceDrift({ packagesDir, rootTsconfigPath });
  } catch (err) {
    console.error(
      `[testing-os build] failed to read/parse root tsconfig.json for the references drift gate: ${err.message}`
    );
    console.error(
      'Check tsconfig.json for a JSON syntax error (trailing comma, unclosed bracket), then re-run `npm run build`.'
    );
    process.exit(1);
  }
  const { missing, stale } = driftResult;

  if (missing.length > 0) {
    console.error(
      `[testing-os build] tsconfig.json references drift — these packages have a tsconfig.json but are not referenced from root: ${missing.join(', ')}`
    );
    console.error(
      `Add them to tsconfig.json's "references" array, e.g.: { "path": "${missing[0]}" }`
    );
    process.exit(1);
  }

  // F-af5e8919: the reverse direction — a root reference whose
  // packages/<name>/tsconfig.json no longer exists (rename/removal). Checked
  // BEFORE ever reaching execSync('tsc --build', ...) below so the operator
  // gets this gate's own operator-friendly guidance instead of a generic
  // `tsc --build`-produced TS5083 "Cannot read file" plus a "fix the reported
  // type errors" hint that is actively wrong for this specific failure (the
  // real fix is removing the stale references[] entry, not fixing a type error).
  if (stale.length > 0) {
    console.error(
      `[testing-os build] tsconfig.json references a package that no longer exists: ${stale.join(', ')} — remove ${stale.length === 1 ? 'it' : 'them'} from the references array.`
    );
    process.exit(1);
  }

  // F-b27d6c0c: every other failure path in this file prints a structured
  // '[testing-os build] ...' message with a concrete remediation before
  // exiting non-zero (see the tsconfig reference-drift gate above and
  // isReadableDirectory's fs-error humanization). An uncaught execSync
  // throw here would instead surface a raw 'Error: Command failed: tsc
  // --build' Node stack on top of tsc's own diagnostics — noise, not signal,
  // since stdio: 'inherit' has already streamed the real diagnostics to the
  // operator. Swallowing the error object is correct: nothing it carries is
  // more useful than what tsc already printed.
  try {
    execSync('tsc --build', { stdio: 'inherit', cwd: repoRoot });
  } catch {
    console.error(
      '[testing-os build] tsc --build failed — see the TypeScript diagnostics above. Fix the reported type errors, then re-run `npm run build`.'
    );
    process.exit(1);
  }
}
