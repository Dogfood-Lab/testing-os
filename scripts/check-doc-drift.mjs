#!/usr/bin/env node
/**
 * check-doc-drift.mjs — config-driven documentation drift checker.
 *
 * Codifies Class #11 (multi-occurrence fix completeness) — when a contract
 * value (an error code, a status enum, a stage name, a path) lives in code
 * but is referenced in docs, the docs go stale silently. This script asserts
 * the cross-reference holds, in one place, on every CI build.
 *
 * Per Mike's wave 19 brief: "the script becomes the test." It IS the contract
 * test that asserts every error code in lib/errors.js has a corresponding
 * entry in the error-codes handbook page (and four sibling drift classes
 * besides). Adding a new check is a config edit (scripts/doc-drift-patterns.json),
 * not a code edit, unless the new check is a new KIND of comparison — in
 * which case add a handler here and a config entry there.
 *
 * Architecture (Phase 7 wave 1, F-252713-016 + F-252713-017):
 *   The 4 original handlers refactored into a uniform handler-module shape:
 *     { kind, description, requiredFields, run(check, repoRoot) → DriftReport[] }
 *   Two new handlers ride the same interface:
 *     - helper-adoption-sweep — productizes wave22-log-stage-discipline.test.js
 *       as a generalized Class #9 sweep. Asserts every shared helper (atomic
 *       write, log-stage, unsafe-segment, structured errors, validate-record)
 *       is the SOLE definition of its concern across packages/**, and every
 *       caller that uses the underlying primitive imports the helper. Drift
 *       = a sibling re-implementing the helper or calling the raw primitive
 *       without going through it.
 *     - schema-conformance — productizes the silent normalization loop in
 *       collect.js as a structured contract gate. Validates target JSON files
 *       against a JSON Schema and emits structured errors on failure.
 *   A self-test handler (framework-self-test) checks the framework's own
 *   structure: every config entry has all required fields for its kind, every
 *   `kind` has a registered handler, every handler module declares the fields
 *   it requires.
 *
 * Each handler is registered in HANDLERS by `kind`. The CLI aggregates
 * reports and exits 0 on clean / 1 on drift / 2 on misconfiguration (e.g.
 * unknown check kind, missing source file).
 *
 * Adding a new drift CLASS = add a handler module here AND a config entry.
 * Adding a new check INSTANCE of an existing class = config-only edit.
 *
 * Usage:
 *   node scripts/check-doc-drift.mjs                  # run all checks
 *   node scripts/check-doc-drift.mjs --check <id>     # run single check by id
 *   node scripts/check-doc-drift.mjs --json           # machine-readable output
 *
 * Programmatic API:
 *   import { runDriftChecks } from './check-doc-drift.mjs';
 *   const result = await runDriftChecks({ repoRoot, configPath, checkId });
 *   // result = { clean: boolean, reports: DriftReport[], checksRun: number }
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * @typedef {Object} DriftReport
 * @property {string} checkId          - id from the config entry
 * @property {string} severity         - 'drift' | 'config-error'
 * @property {string} message          - human-readable
 * @property {string} [file]           - file:line where drift was observed
 * @property {string} [hint]           - actionable next step
 * @property {string[]} [missing]      - for source-vs-target: missing tokens
 * @property {string[]} [forbidden]    - for forbidden-pattern: matched patterns
 * @property {Object}   [error]        - structured error envelope (schema-conformance)
 */

/**
 * @typedef {Object} HandlerModule
 * @property {string}   kind             - matches `check.kind` in config
 * @property {string}   description      - one-line handler purpose
 * @property {string[]} [requiredFields] - config keys required for a valid check
 * @property {(check, repoRoot) => Promise<DriftReport[]> | DriftReport[]} run
 */

/**
 * Run all checks (or one by id). Pure-ish — never mutates the filesystem.
 *
 * @param {Object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.configPath]
 * @param {string} [opts.checkId]
 * @returns {Promise<{ clean: boolean, reports: DriftReport[], checksRun: number, checksTotal: number }>}
 */
