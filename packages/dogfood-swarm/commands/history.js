/**
 * history.js — `swarm history <wave-id>|<finding-id>`
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
 *
 * F-e4557bf5: this file now ALSO exports findingHistory()/
 * formatFindingHistory() — the finding-scoped sibling of history()/
 * formatHistory() above, rendering a single finding's finding_events
 * lifecycle (chronological across every wave, not one wave's own
 * wave_state_events). cli.js's cmdHistory dispatches between the two by the
 * shape of its one positional argument (see that function). pad()/
 * truncate() below are shared, exported verbatim, by both render paths.
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

export function pad(s, w) {
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

export function truncate(s, w) {
  if (s.length <= w) return s;
  if (w <= 3) return s.slice(0, w);
  return s.slice(0, w - 3) + '...';
}

/**
 * F-e4557bf5: resulting `findings.status` each event_type deterministically
 * produces — transcribed directly from the write sites, not re-derived by
 * guessing:
 *   - reported/fixed/unverified: lib/fingerprint.js#upsertFindings (the
 *     INSERT-new path, and the two unconditional `UPDATE ... SET status =`
 *     calls for absence-closure/unverified).
 *   - approved/deferred/rejected: cli.js's cmdApprove / disposeFindings.
 *   - reopened: cli.js's transitionFindings — eventType='reopened' but
 *     targetStatus='recurring' are DELIBERATELY different literals (see
 *     transitionFindings' own `eventType` param doc comment). That gap
 *     (the event_type name does not match the status it produces) is
 *     exactly what an operator scanning raw finding_events rows cannot see
 *     without this mapping — the whole reason this table exists.
 *
 * 'recurred' is excluded on purpose: fingerprint.js writes it from TWO
 * branches with two different status effects (classifyFindings' `recurring`
 * vs `recurred_while_closed` buckets), so a static entry would be a guess,
 * not a fact — see RECURRENCE_PRESERVES_STATUS below, which resolves it
 * from the finding's own running history instead.
 *
 * 'operator_closed' is excluded on purpose too: a legal db/schema.js
 * EVENT_TYPES member that no write site in this codebase emits today
 * (cmdClose's --as is narrowed to 'fixed' only, per that function's own
 * F-68cf9b48 comment) — there is no real write site to transcribe from, so
 * this table stays silent on it rather than inventing a value.
 */
const EVENT_RESULT_STATUS = Object.freeze({
  reported: 'new',
  approved: 'approved',
  fixed: 'fixed',
  unverified: 'unverified',
  deferred: 'deferred',
  rejected: 'rejected',
  reopened: 'recurring',
});

/**
 * F-e4557bf5: statuses a 'recurred' event LEAVES UNTOUCHED — transcribed
 * from classifyFindings' own branch condition (lib/fingerprint.js: `if
 * (prior.status === 'deferred' || prior.status === 'rejected')` routes to
 * `recurred_while_closed`, whose upsertFindings write
 * (updateLastSeenPreserveStatus) never assigns `status`). Every OTHER prior
 * status recurring — including 'fixed', DELIBERATELY, per that same file's
 * own comment ("a fixed finding recurring IS new information ... flows
 * through the ordinary recurring path") — goes through `updateRecurring`,
 * which unconditionally sets status='recurring'.
 */
const RECURRENCE_PRESERVES_STATUS = new Set(['deferred', 'rejected']);

/**
 * F-e4557bf5: `swarm history <finding-id>` — render a single finding's full
 * finding_events lifecycle, chronologically. Companion read surface to
 * history()/formatHistory() above (wave-scoped wave_state_events); this one
 * is finding-scoped and spans every wave the finding was ever touched in.
 *
 * finding_id is only unique WITHIN a run (UNIQUE(run_id, finding_id) /
 * (run_id, fingerprint) — db/schema.js), so a bare finding id is searched
 * GLOBALLY across every run by default, matching this verb's one-positional-
 * argument dispatch in cli.js (there is nowhere else for a run id to come
 * from on that path). opts.runId narrows the search when supplied
 * (`--run <run-id>`, the escape hatch for the rare cross-run 8-hex-prefix
 * collision). An absent or ambiguous match fails loud, NAMING the
 * resolution that was attempted, per this finding's own recommendation.
 *
 * @param {object} opts
 * @param {string} opts.findingId
 * @param {string} [opts.runId]
 * @param {string} opts.dbPath
 * @returns {{ findingId: string, runId: string, finding: object, events: object[] }}
 */
