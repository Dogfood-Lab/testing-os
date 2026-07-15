/**
 * Context loader
 *
 * Gathers everything the verifier needs:
 * - Global policy
 * - Repo policy (optional, missing is valid)
 * - Scenario definitions from source repo (optional, missing becomes rejection reason)
 * - Payload normalization
 *
 * Scenario loading uses a fetch adapter so it can be stubbed in tests.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { validatePayload } from '@dogfood-lab/schemas';
import { logStage as sharedLogStage } from '@dogfood-lab/dogfood-swarm/lib/log-stage.js';
import { isUnsafeSegment } from './lib/unsafe-segment.js';

/**
 * D2B-005 (Phase 10 Step 1): summarise a `validatePayload('policy', …)`
 * result down to a single-line operator-actionable reason string. The
 * canonical seam returns `{ path, message, keyword, params }` per error;
 * we collapse the first 3 violations into a `path message` join so the
 * sentinel's `reason` field stays grep-friendly without truncating the
 * structural detail an operator needs to find the offending YAML key.
 *
 * Three errors is a deliberate ceiling — a policy with 20 violations
 * almost certainly has a single root cause (wrong section nesting,
 * malformed root); flooding the reason string with 20 lines makes the
 * error harder to read, not easier.
 */
function summarizePolicyErrors(errors) {
  const trimmed = errors.slice(0, 3).map(e => `${e.path || '/'} ${e.message}`);
  const ellipsis = errors.length > 3 ? `; (+${errors.length - 3} more)` : '';
  return trimmed.join('; ') + ellipsis;
}

/**
 * D1B-006 (Stage C humanization): one structured `logStage(...)` helper,
 * component-pinned to `ingest` so the NDJSON stream is greppable with the
 * rest of the pipeline. Same wave-22 wrapper-strip pattern as `run.js`.
 */
function logStage(stage, fields = {}) {
  const { stage: _ignored, ...rest } = fields;
  sharedLogStage(stage, { component: 'ingest', ...rest });
}

/**
 * Load the global policy.
 *
 * The global policy is REQUIRED — unlike `loadRepoPolicy` which silently
 * returns null when a repo-specific override is absent, a missing or malformed
 * global policy throws with a structured, operator-actionable message naming
 * the resolved path and the failure mode (missing vs unreadable vs invalid
 * YAML, with line/column from `yaml.YAMLException.mark` when available).
 * Receiver workflows would otherwise crash with a raw `ENOENT` or
 * `YAMLException` stack trace, leaving the operator to guess which file
 * to fix.
 *
 * @param {string} repoRoot
 * @returns {object}
 */
export function loadGlobalPolicy(repoRoot) {
  const path = join(repoRoot, 'policies', 'global-policy.yaml');
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(
        `Global policy missing: ${path}\n` +
        `The ingest pipeline requires a global policy file. ` +
        `Create it from policies/global-policy.example.yaml or the project README.`
      );
    }
    throw new Error(`Global policy unreadable: ${path} — ${e.message}`);
  }
  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    const where = e.mark ? ` at line ${e.mark.line + 1}, column ${e.mark.column + 1}` : '';
    throw new Error(
      `Global policy YAML invalid: ${path}${where} — ${e.message}\n` +
      `Fix the YAML and re-run.`
    );
  }

  // D2B-005: schema-gate the parsed policy against policy.schema.json.
  // Pre-fix, a YAML that parsed but didn't conform (extra fields, wrong
  // enums, missing required) silently loaded and the verifier ran with
  // ad-hoc field probing — a structurally-invalid policy could produce
  // "verifier accepts everything." Post-H3 the canonical seam is one
  // call away. Global policy is required + load-once, so a schema fault
  // here is fail-loud (matches the YAML-invalid sibling above).
  const validation = validatePayload('policy', parsed);
  if (!validation.valid) {
    throw new Error(
      `Global policy schema-invalid: ${path} — ${summarizePolicyErrors(validation.errors)}\n` +
      `Fix the policy to conform to policy.schema.json and re-run.`
    );
  }
  return parsed;
}

