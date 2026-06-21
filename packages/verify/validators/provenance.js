/**
 * Provenance adapters
 *
 * The verifier checks that a source run actually exists and matches claims.
 * Two adapters:
 * - stub: always confirms (for tests and local development)
 * - github: confirms via GitHub Actions API (for production)
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
