/**
 * status.js — the post-dispatch confirmation for @dogfood-lab/report.
 *
 * The most dangerous adoption failure is NOT a noisy one. A consumer wires the
 * dogfood workflow, their CI dispatches the submission, the job goes green — and
 * the submission was never recorded (rejected on provenance/schema/policy, or
 * simply lost to a transient dispatch failure). Nothing in the CONSUMER's own CI
 * ever turns red, so they believe they are being measured when they are not.
 *
 * `runStatus` closes that loop. It reads the receiver's PUBLIC served index —
 *   https://raw.githubusercontent.com/dogfood-lab/testing-os/main/indexes/latest-by-repo.json
 * — which needs NO auth, and answers three questions with a single exit code a CI
 * step can gate on:
 *
 *   1. recorded?  — is the consumer's repo present in latest-by-repo.json at all?
 *                   That index is built ONLY from ACCEPTED records (see
 *                   packages/ingest/rebuild-indexes.js: `if status !== 'accepted'
 *                   continue`), so absence means the run was rejected (it went to
 *                   records/_rejected/, which is never served) OR never arrived.
 *                   Both are failures the consumer must see.
 *   2. accepted?  — present ⇒ accepted by construction. But the recorded verdict
 *                   may still be a non-pass `verified` value; when it is, status
 *                   fetches the served record JSON and surfaces its
 *                   verification.rejection_reasons so the consumer learns WHY.
 *   3. fresh?     — is the latest accepted run within the freshness window? A
 *                   stale latest run means the dogfood pipeline silently stopped
 *                   producing records, which is exactly the failure this guards.
 *
 * Exit contract (mirrors swarm doctor): exit non-zero on a hard problem
 * (unrecorded, non-pass verdict, or stale); exit 0 only on recorded + accepted +
 * pass + fresh. A consumer adds this as a CI step so a silent non-record fails
 * loudly instead of going green.
 *
 * The fetch implementation and the index base URL are both injectable so the
 * tests run fully offline against a local fixture — no network, no flakiness.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The receiver repo whose served indexes carry every consumer's record. */
const RECEIVER_REPO = 'dogfood-lab/testing-os';

/**
 * F-19d78ede: default per-request timeout for this module's network fetch.
 * This file's own header states the mission: "the most dangerous adoption
 * failure is NOT a noisy one... nothing in the consumer's own CI ever turns
 * red." Every OTHER network call in this domain is bounded for exactly this
 * reason (packages/verify/validators/provenance.js's
 * GITHUB_PROVENANCE_TIMEOUT_MS / GITLAB_PROVENANCE_TIMEOUT_MS;
 * packages/ingest/load-context.js's GITHUB_SCENARIO_FETCH_TIMEOUT_MS) — a
 * hung API call would otherwise stall the consumer's CI step until the
 * surrounding runner's own timeout fires (GitHub Actions default 6h),
 * replacing this module's one guaranteed signal (a clean, structured
 * `INDEX_UNREACHABLE`) with a generic, unhelpful runner timeout. This was
 * the ONLY unbounded network call in the file (confirmed by grep across
 * packages/report/: zero occurrences of 'timeout'/'AbortController'/'signal'
 * before this fix).
 */
export const DEFAULT_STATUS_FETCH_TIMEOUT_MS = 30000;

/**
 * Read + parse a file:// index artifact off disk, mirroring fetchJsonOrNull's
 * contract: null when the file is absent (the "not present" answer), a structured
 * {code} throw on a parse failure the caller must surface rather than misread.
 *
 * @param {string} fileUrl
 * @returns {any|null}
 */
function readFileJsonOrNull(fileUrl) {
  const path = fileURLToPath(fileUrl);
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    const e = new Error(`could not read local index ${path}: ${err && err.message ? err.message : err}`);
    e.code = 'INDEX_UNREACHABLE';
    e.hint = 'Confirm the --index-base file:// path exists and is readable.';
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const e = new Error(`local index ${path} was not valid JSON: ${err && err.message ? err.message : err}`);
    e.code = 'INDEX_MALFORMED';
    e.hint = 'The local index is corrupt; regenerate it or point --index-base elsewhere.';
    throw e;
  }
}

