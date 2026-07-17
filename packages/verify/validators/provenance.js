/**
 * Provenance adapters
 *
 * The verifier checks that a source run actually exists and matches claims.
 * Adapters:
 * - stub:      always confirms (for tests and local development)
 * - github:    confirms via the GitHub Actions API (production)
 * - gitlab:    confirms via the GitLab CI API (production)
 *
 * The two real adapters are PEERS — same hardening discipline (per-request
 * timeout, 404-only-false, throw-on-operational, finished-state assertion, and
 * the verify-A-001 commit-binding anti-forgery guard). Production code selects
 * the adapter for a submission via {@link provenanceForProvider}, keyed on
 * `source.provider`, so the provider enum, the run_url parsers
 * (validators/repo-binding.js), and the adapters here stay in lockstep —
 * coverage tests fail CI if any of the three drifts.
 */

/**
 * Default per-request timeout for the GitHub provenance fetch.
 * A hung GitHub API call would otherwise stall every consumer's ingest until
 * the surrounding GitHub Actions runner timeout fires (default 6h). Fail fast
 * with a clear AbortError so the verifier records 'provenance: timeout' in
 * rejection_reasons.
 */
export const GITHUB_PROVENANCE_TIMEOUT_MS = 30000;

/**
 * Default per-request timeout for the GitLab provenance fetch. Same rationale
 * as the GitHub guard — a hung gitlab.com/api call must not block ingest.
 */
export const GITLAB_PROVENANCE_TIMEOUT_MS = 30000;

/**
 * Default RETRY budget for a transient provider fault (HTTP 429 rate-limit or a
 * 5xx provider outage). PROACT-VERIFY-001: a single 429/5xx during a momentary
 * blip used to fail the whole submission as an operational incident even though
 * one retry would have confirmed the run. We retry a BOUNDED number of times
 * with exponential backoff (honoring `Retry-After` when the provider sends it),
 * then THROW on exhaustion so a genuinely-down provider still surfaces as an
 * operational signal — never a false 'confirmed'. 404 is NOT retried (the run is
 * genuinely absent, a single immediate rejection).
 *
 * `retries` is the number of ADDITIONAL attempts after the first, so the default
 * 2 means up to 3 total requests. It is an opts field (like `timeoutMs`) so it
 * stays test-injectable and the offline stub path is unaffected.
 */
export const PROVENANCE_RETRIES = 2;

/**
 * Base backoff between retry attempts, in ms. Attempt N waits
 * `PROVENANCE_BACKOFF_MS * 2^(N-1)` (250 → 500 → …), unless the provider sent a
 * `Retry-After` header, which takes precedence. Injectable via opts so tests run
 * without real delay.
 */
export const PROVENANCE_BACKOFF_MS = 250;

/** HTTP statuses worth retrying: 429 rate-limit + the 5xx provider-outage band. */
function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * F-5fd3f832: ceiling on a provider-sent Retry-After wait. The per-request
 * AbortController timeout bounds each REQUEST but not the inter-attempt sleep
 * — without this clamp, one hostile or misconfigured `Retry-After: 86400`
 * (plausible via gitlabProvenance's self-hosted `apiBase` override) would
 * stall the concurrency-serialized ingest.yml queue for a day. 30s matches
 * the per-request timeout: an honest throttle rarely asks for more, and a
 * provider that does is better surfaced as an exhausted-retries operational
 * throw than silently obeyed.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Resolve the wait before the next attempt. A `Retry-After` header (delay in
 * seconds, or an HTTP-date) is honored when present and parseable — clamped
 * to {@link MAX_RETRY_AFTER_MS} in both branches (F-5fd3f832); otherwise
 * fall back to exponential backoff (already bounded by the retry budget).
 * `attempt` is 1-based (1 = wait before the 2nd request).
 *
 * @param {Response|null} resp - The non-ok response carrying a possible
 *   Retry-After, or null for a transport reject (no response → exponential).
 * @param {number} attempt - 1-based retry index.
 * @param {number} backoffMs - Base backoff.
 * @returns {number} Milliseconds to wait (never negative).
 */
function nextBackoffMs(resp, attempt, backoffMs) {
  const header = resp?.headers?.get?.('retry-after');
  if (header != null && header !== '') {
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.min(Math.round(asSeconds * 1000), MAX_RETRY_AFTER_MS);
    }
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) {
      return Math.min(Math.max(0, asDate - Date.now()), MAX_RETRY_AFTER_MS);
    }
  }
  return backoffMs * 2 ** (attempt - 1);
}

