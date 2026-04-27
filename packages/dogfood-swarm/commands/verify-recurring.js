/**
 * verify-recurring.js — `swarm verify-recurring <run-id> [--threshold=N] [--format=...]`
 *
 * **W3-BACK-003 (Phase 7 wave 3).** Sister verb to verify-fixed.
 *
 * Reads findings whose lifecycle in `finding_events` shows multiple
 * `fixed` events across distinct waves — the regression-and-reclaim
 * pattern. A finding marked `[fixed]` in wave 5, then `recurred` in wave 8,
 * then `[fixed]` again in wave 12 is a recurring pattern: same root cause,
 * same anchor, but the fix landed → got reverted → got fixed again. Each
 * cycle is an opportunity for the bug to slip back in.
 *
 * **What we surface:** for every finding the operator sees a row with
 *   - recurrence_count: number of distinct waves with a `fixed` event
 *   - claimed_in_waves: [int] — wave_numbers (not wave_ids) where `fixed`
 *   - regressed_in_waves: [int] — wave_numbers where `recurred` event fired
 *   - the v2 envelope's classification of the *current* anchor state, so
 *     the operator can tell whether the latest fix has held.
 *
 * **Decision rule for "recurring":** the finding's lifecycle includes ≥2
 * distinct waves where event_type='fixed'. One fix-event is the normal
 * case; ≥2 means the fix was reclaimed at least once. We do NOT require
 * `recurred` events between them — the duplicate `fixed` is itself the
 * signal.
 *
 * Output schema: `verify-recurring-delta/v1`. Pattern #8 envelope shared
 * with verify-fixed v2 via lib/verify-classifier-v2.js.
 *
 * Exit codes (mirror verify-fixed v2 contract):
 *   0 — no recurring findings, or every recurring finding currently
 *       classifies `verified` AND offending count ≤ threshold.
 *   1 — offending count (regressed + claimed-but-still-present) >
 *       threshold among recurring findings.
 *   2 — every recurring finding classifies `unverifiable`; pipeline broken.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { atomicWriteFileSync } from '@dogfood-lab/findings/lib/atomic-write.js';

import { openDb } from '../db/connection.js';
import { buildV2Delta } from '../lib/verify-classifier-v2.js';
import { renderVerifyFixedDelta } from '../lib/findings-render.js';
import { logStage } from '../lib/log-stage.js';

const SCHEMA = 'verify-recurring-delta/v1';
const VERB = 'verify-recurring';

/**
 * Load all findings whose lifecycle has ≥2 distinct waves with a `fixed`
 * event. Returns rows enriched with claimed/regressed wave-number arrays.
 *
 * Exported for unit tests so they can seed a synthetic DB and assert the
 * query without going through the CLI.
 */
export function loadRecurringFindings(db, runId) {
  // Step 1: find finding rows with ≥2 distinct fixed-event waves.
  const candidates = db.prepare(`
    SELECT
      f.id            AS row_id,
      f.finding_id    AS finding_id,
      f.fingerprint   AS fingerprint,
      f.severity      AS severity,
      f.category      AS category,
      f.file_path     AS file_path,
      f.line_number   AS line_number,
      f.symbol        AS symbol,
      f.description   AS description,
      f.recommendation AS recommendation,
      f.status        AS status,
      f.last_seen_wave AS last_seen_wave,
      COUNT(DISTINCT e.wave_id) AS fixed_wave_count
    FROM findings f
    JOIN finding_events e ON e.finding_id = f.id AND e.event_type = 'fixed'
    WHERE f.run_id = ?
    GROUP BY f.id
    HAVING fixed_wave_count >= 2
    ORDER BY f.id ASC
  `).all(runId);

  if (candidates.length === 0) return [];

  // Step 2: enrich each candidate with the full event history. We keep the
  // queries inside this function so callers don't have to know the
  // join-shape; the v2 classifier reads the raw finding row.
  const eventsStmt = db.prepare(`
    SELECT e.event_type, w.wave_number
    FROM finding_events e
    JOIN waves w ON w.id = e.wave_id
    WHERE e.finding_id = ?
    ORDER BY w.wave_number ASC, e.id ASC
  `);

  const out = [];
  for (const row of candidates) {
    const events = eventsStmt.all(row.row_id);
    const claimed = [];
    const regressed = [];
    for (const ev of events) {
      if (ev.event_type === 'fixed') claimed.push(ev.wave_number);
      else if (ev.event_type === 'recurred') regressed.push(ev.wave_number);
    }
    // Last `fixed` wave is the closest analogue of v1's
    // originalFixedWave for an anchor-state classification.
    const lastFixedWave = claimed.length ? claimed[claimed.length - 1] : null;
    out.push({
      ...row,
      claimed_in_waves: claimed,
      regressed_in_waves: regressed,
      recurrence_count: claimed.length,
      fixed_wave_id: lastFixedWave,
    });
  }
  return out;
}

/**
 * Run the verify-recurring audit.
 */
export function verifyRecurring(opts) {
  const db = openDb(opts.dbPath);

  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(opts.runId);
  if (!run) {
    throw new Error(`Run not found: ${opts.runId}`);
  }

  const latestWave = db.prepare(
    'SELECT wave_number FROM waves WHERE run_id = ? ORDER BY wave_number DESC LIMIT 1'
  ).get(opts.runId);
  const waveNumber = latestWave?.wave_number ?? null;

  const recurring = loadRecurringFindings(db, opts.runId);

  logStage('verify_recurring_start', {
    component: 'dogfood-swarm',
    runId: opts.runId,
    wave: waveNumber,
    recurring_count: recurring.length,
    threshold: opts.threshold ?? 0,
  });

  const threshold = opts.threshold ?? 0;
  const delta = buildV2Delta({
    verb: VERB,
    schema: SCHEMA,
    runId: opts.runId,
    waveNumber,
    findings: recurring,
    repoRoot: run.local_path,
    threshold,
    entryDecorator: (raw) => ({
      recurrence_count: raw.recurrence_count,
      claimed_in_waves: raw.claimed_in_waves,
      regressed_in_waves: raw.regressed_in_waves,
    }),
  });

  const deltaName = waveNumber != null ? `verify-recurring-${waveNumber}.json` : 'verify-recurring.json';
  const deltaPath = join(opts.outputDir, deltaName);
  if (!existsSync(dirname(deltaPath))) {
    mkdirSync(dirname(deltaPath), { recursive: true });
  }
  atomicWriteFileSync(deltaPath, JSON.stringify(delta, null, 2) + '\n', 'utf-8');

  // Reuse the verify-fixed renderer choke-point — Pattern #8 says the
  // envelope shape is shared, so the renderer is too. The verb tag is
  // visible in the headline and JSON, which is enough disambiguation.
  const output = renderVerifyFixedDelta(delta, opts.format, opts.stream || process.stdout);

  logStage('verify_recurring_complete', {
    component: 'dogfood-swarm',
    runId: opts.runId,
    wave: waveNumber,
    summary: delta.summary,
    threshold: delta.threshold,
    threshold_exceeded: delta.thresholdExceeded,
    delta_path: deltaPath,
    exit_code: delta.exitCode,
  });

  return {
    delta,
    output,
    deltaPath,
    exitCode: delta.exitCode,
  };
}