export async function runDriftChecks({ repoRoot, configPath, checkId }) {
  const cfgPath = configPath ?? resolve(repoRoot, 'scripts/doc-drift-patterns.json');
  if (!existsSync(cfgPath)) {
    return {
      clean: false,
      reports: [{
        checkId: '<config>',
        severity: 'config-error',
        message: `[check-doc-drift] config file not found: ${cfgPath}`,
        hint: 'Run from the repo root, or pass --config explicitly.',
      }],
      checksRun: 0,
      checksTotal: 0,
    };
  }

  // F-016e7a8c: this parse was unguarded — a hand-edit JSON syntax error
  // (this file's own docstring invites exactly this: "Adding a new check is
  // a config edit") propagated as an uncaught SyntaxError out of this async
  // function (a rejected promise), bypassing the documented Programmatic API
  // contract (`{ clean, reports, checksRun, checksTotal }`) this function's
  // own JSDoc promises — every OTHER failure path in this function (config
  // not found, above; unknown checkId, below) already degrades to that
  // shape instead of throwing. Mirrors the schema-conformance handler's
  // identical try/catch a few hundred lines down, which already proves the
  // codebase knows this pattern; it just wasn't applied to this function's
  // own top-level config load.
  let config;
  try {
    config = JSON.parse(readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    return {
      clean: false,
      reports: [{
        checkId: '<config>',
        severity: 'config-error',
        message: `[check-doc-drift] config file is not valid JSON: ${relative(repoRoot, cfgPath)} — ${err.message}`,
        hint: 'Check the config file for a JSON syntax error (trailing comma, unclosed bracket).',
      }],
      checksRun: 0,
      checksTotal: 0,
    };
  }
  const allChecks = config.checks ?? [];
  const checks = checkId ? allChecks.filter((c) => c.id === checkId) : allChecks;

  if (checkId && checks.length === 0) {
    return {
      clean: false,
      reports: [{
        checkId,
        severity: 'config-error',
        message: `[check-doc-drift] no check with id '${checkId}' in ${relative(repoRoot, cfgPath)}`,
        hint: `Known check ids: ${allChecks.map((c) => c.id).join(', ')}`,
      }],
      checksRun: 0,
      checksTotal: allChecks.length,
    };
  }

  const reports = [];
  for (const check of checks) {
    const handler = HANDLERS[check.kind];
    if (!handler) {
      reports.push({
        checkId: check.id,
        severity: 'config-error',
        message: `[check-doc-drift] unknown check kind '${check.kind}' for check '${check.id}'`,
        hint: `Known kinds: ${Object.keys(HANDLERS).join(', ')}. To add a new kind, register a handler module in scripts/check-doc-drift.mjs.`,
      });
      continue;
    }
    try {
      const checkReports = await handler.run(check, repoRoot);
      reports.push(...checkReports);
    } catch (err) {
      reports.push({
        checkId: check.id,
        severity: 'config-error',
        message: `[check-doc-drift] handler for '${check.id}' threw: ${err.message}`,
        hint: 'Likely a misconfigured source/target path. Verify all paths in scripts/doc-drift-patterns.json.',
      });
    }
  }

  return {
    clean: reports.length === 0,
    reports,
    checksRun: checks.length,
    checksTotal: allChecks.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler modules — one per check kind. Adding a new module = adding a new
// drift CLASS. Adding a new check INSTANCE of an existing kind is config-only.
// Each module exports { kind, description, requiredFields?, run }.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a set of token values from the configured sources, then assert
 * every token is mentioned in at least one target. Allowlist exempts tokens
 * that are intentionally code-only (internal plumbing not surfaced to
 * operators).
 */
const sourceVsTargetCoverageHandler = {
  kind: 'source-vs-target-coverage',
  description: 'Every token extracted from sources must appear in at least one target.',
  requiredFields: ['sources', 'sourceExtractors', 'targets'],
  async run(check, repoRoot) {
    const tokens = new Set();
    for (const source of check.sources ?? []) {
      const sourcePath = resolve(repoRoot, source);
      if (!existsSync(sourcePath)) {
        return [{
          checkId: check.id,
          severity: 'config-error',
          message: `[${check.id}] source file not found: ${source}`,
          hint: 'Verify the path in scripts/doc-drift-patterns.json — it may have moved or been renamed.',
        }];
      }

      for (const extractor of check.sourceExtractors ?? []) {
        // Programmatic-evaluator extractor: import the module and read an
        // exported enum object. Only used for STATUS-shaped values where the
        // source of truth is a JS object literal that's awkward to regex.
        if (extractor.kind === 'status-enum-evaluator') {
          const modUrl = pathToFileURL(resolve(repoRoot, extractor.module)).href;
          const mod = await import(modUrl);
          const obj = mod[extractor.exportName];
          if (!obj || typeof obj !== 'object') {
            return [{
              checkId: check.id,
              severity: 'config-error',
              message: `[${check.id}] export ${extractor.exportName} from ${extractor.module} is missing or not an object`,
            }];
          }
          const skip = new Set(extractor.skipKeys ?? []);
          for (const [key, value] of Object.entries(obj)) {
            if (skip.has(key)) continue;
            if (Array.isArray(value)) {
              for (const v of value) tokens.add(v);
            }
          }
          continue;
        }

        // Regex extractor with optional fixed expansion (for template-literal
        // codes like `STATE_MACHINE_${kind}` that regex alone can't enumerate).
        if (extractor.expand) {
          const src = readFileSync(sourcePath, 'utf8');
          const re = new RegExp(extractor.regex);
          if (re.test(src)) {
            for (const v of extractor.expand) tokens.add(v);
          }
          continue;
        }

        const src = readFileSync(sourcePath, 'utf8');
        const re = new RegExp(extractor.regex, 'g');
        let m;
        while ((m = re.exec(src)) !== null) {
          const captured = m[extractor.captureGroup ?? 1];
          if (captured) tokens.add(captured);
        }
      }
    }

    const allowlist = new Set(check.allowlist ?? []);
    const requiredTokens = [...tokens].filter((t) => !allowlist.has(t));

    const targetCorpus = readTargetCorpus(check.targets ?? [], repoRoot);
    if (targetCorpus.error) {
      return [{ checkId: check.id, severity: 'config-error', message: targetCorpus.error }];
    }

    const missing = [];
    for (const token of requiredTokens) {
      const found = check.matchMode === 'wholeWord'
        ? new RegExp(`\\b${escapeRegex(token)}\\b`).test(targetCorpus.text)
        : targetCorpus.text.includes(token);
      if (!found) missing.push(token);
    }

    if (missing.length === 0) return [];

    return [{
      checkId: check.id,
      severity: 'drift',
      message: `[${check.id}] ${check.title}: ${missing.length} token(s) missing from target docs`,
      missing,
      file: check.targets?.[0],
      hint: check.hint,
    }];
  },
};

/**
 * Assert no target file contains any of the forbidden patterns. Path patterns
 * for legacy paths, version-specific narrative terms, etc.
 */
const forbiddenPatternInTargetsHandler = {
  kind: 'forbidden-pattern-in-targets',
  description: 'No target file may contain any of the forbidden patterns.',
  requiredFields: ['patterns', 'targets'],
  async run(check, repoRoot) {
    const reports = [];
    const targetFiles = expandGlobs(check.targets ?? [], repoRoot);

    // F-cca3ed17: zero matched targets means the gate protects NOTHING — a
    // renamed docs dir or a typo'd glob turned the check silently green
    // forever (the D4-004 vacuous-gate class, closed for every sibling
    // handler but this one). Fail loud unless the check explicitly opts into
    // empty via allowEmpty (parity with schema-conformance).
    if (targetFiles.length === 0 && !check.allowEmpty) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] no target files matched: ${(check.targets ?? []).join(', ')}`,
        hint: 'The target globs may have rotted (docs reorganized, path typo). Fix the globs in scripts/doc-drift-patterns.json, or set "allowEmpty": true only if matching zero files is genuinely acceptable for this check.',
      }];
    }

    for (const file of targetFiles) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      for (const pattern of check.patterns ?? []) {
        const re = new RegExp(pattern.regex, 'g');
        const hits = [];
        lines.forEach((line, idx) => {
          if (re.test(line)) {
            hits.push({ line: idx + 1, snippet: line.trim().slice(0, 120) });
          }
          re.lastIndex = 0;
        });
        if (hits.length > 0) {
          const rel = relative(repoRoot, file).replace(/\\/g, '/');
          for (const hit of hits) {
            reports.push({
              checkId: check.id,
              severity: 'drift',
              message: `[${check.id}] ${pattern.label}: ${rel}:${hit.line}`,
              file: `${rel}:${hit.line}`,
              forbidden: [pattern.regex],
              hint: check.hint,
            });
          }
        }
      }
    }

    return reports;
  },
};

/**
 * Assert a single target file passes a set of must[] / mustNot[] rules.
 * Used for cross-referential consistency within one file (e.g. PROTOCOL.md
 * mentioning Stage D in the title and in the body and in the checklist).
 */
const selfConsistencyHandler = {
  kind: 'self-consistency',
  description: 'A single target file satisfies must[] / mustNot[] rules.',
  requiredFields: ['target', 'rules'],
  async run(check, repoRoot) {
    const targetPath = resolve(repoRoot, check.target);
    if (!existsSync(targetPath)) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] target file not found: ${check.target}`,
      }];
    }
    const text = readFileSync(targetPath, 'utf8');
    const reports = [];

    for (const rule of check.rules ?? []) {
      for (const must of rule.must ?? []) {
        const re = new RegExp(must.regex, 'g');
        const matches = text.match(re) ?? [];
        const min = must.min ?? 1;
        if (matches.length < min) {
          reports.push({
            checkId: check.id,
            severity: 'drift',
            message: `[${check.id}/${rule.id}] required content missing — ${must.label} (found ${matches.length}, need ${min})`,
            file: check.target,
            hint: check.hint,
          });
        }
      }
      for (const mustNot of rule.mustNot ?? []) {
        const re = new RegExp(mustNot.regex);
        if (re.test(text)) {
          reports.push({
            checkId: check.id,
            severity: 'drift',
            message: `[${check.id}/${rule.id}] forbidden content present — ${mustNot.label}`,
            file: check.target,
            hint: check.hint,
          });
        }
      }
    }

    return reports;
  },
};

/**
 * Assert every opening triple-backtick fence in target Markdown files carries
 * a language tag. Closing fences (the matching ``` on a line by itself after
 * the open) are correctly bare; this handler tracks open/close state by
 * counting fence lines per file. Drift = an OPENING fence with no language.
 *
 * Why a dedicated handler instead of forbidden-pattern-in-targets: the regex
 * `^```$` would match both opening AND closing fences and produce false
 * positives on every well-formed code block. The state machine here (toggle
 * `inFence` per `^```` line, only inspect on the open transition) is the
 * minimum needed to distinguish the two cases without spec-grade Markdown
 * parsing.
 *
 * Stage D wave 23, D-CI-001 (F-827321-010): added after the handbook sweep
 * fixed five untagged fences across architecture / state-machines /
 * intelligence-layer.
 */
const untaggedFenceHandler = {
  kind: 'untagged-fence',
  description: 'Every opening triple-backtick fence in target markdown declares a language.',
  requiredFields: ['targets'],
  async run(check, repoRoot) {
    const reports = [];
    const targetFiles = expandGlobs(check.targets ?? [], repoRoot);
    if (targetFiles.length === 0) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] no target files matched: ${(check.targets ?? []).join(', ')}`,
      }];
    }

    for (const file of targetFiles) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      let inFence = false;
      let fenceLen = 0;
      lines.forEach((line, idx) => {
        if (inFence) {
          // A closer is a BARE fence, optionally indented up to 3 spaces
          // (CommonMark), AT LEAST as long as its opener (F-1c99c064: a
          // fixed-``` closer could never close a 4-backtick block — the
          // standard way to SHOW fence examples — so the inner bare ```
          // example lines were false-flagged and every later real fence in
          // the file went invisible). A fence-looking line WITH an info
          // string inside an open block is content, not a close.
          const close = /^\s{0,3}(`{3,})\s*$/.exec(line);
          if (close && close[1].length >= fenceLen) inFence = false;
          return;
        }
        // F-de02ea22: openers may be indented up to 3 spaces and may sit on a
        // list-marker line (`- ```js`) or a list continuation — legal, common
        // CommonMark that the previous column-0-only regex silently skipped,
        // so untagged fences nested in the handbook's bulleted lists shipped
        // unflagged. 4+ spaces of indent is an indented code block, not a
        // fence, and stays ignored. F-1c99c064: the opener's backtick run is
        // captured so the closer can require an equal-or-longer run.
        const m = /^\s{0,3}(?:(?:[-*+]|\d+\.)\s+)?(`{3,})(.*)$/.exec(line);
        if (!m) return;
        const info = m[2].trim();
        // CommonMark: the info string of a backtick fence may not contain a
        // backtick — such a line is not a fence opener at all (F-1c99c064).
        if (info.includes('`')) return;
        if (info.length === 0) {
          const rel = relative(repoRoot, file).replace(/\\/g, '/');
          reports.push({
            checkId: check.id,
            severity: 'drift',
            message: `[${check.id}] ${check.title}: ${rel}:${idx + 1} — opening fence missing language tag`,
            file: `${rel}:${idx + 1}`,
            forbidden: ['```\\n (untagged opening fence)'],
            hint: check.hint,
          });
        }
        inFence = true;
        fenceLen = m[1].length;
      });
    }

    return reports;
  },
};

