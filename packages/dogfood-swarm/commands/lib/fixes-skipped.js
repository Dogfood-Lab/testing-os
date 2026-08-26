/**
 * fixes-skipped.js — durable wave-level rollup of amend fixes[] refusals.
 *
 * applyDeclaredFixes already records unknown_id / not_approved / unowned /
 * already_closed on the ephemeral collect report (GitHub #65 / F-64e6da30).
 * That signal never reached status/receipt, so a wave that evaporated
 * declarations still looked clean. Persist the rollup in kv (no schema
 * migration — same seam as wave:<id>:skip_verify and roadmap seed lineage)
 * and let status/receipt/cli read it back after collect's stdout scrolls past.
 */

export const FIXES_SKIPPED_KV_PREFIX = 'fixes_skipped:wave:';

/** Cap on distinct finding_ids shown in status/receipt sample lines. */
export const SAMPLE_ID_CAP = 12;

const KNOWN_REASONS = ['unknown_id', 'not_approved', 'unowned', 'already_closed'];

/**
 * @param {Array<{ finding_id: string, reason: string, domain?: string, status?: string }>} entries
 * @returns {{
 *   total: number,
 *   by_reason: Record<string, number>,
 *   sample_ids: string[],
 *   agents: Array<{ domain: string, skipped: Array<{ finding_id: string, reason: string, status?: string }> }>
 * }}
 */
export function rollupFixesSkipped(entries) {
  const by_reason = Object.fromEntries(KNOWN_REASONS.map(r => [r, 0]));
  const sample_ids = [];
  const seenIds = new Set();
  const byDomain = new Map();

  for (const e of entries) {
    if (!e || !e.finding_id || !e.reason) continue;
    by_reason[e.reason] = (by_reason[e.reason] || 0) + 1;
    if (sample_ids.length < SAMPLE_ID_CAP && !seenIds.has(e.finding_id)) {
      seenIds.add(e.finding_id);
      sample_ids.push(e.finding_id);
    }
    const domain = e.domain || '(unknown)';
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    const item = { finding_id: e.finding_id, reason: e.reason };
    if (e.status) item.status = e.status;
    byDomain.get(domain).push(item);
  }

  const agents = [...byDomain.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain, skipped]) => ({ domain, skipped }));

  return {
    total: entries.length,
    by_reason,
    sample_ids,
    agents,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} waveId
 * @param {ReturnType<typeof rollupFixesSkipped>} rollup
 */
export function persistWaveFixesSkipped(db, waveId, rollup) {
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    `${FIXES_SKIPPED_KV_PREFIX}${waveId}`,
    JSON.stringify(rollup),
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} waveId
 * @returns {ReturnType<typeof rollupFixesSkipped> | null}
 */
export function readWaveFixesSkipped(db, waveId) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?')
    .get(`${FIXES_SKIPPED_KV_PREFIX}${waveId}`);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed.total !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * One-line operator summary for status / collect banner / receipt markdown.
 * @param {ReturnType<typeof rollupFixesSkipped>} rollup
 * @returns {string}
 */
export function formatFixesSkippedSummary(rollup) {
  if (!rollup || !rollup.total) return '';
  const parts = KNOWN_REASONS
    .filter(r => (rollup.by_reason[r] || 0) > 0)
    .map(r => `${r}=${rollup.by_reason[r]}`);
  const extra = Object.keys(rollup.by_reason || {})
    .filter(r => !KNOWN_REASONS.includes(r) && rollup.by_reason[r] > 0)
    .map(r => `${r}=${rollup.by_reason[r]}`);
  const reasonPart = [...parts, ...extra].join(' ') || `total=${rollup.total}`;
  const sample = (rollup.sample_ids || []).slice(0, SAMPLE_ID_CAP).join(', ');
  const samplePart = sample ? `; sample: ${sample}` : '';
  return `${rollup.total} fixes[] declaration(s) skipped (${reasonPart})${samplePart}`;
}