/** Default sleep: a real timer. Injectable via `opts.sleepImpl` for tests. */
function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * F-2a5ddafa: emit ONE structured NDJSON warn line to stderr each time a
 * retry is about to happen, so an operator tailing CI logs sees a degrading
 * provider BEFORE the retry budget exhausts and throws. Pre-fix, every
 * `await sleep(...); continue;` branch in both adapters below was completely
 * silent — a submission that succeeded only after 1-2 retries against a
 * degrading GitHub/GitLab API was byte-for-byte indistinguishable in the log
 * from one that succeeded on the first try. The eventual exhausted-retry
 * failure is already loud (an operational throw); this closes the gap on
 * the way there, which is exactly the window an operator could act in
 * (e.g. correlate a slow ingest with a known provider incident).
 *
 * Deliberately NOT named `logStage` and NOT importing
 * `@dogfood-lab/dogfood-swarm/lib/log-stage.js`: packages/verify depends on
 * nothing but `@dogfood-lab/schemas` + `js-yaml` today (see package.json),
 * and the accepted workspace cycle (root CLAUDE.md, "Workspace dependency
 * graph") is `findings -> ingest -> dogfood-swarm -> findings`. `ingest`
 * ALSO depends on `verify`, so a NEW `verify -> dogfood-swarm` edge would
 * not reuse that cycle — it would close a SECOND, larger one:
 * `verify -> dogfood-swarm -> findings -> ingest -> verify`. This mirrors
 * the repo's existing precedent for exactly this constraint —
 * `packages/ingest/lib/sleep-sync.js` duplicates
 * `packages/findings/lib/file-lock.js`'s private `sleepSync` verbatim,
 * per that file's own header, rather than take a disallowed cross-edge —
 * so this emits the same NDJSON stage-line SHAPE independently instead of
 * importing the shared helper.
 * `packages/ingest/wave22-log-stage-discipline.test.js` (Class #9 sweep)
 * enforces that no file under `packages/**` defines its OWN `logStage`
 * without delegating to the shared helper; this helper uses a distinct
 * name for exactly that reason and is not a competing definition of that
 * convention.
 *
 * Injectable via `opts.onRetryWarn` (mirrors the already-injectable
 * `opts.fetchImpl` / `opts.sleepImpl` on this file) so tests assert the
 * exact fields without scraping stderr.
 *
 * @param {{ kind: string, provider: string, attempt: number, status_or_reason: string|number, next_backoff_ms: number }} fields
 */
function defaultOnRetryWarn(fields) {
  const line = { ts: new Date().toISOString(), component: 'verify', stage: 'warn', ...fields };
  try {
    console.error(JSON.stringify(line));
  } catch {
    // The logger must never throw and mask a real retry — same last-resort
    // discipline as the shared dogfood-swarm helper (log-stage.js).
    console.error('{"stage":"warn","kind":"log_serialization_failed"}');
  }
}

/**
 * Stub provenance adapter. Always confirms.
 * Use in tests and local development.
 */
export const stubProvenance = {
  async confirm(_source) {
    return true;
  }
};

/**
 * Stub provenance adapter that always rejects.
 * Use in tests to verify rejection paths.
 */
export const rejectingProvenance = {
  async confirm(_source) {
    return false;
  }
};

/**
 * GitHub provenance adapter.
 * Confirms a workflow run exists and matches the claimed repo, SHA, and workflow.
 *
 * @param {string} token - GitHub PAT with actions:read scope
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {object} Provenance adapter
 */
export function githubProvenance(token, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GITHUB_PROVENANCE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? PROVENANCE_RETRIES;
  const backoffMs = opts.backoffMs ?? PROVENANCE_BACKOFF_MS;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const onRetryWarn = opts.onRetryWarn ?? defaultOnRetryWarn;
  return {
    /**
     * @param {object} source - submission.source (provider-scoped run claim)
     * @param {{ refCommitSha?: string }} [expected] - cross-field invariants the
     *   verifier binds at the call site. `refCommitSha` is the PERSISTED
     *   `submission.ref.commit_sha` — the commit the record will attest to. When
     *   present it is checked MANDATORILY against the confirmed run head, so a
     *   submitter cannot point a real run at an arbitrary persisted commit
     *   (verify-A-001).
     */
    async confirm(source, expected = {}) {
      if (source.provider !== 'github') {
        throw new Error(`unsupported provider: ${source.provider}`);
      }

      const { provider_run_id, run_url } = source;
      if (!provider_run_id || !run_url) {
        return false;
      }

      // Extract owner/repo from run_url
      // Format: https://github.com/{owner}/{repo}/actions/runs/{id}
      const match = run_url.match(
        /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)$/
      );
      if (!match) return false;

      const [, owner, repo, urlRunId] = match;

      // run_id in URL must match claimed provider_run_id
      if (urlRunId !== String(provider_run_id)) return false;

      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${provider_run_id}`;

      // PROACT-VERIFY-001: bounded retry over transient provider faults (429
      // rate-limit, 5xx outage). Each attempt carries its own per-request
      // AbortController timeout — without it a hung GitHub API call blocks ingest
      // indefinitely. We retry up to `retries` extra times with exponential
      // backoff (honoring Retry-After), then THROW on exhaustion so a
      // genuinely-down provider surfaces as an operational signal — never a
      // false 'confirmed'. 404 is NOT retried (run genuinely absent). The
      // earlier non-retry behavior (single 429/5xx → immediate throw) failed a
      // submission on a momentary blip that one retry would have confirmed.
      let run;
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let resp;
        try {
          resp = await fetchImpl(apiUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28'
            },
            signal: controller.signal
          });
        } catch (err) {
          if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
            // F-8e72d0de: a per-request timeout is at least as transient as a
            // connection refusal — retry within the same budget as the
            // transport-reject branch below (mirrors the scenario fetcher's
            // retryable-timeout discipline), then throw on exhaustion.
            if (attempt < retries) {
              const waitMs = nextBackoffMs(null, attempt + 1, backoffMs);
              // F-2a5ddafa: visibility BEFORE the budget exhausts (see
              // defaultOnRetryWarn's doc above for why this is 'warn').
              onRetryWarn({ kind: 'provenance_retry', provider: 'github', attempt: attempt + 1, status_or_reason: 'timeout', next_backoff_ms: waitMs });
              await sleep(waitMs);
              continue;
            }
            throw new Error(`provenance: GitHub API timeout after ${timeoutMs}ms`);
          }
          // F-dac7e08c: a transport reject (DNS failure, ECONNREFUSED) means the
          // provider or the runner's NETWORK is down — an operational incident,
          // not evidence the run is absent. Retry within the same budget as a
          // 5xx (at least as transient), then THROW so the reason lands under
          // the operational `provenance-fault:` prefix. The old `return false`
          // persisted a REJECTED submission-bad record during a network blip,
          // and the duplicate guard then blocked a clean resubmission under the
          // same run_id. `return false` is reserved for HTTP 404 (mirrors GitLab).
          if (attempt < retries) {
            const waitMs = nextBackoffMs(null, attempt + 1, backoffMs);
            onRetryWarn({ kind: 'provenance_retry', provider: 'github', attempt: attempt + 1, status_or_reason: err && err.message ? err.message : 'network_error', next_backoff_ms: waitMs });
            await sleep(waitMs);
            continue;
          }
          throw new Error(`provenance: network error: ${err.message}`);
        } finally {
          clearTimeout(timer);
        }

        if (resp.ok) {
          run = await resp.json();
          break;
        }

        // verify-A-002: only 404 means the run is genuinely absent — a real
        // submission-bad rejection, never retried. 429/5xx are transient
        // OPERATIONAL signals: retry within budget. 401/403 (expired/insufficient
        // token) are NOT transient — throw immediately. On exhausted retries the
        // last 429/5xx throws so a real outage still surfaces (operational).
        if (resp.status === 404) return false;
        if (isRetryableStatus(resp.status) && attempt < retries) {
          const waitMs = nextBackoffMs(resp, attempt + 1, backoffMs);
          onRetryWarn({ kind: 'provenance_retry', provider: 'github', attempt: attempt + 1, status_or_reason: resp.status, next_backoff_ms: waitMs });
          await sleep(waitMs);
          continue;
        }
        throw new Error(`provenance: GitHub API returned ${resp.status}`);
      }

      if (run.id !== Number(provider_run_id)) return false;

      // Contract: provenance confirms the workflow run actually EXECUTED
      // (status === 'completed'). Pass/fail is a separate signal carried
      // by submission.ci_checks and scenario verdicts — the verifier still
      // persists failed runs, it just refuses to accept a record before the
      // underlying CI evidence exists. Rejects 'queued' / 'in_progress' / 'waiting'.
      if (run.status !== 'completed') return false;

      // verify-A-001: bind the persisted commit to the confirmed run. The record
      // attests to submission.ref.commit_sha (index.js persists submission.ref
      // verbatim), so the run head MUST equal it. Without this, a submitter who
      // owns a real completed run could set ref.commit_sha to any 40-hex sha and
      // earn a provenance_confirmed 'pass' for a commit the run never executed.
      // Mandatory whenever the binding is supplied — not gated on the optional
      // source.commit_sha.
      if (expected.refCommitSha && run.head_sha !== expected.refCommitSha) return false;
      if (source.commit_sha && run.head_sha !== source.commit_sha) return false;
      if (source.repo && run.repository?.full_name !== source.repo) return false;

      return true;
    }
  };
}

/**
 * Terminal GitLab pipeline/job states. Provenance confirms the pipeline RAN to a
 * terminal state — it is NOT a pass/fail gate (pass/fail is carried by ci_checks
 * and scenario verdicts, exactly as in githubProvenance, which accepts a
 * `completed` run regardless of conclusion). 'success', 'failed', 'canceled',
 * and 'skipped' are terminal; 'running'/'pending'/'created'/'preparing'/
 * 'waiting_for_resource'/'scheduled'/'manual' are not.
 */
const GITLAB_FINISHED_STATES = new Set(['success', 'failed', 'canceled', 'cancelled', 'skipped']);

/**
 * GitLab CI provenance adapter — peer of {@link githubProvenance}.
 *
 * Confirms a GitLab pipeline (or job) exists and matches the claimed project,
 * commit, and finished state. Mirrors githubProvenance's hardening exactly:
 *   - per-request AbortController timeout (throws `provenance: GitLab API timeout`)
 *   - returns false ONLY on HTTP 404 (run genuinely absent)
 *   - THROWS on 401/403/429/5xx as OPERATIONAL (`provenance: GitLab API returned N`)
 *     so parseRejectionReason classifies it operational, not submission-bad
 *   - asserts a finished/terminal pipeline state ({@link GITLAB_FINISHED_STATES})
 *   - binds the pipeline sha (or job commit.id) to the PERSISTED commit
 *     (expected.refCommitSha — the verify-A-001 anti-forgery guard) MANDATORILY,
 *     and binds the run_url project path to source.repo
 *
 * The run_url shape decides which endpoint is queried:
 *   PIPELINE → GET /api/v4/projects/:id/pipelines/:pipeline_id  (commit at .sha)
 *   JOB      → GET /api/v4/projects/:id/jobs/:job_id            (commit at .commit.id)
 * `:id` is the URL-encoded `group/project` (or nested `group/subgroup/project`)
 * path — GitLab accepts the URL-encoded path in place of a numeric project id.
 *
 * @param {string} token - GitLab token with `read_api` scope (sent as PRIVATE-TOKEN).
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch, apiBase?: string }} [opts]
 *   `apiBase` overrides the API origin for self-hosted GitLab (default
 *   'https://gitlab.com'); tests inject `fetchImpl` so no network is hit.
 * @returns {object} Provenance adapter
 */
export function gitlabProvenance(token, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GITLAB_PROVENANCE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const apiBase = (opts.apiBase ?? 'https://gitlab.com').replace(/\/+$/, '');
  const retries = opts.retries ?? PROVENANCE_RETRIES;
  const backoffMs = opts.backoffMs ?? PROVENANCE_BACKOFF_MS;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const onRetryWarn = opts.onRetryWarn ?? defaultOnRetryWarn;
  return {
    /**
     * @param {object} source - submission.source (provider-scoped run claim)
     * @param {{ refCommitSha?: string }} [expected] - see githubProvenance.confirm.
     *   `refCommitSha` (the persisted submission.ref.commit_sha) is checked
     *   MANDATORILY against the confirmed pipeline/job commit (verify-A-001).
     */
    async confirm(source, expected = {}) {
      if (source.provider !== 'gitlab') {
        throw new Error(`unsupported provider: ${source.provider}`);
      }

      const { provider_run_id, run_url } = source;
      if (!provider_run_id || !run_url) {
        return false;
      }

      // Decode the project path + run kind + id from the run_url.
      //   JOB:      https://<host>/<project-path>/-/jobs/<id>
      //   PIPELINE: https://<host>/<project-path>/-/pipelines/<id>
      // <project-path> may be a nested namespace (group/subgroup/project).
      const match = run_url.match(
        /^https:\/\/[^/]+\/(.+?)\/-\/(jobs|pipelines)\/(\d+)(?:[/?#].*)?$/
      );
      if (!match) return false;

      const [, projectPath, runKind, urlRunId] = match;

      // run id in URL must match the claimed provider_run_id.
      if (urlRunId !== String(provider_run_id)) return false;

      // Bind the project path to source.repo BEFORE the network call — a forged
      // project claim is a cheap, offline rejection. V2-CROSS-BO-005
      // (F-54e5fde7 contract): submission.repo is strictly two-segment — the
      // submission schema's `repo` pattern forbids a second slash, so nested
      // GitLab subgroups are UNSUPPORTED end-to-end. A nested project path
      // decoded from the run_url (group/subgroup/project) can therefore never
      // equal a schema-valid source.repo and fails closed right here.
      if (source.repo && projectPath !== source.repo) return false;

      const projectId = encodeURIComponent(projectPath);
      const endpoint = runKind === 'jobs'
        ? `${apiBase}/api/v4/projects/${projectId}/jobs/${provider_run_id}`
        : `${apiBase}/api/v4/projects/${projectId}/pipelines/${provider_run_id}`;

      // PROACT-VERIFY-001: bounded retry over transient provider faults — same
      // discipline as githubProvenance. Each attempt carries its own per-request
      // AbortController timeout. 429/5xx retry within budget (exponential backoff,
      // honoring Retry-After), then THROW on exhaustion so a real outage still
      // surfaces as operational — never a false 'confirmed'. 404 is a single
      // immediate rejection; 401/403 throw immediately (not transient).
      let run;
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let resp;
        try {
          resp = await fetchImpl(endpoint, {
            headers: {
              'PRIVATE-TOKEN': token,
              Accept: 'application/json'
            },
            signal: controller.signal
          });
        } catch (err) {
          if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
            // F-8e72d0de: retry timeouts within the shared budget — peer
            // discipline with githubProvenance (see that adapter's note).
            if (attempt < retries) {
              const waitMs = nextBackoffMs(null, attempt + 1, backoffMs);
              onRetryWarn({ kind: 'provenance_retry', provider: 'gitlab', attempt: attempt + 1, status_or_reason: 'timeout', next_backoff_ms: waitMs });
              await sleep(waitMs);
              continue;
            }
            throw new Error(`provenance: GitLab API timeout after ${timeoutMs}ms`);
          }
          // F-dac7e08c: transport reject = operational, retried then thrown —
          // mirrors githubProvenance exactly. `return false` is 404-only.
          if (attempt < retries) {
            const waitMs = nextBackoffMs(null, attempt + 1, backoffMs);
            onRetryWarn({ kind: 'provenance_retry', provider: 'gitlab', attempt: attempt + 1, status_or_reason: err && err.message ? err.message : 'network_error', next_backoff_ms: waitMs });
            await sleep(waitMs);
            continue;
          }
          throw new Error(`provenance: network error: ${err.message}`);
        } finally {
          clearTimeout(timer);
        }

        if (resp.ok) {
          run = await resp.json();
          break;
        }

        // Mirror verify-A-002: 404 = pipeline/job genuinely absent (submission-bad,
        // never retried). 429/5xx = transient operational fault, retry within
        // budget. 401/403 = non-transient operational, throw immediately.
        if (resp.status === 404) return false;
        if (isRetryableStatus(resp.status) && attempt < retries) {
          const waitMs = nextBackoffMs(resp, attempt + 1, backoffMs);
          onRetryWarn({ kind: 'provenance_retry', provider: 'gitlab', attempt: attempt + 1, status_or_reason: resp.status, next_backoff_ms: waitMs });
          await sleep(waitMs);
          continue;
        }
        throw new Error(`provenance: GitLab API returned ${resp.status}`);
      }

      // id in the response must match the claimed run id.
      if (run.id !== Number(provider_run_id)) return false;

      // Contract: confirm the pipeline/job reached a TERMINAL state. Like
      // githubProvenance's `status === 'completed'`, this is not a pass/fail
      // gate — a terminal 'failed'/'canceled' still confirms the run executed.
      if (!GITLAB_FINISHED_STATES.has(run.status)) return false;

      // The confirmed commit: a pipeline carries it at `.sha`; a job at
      // `.commit.id`. Either must be present for a binding to be possible.
      const runCommit = runKind === 'jobs' ? run.commit?.id : run.sha;
      if (!runCommit) return false;

      // verify-A-001: bind the PERSISTED commit to the confirmed run. Mandatory
      // whenever the binding is supplied — a submitter who owns a real finished
      // pipeline must not be able to attest an arbitrary commit.
      if (expected.refCommitSha && runCommit !== expected.refCommitSha) return false;
      if (source.commit_sha && runCommit !== source.commit_sha) return false;

      return true;
    }
  };
}

/**
 * Provider → provenance-adapter-factory registry, keyed on `source.provider`.
 *
 * Each factory has the signature `(token, opts?) => { confirm(source, expected?) }`.
 * This registry is the lockstep partner of `RUN_URL_PARSERS` in
 * validators/repo-binding.js: a provider in the `source.provider` schema enum
 * MUST have BOTH a run_url parser (so the anti-forgery repo-binding decodes it)
 * AND a provenance adapter (so its runs are confirmable). Two coverage tests —
 * validators/repo-binding.test.js and validators/provenance-registry.test.js —
 * read the actual enum and fail CI if either side is missing for a provider.
 *
 * @type {Record<string, (token: string, opts?: object) => { confirm: Function }>}
 */
export const PROVENANCE_ADAPTERS = {
  github: githubProvenance,
  gitlab: gitlabProvenance,
};

/**
 * Resolve the provenance-adapter factory for a `source.provider`.
 *
 * F-2965699b: `PROVENANCE_ADAPTERS[provider]` alone resolves inherited
 * `Object.prototype` keys (`provider: 'valueOf'` returns
 * `Object.prototype.valueOf`, a truthy function) — the `??` operator only
 * catches `null`/`undefined`, so the `if (!factory)` unknown-provider gate at
 * this function's ONE caller (`resolveProviderProvenance`, packages/ingest/
 * run.js) never fires for the whole Object.prototype key space, and
 * `factory(token)` goes on to call an unrelated Object.prototype method with
 * an unbound `this`, producing an uncaught TypeError (`valueOf`/`__proto__`)
 * or a misleading downstream error (`constructor`/`toString`/
 * `isPrototypeOf`) instead of the correct "unknown provenance provider"
 * message. This site is reached on FULLY UNTRUSTED input — `submission.
 * source.provider` — BEFORE verify()'s schema gate constrains it to the
 * [github, gitlab] enum.
 *
 * `Object.hasOwn` restricts the lookup to the registry's own properties,
 * matching the idiom `safeGet()` already uses in validators/predicate.js —
 * the two prototype-safety sites now read the same.
 *
 * @param {string} provider The `source.provider` token (e.g. 'github', 'gitlab').
 * @returns {((token: string, opts?: object) => { confirm: Function }) | null}
 *   The adapter factory, or `null` when the provider has no registered adapter
 *   (including every Object.prototype key — `constructor`, `toString`,
 *   `valueOf`, `__proto__`, `hasOwnProperty`, `isPrototypeOf`,
 *   `propertyIsEnumerable`, `toLocaleString` — none of which are OWN
 *   properties of PROVENANCE_ADAPTERS).
 */
export function provenanceForProvider(provider) {
  return typeof provider === 'string' && Object.hasOwn(PROVENANCE_ADAPTERS, provider)
    ? PROVENANCE_ADAPTERS[provider]
    : null;
}
