/**
 * Cross-field repo-binding parsers (verify-B-001).
 *
 * The anti-forgery guard in verify/index.js binds `submission.repo` to the
 * owner/repo encoded in `submission.source.run_url`, so a submitter cannot
 * claim `repo='victim/repo'` while supplying a real run_url from their own
 * repo (the verify-A-001 vector). That guard only works if it can decode the
 * run_url for the submission's PROVIDER.
 *
 * Pre-fix the GitHub run_url regex was inlined in index.js behind `if (m)`.
 * A second provider in the `source.provider` enum would fall through `m ===
 * null` and the binding would SILENTLY no-op — reopening the forgery vector
 * for the new provider with no error and no test failure.
 *
 * The fix keys the parsers by provider. `RUN_URL_PARSERS` MUST stay in lockstep
 * with the `source.provider` enum in dogfood-record-submission.schema.json —
 * a guard-coverage test (repo-binding.test.js) asserts exactly that, so adding
 * a provider to the schema without adding a parser here fails CI instead of
 * silently disabling the binding for the new provider.
 */

/**
 * @typedef {object} RunUrlRepo
 * @property {string} owner Repository owner/org.
 * @property {string} repo  Repository name.
 */

/**
 * Per-provider run_url → { owner, repo } parser.
 *
 * Each parser returns `null` when the URL does not match the provider's run_url
 * shape (malformed/foreign URL). A malformed URL is NOT a binding failure —
 * the schema validator already rejects a malformed source.run_url — so the
 * guard treats a `null` parse as "nothing to bind against" and lets the schema
 * layer own the rejection.
 *
 * @type {Record<string, (runUrl: string) => RunUrlRepo | null>}
 */
export const RUN_URL_PARSERS = {
  // Format: https://github.com/{owner}/{repo}/actions/runs/{id}
  github(runUrl) {
    const m = runUrl.match(
      /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/\d+$/
    );
    return m ? { owner: m[1], repo: m[2] } : null;
  },
};

/**
 * Decode the owner/repo a run_url attests to, for the given provider.
 *
 * @param {string} provider The `source.provider` token (e.g. 'github').
 * @param {string} runUrl   The `source.run_url`.
 * @returns {RunUrlRepo | null} `{ owner, repo }`, or `null` when the provider
 *   has no parser or the URL does not match the provider's shape.
 */
export function parseRunUrlRepo(provider, runUrl) {
  const parser = RUN_URL_PARSERS[provider];
  if (!parser) return null;
  return parser(runUrl);
}