/**
 * helper-adoption-sweep — F-252713-016 / FT-CITOOLING-001.
 *
 * Productizes wave22-log-stage-discipline.test.js as a generalized Class #9
 * (multi-occurrence sibling-fix) sweep. Given:
 *   - helper:           the file that owns the canonical implementation
 *                       (e.g. packages/findings/lib/atomic-write.js)
 *   - exportName:       the export name agents must import
 *                       (e.g. atomicWriteFileSync)
 *   - forbiddenPattern: the raw primitive callers should NOT use directly
 *                       (e.g. fs\.writeFileSync|writeFileSync\()
 *   - callers:          glob list of files where the pattern is searched
 *                       (e.g. ['packages/**\/*.js'] — no actual escape, see config)
 *   - allowlist:        files that legitimately use the primitive
 *                       (e.g. the helper itself, test fixtures)
 *   - wrapperHint:      hint shown on drift to guide the fix
 *
 * Behavior: walk the callers glob, regex for forbiddenPattern. For each hit,
 * verify the file imports the helper export. If not, report drift with a
 * pointer at the canonical helper.
 *
 * Wrappers that import the shared helper AND re-export under a different
 * name (e.g. ingest's component-pinning logStage wrapper) are allowed —
 * the import-of-helper check is the discriminator.
 *
 * Test-files exclusion: any file ending `.test.js` / `.test.mjs` is excluded
 * by default (tests routinely call raw fs.writeFileSync to construct
 * fixtures). Override via `includeTests: true` if desired.
 */
