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
  console.error(JSON.stringify(line));

  if (shouldEmitHuman()) {
    console.error(formatHumanBanner(line));
  }
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

  // Identity fields — narrow first, broad last
  const idFields = [
    ['domain',         line.domain],
    ['agent',          line.agent_id || line.agentId],
    ['run',            line.run_id || line.runId],
    ['wave',           line.wave_id || line.waveId],
    ['submission',     line.submission_id || line.submissionId],
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
