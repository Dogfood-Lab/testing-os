/**
 * bounded-json-read.js — Shared size-gate + JSON.parse helper.
 *
 * Background. The swarm control plane reads JSON from several
 * trust-boundary sites: operator-supplied output paths (revalidate.js,
 * persist-results.js manifest dir), agent-emitted output JSONs
 * (findings-digest.js, collect.js), and untrusted target-repo files
 * (lib/verify/adapters/node.js reading the package.json of the repo under
 * audit). Each of these is a path where a pathological input (logging
 * loop, multi-GB blob, malicious >RAM file) would otherwise:
 *
 *   - Block the coordinator's event loop during `JSON.parse` (synchronous
 *     parser holds the loop until done).
 *   - Exhaust memory on very large files (parse buffers + the parsed
 *     object live alongside the original string).
 *
 * `commands/collect.js` had been doing the right thing for one site (an
 * agent output read at line 235-246) with a 50 MB statSync gate before
 * the parse; the other four sites lacked the guard.
 *
 * This helper lifts that pattern. Call sites that adopt this stay in
 * lockstep with the constant — when we revisit the limit (e.g. for
 * verification adapter outputs from build-heavy repos), one source.
 *
 * BR-B-001 (the original collect.js wave). F-H5 (Wave A1 D3): family lift.
 *
 * Out of scope (DO NOT route through this helper). Internal,
 * trust-bounded JSON.parse calls where the input is DB-derived swarm own
 * state (lib/advance.js:314, lib/persist/export.js:109, lib/verify-fixed.js,
 * lib/domains.js:146, commands/resume.js:139): the input was written by
 * the swarm's own code into a trusted column (gates_checked, overrides,
 * domain globs JSON, etc.). Adding the size-gate there would impose a
 * useless O(n) statSync hop on hot paths.
 */

import { readFileSync, statSync } from 'node:fs';

/**
 * Upper bound on bytes read before parse. 50 MB matches the original
 * `commands/collect.js` MAX_AGENT_OUTPUT_BYTES constant; honest swarm
 * outputs are <100 KB even in verbose-findings mode. Operator-supplied
 * inputs are similar in volume.
 *
 * If a legitimate site needs more headroom (e.g. a verification adapter
 * forwarding a large coverage JSON), pass `maxBytes` via opts at the call
 * site rather than nudging the default up. The constant is the floor for
 * "honestly produced" inputs; anything bigger should be visible.
 */
export const MAX_AGENT_OUTPUT_BYTES = 50 * 1024 * 1024;

/**
 * Error subclass surfaced when the path either (a) exceeds the byte limit
 * or (b) can't be parsed. Callers can `instanceof BoundedJsonError` to
 * differentiate from a pure `fs` error.
 *
 * The shape matches the structured-error convention this package uses
 * elsewhere (kind + path + hint) so it slots into the CLI's renderer
 * without a per-site translation.
 */
export class BoundedJsonError extends Error {
  constructor(message, { kind, path: filePath, size, maxBytes, cause } = {}) {
    super(message);
    this.name = 'BoundedJsonError';
    this.kind = kind || 'BOUNDED_JSON';
    this.path = filePath;
    if (size !== undefined) this.size = size;
    if (maxBytes !== undefined) this.maxBytes = maxBytes;
    if (cause) this.cause = cause;
  }
}

/**
 * Read a file as UTF-8 with a size gate, then JSON.parse it.
 *
 * @param {string} filePath — absolute or relative path
 * @param {{ maxBytes?: number }} [opts]
 * @returns {unknown} — parsed JSON value
 * @throws {BoundedJsonError} when the file exceeds the byte limit, can't be
 *   stat'd, or the contents fail JSON.parse. The thrown error carries
 *   `kind` (`SIZE_LIMIT` / `READ_FAILED` / `PARSE_FAILED`), `path`, and
 *   (for SIZE_LIMIT) `size` + `maxBytes`.
 */
export function readBoundedJson(filePath, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_AGENT_OUTPUT_BYTES;

  let stats;
  try {
    stats = statSync(filePath);
  } catch (e) {
    throw new BoundedJsonError(
      `bounded-json: cannot stat ${filePath}: ${e.message}`,
      { kind: 'READ_FAILED', path: filePath, cause: e }
    );
  }

  if (stats.size > maxBytes) {
    const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
    const limitMb = (maxBytes / 1024 / 1024).toFixed(1);
    throw new BoundedJsonError(
      `bounded-json: file exceeds size limit: ${sizeMb} MB (limit: ${limitMb} MB). ` +
      `Path: ${filePath}. The producer likely entered a logging loop, wrote ` +
      `raw stdout instead of structured JSON, or supplied an unintended path. ` +
      `Inspect the file before raising the limit.`,
      { kind: 'SIZE_LIMIT', path: filePath, size: stats.size, maxBytes }
    );
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (e) {
    throw new BoundedJsonError(
      `bounded-json: cannot read ${filePath}: ${e.message}`,
      { kind: 'READ_FAILED', path: filePath, cause: e }
    );
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new BoundedJsonError(
      `bounded-json: JSON parse error at ${filePath}: ${e.message}`,
      { kind: 'PARSE_FAILED', path: filePath, cause: e }
    );
  }
}

/**
 * Registry of every call site under `packages/dogfood-swarm/**` that
 * intentionally routes through {@link readBoundedJson}. The bounded-json
 * discipline guard (`amend1-bounded-json-discipline.test.js`) consults this
 * registry when it scans `JSON.parse(readFileSync(...))` patterns.
 */
export const BOUNDED_JSON_CALL_SITES = Object.freeze([
  { file: 'commands/collect.js', purpose: 'agent output JSON read in the collect loop (the original BR-B-001 site)' },
  { file: 'commands/revalidate.js', purpose: 'operator-supplied output JSON via --domain=name:path' },
  { file: 'persist-results.js', purpose: 'operator-supplied manifest dir audit/* + remediate/* JSONs' },
  { file: 'lib/findings-digest.js', purpose: 'per-domain agent output JSONs in the wave dir' },
  { file: 'lib/verify/adapters/node.js', purpose: 'untrusted target-repo package.json (most exotic input)' },
]);
