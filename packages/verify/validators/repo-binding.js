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

  // GitLab run_url shapes (gitlab.com AND self-hosted hosts):
  //   JOB:      https://<host>/<namespace>/<project>/-/jobs/<id>
  //   PIPELINE: https://<host>/<namespace>/<project>/-/pipelines/<id>
  // The project path is everything between the host and the `/-/` run segment.
  //
  // TWO-SEGMENT CONTRACT (F-54e5fde7, load-bearing decision): nested GitLab
  // subgroups (`group/subgroup/project`) are UNSUPPORTED end-to-end. The
  // submission schema's `repo` pattern (^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$)
  // forbids a second slash, so a nested project path can never be a valid
  // submission.repo, and the policy loaders (ingest load-context.js, verify
  // cli.js) fail closed on 3+-segment slugs. A GitLab consumer with nested
  // subgroups must submit from a top-level group/project (or mirror the repo)
  // until the contract is widened deliberately — schema pattern, both policy
  // loaders, and the records/ path layout together, never piecemeal.
  //
  // The parser still maps owner = full namespace (slashes preserved) and
  // repo = last segment. That is DELIBERATE fail-closed behavior, not nested
  // support: for a nested run_url the reconstructed `${owner}/${repo}` carries
  // 2+ slashes and can never equal a schema-valid submission.repo, so the
  // binding guard rejects with repo:mismatch instead of silently skipping the
  // anti-forgery check (returning null here would fail OPEN). For a flat
  // `group/project` this degenerates to owner='group', repo='project' — the
  // same shape as GitHub, and the only shape the contract supports.
  //
  // A single-segment path (no namespace + project, just `<project>/-/jobs/<id>`)
  // returns null — it cannot be split into owner + repo and is not a valid
  // GitLab project URL.
  gitlab(runUrl) {
    const m = runUrl.match(
      /^https:\/\/[^/]+\/(.+?)\/-\/(?:jobs|pipelines)\/\d+(?:[/?#].*)?$/
    );
    if (!m) return null;
    const segments = m[1].split('/');
    if (segments.length < 2) return null; // need at least namespace + project
    const repo = segments.pop();
    const owner = segments.join('/');
    return { owner, repo };
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
