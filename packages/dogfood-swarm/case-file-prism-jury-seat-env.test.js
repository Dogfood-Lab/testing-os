/**
 * case-file-prism-jury-seat-env.test.js — F-da670b34: buildSeatEnv's own
 * docstring says "nothing ambient survives" except a seat's own recipe; the
 * implementation enforced that with SCRUBBED_ENV_KEYS, a fixed six-name
 * denylist plus one regex — permission BY EXCEPTION, so anything not named
 * survived. PRISM_RHO_MAX (overrides the L4 submodularity cutoff) and
 * PRISM_OLLAMA_BASE_URL (redirects every local seat's host) were both
 * reachable through that gap. The fix inverts to an allowlist
 * (AMBIENT_PASSTHROUGH_KEYS in lib/case-file/prism-jury.js).
 *
 * New standalone file rather than an addition to the existing
 * case-file-prism-jury.test.js: that file is concurrently owned and edited by
 * swarm-cp-tests in a parallel worktree for a different finding
 * (F-c729644d) — two agents writing one file from isolated worktrees is a
 * merge hazard, so this fix's regression coverage lives here instead. The
 * existing file's SCRUBBED_ENV_KEYS-dependent tests still pass unmodified
 * (the constant is retained as a documented backward-compat export; see its
 * docstring in lib/case-file/prism-jury.js).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSeatEnv } from './lib/case-file/prism-jury.js';

const HIJACK_KEYS = ['GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'];

describe('buildSeatEnv — an ALLOWLIST closes the whole unnamed-var class (F-da670b34)', () => {
  it('blocks ambient provider keys that would hijack the route or spend money', () => {
    const base = Object.fromEntries(HIJACK_KEYS.map(k => [k, `real-${k}`]));
    const env = buildSeatEnv({ family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' }, base);
    for (const k of HIJACK_KEYS) assert.equal(env[k], undefined, `${k} must not survive`);
  });

  // The two defects named explicitly in F-da670b34: unscrubbed under the old
  // denylist because nobody had named them yet. An allowlist closes the whole
  // class without naming either one specifically — that is the point, and
  // these two assert it actually happened for the two vars that motivated it.
  it('blocks PRISM_RHO_MAX — an ambient override silently disables L4 collapse-refusal', () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' },
      { PRISM_RHO_MAX: '1.0' },
    );
    assert.equal(env.PRISM_RHO_MAX, undefined);
  });

  it("blocks PRISM_OLLAMA_BASE_URL from ambient — a seat's own base_url recipe is the only legitimate source", () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' },
      { PRISM_OLLAMA_BASE_URL: 'http://attacker:11434' },
    );
    assert.equal(env.PRISM_OLLAMA_BASE_URL, undefined);
  });

  it('a seat with its own base_url recipe still sets PRISM_OLLAMA_BASE_URL from the recipe, not ambient', () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local', base_url: 'http://legit-host:11434' },
      { PRISM_OLLAMA_BASE_URL: 'http://attacker:11434' },
    );
    assert.equal(env.PRISM_OLLAMA_BASE_URL, 'http://legit-host:11434', 'the recipe wins, ambient never does');
  });

  it('preserves unrelated subprocess-plumbing env the interpreter needs to start at all', () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' },
      { PATH: '/usr/bin', SYSTEMROOT: 'C:\\Windows', TEMP: '/tmp', LANG: 'en_US.UTF-8' },
    );
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.SYSTEMROOT, 'C:\\Windows');
    assert.equal(env.TEMP, '/tmp');
    assert.equal(env.LANG, 'en_US.UTF-8');
  });

  it('matches plumbing keys case-insensitively (Windows env casing varies by shell) and preserves original casing', () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' },
      { Path: 'C:\\bin', SystemRoot: 'C:\\Windows' },
    );
    assert.equal(env.Path, 'C:\\bin');
    assert.equal(env.SystemRoot, 'C:\\Windows');
  });

  // Real signing key MATERIAL has no other source — receipts/signing.py reads
  // it directly from THIS process's os.environ, and nothing in buildSeatEnv
  // sets a substitute. Omitting both fails every seat closed with a
  // SigningSecretError (an all-abstain panel). Deletion-shaped: drop either
  // from AMBIENT_PASSTHROUGH_KEYS in lib/case-file/prism-jury.js and this
  // goes red.
  it('admits real signing key material (PRISM_SIGNING_KEY / PRISM_SIGNING_SECRET) — it has no other source', () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' },
      { PRISM_SIGNING_KEY: 'ed25519-priv-pem', PRISM_SIGNING_SECRET: 'hmac-secret' },
    );
    assert.equal(env.PRISM_SIGNING_KEY, 'ed25519-priv-pem');
    assert.equal(env.PRISM_SIGNING_SECRET, 'hmac-secret');
  });

  // PRISM_DEV is NOT signing material — it is a policy toggle that lowers the
  // bar, and it reads like part of the signing identity (it was grouped with
  // the two above in this fix's first draft, which is exactly why it is
  // pinned separately here). signing.py:209 gates it on
  // `ed is None and mac is None`, so it fires ONLY when no real key is set:
  // this fixture — ambient PRISM_DEV=1 with NO signing key — is the sole
  // state where admitting it would have had any effect at all, and that
  // effect is signing with a seed that is a public literal in prism's source
  // (signing.py:35), producing a receipt that VERIFIES while being forgeable
  // by anyone. Scrubbed, prism raises SigningSecretError -> the seat abstains
  // honestly.
  it('blocks PRISM_DEV with no signing key present — the one state where it would downgrade the receipt', () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' },
      { PRISM_DEV: '1' },
    );
    assert.equal(env.PRISM_DEV, undefined);
  });

  it('blocks PRISM_DEV even alongside real key material (no admission by association)', () => {
    const env = buildSeatEnv(
      { family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' },
      { PRISM_SIGNING_KEY: 'ed25519-priv-pem', PRISM_DEV: '1' },
    );
    assert.equal(env.PRISM_SIGNING_KEY, 'ed25519-priv-pem', 'real key material still passes');
    assert.equal(env.PRISM_DEV, undefined);
  });

  // The coordinator's own proof obligation for the allowlist direction: the
  // panel's cross-seat diversity depends on each seat's OWN recipe winning,
  // never on an ambient PRISM_VERIFIER_MODEL_* pin. Assert two DIFFERENT
  // seats produce two DIFFERENT pins under the SAME key — a test that only
  // checks a bad value is ABSENT would pass even if every seat silently
  // collapsed to the same fallback model (the exact failure mode the panel
  // exists to prevent).
  it('two different seats on the same prism_family slot get two different model pins', () => {
    const mistralEnv = buildSeatEnv({ family: 'mistral', model: 'mistral-small:24b', prism_family: 'local' }, {});
    const qwenEnv = buildSeatEnv({ family: 'qwen', model: 'qwen2.5:7b', prism_family: 'local' }, {});
    const hermesEnv = buildSeatEnv({ family: 'hermes', model: 'hermes3:8b', prism_family: 'local' }, {});
    assert.equal(mistralEnv.PRISM_VERIFIER_MODEL_LOCAL, 'mistral-small:24b');
    assert.equal(qwenEnv.PRISM_VERIFIER_MODEL_LOCAL, 'qwen2.5:7b');
    assert.equal(hermesEnv.PRISM_VERIFIER_MODEL_LOCAL, 'hermes3:8b');
    const pins = new Set([
      mistralEnv.PRISM_VERIFIER_MODEL_LOCAL,
      qwenEnv.PRISM_VERIFIER_MODEL_LOCAL,
      hermesEnv.PRISM_VERIFIER_MODEL_LOCAL,
    ]);
    assert.equal(pins.size, 3, 'three seats must not collapse to fewer than three distinct model pins');
  });

  // A stale ambient PRISM_VERIFIER_MODEL_<OTHER-FAMILY> pin must not leak
  // into a seat it was never meant for, even though it is not this seat's
  // own family slot — the allowlist admits none of the PRISM_VERIFIER_MODEL_*
  // shape from ambient, regardless of which family it names.
  it('blocks a stale PRISM_VERIFIER_MODEL_* pin for a DIFFERENT family from leaking through', () => {
    const env = buildSeatEnv(
      { family: 'qwen', model: 'qwen2.5:7b', prism_family: 'local' },
      { PRISM_VERIFIER_MODEL_OPENAI: 'stale-cloud-pin', PRISM_VERIFIER_MODEL_LOCAL_VERIFIER: 'stale-specialist-pin' },
    );
    assert.equal(env.PRISM_VERIFIER_MODEL_OPENAI, undefined);
    assert.equal(env.PRISM_VERIFIER_MODEL_LOCAL_VERIFIER, undefined);
    assert.equal(env.PRISM_VERIFIER_MODEL_LOCAL, 'qwen2.5:7b', 'this seat still gets its own correct pin');
  });
});