/**
 * The default public base for the served indexes/ and records/ trees. Ends in a
 * trailing slash so `new URL(relPath, base)` joins cleanly. Overridable via the
 * --index-base flag (the bin) or the `indexBase` option (this module) so tests
 * point at a local file:// directory.
 */
export const DEFAULT_INDEX_BASE = `https://raw.githubusercontent.com/${RECEIVER_REPO}/main/`;

/**
 * The freshness window, in days. Matches the ingest rebuild-indexes default
 * (`staleDays = 30`) so "fresh" here means the same thing the receiver's own
 * stale.json would say. Overridable via `staleDays` for tests/strict consumers.
 */
export const DEFAULT_STALE_DAYS = 30;

/**
 * F-d433f8a4: refuse an index entry.path that would leave the receiver's
 * records/ tree. WHATWG `new URL(relPath, base)` turns absolute URLs and
 * protocol-relative paths into a different origin, and a leading `/` or `..`
 * segment can escape the repo prefix. Index paths are normally repo-relative
 * forward-slash paths under `records/`; a poisoned latest-by-repo.json must
 * not make consumer CI fetch attacker-controlled JSON when surfacing
 * rejection_reasons.
 *
 * @param {string} relPath
 * @param {string} base
 */
export function assertSafeRecordPath(relPath, base) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    const e = new Error('index entry path is missing or not a string');
    e.code = 'INDEX_MALFORMED';
    e.hint = 'latest-by-repo.json entries must carry a relative records/ path.';
    throw e;
  }
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relPath) ||
    relPath.startsWith('//') ||
    relPath.startsWith('/') ||
    relPath.includes('..')
  ) {
    const e = new Error(`index entry path is not a safe relative records/ path: ${relPath}`);
    e.code = 'INDEX_MALFORMED';
    e.hint = 'Refuse absolute, protocol-relative, rooted, or .. paths; rebuild-indexes emits repo-relative records/ paths only.';
    throw e;
  }

  const baseUrl = new URL(base.endsWith('/') ? base : `${base}/`);
  const resolved = new URL(relPath, baseUrl);
  if (resolved.protocol !== baseUrl.protocol) {
    const e = new Error(`index entry path resolves off the index base protocol: ${relPath}`);
    e.code = 'INDEX_MALFORMED';
    e.hint = 'entry.path must resolve under the same scheme as --index-base.';
    throw e;
  }
  // file: URLs report origin as the string "null"; compare href prefixes instead
  // of origin so both https:// and file:// bases stay covered.
  const recordsRoot = new URL('records/', baseUrl);
  if (!resolved.href.startsWith(recordsRoot.href)) {
    const e = new Error(`index entry path does not stay under records/ after resolve: ${relPath}`);
    e.code = 'INDEX_MALFORMED';
    e.hint = 'entry.path must resolve under the records/ prefix of --index-base.';
    throw e;
  }
}

/**
 * Fetch and parse one served JSON artifact, relative to the index base.
 * Returns null on a 404 (a normal "not present" answer, not an error) and throws
 * a structured {code} error only on a transport/parse failure the caller should
 * surface as a hard problem rather than misread as "absent".
 *
 * @param {(url: string, init?: {signal?: AbortSignal}) => Promise<{ok:boolean,status:number,json:()=>Promise<any>}>} fetchImpl
 * @param {string} base
 * @param {string} relPath
 * @param {number} [timeoutMs=DEFAULT_STATUS_FETCH_TIMEOUT_MS]
 * @returns {Promise<any|null>}
 */