/**
 * Load repo-specific policy.
 *
 * Three discriminable return shapes:
 *   - `null`            → no repo-policy file exists; defaults apply
 *     (documented design — submission is NOT rejected for absent policy).
 *   - parsed YAML object → policy loaded cleanly.
 *   - `{ __torn: true, reason, path }` → D1B-006 sentinel: the policy
 *     file EXISTS but cannot be parsed. Pre-fix this case returned null,
 *     which the verifier then treated as "no policy → defaults apply →
 *     accept". That sentinel inversion silently approved every
 *     submission against a corrupt policy. The torn sentinel surfaces
 *     the broken state so the verifier can reject with a
 *     `'policy: <reason>'` rejection AND `policy_valid=false`.
 *
 * The sentinel is intentionally a distinct shape (`__torn: true`) so the
 * verifier pattern-match needs no schema knowledge — the existence of
 * `__torn` discriminates without parsing the policy twice.
 *
 * @param {string} repoSlug - e.g. "mcp-tool-shop-org/dogfood-labs"
 * @param {string} repoRoot
 * @returns {object|null|{ __torn: true, reason: string, path: string }}
 */
export function loadRepoPolicy(repoSlug, repoRoot) {
  // F-54e5fde7: the submission contract is strictly two-segment (the schema's
  // `repo` pattern forbids a second slash; nested GitLab subgroups are
  // UNSUPPORTED). A 3+-segment slug must fail closed here — the old 2-way
  // destructure silently dropped the third segment and would have resolved a
  // DIFFERENT repo's policy file (group/subgroup/project → repos/group/subgroup.yaml).
  const segments = repoSlug.split('/');
  if (segments.length !== 2) return null;
  const [org, repo] = segments;
  if (!org || !repo || isUnsafeSegment(org) || isUnsafeSegment(repo)) return null;
  const path = join(repoRoot, 'policies', 'repos', org, `${repo}.yaml`);

  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = yaml.load(readFileSync(path, 'utf-8'));
  } catch (e) {
    // D1B-006: torn-policy sentinel + structured warn event for YAML
    // parse failures. The verifier (verify/index.js:189-192) surfaces
    // this as a `policy: <reason>` rejection.
    const reason = e && e.message ? e.message : String(e);
    logStage('warn', {
      kind: 'repo_policy_unreadable',
      repo: repoSlug,
      path,
      error: reason
    });
    return { __torn: true, reason, path };
  }

  // D2B-005 (Phase 10 Step 1): schema-gate the parsed repo policy.
  // Reuses the `__torn` sentinel so the verifier's existing single-
  // branch handler (verify/index.js:189) catches both "YAML failed
  // to parse" (D1B-006) and "YAML parsed but doesn't conform to
  // policy.schema.json" (D2B-005). The verify-side reason prefix
  // (`policy: repo policy unreadable — <reason>`) covers both
  // classes; the embedded schema-violation detail tells the operator
  // which YAML key to fix.
  const validation = validatePayload('policy', parsed);
  if (!validation.valid) {
    const reason = `schema-invalid — ${summarizePolicyErrors(validation.errors)}`;
    logStage('warn', {
      kind: 'repo_policy_unreadable',
      repo: repoSlug,
      path,
      error: reason
    });
    return { __torn: true, reason, path };
  }
  return parsed;
}

/**
 * Default per-request timeout for the GitHub scenario fetch. Mirrors the
 * sibling `GITHUB_PROVENANCE_TIMEOUT_MS` constant at
 * `packages/verify/validators/provenance.js`: a hung GitHub API call
 * would otherwise stall ingest until the surrounding GitHub Actions
 * runner timeout fires (default 6h). 30s fails fast with a typed
 * `'timeout'` reason the operator can pivot on.
 */
