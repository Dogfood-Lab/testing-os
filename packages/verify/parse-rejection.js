/**
 * parse-rejection.js — F1-CONTRACTS-003 (Wave 4, MED)
 *
 * The verifier emits `verification.rejection_reasons` as an array of STRINGS
 * carrying stable prefixes (see verify/README.md → "Prefix taxonomy"). Until
 * now every operator discriminated failure class with hand-rolled
 * `.startsWith()` chains, re-implementing the same taxonomy at each call site —
 * a fresh drift source the moment a prefix is added.
 *
 * `parseRejectionReason(reason)` is the single exported classifier. It maps a
 * raw rejection string to `{ class, prefix, detail, retryable }`:
 *
 *   - class   — the routing decision (who fixes this):
 *       'submission-bad' → the submitter fixes the payload and resubmits
 *       'operational'    → the verifier/tooling faulted; page ops, do NOT
 *                          bounce back to the submitter
 *       'ingest'         → an ingest-side load fault (scenario fetch)
 *       'unknown'        → unrecognized prefix; log + surface raw
 *   - prefix  — the canonical prefix token that matched (e.g. `'schema:'`,
 *               `'steps[<id>]:'`), or `null` for the 'unknown' class.
 *   - detail  — the human-readable remainder with the matched prefix stripped
 *               (for 'unknown', the whole string verbatim).
 *   - retryable — (F-f8952a50, wave 10) may a same-run_id resubmission whose
 *               ONLY prior rejection carries this prefix still reach an
 *               acceptance, once corrected? This is a NARROWER question than
 *               `class`. Every 'operational' / 'ingest' / 'unknown' reason is
 *               `retryable: false` (only the submitter's own payload earns a
 *               retry — an ops fault or an unrecognized signal never does).
 *               Within 'submission-bad', the taxonomy splits further:
 *                 - retryable: true  — the prefix means "we could not even
 *                   read/place/shape your submission" (schema:, repo:,
 *                   unsafe-record-path:, steps[<id>]:, policy-config:,
 *                   submission-contains-verifier-field:,
 *                   CONTRACT_SCHEMA_TOO_NEW:, CONTRACT_SCHEMA_TOO_OLD:) — a
 *                   correction changes nothing about what the run actually
 *                   did, only how it was addressed/formatted/configured.
 *                 - retryable: false — the prefix means "we read your
 *                   submission and rendered a VERDICT against its content"
 *                   (policy:, provenance:) — consuming the run_id is the
 *                   INTENDED anti-gaming behavior: a submitter cannot launder
 *                   a genuinely-failed run into an accepted one by resubmitting
 *                   different self-reported content under the same run_id.
 *                   Pinned end-to-end: schema-invalid-skip-persist.test.js's
 *                   "REGRESSION GUARD: a resubmission after a persisted
 *                   NON-schema rejection is STILL blocked" test (provenance:)
 *                   and f-0f9e4077-retry-collision-duplicate-rejection.test.js's
 *                   "F-f8952a50" describe block (policy: / provenance: cases).
 *               Consumers key off THIS field, never off `prefix` — see
 *               packages/ingest/persist.js's isRetryableRejection().
 *
 * The prefix vocabulary below is enumerated from the ACTUAL emitters — it is
 * NOT invented:
 *   - verify/index.js:                schema:, policy:, policy-config: (VERIFY-F1,
 *                                     repo custom-rule predicate fault → submission-bad),
 *                                     steps[<id>]:,
 *                                     provenance: (run absent → submission-bad),
 *                                     provenance-fault: (provider 429/5xx/401/403
 *                                       → operational), repo:,
 *                                     submission-contains-verifier-field:,
 *                                     submission-malformed:,
 *                                     VALIDATOR_FAULT_<NAME>:
 *   - validators/schema-version.js:   CONTRACT_SCHEMA_TOO_NEW:,
 *                                     CONTRACT_SCHEMA_TOO_OLD:
 *   - packages/ingest/run.js:         scenario-load:,
 *                                     unsafe-record-path: (F-4acd28d8,
 *                                       computeRecordPath's traversal guard
 *                                       rejected a schema-valid repo →
 *                                       submission-bad)
 *   - packages/ingest/load-context.js: scenario-fetch-fault: (V2-CROSS-BO-001,
 *                                     scenario-fetch outage/credential fault
 *                                     → operational)
 *
 * `VALIDATOR_FAULT_*` is matched by family, not by an exhaustive name list, so
 * a future `VALIDATOR_FAULT_<NEW>:` (e.g. the runValidator seam adds a 5th
 * validator) is classified 'operational' without a code change here. The
 * `steps[<id>]:` prefix uses bracket syntax (`steps[step-7]:`), so it is matched
 * by a small regex rather than a literal `.startsWith`.
 */

