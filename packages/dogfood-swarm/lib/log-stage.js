/**
 * log-stage.js — structured stage-transition NDJSON helper.
 *
 * Shared helper extracted from packages/ingest/run.js's inline `logStage`
 * for reuse inside dogfood-swarm. The wave-9 ingest fix established the
 * pattern: one JSON object per line on stderr, tagged with `component`
 * + `stage`, so a `grep` of any field across CI/runner logs recovers the
 * full forensic record without needing a log framework.
 *
 * Why stderr (not stdout): commands like `swarm dispatch` and `swarm
 * collect` print structured results on stdout for callers (CLI harness,
 * coordinator) to parse. Diagnostic stage transitions belong on stderr
 * where they don't pollute the parse target.
 *
 * Why NDJSON (not pretty JSON): one event = one line. `grep` works.
 * Stream concatenation is safe. Preserves event ordering across
 * interleaved processes.
 *
 * F-129818-013 (wave-17): JSON path is preserved unchanged for pipe
 * contexts. A human-readable companion banner is ADDITIVELY emitted
 * after the JSON line when stderr is a TTY OR DOGFOOD_LOG_HUMAN=1 is
 * set. Both still go to stderr; consumers parsing JSON keep working.
 *
 * Guard discipline: every console.error call in this function is
 * individually wrapped in its own try/catch — logStage is the operator's
 * last forensic channel and must never throw, even when stderr itself is
 * PERSISTENTLY (not just transiently) broken. Four call sites, each
 * independently guarded:
 *   1. the serialization-failure fallback's structured attempt
 *   2. that fallback's OWN last-resort literal (F-542caea3 — the gap one
 *      level deeper than #3 below, closed the same wave this comment
 *      was added)
 *   3. the ordinary successful-serialization write (F-36fdebca)
 *   4. the human-banner companion write
 * A fix to any ONE of these must never assume a sibling's try/catch covers
 * it — each is its own last-resort and needs its own guard.
 *
 * Override env var:
 *   DOGFOOD_LOG_HUMAN=1 — force human banner even when piped
 *   DOGFOOD_LOG_HUMAN=0 — suppress human banner even at TTY
 *
 * @example
 *   logStage('isolate_failed', {
 *     component: 'dogfood-swarm',
 *     err: e.message,
 *     runId,
 *     domain: 'backend',
 *   });
 */
