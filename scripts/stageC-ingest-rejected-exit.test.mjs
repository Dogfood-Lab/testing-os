/**
 * stageC-ingest-rejected-exit — regression for d6-infra-B001 + d6-infra-B003.
 *
 * d6-infra-B001 (rejected-exit decouple): a REJECTED dogfood submission is a
 * NORMAL, designed outcome — packages/ingest/run.js exits 1 for
 * `verification.status !== 'accepted'` (run.js:720) AFTER writing the rejection
 * record to records/_rejected/ (`written: true`). Pre-fix, ingest.yml's
 * ingestion steps were `node ... | tee /tmp/ingest-result.json` under the
 * default `bash -eo pipefail` shell, so node's exit 1 propagated through the
 * pipeline and `set -e` halted the job at the ingestion step — the 'Read
 * result' and 'Commit records and indexes' steps (neither carrying
 * `if: always()`) were skipped, and the _rejected evidence the system exists to
 * accumulate was silently dropped from the repo. The fix wraps the pipeline in
 * `set +e`, captures node's code via PIPESTATUS, and treats exit 0/1 as
 * proceed-to-commit while reserving a red job for exit >=2 (a genuine fault),
 * which emits a structured `::error::` naming the fault and distinguishing it
 * from a rejection.
 *
 * d6-infra-B003 (jq parse guard): the 'Read result' step parsed
 * /tmp/ingest-result.json with bare `jq -r '.status'` under `set -e`. The
 * `[ -f ]` guard covered an ABSENT file but not a MALFORMED one; a non-JSON
 * line on stdout (or a torn tee) made jq exit non-zero and `set -e` fail the
 * step with jq's terse parse error instead of an operator-legible `::error::`
 * naming the file. The fix adds a `jq -e .` validity check that emits a
 * structured annotation + the raw contents before exiting.
 *
 * How these are tested: rather than token-match the YAML, we EXTRACT the actual
 * `run:` script bodies from .github/workflows/ingest.yml and EXECUTE them under
 * bash with PATH-shimmed `node` / `jq` stubs, asserting the real shell logic
 * branches correctly. This goes RED if the fix is reverted in the source YAML
 * (e.g. the `set +e` / PIPESTATUS decouple removed, or the parse guard dropped),
 * because the stub exits would then propagate and crash the script.
 *
 * Why a `node`/`jq` stub instead of the real binaries: the test must run on the
 * dev rig where `jq` is not installed, and must not spawn the real ingest
 * pipeline (which would touch records/). The stubs reproduce only the two
 * contract points the steps depend on — node's exit code + JSON stdout, and
 * jq's field-extraction / `-e` validity check.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const ingestYml = resolve(repoRoot, '.github/workflows/ingest.yml');

/**
 * Extract the multi-line `run: |` script body of the step whose `name:` matches
 * `stepName`, dedented to its block indentation. Walks the YAML structurally so
 * it tracks the real file rather than a copied snippet.
 */
function extractRunBlock(yamlText, stepName) {
  const lines = yamlText.split(/\r?\n/);
  // Find the step's `- name: <stepName>` line.
  let i = lines.findIndex((l) => new RegExp(`^\\s*-\\s*name:\\s*${stepName}\\s*$`).test(l));
  assert.ok(i >= 0, `could not find step named "${stepName}" in ingest.yml`);
  // Find the `run: |` line within this step (before the next `- name:`).
  let runIdx = -1;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*-\s*name:/.test(lines[j])) break;
    if (/^\s*run:\s*\|\s*$/.test(lines[j])) {
      runIdx = j;
      break;
    }
  }
  assert.ok(runIdx >= 0, `step "${stepName}" has no \`run: |\` block`);
  const runIndent = lines[runIdx].match(/^(\s*)/)[1].length;
  const body = [];
  for (let j = runIdx + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent <= runIndent) break; // de-indented → block ended
    body.push(line.slice(runIndent + 2)); // dedent to block body
  }
  return body.join('\n');
}

