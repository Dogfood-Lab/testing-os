/**
 * error-render-hint-coverage.test.js — F-4b72faf9: CriterionIntentOverflowError
 * never set `.hint`, and error-render.js's deriveHintForCode() switch had no
 * case for 'CRITERION_INTENT_OVERFLOW' either — so renderTopLevelError printed
 * no "Next:" line at all for it, unlike every OTHER typed error in errors.js.
 *
 * INSTANCE FIX: CriterionIntentOverflowError's constructor now sets a default
 * `.hint` (the message's own remediation text, split into a dedicated field,
 * mirroring ControlPlaneSchemaTooNewError's `opts.hint || '<default>'`
 * pattern), AND deriveHintForCode() gained a matching CRITERION_INTENT_OVERFLOW
 * case (mirroring CONTROL_PLANE_SCHEMA_TOO_NEW's existing dual-coverage) —
 * doing BOTH covers both a directly-constructed error (has `.hint` already)
 * and a hand-shaped/JSON-round-tripped error object that kept `.code` but not
 * the real class's constructor logic.
 *
 * CLASS FIX (this file, F-4b72faf9 first pass): the finding's own text asks
 * "whether the missing fallback is the real class defect" — a FUTURE typed
 * error added to errors.js with neither a constructor-set `.hint` NOR a
 * deriveHintForCode() case would silently lose its "Next:" line the exact
 * same way CriterionIntentOverflowError did, and nothing in the suite would
 * catch it. This file drives every exported typed error class from errors.js
 * through the real renderTopLevelError and asserts a "Next:" line always
 * prints. A negative control (a hint-less, code-only synthetic error) proves
 * the harness actually discriminates — a helper that always finds SOME
 * output line would rubber-stamp a broken class the same way the pre-fix
 * state went uncaught.
 *
 * F-7d4ac5ce (wave 22): the class-fix claim above was itself false AS A
 * MECHANISM. TESTED_CLASSES (below) was a static, hand-typed list — nothing
 * re-derived it from errors.js's actual exports. `grep -n "^export class"
 * lib/errors.js` shows today's 7 named imports above are the complete set
 * (this suite was not under-covering anything LIVE), but add an 8th
 * `export class FooError extends Error {}` tomorrow with no `.hint` and no
 * deriveHintForCode case, and every test below stays green — the exact
 * regression this file claims to prevent ships silently. computeUncoveredErrorClasses
 * makes the enumeration dynamic: it diffs errors.js's REAL exports against
 * TESTED_CLASSES, and the "GATE (mutation control)" tests below prove the
 * diff itself can go non-empty (PROTOCOL.md: "a gate that can't go red is
 * theater") — mirroring this package's own dogfood on gates that assert
 * their own falsifiability.
 *
 * SCOPE NOTE. Lives under lib/ (not the package root) because the
 * swarm-cp-core domain owns packages/dogfood-swarm/lib/**\ only.
 *
 * F-8f735719 (MEDIUM, wave 24): F-7d4ac5ce's dynamic diff genuinely closed
 * "an 8th errors.js class silently escapes the SET" — but membership in
 * that set was still a bare, hand-typed array (TESTED_CLASSES) nobody
 * re-derived from the it() blocks actually present. PROVEN LIVE (mirroring
 * the finding's own construction): add a synthetic hint-less class, add ONLY
 * its NAME to a copy of TESTED_CLASSES (the one remediation step the "today"
 * test's own failure message names), and the gate reported `[]` — fully
 * covered — with zero it() anywhere driving that class through
 * renderTopLevelError. The SET was dynamic; membership in it was not.
 *
 * THE FIX: TESTED_CLASSES is gone. `namedErrorTest(className, run)` below is
 * now the ONLY way a class name enters `EXERCISED_CLASSES` — it registers
 * the real it() and (AS OF wave 24) recorded the name as its first
 * statement, so the record happened even if `run`'s assertion later threw
 * ("exercised" meant "a real test attempted this class," independent of
 * whether that test currently passed). **F-ba7ad7df (wave 26) changed this
 * ordering — see below; the record now happens AFTER `run` completes,
 * gated on observed evidence, not as `run`'s first effect.** What did NOT
 * change: there is no longer a freestanding array a future author can edit
 * without also writing the corresponding test. Node's test runner executes
 * `describe`/`it` bodies sequentially in declaration order (verified
 * empirically against this Node version, not assumed), so by the time the
 * "today" gate test below runs, every namedErrorTest call above has already
 * executed and recorded its name.
 *
 * DISCLOSED RESIDUAL: EXERCISED_CLASSES is a plain, module-local `Set` —
 * nothing prevents a determined author from writing `EXERCISED_CLASSES.add
 * ('X')` as a bare statement outside any namedErrorTest/it() call. That is
 * not eliminated, and no runtime mechanism short of coverage instrumentation
 * (reading which lines actually executed) can eliminate it. What changes is
 * the SHAPE of the bypass: the original exploit (append a string to a plain
 * array — reads as completely ordinary code, easy to miss in review) is
 * replaced by a bare `.add()` call sitting outside any test registration,
 * which is visibly anomalous in a test file and has no reason to exist
 * outside this one helper. Harder to do by accident, and conspicuous when
 * done deliberately — not unforgeable, but a materially smaller target than
 * the array it replaces.
 *
 * F-ba7ad7df (MEDIUM, wave 26): the DISCLOSED RESIDUAL above named the bare
 * `.add()` bypass but missed a NARROWER, easier-to-hit sibling inside
 * namedErrorTest ITSELF: registration happened as `run`'s FIRST effect,
 * BEFORE `run` executed at all — so `namedErrorTest('HintlessFutureError',
 * () => {})`, an ordinary-looking empty test stub (not the "visibly
 * anomalous" bare `.add()` the residual above warned about — an incomplete
 * stub is a common, unremarkable real-world shape), still registered the
 * class as exercised with zero assertions ever made. PROVEN LIVE (mirroring
 * F-8f735719's own proof style, direct reproduction, zero repo writes): that
 * exact call left `computeUncoveredErrorClasses` reporting `[]` for the
 * synthetic class — identical to genuine coverage.
 *
 * THE FIX: registration moved from `run`'s first effect to AFTER `run`
 * completes, gated on evidence. `runNamedErrorTest` (below) records every
 * `nextLineFor()` call's result made during `run` (via the module-level
 * `nextLineForCalls` log) and requires (a) at least one call happened and
 * (b) at least one produced a genuine, non-empty "Next:" line, before adding
 * `className` to EXERCISED_CLASSES. An empty-bodied (or Next:-line-free)
 * `run` now throws instead of silently registering — proven by the
 * F-ba7ad7df GATE (mutation control) tests alongside the F-8f735719 ones
 * below.
 *
 * This supersedes the OLD registration-before-run ordering's stated reason
 * for existing (recording "a real test attempted this class" as a signal
 * independent of that test's assertions later failing). That goal is
 * superseded by the stronger requirement that "exercised" means genuine
 * evidence was observed, not merely that `run` was invoked without
 * throwing. The trade-off is disclosed, not hidden: a namedErrorTest whose
 * assertions legitimately fail because of a REAL regression in
 * error-render.js will now ALSO fail the "today" coverage-gate test lower in
 * this file (the class drops out of EXERCISED_CLASSES along with the red
 * it()) — two failing tests instead of one for the same root cause, a
 * noisier but strictly more honest signal than the one it replaces, since
 * neither test can go green while the class's rendering is actually broken.
 *
 * FURTHER DISCLOSED RESIDUAL (narrower than either bypass above): the
 * tightened gate proves `run` triggered a genuine "Next:" line SOMEWHERE
 * during its execution — it does not verify that line came from
 * constructing an actual instance of `className` itself. A `run` body that
 * calls `nextLineFor` on an unrelated, already-covered class (e.g.
 * `namedErrorTest('FutureError', () => { nextLineFor(new
 * IsolationError('x')) })`) would still satisfy it. This is a smaller, more
 * contrived target than the empty-body case this fix closes — it requires
 * deliberately referencing a working, unrelated class inside a stub for the
 * wrong one, which reads oddly in review rather than as an ordinary
 * incomplete stub — and is disclosed rather than closed here, matching this
 * file's own standard for the bare-`.add()` residual above.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as errorsModule from './errors.js';
import {
  IsolationError,
  CollectUpsertError,
  DispatchPreconditionError,
  CliInvalidGlobsError,
  ControlPlaneSchemaTooNewError,
  CriterionIntentOverflowError,
  StateMachineRejectionError,
} from './errors.js';
import { renderTopLevelError } from './error-render.js';

// F-8f735719: the self-registered replacement for the old hand-typed
// TESTED_CLASSES array — see this file's module docstring for the full
// rationale and the disclosed residual.
const EXERCISED_CLASSES = new Set();

// F-ba7ad7df: every nextLineFor() call's result, in invocation order — lets
// runNamedErrorTest prove a given `run` genuinely triggered a render (not
// just that it executed without throwing). See this file's module docstring
// for the full rationale.
const nextLineForCalls = [];

/**
 * The gate mechanic behind namedErrorTest, factored out so it can be
 * exercised directly with assert.throws() (see the GATE (mutation control)
 * tests below) instead of fighting node:test's synchronous-registration
 * semantics for a nested it() call.
 *
 * F-ba7ad7df: `className` enters EXERCISED_CLASSES only AFTER `run`
 * completes, and only if `run` is observed (via nextLineForCalls) to have
 * triggered at least one nextLineFor() call that produced a genuine,
 * non-empty "Next:" line. An empty-bodied (or Next:-line-free) `run` throws
 * here instead of silently registering the class — see this file's module
 * docstring for the full rationale, the disclosed trade-off, and the
 * narrower residual that remains.
 *
 * @param {string} className
 * @param {() => void} run
 */
