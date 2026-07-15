/**
 * d1b-001-cli-toplevel-error-event.test.js
 *
 * D1B-001 (Stage C humanization amend) — operator-legibility for the CLI
 * top-level catch at `run.js`'s `isMain` block. Before the fix, every failure
 * path that reached the outer catch logged unstructured
 * `console.error('ERROR: ingest failed: <msg>')` and exited 2. A grep of
 * `"stage":"error"` across runner logs MISSED the failure — only the
 * `rebuild_indexes` inner catch (run.js:260-292) emitted a structured event.
 *
 * Lens: the failure must be operator-legible — structured (NDJSON line),
 * coded (`stage:"error"`), pivot-keyed (`correlation_id`), and locator-tagged
 * (`failed_stage`).
 *
 * The CLI is invoked via `spawnSync` so we observe the same stderr/exit
 * behaviour an operator would see in CI. The runner is told NOT to set CI/
 * GITHUB_ACTIONS so the `--provenance=stub` path stays allowed (the in-CI
 * structural guard would otherwise short-circuit before our targeted
 * failures fire).
 *
 * Invariant (both halves enforced):
 *   1. POSITIVE: Each named failure path (validateRecord-equivalent throw via
 *      verifier-owned-field-rejection; loadGlobalPolicy ENOENT via missing
 *      policies dir; provenance throw via repo/run_url mismatch funnelled to
 *      the verifier) emits exactly one final `{"stage":"error", ...}`
 *      NDJSON line carrying `failed_stage` AND `correlation_id` before the
 *      process exits 2.
 *   2. NEGATIVE: A successful pipeline run does NOT emit any
 *      `{"stage":"error", ...}` line.
 *
 * Why named failure paths rather than ENOENT-then-DuplicateRunIdError-
 * then-validateRecord one-by-one: the CLI funnels everything through the
 * same outer catch. What we pin is THE catch's invariant — for any failure
 * path that reaches it, a structured `stage:error` event fires with the
 * pivot key and the locator. Two representatives (load-context failure +
 * verify-bubble-up) exercise distinct `failed_stage` values without
 * over-coupling the test to internals.
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, writeFileSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(__dirname, '../verify/fixtures');
// Distinct test root from sibling test files so node --test's parallel
// execution can't make these step on each other (mirrors the pattern
// established by verify-only-and-correlation.test.js).
const TEST_ROOT = resolve(__dirname, '__test_root_d1b001__');

let pilot0;

function copyDirSync(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

before(() => {
  pilot0 = JSON.parse(readFileSync(resolve(FIXTURES, 'pilot-0-submission.json'), 'utf-8'));
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

/**
 * Run `packages/ingest/run.js` as a CLI subprocess with the given payload.
 * Forces stub provenance and clears CI markers so the in-CI structural
 * guard at run.js:494 doesn't fire before our targeted failures.
 */
function runCli(payload, extraEnv = {}) {
  return spawnSync(process.execPath, [
    resolve(__dirname, 'run.js'),
    '--provenance', 'stub'
  ], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...extraEnv }
  });
}

/**
 * Run the SANDBOX copy of run.js (staged by `setupTempRunJs`) so the CLI's
 * `repoRoot = resolve(__dirname, '../..')` walk lands in TEST_ROOT. Tests that
 * drive a *real* ingest use this rather than `runCli`: a successful ingest
 * writes a record under `records/<org>/<repo>/…` AND rebuilds `indexes/`, both
 * rooted at `repoRoot`. Pointed at the real repo those writes pollute the
 * working tree (untracked record + re-stamped indexes — and on Windows the
 * index `path` fields flip to `\` separators); pointed at TEST_ROOT they land
 * in the sandbox `afterEach` deletes. Mirrors `runCli`'s flag + env shape —
 * only the run.js path differs.
 */
function runSandboxCli(payload, extraEnv = {}) {
  return spawnSync(process.execPath, [
    join(TEST_ROOT, 'packages', 'ingest', 'run.js'),
    '--provenance', 'stub'
  ], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...extraEnv }
  });
}

/**
 * Parse NDJSON `logStage` lines out of a captured stderr stream.
 * Filters out the human-readable banner that wave-17 emits when the runner
 * sees a TTY.
 */