const helperAdoptionSweepHandler = {
  kind: 'helper-adoption-sweep',
  description: 'Every caller of a primitive imports the canonical helper instead of the raw primitive.',
  requiredFields: ['helper', 'exportName', 'forbiddenPattern', 'callers'],
  async run(check, repoRoot) {
    const helperAbs = resolve(repoRoot, check.helper);
    if (!existsSync(helperAbs)) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] helper file not found: ${check.helper}`,
        hint: 'Verify the path in scripts/doc-drift-patterns.json — the helper may have moved.',
      }];
    }

    // Sanity check: helper actually exports the named symbol.
    const helperSrc = readFileSync(helperAbs, 'utf8');
    const exportRe = new RegExp(`export\\s+(?:function|const|let|var|class)\\s+${escapeRegex(check.exportName)}\\b`);
    if (!exportRe.test(helperSrc)) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] helper ${check.helper} does not export ${check.exportName}`,
        hint: 'Either fix exportName in the config, or add the missing export to the helper.',
      }];
    }

    const callerFiles = expandGlobs(check.callers ?? [], repoRoot, { recursive: true });
    if (callerFiles.length === 0) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] no caller files matched: ${(check.callers ?? []).join(', ')}`,
      }];
    }

    const allowlist = new Set((check.allowlist ?? []).map((p) => resolve(repoRoot, p)));
    const includeTests = check.includeTests === true;
    const forbiddenRe = new RegExp(check.forbiddenPattern);
    const importRe = new RegExp(
      `import\\s*(?:[^;]*?\\b${escapeRegex(check.exportName)}\\b[^;]*?)\\s*from\\s*['"][^'"]+['"]`,
    );

    const reports = [];
    for (const file of callerFiles) {
      if (file === helperAbs) continue;
      if (allowlist.has(file)) continue;
      const base = file.replace(/\\/g, '/');
      if (!includeTests && /\.test\.(?:js|mjs|cjs)$/.test(base)) continue;

      const src = readFileSync(file, 'utf8');
      const stripped = stripCommentsAndStrings(src);
      if (!forbiddenRe.test(stripped)) continue;
      if (importRe.test(src)) continue;

      const rel = relative(repoRoot, file).replace(/\\/g, '/');
      reports.push({
        checkId: check.id,
        severity: 'drift',
        message: `[${check.id}] ${check.title ?? check.id}: ${rel} uses raw ${check.forbiddenPattern} but does not import { ${check.exportName} } from ${check.helper}`,
        file: rel,
        forbidden: [check.forbiddenPattern],
        hint: check.wrapperHint
          ?? `Import { ${check.exportName} } from '${check.helper}' (via @dogfood-lab/<pkg> if cross-package) and replace the raw call. Wrappers that delegate to the helper are allowed; the wrapper file must import the helper.`,
      });
    }

    return reports;
  },
};

/**
 * schema-conformance — F-252713-017 / FT-CITOOLING-002.
 *
 * Validates target JSON files against a JSON Schema. The schema is loaded
 * via Ajv2020 (mirrors packages/ingest/validate-record.js). On failure,
 * each invalid file produces a structured drift report with the Ajv error
 * envelope so the agent author can fix the format drift at the source.
 *
 * Today this is the wave-26 contract for swarms/<run>/wave-N/<domain>.json
 * feature outputs. The schema lives at scripts/agent-output.schema.json.
 * collect.js may eventually call validateAgainstSchema() before merge — that
 * wiring is a backend-domain edit (cross-wave dependency), but the gate
 * itself runs here on every CI build.
 *
 * Stage C Wave A2 D4-004 (the SOUND half of R9 — close the vacuous gate):
 * the original handler treated every matched file as "must validate" and
 * the config relied on `allowEmpty: true` because both target globs matched
 * zero committed files. That made the check structurally vacuous —
 * a future zero-match (schema rot, stray globs) stays silently green.
 *
 * The handler now discriminates POSITIVE vs NEGATIVE fixtures by filename:
 * a basename matching `negativeFilenamePattern` (default `^invalid-`) MUST
 * fail validation; everything else MUST pass. A negative fixture that
 * accidentally validates is reported as drift — proof that the negative
 * fixture isn't actually testing the constraint it claims to test.
 * Combined with dropping `allowEmpty: true` in the config, the gate is now
 * behaviorally fail-loud: zero fixtures → config-error; positive fixture
 * that fails → drift; negative fixture that passes → drift.
 */
const schemaConformanceHandler = {
  kind: 'schema-conformance',
  description: 'Target JSON files validate against the configured JSON Schema. Negative fixtures (basename matches negativeFilenamePattern) must fail validation; everything else must pass.',
  requiredFields: ['schema', 'targets'],
  async run(check, repoRoot) {
    const schemaAbs = resolve(repoRoot, check.schema);
    if (!existsSync(schemaAbs)) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] schema file not found: ${check.schema}`,
        hint: 'Either add the schema or fix the path in scripts/doc-drift-patterns.json.',
      }];
    }

    let schema;
    try {
      schema = JSON.parse(readFileSync(schemaAbs, 'utf8'));
    } catch (err) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] schema file is not valid JSON: ${err.message}`,
      }];
    }

    // Ajv is an optional dep — a structural fallback exists for minimum-dep
    // environments, but ONLY as an explicit opt-in. F-1b9456a0: the fallback
    // ignores additionalProperties, oneOf/anyOf, deep $defs, and numeric
    // constraints, so silently substituting it (node_modules corruption, a
    // future dep restructure) is a strength downgrade of a CI gate with no
    // signal — positive fixtures could pass the weak validator while
    // violating the real schema. Default is fail-loud (config-error);
    // `allowStructuralFallback: true` accepts the weaker gate explicitly,
    // and even then the downgrade is logged. `ajvModule` exists as a
    // dependency-injection seam so the META test can exercise this path.
    let validate;
    const ajvModule = check.ajvModule ?? 'ajv/dist/2020.js';
    try {
      const Ajv2020Mod = await import(ajvModule);
      const Ajv2020 = Ajv2020Mod.default ?? Ajv2020Mod;
      const addFormatsMod = await import('ajv-formats').catch(() => null);
      const addFormats = addFormatsMod?.default ?? addFormatsMod;
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      if (addFormats) addFormats(ajv);
      validate = ajv.compile(schema);
    } catch (err) {
      if (check.allowStructuralFallback !== true) {
        return [{
          checkId: check.id,
          severity: 'config-error',
          message: `[${check.id}] Ajv unavailable (${err.message}) — refusing to silently downgrade to the weaker structural validator`,
          hint: 'Restore the ajv install (npm ci), or set "allowStructuralFallback": true on the check to accept the degraded gate explicitly.',
        }];
      }
      console.error(
        `[check-doc-drift] WARNING: Ajv unavailable for check '${check.id}' (${err.message}) — running with the weaker structural validator (ignores additionalProperties, oneOf/anyOf, numeric constraints).`,
      );
      validate = makeStructuralValidator(schema);
    }

    const targetFiles = expandGlobs(check.targets ?? [], repoRoot, { recursive: true });
    const allowlist = new Set((check.allowlist ?? []).map((p) => resolve(repoRoot, p)));
    const errorClass = check.errorClass ?? 'AgentOutputValidationError';

    // D4-004: negative-fixture convention — basenames matching this regex
    // MUST fail validation. Default `^invalid-` picks up the canonical
    // hand-curated negative fixtures under swarms/__schema-fixtures__/
    // (e.g. invalid-missing-domain.json). Configurable per check so a
    // different fixture-tree convention can override without code edits.
    const negFilenameRe = new RegExp(
      check.negativeFilenamePattern ?? '^invalid-',
    );

    // F-5d126106: per-glob zero-match check, not union-level. The prior
    // guard checked only the FLATTENED union (targetFiles.length === 0), so
    // any one glob matching files permanently masked every other glob
    // matching zero — this is exactly how the live-run wave-outputs glob
    // (swarms/swarm-*/wave-*/outputs/*.json — structurally unmatchable on
    // CI because swarms/.gitignore ignores `swarm-*/` wholesale) stayed
    // invisible for as long as swarms/__schema-fixtures__/*.json kept
    // matching its 4 committed fixtures. `allowEmptyGlobs` names the
    // specific target globs EXPECTED to legitimately match zero files on
    // CI, declaring that intent explicitly rather than a check-wide
    // `allowEmpty: true` silently covering a glob that rotted for an
    // unrelated reason. Every glob not listed there is checked
    // independently and must match at least one file.
    if (!check.allowEmpty) {
      const allowEmptyGlobs = new Set(check.allowEmptyGlobs ?? []);
      const emptyRequired = (check.targets ?? []).filter(
        (pattern) => !allowEmptyGlobs.has(pattern) && expandGlobs([pattern], repoRoot, { recursive: true }).length === 0,
      );
      if (emptyRequired.length > 0) {
        return [{
          checkId: check.id,
          severity: 'config-error',
          message: `[${check.id}] no target files matched: ${emptyRequired.join(', ')}`,
          hint: 'The target glob(s) may have rotted (docs reorganized, path typo). Fix the glob in scripts/doc-drift-patterns.json, or add it to "allowEmptyGlobs" only if matching zero files is genuinely expected for that specific glob (e.g. a local-only live-run tree that CI never populates).',
        }];
      }
    }

    const reports = [];
    for (const file of targetFiles) {
      if (allowlist.has(file)) continue;
      const basename = file.replace(/\\/g, '/').split('/').pop() ?? file;
      const isNegative = negFilenameRe.test(basename);

      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        const rel = relative(repoRoot, file).replace(/\\/g, '/');
        // Negative fixtures intentionally violate the schema, not the JSON
        // grammar. Malformed JSON is a real bug in either case — surface it.
        reports.push({
          checkId: check.id,
          severity: 'drift',
          message: `[${check.id}] ${rel}: invalid JSON — ${err.message}`,
          file: rel,
          error: { name: errorClass, code: 'INVALID_JSON', message: err.message, hint: 'Fix the JSON syntax. Common causes: trailing comma, unquoted key, unescaped string.' },
          hint: check.hint,
        });
        continue;
      }

      const ok = validate(parsed);
      const rel = relative(repoRoot, file).replace(/\\/g, '/');

      if (isNegative) {
        // Negative fixture: MUST fail validation. If it passes, the fixture
        // is no longer testing the constraint it claims to test (schema
        // loosened, fixture out of date, etc.) — surface as drift.
        if (ok) {
          reports.push({
            checkId: check.id,
            severity: 'drift',
            message: `[${check.id}] ${rel}: NEGATIVE fixture passed validation but must fail`,
            file: rel,
            error: {
              name: errorClass,
              code: 'NEGATIVE_FIXTURE_PASSED',
              message: `Negative fixture ${rel} validated against ${check.schema} but is expected to fail. The schema may have loosened, or the fixture no longer violates the constraint it claims to test.`,
              hint: 'Either tighten the fixture to violate a current constraint, or remove it if the constraint is gone.',
            },
            hint: check.hint,
          });
        }
        // Negative-fixture-correctly-failed: silent pass, no report.
        continue;
      }

      // Positive fixture: MUST pass validation.
      if (!ok) {
        const ajvErrors = validate.errors ?? [];
        const summary = ajvErrors
          .slice(0, 5)
          .map((e) => `${e.instancePath || '/'} ${e.message}`)
          .join('; ');
        reports.push({
          checkId: check.id,
          severity: 'drift',
          message: `[${check.id}] ${rel}: schema validation failed — ${summary}`,
          file: rel,
          error: {
            name: errorClass,
            code: 'AGENT_OUTPUT_INVALID',
            message: summary,
            errors: ajvErrors,
            hint: check.hint
              ?? `Fix the agent output to match ${check.schema}. The canonical shape is documented in the schema's description and in the brief's output-format section.`,
          },
          hint: check.hint,
        });
      }
    }

    return reports;
  },
};

/**
 * framework-self-test — meta-check that asserts the framework's own structure.
 *
 * This is the choke-point invariant: every config entry must declare a kind
 * registered in HANDLERS, and every check must include the requiredFields
 * declared by its handler module. Drift here means someone added a new check
 * kind in config but forgot to register the handler, or removed a required
 * field from an existing check.
 *
 * The handler reads the live config from `configPath` (defaults to the same
 * config file the framework runs against) and walks every check entry.
 */
const frameworkSelfTestHandler = {
  kind: 'framework-self-test',
  description: 'Every config entry has a registered handler and all required fields.',
  requiredFields: [],
  async run(check, repoRoot) {
    const cfgPath = resolve(repoRoot, check.configPath ?? 'scripts/doc-drift-patterns.json');
    if (!existsSync(cfgPath)) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] config file not found: ${cfgPath}`,
      }];
    }
    // F-016e7a8c: the same unguarded JSON.parse(readFileSync(...)) pattern
    // fixed in runDriftChecks above, repeated here — this handler re-reads
    // the config file to self-validate the framework, and a malformed file
    // threw uncaught out of this run() rather than the structured
    // DriftReport[] this handler's own return type promises. (The generic
    // per-handler try/catch in runDriftChecks' own dispatch loop happens to
    // already convert this specific throw into SOME config-error report
    // today, but with a generic "handler threw" message and a misleading
    // "misconfigured source/target path" hint — not the JSON-syntax-specific
    // guidance this failure actually needs, and any future direct caller of
    // this handler's run() would not get that safety net at all.)
    let config;
    try {
      config = JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] config file is not valid JSON: ${cfgPath} — ${err.message}`,
        hint: 'Check the config file for a JSON syntax error (trailing comma, unclosed bracket).',
      }];
    }
    const reports = [];
    for (const entry of config.checks ?? []) {
      // Skip self — framework-self-test asserting its own required fields is
      // a vacuous loop.
      if (entry.id === check.id) continue;

      const handler = HANDLERS[entry.kind];
      if (!handler) {
        reports.push({
          checkId: check.id,
          severity: 'drift',
          message: `[${check.id}] check '${entry.id}' uses unknown kind '${entry.kind}' — no handler registered`,
          hint: `Register a handler module for kind '${entry.kind}' or remove the check.`,
        });
        continue;
      }
      for (const field of handler.requiredFields ?? []) {
        if (entry[field] === undefined) {
          reports.push({
            checkId: check.id,
            severity: 'drift',
            message: `[${check.id}] check '${entry.id}' (kind '${entry.kind}') missing required field '${field}'`,
            hint: `Add '${field}' to the check entry. Required fields for '${entry.kind}': ${(handler.requiredFields ?? []).join(', ')}.`,
          });
        }
      }
    }

    // Also assert every registered handler module declares its kind matching
    // its key in HANDLERS — defensive against future copy-paste bugs.
    for (const [registeredKind, mod] of Object.entries(HANDLERS)) {
      if (mod.kind !== registeredKind) {
        reports.push({
          checkId: check.id,
          severity: 'drift',
          message: `[${check.id}] handler module registered as '${registeredKind}' declares kind '${mod.kind}'`,
          hint: 'The HANDLERS map key must match the module\'s declared kind.',
        });
      }
    }

    return reports;
  },
};

/**
 * source-of-truth-cross-ref — R9 (v1.3.1 fast-follow).
 *
 * Cross-references current-state claims on honesty surfaces (SHIP_GATE,
 * SCORECARD, CLAUDE, README, HANDOFF, SECURITY, site-config) against
 * authoritative resolvers (package.json fields, publishability declarations,
 * cli.js verb counts). Closes the drift class the v1.3.0 release surfaced
 * twice — stale `v1.2.3` text on ungated surfaces after the v1.3.0 bump,
 * caught by a manual sweep that nothing was gating.
 *
 * Design corrections from the original R9 brief (per the v1.3.0 swarm
 * post-mortem):
 *   - NO wall-clock date arithmetic (the original's "N days ago" check is a
 *     time-bomb — goes red on every calendar day with zero code/doc change).
 *   - NO absolute test-count resolver (R6 dropped that claim from the README
 *     in v1.3.0; reintroducing it would re-introduce the unit-mismatch risk).
 *   - "Publishable" = package.json *declares* publishable (not private +
 *     `publishConfig.access`), NOT npm-registry truth. The manifest is the
 *     authoritative surface for what the operator promised to ship; registry
 *     state lives outside the build.
 *   - Current-vs-historical discrimination is via per-claim anchor patterns,
 *     NOT free-floating version-string classification. Each claim names the
 *     exact line shape it gates; a pattern that matches zero lines reports as
 *     config-error so silent-truncation-by-rename cannot land a vacuous gate.
 *
 * Vacuity guard (lesson #3 from v1.3.0 — twice bit at the FIX layer): a claim
 * whose `pattern` matches no lines in its `target` is reported as
 * config-error, not silent pass. The companion META test in
 * scripts/check-doc-drift.test.mjs mutates each LIVE claim's captured value
 * to a stale stand-in and asserts the gate fires RED. Without that META loop,
 * R9 joins the drift-treadmill it was built to stop.
 *
 * Resolvers (extensible — add a case in resolveOne() to introduce a new kind):
 *   - package-json-field: read a dotted field path from a manifest file.
 *   - package-json-publishable: `!private && publishConfig.access === 'public'`.
 *   - pattern-count: count regex matches across a source file.
 *
 * Claim shape (in scripts/doc-drift-patterns.json):
 *   {
 *     id: string,
 *     target: string,            // path to honesty surface
 *     pattern: string,           // regex anchored to the current-state assertion
 *     captureGroup: number,      // which capture group holds the asserted value
 *     resolver: string,          // resolver name from `resolvers` map
 *     valueMap?: { [resolverStr: string]: string },  // optional boolean→token map
 *     title?: string,
 *     hint?: string,
 *     vacuousHint?: string
 *   }
 */
const sourceOfTruthCrossRefHandler = {
  kind: 'source-of-truth-cross-ref',
  description: 'Honesty surfaces match resolvers from package.json + cli.js. Per-claim anchor patterns; vacuity guarded; META test required.',
  requiredFields: ['resolvers', 'claims'],
  async run(check, repoRoot) {
    const reports = [];

    // ── Phase 1: resolve every resolver up-front. A resolver failure is a
    //    config-error that aborts the check — we cannot meaningfully report
    //    drift if we don't know the source of truth. ───────────────────────
    const resolverValues = {};
    for (const [name, spec] of Object.entries(check.resolvers ?? {})) {
      try {
        resolverValues[name] = resolveOne(spec, repoRoot);
      } catch (err) {
        reports.push({
          checkId: check.id,
          severity: 'config-error',
          message: `[${check.id}] resolver '${name}' failed: ${err.message}`,
          hint: `Check the resolver spec in scripts/doc-drift-patterns.json — verify 'source', 'file', and 'path'/'pattern' fields. Known sources: package-json-field, package-json-publishable, pattern-count.`,
        });
      }
    }
    // If any resolver failed, do not attempt claim evaluation — the comparison
    // would be against `undefined` and produce noisy false drift.
    if (reports.length > 0) return reports;

    // ── Phase 2: evaluate every claim against its resolver. ───────────────
    for (const claim of check.claims ?? []) {
      const targetAbs = resolve(repoRoot, claim.target);
      if (!existsSync(targetAbs)) {
        reports.push({
          checkId: check.id,
          severity: 'config-error',
          message: `[${check.id}/${claim.id}] target file not found: ${claim.target}`,
          hint: claim.vacuousHint ?? `Verify the path in scripts/doc-drift-patterns.json — the file may have moved or been renamed. R9 cannot honesty-check a surface that does not exist.`,
        });
        continue;
      }
      const rawResolver = resolverValues[claim.resolver];
      if (rawResolver === undefined) {
        reports.push({
          checkId: check.id,
          severity: 'config-error',
          message: `[${check.id}/${claim.id}] resolver '${claim.resolver}' not declared in resolvers{} for check '${check.id}'`,
          hint: `Add a '${claim.resolver}' entry to the check's resolvers{} block, or fix the typo in claim.resolver.`,
        });
        continue;
      }

      // Apply optional valueMap (used for boolean resolvers asserted as
      // human-readable tokens like 'yes'/'no' in the target text), then an
      // optional numeric offset (FT-g: relative-count claims). A surface that
      // says "all N sibling verbs" asserts total-1; "the other N verbs" after
      // naming K verbs inline asserts total-K. The offset is added to the
      // numeric resolver value before stringifying, so one verbCount resolver
      // governs every relative form. A non-integer resolver value with an
      // offset is a config error (you can't offset a version string).
      let resolved = claim.valueMap
        ? (claim.valueMap[String(rawResolver)] ?? rawResolver)
        : rawResolver;
      if (claim.offset !== undefined) {
        const base = Number(resolved);
        if (!Number.isInteger(base)) {
          reports.push({
            checkId: check.id,
            severity: 'config-error',
            message: `[${check.id}/${claim.id}] claim has 'offset' but resolver '${claim.resolver}' yielded a non-integer value '${resolved}' — offsets only apply to numeric (count) resolvers`,
            hint: `Remove 'offset' from claim '${claim.id}', or point it at a count resolver (pattern-count / command-map-count).`,
          });
          continue;
        }
        resolved = base + claim.offset;
      }
      const expected = String(resolved);

      const text = readFileSync(targetAbs, 'utf8');
      const lines = text.split(/\r?\n/);
      // Build a per-line regex so we report line numbers. A claim's pattern
      // is treated as line-local (no multiline modifier) — multi-line
      // assertions should be decomposed into multiple claims.
      let flags = claim.flags ?? '';
      if (!flags.includes('g')) flags += 'g';
      const re = new RegExp(claim.pattern, flags);

      const matches = [];
      lines.forEach((line, idx) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const captureGroup = claim.captureGroup ?? 1;
          const captured = m[captureGroup];
          if (captured !== undefined) {
            matches.push({ line: idx + 1, captured, full: m[0] });
          }
          if (m.index === re.lastIndex) re.lastIndex++; // safety: avoid infinite loop on zero-width
        }
      });

      // ── Vacuity guard. The protected assertion has been moved, renamed, or
      //    silently truncated. Stay LOUD so the operator updates the claim
      //    config rather than living with a green-but-protect-nothing gate. ─
      if (matches.length === 0) {
        reports.push({
          checkId: check.id,
          severity: 'config-error',
          message: `[${check.id}/${claim.id}] vacuous claim — pattern matched zero lines in ${claim.target}; the current-state assertion this claim guards has been moved, renamed, or removed`,
          file: claim.target,
          hint: claim.vacuousHint ?? `Locate the current ${claim.resolver} assertion in ${claim.target} and update claim '${claim.id}'s pattern in scripts/doc-drift-patterns.json to match its current shape. If the assertion was intentionally removed, delete the claim too (and document why in the entry's description).`,
        });
        continue;
      }

      // ── Drift check: every matched assertion must match the resolver value. ─
      for (const hit of matches) {
        if (hit.captured !== expected) {
          reports.push({
            checkId: check.id,
            severity: 'drift',
            message: `[${check.id}/${claim.id}] ${claim.target}:${hit.line} asserts '${hit.captured}' but resolver '${claim.resolver}' is '${expected}' — ${claim.title ?? claim.id}`,
            file: `${claim.target}:${hit.line}`,
            hint: claim.hint
              ?? `Update ${claim.target}:${hit.line} to '${expected}'. If the doc is right and the source is wrong, fix the resolver source instead. Either way, the two must agree before release.`,
          });
        }
      }
    }
    return reports;
  },
};

