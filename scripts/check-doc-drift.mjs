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

  const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
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
      lines.forEach((line, idx) => {
        const m = /^```(.*)$/.exec(line);
        if (!m) return;
        if (!inFence) {
          const info = m[1].trim();
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
        } else {
          inFence = false;
        }
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
 */
const schemaConformanceHandler = {
  kind: 'schema-conformance',
  description: 'Target JSON files validate against the configured JSON Schema.',
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

    // Ajv is an optional dep — fall back to a structural check if it's not
    // installable in this context. The structural check matches required[]
    // and type for top-level properties; it's less thorough but keeps the
    // gate functional in minimum-dep environments.
    let validate;
    try {
      const Ajv2020Mod = await import('ajv/dist/2020.js');
      const Ajv2020 = Ajv2020Mod.default ?? Ajv2020Mod;
      const addFormatsMod = await import('ajv-formats').catch(() => null);
      const addFormats = addFormatsMod?.default ?? addFormatsMod;
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      if (addFormats) addFormats(ajv);
      validate = ajv.compile(schema);
    } catch {
      validate = makeStructuralValidator(schema);
    }

    const targetFiles = expandGlobs(check.targets ?? [], repoRoot, { recursive: true });
    const allowlist = new Set((check.allowlist ?? []).map((p) => resolve(repoRoot, p)));
    const errorClass = check.errorClass ?? 'AgentOutputValidationError';

    if (targetFiles.length === 0 && !check.allowEmpty) {
      return [{
        checkId: check.id,
        severity: 'config-error',
        message: `[${check.id}] no target files matched: ${(check.targets ?? []).join(', ')}`,
        hint: 'Set "allowEmpty": true in the config if matching zero files is acceptable (e.g. early in a run before any agent output exists).',
      }];
    }

    const reports = [];
    for (const file of targetFiles) {
      if (allowlist.has(file)) continue;

      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err) {
        const rel = relative(repoRoot, file).replace(/\\/g, '/');
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
      if (!ok) {
        const rel = relative(repoRoot, file).replace(/\\/g, '/');
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
    const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
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

const HANDLERS = {
  [sourceVsTargetCoverageHandler.kind]: sourceVsTargetCoverageHandler,
  [forbiddenPatternInTargetsHandler.kind]: forbiddenPatternInTargetsHandler,
  [selfConsistencyHandler.kind]: selfConsistencyHandler,
  [untaggedFenceHandler.kind]: untaggedFenceHandler,
  [helperAdoptionSweepHandler.kind]: helperAdoptionSweepHandler,
  [schemaConformanceHandler.kind]: schemaConformanceHandler,
  [frameworkSelfTestHandler.kind]: frameworkSelfTestHandler,
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
  const SENTINEL_DOUBLE = ' DBL ';
  const SENTINEL_SINGLE = ' SGL ';
  let pattern = glob.replace(/\*\*\//g, SENTINEL_DOUBLE).replace(/\*\*/g, SENTINEL_DOUBLE);
  pattern = pattern.replace(/\*/g, SENTINEL_SINGLE);
  pattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
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

  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const checkIdx = args.indexOf('--check');
  const checkId = checkIdx !== -1 ? args[checkIdx + 1] : undefined;

  runDriftChecks({ repoRoot, checkId })
    .then((result) => {
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const verb = checkId ? `check '${checkId}'` : `${result.checksRun} check(s)`;
        if (result.clean) {
          console.log(`[check-doc-drift] OK — ${verb} passed.`);
        } else {
          console.error(`[check-doc-drift] DRIFT — ${result.reports.length} report(s) from ${verb}:\n`);
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
      const hasConfigError = result.reports.some((r) => r.severity === 'config-error');
      const hasDrift = result.reports.some((r) => r.severity === 'drift');
      process.exit(hasConfigError ? 2 : hasDrift ? 1 : 0);
    })
    .catch((err) => {
      console.error(`[check-doc-drift] fatal: ${err.message}`);
      process.exit(2);
    });
}
