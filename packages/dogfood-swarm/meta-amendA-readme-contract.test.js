/**
 * meta-amendA-readme-contract.test.js — README → CLI contract guard.
 *
 * td-006 (Wave-1 amend-A, tests-docs domain). The package already has a
 * doc-drift discipline (wave10-docs-identity-drift.test.js pins schema.js
 * STATUS.run to dispatch.js phase lists; scripts/check-doc-drift.mjs pins
 * error-code + STATUS strings to the handbook and the cmd-handler COUNT to
 * SHIP_GATE.md), but NONE of it pinned README.md's documented `swarm <cmd>`
 * examples to cli.js's actual routing. That hole let td-001..td-005 drift
 * undetected through ~28 audit waves: an operator copying the Quick start
 * hit a precondition failure on the first command.
 *
 * This test closes the hole. It reads the REAL cli.js `commands` map (it does
 * NOT hardcode the command list — same source-of-truth extraction used at
 * wave10-docs-identity-drift.test.js:215-238) and asserts:
 *
 *   (a) every `swarm <cmd>` invocation fenced in README.md names a command
 *       that exists in cli.js's `commands` map;
 *   (b) the README's required-flag contracts hold — the `collect` and
 *       `revalidate` examples carry `--domain=`, and `dispatch` uses a named
 *       `<phase>` placeholder rather than a bare wave number;
 *   (c) the README's "Requires Node ≥ N" string equals package.json
 *       `engines.node`'s floor.
 *   (d) every operator-facing environment variable the package READS
 *       (`process.env.<NAME>` in non-test source) is documented in the README.
 *
 * If a future edit reintroduces a wrong example (a renamed command, a dropped
 * required flag, a `<wave-number>` placeholder, a stale Node floor) — or adds /
 * renames an env var without documenting it — this test fails at that edit
 * instead of in an operator's terminal.
 *
 * td-p-005 (Wave-3 amend-C, tests-docs domain) added (d): the original td-006
 * guard pinned the COMMAND surface only, so an undocumented env var (the exact
 * gap found in this Stage-B/C pass — `DOGFOOD_LOG_HUMAN`, `SWARM_DB`) could
 * silently rot the README. (d) closes that hole with the same read-the-real-
 * source discipline as (a): it extracts the env-var literals from source rather
 * than hardcoding them, so a new operator-facing var cannot drift undocumented.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PKG_DIR = dirname(fileURLToPath(import.meta.url));

const README = readFileSync(new URL('./README.md', import.meta.url), 'utf-8');
const CLI_SRC = readFileSync(new URL('./cli.js', import.meta.url), 'utf-8');
const PKG = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
);

/**
 * Extract the command names registered in cli.js's `commands` map — the
 * single source of truth for what the `swarm` binary actually routes. We read
 * the source rather than importing it because cli.js runs its dispatch block
 * at module top-level (it is a bin entry, not a library); a regex over the map
 * body is the strict-safe extraction, mirroring the AUDIT_PHASES/AMEND_PHASES
 * approach in wave10-docs-identity-drift.test.js.
 *
 * Map entries take two shapes:
 *   init: cmdInit,              (bareword key)
 *   'verify-fixed': cmdVerifyFixed,  (quoted key — contains a hyphen)
 */
function extractCliCommands(src) {
  const mapMatch = src.match(/const commands\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(mapMatch, 'cli.js must define a `const commands = { ... };` map');
  const body = mapMatch[1];

  const names = new Set();
  const keyRe = /(?:^|,)\s*(?:'([a-z][a-z0-9-]*)'|([a-z][a-z0-9-]*))\s*:/gm;
  let m;
  while ((m = keyRe.exec(body)) !== null) {
    names.add(m[1] ?? m[2]);
  }
  assert.ok(names.size >= 10, `expected to extract the full command map; got ${names.size}: ${[...names].join(', ')}`);
  return names;
}

/**
 * Pull every fenced ```bash``` block out of the README. We deliberately scope
 * the contract to fenced code (the copy-paste surface an operator actually
 * runs); inline mentions of `swarm domains --unfreeze` inside prose bullets
 * are guidance, not runnable examples, and are out of scope.
 */
function fencedBashBlocks(md) {
  const blocks = [];
  const re = /```bash\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) blocks.push(m[1]);
  return blocks;
}

/**
 * From the fenced blocks, return the list of `swarm <cmd> ...` invocations as
 * { command, line } records. A line is an invocation iff its first token is
 * `swarm`; flag-continuation lines (starting with `--`) and comment lines
 * (starting with `#`) are not invocations and are skipped.
 */
function readmeInvocations(md) {
  const out = [];
  for (const block of fencedBashBlocks(md)) {
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('swarm ')) continue;
      const tokens = line.split(/\s+/);
      out.push({ command: tokens[1], line });
    }
  }
  return out;
}

