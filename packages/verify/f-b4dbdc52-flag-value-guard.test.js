/**
 * F-b4dbdc52: the space-form value take treated ANY next token as a value, so
 * `verify --file --json` consumed '--json' as the file path and failed with a
 * misleading exit-2 'could not read --file: …/--json' — losing the diagnosis
 * of the real mistake. packages/ingest/run.js fixed this class with its
 * `nextIsValue` guard (f-ingest-003); this CLI's parser claims to mirror it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from './cli.js';

describe('F-b4dbdc52: a flag is never consumed as another flag\'s value', () => {
  it('--file followed by --json throws the --file-requires-a-path OperatorError', () => {
    assert.throws(
      () => parseArgs(['--file', '--json']),
      /--file requires a path/
    );
  });

  it('--payload followed by --explain throws the requires-value OperatorError', () => {
    assert.throws(
      () => parseArgs(['--payload', '--explain']),
      /--payload requires a JSON string/
    );
  });

  it('space-form values still work when the next token is a real value', () => {
    const opts = parseArgs(['--file', 'submission.json', '--json']);
    assert.equal(opts.file, 'submission.json');
    assert.equal(opts.mode, 'json');
  });

  it('inline-form values are unaffected', () => {
    const opts = parseArgs(['--provenance=stub', '--file=x.json']);
    assert.equal(opts.file, 'x.json');
    assert.equal(opts.provenanceMode, 'stub');
  });
});