export function logStage(stage, fields = {}) {
  const line = {
    ts: new Date().toISOString(),
    component: fields.component || 'dogfood-swarm',
    stage,
    ...fields,
  };
  // Re-set component last so the caller's explicit value survives spreads
  // that might have included a different `component`. Then strip the
  // accidental duplicate from the leading default by deleting the
  // intermediate key — but since spread preserves last-wins, the order
  // above is already correct: component-default → fields-overrides.

  // D3B-021 (Wave A2 Stage C): wrap JSON.stringify in safeStringify so a
  // circular reference, BigInt field, or other non-serializable value in
  // the caller-supplied fields cannot crash the logger itself. The logger
  // is the operator's last forensic channel — it MUST never throw.
  let serialized;
  let serializationFailed = null;
  try {
    serialized = JSON.stringify(line);
    if (serialized === undefined) {
      // JSON.stringify returns undefined for a top-level non-serializable
      // value (e.g. a Symbol). Treat that as a serialization failure too.
      serializationFailed = new Error('JSON.stringify returned undefined');
    }
  } catch (e) {
    serializationFailed = e;
  }

  if (serializationFailed) {
    // Emit a known-safe structured fallback line so NDJSON consumers see
    // the failure as a typed event rather than no event at all (the latter
    // is the silent-degradation pattern this fix exists to prevent).
    const fallback = {
      ts: new Date().toISOString(),
      component: line.component,
      stage: 'log_stage_serialization_failed',
      kind: 'log_stage_serialization_failed',
      original_stage: typeof stage === 'string' ? stage : '(non-string)',
      error: truncate(String(serializationFailed.message || serializationFailed), 240),
    };
    try {
      console.error(JSON.stringify(fallback));
    } catch {
      // Absolute last-resort: a fixed-shape literal that is known to
      // serialize. Operator at least sees that SOMETHING tried to log.
      //
      // F-542caea3: this write is ITSELF wrapped in its own try/catch. A
      // PERSISTENTLY (not merely transiently) broken stderr — the realistic
      // EPIPE condition, which breaks every subsequent write, not just the
      // first — used to throw straight out of this catch block, escaping
      // logStage() entirely from its own deepest fallback. There is no
      // further channel to hand this failure to, so the catch here is
      // empty: logStage still returns normally rather than propagating a
      // write failure over output it does not control.
      try {
        console.error(
          '{"stage":"log_stage_serialization_failed","kind":"log_stage_serialization_failed","error":"unable to serialize fallback"}'
        );
      } catch {
        // Truly nothing further to do — see the comment above.
      }
    }
    return;
  }

  // F-36fdebca: this is the ORDINARY, successful-serialization exit path —
  // every OTHER console.error call in this function is already guarded (the
  // serialization-failure fallback above; the human-banner call below,
  // "Banner failure must not crash the logger"). This was the one gap. A
  // closed/broken stderr pipe (EPIPE) throws synchronously from
  // console.error itself, not asynchronously — proven live for the identical
  // shape at packages/verify/validators/provenance.js's defaultOnRetryWarn
  // (F-f50e779b), which this mirrors. logStage is the operator's last
  // forensic channel and must never crash its caller over a write it does
  // not control.
  try {
    console.error(serialized);
  } catch {
    // Nothing further to do: this IS the fallback-of-last-resort for a
    // successfully-serialized line — there is no more-fundamental channel to
    // hand the failure to (contrast the serialization-failure branch above,
    // which exists to recover the INPUT; this is the OUTPUT stream itself
    // failing).
  }

  if (shouldEmitHuman()) {
    try {
      console.error(formatHumanBanner(line));
    } catch {
      // Banner failure must not crash the logger; NDJSON line already
      // landed above, which is the load-bearing surface.
    }
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

/**
 * Decide whether to emit the human-readable companion banner.
 * Order:
 *   1. DOGFOOD_LOG_HUMAN=0 → never
 *   2. DOGFOOD_LOG_HUMAN=1 → always
 *   3. process.stderr.isTTY === true → emit
 *   4. otherwise → suppress
 *
 * Exported for test injection — tests can call this to verify decision
 * matrix without spinning up child processes.
 */
export function shouldEmitHuman() {
  const env = process.env.DOGFOOD_LOG_HUMAN;
  if (env === '0') return false;
  if (env === '1') return true;
  return process.stderr.isTTY === true;
}

/**
 * Build the human-readable companion line from a structured NDJSON object.
 * Format: `[<component>:<stage>] <one-line summary>`
 *
 * The summary surfaces the most useful per-stage fields without parsing
 * the JSON. F-129818-014 (chained-narrative): banners for related stages
 * (dispatch_received → verify_complete (rejected) → rejected_pre_persist)
 * read coherently in sequence.
 *
 * Exported for test injection so the chain test can build expected text
 * without relying on stderr capture.
 */
export function formatHumanBanner(line) {
  const component = line.component || 'dogfood-swarm';
  const stage = line.stage || 'unknown';
  const summary = buildSummary(line);
  return `[${component}:${stage}] ${summary}`;
}

function buildSummary(line) {
  const parts = [];

  // Narrative: rejection / failure / error tags surface FIRST so a
  // tailing operator can see "this stage failed" before scanning fields.
  if (line.status === 'rejected' || line.rejected === true) {
    parts.push('REJECTED');
  } else if (line.error || line.err) {
    parts.push('ERROR');
  } else if (line.passed === false) {
    parts.push('FAILED');
  } else if (line.status === 'pass' || line.passed === true) {
    parts.push('OK');
  }

  // Identity fields — narrow first, broad last.
  // FT-PIPELINE-004 + W2-BACK-007: correlation_id is appended last in this
  // block so the verdict + agent + run identity surface FIRST and the
  // forensic anchor surfaces at the tail of the banner. Single grep across
  // dispatch / collect / receipt stderr resolves the same coord-<ts>-<rand>
  // back to one originating event.
  const idFields = [
    ['domain',         line.domain],
    ['agent',          line.agent_id || line.agentId],
    ['run',            line.run_id || line.runId],
    ['wave',           line.wave_id || line.waveId],
    ['submission',     line.submission_id || line.submissionId],
    ['correlation_id', line.correlation_id || line.correlationId],
    // F-de9c9160: the four confirm_id_reuse_* stages (lib/fingerprint.js's
    // honorReusedFindingIds) carry their own identity vocabulary that none
    // of the fields above recognized, so all four fell through to the bare
    // '(no fields)' banner below. Each field renders under its OWN label —
    // never folded together via `||` — because confirm_id_reuse_file_mismatch
    // populates BOTH finding_file and prior_file at once: the mismatch IS
    // the two values disagreeing, so collapsing them into one slot would
    // hide the exact thing the banner exists to show an operator.
    ['declared_id',          line.declared_id],
    ['declaring_domain',     line.declaring_domain],
    ['prior_status',         line.prior_status],
    ['file',                 line.file],
    ['finding_file',         line.finding_file],
    ['prior_file',           line.prior_file],
    ['prior_fingerprint',    line.prior_fingerprint],
    ['replaced_fingerprint', line.replaced_fingerprint],
  ];
  for (const [k, v] of idFields) {
    if (v != null && v !== '') parts.push(`${k}=${v}`);
  }

  // Reason / cause — short prose
  if (line.reason) parts.push(`reason=${line.reason}`);
  if (Array.isArray(line.rejection_reasons) && line.rejection_reasons.length > 0) {
    const first = String(line.rejection_reasons[0]).slice(0, 80);
    const more = line.rejection_reasons.length - 1;
    parts.push(more > 0 ? `first_reason="${first}" (+${more} more)` : `reason="${first}"`);
  }
  if (line.rejection_reason_count != null && !line.rejection_reasons) {
    parts.push(`rejection_count=${line.rejection_reason_count}`);
  }
  if (line.err) parts.push(`err="${String(line.err).slice(0, 120)}"`);
  if (line.error && typeof line.error === 'string') parts.push(`error="${line.error.slice(0, 120)}"`);

  // Duration — last
  if (line.duration_ms != null) parts.push(`${line.duration_ms}ms`);

  return parts.join(' ') || '(no fields)';
}
