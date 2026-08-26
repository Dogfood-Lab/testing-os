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
 * Thrown when a `swarm dispatch` precondition fails (missing run, frozen-
 * domain check, missing domains).
 *
 * Pre-fix history (D3B-003, Wave A2 Stage C): dispatch threw bare
 * `new Error('Run not found: ...')` / `new Error('Domains are not
 * frozen...')` strings that left the CLI's top-level handler with no
 * stable signal to render an actionable hint. The typed shape carries a
 * stable .code so consumers can pattern-match without substring grep on
 * .message, mirroring IsolationError / StateMachineRejectionError.
 *
 * Codes (wave 43 correction — this list previously named only 4 of the 7
 * live call sites in commands/dispatch.js, source-verified by direct grep
 * this wave; the same doc-vs-runtime-drift-inside-a-comment class as
 * F-2f7dd0ce/F-ab4fbab0):
 *   DISPATCH_RUN_NOT_FOUND         — `runs.id` does not exist
 *   DISPATCH_DOMAINS_NOT_FROZEN    — domains still draft, no --auto-freeze
 *   DISPATCH_NO_DOMAINS            — frozen but the domain set is empty
 *   DISPATCH_INVALID_PHASE         — phase not in AUDIT_PHASES ∪ AMEND_PHASES
 *                                    (d5-swarm-cli-001: caught BEFORE buildWave
 *                                    mutates the control plane, replacing the
 *                                    post-commit untyped `Unknown audit phase`
 *                                    throw from lib/templates.js)
 *   DISPATCH_NO_AGENT_DOMAINS      — every domain in the frozen map is class
 *                                    'shared' (a zone, not an agent) — zero
 *                                    agent_runs would be created and the wave
 *                                    would permanently block future dispatch
 *                                    on DISPATCH_WAVE_IN_FLIGHT below, since a
 *                                    zero-agent wave can never collect
 *   DISPATCH_WAVE_IN_FLIGHT        — an older wave of this run is still
 *                                    'dispatched'/'collecting'; collect/
 *                                    resume/advance only operate on the
 *                                    LATEST wave, so a second dispatch would
 *                                    strand it (F-cf8b7a6c)
 *   DISPATCH_ROADMAP_DIGEST_NOT_FOUND — T4's `--seed-from-roadmap` opt-in
 *                                    (docs/trajectory-and-closure.dispatch.md)
 *                                    names a run with no compiled roadmap
 *                                    artifact to seed the digest from. Lands
 *                                    from swarm-cp-verbs' wave-43 worktree
 *                                    (parallel to this fix, invisible in this
 *                                    domain's own tree before merge) — cited
 *                                    here per this wave's cross-domain
 *                                    coordination so this list is accurate at
 *                                    the merged commit, not merely today's.
 */
export class DispatchPreconditionError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {'DISPATCH_RUN_NOT_FOUND' | 'DISPATCH_DOMAINS_NOT_FROZEN' | 'DISPATCH_NO_DOMAINS' | 'DISPATCH_INVALID_PHASE' | 'DISPATCH_NO_AGENT_DOMAINS' | 'DISPATCH_WAVE_IN_FLIGHT' | 'DISPATCH_ROADMAP_DIGEST_NOT_FOUND'} opts.code
   * @param {string} [opts.runId]
   * @param {string} [opts.phase]
   * @param {string} [opts.hint]
   */
  constructor(message, opts) {
    super(message);
    this.name = 'DispatchPreconditionError';
    this.code = opts.code;
    if (opts.runId != null) this.runId = opts.runId;
    if (opts.phase != null) this.phase = opts.phase;
    if (opts.hint) this.hint = opts.hint;
  }
}

/**
 * Thrown when `swarm <verb> --globs <JSON>` cannot be parsed (or the
 * parsed value has the wrong shape).
 *
 * Pre-fix history (D3B-004, Wave A2 Stage C): cli.js wrapped
 * `JSON.parse(args[idx+1])` with no try/catch and no shape check. An
 * operator typo yielded a raw `SyntaxError: Unexpected token ...` at
 * stderr with no actionable hint. The typed shape gives the top-level
 * renderer something to bind a clear "expected JSON array of strings"
 * message to.
 *
 * Codes:
 *   CLI_INVALID_GLOBS_JSON  — the JSON.parse call threw OR the parsed
 *                             value is not a non-empty array of strings
 */
export class CliInvalidGlobsError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.received] — the raw input string (may be truncated)
   * @param {string} [opts.cause]    — the inner JSON.parse error message
   * @param {string} [opts.hint]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'CliInvalidGlobsError';
    this.code = 'CLI_INVALID_GLOBS_JSON';
    if (opts.received != null) this.received = opts.received;
    if (opts.cause) this.cause = opts.cause;
    if (opts.hint) this.hint = opts.hint;
  }
}