/**
 * Resolve a single resolver spec to its authoritative value.
 *
 * @param {{ source: string, file?: string, path?: string, pattern?: string, flags?: string }} spec
 * @param {string} repoRoot
 * @returns {string | number | boolean}
 */
function resolveOne(spec, repoRoot) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('resolver spec must be an object with a `source` field');
  }
  if (spec.source === 'package-json-field') {
    if (!spec.file) throw new Error('package-json-field resolver requires `file`');
    if (!spec.path) throw new Error('package-json-field resolver requires `path`');
    const abs = resolve(repoRoot, spec.file);
    if (!existsSync(abs)) throw new Error(`manifest not found: ${spec.file}`);
    const j = JSON.parse(readFileSync(abs, 'utf8'));
    let v = j;
    for (const seg of String(spec.path).split('.')) {
      if (v == null) break;
      v = v[seg];
    }
    if (v === undefined) {
      throw new Error(`field '${spec.path}' not present in ${spec.file}`);
    }
    return v;
  }
  if (spec.source === 'package-json-publishable') {
    if (!spec.file) throw new Error('package-json-publishable resolver requires `file`');
    const abs = resolve(repoRoot, spec.file);
    if (!existsSync(abs)) throw new Error(`manifest not found: ${spec.file}`);
    const j = JSON.parse(readFileSync(abs, 'utf8'));
    const notPrivate = j.private !== true;
    const hasPublicAccess = j.publishConfig != null && j.publishConfig.access === 'public';
    return notPrivate && hasPublicAccess;
  }
  if (spec.source === 'pattern-count') {
    if (!spec.file) throw new Error('pattern-count resolver requires `file`');
    if (!spec.pattern) throw new Error('pattern-count resolver requires `pattern`');
    const abs = resolve(repoRoot, spec.file);
    if (!existsSync(abs)) throw new Error(`source file not found: ${spec.file}`);
    const src = readFileSync(abs, 'utf8');
    let flags = spec.flags ?? 'g';
    if (!flags.includes('g')) flags += 'g';
    const re = new RegExp(spec.pattern, flags);
    let count = 0;
    while (re.exec(src) !== null) {
      count++;
      if (count > 100000) throw new Error('pattern-count exceeded 100k matches — likely an unanchored regex');
    }
    return count;
  }
  if (spec.source === 'command-map-count') {
    // FT-g: count the registered verbs of a CLI dispatch table — the
    // AUTHORITATIVE verb count — by parsing the `commands = { ... }` object
    // literal rather than the `function cmd*` definitions. The two diverge the
    // moment a cmd* function exists that isn't wired into the map (a private
    // helper, a renamed-but-not-deleted handler) or a verb is registered as an
    // alias to a shared handler (e.g. several verify-* verbs mapping to one
    // function). The dispatch map is the contract operators reach via `swarm
    // <verb>`; the function list is an implementation detail. Counting the map
    // is what makes the gate track the real surface.
    if (!spec.file) throw new Error('command-map-count resolver requires `file`');
    if (!spec.bindingName) throw new Error('command-map-count resolver requires `bindingName` (e.g. "commands")');
    const abs = resolve(repoRoot, spec.file);
    if (!existsSync(abs)) throw new Error(`source file not found: ${spec.file}`);
    const src = readFileSync(abs, 'utf8');
    return countCommandMapEntries(src, spec.bindingName, spec.file);
  }
  throw new Error(`unknown resolver source: '${spec.source}' (known: package-json-field, package-json-publishable, pattern-count, command-map-count)`);
}

