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
 * `swarm status`. Enforced, not just documented, as of F-7c3e91a4 (wave 18):
 * every `reason` cell routes through escapeReasonForDisplay before
 * rendering, so an operator-supplied --reason (unrestricted free text, no
 * character validation upstream) cannot inject a raw newline, ANSI escape,
 * or other control byte into this table.
 */

import { openDb } from '../db/connection.js';
import { getWaveTransitionHistory } from '../lib/wave-state-machine.js';
import { escapeReasonForDisplay } from './lib/escape-reason.js';

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

  // F-4e4b88f7: 19 fits 'aborted_for_rewind' — the longest status
  // wave-state-machine.js's transitionWave ever writes to wave_state_events
  // (pending/dispatched/collected/verified/advanced/failed/collecting/
  // aborted_for_rewind) — with zero truncation in the common case. pad()'s
  // truncate-with-ellipsis fallback (below) is the actual fix for the class:
  // it protects any FUTURE status name longer than this width too, instead
  // of re-earning this same finding the next time the state machine grows a
  // longer name.
  const FROM_W = 19;
  const TO_W = 19;
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
    // F-7c3e91a4: escape BEFORE truncate, not after — truncate() is a plain
    // String#slice with no control-byte awareness of its own, so by the
    // time the reason reaches it every dangerous byte must already be gone.
    // Escaping first also means the REASON_W column budget is spent on the
    // operator-VISIBLE (escaped) text, matching what actually prints.
    const reason = e.reason == null ? '(none)' : escapeReasonForDisplay(String(e.reason));
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
  // F-4e4b88f7: a status name >= the column width used to return unpadded AND
  // untruncated, silently breaking the fixed-column contract for that one row
  // (every column after it desyncs from the header and every sibling row).
  // truncate() already guarantees an exactly-w-length result when str.length > w
  // (either the w<=3 slice branch or the `slice(0, w-3) + '...'` branch), so
  // this stays symmetric with the REASON column's existing shrink behavior for
  // ANY status name, not just the ones known when FROM_W/TO_W were chosen.
  if (str.length > w) return truncate(str, w);
  if (str.length === w) return str;
  return str + ' '.repeat(w - str.length);
}

function truncate(s, w) {
  if (s.length <= w) return s;
  if (w <= 3) return s.slice(0, w);
  return s.slice(0, w - 3) + '...';
}
