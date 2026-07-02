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
 * raw rejection string to `{ class, prefix, detail }`:
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
 *   - packages/ingest/run.js:         scenario-load:
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
 * @property {RejectionClass} class  Routing decision (who must act).
 * @property {string | null}  prefix Canonical prefix token, or null when unknown.
 * @property {string}         detail Human-readable remainder (prefix stripped).
 */

/**
 * Literal-prefix matchers, ordered most-specific-first. Each carries the
 * canonical prefix token and the routing class. `match` is the exact string the
 * reason must start with; `detail` is whatever follows it (trimmed of one
 * leading space). `repo:` matches the `repo:mismatch: …` family — the canonical
 * token reported is the stable `repo:` head.
 */
const LITERAL_PREFIXES = [
  // submission-bad
  { match: 'schema:', prefix: 'schema:', class: 'submission-bad' },
  // VERIFY-F1: a malformed REPO custom-rule predicate (eval-time semantic fault the
  // schema could not catch). submission-bad — the repo authored the bad policy YAML,
  // so the fix belongs to the submitter, not studio ops. Ordered BEFORE `policy:`
  // to keep the most-specific-first invariant (the tokens don't overlap — `policy:`
  // ends at the colon, `policy-config:` continues with `-config:` — but the order is
  // explicit). A malformed GLOBAL predicate is operational (VALIDATOR_FAULT_POLICY).
  { match: 'policy-config:', prefix: 'policy-config:', class: 'submission-bad' },
  { match: 'policy:', prefix: 'policy:', class: 'submission-bad' },
  // operational — a provider-side provenance FAULT (429/5xx/401/403). The
  // adapter THROWS these (verify-A-002); index.js catches the throw and emits
  // this distinct `provenance-fault:` prefix so the incident pages ops. Ordered
  // before the bare `provenance:` literal — it is a distinct token, but keeping
  // the longer, more-specific match first preserves the most-specific-first
  // invariant the array is sorted by. The genuine not-confirmed case
  // (`provenance: source run could not be confirmed`) stays submission-bad below.
  { match: 'provenance-fault:', prefix: 'provenance-fault:', class: 'operational' },
  { match: 'provenance:', prefix: 'provenance:', class: 'submission-bad' },
  { match: 'repo:', prefix: 'repo:', class: 'submission-bad' },
  {
    match: 'submission-contains-verifier-field:',
    prefix: 'submission-contains-verifier-field:',
    class: 'submission-bad',
  },
  { match: 'CONTRACT_SCHEMA_TOO_NEW:', prefix: 'CONTRACT_SCHEMA_TOO_NEW:', class: 'submission-bad' },
  { match: 'CONTRACT_SCHEMA_TOO_OLD:', prefix: 'CONTRACT_SCHEMA_TOO_OLD:', class: 'submission-bad' },
  // operational — a null/non-object submission is a malfunctioning dispatcher
  // (verify-B-003), not a submitter who sent a bad-but-shaped payload. Page ops;
  // do NOT bounce it back to the submitter.
  { match: 'submission-malformed:', prefix: 'submission-malformed:', class: 'operational' },
  // operational — the scenario fetcher THREW after exhausting its retry
  // budget (5xx/429 outage, transport reject) or hit a credential fault
  // (401/403). V2-CROSS-BO-001: packages/ingest/load-context.js throws this
  // classified error instead of returning `not_found`, so an outage never
  // rejects a good submission. Ordered before `scenario-load:` to keep the
  // most-specific-first invariant explicit (the tokens do not overlap).
  { match: 'scenario-fetch-fault:', prefix: 'scenario-fetch-fault:', class: 'operational' },
  // ingest
  { match: 'scenario-load:', prefix: 'scenario-load:', class: 'ingest' },
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
    return { class: 'unknown', prefix: null, detail: '' };
  }

  // 1. Operational faults — matched by FAMILY so future VALIDATOR_FAULT_<NEW>
  //    classes need no edit here. (runValidator emits `VALIDATOR_FAULT_<CLS>: …`.)
  const faultMatch = reason.match(/^(VALIDATOR_FAULT_[A-Z0-9_]+):\s*/);
  if (faultMatch) {
    return {
      class: 'operational',
      prefix: `${faultMatch[1]}:`,
      detail: reason.slice(faultMatch[0].length),
    };
  }

  // 2. steps[<id>]: — bracketed id, so matched by regex rather than a literal.
  const stepsMatch = reason.match(/^steps\[[^\]]*\]:\s*/);
  if (stepsMatch) {
    return {
      class: 'submission-bad',
      prefix: 'steps[<id>]:',
      detail: reason.slice(stepsMatch[0].length),
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
      };
    }
  }

  // 4. Unrecognized — log + surface raw. (The null/non-object submission reason
  //    now carries the typed `submission-malformed:` prefix → 'operational', so it
  //    no longer falls through here; see verify-B-003.)
  return { class: 'unknown', prefix: null, detail: reason };
}
