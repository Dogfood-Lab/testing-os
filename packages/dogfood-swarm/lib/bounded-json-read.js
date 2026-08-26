/**
 * bounded-json-read.js — Shared size-gate + bounded-read helpers, for JSON
 * (readBoundedJson) and raw text (readBoundedText) alike.
 *
 * Background. The swarm control plane reads untrusted or size-unbounded
 * content from several trust-boundary sites: operator-supplied output paths
 * (revalidate.js, persist-results.js manifest dir), agent-emitted output
 * JSONs (findings-digest.js, collect.js), and untrusted target-repo files
 * (lib/verify/adapters/{node,python,rust}.js reading the manifest of the
 * repo under audit). Each of these is a path where a pathological input
 * (logging loop, multi-GB blob, malicious >RAM file) would otherwise:
 *
 *   - Block the coordinator's event loop during `JSON.parse` (synchronous
 *     parser holds the loop until done) or during a large synchronous read.
 *   - Exhaust memory on very large files (read buffers + any parsed object
 *     live alongside the original bytes).
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
 * F-a89f89f7 (Wave 18): the statSync gate alone was never enough — a plain
 * `readFileSync(path)` has no length argument, so it always reads to EOF in
 * one synchronous call before any post-read check can run. readBoundedFromFd
 * closes that gap by bounding the READ ITSELF (chunked fs.readSync, bails
 * as soon as the cap is crossed), and readBoundedText extends the same
 * bounded-read discipline to non-JSON text consumers (the TOML manifest
 * adapters), which had each been maintaining a private, unbounded,
 * un-rechecked copy of the pre-fix pattern instead of sharing this module.
 *
 * Out of scope (DO NOT route through this helper). Internal,
 * trust-bounded JSON.parse calls where the input is DB-derived swarm own
 * state (lib/advance.js:314, lib/persist/export.js:109, lib/verify-fixed.js,
 * lib/domains.js:146, commands/resume.js:139): the input was written by
 * the swarm's own code into a trusted column (gates_checked, overrides,
 * domain globs JSON, etc.). Adding the size-gate there would impose a
 * useless O(n) statSync hop on hot paths.
 */

import { statSync, openSync, readSync, closeSync } from 'node:fs';

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
 * Chunk size for the bounded read loop (readBoundedFromFd). Small enough
 * that a file which blows past maxBytes is caught within one chunk of the
 * cap — worst-case memory overshoot is this constant, not the file's full
 * size; large enough that an honest sub-1MB swarm output completes in a
 * single syscall.
 */
const READ_CHUNK_BYTES = 1024 * 1024; // 1 MB

/**
 * Stable `.code` values for {@link BoundedJsonError}, keyed by `.kind`.
 * F-e0eebfec: renderTopLevelError branches on `.code`; pre-fix this class
 * only set `.code` from an fs cause (READ_FAILED) and never set `.hint`, so
 * SIZE_LIMIT / PARSE_FAILED rendered as untyped `ERROR: …` with no Next:.
 */
const BOUNDED_JSON_CODES = Object.freeze({
  SIZE_LIMIT: 'BOUNDED_JSON_SIZE_LIMIT',
  READ_FAILED: 'BOUNDED_JSON_READ_FAILED',
  PARSE_FAILED: 'BOUNDED_JSON_PARSE_FAILED',
});

const BOUNDED_JSON_HINTS = Object.freeze({
  SIZE_LIMIT: 'inspect the file (logging loop / raw stdout / wrong path), lower the producer output, or raise maxBytes only after confirming the content is legitimate',
  READ_FAILED: 'inspect the path (existence, permissions, not a directory) and retry',
  PARSE_FAILED: 'fix the JSON at the path (truncated write, trailing commas, or non-JSON content) and retry',
});

/**
 * Error subclass surfaced when the path either (a) exceeds the byte limit
 * or (b) can't be parsed. Callers can `instanceof BoundedJsonError` to
 * differentiate from a pure `fs` error.
 *
 * Shape (F-e0eebfec): stable `.code` + `.kind` + `.path` + default `.hint`
 * so renderTopLevelError emits `ERROR [<CODE>]:` and a Next: line without
 * a per-site translation. Underlying fs codes (ENOENT / EISDIR / …) stay
 * on `.cause.code` — adapters that want the fs signal read the cause.
 */