async function fetchJsonOrNull(fetchImpl, base, relPath, timeoutMs = DEFAULT_STATUS_FETCH_TIMEOUT_MS) {
  const url = new URL(relPath, base).toString();

  // Node's fetch() does not implement the file: scheme, but a local index mirror
  // is a legitimate base (CI air-gap, tests, a vendored snapshot). Read those
  // straight off disk with the same null-on-absent / structured-throw contract.
  if (url.startsWith('file:')) {
    return readFileJsonOrNull(url);
  }

  // F-19d78ede: bound the ONE network call this module makes so a hung
  // raw.githubusercontent.com response fails fast with this module's own
  // structured INDEX_UNREACHABLE instead of wedging the consumer's CI step
  // for hours. Mirrors the AbortController pattern already established by
  // provenance.js / load-context.js in this same domain.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      const e = new Error(`served index fetch timed out after ${timeoutMs}ms: ${url}`);
      e.code = 'INDEX_UNREACHABLE';
      e.hint = `The request to ${url} did not complete within ${timeoutMs}ms. Check network access, or pass --index-base at a reachable mirror.`;
      throw e;
    }
    const e = new Error(`could not reach the served index at ${url}: ${err && err.message ? err.message : err}`);
    e.code = 'INDEX_UNREACHABLE';
    e.hint = `Confirm network access to ${base}, or pass --index-base at a reachable mirror.`;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404 || res.ok === false) {
    if (res.status === 404) return null;
    const e = new Error(`served index ${url} returned HTTP ${res.status}`);
    e.code = 'INDEX_UNREACHABLE';
    e.hint = `Confirm ${url} is reachable, or pass --index-base at a reachable mirror.`;
    throw e;
  }
  try {
    return await res.json();
  } catch (err) {
    const e = new Error(`served index ${url} was not valid JSON: ${err && err.message ? err.message : err}`);
    e.code = 'INDEX_MALFORMED';
    e.hint = 'The served index is corrupt; re-check the --index-base or report it upstream.';
    throw e;
  }
}

/**
 * Confirm a consumer's latest dogfood run against the receiver's public index.
 *
 * @param {object} opts
 * @param {string} opts.repo — the consumer's `org/repo` slug to confirm.
 * @param {string} [opts.surface] — restrict the check to one product_surface.
 *   Omitted ⇒ the run is "recorded" if ANY surface is present, and the freshest
 *   surface decides accepted/fresh.
 * @param {string} [opts.indexBase=DEFAULT_INDEX_BASE]
 * @param {number} [opts.staleDays=DEFAULT_STALE_DAYS]
 * @param {(url:string, init?: {signal?: AbortSignal})=>Promise<any>} [opts.fetchImpl=globalThis.fetch]
 * @param {number} [opts.now=Date.now()] — injectable clock for deterministic tests.
 * @param {number} [opts.fetchTimeoutMs=DEFAULT_STATUS_FETCH_TIMEOUT_MS] — F-19d78ede:
 *   per-request timeout for this module's network fetch(es).
 * @returns {Promise<{repo,surface,recorded,accepted,fresh,verified,finishedAt,reasons,message,exitCode}>}
 */
