/**
 * history.js — `swarm history <wave-id>`
 *
 * Operator-facing read surface for wave_state_events: render the full
 * transition chain for a specific wave so the audit record written by
 * transitionWave (including override transitions with operator-supplied
 * reason text) is reachable without raw SQL.
 *
 * Phase 5A wired the audit row (`wave revalidate --apply` records the
 * operator's `--reason` prefixed with `revalidate:`); Phase 5B-0 ships the
 * deep-audit verb that lets a coordinator inspect that record. The
 * reciprocal one-line breadcrumb in `swarm status` (`commands/status.js`)
 * surfaces the existence of interesting history so the operator's natural
 * scan-mode reads through to this verb.
 *
 * Reads via lib/wave-state-machine.js#getWaveTransitionHistory — does NOT
 * re-implement the query.
 *
 * Render contract: plain-ASCII fixed-column table. No ANSI/emoji so the
 * output renders identically under CI plaintext logs, screen-readers, and
 * Markdown. Matches the visual discipline used by D-STRUCT-001 frames in
 * `swarm status`.
 */

import { openDb } from '../db/connection.js';
import { getWaveTransitionHistory } from '../lib/wave-state-machine.js';

/**
 * @param {object} opts
 * @param {number|string} opts.waveId
 * @param {string} opts.dbPath
 * @returns {{ waveId: number, wave: object|null, events: object[] }}
 */
export function history(opts) {
  const db = openDb(opts.dbPath);
  const waveId = Number(opts.waveId);

  if (!Number.isInteger(waveId) || waveId <= 0) {
    throw new Error(`history: wave id must be a positive integer (got ${JSON.stringify(opts.waveId)})`);
  }

  const wave = db.prepare(
    'SELECT id, run_id, phase, wave_number, status FROM waves WHERE id = ?'
  ).get(waveId);

  if (!wave) {
    const err = new Error(`history: wave not found: ${waveId}`);
    err.code = 'WAVE_NOT_FOUND';
    throw err;
  }

  const events = getWaveTransitionHistory(db, waveId);

  return { waveId, wave, events };
}

/**
 * Render the audit chain as a plain-ASCII fixed-column table. The header
 * line + one row per transition. Empty history renders a single
 * "No transitions yet" notice so the no-history case is unambiguous (the
 * common state for a fresh `dispatched` wave whose first state change has
 * not yet landed).
 */
export function formatHistory(report) {
  const { wave, events } = report;
  const lines = [];

  lines.push(`Wave ${wave.id} (run ${wave.run_id}, wave_number ${wave.wave_number}, phase ${wave.phase}) — current status: ${wave.status}`);
  lines.push('');

  if (events.length === 0) {
    lines.push('No transitions yet.');
    return lines.join('\n');
  }

  const FROM_W = 12;
  const TO_W = 12;
  const TS_W = 19;
  const REASON_W = 60;

  const header =
    pad('FROM', FROM_W) + '  ' +
    pad('TO', TO_W) + '  ' +
    pad('WHEN', TS_W) + '  ' +
    'REASON';
  const rule = '-'.repeat(FROM_W + 2 + TO_W + 2 + TS_W + 2 + REASON_W);

  lines.push(header);
  lines.push(rule);

  for (const e of events) {
    const reason = e.reason == null ? '(none)' : String(e.reason);
    const ts = e.created_at || '(unknown)';
    lines.push(
      pad(e.from_status, FROM_W) + '  ' +
      pad(e.to_status, TO_W) + '  ' +
      pad(ts, TS_W) + '  ' +
      truncate(reason, REASON_W)
    );
  }

  lines.push('');
  lines.push(`(${events.length} ${events.length === 1 ? 'transition' : 'transitions'})`);

  return lines.join('\n');
}

function pad(s, w) {
  const str = String(s ?? '');
  if (str.length >= w) return str;
  return str + ' '.repeat(w - str.length);
}

function truncate(s, w) {
  if (s.length <= w) return s;
  if (w <= 3) return s.slice(0, w);
  return s.slice(0, w - 3) + '...';
}