export class BoundedJsonError extends Error {
  constructor(message, { kind, path: filePath, size, maxBytes, cause, hint } = {}) {
    super(message);
    this.name = 'BoundedJsonError';
    this.kind = kind || 'BOUNDED_JSON';
    // F-e0eebfec: always a stable swarm code for the CLI envelope — never
    // the underlying fs code (that lives on cause.code when present).
    this.code = BOUNDED_JSON_CODES[this.kind] || 'BOUNDED_JSON';
    this.path = filePath;
    if (size !== undefined) this.size = size;
    if (maxBytes !== undefined) this.maxBytes = maxBytes;
    this.hint = hint || BOUNDED_JSON_HINTS[this.kind]
      || 'inspect the path named in the message and retry with a smaller or well-formed input';
    if (cause) this.cause = cause;
  }
}

/**
 * Read from an ALREADY-OPEN, readable fd in fixed-size chunks, stopping the
 * loop — not just a post-hoc length check — as soon as cumulative bytes
 * read crosses maxBytes.
 *
 * fp-004 (F-a89f89f7): this is the actual close of the statSync→read TOCTOU
 * window. The prior fix's comment claimed the window was closed by checking
 * `buf.length > maxBytes` on the result of a plain `readFileSync(filePath)`
 * — but Node's fs API has no length-bounded read; readFileSync(path) always
 * reads to EOF in one synchronous call BEFORE any check can run, allocating
 * a buffer sized to the file's ACTUAL size at read time. For a file that
 * passes the statSync gate and then grows past maxBytes before the read
 * runs (a producer actively writing — the "logging loop" scenario this
 * module's header names as its reason to exist), the old code still
 * performed the full unbounded read + allocation this module is supposed to
 * prevent, and only noticed afterward. Reading in bounded chunks via a raw
 * fd means a multi-GB actively-growing file is never fully buffered — the
 * loop exits within one READ_CHUNK_BYTES of the cap, not after the file's
 * full size has been read.
 *
 * Exported (in addition to the path-based helpers below) so the caller can
 * hold the fd open across an external mutation and so
 * bounded-json-read-toctou-close.test.js can drive the exact race
 * deterministically instead of depending on real-world OS scheduling.
 *
 * @param {number} fd — opened via openSync; the caller owns closing it.
 * @param {number} maxBytes
 * @returns {Buffer} — length is EOF-bounded normally, or
 *   `maxBytes < length <= maxBytes + READ_CHUNK_BYTES` when the cap was
 *   crossed before EOF (the caller's post-read length check rejects this).
 */
export function readBoundedFromFd(fd, maxBytes) {
  const chunks = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  for (;;) {
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break; // EOF
    total += bytesRead;
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    // Stop as soon as the cap is crossed instead of continuing to EOF — this
    // is what makes the bound apply to the READ, not just to a check run
    // after an unbounded read already completed.
    if (total > maxBytes) break;
  }
  return Buffer.concat(chunks, total);
}

/**
 * Read a file into a Buffer with a size gate on both the pre-read stat AND
 * the read itself (via {@link readBoundedFromFd}), rejecting with a
 * structured {@link BoundedJsonError} rather than ever fully buffering an
 * oversized or actively-growing file.
 *
 * @param {string} filePath — absolute or relative path
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Buffer}
 * @throws {BoundedJsonError} `READ_FAILED` (stat/open/read failure) or
 *   `SIZE_LIMIT` (oversized at stat time, or the read crossed maxBytes
 *   before EOF — the TOCTOU case).
 */
