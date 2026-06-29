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
  const [org, repo] = repoSlug.split('/');
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
 * Default scenario fetcher that reads from the local filesystem.
 * Used when dogfood-labs is dogfooding itself.
 *
 * @param {string} repoRoot - Root of the source repo
 * @returns {object} Scenario fetch adapter
 */
export function localScenarioFetcher(repoRoot) {
  return {
    async fetch(scenarioId) {
      if (!/^[\w-]+$/.test(scenarioId)) return null;
      const path = join(repoRoot, 'dogfood', 'scenarios', `${scenarioId}.yaml`);
      if (!existsSync(path)) return null;
      return yaml.load(readFileSync(path, 'utf-8'));
    }
  };
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
 *     `'timeout' | 'not_found' | 'parse_error' | 'invalid_id'` on
 *     failure (absent on success). The reason gives operators a
 *     pivot key when diagnosing a stale scenario-load chain.
 *
 * Both surfaces honour the per-request AbortController timeout
 * (`GITHUB_SCENARIO_FETCH_TIMEOUT_MS`, overridable via `opts.timeoutMs`).
 *
 * @param {string} token - GitHub PAT
 * @param {string} repoSlug - e.g. "mcp-tool-shop-org/shipcheck"
 * @param {string} commitSha - Commit to fetch scenarios from
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {{ fetch(scenarioId: string): Promise<object|null>, fetchWithReason(scenarioId: string): Promise<{ scenario: object|null, reason?: string }> }}
 */
export function githubScenarioFetcher(token, repoSlug, commitSha, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GITHUB_SCENARIO_FETCH_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));

  const [org, repo] = repoSlug.split('/');
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

  async function fetchWithReason(scenarioId) {
    if (!/^[\w-]+$/.test(scenarioId)) {
      return { scenario: null, reason: 'invalid_id' };
    }
    const path = `dogfood/scenarios/${scenarioId}.yaml`;
    const url = `https://api.github.com/repos/${repoSlug}/contents/${path}?ref=${commitSha}`;

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
        return { scenario: null, reason: 'not_found' };
      }
      text = await resp.text();
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
        return { scenario: null, reason: 'timeout' };
      }
      // Network reject, DNS failure, etc. — surface as not_found for
      // back-compat with the legacy null contract.
      return { scenario: null, reason: 'not_found' };
    } finally {
      clearTimeout(timer);
    }

    try {
      const scenario = yaml.load(text);
      if (!scenario || typeof scenario !== 'object') {
        return { scenario: null, reason: 'parse_error' };
      }
      return { scenario };
    } catch {
      return { scenario: null, reason: 'parse_error' };
    }
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
 * D1B-004 / L1-007 (Wave A2 Stage C amend2): when the fetcher exposes
 * the typed `fetchWithReason` surface (the canonical
 * `githubScenarioFetcher` does; the legacy `localScenarioFetcher` and any
 * legacy test stub may not), the discriminated `reason` (`timeout` /
 * `not_found` / `parse_error` / `invalid_id`) is propagated into the
 * error string so the operator can pivot on the failure class. Otherwise
 * we fall back to the legacy `fetch(id)` truthiness contract.
 *
 * @param {object} submission
 * @param {object} scenarioFetcher - { fetch(scenarioId), fetchWithReason?(scenarioId) }
 * @returns {Promise<{ scenarios: Map<string, object>, errors: string[] }>}
 */
export async function loadScenarios(submission, scenarioFetcher) {
  const scenarios = new Map();
  const errors = [];

  const supportsTypedReason = typeof scenarioFetcher.fetchWithReason === 'function';

  for (const sr of submission.scenario_results || []) {
    const id = sr.scenario_id;
    if (scenarios.has(id)) continue;

    if (supportsTypedReason) {
      const result = await scenarioFetcher.fetchWithReason(id);
      if (result && result.scenario) {
        scenarios.set(id, result.scenario);
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

  return { scenarios, errors };
}
