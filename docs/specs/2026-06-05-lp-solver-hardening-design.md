# LP-solver hardening - design

Date: 2026-06-05
Branch: `feat/lp-solver` (work lands here; not merged until rendering is adapted
and obvious issues are resolved)
Related decision: STC-0005 amendment (Prototype 001 GLPK-oracle eval)

## Goal

Make the LP solver fail loudly and honestly, verify its own output during
development, and keep the engine swappable, so that when the render layer is
adapted to the LP solver, it builds on a solver that (a) reports unsatisfiable
requests instead of silently rendering a wrong plan, (b) catches its own
physically-impossible solves in dev/CI, and (c) can be backed by a different
solver later without touching callers.

This is hardening of the existing solver, not a rewrite. Prototype 001 already
validated the solver's correctness against an industrial GLPK reference across
23 scenarios; this work wires up the safety and observability hooks the solver
already has but does not use.

## Scope

Five items. All small and complementary.

1. Surface soft-infeasibility (release, user-facing).
2. Run reference-free invariants as dev-only post-solve checks (tree-shaken from
   release).
3. Big-M numerical stress test (test-only, no behavior change).
4. Assert the cyclic-target honest-infeasibility contract (test-only).
5. Formalize the solver port so the engine is swappable (minimal; contract
   already exists).

Plus a supporting change: adopt the prototype's closed-form fixtures to back
items 1 and 4 with reference-independent assertions.

## Non-goals

- Building the vendor (GLPK) solver implementation. The port makes room for it;
  it is built later on the deferred GLPK-oracle branch.
- Porting the GLPK CI oracle, the de-Angular vendored slice, or the adapter.
- Dropping exact `Fraction` arithmetic from the production data path (deferred;
  needs its own ADR-level investigation).
- The `optimality.ts` heuristic re-solve screen in production: a non-proof
  with documented false positives, so it stays dev/test-only.
- The render-pipeline edge-drop bug (RF-1); that belongs to the render phase.

---

## Item 1 - Surface soft-infeasibility

### Problem

The LP has a deficit escape valve: when an item's demand cannot be met it leaves
a `deficit` and reports `status: "feasible"` with `softFeasible: false`
(`lp.ts`). This is correct, deliberate design. But the production entry points
`solvePlan` / `solvePlanWithIntermediates` (`index.ts`) call `assertSolvable`
(which only throws on hard `infeasible`/`unbounded`) and then read only
`lpResult.rates`, discarding `softFeasible` and `deficit`. A
`feasible + softFeasible:false` result renders exactly like a fully-satisfiable
one. An impossible request silently produces a wrong-looking plan.

### Change

Thread the feasibility result out of the solver entry points to the caller. The
values already exist on `LpResult`; stop discarding them.

### Key decision

Surface a feasibility summary on `SolvePlanFull` (the render-feeding entry),
carrying at least `softFeasible` and the set of deficit items with their
amounts. `solvePlan` (bare `LogicalGraph` return) is left unchanged unless a
current caller needs feasibility, to be confirmed during planning by auditing
`solvePlan` callers. The render/UI layer consumes this later; this item only
makes the data reach the boundary.

### Acceptance criteria