function runNamedErrorTest(className, run) {
  const before = nextLineForCalls.length;
  run();
  const observedDuringRun = nextLineForCalls.slice(before);
  assert.ok(
    observedDuringRun.length > 0,
    `namedErrorTest('${className}') never called nextLineFor() — a class cannot be marked ` +
    `exercised without the harness observing at least one rendered error for it`,
  );
  assert.ok(
    observedDuringRun.some((line) => typeof line === 'string' && line.length > 0),
    `namedErrorTest('${className}') called nextLineFor() but no invocation produced a "Next:" ` +
    `line — a class cannot be marked exercised without at least one genuine "Next:" hint being observed`,
  );
  EXERCISED_CLASSES.add(className);
}

/**
 * Registers a per-class positive test whose only path to marking
 * `className` "exercised" is runNamedErrorTest above — see its docstring and
 * this file's module docstring for the gate mechanic and F-ba7ad7df's fix
 * rationale.
 *
 * `title` defaults to `className` (the common case, matching every existing
 * it() title below) but can be overridden for a test that documents more
 * than the bare class name (e.g. "all four documented codes") without
 * decoupling the DISPLAYED title from the name actually recorded for
 * coverage purposes.
 *
 * @param {string} className
 * @param {() => void} run
 * @param {string} [title]
 */
