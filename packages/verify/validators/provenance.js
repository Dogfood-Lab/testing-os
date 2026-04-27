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
    async confirm(source) {
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

        if (!resp.ok) return false;

        run = await resp.json();
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
          throw new Error(`provenance: GitHub API timeout after ${timeoutMs}ms`);
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

      if (source.commit_sha && run.head_sha !== source.commit_sha) return false;
      if (source.repo && run.repository?.full_name !== source.repo) return false;

      return true;
    }
  };
}