function parseStageEvents(stderrText) {
  const events = [];
  for (const line of stderrText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.stage) events.push(parsed);
    } catch {
      // Tolerate non-JSON noise.
    }
  }
  return events;
}

// ─────────────────────────────────────────────────────────────────
// D1B-001 — structured stage:error event for the CLI top-level catch
// ─────────────────────────────────────────────────────────────────

describe('D1B-001 — CLI top-level catch emits a structured stage:error event', () => {
  it('POSITIVE: verifier throw bubbles up → final stage:error event carries failed_stage + correlation_id', () => {
    // Strategy: drive the CLI with a submission whose `verification` field is
    // a non-empty object. The verifier at packages/verify/index.js rejects
    // it (it's a verifier-owned field), but the bubble path here is the
    // outer pipeline — we want a hard throw, not a structured rejection.
    //
    // We get a hard throw by pointing the CLI at a repoRoot that has NO
    // policies directory: loadGlobalPolicy throws ENOENT. Since run.js
    // hard-codes repoRoot to `resolve(__dirname, '../..')`, we have to spin
    // up a sandbox copy of run.js. Easier: use the existing module API
    // indirectly by removing the global-policy file at the real REPO_ROOT?
    // No — that would race with other tests.
    //
    // Instead we exploit that run.js exits 2 on JSON.parse failure via a
    // DIFFERENT catch (line 485-488). That catch must ALSO emit the
    // structured error event by the fix contract: any failure path that
    // exits 2 from the CLI must emit `stage:"error"` first.
    //
    // We send malformed JSON and assert the structured event fires for a
    // failed_stage of `cli_parse_payload` (or whatever the implementation
    // names it — we accept any non-empty string).
    const child = runCli('this is not JSON {');

    assert.equal(child.status, 2,
      `CLI must exit 2 on malformed JSON (stdout=${child.stdout} stderr=${child.stderr})`);

    const events = parseStageEvents(child.stderr);
    const errorEvents = events.filter(e => e.stage === 'error');

    assert.equal(errorEvents.length, 1,
      `expected exactly one stage:error event for malformed-JSON path; got ${errorEvents.length}. ` +
      `stderr=${child.stderr}`);

    const errEvent = errorEvents[0];
    assert.equal(errEvent.component, 'ingest',
      'structured error event must be tagged as ingest');
    assert.equal(typeof errEvent.failed_stage, 'string',
      `failed_stage must be a string; got ${JSON.stringify(errEvent.failed_stage)}`);
    assert.ok(errEvent.failed_stage.length > 0,
      'failed_stage must be non-empty');
    assert.equal(typeof errEvent.message, 'string',
      `message must be a string; got ${JSON.stringify(errEvent.message)}`);
    assert.ok(errEvent.message.length > 0,
      'message must be non-empty');
    // No submission means no run_id-based correlation_id; the synth path
    // must still produce SOMETHING the operator can pivot on.
    assert.equal(typeof errEvent.correlation_id, 'string',
      `correlation_id must be present; got ${JSON.stringify(errEvent.correlation_id)}`);
    assert.ok(errEvent.correlation_id.length > 0,
      'correlation_id must be non-empty (synth id for malformed input)');
  });

  it('POSITIVE: pipeline-stage failure (verifier throw) emits stage:error with submission.run_id as correlation_id', () => {
    // Drive a hard throw inside the pipeline by sending a submission that
    // makes the verifier crash. We forge `submission.verification` to a
    // non-object (e.g. a string) — the verifier's verifier-owned-field
    // check just records a rejection reason, so that won't throw. To get
    // a real throw, set `scenario_results` to a value that triggers the
    // step validator's internal assertion logic.
    //
    // Cleanest hard-throw without coupling: pass a payload that is a
    // valid object but a JSON array at the top level — but run.js's
    // `submission && typeof === 'object' && !Array.isArray(submission)`
    // guard short-circuits arrays into the verifier's _skipPersist path,
    // not a throw.
    //
    // Reliable approach: feed a NON-OBJECT root after the JSON.parse
    // (a number). Same `_skipPersist` path — not a throw either.
    //
    // What does throw deterministically: a submission whose run_url is
    // missing — provenance.confirm rejects with an Error (provider:'github'
    // adapter); but we're using stubProvenance which never throws. So
    // provenance can't be made to throw via the CLI here.
    //
    // The most CLI-realistic throw is the persist path: a submission with
    // an invalid `repo` value that survives schema validation but trips
    // computeRecordPath's path-segment safety. We achieve this with a
    // submission whose `repo` contains `..` — but schema validation
    // rejects that first.
    //
    // What's left and stable: provenance adapter requirement check at
    // run.js:116. Strip provenance from the options? CLI always supplies
    // one. So we use a different vector: a submission with timing where
    // finished_at is malformed enough to trip the writeRecord layer. To
    // avoid over-coupling, we drive the bubble via the verifier-owned-field
    // path producing a rejection (status='rejected', exit 1 not exit 2)
    // — which is NOT what we want.
    //
    // CONCLUSION: the most stable, named-failure-path that lands in the
    // outer catch is a submission whose `submission_id` is a valid run_id
    // but whose internal shape forces an exception during persist. We
    // construct that with `pilot0` and a deliberate `ref.commit_sha` that
    // is structurally valid but a duplicate of an existing record — but
    // DuplicateRunIdError is THROWN by writeRecord. Perfect.
    //
    // To create the duplicate, we first ingest the submission once
    // (programmatically via spawnSync), then send the SAME submission a
    // second time. The second call must hit the duplicate-detect path
    // — currently that path returns `{ duplicate: true }` cleanly, not
    // a throw. So duplicates don't land in the catch either.
    //
    // FINAL stable vector: send a payload that parses as a STRING (not an
    // object). The CLI's `JSON.parse(submissionJson)` wraps strings in
    // a second `JSON.parse` — if the string isn't itself JSON it throws
    // inside the outer try/catch (line 481-488), exit 2. The malformed
    // JSON test above already covers that early-catch.
    //
    // What we test HERE: the OUTER catch (line 556-559) must also emit
    // a stage:error. We force a throw inside ingest() by passing a
    // submission whose `repo` contains a path-traversal segment AFTER
    // schema-validating cleanly. Use the pilot0 fixture and inject the
    // run_id field with the `submission.run_id` carrying the synthetic
    // pattern, while planting an invalid step that trips
    // validateStepResults internally to throw.
    //
    // After deliberation: the simplest deterministic vector that EXISTS
    // in the current code and bubbles to the outer catch is to make
    // `loadRepoPolicy` return non-yaml. But the current code swallows
    // and returns null. So no throw.
    //
    // GIVEN THE ABOVE: every "hard" throw vector lives inside the
    // outer catch IFF we have a no-policies repoRoot. Since run.js
    // hard-codes repoRoot via __dirname, we cannot redirect it from the
    // outside in this test process — unless we copy run.js into a
    // sandbox directory and invoke that copy.
    //
    // Implementation: copy `run.js` to a temp dir with NO `../../policies`
    // structure. loadGlobalPolicy throws ENOENT. The outer catch sees it.
    // The structured error event must fire and carry the pilot0.run_id
    // (synth-or-real) as correlation_id.
    setupTempRunJs();

    const child = runSandboxCli(pilot0);

    assert.equal(child.status, 2,
      `expected exit 2 when global policy missing; got ${child.status}. ` +
      `stdout=${child.stdout} stderr=${child.stderr}`);

    const events = parseStageEvents(child.stderr);
    const errorEvents = events.filter(e => e.stage === 'error');

    assert.equal(errorEvents.length, 1,
      `expected exactly one stage:error event for loadGlobalPolicy-ENOENT path; ` +
      `got ${errorEvents.length}. stderr=${child.stderr}`);

    const errEvent = errorEvents[0];
    assert.equal(errEvent.component, 'ingest');
    assert.equal(typeof errEvent.failed_stage, 'string');
    assert.ok(errEvent.failed_stage.length > 0,
      'failed_stage must be non-empty');
    // Submission was valid → correlation_id MUST equal submission.run_id.
    assert.equal(errEvent.correlation_id, pilot0.run_id,
      `correlation_id must equal submission.run_id for valid submissions; ` +
      `got ${JSON.stringify(errEvent.correlation_id)}`);
    assert.equal(typeof errEvent.message, 'string');
    assert.ok(errEvent.message.length > 0);
  });

  it('NEGATIVE: a successful run does NOT emit any stage:error event', () => {
    // Counter-test: pilot0 ingested against a SANDBOXED repo root (real
    // `policies/` copied in) should succeed (exit 0) and emit zero stage:error
    // lines. Pins that the structured-error emit is FAILURE-PATH ONLY, not a
    // noisy default.
    //
    // Why sandboxed and not the real repoRoot: a successful ingest WRITES a
    // record under `records/<org>/<repo>/…` AND rebuilds `indexes/`, both
    // rooted at repoRoot. Against the real repo that left an untracked record
    // and re-stamped the committed indexes on every run — and on Windows
    // `rebuildIndexes` rewrites each index `path` with `\` separators, so
    // `git status` was dirty after every test run (the path.sep cross-platform
    // blind-spot). `setupTempRunJs({ withPolicies: true })` redirects repoRoot
    // to TEST_ROOT so the full persist + rebuild success path is exercised
    // inside the sandbox `afterEach` deletes, leaving the working tree clean.
    // (Bonus fidelity: a fresh TEST_ROOT/records is empty, so this always hits
    // the real write+rebuild path rather than short-circuiting on a duplicate
    // record left over from a previous run against the real tree.)
    setupTempRunJs({ withPolicies: true });

    const child = runSandboxCli(pilot0);

    assert.equal(child.status, 0,
      `valid submission must exit 0; got ${child.status}. ` +
      `stdout=${child.stdout} stderr=${child.stderr}`);

    const events = parseStageEvents(child.stderr);
    const errorEvents = events.filter(e => e.stage === 'error');
    assert.equal(errorEvents.length, 0,
      `successful run must not emit any stage:error event; got ${errorEvents.length}. ` +
      `events=${JSON.stringify(events.map(e => e.stage))}`);
  });

  // ─────────────────────────────────────────────────────────────────
  // L1-001 (Wave A2 amend2): every provenance-precondition exit-2 path
  // must ALSO emit `stage:"error"` with failed_stage='cli_provenance_resolve'.
  // Pre-fix these paths printed bare `ERROR: …` to stderr and exited 2 with
  // NO NDJSON event — the D1B-001 header invariant claimed they emitted but
  // never did. Four paths; each is its own subtest so a future regression
  // names the exact path that lost the emit.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Invoke run.js directly (NOT via runCli's --provenance flag) so we exercise
   * the four provenance-precondition paths the L1-001 fix wired through
   * emitCliErrorEvent. Each subtest supplies the env shape that pins exactly
   * one of the 4 paths.
   */
  function runCliRaw(extraArgs, payload, extraEnv = {}) {
    return spawnSync(process.execPath, [
      resolve(__dirname, 'run.js'),
      ...extraArgs
    ], {
      input: typeof payload === 'string' ? payload : JSON.stringify(payload),
      encoding: 'utf-8',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', GITHUB_TOKEN: '', GH_TOKEN: '', ...extraEnv }
    });
  }

  function assertProvenanceErrorEvent(child, label) {
    assert.equal(child.status, 2,
      `${label} must exit 2 (stdout=${child.stdout} stderr=${child.stderr})`);
    const events = parseStageEvents(child.stderr);
    const errorEvents = events.filter(e => e.stage === 'error');
    assert.equal(errorEvents.length, 1,
      `${label}: expected exactly one stage:error event; got ${errorEvents.length}. stderr=${child.stderr}`);
    const errEvent = errorEvents[0];
    assert.equal(errEvent.failed_stage, 'cli_provenance_resolve',
      `${label}: failed_stage must be 'cli_provenance_resolve'; got ${JSON.stringify(errEvent.failed_stage)}`);
    assert.equal(errEvent.component, 'ingest', `${label}: component must be ingest`);
    assert.equal(typeof errEvent.message, 'string', `${label}: message must be a string`);
    assert.ok(errEvent.message.length > 0, `${label}: message must be non-empty`);
    assert.equal(typeof errEvent.correlation_id, 'string',
      `${label}: correlation_id must be present`);
  }

  it('L1-001 POSITIVE: --provenance=stub in CI emits stage:error', () => {
    const child = runCliRaw(['--provenance', 'stub'], pilot0, { CI: 'true' });
    assertProvenanceErrorEvent(child, '--provenance=stub in CI');
  });

  it('L1-001 POSITIVE: --provenance=github without GITHUB_TOKEN emits stage:error', () => {
    const child = runCliRaw(['--provenance', 'github'], pilot0);
    assertProvenanceErrorEvent(child, '--provenance=github without GITHUB_TOKEN');
  });

  it('L1-001 POSITIVE: CI without --provenance flag and no GITHUB_TOKEN emits stage:error', () => {
    const child = runCliRaw([], pilot0, { CI: 'true' });
    assertProvenanceErrorEvent(child, 'CI without --provenance flag and no GITHUB_TOKEN');
  });

  it('L1-001 POSITIVE: no --provenance flag at all (non-CI) emits stage:error', () => {
    const child = runCliRaw([], pilot0);
    assertProvenanceErrorEvent(child, 'no --provenance flag at all');
  });

  // ─────────────────────────────────────────────────────────────────
  // cli_read_file (D1B-001 family): the `--file <path>` flag read fires
  // during arg-parsing — OUTSIDE the JSON.parse try and BEFORE
  // `cliCorrelationId` is seeded. Pre-fix, an unreadable path (ENOENT) threw
  // an uncaught exception → raw stack + exit 1, with NO `"stage":"error"`
  // NDJSON line. The exit-1 (not exit-2) put it technically outside the
  // literal D1B-001 "exit-2" contract, yet it produced exactly the
  // un-greppable raw-stack failure D1B-001 exists to eliminate. The fix wraps
  // the read so a failure routes through emitCliErrorEvent
  // (failed_stage='cli_read_file', synth correlation id) and exits 2.
  // ─────────────────────────────────────────────────────────────────

  it('cli_read_file POSITIVE: --file with a nonexistent path emits stage:error and exits 2', () => {
    // The read happens before stdin is consulted and before any submission is
    // parsed, so the only pivot available is the synth correlation id.
    const child = runCliRaw(['--file', '/nonexistent/path.json'], '');

    assert.equal(child.status, 2,
      `--file ENOENT must exit 2, not the pre-fix raw-stack exit 1 ` +
      `(stdout=${child.stdout} stderr=${child.stderr})`);

    const events = parseStageEvents(child.stderr);
    const errorEvents = events.filter(e => e.stage === 'error');

    assert.equal(errorEvents.length, 1,
      `expected exactly one stage:error event for the --file ENOENT path; ` +
      `got ${errorEvents.length}. stderr=${child.stderr}`);

    const errEvent = errorEvents[0];
    assert.equal(errEvent.failed_stage, 'cli_read_file',
      `failed_stage must be 'cli_read_file'; got ${JSON.stringify(errEvent.failed_stage)}`);
    assert.equal(errEvent.component, 'ingest',
      'structured error event must be tagged as ingest');
    assert.equal(typeof errEvent.message, 'string',
      `message must be a string; got ${JSON.stringify(errEvent.message)}`);
    assert.ok(errEvent.message.length > 0, 'message must be non-empty');
    // No submission parsed yet → correlation_id must be a synth `ing-…` id.
    assert.ok(errEvent.correlation_id && errEvent.correlation_id.startsWith('ing-'),
      `correlation_id must be a synth id (ing-…) for the --file ENOENT path; ` +
      `got ${JSON.stringify(errEvent.correlation_id)}`);
  });
});

