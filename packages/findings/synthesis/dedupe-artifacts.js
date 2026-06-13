/**
 * Deduplication for derived synthesis-artifact candidates (patterns /
 * recommendations / doctrine).
 *
 * F2-INTEL-002 — the artifact analogue of `derive/dedupe.js`
 * `dedupeAgainstExisting`. Re-running `findings <type> derive --write` produces
 * the SAME deterministic ids as the prior run. At HEAD the writers would
 * silently overwrite the on-disk file via `atomicWriteFileSync`, so an artifact
 * the operator had already accepted / rejected / invalidated would be reset to a
 * fresh `candidate` — erasing the operator's decision and re-breaking the loop
 * that F2-INTEL-001 closed.
 *
 * Dedupe law (identical to the findings dedupe semantics):
 *   - id not on disk            → write (new artifact)
 *   - id on disk, status candidate → write (refresh the machine output)
 *   - id on disk, NON-candidate status (reviewed/accepted/rejected/invalidated)
 *                                → COLLISION, do NOT overwrite. The operator's
 *                                  decision is load-bearing and survives.
 *
 * The decision is intentionally the conservative one the findings layer already
 * makes: preserve the operator's status by skipping the re-write entirely. The
 * refreshed machine content is discarded for a promoted artifact rather than
 * merged, because merging fresh `candidate`-shaped content into an `accepted`
 * artifact would silently mutate what the operator signed off on.
 */

/**
 * @param {Array<object>} candidates - Freshly-derived artifact candidates.
 * @param {Array<{ data: object }>} existing - Already-loaded on-disk artifacts
 *   (e.g. `loadPatternsWithSkips(rootDir).entries`).
 * @param {string} idKey - The artifact's id field ('pattern_id' |
 *   'recommendation_id' | 'doctrine_id').
 * @returns {{ toWrite: Array<object>, skippedUnchanged: number, collisions: Array<{ id: string, existingStatus: string }> }}
 */
export function dedupeArtifactsAgainstExisting(candidates, existing, idKey) {
  const existingById = new Map();
  for (const e of existing || []) {
    const data = e?.data;
    if (data && data[idKey]) existingById.set(data[idKey], data);
  }

  const toWrite = [];
  let skippedUnchanged = 0;
  const collisions = [];

  for (const c of candidates) {
    const id = c?.[idKey];
    const prior = id != null ? existingById.get(id) : undefined;

    if (!prior) {
      toWrite.push(c);
      continue;
    }

    // Same id exists — the operator's status is the gate.
    if (prior.status !== 'candidate') {
      // Promoted artifact: collision, never overwrite.
      collisions.push({ id, existingStatus: prior.status });
      continue;
    }

    // Still a candidate on disk — refresh the machine output.
    toWrite.push(c);
  }

  return { toWrite, skippedUnchanged, collisions };
}