export async function runStatus(opts) {
  const repo = opts.repo;
  const indexBase = opts.indexBase || DEFAULT_INDEX_BASE;
  const staleDays = Number.isFinite(opts.staleDays) ? opts.staleDays : DEFAULT_STALE_DAYS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const fetchTimeoutMs = Number.isFinite(opts.fetchTimeoutMs) ? opts.fetchTimeoutMs : DEFAULT_STATUS_FETCH_TIMEOUT_MS;

  if (!fetchImpl) {
    const e = new Error('no fetch implementation available (Node < 18?) and none injected');
    e.code = 'NO_FETCH';
    e.hint = 'Run on Node >=22, or pass fetchImpl. The package engines floor is Node 22.';
    throw e;
  }

  const index = await fetchJsonOrNull(fetchImpl, indexBase, 'indexes/latest-by-repo.json', fetchTimeoutMs);
  const surfaces = index && index[repo] ? index[repo] : null;

  const base = {
    repo,
    surface: opts.surface || null,
    recorded: false,
    accepted: false,
    fresh: false,
    verified: null,
    finishedAt: null,
    reasons: [],
  };

  if (!surfaces || Object.keys(surfaces).length === 0) {
    return {
      ...base,
      message: `no accepted record found for ${repo} in the served index. A rejected or never-delivered submission is NOT recorded — check the ingest run and the DOGFOOD_TOKEN secret.`,
      exitCode: 1,
    };
  }

  // Pick the entry to judge: the requested surface, or the freshest one. The
  // index only holds accepted records, so any present entry IS accepted.
  let entry;
  let surfaceKey;
  if (opts.surface) {
    entry = surfaces[opts.surface];
    surfaceKey = opts.surface;
    if (!entry) {
      return {
        ...base,
        recorded: false,
        message: `${repo} has accepted records, but none for surface "${opts.surface}". Surfaces present: ${Object.keys(surfaces).join(', ')}.`,
        exitCode: 1,
      };
    }
  } else {
    for (const [key, e] of Object.entries(surfaces)) {
      const ms = e.finished_at ? new Date(e.finished_at).getTime() : NaN;
      if (!entry || (Number.isFinite(ms) && ms > (new Date(entry.finished_at).getTime() || -Infinity))) {
        entry = e;
        surfaceKey = key;
      }
    }
  }

  const finishedMs = entry.finished_at ? new Date(entry.finished_at).getTime() : NaN;
  const ageDays = Number.isFinite(finishedMs)
    ? Math.floor((now - finishedMs) / (24 * 60 * 60 * 1000))
    : null;
  const fresh = Number.isFinite(finishedMs) && (now - finishedMs) <= staleDays * 24 * 60 * 60 * 1000;
  const passed = entry.verified === 'pass';

  const result = {
    ...base,
    surface: surfaceKey,
    recorded: true,
    accepted: true,
    fresh,
    verified: entry.verified ?? null,
    finishedAt: entry.finished_at ?? null,
    reasons: [],
  };

  if (!passed) {
    // Accepted but the verified verdict is not pass. Fetch the served record to
    // surface the concrete rejection_reasons so the consumer learns WHY.
    let reasons = [];
    if (entry.path) {
      // F-d433f8a4: path guard BEFORE fetch — INDEX_MALFORMED must not be
      // swallowed by the transport catch below (that catch is for lost detail
      // on an otherwise-decided non-pass verdict, not for off-base fetches).
      assertSafeRecordPath(entry.path, indexBase);
      try {
        const record = await fetchJsonOrNull(fetchImpl, indexBase, entry.path, fetchTimeoutMs);
        reasons = record?.verification?.rejection_reasons ?? [];
      } catch (err) {
        if (err && err.code === 'INDEX_MALFORMED') throw err;
        // A record we cannot fetch does not flip the verdict — the index entry's
        // non-pass `verified` already decides the exit code; we just lose detail.
        reasons = [];
      }
    }
    result.reasons = reasons;
    const reasonTail = reasons.length ? ` Reasons: ${reasons.join('; ')}` : '';
    result.message = `${repo} (${surfaceKey}) is recorded and accepted, but its latest verified verdict is "${entry.verified}", not "pass".${reasonTail}`;
    result.exitCode = 1;
    return result;
  }

  if (!fresh) {
    const ageTail = ageDays === null ? 'an unparseable finished_at' : `${ageDays}d old`;
    result.message = `${repo} (${surfaceKey}) is recorded and accepted, but its latest run is STALE (${ageTail}; freshness window is ${staleDays}d). The dogfood pipeline may have stopped producing records.`;
    result.exitCode = 1;
    return result;
  }

  result.message = `${repo} (${surfaceKey}) is recorded, accepted, and fresh (verdict "pass", ${ageDays}d old, within the ${staleDays}d window).`;
  result.exitCode = 0;
  return result;
}

/**
 * Identity projection of a runStatus result into the stable JSON contract a
 * `--format=json` consumer scrapes. Kept as an explicit seam (not a raw dump of
 * the internal object) so the wire shape is decoupled from internal field
 * churn — the same buildXJSON discipline the swarm status/runs/trends verbs use.
 *
 * @param {Awaited<ReturnType<typeof runStatus>>} result
 * @returns {object}
 */
export function buildStatusJSON(result) {
  return {
    repo: result.repo,
    surface: result.surface,
    recorded: result.recorded,
    accepted: result.accepted,
    fresh: result.fresh,
    verified: result.verified,
    finished_at: result.finishedAt,
    reasons: result.reasons,
    message: result.message,
    ok: result.exitCode === 0,
  };
}

const STATUS_SIGIL = (ok) => (ok ? '[OK]' : '[FAIL]');

/**
 * Render a runStatus result as scan-first plain ASCII (matches the doctor /
 * status posture — no color, identical under CI logs).
 *
 * @param {Awaited<ReturnType<typeof runStatus>>} result
 * @returns {string}
 */
export function formatStatus(result) {
  const lines = [
    `dogfood-report --status ${result.repo}`,
    '',
    `${STATUS_SIGIL(result.exitCode === 0)} ${result.message}`,
  ];
  for (const r of result.reasons) lines.push(`         - ${r}`);
  return lines.join('\n');
}
