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

      // Per-request timeout. Without this, a hung GitHub API call (rate-limit
      // throttle, regional outage, slow connection) blocks ingest indefinitely.
      // AbortController fires AbortError on timeout — we re-throw with a clear
      // message so the verifier records it in rejection_reasons instead of
      // silently treating it as 'provenance returned false.'
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let run;
      try {
        const resp = await fetchImpl(apiUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          signal: controller.signal
        });

        if (!resp.ok) {
          // verify-A-002: only 404 means the run is genuinely absent — a real
          // submission-bad rejection. Every other non-2xx is an OPERATIONAL
          // signal (401/403 expired/insufficient token, 429 rate limit, 5xx
          // GitHub outage). Collapsing those into `return false` made the
          // verifier record 'source run could not be confirmed' and routing
          // bounced an ops incident to submitters. Throw so the existing catch
          // in index.js records it as a provenance verification failure
          // (operational), mirroring the timeout fix above.
          if (resp.status === 404) return false;
          throw new Error(`provenance: GitHub API returned ${resp.status}`);
        }

        run = await resp.json();
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
          throw new Error(`provenance: GitHub API timeout after ${timeoutMs}ms`);
        }
        // verify-A-002: operational signals we raised ourselves (non-2xx HTTP)
        // already carry the 'provenance:' prefix — re-throw them so they reach
        // index.js as a verification failure rather than being swallowed into
        // 'return false'. Reserve `return false` for genuine transport errors
        // (DNS, connection refused) where there is no run to confirm.
        if (err && typeof err.message === 'string' && err.message.startsWith('provenance:')) {
          throw err;
        }
        return false;
      } finally {
        clearTimeout(timer);
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
      // project claim is a cheap, offline rejection. For GitLab, submission.repo
      // is the full project path (which may contain nested-subgroup slashes).
      if (source.repo && projectPath !== source.repo) return false;

      const projectId = encodeURIComponent(projectPath);
      const endpoint = runKind === 'jobs'
        ? `${apiBase}/api/v4/projects/${projectId}/jobs/${provider_run_id}`
        : `${apiBase}/api/v4/projects/${projectId}/pipelines/${provider_run_id}`;

      // Per-request timeout — identical discipline to githubProvenance. Without
      // it a hung gitlab.com/api call blocks ingest until the surrounding runner
      // times out. AbortError → re-thrown with a clear 'provenance:' message so
      // the verifier records it instead of silently returning false.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let run;
      try {
        const resp = await fetchImpl(endpoint, {
          headers: {
            'PRIVATE-TOKEN': token,
            Accept: 'application/json'
          },
          signal: controller.signal
        });

        if (!resp.ok) {
          // Mirror verify-A-002: only 404 means the pipeline/job is genuinely
          // absent (submission-bad). 401/403/429/5xx are OPERATIONAL — throw so
          // the catch in index.js records a 'provenance:' verification failure
          // (paged to ops) instead of bouncing an outage to the submitter.
          if (resp.status === 404) return false;
          throw new Error(`provenance: GitLab API returned ${resp.status}`);
        }

        run = await resp.json();
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
          throw new Error(`provenance: GitLab API timeout after ${timeoutMs}ms`);
        }
        // Operational signals we raised ourselves already carry the
        // 'provenance:' prefix — re-throw. Reserve `return false` for genuine
        // transport errors (DNS, connection refused) where there is no run.
        if (err && typeof err.message === 'string' && err.message.startsWith('provenance:')) {
          throw err;
        }
        return false;
      } finally {
        clearTimeout(timer);
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
 * @param {string} provider The `source.provider` token (e.g. 'github', 'gitlab').
 * @returns {((token: string, opts?: object) => { confirm: Function }) | null}
 *   The adapter factory, or `null` when the provider has no registered adapter.
 */
export function provenanceForProvider(provider) {
  return PROVENANCE_ADAPTERS[provider] ?? null;
}