export const GITHUB_SCENARIO_FETCH_TIMEOUT_MS = 30000;

/**
 * Default number of fetch attempts (INGEST-PROACT-003). A transient GitHub-API
 * fault (5xx, 429, network blip) should not turn a loadable scenario into a hard
 * rejection; a small bounded retry rides out the hiccup. Kept small — three
 * attempts is enough to clear a momentary throttle without amplifying a real
 * outage into a multi-minute stall (the AbortController timeout still bounds each
 * attempt, and a 404/invalid-id is never retried).
 */
export const GITHUB_SCENARIO_FETCH_ATTEMPTS = 3;

/** Initial backoff before the first retry (ms); doubles per attempt, capped. */
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 2000;

/**
 * V2-CROSS-BO-002: byte cap on a fetched scenario body. A scenario definition
 * crosses the consumer-repo → verifier trust boundary; without a cap a
 * hostile/misconfigured source repo could stream an arbitrarily large body
 * into memory and into yaml.load. Real scenario files are a few KB — 1 MiB is
 * three orders of magnitude of headroom. Checked against Content-Length
 * BEFORE the body is read (when the response exposes it), then enforced
 * WHILE the body streams (F-35486d38: the reader aborts the moment the
 * running byte count crosses the cap, so a header-suppressed oversized body
 * never fully buffers). Responses without a streamable body (test stubs)
 * fall back to text() + a post-read length check, which then bounds only
 * yaml.load, not the buffering step.
 */
export const GITHUB_SCENARIO_MAX_BYTES = 1024 * 1024;

/**
 * F-2750c4e8: hard ceiling on DISTINCT scenario ids fetched per submission.
 * Matches the submission schema's `scenario_results` maxItems (1000) — the
 * published contract bound — so a schema-valid submission can never hit it,
 * while a hostile pre-schema-gate payload (the fetch loop runs before
 * verify()'s schema rejection lands) cannot drive unbounded sequential
 * authenticated GitHub API calls. Combined with the attempted-id dedupe in
 * loadScenarios, the worst-case network spend per submission is bounded by
 * this constant regardless of payload shape.
 */
export const MAX_DISTINCT_SCENARIO_FETCHES = 1000;

/**
 * V2-CROSS-BO-001: classified operational fault for the scenario fetch —
 * mirrors the F-dac7e08c adapter discipline in
 * `packages/verify/validators/provenance.js` (transport rejects and non-404
 * provider statuses THROW after the bounded retry, they never masquerade as
 * "the file does not exist"). The `scenario-fetch-fault:` prefix is
 * registered in `@dogfood-lab/verify`'s parseRejectionReason as
 * 'operational', so any surface that stringifies this error routes the
 * incident to ops instead of bouncing a good submission back to the
 * submitter.
 */
function scenarioFetchFault(detail) {
  const err = new Error(`scenario-fetch-fault: ${detail}`);
  err.code = 'SCENARIO_FETCH_FAULT';
  return err;
}