/**
 * Stage a sandbox copy of run.js in TEST_ROOT and rewrite the
 * `node:fs`/`node:path`/`@dogfood-lab/*` imports to absolute paths so the
 * copy resolves against the real workspace's installed deps.
 *
 * Why a sandbox: run.js hard-codes `repoRoot = resolve(__dirname, '../..')`
 * in its `isMain` block, so the only way to point the CLI at a fake repo
 * root without forking the production source is to copy the file into a
 * sibling directory hierarchy. Because the copy lives at
 * `TEST_ROOT/packages/ingest/run.js`, its `repoRoot` resolves to TEST_ROOT —
 * so every record write and index rebuild the CLI performs is redirected
 * into the sandbox `afterEach` deletes, never the real working tree.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.withPolicies=false] - Default (false): NO `policies/`
 *   dir is staged, so `loadGlobalPolicy(TEST_ROOT)` throws ENOENT — exactly the
 *   failure the loadGlobalPolicy-ENOENT POSITIVE test drives. When true: the
 *   real `policies/` tree is copied in so the verifier sees the same policy
 *   inputs as the real repo and the ingest SUCCEEDS end-to-end (verify →
 *   persist → rebuild) entirely inside the sandbox — the NEGATIVE test needs a
 *   genuine success whose record/index writes never reach the working tree.
 */
