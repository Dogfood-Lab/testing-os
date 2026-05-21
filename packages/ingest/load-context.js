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

import { isUnsafeSegment } from './lib/unsafe-segment.js';

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
  try {
    return yaml.load(raw);
  } catch (e) {
    const where = e.mark ? ` at line ${e.mark.line + 1}, column ${e.mark.column + 1}` : '';
    throw new Error(
      `Global policy YAML invalid: ${path}${where} — ${e.message}\n` +
      `Fix the YAML and re-run.`
    );
  }
}

/**
 * Load repo-specific policy. Returns null if no policy exists.
 *
 * @param {string} repoSlug - e.g. "mcp-tool-shop-org/dogfood-labs"
 * @param {string} repoRoot
 * @returns {object|null}
 */
export function loadRepoPolicy(repoSlug, repoRoot) {
  const [org, repo] = repoSlug.split('/');
  if (!org || !repo || isUnsafeSegment(org) || isUnsafeSegment(repo)) return null;
  const path = join(repoRoot, 'policies', 'repos', org, `${repo}.yaml`);

  if (!existsSync(path)) return null;
  try {
    return yaml.load(readFileSync(path, 'utf-8'));
  } catch {
    console.warn(`load-context: malformed YAML in repo policy for ${repoSlug}`);
    return null;
  }
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
 * GitHub scenario fetcher. Loads scenario definitions from a source repo
 * via the GitHub API at a specific commit SHA.
 *
 * @param {string} token - GitHub PAT
 * @param {string} repoSlug - e.g. "mcp-tool-shop-org/shipcheck"
 * @param {string} commitSha - Commit to fetch scenarios from
 * @returns {object} Scenario fetch adapter
 */
export function githubScenarioFetcher(token, repoSlug, commitSha) {
  const [org, repo] = repoSlug.split('/');
  if (!org || !repo || isUnsafeSegment(org) || isUnsafeSegment(repo)) {
    return { async fetch() { return null; } };
  }
  return {
    async fetch(scenarioId) {
      if (!/^[\w-]+$/.test(scenarioId)) return null;
      const path = `dogfood/scenarios/${scenarioId}.yaml`;
      const url = `https://api.github.com/repos/${repoSlug}/contents/${path}?ref=${commitSha}`;

      try {
        const resp = await globalThis.fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.raw+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        });
        if (!resp.ok) return null;
        const text = await resp.text();
        return yaml.load(text);
      } catch {
        return null;
      }
    }
  };
}

/**
 * Load all scenario definitions referenced by a submission's scenario_results.
 *
 * @param {object} submission
 * @param {object} scenarioFetcher - { fetch(scenarioId) => Promise<object|null> }
 * @returns {Promise<{ scenarios: Map<string, object>, errors: string[] }>}
 */
export async function loadScenarios(submission, scenarioFetcher) {
  const scenarios = new Map();
  const errors = [];

  for (const sr of submission.scenario_results || []) {
    const id = sr.scenario_id;
    if (scenarios.has(id)) continue;

    const definition = await scenarioFetcher.fetch(id);
    if (definition) {
      scenarios.set(id, definition);
    } else {
      errors.push(`scenario "${id}" could not be loaded from source repo`);
    }
  }

  return { scenarios, errors };
}
