/**
 * revalidation-cadence.mjs — the single definition of "is this dated
 * exemption overdue," shared across every gate that grants a time-boxed
 * exemption from a stricter check.
 *
 * F-875708f9 (wave 39 feature pass, T6 — docs/trajectory-and-closure.dispatch.md):
 * scripts/check-finding-regression-pins.mjs computed this comparison inline,
 * twice (once for the allowlist bucket, once for the grandfathered-manifest
 * bucket) — `entry.revalidate_by < today`. T6 needs the IDENTICAL operation
 * applied to a third and fourth set (deferred findings, and the same
 * grandfathered manifest again) from the roadmap compiler (core domain,
 * dogfood/roadmap/<run-id>.json). Left as copy-paste, that is two
 * independently-evolving definitions of "overdue" — this repo's own
 * CLAUDE.md documents the atomic-write.js / log-stage.js precedent for
 * exactly this situation: extract the leaf helper once, before a second
 * caller has to choose between duplicating it or importing across a
 * package boundary that was never designed for it.
 *
 * Contract: `revalidate_by` (and `expires`, for T3 operator notes — see
 * check-doc-drift.mjs's roadmap-notes-integrity handler) are ISO
 * 'YYYY-MM-DD' date strings. String comparison is lexicographically
 * correct for zero-padded ISO dates without parsing to a Date object —
 * the same assumption check-finding-regression-pins.mjs's loadAllowlist /
 * loadGrandfatherManifest already enforce via their `dateRe` validation
 * before any entry reaches this module.
 *
 * This module is deliberately dependency-free (no imports) so both a
 * scripts/ gate and a future packages/dogfood-swarm/ compiler can import it
 * without creating a new workspace edge for a three-line comparison.
 */

/**
 * Pure predicate: is `entry` due for revalidation as of `today`?
 *
 * @param {{ revalidate_by: string }} entry - an ISO 'YYYY-MM-DD' date string.
 * @param {string} today - an ISO 'YYYY-MM-DD' date string.
 * @returns {boolean}
 */
export function isDueForRevalidation(entry, today) {
  return entry.revalidate_by < today;
}

/**
 * Today's date as an ISO 'YYYY-MM-DD' string (UTC) — the same computation
 * check-finding-regression-pins.mjs's runRegressionPinGate already performs
 * inline (`new Date().toISOString().slice(0, 10)`), now the single source so
 * a future caller does not silently pick a different clock/format.
 *
 * @returns {string}
 */
export function defaultToday() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Given a list of ids and a lookup map of id -> entry (each entry carrying
 * at least `{ revalidate_by, owner }`), return the projected
 * `{ id, revalidate_by, owner }` rows for every id whose entry is due for
 * revalidation as of `today`. This is the exact operation both
 * check-finding-regression-pins.mjs call sites (the allowlist due-list and
 * the grandfathered-manifest due-list) perform today, and the one T6's
 * roadmap drain-queue section needs for its own two target sets
 * (grandfathered manifest + deferred findings).
 *
 * An id present in `ids` but absent from `entryById` is silently skipped
 * (defensive — this module has no opinion on why an id might be missing its
 * entry; callers that need to treat that as an error should check for it
 * themselves before calling this function).
 *
 * @param {string[]} ids
 * @param {Record<string, { revalidate_by: string, owner: string }>} entryById
 * @param {string} [today] - defaults to defaultToday().
 * @returns {{ id: string, revalidate_by: string, owner: string }[]}
 */
export function selectDueForRevalidation(ids, entryById, today = defaultToday()) {
  return ids
    .map((id) => ({ id, entry: entryById[id] }))
    .filter(({ entry }) => entry && isDueForRevalidation(entry, today))
    .map(({ id, entry }) => ({ id, revalidate_by: entry.revalidate_by, owner: entry.owner }));
}