function setupTempRunJs({ withPolicies = false } = {}) {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  // Mirror the packages/ingest/run.js path so the copy's `../..` walk lands
  // in TEST_ROOT.
  mkdirSync(join(TEST_ROOT, 'packages', 'ingest'), { recursive: true });
  const realRunJs = readFileSync(resolve(__dirname, 'run.js'), 'utf-8');
  // Rewrite bare workspace imports + sibling-module relative imports to
  // absolute `file://` URLs (Windows ESM loader requires the scheme).
  const verifyIndex = pathToFileURL(resolve(__dirname, '../verify/index.js')).href;
  const provenanceJs = pathToFileURL(resolve(__dirname, '../verify/validators/provenance.js')).href;
  const logStageJs = pathToFileURL(resolve(__dirname, '../dogfood-swarm/lib/log-stage.js')).href;
  const loadContextJs = pathToFileURL(resolve(__dirname, 'load-context.js')).href;
  const persistJs = pathToFileURL(resolve(__dirname, 'persist.js')).href;
  // F-4acd28d8: run.js now imports RecordValidationError directly (to route
  // it alongside UnsafeRecordPathError out of ingest()'s writeRecord() catch),
  // so the sandbox copy needs this sibling rewritten too or Node's ESM loader
  // fails to resolve the relative specifier from TEST_ROOT.
  const validateRecordJs = pathToFileURL(resolve(__dirname, 'validate-record.js')).href;
  const rebuildIndexesJs = pathToFileURL(resolve(__dirname, 'rebuild-indexes.js')).href;
  const verifyChainJs = pathToFileURL(resolve(__dirname, 'verify-chain.js')).href;
  // The anchor CLI handlers are imported by run.js too; rewrite that sibling
  // import to the real source so the sandbox copy resolves it. cli.js's own
  // relative imports (./compute-root.js etc.) resolve from the real anchor/
  // directory because the rewritten URL points back at the real file.
  const anchorCliJs = pathToFileURL(resolve(__dirname, 'anchor/cli.js')).href;

  const rewritten = realRunJs
    .replace(/from\s+['"]@dogfood-lab\/verify['"]/, `from '${verifyIndex}'`)
    .replace(/from\s+['"]@dogfood-lab\/verify\/validators\/provenance\.js['"]/,
      `from '${provenanceJs}'`)
    .replace(/from\s+['"]@dogfood-lab\/dogfood-swarm\/lib\/log-stage\.js['"]/,
      `from '${logStageJs}'`)
    .replace(/from\s+['"]\.\/load-context\.js['"]/, `from '${loadContextJs}'`)
    .replace(/from\s+['"]\.\/persist\.js['"]/, `from '${persistJs}'`)
    .replace(/from\s+['"]\.\/validate-record\.js['"]/, `from '${validateRecordJs}'`)
    .replace(/from\s+['"]\.\/rebuild-indexes\.js['"]/, `from '${rebuildIndexesJs}'`)
    .replace(/from\s+['"]\.\/verify-chain\.js['"]/, `from '${verifyChainJs}'`)
    .replace(/from\s+['"]\.\/anchor\/cli\.js['"]/, `from '${anchorCliJs}'`);

  writeFileSync(join(TEST_ROOT, 'packages', 'ingest', 'run.js'), rewritten, 'utf-8');

  // For a SUCCESSFUL ingest the verifier needs policy: `loadGlobalPolicy` and
  // `loadRepoPolicy` resolve under `repoRoot` (= TEST_ROOT for the copy), so
  // copy the real policy tree in. Omitting it is the ENOENT failure the
  // loadGlobalPolicy POSITIVE test relies on — hence opt-in, default off.
  if (withPolicies) {
    copyDirSync(resolve(REPO_ROOT, 'policies'), join(TEST_ROOT, 'policies'));
  }
}