/**
 * Count the top-level keys of a `const <bindingName> = { ... }` object literal
 * in a JS source string. Used by the `command-map-count` resolver to count the
 * registered verbs of a CLI dispatch table.
 *
 * Implementation: locate the binding, find the opening brace of its object
 * literal, then walk the source tracking brace/bracket/paren depth and
 * string/template/regex/comment state so nested objects, arrays, template
 * literals, and regex literals don't confuse the boundary. Keys are counted
 * as the identifiers/string-literals that sit at depth 1 immediately before
 * a `:`. A trailing comma produces no phantom key because we only count a
 * key when a `:` follows it at depth 1.
 *
 * This is deliberately a small purpose-built scanner rather than a full JS
 * parser: pulling acorn/espree into a CI doc-gate would be a heavyweight dep
 * for one resolver, and the dispatch-table shape we parse is constrained
 * (a flat map of verb → handler). If the map ever grows computed keys or
 * spread elements the scanner throws, which surfaces as a config-error rather
 * than a silently-wrong count. F-6cfe4d01: a regex-literal VALUE (e.g.
 * `b: /a:b/`) is skipped as one atomic unit rather than re-tokenized char by
 * char — without that, an internal `:` reads as a phantom key confirmation
 * (an overcount) and any bracket the pattern contains (e.g. `/a{2,3}/`)
 * would corrupt the depth counter this function's own boundary-finding
 * depends on.
 *
 * @param {string} src         - JS source
 * @param {string} bindingName - e.g. 'commands'
 * @param {string} fileLabel   - for error messages
 * @returns {number} number of keys at depth 1
 */
export function countCommandMapEntries(src, bindingName, fileLabel) {
  const bindingRe = new RegExp(
    `(?:const|let|var)\\s+${escapeRegex(bindingName)}\\s*=\\s*\\{`,
  );
  const m = bindingRe.exec(src);
  if (!m) {
    throw new Error(
      `command-map-count: binding '${bindingName} = {' not found in ${fileLabel}`,
    );
  }
  // Start scanning just after the opening brace of the object literal.
  let i = m.index + m[0].length;
  let depth = 1; // we're inside the object literal
  let keyCount = 0;
  let pendingKeyAtTopLevel = false; // saw a key token at depth 1, awaiting ':'
  // F-1ca7b818: true when the scanner is in KEY position (map start / after a
  // depth-1 comma), false once this entry's key has been consumed by a ':'.
  // Discriminates a method-shorthand KEY (`verb(args) {}` — unsupported,
  // throw) from a call expression in VALUE position (`verb: wrap(cmdA)` —
  // fine), which are both "identifier followed by '('" at depth 1.
  let awaitingKey = true;
  const n = src.length;

  while (i < n && depth > 0) {
    const c = src[i];
    const c2 = src[i + 1];

    // Skip line comments.
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    // Skip block comments.
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Skip string / template literals wholesale. A string at depth 1 that is
    // immediately followed (after optional whitespace) by ':' is a quoted key
    // (e.g. 'verify-fixed': cmdVerifyFixed) — mark it pending.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i += 2;
        else i++;
      }
      i++; // past closing quote
      if (depth === 1) pendingKeyAtTopLevel = true;
      continue;
    }
    // F-6cfe4d01: skip regex literals wholesale, mirroring the string/
    // template skip above. A bare '/' here is never division — line/block
    // comments were already consumed above, and the constrained flat
    // verb->handler shape this resolver supports never puts an arithmetic
    // expression in value position, so a stray '/' can only be a regex
    // literal (e.g. `b: /a:b/`). A character class (`[...]`) is tracked
    // separately because an unescaped '/' inside one does not terminate the
    // literal (e.g. `/[a/b]/`). Never a key, so — unlike the string/template
    // skip above — this never sets pendingKeyAtTopLevel.
    if (c === '/') {
      i++;
      let inClass = false;
      while (i < n && (inClass || src[i] !== '/')) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i++;
      }
      i++; // past closing '/' (or past end-of-source if unterminated)
      while (i < n && /[a-z]/i.test(src[i])) i++; // regex flags (g, i, m, ...)
      continue;
    }

    // F-6cfe4d01: a computed key (`[expr]:`) at the top level of the object
    // literal is outside the constrained shape this resolver supports — fail
    // loud, mirroring the ternary/spread/method-shorthand checks below. Must
    // run before the generic '[' depth++ immediately after, and is gated on
    // awaitingKey (KEY position) so a VALUE-position array literal (e.g.
    // `verb: [1, 2, 3]`) still falls through to the generic bracket handler
    // unaffected — pre-fix, the '[' there bumped depth first regardless of
    // position, so the computed key's contents were swallowed into a nested
    // "value" and silently vanished from the count instead of throwing.
    if (c === '[' && depth === 1 && awaitingKey) {
      throw new Error(
        `command-map-count: computed key ('[expr]:') in '${bindingName}' object literal in ${fileLabel} — the resolver only supports a flat verb→handler map (its bracket contents would be swallowed as a nested value, silently vanishing from the count)`,
      );
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth--;
      i++;
      continue;
    }

    if (depth === 1) {
      if (c === ':') {
        // A ':' at depth 1 confirms the most recent key token. Guard against
        // counting a stray ':' with no preceding key (shouldn't happen in a
        // well-formed map, but stays defensive).
        if (pendingKeyAtTopLevel) {
          keyCount++;
          pendingKeyAtTopLevel = false;
        }
        awaitingKey = false;
        i++;
        continue;
      }
      if (c === ',') {
        // Reset between entries. A trailing comma before `}` leaves no pending
        // key, so it contributes nothing.
        pendingKeyAtTopLevel = false;
        awaitingKey = true;
        i++;
        continue;
      }
      // F-1ca7b818: a '?' at depth 1 is a ternary (or optional-chaining /
      // nullish) in value position — outside the flat verb→handler shape.
      // Pre-fix, `verb: cond ? h1 : h2` minted a PHANTOM second key: the
      // ternary's ':' followed an identifier that had set
      // pendingKeyAtTopLevel. Fail loud (config-error) instead of counting
      // silently wrong — the doc-comment above promises exactly that.
      if (c === '?') {
        throw new Error(
          `command-map-count: unsupported ternary/'?' expression at the top level of '${bindingName}' object literal in ${fileLabel} — the resolver only supports a flat verb→handler map (its ':' would be miscounted as a key)`,
        );
      }
      // An identifier-start at depth 1 begins an unquoted key (e.g. `init:`).
      if (/[A-Za-z_$]/.test(c)) {
        // Consume the whole identifier so we don't mark every char pending.
        i++;
        while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++;
        // F-1ca7b818: a KEY-position identifier directly followed by '(' is a
        // method-shorthand entry (`verb(args) { ... }`) — no depth-1 ':' ever
        // confirms it, so pre-fix it was silently NOT counted and the R9
        // verb-count claims drifted with a misleading total. Fail loud.
        if (awaitingKey) {
          let j = i;
          while (j < n && /\s/.test(src[j])) j++;
          if (src[j] === '(') {
            throw new Error(
              `command-map-count: method-shorthand entry at the top level of '${bindingName}' object literal in ${fileLabel} — the resolver only supports a flat verb→handler map (write 'verb: handler' instead of 'verb() {}')`,
            );
          }
        }
        pendingKeyAtTopLevel = true;
        continue;
      }
      // A spread element (`...x`) or computed key (`[expr]:`) is outside the
      // constrained shape this resolver supports — fail loud.
      if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
        throw new Error(
          `command-map-count: spread element in '${bindingName}' object literal in ${fileLabel} — the resolver only supports a flat verb→handler map`,
        );
      }
    }
    i++;
  }

  if (depth !== 0) {
    throw new Error(
      `command-map-count: unbalanced braces while scanning '${bindingName}' object literal in ${fileLabel}`,
    );
  }
  return keyCount;
}

