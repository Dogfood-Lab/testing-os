/**
 * Custom error classes for dogfood-swarm.
 *
 * Mirrors the @dogfood-lab/ingest RecordValidationError pattern: structured
 * subclasses of Error with a stable `code` so callers can `instanceof` or
 * pattern-match on `.code` instead of substring-matching `.message`.
 *
 * Why centralized: errors that cross module boundaries (e.g. createWorktree
 * failure surfacing through dispatch into the CLI) need a stable shape so
 * the CLI can decide exit code, and tests can assert behaviour without
 * coupling to message text.
 */

/**
 * Thrown when --isolate is requested but worktree creation fails.
 *
 * Pre-fix history: dispatch.js had a bare `try { createWorktree() } catch {}`
 * that silently fell back to running the agent in the main repo. Operator
 * believed isolation was in effect; every wave actually shared the workspace.
 * This was a re-emergence of F-742440-007 (wave-1).
 *
 * The wave-12 fix throws this typed error instead. The CLI layer is
 * responsible for catching, surfacing the message, and exiting non-zero —
 * NEVER silent fallback. Isolation is a contract; if the operator passed
 * --isolate the only valid responses are "isolated" or "loud failure".
 */
export class IsolationError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {Error} [opts.cause] — the underlying error from createWorktree
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'IsolationError';
    this.code = 'ISOLATION_FAILED';
    if (opts.cause) this.cause = opts.cause;
  }
}

/**
 * Thrown when collect's findings upsert transaction fails.
 *
 * Pre-fix history: collect.js called upsertFindings with no try/catch. If
 * the inner SQLite transaction threw (busy_timeout exhaustion, fingerprint
 * UNIQUE collision, prepared-statement crash), the throw escaped collect
 * AFTER artifact rows + file_claims + agent state transitions had already
 * been committed but BEFORE the wave-status UPDATE ran. The control plane
 * was left in an inconsistent half-written state that `swarm resume` could
 * not recover (resume only redispatches non-complete agents).
 *
 * The wave-12 fix surfaces this typed error so the CLI can exit non-zero.
 * SQLite's transactional guarantee is preserved at the upsert level (the
 * tx wrapper inside upsertFindings is atomic); the wrapper here adds an
 * audit trail and fail-loud propagation rather than silent partial-write.
 */
export class CollectUpsertError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {Error} [opts.cause]
   * @param {number|string} [opts.waveId]
   * @param {number} [opts.findingsAttempted]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'CollectUpsertError';
    this.code = 'COLLECT_UPSERT_FAILED';
    if (opts.cause) this.cause = opts.cause;
    if (opts.waveId != null) this.waveId = opts.waveId;
    if (opts.findingsAttempted != null) this.findingsAttempted = opts.findingsAttempted;
  }
}

/**
 * Thrown by transitionAgent when a state-machine transition is rejected.
 *
 * Pre-fix history (F-091578-002): the rejection path threw a bare
 * `new Error('Illegal transition: ${check.reason}')`, leaking internal
 * state-machine vocabulary ("`complete` is terminal — no transitions
 * allowed") to operators with no class differentiator and no actionable
 * hint. An operator hitting this had no way to tell whether the rejection
 * was their problem (BLOCKED — needs override), the program's problem
 * (TERMINAL — caller bug), or a missing edge in TRANSITIONS (INVALID —
 * legitimate disallowed transition).
 *
 * The wave-17 fix routes every rejection through this typed error with a
 * `code` field (`BLOCKED` / `TERMINAL` / `INVALID`) so the CLI's top-level
 * handler can render a code-specific actionable hint. Sibling concept to
 * IsolationError + CollectUpsertError: structured shape > prose-only.
 */
export class StateMachineRejectionError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {'BLOCKED' | 'TERMINAL' | 'INVALID'} opts.kind
   * @param {string} opts.from
   * @param {string} opts.to
   * @param {number|string} [opts.agentRunId]
   * @param {string} [opts.hint] — actionable next-step text
   * @param {string[]} [opts.allowedTransitions] — legal `to` set from `from`
   */
  constructor(message, opts) {
    super(message);
    this.name = 'StateMachineRejectionError';
    this.code = `STATE_MACHINE_${opts.kind}`;
    this.kind = opts.kind;
    this.from = opts.from;
    this.to = opts.to;
    if (opts.agentRunId != null) this.agentRunId = opts.agentRunId;
    if (opts.hint) this.hint = opts.hint;
    if (opts.allowedTransitions) this.allowedTransitions = opts.allowedTransitions;
  }
}