function namedErrorTest(className, run, title = className) {
  it(title, () => runNamedErrorTest(className, run));
}

function isErrorClass(v) {
  return typeof v === 'function' && v.prototype instanceof Error;
}

/**
 * F-7d4ac5ce: the sorted list of exported Error-subclass names in
 * `moduleExports` that are NOT present in `testedNames`. Used both to gate
 * the real errors.js module (should return `[]` today) and, in the mutation
 * controls below, against a SYNTHETIC module object carrying an extra class
 * (must NOT return `[]`) — proving the mechanism can actually fire, not just
 * that today happens to be fully covered. `testedNames` is generic (any
 * iterable of names) by design — this function's own diff logic does not
 * care whether the caller's list came from a hand-typed array or (F-8f735719,
 * below) a self-registered Set; the fix lives in what THIS FILE passes in.
 */
function computeUncoveredErrorClasses(moduleExports, testedNames) {
  const tested = new Set(testedNames);
  return Object.entries(moduleExports)
    .filter(([, v]) => isErrorClass(v))
    .map(([name]) => name)
    .filter((name) => !tested.has(name))
    .sort();
}

function nextLineFor(err) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    renderTopLevelError(err);
  } finally {
    console.error = orig;
  }
  const next = lines.find((l) => l.trim().startsWith('Next:'));
  // F-ba7ad7df: recorded unconditionally — runNamedErrorTest reads this log
  // to prove a `run` body genuinely rendered something, not just that it
  // executed without throwing.
  nextLineForCalls.push(next);
  return next;
}