- A plan with an unsourceable/cyclic target returns `softFeasible: false` and the
  offending deficit items to the caller (verified against a closed-form fixture,
  item 1's tie to the adopted fixtures).
- A fully-satisfiable plan returns `softFeasible: true` with no deficits.
- No change to the hard-error behavior for `infeasible`/`unbounded`.

---

## Item 2 - Reference-free invariants, dev-only

### Problem

`invariants.ts` has five reference-free checkers that re-derive correctness in
exact `Fraction` arithmetic (they recompute rather than trust the LP):
`checkMassBalance`, `checkTargetsMet`, `checkRawOnlyBoundary`,
`checkRepresentable`, `checkNoOrphanLogicalNodes`. They score against the exact
objective weights imported from `lp.ts`, so they are a genuine independent
oracle. Today only `invariants.test.ts` calls them; production `solvePlan` never
does. The self-verification only runs on fixtures, never on a real plan.

### Change

Call the checkers right after the solve in the production entry points, guarded
so they run in dev/test/CI and are compiled out of release.

### Key decisions

- Guard behind `import.meta.env.DEV` (Vite statically replaces this; the dead
  branch and the entire `invariants.ts` import graph are tree-shaken out of the
  release bundle, so there is zero runtime cost and a smaller bundle).
- On failure in dev/test/CI: throw loudly (a failed invariant is a solver bug
  that should never happen, distinct from item 1's expected unsatisfiable
  request). This gates CI.
- Exact `Fraction` arithmetic is retained in the checkers because it catches
  sub-1e-6 drift a float check would miss, and the dev-only guard already
  removes its release cost.

### Acceptance criteria

- All five checkers run after a solve in a dev/test build and pass on the
  headline plan.
- A deliberately corrupted solve result trips the relevant checker and throws in
  a dev/test build.
- A production build contains no reference to `invariants.ts` (tree-shaken).

---

## Item 3 - Big-M numerical stress test

### Problem

The LP objective spans ~12 orders of magnitude (surplus `1e-3`, recipe cost
medium, big-M `1e6`, deficit `1e9`). `javascript-lp-solver` is a plain float
simplex with no scaling/presolve, the regime where a wide coefficient range is
numerically weakest. The two-pass deterministic solve relies on a tiny relative
cost-cap epsilon (~`1e-9`) that can be swamped when pass 1 is deficit-dominated
(`1e9`), making the lex tie-break effectively non-binding. Prototype 001 saw no
wrong-feasible result or drift across 23 scenarios, but the adversarial case
(deficit-dominated plan with a tight cost-cap) was never deliberately built.

### Change

One focused test constructing the worst-case input, asserting the result stays
correct (or fails honestly). No behavior change, no runtime cost.

### Acceptance criteria

- A deficit-dominated fixture with a tight cost-cap solves to the closed-form
  expected result within the documented tolerance, or reports honest
  infeasibility, and the assertion pins which.
- The test is independent of any external solver.

---

## Item 4 - Assert the cyclic-target contract

### Problem

STC-0005 ratified honest-infeasibility semantics: a target whose inputs cannot
be externally sourced is reported as `softFeasible: false` + a deficit (not a
falsely-met target). The solver already does this correctly; nothing locks it
against regression.

### Change

A direct test on a cyclic/unsourceable-target fixture asserting the ratified
contract. Pairs with item 1: it proves the surfaced flag carries the right
value.

### Acceptance criteria

- The cyclic-target fixture yields `softFeasible: false` with a deficit on the
  expected item, and the target is not reported as met.
- The assertion references closed-form truth, not `solveLp`'s own output.

---

## Item 5 - Formalize the solver port

### Problem / rationale

The build-vs-buy decision (STC-0005) is "keep the in-house solver, do not adopt
GLPK now". But the choice should stay reversible: the PR review and the prototype
both note the solver is already a swappable component behind the
`LpInput`/`LpResult` contract. Make that seam explicit so a future vendor solver
is a drop-in, not a refactor.

### Change

Define a solver port type and have the production entry points depend on the
port rather than importing `solveLp` directly. The in-house solver is the
default implementation.

The port is the contract that already exists:

```
type LpSolver = (input: LpInput) => LpResult
```

### Key decision - injection mechanism

Inject via an optional parameter on `solvePlan` / `solvePlanWithIntermediates`,
defaulting to the in-house solver. No registry, no config surface, no global
mutable default. Rationale: two implementations (in-house now, vendor later) do
not justify a registry; an optional parameter is explicit, testable, and has no
hidden state. This also lets tests exercise the invariants against an alternate
solver later.

A vendor implementation must map its native output into `LpResult` shape
(`status`/`softFeasible`/`deficit`/snapped-`Fraction` rates). That mapping is
exactly what a future adapter on the GLPK-oracle branch provides. It is not
built here.

### Acceptance criteria

- The in-house solver is reachable only through the port from the entry points.
- Passing an alternate function satisfying `LpSolver` routes the solve through it
  with no other code change (verified with a trivial stub in a test).
- Default behavior (no solver passed) is unchanged.

---

## Supporting change - adopt closed-form fixtures

The prototype's `tools/oracle/fixtures/index.ts` + `pack.ts` are hand-authored
micro-packs, each declaring a closed-form expected answer independent of any
solver (chain, cyclic-target with declared deficit items, no-producer case). The
GLPK dependency lives only in the test harnesses, not the fixtures; the fixtures
import only their local pack builder.

### Change

Lift the fixtures into STC's own test suite (re-homed under `src/solver/`),
stripped of the GLPK comparison harness. They back items 1 and 4 with
reference-independent assertions, fixing the prototype gap-list's complaint that
STC's goldens are self-derived from `solveLp` output (a self-checking golden
cannot catch a systematically-wrong solver; a closed-form one can).

### Acceptance criteria

- Items 1 and 4 assert against the adopted closed-form fixtures.
- No `glpk-ts` / vendored-FactorioLab dependency enters the STC test suite.

---

## Testing strategy

- Items 1, 4: behavior + contract tests against adopted closed-form fixtures.
- Item 2: a passing run on the headline plan plus a corrupted-result test that
  trips a checker; a build-output check that release is tree-shaken.
- Item 3: one adversarial numerical fixture.
- Item 5: a stub-solver routing test.
- Existing suite (102 tests) must stay green; the pre-existing bun:test extractor
  suite remains the only unrelated failure.

## Dependencies and sequencing

- Fixture adoption precedes items 1 and 4 (they assert against it).
- Item 5 (port) precedes item 2's alternate-solver testability but is otherwise
  independent; items 1-4 do not depend on item 5.
- Recommended order: fixtures -> item 1 -> item 4 -> item 5 -> item 2 -> item 3.

## Out of scope / carried forward

- GLPK CI oracle and adapter: separate feature branch (deferred).
- Production-path `Fraction` reconsideration: separate ADR-level investigation
  (deferred TODO).
- RF-1 render edge-drop: render phase.
- Adapting the render/UI layer to consume the surfaced feasibility (item 1 only
  reaches the boundary): render phase.
