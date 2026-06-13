/**
 * stageC-load-parse-error-context.test.ts — proves load() attaches filename
 * context when a package-bundled schema JSON fails to parse.
 *
 * d1-schemas-B002 (FINAL LOW, defensive) — src/index.ts load() did
 * readFileSync + JSON.parse with no try/catch and no error context. It runs
 * eight times at module-init (recordSchema..scenarioSchema top-level consts). If
 * a published tarball ships a corrupted or truncated src/json/*.schema.json (the
 * `files` array publishes src/json verbatim), the import throws a bare
 * SyntaxError ("Unexpected end of JSON input") with NO indication of WHICH of
 * the eight schema files failed — the consumer has to bisect by hand.
 *
 * This only fires on a corrupt/truncated package-bundled asset (a packaging
 * defect, not operator runtime input) and it fails loud at import time before
 * any workflow runs, so the blast radius is small — hence LOW. The humanization
 * fix is still real: turn an anonymous SyntaxError into a self-identifying one
 * that names the package and the offending filename, so the consumer's recovery
 * action (re-install / inspect that one file) is obvious from the message.
 *
 * Test seam: load() is module-private, so index.ts exports a thin
 * `_loadSchemaForTests(filename, dirOverride?)` wrapper — mirroring the existing
 * `_resetValidatorCacheForTests` / `_schemasModuleInstanceCount` test-only
 * exports. The override lets this test point load() at a TEST_ROOT temp dir
 * holding a deliberately corrupt fixture, so the real src/json tree is never
 * touched.
 *
 * Loading note: the seam is imported from `../src/index.js` — the same
 * in-package source-import convention used by validate.test.ts and
 * schemas.test.ts (the package root export resolves to the built dist/, which
 * would lag a fresh source change). This is intra-package, not a cross-package
 * relative import.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _loadSchemaForTests } from '../src/index.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dfl-schemas-load-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('load() parse-error context (d1-schemas-B002)', () => {
  it('rethrows a self-identifying error naming the offending file when JSON is truncated', () => {
    // Simulate a tarball-corrupted schema: valid prefix, truncated mid-document.
    writeFileSync(join(dir, 'dogfood-record.schema.json'), '{ "title": "broken", "enum": [', 'utf8');

    let thrown: Error | undefined;
    try {
      _loadSchemaForTests('dogfood-record.schema.json', dir);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown, 'load() must throw on corrupt JSON').toBeInstanceOf(Error);
    const msg = thrown!.message;
    // The recovery-helping payload: names the package AND the exact file.
    expect(msg).toContain('@dogfood-lab/schemas');
    expect(msg).toContain('dogfood-record.schema.json');
    // And it preserves the underlying parser detail so the cause is not lost.
    expect(msg.toLowerCase()).toContain('json');
  });

  it('names the specific file among several so the consumer need not bisect all eight', () => {
    writeFileSync(join(dir, 'policy.schema.json'), 'not json at all', 'utf8');

    let thrown: Error | undefined;
    try {
      _loadSchemaForTests('policy.schema.json', dir);
    } catch (e) {
      thrown = e as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // It must name THIS file, not a generic "a schema failed".
    expect(thrown!.message).toContain('policy.schema.json');
    expect(thrown!.message).not.toContain('dogfood-record.schema.json');
  });

  it('still parses a healthy schema file without throwing (guard does not break the happy path)', () => {
    const good = { $schema: 'x', title: 'ok', type: 'object', enum: ['a', 'b'] };
    writeFileSync(join(dir, 'scenario.schema.json'), JSON.stringify(good), 'utf8');

    const loaded = _loadSchemaForTests('scenario.schema.json', dir) as typeof good;
    expect(loaded.title).toBe('ok');
    expect(loaded.enum).toEqual(['a', 'b']);
  });

  it('the real bundled schemas all parse (the guard is dormant on a healthy install)', () => {
    // No dirOverride → reads the real src/json tree. Proves the guard is a
    // no-op cost on the normal path; only a corrupt artifact trips it.
    expect(() => _loadSchemaForTests('dogfood-finding.schema.json')).not.toThrow();
    expect(() => _loadSchemaForTests('policy.schema.json')).not.toThrow();
  });
});