/** Default async backoff. Injectable (`opts.sleepImpl`) so tests run instantly. */
function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * COORD-001: parse a scenario body fetched from a consumer's source repo —
 * the one `yaml.load` call site in this file that sees content a hostile or
 * compromised submitter controls end to end. js-yaml 4.1.1 (the workspace
 * floor; see package.json `"js-yaml": "^4.1.0"`) carries
 * GHSA-h67p-54hq-rp68: chained `<<` merge keys cost O(depth) per level,
 * because `mergeMappings()` (js-yaml lib/loader.js:304-321) re-copies
 * `Object.keys(source)` for the FULL accumulated mapping at every level —
 * so an n-level merge chain costs O(n^2) total. The attack is small BY
 * CONSTRUCTION (each level adds only a couple of YAML lines), so
 * GITHUB_SCENARIO_MAX_BYTES (a 1 MiB cap on the wire size) does not defend
 * it: measured on the reference rig, a chain sized right at that 1 MiB cap
 * costs ~61s of CPU, and scaling is ~quadratic (68 KB -> 127ms, 145 KB ->
 * 656ms). Bumping js-yaml to v5 (which drops merge-key support outright)
 * is blocked — Dependabot #50 is held open because v5 breaks two scripts/
 * gates — so the mitigation lives here instead of in the dependency.
 *
 * CORE_SCHEMA is DEFAULT_SCHEMA minus exactly the YAML-1.1 extras
 * (`timestamp`, `merge`, `binary`, `omap`, `pairs`, `set` — see js-yaml
 * lib/schema/default.js). Without the registered `merge` type, the
 * loader's `keyTag === 'tag:yaml.org,2002:merge'` branch in
 * storeMappingPair() never matches a `<<` key, so `mergeMappings()` is
 * never invoked and the O(depth) copy loop simply cannot run — `<<`
 * resolves as an ordinary (and, against scenario.schema.json, rejected —
 * `additionalProperties: false`) string key instead. This is verified
 * behaviourally, not assumed from the option name, in
 * coord-001-scenario-merge-bomb.test.js: a probe document proves the
 * merge-key never fires, and a second probe proves the real fetch path
 * (not just this helper in isolation) stays protected. Every field
 * scenario.schema.json declares is a plain string/object/array/boolean —
 * none relies on the dropped timestamp/binary/omap/pairs/set types — so
 * this is a pure security hardening with no behavioural cost to a
 * conforming scenario document.
 *
 * Scoped deliberately to THIS call site only. The other two `yaml.load`
 * calls in this file (loadGlobalPolicy, loadRepoPolicy) both read
 * maintainer-committed local files — the attacker does not control their
 * content, only (in loadRepoPolicy's case) which existing file gets
 * selected, and that selection is already segment-validated above.
 * Widening this schema change to those sites is unnecessary risk for zero
 * additional coverage.
 *
 * F-3be85850: this comment previously also named a THIRD "local files"
 * call site, localScenarioFetcher — removed as dead code (zero callers
 * anywhere in the repo, and not reachable even as an external package hook:
 * load-context.js is not in @dogfood-lab/ingest's package.json `exports`
 * map). Its own doc comment claimed it was "Used when dogfood-labs is
 * dogfooding itself," but the real self-dogfood path (self-dogfood.yml)
 * routes through the SAME public ingest.yml repository_dispatch pipeline
 * every consumer uses, via githubScenarioFetcher below — never a local-disk
 * reader. dogfood/scenarios/*.yaml remain the canonical scenario
 * definitions; they are simply fetched over the GitHub Contents API rather
 * than off local disk, even for this repo's own CI.
 */
export function parseUntrustedScenarioYaml(text) {
  return yaml.load(text, { schema: yaml.CORE_SCHEMA });
}

/**
 * GitHub scenario fetcher. Loads scenario definitions from a source repo
 * via the GitHub API at a specific commit SHA.
 *
 * Two surfaces on the returned adapter:
 *   - `fetch(scenarioId)`: legacy contract — returns the scenario object
 *     on success, `null` on any failure. Preserved for back-compat with
 *     callers that pattern-match on the truthiness of the result.
 *   - `fetchWithReason(scenarioId)`: D1B-004 typed contract — always
 *     returns `{ scenario, reason }` where `scenario` is the loaded
 *     object on success or `null` on failure, and `reason` is one of
 *     `'not_found' | 'parse_error' | 'invalid_id' | 'too_large' |
 *     'schema_invalid'` on failure (absent on success). The reason gives
 *     operators a pivot key when diagnosing a stale scenario-load chain.
 *     A timeout that survives every retry no longer RETURNS a typed
 *     reason — it throws `scenario-fetch-fault:` (F-07ab7f86, see below).
 *
 * Both surfaces honour the per-request AbortController timeout
 * (`GITHUB_SCENARIO_FETCH_TIMEOUT_MS`, overridable via `opts.timeoutMs`).
 *
 * INGEST-PROACT-003: each call makes up to `opts.attempts`
 * (`GITHUB_SCENARIO_FETCH_ATTEMPTS`) tries with exponential backoff, retrying
 * ONLY the transient classes — request timeout, HTTP 5xx, HTTP 429, and network
 * rejects. A 404 (`not_found`), an `invalid_id`, a `parse_error`, a
 * `too_large`, and a `schema_invalid` are DEFINITIVE answers and are returned
 * immediately without a retry (mirrors the EPERM/EBUSY-only discipline in
 * `lib/rename-with-retry.js`). The backoff sleep is injectable
 * (`opts.sleepImpl`) so tests do not actually wait.
 *
 * V2-CROSS-BO-001 + F-07ab7f86: exhausting the retry budget on a 5xx/429, a
 * transport reject, OR a per-request timeout, or hitting any other non-404
 * non-ok status (401/403 bad credential), THROWS a `scenario-fetch-fault:`
 * classified error instead of returning a typed reason — an outage, a slow-API
 * window, or a token fault is an OPERATIONAL incident, never evidence that
 * the scenario file is absent. Callers (loadScenarios → run.js) propagate the
 * throw so the CLI exits 2 without persisting a rejected record. The
 * exhausted-timeout fault keeps the literal word 'timeout' in its detail so
 * the D1B-004/L1-007 operator pivot key survives (contract updated wave 4;
 * pre-fix the typed 'timeout' reason became a submission-rejecting
 * `scenario-load:` reason that poisoned the run_id via the duplicate guard).
 *
 * @param {string} token - GitHub PAT
 * @param {string} repoSlug - e.g. "mcp-tool-shop-org/shipcheck"
 * @param {string} commitSha - Commit to fetch scenarios from
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, attempts?: number, sleepImpl?: (ms: number) => Promise<void> }} [opts]
 * @returns {{ fetch(scenarioId: string): Promise<object|null>, fetchWithReason(scenarioId: string): Promise<{ scenario: object|null, reason?: string }> }}
 */
export function githubScenarioFetcher(token, repoSlug, commitSha, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GITHUB_SCENARIO_FETCH_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const attempts = opts.attempts ?? GITHUB_SCENARIO_FETCH_ATTEMPTS;
  const sleep = opts.sleepImpl ?? defaultSleep;

  // V2-CROSS-BO-003 (F-54e5fde7 family): the submission contract is strictly
  // two-segment. The old 2-way destructure silently dropped a third segment —
  // and worse, the URL below was built from the RAW slug, so `org/repo/extra`
  // reached the authenticated GitHub API verbatim. Fail closed here and build
  // the URL from the VALIDATED segments only.
  const segments = typeof repoSlug === 'string' ? repoSlug.split('/') : [];
  const [org, repo] = segments.length === 2 ? segments : [null, null];
  // commitSha is interpolated into the authenticated (Bearer-token) GitHub API
  // URL's `?ref=` — a shape guard (lowercase-hex, 7–40 chars) refuses anything
  // that could re-target the ref or inject query params, matching how org/repo
  // and scenarioId are guarded below. encodeURIComponent alone would NOT reject
  // a re-targeted ref (e.g. a branch name), so the shape guard is the floor.
  if (
    !org || !repo || isUnsafeSegment(org) || isUnsafeSegment(repo) ||
    typeof commitSha !== 'string' || !/^[0-9a-f]{7,40}$/.test(commitSha)
  ) {
    return {
      async fetch() { return null; },
      async fetchWithReason() { return { scenario: null, reason: 'invalid_id' }; }
    };
  }

  // One bounded attempt. Returns `{ scenario, reason, retryable, fault }`;
  // the loop below retries on `retryable` and THROWS `fault` (when present)
  // once the budget is exhausted — so a transient blip is ridden out, but a
  // real outage surfaces as an operational fault, never as `not_found`.
  async function attemptOnce(scenarioId) {
    const path = `dogfood/scenarios/${scenarioId}.yaml`;
    // V2-CROSS-BO-003: built from the validated org/repo, never the raw slug.
    const url = `https://api.github.com/repos/${org}/${repo}/contents/${path}?ref=${commitSha}`;

    // D1B-004: AbortController-bounded request. Copied from
    // `packages/verify/validators/provenance.js:80-104`. The 30s default
    // matches that sibling so a single end-to-end ingest cannot stall
    // longer than ~60s on cumulative GitHub-API timeouts.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let text;
    try {
      const resp = await fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        signal: controller.signal
      });
      if (!resp.ok) {
        // V2-CROSS-BO-001: only a 404 means "the scenario file is absent" —
        // that is the sole not_found. A 5xx / 429 is a transient provider
        // fault: retry, then throw operational on exhaustion. Anything else
        // (401/403 bad credential, unexpected 4xx) is a definitive
        // OPERATIONAL fault: throw immediately, never retried, never
        // misread as a missing file.
        if (resp.status === 404) {
          return { scenario: null, reason: 'not_found', retryable: false };
        }
        const fault = scenarioFetchFault(
          `GitHub API HTTP ${resp.status} loading scenario "${scenarioId}" from ${org}/${repo}`
        );
        if (resp.status >= 500 || resp.status === 429) {
          return { scenario: null, retryable: true, fault };
        }
        throw fault;
      }

      // V2-CROSS-BO-002: byte cap at the trust boundary. Check the declared
      // Content-Length first (skips even starting an oversized read when the
      // response exposes headers) — the header is attacker-suppliable, so the
      // read below re-enforces the cap on real bytes.
      const declaredLength = typeof resp.headers?.get === 'function'
        ? Number(resp.headers.get('content-length'))
        : NaN;
      if (declaredLength > GITHUB_SCENARIO_MAX_BYTES) {
        return { scenario: null, reason: 'too_large', retryable: false };
      }
      // F-35486d38: stream the body with a running byte count and abort the
      // moment the cap is crossed, so a header-suppressed oversized body is
      // never fully buffered. Responses without a streamable body (test
      // stubs, non-spec fetch impls) fall back to text() + post-read check,
      // which bounds yaml.load but not the buffering step.
      if (resp.body && typeof resp.body.getReader === 'function') {
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        let overflow = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > GITHUB_SCENARIO_MAX_BYTES) {
            overflow = true;
            // cancel() may reject if the connection is already torn down —
            // the too_large verdict below stands either way.
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
        }
        if (overflow) {
          return { scenario: null, reason: 'too_large', retryable: false };
        }
        text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
      } else {
        text = await resp.text();
        if (Buffer.byteLength(text, 'utf8') > GITHUB_SCENARIO_MAX_BYTES) {
          return { scenario: null, reason: 'too_large', retryable: false };
        }
      }
    } catch (err) {
      if (err && err.code === 'SCENARIO_FETCH_FAULT') {
        throw err;
      }
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        // A timed-out request may succeed on a retry.
        return { scenario: null, reason: 'timeout', retryable: true };
      }
      // V2-CROSS-BO-001: network reject, DNS failure, etc. — transient, so
      // retry; but on exhaustion this is an outage (operational fault), NOT
      // evidence the scenario file is absent.
      return {
        scenario: null,
        retryable: true,
        fault: scenarioFetchFault(
          `network error loading scenario "${scenarioId}" from ${org}/${repo}: ${err && err.message ? err.message : String(err)}`
        )
      };
    } finally {
      clearTimeout(timer);
    }

    let scenario;
    try {
      // COORD-001: merge-key DoS defense — see parseUntrustedScenarioYaml's
      // doc comment. `text` is untrusted (fetched from the submitter's
      // source repo), so it must never reach plain yaml.load().
      scenario = parseUntrustedScenarioYaml(text);
    } catch {
      return { scenario: null, reason: 'parse_error', retryable: false };
    }
    if (!scenario || typeof scenario !== 'object') {
      return { scenario: null, reason: 'parse_error', retryable: false };
    }

    // V2-CROSS-BO-002: schema-gate the loaded object before it crosses into
    // verify()'s required-steps enforcement. A parses-but-nonconforming
    // scenario is a SUBMISSION-SIDE fault (the source repo authored it) — it
    // surfaces through loadScenarios as a typed `schema_invalid` reason and
    // becomes a `scenario-load:` rejection at the ingest layer, never a
    // validator fault.
    const validation = validatePayload('scenario', scenario);
    if (!validation.valid) {
      return { scenario: null, reason: 'schema_invalid', retryable: false };
    }
    return { scenario };
  }

  async function fetchWithReason(scenarioId) {
    if (!/^[\w-]+$/.test(scenarioId)) {
      return { scenario: null, reason: 'invalid_id' };
    }

    let last;
    for (let i = 0; i < attempts; i++) {
      last = await attemptOnce(scenarioId);
      if (last.scenario || !last.retryable || i === attempts - 1) break;
      await sleep(Math.min(RETRY_BASE_MS * (1 << i), RETRY_MAX_MS));
    }
    // V2-CROSS-BO-001: a transient fault that survived every retry is an
    // outage — throw the classified operational error instead of returning a
    // reason the ingest layer would turn into a submission rejection.
    if (last.fault) {
      throw last.fault;
    }
    // F-07ab7f86: timeout EXHAUSTION is outage-shaped too — a sustained
    // slow-API window (every attempt >timeoutMs) is the same operational
    // class as exhausted ECONNREFUSED/5xx, not evidence the submission is
    // bad. Throw the classified fault, keeping the literal word 'timeout'
    // in the detail so the D1B-004/L1-007 operator pivot key survives in
    // the error message. (This deliberately supersedes the earlier pinned
    // contract where exhausted-timeout returned the typed reason and became
    // a `scenario-load:` rejection — that permanently poisoned run_ids
    // during slow-API windows via the _rejected duplicate guard.)
    if (last.reason === 'timeout') {
      throw scenarioFetchFault(
        `timeout after ${attempts} attempt(s) loading scenario "${scenarioId}" from ${org}/${repo}`
      );
    }
    // Strip the internal `retryable` flag from the public contract.
    const { retryable: _drop, ...result } = last;
    return result;
  }

  return {
    // Legacy: success returns the scenario object, failure returns null
    // — every existing caller pattern-matches on truthiness.
    async fetch(scenarioId) {
      const result = await fetchWithReason(scenarioId);
      return result.scenario;
    },
    fetchWithReason
  };
}

