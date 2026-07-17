/**
 * normalize-path.js — shared leaf helper: normalize a file path for
 * case/slash-insensitive comparison before fingerprinting or glob-ownership
 * matching.
 *
 * F-d656acc4 / F-swarmcpcore-008: lib/fingerprint.js's private `normalizePath`
 * and commands/collect.js's private `normalizeFilePathForGlobMatch` were
 * confirmed byte-identical transforms (backslash-to-forward-slash, collapse
 * repeated slashes, strip leading './', strip trailing '/', lowercase),
 * duplicated across the swarm-cp-core / swarm-cp-verbs domain boundary. The
 * wave-37 commit message and collect.js's own comment both disclosed this as
 * debt, with collect.js naming the exact trigger: "a third copy would be the
 * signal to promote this to a shared, exported helper instead of forking
 * again." This file is that promotion.
 *
 * NAMING NOTE (deliberate departure from the finding's literal suggestion):
 * the recommendation text proposed `normalizePathForMatch`, but
 * `commands/rewind.js` already exports a DIFFERENT, pre-existing function
 * under that exact name — a platform-aware (win32 vs POSIX) worktree
 * CWD-vs-`runs.local_path` comparator (see stageA-rewind-path-case.test.js),
 * unrelated to fingerprinting or domain-glob ownership. Reusing that name
 * here would read as "the same normalization" when it is not: rewind.js's
 * version is platform-conditional and has no case-fold-for-glob-matching
 * intent at all. This export is named after collect.js's OWN existing local
 * name for the identical transform (`normalizeFilePathForGlobMatch`) instead
 * — the name collect.js's future import can adopt with a pure
 * delete-local-add-import diff, and a name that cannot be confused with
 * rewind.js's unrelated helper.
 *
 * F-c63da27b (the original fix this transform implements): collapsing
 * repeated slashes BEFORE stripping the leading './' also normalizes a
 * leading './/', which a strict single-slash leading-dot strip alone would
 * otherwise leave as a stray '/'.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeFilePathForGlobMatch(filePath) {
  if (!filePath) return '';
  return filePath
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '')
    .toLowerCase();
}