export function findingHistory(opts) {
  const db = openDb(opts.dbPath);
  const findingIdUpper = String(opts.findingId).toUpperCase();

  const params = [findingIdUpper];
  let sql = 'SELECT * FROM findings WHERE UPPER(finding_id) = ?';
  if (opts.runId) {
    sql += ' AND run_id = ?';
    params.push(opts.runId);
  }
  const matches = db.prepare(sql).all(...params);

  if (matches.length === 0) {
    const err = new Error(
      opts.runId
        ? `history: finding not found: ${opts.findingId} in run ${opts.runId}`
        : `history: finding not found: ${opts.findingId} (searched across all runs — pass --run <run-id> if you know it)`
    );
    err.code = 'FINDING_NOT_FOUND';
    throw err;
  }
  if (matches.length > 1) {
    const runs = matches.map((m) => m.run_id).join(', ');
    const err = new Error(
      `history: finding id ${opts.findingId} exists in ${matches.length} runs (${runs}) — ` +
      `pass --run <run-id> to disambiguate`
    );
    err.code = 'FINDING_ID_AMBIGUOUS';
    throw err;
  }

  const finding = matches[0];

  const rows = db.prepare(
    `SELECT fe.id, fe.event_type, fe.wave_id, fe.agent_run_id, fe.notes, fe.actor, fe.created_at,
            w.wave_number
     FROM finding_events fe
     LEFT JOIN waves w ON w.id = fe.wave_id
     WHERE fe.finding_id = ?
     ORDER BY fe.created_at ASC, fe.id ASC`
  ).all(finding.id);

  // Thread a running status through the chronological events so 'recurred'
  // (the one event_type with a conditional effect — see
  // RECURRENCE_PRESERVES_STATUS above) resolves against what THIS finding's
  // own history actually shows at that point, never a guess. The first
  // finding_events row for any finding is always 'reported' (upsertFindings'
  // insert path is the only writer that creates a finding_events row with no
  // prior row for that finding_id — every other writer targets an EXISTING
  // findings.id), so `running` is always defined by the time a 'recurred'
  // row (which can only ever be second-or-later) needs it.
  let running;
  const events = rows.map((r) => {
    const statusFrom = running;
    let statusTo;
    if (r.event_type === 'recurred') {
      statusTo = RECURRENCE_PRESERVES_STATUS.has(running) ? running : 'recurring';
    } else if (Object.prototype.hasOwnProperty.call(EVENT_RESULT_STATUS, r.event_type)) {
      statusTo = EVENT_RESULT_STATUS[r.event_type];
    } else {
      statusTo = undefined; // operator_closed, or any future event_type this table hasn't been taught
    }
    if (statusTo !== undefined) running = statusTo;
    return { ...r, statusFrom, statusTo };
  });

  return { findingId: finding.finding_id, runId: finding.run_id, finding, events };
}

/**
 * F-e4557bf5: text renderer for findingHistory()'s report. Same plain-ASCII
 * fixed-column discipline as formatHistory above — pad/truncate reused
 * verbatim, not re-derived — extended with a WAVE column (this view spans
 * every wave the finding was touched in, unlike formatHistory's single-wave
 * scope) in place of a from_status/to_status pair that finding_events simply
 * does not store (unlike wave_state_events — see findingHistory's own doc
 * comment for why FROM/TO here are DERIVED, not raw columns). Every
 * reason/notes cell routes through escapeReasonForDisplay before rendering,
 * matching formatHistory's own "escape BEFORE truncate" ordering.
 */
export function formatFindingHistory(report) {
  const { finding, events } = report;
  const lines = [];

  lines.push(
    `Finding ${finding.finding_id} (run ${finding.run_id}) — current status: ${finding.status}, ` +
    `severity: ${finding.severity}, category: ${finding.category}`
  );
  lines.push(finding.file_path ? `  ${escapeReasonForDisplay(String(finding.file_path))}` : '  (no file)');
  lines.push('');

  if (events.length === 0) {
    lines.push('No events recorded.');
    return lines.join('\n');
  }

  // WAVE holds a wave_number (small int) or '(none)' for the operator-invoked
  // events (approved/deferred/rejected/reopened/close) that carry no wave_id
  // at all. STATUS_W=12 fits every STATUS.finding value (db/schema.js) with
  // room to spare — 'unverified' (10) is the longest live one — and pad()'s
  // truncate-with-ellipsis fallback protects any future longer status name,
  // the same resilience F-4e4b88f7 established for formatHistory's own
  // FROM_W/TO_W above.
  const WAVE_W = 6;
  const EVENT_W = 17;
  const STATUS_W = 12;
  const TS_W = 19;
  const REASON_W = 60;

  const header =
    pad('WAVE', WAVE_W) + '  ' +
    pad('EVENT', EVENT_W) + '  ' +
    pad('FROM', STATUS_W) + '  ' +
    pad('TO', STATUS_W) + '  ' +
    pad('WHEN', TS_W) + '  ' +
    'REASON';
  const rule = '-'.repeat(WAVE_W + 2 + EVENT_W + 2 + STATUS_W + 2 + STATUS_W + 2 + TS_W + 2 + REASON_W);

  lines.push(header);
  lines.push(rule);

  for (const e of events) {
    const wave = e.wave_number != null ? String(e.wave_number) : '(none)';
    // statusFrom is genuinely absent (not merely falsy) only for the very
    // first event of a finding's history — `== null` (not `===`) so it
    // matches both the initial `undefined` seed and any future null.
    const from = e.statusFrom == null ? '(none)' : e.statusFrom;
    const to = e.statusTo === undefined ? '(unknown)' : e.statusTo;
    const reason = e.notes == null ? '(none)' : escapeReasonForDisplay(String(e.notes));
    const ts = e.created_at || '(unknown)';
    lines.push(
      pad(wave, WAVE_W) + '  ' +
      pad(e.event_type, EVENT_W) + '  ' +
      pad(from, STATUS_W) + '  ' +
      pad(to, STATUS_W) + '  ' +
      pad(ts, TS_W) + '  ' +
      truncate(reason, REASON_W)
    );
  }

  lines.push('');
  lines.push(`(${events.length} ${events.length === 1 ? 'event' : 'events'})`);

  return lines.join('\n');
}