/**
 * Load all scenario definitions referenced by a submission's scenario_results.
 *
 * F-efe4f893: this function now runs BEFORE the schema gate on untrusted
 * consumer input (the F-3bfc2885 production wiring), so it must be defensive:
 *   - a non-array `scenario_results` returns empty-handed (the schema
 *     rejection downstream in verify() is the authoritative signal);
 *   - an entry that is not a non-null object carrying a string `scenario_id`
 *     is NEVER fetched — pre-fix, `/^[\w-]+$/.test(undefined)` coerced to the
 *     string 'undefined' and issued a real authenticated GitHub API request
 *     per malformed entry. It pushes a typed `malformed_entry` error instead.
 *
 * F-2750c4e8: every ATTEMPTED id is cached (successes AND typed failures), so
 * a repeated id — loaded or failed — costs exactly one fetch, and the number
 * of distinct fetches is capped at {@link MAX_DISTINCT_SCENARIO_FETCHES}
 * (the schema's own maxItems bound). Entries beyond the cap get a typed
 * `fetch_cap` error without touching the network. Thrown
 * `scenario-fetch-fault:`s are deliberately NOT cached — they propagate
 * immediately (see below), so outage semantics survive the dedupe.
 *
 * DESIGN RULING (wave 4) — three-way failure split:
 *   - true 404 (`not_found`, typed surface only) → NOT a rejection. The fleet
 *     is mixed (some consumers commit dogfood/scenarios/, some don't);
 *     nothing declared means nothing to enforce. Surfaces on `warnings` so
 *     run.js lands it on verification.warnings (the v1.6.0
 *     accepted-with-warning channel) and required-steps enforcement is
 *     simply skipped for that scenario.
 *   - malformed committed file (`parse_error` / `schema_invalid` /
 *     `too_large` / `invalid_id`) → `errors` → submission-bad
 *     `scenario-load:` rejection (unchanged).
 *   - outage (`scenario-fetch-fault:` throw, incl. exhausted timeout) →
 *     PROPAGATES deliberately; the CLI's outer catch emits a structured
 *     operational error and exits 2 without persisting (V2-CROSS-BO-001).
 *
 * The legacy `fetch(id)` truthiness surface cannot discriminate not_found
 * from a malformed file, so its `null` keeps the historical
 * rejection-on-error behavior.
 *
 * @param {object} submission
 * @param {object} scenarioFetcher - { fetch(scenarioId), fetchWithReason?(scenarioId) }
 * @returns {Promise<{ scenarios: Map<string, object>, errors: string[], warnings: string[] }>}
 */