const HANDLERS = {
  [sourceVsTargetCoverageHandler.kind]: sourceVsTargetCoverageHandler,
  [forbiddenPatternInTargetsHandler.kind]: forbiddenPatternInTargetsHandler,
  [selfConsistencyHandler.kind]: selfConsistencyHandler,
  [untaggedFenceHandler.kind]: untaggedFenceHandler,
  [helperAdoptionSweepHandler.kind]: helperAdoptionSweepHandler,
  [schemaConformanceHandler.kind]: schemaConformanceHandler,
  [frameworkSelfTestHandler.kind]: frameworkSelfTestHandler,
  [sourceOfTruthCrossRefHandler.kind]: sourceOfTruthCrossRefHandler,
};

// Exposed for tests + meta-introspection. Keep the export surface read-only —
// callers that mutate this break the framework-self-test invariant.
export const REGISTERED_HANDLERS = HANDLERS;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function readTargetCorpus(targets, repoRoot) {
  const files = expandGlobs(targets, repoRoot);
  if (files.length === 0) {
    return { error: `[check-doc-drift] no target files matched: ${targets.join(', ')}` };
  }
  const parts = files.map((f) => readFileSync(f, 'utf8'));
  return { text: parts.join('\n\n'), files };
}

/**
 * Glob expansion supporting:
 *   - exact paths               ('docs/policy-contract.md')
 *   - single-segment '*'        ('site/src/content/docs/handbook/*.md')
 *   - multi-segment '*' globs   ('swarms/swarm-*\/wave-*\/*.json')
 *   - doublestar '**' (when opts.recursive === true)
 *                               ('packages/**\/*.js')
 *
 * The recursive ('**') mode is restricted to opt-in callers (helper-adoption-
 * sweep, schema-conformance) so the behaviour of original handlers stays
 * unchanged. Multi-segment '*' is always supported.
 */
export function expandGlobs(patterns, repoRoot, opts = {}) {
  const out = [];
  for (const pattern of patterns) {
    const abs = resolve(repoRoot, pattern);
    // Plain file?
    if (!pattern.includes('*') && existsSync(abs)) {
      out.push(abs);
      continue;
    }
    if (pattern.includes('**') && opts.recursive) {
      // Walk-then-match strategy. Root = the longest leading non-glob segment.
      const idx = pattern.indexOf('*');
      const lastSlash = pattern.lastIndexOf('/', idx);
      const rootRel = lastSlash === -1 ? '.' : pattern.slice(0, lastSlash);
      const rootAbs = resolve(repoRoot, rootRel);
      if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) continue;
      const fileRe = doublestarToRegex(pattern);
      for (const file of walkDir(rootAbs)) {
        const relPath = relative(repoRoot, file).replace(/\\/g, '/');
        if (fileRe.test(relPath)) out.push(file);
      }
      continue;
    }
    // F-ae195c1d: `**` without opts.recursive would fall through to the
    // segmented expander, where globToRegex degrades `**` to a single-segment
    // wildcard — a config author who widens a check with a doublestar glob
    // would see green while only ONE directory level is actually gated.
    // Fail loud instead; runDriftChecks converts the throw to a config-error.
    if (pattern.includes('**')) {
      throw new Error(
        `glob '${pattern}' uses '**' but this check kind does not enable recursive expansion — it would silently match a single directory level. Use single-star segments, or a handler kind that opts into recursive globs (helper-adoption-sweep, schema-conformance).`,
      );
    }
    if (pattern.includes('*')) {
      // Walk file segments, expanding each level. This handles the simple
      // "single * per segment" case across multiple segments (no doublestar).
      for (const file of expandSegmentedGlob(pattern, repoRoot)) {
        out.push(file);
      }
    }
  }
  return [...new Set(out)].sort();
}

function expandSegmentedGlob(pattern, repoRoot) {
  const segments = pattern.split('/');
  // Expand level-by-level, accumulating directories until we hit the file
  // segment.
  let dirs = [resolve(repoRoot, '.')];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const next = [];
    if (!seg.includes('*')) {
      for (const d of dirs) {
        const candidate = join(d, seg);
        if (existsSync(candidate)) {
          if (isLast) {
            if (statSync(candidate).isFile()) next.push(candidate);
          } else if (statSync(candidate).isDirectory()) {
            next.push(candidate);
          }
        }
      }
    } else {
      const segRe = globToRegex(seg);
      for (const d of dirs) {
        let entries;
        try { entries = readdirSync(d); } catch { continue; }
        for (const entry of entries) {
          if (!segRe.test(entry)) continue;
          const candidate = join(d, entry);
          let st;
          try { st = statSync(candidate); } catch { continue; }
          if (isLast) {
            if (st.isFile()) next.push(candidate);
          } else if (st.isDirectory()) {
            next.push(candidate);
          }
        }
      }
    }
    dirs = next;
    if (dirs.length === 0) break;
  }
  return dirs;
}

function walkDir(root) {
  const out = [];
  const skip = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.cache', '__test_root__']);
  function visit(dir) {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) visit(full);
      else if (st.isFile()) out.push(full);
    }
  }
  visit(root);
  return out;
}

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/**
 * Translate a glob with '**' into a regex that matches a relative posix path.
 * '**' = any number of path segments (including zero).
 * '*'  = any chars within a single segment.
 */