/**
 * Thrown when `swarm domains --add/--edit --ownership <value>` names a class
 * outside STATUS.ownership_class.
 *
 * Pre-fix history (F-969074b9): editDomain/addDomain threw bare
 * `new Error('Invalid ownership class: …')` that named the bad value but
 * never listed the live enum (owned|shared|bridge|coordinator), and had no
 * `.code`/`.hint`, so renderTopLevelError flattened them to untyped
 * `ERROR: …` with no Next: line. Sibling DISPATCH_INVALID_PHASE already
 * enumerates valid phases in both throw-site hint and deriveHintForCode.
 */
export class DomainsInvalidOwnershipError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {string} opts.received — the rejected ownership_class value
   * @param {string[]} opts.valid — live STATUS.ownership_class snapshot
   * @param {string} [opts.hint]
   */
  constructor(message, opts) {
    super(message);
    this.name = 'DomainsInvalidOwnershipError';
    this.code = 'DOMAINS_INVALID_OWNERSHIP_CLASS';
    this.received = opts.received;
    this.valid = opts.valid;
    this.hint = opts.hint
      || `pass one of ${opts.valid.join('|')} — e.g. \`--ownership owned\``;
  }
}

/**
 * Thrown by openDb when the on-disk control-plane.db was written by a NEWER
 * @dogfood-lab/dogfood-swarm build than the one running.
 *
 * Pre-fix history (F4-CP-03 / F5-07): connection.js's `version >
 * SCHEMA_VERSION` branch threw a BARE `new Error(...)` with no `.code`/`.hint`,
 * so error-render.js flattened it to the untyped `ERROR: <msg>` single-line
 * shape instead of the `ERROR [<CODE>]:` structured envelope every sibling
 * code gets. error-codes.md already DOCUMENTED `CONTROL_PLANE_SCHEMA_TOO_NEW`
 * but had to caveat it as "plain Error (no .code field yet)" with a Follow-ups
 * note. This typed class closes that gap: the refusal is fail-closed (openDb
 * closes the handle + drops it from the pool before throwing — no write
 * happens against the unknown-newer shape), mirroring the IsolationError /
 * StateMachineRejectionError structured-shape discipline.
 *
 * Recovery is to UPGRADE THE TOOL, not the DB — the on-disk state is the
 * newer build's correct migrated state, not corruption. The `hint` says so.
 */
export class ControlPlaneSchemaTooNewError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {number} opts.onDiskVersion — schema_version read from the DB's kv table
   * @param {number} opts.buildVersion  — SCHEMA_VERSION this build understands
   * @param {string} [opts.dbPath]      — the refused DB path (log correlation)
   * @param {string} [opts.hint]        — override the default build-upgrade hint
   */
  constructor(message, opts) {
    super(message);
    this.name = 'ControlPlaneSchemaTooNewError';
    this.code = 'CONTROL_PLANE_SCHEMA_TOO_NEW';
    this.onDiskVersion = opts.onDiskVersion;
    this.buildVersion = opts.buildVersion;
    if (opts.dbPath != null) this.dbPath = opts.dbPath;
    this.hint = opts.hint
      || 'Pull the latest @dogfood-lab/dogfood-swarm so your build SCHEMA_VERSION >= the on-disk control-plane version. Do NOT hand-edit or delete the DB — its state is the newer build\'s correctly migrated state, not corruption.';
  }
}

/**
 * Thrown by openDb (via getSchemaVersion) when the on-disk control-plane.db's
 * `kv.schema_version` value is not a finite number.
 *
 * F-9587adda: getSchemaVersion() used to `parseInt(row.value, 10)` and return
 * whatever that produced, including NaN for a non-numeric value. Both
 * downstream comparisons in openDb — `version > SCHEMA_VERSION` (the
 * too-new refusal above) and `version < SCHEMA_VERSION` (the schema-bootstrap
 * gate) — are FALSE for NaN, so a corrupted schema_version silently skipped
 * BOTH: the too-new refusal never fired, and `db.exec(SCHEMA_SQL)` never ran,
 * contradicting this same module's own fail-loud-not-silent discipline
 * (already applied above for the too-new case, and for the dead-handle
 * sentinel in openDb).
 *
 * Recovery is NOT "pull the latest build" (that is ControlPlaneSchemaTooNewError's
 * remedy, for a DIFFERENT condition — a value this build understands perfectly
 * well but that belongs to a newer one). A corrupt kv.value means the row
 * itself is wrong: restore from a known-good backup, or start a fresh control
 * plane at this dbPath if none exists. The two conditions get distinct codes
 * so a caller (or an operator scanning logs) is never told to "upgrade" a DB
 * that is actually just damaged, or vice versa.
 */