/** @pins F-4b72faf9 */
describe('errors.js — every typed error renders a "Next:" hint (F-4b72faf9 class-level gate)', () => {
  it('GATE (negative control): a hint-less error whose code has no deriveHintForCode case renders NO "Next:" line', () => {
    // Proves nextLineFor() actually discriminates. Without this control, a
    // broken helper that always returns something would make every positive
    // assertion below meaningless — the same blind spot that let
    // CriterionIntentOverflowError ship with no "Next:" line and no test
    // catching it.
    const e = Object.assign(new Error('msg'), { code: 'NO_HINT_ANYWHERE_TEST_CODE' });
    assert.equal(nextLineFor(e), undefined);
  });

  namedErrorTest('IsolationError', () => {
    const e = new IsolationError('worktree creation failed');
    assert.ok(nextLineFor(e), 'IsolationError must render a Next: hint');
  });

  namedErrorTest('CollectUpsertError', () => {
    const e = new CollectUpsertError('upsert failed', { waveId: 1 });
    assert.ok(nextLineFor(e), 'CollectUpsertError must render a Next: hint');
  });

  namedErrorTest('DispatchPreconditionError', () => {
    for (const code of [
      'DISPATCH_RUN_NOT_FOUND',
      'DISPATCH_DOMAINS_NOT_FROZEN',
      'DISPATCH_NO_DOMAINS',
      'DISPATCH_INVALID_PHASE',
    ]) {
      const e = new DispatchPreconditionError('precondition failed', { code });
      assert.ok(nextLineFor(e), `DispatchPreconditionError[${code}] must render a Next: hint`);
    }
  }, 'DispatchPreconditionError (all four documented codes)');

  namedErrorTest('CliInvalidGlobsError', () => {
    const e = new CliInvalidGlobsError('bad globs JSON');
    assert.ok(nextLineFor(e), 'CliInvalidGlobsError must render a Next: hint');
  });

  namedErrorTest('ControlPlaneSchemaTooNewError', () => {
    const e = new ControlPlaneSchemaTooNewError('schema too new', { onDiskVersion: 9, buildVersion: 8 });
    assert.ok(nextLineFor(e), 'ControlPlaneSchemaTooNewError must render a Next: hint');
  });

  namedErrorTest('CriterionIntentOverflowError', () => {
    const e = new CriterionIntentOverflowError('intent too long', {
      criterionId: 'c1', headLength: 4100, maxChars: 4000,
    });
    assert.ok(nextLineFor(e), 'CriterionIntentOverflowError must render a Next: hint (F-4b72faf9)');

    // Also pin the dual-coverage fallback directly: a hand-shaped error
    // object with the code but no constructor-set .hint must still get one
    // from deriveHintForCode's new case.
    const shaped = Object.assign(new Error('intent too long'), {
      code: 'CRITERION_INTENT_OVERFLOW', criterionId: 'c2', headLength: 4200, maxChars: 4000,
    });
    assert.ok(nextLineFor(shaped), 'a .hint-less CRITERION_INTENT_OVERFLOW must still get a fallback Next: hint');
  });

  namedErrorTest('StateMachineRejectionError', () => {
    for (const kind of ['BLOCKED', 'TERMINAL', 'INVALID']) {
      const e = new StateMachineRejectionError('rejected', { kind, from: 'a', to: 'b', hint: 'do the thing' });
      assert.ok(nextLineFor(e), `StateMachineRejectionError[${kind}] must render a Next: hint`);
    }
  }, 'StateMachineRejectionError (all three kinds)');
});

