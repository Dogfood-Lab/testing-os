/**
 * registry.js — Adapter registry for swarm verify.
 *
 * Each adapter implements:
 *   probe(repoPath)  → { score: 0-100, reason: string, evidence: object }
 *   commands(profile) → { lint?, typecheck?, test?, build? } — each a { cmd, args } or null
 *   run(repoPath, profile?) → VerificationReceipt
 *
 * The registry selects the best adapter by probe score.
 * Explicit override skips probing entirely.
 */

import { nodeAdapter } from './adapters/node.js';
import { pythonAdapter } from './adapters/python.js';
import { rustAdapter } from './adapters/rust.js';

const ADAPTERS = new Map([
  ['node', nodeAdapter],
  ['python', pythonAdapter],
  ['rust', rustAdapter],
]);

/**
 * Deterministic tie-break priority for equal-confidence probes (ve-p-006).
 *
 * A polyglot repo can legitimately score equally under two adapters (e.g. a
 * Rust core with a Node tooling layer). Sorting by score alone left the winner
 * to the Map's insertion order — an implicit, undocumented precedence that
 * grows more fragile as adapters are added. This makes the precedence explicit
 * and testable: HIGHER wins on a score tie. The ordering reflects marker
 * exclusivity — `Cargo.toml` is a near-certain Rust signal, `pyproject.toml`
 * is Python-specific, and `package.json` is the most common file to appear
 * incidentally in a non-Node repo (build tooling, JS assets), so it loses ties.
 * An operator can always force a choice with `--adapter`.
 */
const ADAPTER_TIE_BREAK = new Map([
  ['rust', 3],
  ['python', 2],
  ['node', 1],
]);

/**
 * Probe all adapters and rank by score.
 *
 * @param {string} repoPath
 * @returns {Array<{ name: string, score: number, reason: string, evidence: object }>}
 */
export function probeAll(repoPath) {
  const results = [];
  for (const [name, adapter] of ADAPTERS) {
    try {
      const probe = adapter.probe(repoPath);
      results.push({ name, ...probe });
    } catch (e) {
      results.push({ name, score: 0, reason: `Probe error: ${e.message}`, evidence: {} });
    }
  }
  // ve-p-006: stable, documented tie-break on equal score. Without it, the
  // winner of a score tie was whatever the engine's stable sort left first
  // given Map insertion order — a latent surprise as adapters grow.
  return results.sort(
    (a, b) =>
      b.score - a.score ||
      (ADAPTER_TIE_BREAK.get(b.name) ?? 0) - (ADAPTER_TIE_BREAK.get(a.name) ?? 0)
  );
}

/**
 * Select the best adapter for a repo.
 * Returns the highest-scoring adapter with score > 0, or null.
 *
 * @param {string} repoPath
 * @param {string} [override] — force a specific adapter name
 * @returns {{ name: string, adapter: object, probe: object } | null}
 */
export function selectAdapter(repoPath, override) {
  if (override) {
    const adapter = ADAPTERS.get(override);
    if (!adapter) throw new Error(`Unknown adapter: "${override}". Available: ${[...ADAPTERS.keys()].join(', ')}`);
    const probe = adapter.probe(repoPath);
    return { name: override, adapter, probe };
  }

  const ranked = probeAll(repoPath);
  if (ranked.length === 0 || ranked[0].score === 0) return null;
  const best = ranked[0];
  return { name: best.name, adapter: ADAPTERS.get(best.name), probe: best };
}

/**
 * Run verification using the selected adapter.
 *
 * @param {string} repoPath
 * @param {object} opts
 * @param {string} [opts.override] — force adapter
 * @param {object} [opts.commandOverrides] — override specific commands
 * @returns {object} — VerificationResult
 */
export function runVerification(repoPath, opts = {}) {
  const selection = selectAdapter(repoPath, opts.override);
  if (!selection) {
    return {
      adapter: null,
      probe: null,
      steps: [],
      verdict: 'skip',
      reason: 'No adapter matched this repo',
    };
  }

  const { name, adapter, probe } = selection;
  const result = adapter.run(repoPath, opts.commandOverrides);

  return {
    adapter: name,
    probe: { score: probe.score, reason: probe.reason, evidence: probe.evidence },
    ...result,
  };
}

/**
 * List available adapters.
 */
export function listAdapters() {
  return [...ADAPTERS.keys()];
}

export { ADAPTERS };