export async function loadScenarios(submission, scenarioFetcher) {
  const scenarios = new Map();
  const errors = [];
  const warnings = [];

  const results = submission && typeof submission === 'object'
    ? submission.scenario_results
    : undefined;
  if (!Array.isArray(results)) {
    // Non-array shapes (string, object, null) iterate wrong or crash —
    // notably a STRING iterates characters. Skip entirely; verify()'s schema
    // gate rejects the submission with the authoritative reason.
    return { scenarios, errors, warnings };
  }

  const supportsTypedReason = typeof scenarioFetcher.fetchWithReason === 'function';
  // F-2750c4e8: id → true once an id has been resolved (success OR typed
  // failure), so repeats never re-fetch. Faults are uncached: they throw.
  const attempted = new Set();
  let distinctFetches = 0;

  for (const sr of results) {
    if (!sr || typeof sr !== 'object' || Array.isArray(sr) || typeof sr.scenario_id !== 'string') {
      errors.push(
        'scenario_results entry is not an object with a string scenario_id (reason: malformed_entry)'
      );
      continue;
    }
    const id = sr.scenario_id;
    if (attempted.has(id)) continue;
    attempted.add(id);

    if (distinctFetches >= MAX_DISTINCT_SCENARIO_FETCHES) {
      errors.push(
        `scenario "${id}" not fetched — distinct-scenario fetch cap (${MAX_DISTINCT_SCENARIO_FETCHES}) reached (reason: fetch_cap)`
      );
      continue;
    }
    distinctFetches++;

    if (supportsTypedReason) {
      const result = await scenarioFetcher.fetchWithReason(id);
      if (result && result.scenario) {
        scenarios.set(id, result.scenario);
      } else if (result && result.reason === 'not_found') {
        warnings.push(`scenario definition not found for "${id}" — required_steps unenforced`);
      } else {
        const reason = result && result.reason ? result.reason : 'unknown';
        errors.push(`scenario "${id}" could not be loaded from source repo (reason: ${reason})`);
      }
    } else {
      const definition = await scenarioFetcher.fetch(id);
      if (definition) {
        scenarios.set(id, definition);
      } else {
        errors.push(`scenario "${id}" could not be loaded from source repo`);
      }
    }
  }

  return { scenarios, errors, warnings };
}