/**
 * @typedef {'submission-bad' | 'operational' | 'ingest' | 'unknown'} RejectionClass
 */

/**
 * @typedef {object} ParsedRejection
 * @property {RejectionClass} class     Routing decision (who must act).
 * @property {string | null}  prefix    Canonical prefix token, or null when unknown.
 * @property {string}         detail    Human-readable remainder (prefix stripped).
 * @property {boolean}        retryable Whether a same-run_id resubmission whose
 *   ONLY prior rejection carries this prefix may still reach an acceptance.
 *   See the file header for the full submission-bad split (shape/addressing
 *   vs. rendered-verdict).
 */

/**
 * Literal-prefix matchers, ordered most-specific-first. Each carries the
 * canonical prefix token, the routing class, and whether a resubmission past
 * this rejection is retryable (F-f8952a50 — see file header). `match` is the
 * exact string the reason must start with; `detail` is whatever follows it
 * (trimmed of one leading space). `repo:` matches the `repo:mismatch: …`
 * family — the canonical token reported is the stable `repo:` head.
 */
const LITERAL_PREFIXES = [
  // submission-bad, retryable — "we could not even read your submission".
  { match: 'schema:', prefix: 'schema:', class: 'submission-bad', retryable: true },
  // VERIFY-F1: a malformed REPO custom-rule predicate (eval-time semantic fault the
  // schema could not catch). submission-bad — the repo authored the bad policy YAML,
  // so the fix belongs to the submitter, not studio ops. Ordered BEFORE `policy:`
  // to keep the most-specific-first invariant (the tokens don't overlap — `policy:`
  // ends at the colon, `policy-config:` continues with `-config:` — but the order is
  // explicit). A malformed GLOBAL predicate is operational (VALIDATOR_FAULT_POLICY).
  // retryable — the REPO's policy YAML was broken, not a judgment on this run's
  // content; once the repo fixes policies/*.yaml, the identical submission can
  // legitimately evaluate cleanly. Shape/config, not a verdict.
  { match: 'policy-config:', prefix: 'policy-config:', class: 'submission-bad', retryable: true },
  // NOT retryable — a rendered verdict on the run's own reported content
  // (forbidden tags, missing required evidence, a failed custom_rules
  // predicate). Consuming the run_id here is the deliberate anti-gaming
  // behavior: pinned by schema-invalid-skip-persist.test.js's "the
  // persist-a-verdict doctrine is preserved" describe block.
  { match: 'policy:', prefix: 'policy:', class: 'submission-bad', retryable: false },
  // operational — a provider-side provenance FAULT (429/5xx/401/403). The
  // adapter THROWS these (verify-A-002); index.js catches the throw and emits
  // this distinct `provenance-fault:` prefix so the incident pages ops. Ordered
  // before the bare `provenance:` literal — it is a distinct token, but keeping
  // the longer, more-specific match first preserves the most-specific-first
  // invariant the array is sorted by. The genuine not-confirmed case
  // (`provenance: source run could not be confirmed`) stays submission-bad below.
  { match: 'provenance-fault:', prefix: 'provenance-fault:', class: 'operational', retryable: false },
  // submission-bad, NOT retryable — a rendered verdict: the provider could not
  // confirm this specific run happened as claimed. Resubmitting different
  // self-reported content under the same run_id to "become confirmable" is
  // exactly the laundering the anti-gaming doctrine blocks. Pinned by
  // schema-invalid-skip-persist.test.js's REGRESSION GUARD test.
  { match: 'provenance:', prefix: 'provenance:', class: 'submission-bad', retryable: false },
  // submission-bad, retryable — pure identity/addressing: the run happened,
  // only the repo/run_url pairing was mis-stated. Proven live (F-f8952a50): a
  // repo:mismatch correction must reach verify() again, not vanish as a
  // silent duplicate.
  { match: 'repo:', prefix: 'repo:', class: 'submission-bad', retryable: true },
  {
    match: 'submission-contains-verifier-field:',
    prefix: 'submission-contains-verifier-field:',
    class: 'submission-bad',
    retryable: true,
  },
  { match: 'CONTRACT_SCHEMA_TOO_NEW:', prefix: 'CONTRACT_SCHEMA_TOO_NEW:', class: 'submission-bad', retryable: true },
  { match: 'CONTRACT_SCHEMA_TOO_OLD:', prefix: 'CONTRACT_SCHEMA_TOO_OLD:', class: 'submission-bad', retryable: true },
  // submission-bad — F-4acd28d8: the record passed schema validation but its
  // OWN repo identifier is unsafe to file under (computeRecordPath's
  // isUnsafeSegment traversal guard, stricter than the schema's repo
  // pattern — see F-bbbe2e1f). The submitter's repo string is the problem,
  // not the verifier/ingest tooling, so this stays submission-bad.
  // retryable — addressing, not a verdict on the run's content.
  { match: 'unsafe-record-path:', prefix: 'unsafe-record-path:', class: 'submission-bad', retryable: true },
  // operational — a null/non-object submission is a malfunctioning dispatcher
  // (verify-B-003), not a submitter who sent a bad-but-shaped payload. Page ops;
  // do NOT bounce it back to the submitter.
  { match: 'submission-malformed:', prefix: 'submission-malformed:', class: 'operational', retryable: false },
  // operational — the scenario fetcher THREW after exhausting its retry
  // budget (5xx/429 outage, transport reject) or hit a credential fault
  // (401/403). V2-CROSS-BO-001: packages/ingest/load-context.js throws this
  // classified error instead of returning `not_found`, so an outage never
  // rejects a good submission. Ordered before `scenario-load:` to keep the
  // most-specific-first invariant explicit (the tokens do not overlap).
  { match: 'scenario-fetch-fault:', prefix: 'scenario-fetch-fault:', class: 'operational', retryable: false },
  // ingest
  { match: 'scenario-load:', prefix: 'scenario-load:', class: 'ingest', retryable: false },
];