describe('README → CLI contract (td-006)', () => {
  it('extracts a sane command map and a usable set of README invocations', () => {
    const commands = extractCliCommands(CLI_SRC);
    // Spot-check a few known commands so a broken extractor (empty/garbled
    // Set) can never make the existence assertion vacuously pass.
    for (const expected of ['init', 'domains', 'dispatch', 'collect', 'revalidate', 'verify-fixed']) {
      assert.ok(commands.has(expected),
        `extractor missed cli.js command "${expected}" — extraction regex is wrong`);
    }

    const invocations = readmeInvocations(README);
    assert.ok(invocations.length >= 8,
      `expected the README to document several swarm invocations; found ${invocations.length}`);
  });

  it('(a) every documented `swarm <cmd>` exists in cli.js commands map', () => {
    const commands = extractCliCommands(CLI_SRC);
    const invocations = readmeInvocations(README);

    for (const { command, line } of invocations) {
      assert.ok(
        commands.has(command),
        `README documents \`swarm ${command}\` but cli.js has no such command. ` +
        `Line: "${line}". Valid commands: ${[...commands].sort().join(', ')}`
      );
    }
  });

  it('(b) collect / revalidate examples carry the required --domain= flag', () => {
    // Both cmdCollect (cli.js: "No outputs provided. Use --domain=name:path")
    // and cmdRevalidate (cli.js: "at least one --domain=name:path is required")
    // exit 1 without at least one --domain pair. Every fenced example that
    // invokes them must therefore include one, possibly on a continuation line.
    for (const cmd of ['collect', 'revalidate']) {
      const examples = exampleInvocationsFor(cmd);
      assert.ok(examples.length > 0,
        `expected at least one fenced \`swarm ${cmd}\` example in the README`);
      for (const ex of examples) {
        assert.match(
          ex,
          /--domain=[^:\s]+:[^\s]+/,
          `README \`swarm ${cmd}\` example must include a --domain=name:path pair ` +
          `(the CLI exits 1 without one). Got:\n${ex}`
        );
      }
    }
  });

  it('(b) dispatch examples use a named <phase>, never a bare wave number', () => {
    // cmdDispatch takes <run-id> <phase> where phase is a NAMED phase string
    // (AUDIT_PHASES/AMEND_PHASES). A wave number silently falls through to the
    // generic fallback and writes a bogus runs.status. The documented example
    // must use the <phase> placeholder or a real named phase — not <wave-number>
    // and not a literal integer in the phase slot.
    const examples = exampleInvocationsFor('dispatch');
    assert.ok(examples.length > 0,
      'expected at least one fenced `swarm dispatch` example in the README');

    const VALID_PHASES = phasesFromDispatchSource();

    for (const ex of examples) {
      // tokens: [swarm, dispatch, <run-id>, <phase>, ...flags]
      const phaseTok = ex.split(/\s+/)[3];
      assert.ok(phaseTok, `dispatch example is missing its phase argument: "${ex}"`);
      assert.ok(
        !/wave[-_]?number/i.test(phaseTok),
        `README \`swarm dispatch\` example uses a wave-number placeholder ("${phaseTok}"); ` +
        `the argument is a NAMED <phase>. Use <phase> or a real phase name.`
      );
      assert.ok(
        !/^\d+$/.test(phaseTok),
        `README \`swarm dispatch\` example uses a bare wave number ("${phaseTok}") in the ` +
        `phase slot; dispatch requires a named phase (${[...VALID_PHASES].join(', ')}).`
      );
      const isPlaceholder = phaseTok === '<phase>';
      assert.ok(
        isPlaceholder || VALID_PHASES.has(phaseTok),
        `README \`swarm dispatch\` phase "${phaseTok}" is neither the <phase> placeholder ` +
        `nor a real phase name (${[...VALID_PHASES].join(', ')}).`
      );
    }
  });

  it('(b) the README lists the real named phases (kept in sync with dispatch.js)', () => {
    // The Quick start tells the operator `<phase>` is a named phase and lists
    // the values. Pin that list to dispatch.js so a future phase rename can't
    // leave the README advertising a phase the CLI rejects.
    const phases = phasesFromDispatchSource();
    for (const phase of phases) {
      assert.ok(
        README.includes(phase),
        `README must list the valid phase "${phase}" so operators can copy it ` +
        `(it is in dispatch.js AUDIT_PHASES/AMEND_PHASES).`
      );
    }
  });

  it('(c) "Requires Node ≥ N" matches package.json engines.node floor', () => {
    const engines = PKG.engines?.node;
    assert.ok(engines, 'package.json must declare engines.node');

    const floorMatch = engines.match(/(\d+)/);
    assert.ok(floorMatch, `could not parse a major-version floor from engines.node "${engines}"`);
    const floor = floorMatch[1];

    const readmeMatch = README.match(/Requires Node\s+[≥>]=?\s*(\d+)/);
    assert.ok(readmeMatch,
      'README must state the Node floor as "Requires Node ≥ N" so the install prose ' +
      'has a single source of truth with engines.node');
    assert.equal(
      readmeMatch[1],
      floor,
      `README says Node ≥ ${readmeMatch[1]} but package.json engines.node is "${engines}" ` +
      `(floor ${floor}). The prose must follow the engines field.`
    );
  });

  it('(d) every operator-facing env var the package reads is documented in the README', () => {
    const vars = envVarsReadInSource();
    // Spot-check so a broken extractor (empty Set) can't make this vacuously
    // pass: these three are read in non-test source today and are the surface
    // td-p-002 documented.
    for (const expected of ['SWARM_DB', 'DOGFOOD_FINDINGS_FORMAT', 'DOGFOOD_LOG_HUMAN']) {
      assert.ok(vars.has(expected),
        `extractor missed \`process.env.${expected}\` — the env-var extraction is wrong`);
    }

    for (const name of vars) {
      assert.ok(
        README.includes(name),
        `the package reads \`process.env.${name}\` but README.md never documents it. ` +
        `Add it to the "Environment variables" section (or remove the read). ` +
        `Documented-or-removed is the contract — an operator scripting against ` +
        `\`${name}\` must be able to learn it from the README.`
      );
    }
  });
});

