/**
 * F-9178b2f3 — persist-results dieOnReadError must use the same ERROR
 * dialect as renderTopLevelError: BOUNDED_JSON_* via e.code, `Caused by:`,
 * and Next: from e.hint (not ERROR [kind] + Cause:).
 *
 * dieOnReadError is module-private and process.exit(2); pin the live source
 * shape under lib/ (swarm-cp-core owns persist-results.js + lib/**).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSIST_RESULTS = join(__dirname, '..', 'persist-results.js');

describe('F-9178b2f3 — persist-results dieOnReadError CLI dialect parity', () => {
  /** @pins F-9178b2f3 */
  it('dieOnReadError paints ERROR [e.code], Caused by:, and Next: (not kind / Cause:)', () => {
    const src = readFileSync(PERSIST_RESULTS, 'utf-8');
    const start = src.indexOf('function dieOnReadError');
    assert.ok(start >= 0, 'dieOnReadError must exist in persist-results.js');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end > start ? end : undefined);

    assert.match(body, /ERROR \[\$\{e\.code/,
      'must prefer BoundedJsonError.code (BOUNDED_JSON_*) over bare kind tokens');
    assert.doesNotMatch(body, /ERROR \[\$\{e\.kind\}\]/,
      'pre-fix ERROR [${e.kind}] dialect must be gone');
    assert.match(body, /console\.error\(`  Caused by:/,
      'detail label must be Caused by: to match renderTopLevelError');
    assert.doesNotMatch(body, /console\.error\(`  Cause:/,
      'legacy Cause: console.error label must not remain in dieOnReadError');
    assert.match(body, /Next: \$\{e\.hint\}/,
      'must print Next: from BoundedJsonError.hint when present');
    assert.match(body, /Path:/,
      'Path: detail line must remain');
  });
});