export class ControlPlaneSchemaCorruptError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {string} opts.rawValue — the unparseable kv.schema_version value read from disk
   * @param {string} [opts.dbPath] — the refused DB path (log correlation)
   * @param {string} [opts.hint]   — override the default corruption hint
   */
  constructor(message, opts) {
    super(message);
    this.name = 'ControlPlaneSchemaCorruptError';
    this.code = 'CONTROL_PLANE_SCHEMA_CORRUPT';
    this.rawValue = opts.rawValue;
    if (opts.dbPath != null) this.dbPath = opts.dbPath;
    this.hint = opts.hint
      || 'kv.schema_version is not a finite number — the control-plane.db is corrupted or was hand-edited, not merely older/newer. Restore control-plane.db from a known-good backup, or remove it to bootstrap a fresh one (only if this run\'s history is not needed) — do not hand-write schema_version without reading db/migrate.js\'s ledger first.';
  }
}

/**
 * Thrown by buildCriterionIntent (lib/case-file/prism-jury.js) when the
 * MANDATORY head section (rubric.objective + the criterion under test) alone
 * exceeds prism's 4000-char intent cap, before any optional section (evidence,
 * out-of-scope) is even considered.
 *
 * Pre-fix history (F-ca495e53): fits() only ever measured `[head, ...parts]`,
 * so head was a fixed cost the budget was spent against but never itself
 * checked. When head alone overflowed, fits() returned false for every
 * candidate, body stayed empty, and the function returned `intent: head` —
 * still over the cap — while `omitted` reported {evidence:0, out_of_scope:0},
 * i.e. affirmatively claiming nothing was dropped. prism's pydantic
 * max_length=4000 then rejected the request, every seat abstained uniformly,
 * and the operator was told the jury could not reach the artifact
 * (insufficient_context, Director disposition) when the actual cause was a
 * deterministic, locally-detectable input error: their rubric objective (or
 * one criterion's check text) was too long. This directly contradicts the
 * module's own stated discipline: "Anything that does not fit is REPORTED,
 * not silently dropped." An over-cap head was neither reported nor dropped.
 *
 * Fail fast at the case-file boundary instead: this is knowable without
 * spending a single ~27s seat call.
 */
export class CriterionIntentOverflowError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {string} opts.criterionId — the criterion under test when the overflow was found
   * @param {number} opts.headLength — the mandatory section's actual length
   * @param {number} opts.maxChars — prism's intent cap (MAX_INTENT_CHARS)
   * @param {string} [opts.hint] — override the default remediation hint
   */
  constructor(message, opts) {
    super(message);
    this.name = 'CriterionIntentOverflowError';
    this.code = 'CRITERION_INTENT_OVERFLOW';
    this.criterionId = opts.criterionId;
    this.headLength = opts.headLength;
    this.maxChars = opts.maxChars;
    // F-4b72faf9: this class never set `.hint`, so renderTopLevelError printed
    // no "Next:" line even though the thrown `message` embeds the same
    // remediation text inline — every sibling typed error in this file with a
    // self-contained one-line remedy (e.g. ControlPlaneSchemaTooNewError)
    // surfaces it through `.hint` instead of leaving operators to parse it out
    // of the message. Default only; a future throw site can still override.
    this.hint = opts.hint
      || `criterion '${opts.criterionId}': mandatory section is ${opts.headLength} chars ` +
         `(cap ${opts.maxChars}) — shorten the objective, split the criterion, or trim the out-of-scope list`;
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
 *
 * F-e0fb3761 (Wave 18): this doc block previously sat above
 * DispatchPreconditionError instead of above this class — an
 * insertion-ordering slip (DispatchPreconditionError's own comment+class
 * pair was added between this doc and its class, and this class was later
 * relocated to the bottom of the file without its comment following it).
 * Moved here, directly above the class it actually documents. Zero runtime
 * effect either way; see errors-orphaned-jsdoc-placement.test.js.
 */
export class StateMachineRejectionError extends Error {
  /**
   * @param {string} message
   * @param {object} opts
   * @param {'BLOCKED' | 'TERMINAL' | 'INVALID'} opts.kind
   * @param {string} opts.from
   * @param {string} opts.to
   * @param {number|string} [opts.agentRunId] — set by transitionAgent (lib/state-machine.js) rejections
   * @param {number|string} [opts.waveId] — set by transitionWave (lib/wave-state-machine.js)
   *   rejections (F-f4a64538). Mirrors CollectUpsertError's existing `waveId` field so
   *   error-render.js's already-correct `e.waveId` branch renders "Wave: N" instead of
   *   mislabeling a wave id as an agent-run id — the two are separate AUTOINCREMENT
   *   sequences in the same DB. A single throw site should set exactly one of
   *   agentRunId/waveId, matching whichever state machine actually rejected the transition.
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
    if (opts.waveId != null) this.waveId = opts.waveId;
    if (opts.hint) this.hint = opts.hint;
    if (opts.allowedTransitions) this.allowedTransitions = opts.allowedTransitions;
  }
}