// No @pins tag here by design (wave 22, reaffirmed wave 24): F-7d4ac5ce's and
// F-8f735719's fixes are entirely inside THIS test file (the dynamic
// enumeration below and the self-registration mechanism above it), so no
// source-side pin exists for a declared tag to resolve against — a tag would
// be dangling by the Class #14 gate's own rule. Both finding ids stay in
// titles/comments for humans.
describe('errors.js coverage gate is DYNAMIC, not a hardcoded list (F-7d4ac5ce class-level fix)', () => {
  it('today: every exported Error subclass in errors.js has dedicated coverage above', () => {
    // F-8f735719: sourced from EXERCISED_CLASSES (self-registered by the
    // namedErrorTest calls above, which have already run by this point —
    // see this file's module docstring for the execution-order proof), never
    // from a hand-typed array a future author could edit without also
    // writing the test.
    const uncovered = computeUncoveredErrorClasses(errorsModule, [...EXERCISED_CLASSES]);
    assert.deepEqual(
      uncovered,
      [],
      `errors.js exports an Error subclass with no namedErrorTest() coverage above: ` +
      `${uncovered.join(', ')} — add a dedicated namedErrorTest(className, () => { ... }) block above ` +
      `asserting it renders a "Next:" line; there is no separate list to edit instead.`,
    );
  });

  it('GATE (mutation control): a synthetic module with one extra Error subclass IS reported uncovered', () => {
    // Proves the gate can actually go RED — the exact failure mode this
    // finding described (a hardcoded list a new class silently escapes) would
    // make this assertion produce [] too, indistinguishable from "genuinely
    // fully covered". Deletion/addition-shaped mutation, not value
    // perturbation (PROTOCOL.md: value-perturbing mutation is blind to
    // exactly this class of gap).
    class FutureError extends Error {}
    const fakeModule = { ...errorsModule, FutureError };
    const uncovered = computeUncoveredErrorClasses(fakeModule, [...EXERCISED_CLASSES]);
    assert.deepEqual(uncovered, ['FutureError']);
  });

  it('GATE (mutation control): two extra Error subclasses are both reported, sorted', () => {
    class AlphaError extends Error {}
    class ZetaError extends Error {}
    const fakeModule = { ...errorsModule, ZetaError, AlphaError };
    const uncovered = computeUncoveredErrorClasses(fakeModule, [...EXERCISED_CLASSES]);
    assert.deepEqual(uncovered, ['AlphaError', 'ZetaError']);
  });

  it('GATE (mutation control): a non-Error export is never reported as an uncovered class', () => {
    // A plain function/const export (e.g. a future helper added to errors.js)
    // must not false-positive as an "uncovered error class" — the filter is
    // Error-subclass-shaped, not "any new export".
    const fakeModule = { ...errorsModule, someHelper: function someHelper() {}, SOME_CONST: 42 };
    const uncovered = computeUncoveredErrorClasses(fakeModule, [...EXERCISED_CLASSES]);
    assert.deepEqual(uncovered, []);
  });

  it('sanity: EXERCISED_CLASSES itself has no stale entry (a name not actually exported by errors.js)', () => {
    // The inverse defect: a name lingering after its class was renamed/
    // removed from errors.js would silently mask a REAL removal going
    // unnoticed by this gate (computeUncoveredErrorClasses only checks
    // exports not-in tested, never tested not-in exports).
    const staleEntries = [...EXERCISED_CLASSES].filter((name) => !isErrorClass(errorsModule[name]));
    assert.deepEqual(staleEntries, [], `EXERCISED_CLASSES names a class errors.js no longer exports: ${staleEntries.join(', ')}`);
  });

  it('F-8f735719 GATE (mutation control): EXERCISED_CLASSES pins the exact 7 classes actually run above — no more, no fewer', () => {
    // Content-addresses the coverage set itself (PROTOCOL.md sub-law 5: "a
    // count is not integrity") rather than only its cardinality — a future
    // author deleting one namedErrorTest call while adding an unrelated one
    // would hold the SIZE constant but change the membership; this pins
    // membership directly.
    assert.deepEqual(
      [...EXERCISED_CLASSES].sort(),
      [
        'CliInvalidGlobsError',
        'CollectUpsertError',
        'ControlPlaneSchemaTooNewError',
        'CriterionIntentOverflowError',
        'DispatchPreconditionError',
        'IsolationError',
        'StateMachineRejectionError',
      ],
    );
  });

  it('F-8f735719 GATE (mutation control): a class name is absent from EXERCISED_CLASSES unless namedErrorTest actually ran for it', () => {
    // Reproduces the finding's own exploit shape and shows it is now closed:
    // pre-fix, an author "added a name to TESTED_CLASSES" (a plain array
    // edit) with zero test coverage, and the gate reported clean. Post-fix,
    // a class that was never passed to namedErrorTest — even one shaped
    // exactly like a real, hint-less bug (mirroring the finding's own
    // HintlessFutureError proof) — is provably absent from the ONLY source
    // the "today" gate reads, because there is no array left to hand-edit.
    class HintlessFutureError extends Error {}
    assert.ok(!EXERCISED_CLASSES.has('HintlessFutureError'),
      'a class never passed to namedErrorTest must not appear in EXERCISED_CLASSES');
    const fakeModule = { ...errorsModule, HintlessFutureError };
    const uncovered = computeUncoveredErrorClasses(fakeModule, [...EXERCISED_CLASSES]);
    assert.deepEqual(uncovered, ['HintlessFutureError'],
      'the gate must report this class uncovered — there is no way to silence it short of a real namedErrorTest call');
  });

  // No @pins tag by design (F-ba7ad7df): this finding's fix is entirely inside
  // this gate test file — tightening namedErrorTest's registration to require
  // real assertion evidence before a class counts as "exercised." There is no
  // production-source F-ba7ad7df pin for a declared tag to resolve against, so a
  // tag here would be dangling by the Class #14 gate's own rule (same shape as
  // wave-22 F-7d4ac5ce). The mutation-control test below still runs.
  it('F-ba7ad7df GATE (mutation control): an empty-bodied namedErrorTest run throws and never registers the class', () => {
    // Reproduces the finding's own reproduction — namedErrorTest
    // ('HintlessFutureError', () => {}) — directly against runNamedErrorTest:
    // an empty run body must not silently register the class the way the
    // pre-fix registration-before-run ordering let it. Placed after the
    // "pins the exact 7 classes" test above (declaration order — see this
    // file's module docstring) so this test's own EXERCISED_CLASSES
    // mutations (there are none — the throw fires before .add()) cannot
    // retroactively affect that already-executed assertion.
    assert.throws(
      () => runNamedErrorTest('EmptyBodyFutureError', () => {}),
      /never called nextLineFor/,
    );
    assert.ok(
      !EXERCISED_CLASSES.has('EmptyBodyFutureError'),
      'an empty-bodied run must not register the class into EXERCISED_CLASSES',
    );
  });

  it('F-ba7ad7df GATE (mutation control): a run that calls nextLineFor but produces no "Next:" line also throws', () => {
    // Closes the narrower loophole one level down from the empty-body case:
    // merely CALLING nextLineFor is not sufficient if it never produces a
    // genuine "Next:" line — a run body that renders an irrelevant,
    // hint-less error (the same shape as this file's own top-level negative
    // control) must not count as coverage either.
    assert.throws(
      () => runNamedErrorTest('CallsButNeverRendersFutureError', () => {
        const e = Object.assign(new Error('msg'), { code: 'NO_HINT_ANYWHERE_TEST_CODE_2' });
        nextLineFor(e); // called, but produces no "Next:" line
      }),
      /no invocation produced a "Next:" line/,
    );
    assert.ok(!EXERCISED_CLASSES.has('CallsButNeverRendersFutureError'));
  });

  it('F-ba7ad7df GATE (mutation control): a run that genuinely renders a "Next:" line still registers normally', () => {
    // Positive control: proves the tightened gate discriminates rather than
    // simply always throwing — a run shaped like the real namedErrorTest
    // calls above (construct + render + observe a genuine line) registers
    // exactly as before.
    runNamedErrorTest('GenuinelyExercisedFutureError', () => {
      const e = new IsolationError('worktree creation failed');
      assert.ok(nextLineFor(e));
    });
    assert.ok(EXERCISED_CLASSES.has('GenuinelyExercisedFutureError'));
  });
});