/**
 * Build a temp harness. The extracted YAML block runs under bash with two
 * substitutions so the SAME source-of-truth shell logic executes identically on
 * the Linux CI runner AND on the Windows dev rig (Git-bash):
 *
 *   1. The bare command tokens `node` / `jq` are rewritten to `nodestub` /
 *      `jqstub` (extensionless shebang scripts on the prepended PATH). A bare
 *      `node`/`jq` token would resolve to the real binary under Git-bash's
 *      Windows-extension command lookup; a uniquely-named stub is found
 *      reliably on both platforms. ONLY the binary name is remapped — the
 *      decouple control flow (`set +e`, `${PIPESTATUS[…]}`, the `>= 2` branch,
 *      the `jq -e .` guard) is executed verbatim from the source YAML, so the
 *      test goes RED if any of it is reverted.
 *   2. The hardcoded result path `/tmp/ingest-result.json` is remapped to a
 *      per-harness temp file so tests don't contend or touch a real path.
 */
function makeHarness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'stageC-ingest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const resultPath = join(dir, 'ingest-result.json').replace(/\\/g, '/');

  function writeStub(name, body) {
    const p = join(binDir, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }

  return {
    dir,
    binDir,
    resultPath,
    /** A `nodestub` that prints `stdout` then exits `code`. */
    writeNodeStub(stdout, code) {
      writeStub(
        'nodestub',
        `#!/usr/bin/env bash\nprintf '%s\\n' '${stdout.replace(/'/g, `'\\''`)}'\nexit ${code}\n`
      );
    },
    /**
     * A `jqstub` implementing the two usages the 'Read result' step needs:
     *   jqstub -e .                  → JSON-validity check (exit 0 valid, 1 not)
     *   jqstub -r '.<field> // empty' → print field or '' when absent/null
     * `valid:false` forces the parse-guard branch (always non-zero / errors).
     */
    writeJqStub({ valid } = { valid: true }) {
      const impl = `
        const fs = require('fs');
        const args = process.argv.slice(2);
        const file = args[args.length - 1];
        let raw;
        try { raw = fs.readFileSync(file, 'utf8'); } catch { process.exit(2); }
        let obj;
        try { obj = JSON.parse(raw); }
        catch { if (args.includes('-e')) process.exit(1); console.log('null'); process.exit(0); }
        if (args.includes('-e')) process.exit(0);
        const filt = args.find(a => a.startsWith('.') && a.length > 1) || args.find(a => a.startsWith('.'));
        if (filt && filt.length > 1) {
          const field = filt.replace(/^\\./, '').replace(/\\s*\\/\\/\\s*empty\\s*$/, '').trim();
          const v = obj[field];
          console.log(v === undefined || v === null ? '' : String(v));
        }
      `;
      const implInvalid = `process.stderr.write('jq: error (test) parse error\\n'); process.exit(2);`;
      // `-- "$@"` so jq-style flags (-e, -r) and the filter/file args land in
      // process.argv rather than being parsed as node's own -e/-- flags.
      // Exec the absolute node binary (NODE_BIN), not a bare `node` token —
      // node is not on Git-bash's PATH on the Windows dev rig.
      writeStub('jqstub', `#!/usr/bin/env bash\nexec "${NODE_BIN}" -e ${shq(valid ? impl : implInvalid)} -- "$@"\n`);
    },
    /** Run an extracted block, remapping node→nodestub, jq→jqstub, result path. */
    run(rawScript, env = {}) {
      const script = remapBlock(rawScript, resultPath);
      const ghOut = join(dir, 'gh_output');
      writeFileSync(ghOut, '');
      const fullEnv = {
        ...process.env,
        PATH: `${binDir}${pathSep()}${process.env.PATH}`,
        GITHUB_OUTPUT: ghOut.replace(/\\/g, '/'),
        GITHUB_STEP_SUMMARY: join(dir, 'gh_summary').replace(/\\/g, '/'),
        ...env,
      };
      let stdout = '';
      let status = 0;
      try {
        stdout = execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
          env: fullEnv,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        status = e.status ?? 1;
        stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      const ghOutContents = existsSync(ghOut) ? readFileSync(ghOut, 'utf8') : '';
      return { status, stdout, ghOut: ghOutContents };
    },
  };
}

/**
 * Remap an extracted `run:` block for the stub harness: rewrite the bare
 * `node`/`jq` command tokens to the stub names and the hardcoded result path to
 * the per-harness temp path. Only command tokens are rewritten (a `node`
 * substring inside a path or message is left alone via the word-boundary +
 * not-preceded-by-slash guard).
 */
function remapBlock(script, resultPath) {
  return script
    .replace(/\/tmp\/ingest-result\.json/g, resultPath)
    // Command-position `node` / `jq`: at a line start (m-flag `^`) or right
    // after a pipe / `&&` / `;` / `(` / `$(` / whitespace. The trailing `\b`
    // and the not-after-`/` intent keep `node` inside a path or message
    // untouched (the only `node`/`jq` tokens in these blocks ARE the command
    // invocations + the comment prose, and prose `node ...`/`jq` mentions are
    // harmless to rewrite since comments don't execute).
    .replace(/(^|[|&;(]|\$\(|\s)node\b/gm, '$1nodestub')
    .replace(/(^|[|&;(]|\$\(|\s)jq\b/gm, '$1jqstub');
}

function isWin() {
  return platform() === 'win32';
}
function pathSep() {
  return isWin() ? ';' : ':';
}
/**
 * Convert a native path to one bash can exec. On win32 the test process's
 * `node` is NOT on Git-bash's PATH (it lives on the Windows PATH), so a stub
 * that shells out to a bare `node` token dies with `node: command not found`.
 * Translate the absolute node binary path to the MSYS `/c/...` form Git-bash
 * resolves; on POSIX it is already exec-able verbatim.
 */
function toBashPath(p) {
  if (isWin() && /^[A-Za-z]:[\\/]/.test(p)) {
    return '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
  }
  return p;
}
// The absolute node binary running this test — the jqstub execs THIS, not a
// bare `node` token, so it resolves on the Windows dev rig too.
const NODE_BIN = toBashPath(process.execPath);

/** POSIX single-quote a string for `node -e ...`. */
function shq(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Whether the bash the harness spawns can actually reach a node binary. True on
// Linux CI and Windows Git-bash. But `npm run verify` on Windows spawns WSL
// `/bin/bash`, where the Windows node — and the `/c/...` NODE_BIN form — is NOT
// reachable; there the bash-EXECUTION tests skip and the STRUCTURAL tests (which
// always run) gate the ingest.yml fix instead. A capability probe (not a coarse
// isWin check) keeps the strong execution gate wherever bash CAN run node.
function bashCanExec() {
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-c', `exec "${NODE_BIN}" -e "process.exit(0)"`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const CAN_EXEC = bashCanExec();

// ─────────────────────────────────────────────────────────────────────────────
// d6-infra-B001: the rejected-exit decouple — exit 1 (rejected) PROCEEDS,
// exit 2 (genuine fault) FAILS the job with a structured ::error::.
// ─────────────────────────────────────────────────────────────────────────────

test('d6-infra-B001: repository_dispatch leg — node exit 1 (rejected) does NOT fail the step', (t) => {
  if (!CAN_EXEC) return t.skip('bash-stub execution is Linux-CI-targeted; structural test below covers win32');
  const h = makeHarness(t);
  const script = extractRunBlock(readFileSync(ingestYml, 'utf8'), 'Run ingestion \\(repository_dispatch\\)');
  h.writeNodeStub('{"status":"rejected","written":true,"run_id":"r-rej"}', 1);
  const { status, stdout } = h.run(script, { SUBMISSION_PAYLOAD: '{"run_id":"r-rej"}' });
  assert.equal(status, 0, `a rejected submission (node exit 1) must NOT fail the step.\n${stdout}`);
});

test('d6-infra-B001: repository_dispatch leg — node exit 0 (accepted) proceeds', (t) => {
  if (!CAN_EXEC) return t.skip('Linux-CI-targeted');
  const h = makeHarness(t);
  const script = extractRunBlock(readFileSync(ingestYml, 'utf8'), 'Run ingestion \\(repository_dispatch\\)');
  h.writeNodeStub('{"status":"accepted","written":true,"run_id":"r-ok"}', 0);
  const { status } = h.run(script, { SUBMISSION_PAYLOAD: '{"run_id":"r-ok"}' });
  assert.equal(status, 0, 'an accepted submission (node exit 0) must proceed');
});

test('d6-infra-B001 + F-42e57a77: repository_dispatch leg — node exit 2 (genuine fault) annotates ::error:: and DEFERS (fault=2, exit 0) so the commit step still runs', (t) => {
  if (!CAN_EXEC) return t.skip('Linux-CI-targeted');
  const h = makeHarness(t);
  const script = extractRunBlock(readFileSync(ingestYml, 'utf8'), 'Run ingestion \\(repository_dispatch\\)');
  h.writeNodeStub('{"stage":"error"}', 2);
  const { status, stdout, ghOut } = h.run(script, { SUBMISSION_PAYLOAD: '{"run_id":"r-err"}' });
  // F-42e57a77: run.js's generic catch (exit 2) can fire AFTER a record was
  // persisted to the runner working tree (persist-then-fail-later is a proven
  // run.js shape — the stale-index precedent). A red step here skips the
  // commit step and discards that evidence — the same evidence-loss class
  // F-caeeacc3 closed for the parse seam. The leg annotates the fault,
  // records fault=$rc, and exits 0; the dedicated deferred-fault step reds
  // the run AFTER the commit.
  assert.equal(status, 0, `a fault must NOT fail the ingestion step (evidence preservation first).\n${stdout}`);
  assert.match(stdout, /::error::ingest pipeline faulted \(exit 2\)/, 'exit 2 must emit a structured ::error:: naming the fault');
  assert.match(stdout, /NOT a rejection/, 'the error must distinguish a fault from a designed rejection');
  assert.match(ghOut, /fault=2/, 'the fault code must reach GITHUB_OUTPUT so the deferred-fault step reds the run after the commit (F-42e57a77)');
});

test('d6-infra-B001 + F-42e57a77: workflow_dispatch leg — node exit 1 (rejected) proceeds; exit 2 defers with fault=2', (t) => {
  if (!CAN_EXEC) return t.skip('Linux-CI-targeted');
  const yaml = readFileSync(ingestYml, 'utf8');
  const script = extractRunBlock(yaml, 'Run ingestion \\(workflow_dispatch\\)');

  const h1 = makeHarness(t);
  h1.writeNodeStub('{"status":"rejected","written":true,"run_id":"w-rej"}', 1);
  const r1 = h1.run(script, { SUBMISSION_FILE: 'sub.json' });
  assert.equal(r1.status, 0, `workflow_dispatch rejected (exit 1) must proceed.\n${r1.stdout}`);

  const h2 = makeHarness(t);
  h2.writeNodeStub('{"stage":"error"}', 2);
  const r2 = h2.run(script, { SUBMISSION_FILE: 'sub.json' });
  assert.equal(r2.status, 0, `workflow_dispatch fault (exit 2) must defer, not fail the step (F-42e57a77).\n${r2.stdout}`);
  assert.match(r2.stdout, /::error::ingest pipeline faulted \(exit 2\)/);
  assert.match(r2.ghOut, /fault=2/, 'the fault code must reach GITHUB_OUTPUT (F-42e57a77)');
});

// ─────────────────────────────────────────────────────────────────────────────
// d6-infra-B003: the 'Read result' parse guard — valid JSON extracts fields;
// malformed JSON emits a structured ::error:: instead of jq's terse parse error.
// ─────────────────────────────────────────────────────────────────────────────

test('d6-infra-B003: Read result — valid JSON extracts status/run_id/written into GITHUB_OUTPUT', (t) => {
  if (!CAN_EXEC) return t.skip('Linux-CI-targeted');
  const h = makeHarness(t);
  const script = extractRunBlock(readFileSync(ingestYml, 'utf8'), 'Read result');
  // The step reads the result file (remapped to h.resultPath) — write a valid one.
  writeFileSync(h.resultPath, '{"status":"rejected","run_id":"r-rej","written":true}');
  h.writeJqStub({ valid: true });
  const { status, ghOut, stdout } = h.run(script);
  assert.equal(status, 0, `valid JSON must parse cleanly.\n${stdout}`);
  assert.match(ghOut, /status=rejected/, 'status must reach GITHUB_OUTPUT');
  assert.match(ghOut, /run_id=r-rej/);
  assert.match(ghOut, /written=true/, 'written=true must reach GITHUB_OUTPUT so the rejected record commits');
});

test('d6-infra-B003 + F-caeeacc3: Read result — malformed JSON emits a structured ::error:: and DEFERS the failure (parse_failed=true, exit 0) so the commit step still runs', (t) => {
  if (!CAN_EXEC) return t.skip('Linux-CI-targeted');
  const h = makeHarness(t);
  const script = extractRunBlock(readFileSync(ingestYml, 'utf8'), 'Read result');
  writeFileSync(h.resultPath, 'this is not json at all');
  h.writeJqStub({ valid: false }); // jq -e . fails
  const { status, stdout, ghOut } = h.run(script);
  // F-caeeacc3 (wave-2 addendum): the parse guard must NOT exit 1 between
  // persist and commit — run.js already wrote the accepted/_rejected record to
  // the runner working tree, and a failing step here skips the commit step and
  // discards that evidence (the exact d6-infra-B001 evidence-loss class, one
  // step later). The step exits 0, flags parse_failed=true, and a dedicated
  // deferred-fail step turns the run red AFTER the commit.
  assert.equal(status, 0, `malformed result JSON must NOT fail this step (evidence preservation first).\n${stdout}`);
  assert.match(stdout, /::error::ingest-result\.json is not valid JSON/, 'must emit a labeled annotation naming the file');
  assert.match(ghOut, /parse_failed=true/, 'must flag parse_failed=true so the commit step still runs and the deferred-fail step reds the run afterwards');
});

// ─────────────────────────────────────────────────────────────────────────────
// STRUCTURAL gate — ALWAYS runs (even where bash-exec is unavailable, e.g.
// `npm run verify` spawning WSL bash on Windows). Asserts the load-bearing
// elements of the d6-infra-B001 + d6-infra-B003 fix are present in the real
// ingest.yml, so a revert is caught on EVERY platform — not only where the
// execution harness can spawn a node-reachable bash. This is the "structural
// test below covers win32" the skip messages promise.
// ─────────────────────────────────────────────────────────────────────────────

test('STRUCTURAL d6-infra-B001 + F-42e57a77: both ingestion legs decouple node exit from step failure and DEFER faults', () => {
  const yaml = readFileSync(ingestYml, 'utf8');
  for (const step of ['Run ingestion \\(repository_dispatch\\)', 'Run ingestion \\(workflow_dispatch\\)']) {
    const block = extractRunBlock(yaml, step);
    assert.match(block, /set \+e/, `${step}: must disable -e so a rejection (exit 1) does not halt the job`);
    assert.match(block, /PIPESTATUS/, `${step}: must read node's code via PIPESTATUS, not the pipeline's`);
    assert.match(block, /"\$rc" -ge 2/, `${step}: only exit >= 2 (a genuine fault) may red the RUN — and only via the deferred-fault step`);
    assert.match(block, /::error::ingest pipeline faulted/, `${step}: a fault must emit a structured ::error::`);
    assert.match(block, /NOT a rejection/, `${step}: the fault error must distinguish itself from a designed rejection`);
    // F-42e57a77: the fault must be DEFERRED past the commit step, not exit
    // the leg — run.js's generic catch (exit 2) can fire after persist, and a
    // red step between persist and commit discards the evidence (the same
    // class F-caeeacc3 closed for the parse seam).
    assert.match(block, /fault=\$rc/, `${step}: a fault must record fault=$rc to GITHUB_OUTPUT for the deferred-fault step (F-42e57a77)`);
    assert.doesNotMatch(block, /exit "\$rc"/, `${step}: the leg must NOT exit non-zero on a fault — that skips the commit step and drops persisted evidence (F-42e57a77)`);
  }
});

test('STRUCTURAL F-42e57a77: the commit step also runs on a deferred fault, and a deferred-fault step reds the run after it', () => {
  const yaml = readFileSync(ingestYml, 'utf8');
  const commit = extractStepSection(yaml, 'Commit records and indexes');
  assert.match(
    commit,
    /if:[^\n]*ingest_rd\.outputs\.fault[^\n]*ingest_wd\.outputs\.fault/,
    "the commit step's `if:` must include both legs' fault outputs so a persisted record still commits when run.js faulted after persist (F-42e57a77)",
  );
  const section = extractStepSection(yaml, 'Fail run on deferred pipeline fault');
  assert.match(section, /ingest_rd\.outputs\.fault[^\n]*ingest_wd\.outputs\.fault/, 'the deferred-fault step must be gated on the fault outputs');
  assert.match(section, /exit\s+"?\$/, 'the deferred-fault step must exit non-zero so a fault still reds the run (failures must surface)');
  assert.ok(
    yaml.indexOf('name: Fail run on deferred pipeline fault') > yaml.indexOf('name: Commit records and indexes'),
    'the deferred-fault step must run after the commit step — evidence first, red run second (F-42e57a77)',
  );
});

test('STRUCTURAL d6-infra-B003 + F-caeeacc3: the Read result step guards malformed JSON and defers the failure past the commit step', () => {
  const block = extractRunBlock(readFileSync(ingestYml, 'utf8'), 'Read result');
  assert.match(block, /jq -e \./, 'must validate the result is JSON (jq -e .) before extracting fields');
  assert.match(block, /::error::ingest-result\.json is not valid JSON/, 'malformed JSON must emit a labeled ::error:: naming the file, not a bare jq error');
  assert.match(block, /parse_failed=true/, 'the parse guard must flag parse_failed=true instead of failing the step (F-caeeacc3 — evidence preservation first)');
  assert.doesNotMatch(block, /exit 1/, 'the Read result step must NOT exit 1 — a failure here between persist and commit discards the persisted record (F-caeeacc3)');
});

// ─────────────────────────────────────────────────────────────────────────────
// F-caeeacc3 (wave-2 HIGH): no step between the ingestion legs (persist) and
// 'Commit records and indexes' may fail the job — a red step there discards
// the record run.js already wrote to the runner working tree, and the
// repository_dispatch payload is gone with the run. Badge regeneration is
// deterministic and self-heals on the next ingest; a dropped record does not.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the full step section (all lines) for `- name: <stepName>`. */
function extractStepSection(yamlText, stepName) {
  const lines = yamlText.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*-\\s*name:\\s*${stepName}\\s*$`).test(l));
  assert.ok(start >= 0, `could not find step named "${stepName}" in ingest.yml`);
  const body = [lines[start]];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^\s*-\s*name:/.test(lines[j])) break;
    body.push(lines[j]);
  }
  return body.join('\n');
}

test('STRUCTURAL F-caeeacc3: badge/trends regeneration is non-fatal (commit step always reachable)', () => {
  const yaml = readFileSync(ingestYml, 'utf8');
  const block = extractRunBlock(yaml, 'Regenerate served badges \\+ trends');
  // The generate.js invocation must be non-fatal so a portfolio bug cannot skip
  // the commit step and drop the persisted record (F-caeeacc3). The fallback may
  // be the single-line `|| echo "::warning::..."` OR a `|| { ...; }` block — the
  // block form is required once the fallback also appends a $GITHUB_STEP_SUMMARY
  // note (F-f05363e2). Both swallow the failure; assert the invariant, not the
  // exact shape: generate.js is followed by a `||` fallback, that fallback still
  // surfaces the ::warning:: signal, and nothing in it exits non-zero.
  assert.match(
    block,
    /node packages\/portfolio\/generate\.js\s*\|\|\s*(\{|echo "::warning::)/,
    'the generate.js invocation must be non-fatal (`|| echo ...` or `|| { ... }`) so a portfolio bug cannot skip the commit step and drop the persisted record (F-caeeacc3)',
  );
  assert.match(
    block,
    /::warning::/,
    'the non-fatal fallback must still surface a ::warning:: so a failed regeneration is not silent (F-caeeacc3)',
  );
  assert.doesNotMatch(
    block,
    /\bexit 1\b/,
    'the badge/trends fallback must not exit 1 — a red step between persist and commit discards the persisted record (F-caeeacc3)',
  );
});

test('STRUCTURAL F-caeeacc3: the commit step also runs when the result parse failed', () => {
  const section = extractStepSection(readFileSync(ingestYml, 'utf8'), 'Commit records and indexes');
  assert.match(
    section,
    /if:[^\n]*parse_failed[^\n]*==\s*'true'/,
    "the commit step's `if:` must include the parse_failed output so an unparseable run.js stdout still commits the persisted evidence (F-caeeacc3)",
  );
});

test('STRUCTURAL F-caeeacc3: a deferred-fail step reds the run after the evidence commit on parse failure', () => {
  const yaml = readFileSync(ingestYml, 'utf8');
  const section = extractStepSection(yaml, 'Fail run on deferred result-parse error');
  assert.match(section, /parse_failed[^\n]*==\s*'true'/, 'the deferred-fail step must be gated on parse_failed');
  assert.match(section, /exit 1/, 'the deferred-fail step must exit 1 so an unparseable result still reds the run (failures must surface)');
  // Ordering: the deferred fail must come AFTER the commit step. Match the
  // step NAME lines, not free text — the Read result comment also mentions
  // the deferred step by name.
  assert.ok(
    yaml.indexOf('name: Fail run on deferred result-parse error') > yaml.indexOf('name: Commit records and indexes'),
    'the deferred-fail step must run after the commit step — evidence first, red run second',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F-50558cb2: stderr capture must be deterministic. Bash does not wait for a
// `2> >(tee ...)` process substitution when the pipeline completes, so the
// staleness NDJSON tail could still be unflushed when the 'Warn on stale
// indexes' step reads the file. A plain redirect + post-pipeline cat has no
// async writer.
// ─────────────────────────────────────────────────────────────────────────────

test('STRUCTURAL F-50558cb2: both ingestion legs capture stderr with a plain redirect, not a procsub, and replay it to the live log', () => {
  const yaml = readFileSync(ingestYml, 'utf8');
  for (const step of ['Run ingestion \\(repository_dispatch\\)', 'Run ingestion \\(workflow_dispatch\\)']) {
    const block = extractRunBlock(yaml, step);
    assert.doesNotMatch(block, /2>\s*>\(/, `${step}: must not use a process substitution for the stderr capture — bash does not wait for it, so the capture file can be torn (F-50558cb2)`);
    assert.match(block, /2>\s*\/tmp\/ingest-stderr\.log/, `${step}: must capture stderr with a plain redirect to /tmp/ingest-stderr.log`);
    assert.match(block, /cat \/tmp\/ingest-stderr\.log >&2/, `${step}: must replay the captured stderr to the live log so operators still see run.js diagnostics inline`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F-68818085: the push-retry loop must only rebase when another attempt
// follows. A rebase after the final failed push can itself conflict, making
// the run's terminal error 'rebase failed during push retry attempt 3' even
// though no retry was going to happen — misdirecting the operator from the
// real terminus ('all 3 push attempts failed').
// ─────────────────────────────────────────────────────────────────────────────

test('STRUCTURAL F-68818085: git pull --rebase runs only inside the another-attempt-follows branch', () => {
  const block = extractRunBlock(readFileSync(ingestYml, 'utf8'), 'Commit records and indexes');
  const rebaseCount = (block.match(/git pull --rebase/g) ?? []).length;
  assert.equal(rebaseCount, 1, 'exactly one rebase site expected in the retry loop');
  // The nearest preceding `if [ $attempt -lt 3 ]; then` must still be OPEN
  // (no intervening `fi`) when the rebase runs — i.e. the rebase is inside
  // that branch, not after it. A lazy `[\s\S]*?` match would pass on the
  // broken layout by crossing the closing `fi`, so we check the slice.
  const rebaseIdx = block.indexOf('git pull --rebase');
  const ifIdx = block.lastIndexOf('if [ $attempt -lt 3 ]; then', rebaseIdx);
  assert.ok(ifIdx >= 0, 'expected an `if [ $attempt -lt 3 ]; then` branch before the rebase');
  assert.doesNotMatch(
    block.slice(ifIdx, rebaseIdx),
    /\bfi\b/,
    'the rebase must sit INSIDE the `if [ $attempt -lt 3 ]` branch so no wasted (and possibly conflicting) rebase runs after the final failed push (F-68818085)',
  );
});