function doublestarToRegex(glob) {
  // First mark `**/` as a placeholder to expand later.
  const SENTINEL_DOUBLE = '\0DBL\0';
  const SENTINEL_SINGLE = '\0SGL\0';
  const SENTINEL_TRAIL = '\0TRL\0';
  // F-ae195c1d: a TRAILING `**` means "everything under this directory".
  // Routing it through the generic doublestar sentinel compiled `outputs/**`
  // to `^outputs/(?:.*/)?$`, which requires the match to END at a slash
  // boundary — relative file paths never end with '/', so the glob matched
  // ZERO files and silently degraded the gate to nothing. Map it to
  // `(?:/.*)?` anchored after the directory name instead: `^outputs(?:/.*)?$`.
  let pattern = glob.replace(/\/\*\*$/, SENTINEL_TRAIL);
  pattern = pattern.replace(/\*\*\//g, SENTINEL_DOUBLE).replace(/\*\*/g, SENTINEL_DOUBLE);
  pattern = pattern.replace(/\*/g, SENTINEL_SINGLE);
  pattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  pattern = pattern.replace(new RegExp(SENTINEL_TRAIL, 'g'), '(?:/.*)?');
  pattern = pattern.replace(new RegExp(SENTINEL_DOUBLE, 'g'), '(?:.*/)?');
  pattern = pattern.replace(new RegExp(SENTINEL_SINGLE, 'g'), '[^/]*');
  return new RegExp(`^${pattern}$`);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strip line comments, block comments, and string literals from a JS source.
 * Used by helper-adoption-sweep so a forbidden-pattern hit inside a comment or
 * docstring (e.g. atomic-write.js's own "fs.writeFileSync" reference in a
 * doc comment) doesn't trip the gate. Conservative: a few false negatives
 * (template literals containing the pattern) are acceptable; false positives
 * on docstrings would be very noisy.
 */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i += 2;
        else i++;
      }
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Tiny structural JSON-Schema validator used as a fallback when Ajv is not
 * installable in the current environment. Honors:
 *   - top-level type
 *   - required[] at top level and in $defs.<name>
 *   - basic type checks for declared properties
 *   - enum + minLength + pattern at the leaf level
 *
 * Not a substitute for full JSON Schema. The framework prefers Ajv when
 * available (which is always, in this repo) — this keeps the handler
 * functional in dep-light fixtures.
 */
function makeStructuralValidator(schema) {
  function validate(value) {
    const errors = [];
    walkValue('', value, schema, errors);
    validate.errors = errors;
    return errors.length === 0;
  }
  function walkValue(path, value, sch, errors) {
    if (sch.$ref) {
      const ref = sch.$ref.replace(/^#\//, '').split('/');
      let resolved = schema;
      for (const part of ref) resolved = resolved?.[part];
      if (!resolved) return;
      walkValue(path, value, resolved, errors);
      return;
    }
    if (sch.type === 'object' || (sch.required && typeof value === 'object')) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors.push({ instancePath: path, message: 'must be object' });
        return;
      }
      for (const key of sch.required ?? []) {
        if (!(key in value)) errors.push({ instancePath: `${path}/${key}`, message: 'is required' });
      }
      for (const [key, val] of Object.entries(value)) {
        const propSch = sch.properties?.[key];
        if (propSch) walkValue(`${path}/${key}`, val, propSch, errors);
      }
    } else if (sch.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push({ instancePath: path, message: 'must be array' });
        return;
      }
      if (sch.items) {
        for (let i = 0; i < value.length; i++) walkValue(`${path}/${i}`, value[i], sch.items, errors);
      }
    } else if (sch.type === 'string') {
      if (typeof value !== 'string') {
        errors.push({ instancePath: path, message: 'must be string' });
        return;
      }
      if (sch.enum && !sch.enum.includes(value)) {
        errors.push({ instancePath: path, message: `must be one of ${sch.enum.join(', ')}` });
      }
      if (sch.minLength != null && value.length < sch.minLength) {
        errors.push({ instancePath: path, message: `must be at least ${sch.minLength} chars` });
      }
      if (sch.pattern && !new RegExp(sch.pattern).test(value)) {
        errors.push({ instancePath: path, message: `must match pattern ${sch.pattern}` });
      }
    }
  }
  return validate;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the `--check <id>` selector from a raw argv slice.
 *
 * Returns `{ checkId }` on success or `{ error }` when `--check` was passed
 * without a usable value. A bare `--check` (last token) or one immediately
 * followed by another flag silently ran ALL checks before this guard existed —
 * an operator who fat-fingers the id gets a full green run and assumes their
 * single check passed. The sibling check-finding-regression-pins.mjs already
 * validates its value-taking flags (`--write-index requires a path argument`);
 * this brings --check to the same standard.
 */
export function parseCheckId(args) {
  const checkIdx = args.indexOf('--check');
  if (checkIdx === -1) return { checkId: undefined };
  const value = args[checkIdx + 1];
  if (value === undefined || value.startsWith('--')) {
    return { error: 'error: --check requires a check id' };
  }
  return { checkId: value };
}

/**
 * Resolve the `--config <path>` override from a raw argv slice.
 *
 * Returns `{ configPath }` (undefined when the flag is absent, so the default
 * scripts/doc-drift-patterns.json applies) or `{ error }` when `--config` was
 * passed without a usable value. The config-not-found hint promises this flag;
 * without a parser the promise was dead — an operator whose config lived
 * elsewhere read the hint, passed --config, and had it silently ignored.
 */
export function parseConfigPath(args) {
  const idx = args.indexOf('--config');
  if (idx === -1) return { configPath: undefined };
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    return { error: 'error: --config requires a path' };
  }
  return { configPath: value };
}

/**
 * Parse the whole recognized flag set, rejecting anything unknown.
 *
 * The sibling gate check-finding-regression-pins.mjs throws on the first
 * unrecognized token; before this, doc-drift dropped unknown flags silently,
 * so a fat-fingered `--josn` for `--json` ran a full green/red drift pass with
 * no signal the flag was wrong. This brings doc-drift to the same fail-loud
 * standard. `--check <id>` and `--config <path>` each consume the following
 * token; a bare positional or unrecognized `--flag` is an error.
 */
export function parseCliArgs(args) {
  const known = new Set(['--json', '--check', '--config', '-h', '--help']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check' || a === '--config') {
      i++;
      continue;
    }
    if (!known.has(a)) {
      return { error: `error: unknown argument '${a}' (see --help)` };
    }
  }
  const help = args.includes('-h') || args.includes('--help');
  const json = args.includes('--json');
  const { checkId, error: checkError } = parseCheckId(args);
  if (checkError) return { error: checkError };
  const { configPath, error: configError } = parseConfigPath(args);
  if (configError) return { error: configError };
  return { help, json, checkId, configPath };
}

export function printHelp() {
  process.stdout.write(`Usage: node scripts/check-doc-drift.mjs [options]

Source-of-truth <-> documentation cross-reference drift gate. Reads a config of
checks (each a source/target pair) and reports where a doc has drifted from the
code, config, or handbook it claims to mirror. Wired into \`npm run verify\` and
ci.yml.

Options:
  --json              machine-readable JSON output (clean flag + reports[])
  --check <id>        run a single check by its config id instead of all
  --config <path>     use a config file other than the default
                      (default: scripts/doc-drift-patterns.json)
  -h, --help          this message

Exit codes: 0 (no drift) | 1 (drift found) | 2 (config error / bad arguments)
`);
}

// F-W1-CI-005: previous heuristic compared `resolve(fileURLToPath(import.meta.url))`
// to `resolve(process.argv[1])`. That mostly works but is the same fragile
// path-string class apply-finding-migration.mjs already fixed in W31-BACK-001:
// on Windows the two strings can disagree on drive-letter casing or 8.3 vs
// long-name resolution and the entry block silently no-ops. The canonical
// Node cross-platform pattern is `pathToFileURL(process.argv[1]).href` —
// import.meta.url is always POSIX/URL form, so URL-vs-URL comparison is
// reliable everywhere.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, '..');

  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.error) {
    console.error(cli.error);
    process.exit(2);
  }
  if (cli.help) {
    printHelp();
    process.exit(0);
  }
  const { json, checkId, configPath } = cli;

  runDriftChecks({ repoRoot, checkId, configPath })
    .then((result) => {
      // F-a80acc6d: hoisted above the print so BOTH the header text and the
      // exit code read the same two booleans (previously computed AFTER the
      // print, so the header text was a hardcoded literal instead of a
      // reflection of what's actually in `reports`). Prior behavior labeled
      // every non-clean result 'DRIFT', even when every report was a
      // config-error — mislabeling a broken CHECK (gating nothing) as a
      // content problem (docs disagree with source). Those mean opposite
      // things to an operator scanning a CI log first-line: 'drift' says
      // update a doc; 'config-error' says fix the check itself.
      const hasConfigError = result.reports.some((r) => r.severity === 'config-error');
      const hasDrift = result.reports.some((r) => r.severity === 'drift');
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const verb = checkId ? `check '${checkId}'` : `${result.checksRun} check(s)`;
        if (result.clean) {
          console.log(`[check-doc-drift] OK — ${verb} passed.`);
        } else {
          const kinds = [hasConfigError && 'CONFIG-ERROR', hasDrift && 'DRIFT'].filter(Boolean).join(' + ');
          console.error(`[check-doc-drift] ${kinds} — ${result.reports.length} report(s) from ${verb}:\n`);
          for (const r of result.reports) {
            console.error(`  ${r.severity.toUpperCase()}: ${r.message}`);
            if (r.missing && r.missing.length) {
              console.error(`    missing: ${r.missing.join(', ')}`);
            }
            if (r.hint) {
              console.error(`    hint: ${r.hint}`);
            }
            console.error('');
          }
        }
      }
      // Fail closed on an unrecognized severity: only 'drift' and
      // 'config-error' are emitted today, but a report of any OTHER
      // severity should still red the run rather than silently exit 0.
      process.exit(hasConfigError ? 2 : result.reports.length > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error(`[check-doc-drift] fatal: ${err.message}`);
      process.exit(2);
    });
}