// ── helpers that read the real sources (no duplicated literals) ──

/**
 * Return every fenced README line that invokes `swarm <cmd>`, JOINED with its
 * immediately-following continuation lines (lines starting with `--` or that
 * end a shell line-continuation `\`), so a multi-line example like
 *
 *   swarm collect <run-id> \
 *     --domain=backend:.../output.json
 *
 * is reassembled into one logical invocation before flag assertions run.
 */
function exampleInvocationsFor(cmd) {
  const out = [];
  for (const block of fencedBashBlocks(README)) {
    const lines = block.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith(`swarm ${cmd} `) && line !== `swarm ${cmd}`) continue;

      let joined = line.replace(/\\$/, '').trim();
      let j = i;
      // Absorb continuation lines: either the prior line ended with `\`, or the
      // next line is a flag fragment (`--...`). Stop at a blank line, a comment,
      // or the next `swarm` invocation.
      while (j + 1 < lines.length) {
        const prev = lines[j].trim();
        const next = lines[j + 1].trim();
        const prevContinues = prev.endsWith('\\');
        const nextIsFlag = next.startsWith('--');
        if (!prevContinues && !nextIsFlag) break;
        if (next === '' || next.startsWith('#') || next.startsWith('swarm ')) break;
        joined += ' ' + next.replace(/\\$/, '').trim();
        j++;
      }
      out.push(joined.trim());
    }
  }
  return out;
}

/**
 * Extract AUDIT_PHASES + AMEND_PHASES from lib/phases.js source — the
 * authoritative phase vocabulary. As of the wave-10 refactor the phase lists
 * live in the shared lib/phases.js (dispatch.js and every render site import
 * them from there); this reads that single source of truth. Same regex-over-
 * source approach as wave10-docs-identity-drift.test.js.
 */
function phasesFromDispatchSource() {
  const src = readFileSync(
    new URL('./lib/phases.js', import.meta.url),
    'utf-8'
  );
  const auditMatch = src.match(/const AUDIT_PHASES\s*=\s*\[([^\]]+)\]/);
  const amendMatch = src.match(/const AMEND_PHASES\s*=\s*\[([^\]]+)\]/);
  assert.ok(auditMatch && amendMatch,
    'lib/phases.js must define AUDIT_PHASES and AMEND_PHASES');
  const parse = (s) => s.split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return new Set([...parse(auditMatch[1]), ...parse(amendMatch[1])]);
}

/**
 * Walk the package's NON-TEST `.js` source and return the set of environment
 * variables it READS — i.e. every `process.env.<NAME>` property access. This
 * is the operator-facing env-var contract: a var the code reads is one an
 * operator can set to change behavior, so it must be documented.
 *
 * Read-the-real-source discipline (mirrors extractCliCommands / phasesFrom-
 * DispatchSource): the list is extracted from source, never hardcoded, so a
 * future contributor who adds `process.env.NEW_VAR` cannot leave the README
 * behind without this test catching it.
 *
 * Scope decisions:
 *  - Test files (`*.test.js` / `*.test.mjs`) are excluded — they set/read env
 *    vars for fixture setup, which is not the production read surface.
 *  - `node_modules`, `dist`, and dotfiles/dotdirs are skipped.
 *  - Only the `process.env.UPPER_SNAKE` access form is matched (the config
 *    surface). `process.env` spreads (e.g. `{ ...process.env, FORCE_COLOR }`
 *    in runner.js, which SETS rather than reads a config var) are correctly
 *    not captured by the property-access regex.
 */
function envVarsReadInSource() {
  const names = new Set();
  const re = /process\.env\.([A-Z][A-Z0-9_]+)/g;

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.js')) continue;
      if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.mjs')) continue;

      const src = readFileSync(full, 'utf-8');
      let m;
      while ((m = re.exec(src)) !== null) names.add(m[1]);
    }
  };

  walk(PKG_DIR);
  assert.ok(names.size >= 3,
    `expected to extract the operator-facing env vars from source; got ${names.size}: ${[...names].join(', ')}`);
  return names;
}

// Touch fileURLToPath so an unused-import lint never trips; harmless no-op that
// also documents that all source reads here are path-relative to this test file.
void fileURLToPath;