export function readBoundedBuffer(filePath, opts = {}) {
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

  // Fast-path reject: a file already oversized at stat time never needs to
  // be opened at all. This is the common case (a stray multi-GB file, an
  // unintended path) and stays cheap — one syscall, no read.
  if (stats.size > maxBytes) {
    const sizeMb = (stats.size / 1024 / 1024).toFixed(1);
    const limitMb = (maxBytes / 1024 / 1024).toFixed(1);
    // F-76fc969b: one-line fact only — Path: is a renderTopLevelError detail
    // line; remediation lives on `.hint` / Next:, not packed into the header.
    throw new BoundedJsonError(
      `bounded-json: file exceeds size limit: ${sizeMb} MB (limit: ${limitMb} MB)`,
      { kind: 'SIZE_LIMIT', path: filePath, size: stats.size, maxBytes }
    );
  }

  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (e) {
    throw new BoundedJsonError(
      `bounded-json: cannot read ${filePath}: ${e.message}`,
      { kind: 'READ_FAILED', path: filePath, cause: e }
    );
  }

  let buf;
  try {
    buf = readBoundedFromFd(fd, maxBytes);
  } catch (e) {
    throw new BoundedJsonError(
      `bounded-json: cannot read ${filePath}: ${e.message}`,
      { kind: 'READ_FAILED', path: filePath, cause: e }
    );
  } finally {
    closeSync(fd);
  }

  // fp-004: this is now a real TOCTOU catch, not just documentation of one —
  // readBoundedFromFd stopped reading within one chunk of maxBytes, so a
  // file that grew past the cap between the statSync above and this read is
  // caught here without ever having been read in full.
  if (buf.length > maxBytes) {
    const sizeMb = (buf.length / 1024 / 1024).toFixed(1);
    const limitMb = (maxBytes / 1024 / 1024).toFixed(1);
    // F-76fc969b: on-read sibling — same one-line fact; Path:/Next: elsewhere.
    throw new BoundedJsonError(
      `bounded-json: file exceeds size limit on read: ${sizeMb} MB (limit: ${limitMb} MB)`,
      { kind: 'SIZE_LIMIT', path: filePath, size: buf.length, maxBytes }
    );
  }

  return buf;
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
  const buf = readBoundedBuffer(filePath, opts);
  const raw = buf.toString('utf-8');

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
 * Read a file as UTF-8 TEXT with the same size gate as {@link
 * readBoundedJson} (stat fast-path + bounded chunked read via {@link
 * readBoundedFromFd}), without the JSON.parse step — for untrusted
 * non-JSON manifests (TOML, etc.) consumed via string scans.
 *
 * F-a89f89f7: added so lib/verify/adapters/python.js and rust.js can route
 * their pyproject.toml/Cargo.toml reads through this shared primitive
 * instead of each maintaining a private statSync-then-readFileSync copy —
 * which had independently reproduced a WORSE version of the same TOCTOU gap
 * (no post-read recheck at all).
 *
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {string}
 * @throws {BoundedJsonError} `READ_FAILED` or `SIZE_LIMIT` — see {@link
 *   readBoundedBuffer}. Never `PARSE_FAILED` (there is no parse step).
 */
export function readBoundedText(filePath, opts = {}) {
  return readBoundedBuffer(filePath, opts).toString('utf-8');
}

/**
 * Registry of every call site under `packages/dogfood-swarm/**` that
 * intentionally routes through {@link readBoundedJson}. The bounded-json
 * discipline guard (`amend1-bounded-json-discipline.test.js`, package root)
 * consults this registry when it scans `JSON.parse(readFileSync(...))`
 * patterns, and separately hard-asserts this exact file list in
 * `amend1-bounded-json-read.test.js`'s "registry lists every migrated call
 * site" test — both out of the swarm-cp-core domain's owned glob
 * (`packages/dogfood-swarm/lib/**` only). Left UNCHANGED by F-a89f89f7 for
 * that reason.
 *
 * F-a89f89f7 (Wave 18): lib/verify/adapters/python.js and rust.js now also
 * route through this module's shared bounded-read primitive — via {@link
 * readBoundedText}, not {@link readBoundedJson} — but are deliberately NOT
 * added here. This registry and its discipline guard are scoped to the
 * `JSON.parse(readFileSync(...))` bug shape specifically; the TOML adapters
 * never matched that pattern (they scan text with `.includes()`/`.match()`,
 * never `JSON.parse`), so they were never candidates for it. Their coverage
 * lives in bounded-json-read-toctou-close.test.js instead.
 */
export const BOUNDED_JSON_CALL_SITES = Object.freeze([
  { file: 'commands/collect.js', purpose: 'agent output JSON read in the collect loop (the original BR-B-001 site)' },
  { file: 'commands/revalidate.js', purpose: 'operator-supplied output JSON via --domain=name:path' },
  { file: 'persist-results.js', purpose: 'operator-supplied manifest dir audit/* + remediate/* JSONs' },
  { file: 'lib/findings-digest.js', purpose: 'per-domain agent output JSONs in the wave dir' },
  { file: 'lib/verify/adapters/node.js', purpose: 'untrusted target-repo package.json (most exotic input)' },
]);