/** Strip a matched literal prefix and one optional leading space from a reason. */
function stripLiteral(reason, match) {
  return reason.slice(match.length).replace(/^\s+/, '');
}

/**
 * Classify a single verifier/ingest rejection-reason string.
 *
 * @param {unknown} reason A rejection string (typically from a persisted
 *   record's `verification.rejection_reasons[]`).
 * @returns {ParsedRejection}
 */
export function parseRejectionReason(reason) {
  if (typeof reason !== 'string') {
    return { class: 'unknown', prefix: null, detail: '', retryable: false };
  }

  // 1. Operational faults — matched by FAMILY so future VALIDATOR_FAULT_<NEW>
  //    classes need no edit here. (runValidator emits `VALIDATOR_FAULT_<CLS>: …`.)
  //    Never retryable — an ops fault is not the submitter's to fix.
  const faultMatch = reason.match(/^(VALIDATOR_FAULT_[A-Z0-9_]+):\s*/);
  if (faultMatch) {
    return {
      class: 'operational',
      prefix: `${faultMatch[1]}:`,
      detail: reason.slice(faultMatch[0].length),
      retryable: false,
    };
  }

  // 2. steps[<id>]: — bracketed id, so matched by regex rather than a literal.
  //    retryable — a structural/completeness mismatch between reported step
  //    results and the scenario's declared required_steps, not a verdict on
  //    whether the run's steps passed.
  const stepsMatch = reason.match(/^steps\[[^\]]*\]:\s*/);
  if (stepsMatch) {
    return {
      class: 'submission-bad',
      prefix: 'steps[<id>]:',
      detail: reason.slice(stepsMatch[0].length),
      retryable: true,
    };
  }

  // 3. Literal prefixes (most-specific-first; the array order guards against a
  //    shorter prefix shadowing a longer one — none currently overlap, but the
  //    ordering keeps that invariant explicit).
  for (const entry of LITERAL_PREFIXES) {
    if (reason.startsWith(entry.match)) {
      return {
        class: entry.class,
        prefix: entry.prefix,
        detail: stripLiteral(reason, entry.match),
        retryable: entry.retryable,
      };
    }
  }

  // 4. Unrecognized — log + surface raw, and never retryable: an unrecognized
  //    prefix is not affirmatively known to be a shape/addressing mistake, so
  //    the same "fails closed" discipline the taxonomy applies elsewhere
  //    applies here too. (The null/non-object submission reason now carries
  //    the typed `submission-malformed:` prefix → 'operational', so it no
  //    longer falls through here; see verify-B-003.)
  return { class: 'unknown', prefix: null, detail: reason, retryable: false };
}
