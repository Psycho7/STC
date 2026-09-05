# Exam Triage Claim-Kind Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub issue #35 - the exam triage's kind-compatibility table maps the `geometric` claim type to every `MeasurementKind`, so a chip-tier claim gets CORROBORATED (skipping refutation) by segment-tier measurements of an unrelated phenomenon. Split `geometric` into `geometric-placement` / `geometric-routing` / `geometric-collision`, each joined only to the measurement kinds that can witness it.

**Architecture:** The triage rules exist twice by design: `tools/exam/triage.ts` (the tested module) and an inlined copy in `.claude/workflows/render-quality-exam.js` (workflow scripts cannot import). Claim types are agent-authored - the evaluator picks one from the workflow's `FINDINGS_SCHEMA` enum guided by prompt text - so the split must land in the module, the inlined copy, the schema enum, and the prompt, in lockstep. `tools/exam/workflow-parity.test.ts` diffs the two copies end-to-end; today it exercises the kind axis only through empty rows, so it gains cross-tier mismatch cases.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes` on via `tsconfig.tools.json`), Vitest (`globals: false`, `describe`/`test` imported), Bun as script runner.

**Branch / worktree:** historical. `feat/exam-harness` merged to `develop` in 59fd0a3 (PR #46) and both the branch and its worktree are gone; the files this plan names -- `tools/exam/triage.ts`, `tools/exam/workflow-parity.test.ts`, `.claude/workflows/render-quality-exam.js` -- are on `develop` at those paths. Read paths below as relative to the repository root.

## Global Constraints

- ASCII characters only in all comments and commit messages (no smart quotes, arrows, or Unicode symbols).
- Commit messages: imperative mood, no references to external docs, tickets, or Markdown files.
- Do not add dependencies.
- The kind mapping being ratified: `geometric-placement` <- `chip-off-own-path` + `chip-vs-card`; `geometric-routing` <- `segment-vs-card` + `own-card-pierce`; `geometric-collision` <- `chip-vs-segment`. The union of the three rows must equal all five `MeasurementKind`s, compile-checked.
- Test runner commands: `npx vitest run tools/exam` (all exam suites), `bun run typecheck:tools` (tools tsconfig). Both must be green before any commit.
- The legacy claim type string `geometric` becomes invalid: `validateFinding` must reject it like any unknown claim type (fail closed - an unrecognized type gets the empty row and never corroborates).

---

### Task 1: Failing tests for sub-kind recognition and cross-tier refusal

**Files:**
- Modify: `tools/exam/triage-fixtures.ts` (add `SEG` and `XING` measurement fixtures)
- Modify: `tools/exam/triage.test.ts` (new tests inside the existing `describe("corroborationsFor", ...)` block)

**Interfaces:**
- Produces: exported fixtures `SEG: Measurement` (kind `segment-vs-card`, footprint `{x:100,y:100,width:40,height:0}`) and `XING: Measurement` (kind `chip-vs-segment`, footprint `{x:100,y:100,width:1,height:10}`), both co-located with the existing `CHIP` fixture so only the kind axis can refuse a join. Task 3's parity cases import them.
- Consumes: existing fixtures `CHIP`, `TILES`, `finding()` from `tools/exam/triage-fixtures.ts`.

- [x] **Step 1: Add the two cross-tier fixtures to `tools/exam/triage-fixtures.ts`**

Append after the existing `CHIP` fixture (which ends at the `detail:` line quoting `84.0 world units`):

```ts
// The same place as CHIP, different tiers. Both sit at world (100, 100), inside
// the default finding's evidence rect through TILE_A, so a join test using them
// isolates the kind axis: co-location and proportionality both pass, and only
// the compatibility table can refuse. SEG is segment-tier (witnesses a routing
// claim), XING is the collision kind (witnesses a collision claim); neither may
// ever corroborate a placement claim, however perfect the overlap.
export const SEG: Measurement = {
  kind: "segment-vs-card",
  elementIds: ["e:0:A->B:iron", "B"],
  footprint: { x: 100, y: 100, width: 40, height: 0 },
  detail: "edge e:0:A->B:iron segment enters the padding of card B",
};
export const XING: Measurement = {
  kind: "chip-vs-segment",
  elementIds: ["e:0:A->B:iron", "chip:7"],
  footprint: { x: 100, y: 100, width: 1, height: 10 },
  detail: "edge e:0:A->B:iron crosses the chip of e:1",
};
```

- [x] **Step 2: Add the recognition and mismatch tests to `tools/exam/triage.test.ts`**

Extend the fixture import at the top of the file to include the new fixtures:

```ts
import {
  CHIP,
  SEG,
  TILES,
  TILE_A,
  TILE_B,
  TILE_FIT,
  XING,
  finding,
  without,
  withoutFalsifier,
} from "./triage-fixtures";
```

Add inside `describe("corroborationsFor", ...)`, after the existing `test.each(["interaction", "absence", "subjective"] ...)` case:

```ts
  // The geometric family splits by tier: a placement claim is about where a
  // chip sits, a routing claim about where an edge runs, a collision claim
  // about an edge crossing a chip. Each is witnessed only by its own tier's
  // geometry; all three measurements here share one location, so the kind
  // axis alone decides.
  test.each([
    ["geometric-placement", CHIP],
    ["geometric-routing", SEG],
    ["geometric-collision", XING],
  ] as const)("joins a %s claim to its own tier's measurement", (claimType, m) => {
    expect(corroborationsFor(finding({ claimType }), [m], TILES)).toEqual([m]);
  });

  test.each([
    ["geometric-placement", SEG],
    ["geometric-placement", XING],
    ["geometric-routing", CHIP],
    ["geometric-collision", SEG],
  ] as const)(
    "never corroborates a %s claim from another tier, however well the rect overlaps",
    (claimType, m) => {
      expect(corroborationsFor(finding({ claimType }), [m], TILES)).toEqual([]);
    },
  );

  test("rejects the retired claim type geometric rather than mapping it", () => {
    const legacy = finding({ claimType: "geometric" as Finding["claimType"] });
    expect(corroborationsFor(legacy, [CHIP, SEG, XING], TILES)).toEqual([]);
  });
```

Note: these use the new claim type strings before `ClaimType` includes them. Vitest transpiles without typechecking, so the file runs; `as const` tuples keep the literals out of the type error path until Task 2 widens `ClaimType`. If the editor flags them meanwhile, that is expected.

- [x] **Step 3: Run the new tests and verify the failure shape**

Run: `npx vitest run tools/exam/triage.test.ts`

Expected: the three "joins a %s claim to its own tier's measurement" tests FAIL (each returns `[]` because the sub-kind strings are unknown claim types today and get the empty row). The mismatch tests and the legacy-rejection test pass vacuously for the same reason - that is fine; they become load-bearing once Task 2 makes the positives pass. Every pre-existing test still passes.

Do not commit yet - the suite is red by design until Task 2.

---

### Task 2: Split the claim type in the module

**Files:**
- Modify: `tools/exam/triage.ts` (types, table, `routeFinding`, `validateFinding`)
- Modify: `tools/exam/triage-fixtures.ts` (default `finding()` claim type)
- Modify: `tools/exam/triage.test.ts` (re-type existing tests that pair the default finding with segment-tier measurements)

**Interfaces:**
- Produces: `export type GeometricClaimType = "geometric-placement" | "geometric-routing" | "geometric-collision"`; `ClaimType = GeometricClaimType | "interaction" | "absence" | "subjective"`; exported for tests if needed. `corroborationsFor`, `routeFinding`, `validateFinding` signatures unchanged.
- Consumes: `MeasurementKind` from `tools/exam/scene.ts` (unchanged).

- [x] **Step 1: Replace the claim type and the compatibility table in `tools/exam/triage.ts`**

Replace the current `ClaimType` line (`triage.ts:38`):

```ts
export type ClaimType = "geometric" | "interaction" | "absence" | "subjective";
```

with:

```ts
// The geometric family is split by what the audits can actually witness: a
// placement claim (where a chip or label sits) is settled by chip-tier
// geometry, a routing claim (where an edge runs) by segment-tier geometry, and
// a collision claim (a stroke through a chip) by the crossing kind. One
// undivided "geometric" row joined every kind to every claim, which let a
// chip-tier claim ride a segment graze past refutation.
export type GeometricClaimType =
  | "geometric-placement"
  | "geometric-routing"
  | "geometric-collision";

export type ClaimType =
  | GeometricClaimType
  | "interaction"
  | "absence"
  | "subjective";
```

Replace the `ALL_MEASUREMENT_KINDS` object and `COMPATIBLE_KINDS` (`triage.ts:128-142`) with:

```ts
// Which geometric sub-claim each measurement kind can witness. `satisfies`
// keeps this exhaustive in both directions: a new MeasurementKind fails to
// compile here rather than silently joining no row, and the rows below are
// derived from this map so the two cannot drift.
const KIND_WITNESSES = {
  "chip-off-own-path": "geometric-placement",
  "chip-vs-card": "geometric-placement",
  "segment-vs-card": "geometric-routing",
  "own-card-pierce": "geometric-routing",
  "chip-vs-segment": "geometric-collision",
} as const satisfies Record<MeasurementKind, GeometricClaimType>;

const MEASUREMENT_KINDS = Object.keys(KIND_WITNESSES) as MeasurementKind[];

// Derived rather than listed so a sub-claim cannot exist without at least one
// kind that witnesses it.
const GEOMETRIC_CLAIM_TYPES = [
  ...new Set(Object.values(KIND_WITNESSES)),
] as GeometricClaimType[];

function isGeometricClaim(claimType: ClaimType): claimType is GeometricClaimType {
  return (GEOMETRIC_CLAIM_TYPES as readonly ClaimType[]).includes(claimType);
}

const COMPATIBLE_KINDS: Record<ClaimType, readonly MeasurementKind[]> = {
  "geometric-placement": MEASUREMENT_KINDS.filter(
    (k) => KIND_WITNESSES[k] === "geometric-placement",
  ),
  "geometric-routing": MEASUREMENT_KINDS.filter(
    (k) => KIND_WITNESSES[k] === "geometric-routing",
  ),
  "geometric-collision": MEASUREMENT_KINDS.filter(
    (k) => KIND_WITNESSES[k] === "geometric-collision",
  ),
  interaction: [],
  absence: [],
  subjective: [],
};
```

Leave `CLAIM_TYPES = Object.keys(COMPATIBLE_KINDS) as ClaimType[]` as-is; it now yields the six-value enum automatically, which also updates `validateFinding`'s "is not a claim type" rejection.

- [x] **Step 2: Re-point the two hard-coded `"geometric"` tests in `routeFinding` and `validateFinding`**

In `routeFinding` (`triage.ts:364`), replace:

```ts
  if (finding.claimType === "geometric" && corroborations.length > 0) {
    return "CORROBORATED";
  }
```

with:

```ts
  if (isGeometricClaim(finding.claimType) && corroborations.length > 0) {
    return "CORROBORATED";
  }
```

In `validateFinding` (`triage.ts:429-433`), replace:

```ts
  const needsFalsifier =
    finding.claimType === "geometric" ||
    finding.claimType === "interaction" ||
    finding.claimType === "absence" ||
    finding.mechanismHypothesis !== undefined;
```

with:

```ts
  const needsFalsifier =
    isGeometricClaim(finding.claimType) ||
    finding.claimType === "interaction" ||
    finding.claimType === "absence" ||
    finding.mechanismHypothesis !== undefined;
```

- [x] **Step 3: Update the default fixture's claim type**

In `tools/exam/triage-fixtures.ts`, the `finding()` factory currently sets `claimType: "geometric"`. Its default evidence and falsifier are chip-flavoured (`chip-binding`, marks the `CHIP` measurement), so it becomes a placement claim:

```ts
    claimType: "geometric-placement",
```

- [x] **Step 4: Re-type the existing tests that pair the default finding with non-chip measurements**

In `tools/exam/triage.test.ts`, any pre-existing test that joins the default `finding()` (now a placement claim) to a `segment-vs-card`, `own-card-pierce`, or `chip-vs-segment` measurement will start returning `[]` on the kind axis. Fix each by giving the finding the matching sub-kind, not by changing the measurement. Known instances (locate each by the quoted measurement kind; line numbers are pre-edit):

- `triage.test.ts:126` "joins a zero-thickness segment footprint to a rect around the stroke" - inline `seg: Measurement` with kind `segment-vs-card`: change its `finding({ evidence: ... })` call to `finding({ claimType: "geometric-routing", evidence: ... })`.
- `triage.test.ts:147` slack-boundary `test.each` and `triage.test.ts:162` - if the measurement under test is segment-tier, add `claimType: "geometric-routing"` to the finding the same way.
- `triage.test.ts:182` floor-boundary and `:195` ratio-boundary `test.each` - the ratio case uses an `own-card-pierce` measurement: add `claimType: "geometric-routing"`.
- Any test using a `chip-vs-segment` measurement: add `claimType: "geometric-collision"`.
- Tests using `chip-off-own-path` or `chip-vs-card` measurements (`:222` among them) need no change - the default is now placement.
- `triage.test.ts:103` "ignores an unknown claimType rather than treating it as geometric": keep the behaviour, reword the name to "ignores an unknown claimType rather than granting it a row" (the `"vibes"` cast still typechecks against the widened union).
- `routeFinding` tests (`:285`, `:317`, `:327`) and `validateFinding` falsifier tests (`:358`, `:428`): replace every literal `"geometric"` claim type with `"geometric-placement"`.

Sweep to confirm nothing is missed:

Run: `rg -n '"geometric"' tools/exam/`
Expected: zero hits.

- [x] **Step 5: Run the module suite and the tools typecheck**

Run: `npx vitest run tools/exam/triage.test.ts && bun run typecheck:tools`
Expected: all tests PASS (including Task 1's recognition tests) and `tsc` exits clean. `workflow-parity.test.ts` is expected to be red at this point - the inlined copy still speaks the old enum; that is Task 3.

Do not commit yet - the two copies must change in one commit per the sync contract in the workflow header.

---

### Task 3: Update the workflow's inlined copy, schema, prompt, and parity cases

**Files:**
- Modify: `.claude/workflows/render-quality-exam.js` (inlined table, `routeFinding`, `validateFinding`, `FINDINGS_SCHEMA` enum, evaluator prompt text)
- Modify: `tools/exam/workflow-parity.test.ts` (cross-tier cases)

**Interfaces:**
- Consumes: `SEG` and `XING` fixtures from Task 1; `GeometricClaimType` values from Task 2.
- Produces: nothing new - behavioural identity between the two copies, verified by the parity diff.

- [x] **Step 1: Replace the inlined table in `.claude/workflows/render-quality-exam.js`**

Replace lines 394-411 (the `MEASUREMENT_KINDS` array through `ASPECTS`) with:

```js
// Which geometric sub-claim each measurement kind can witness: placement is
// chip-tier, routing is segment-tier, collision is the crossing kind.
// Interaction, absence and subjective claims get the empty row and go to a
// refuter or a human. Mirrors the KIND_WITNESSES map in the module.
const COMPATIBLE_KINDS = {
  'geometric-placement': ['chip-off-own-path', 'chip-vs-card'],
  'geometric-routing': ['segment-vs-card', 'own-card-pierce'],
  'geometric-collision': ['chip-vs-segment'],
  interaction: [],
  absence: [],
  subjective: [],
}
const GEOMETRIC_CLAIM_TYPES = ['geometric-placement', 'geometric-routing', 'geometric-collision']
const CLAIM_TYPES = [...GEOMETRIC_CLAIM_TYPES, 'interaction', 'absence', 'subjective']
const SEVERITIES = ['major', 'minor', 'nit']
const ASPECTS = ['correctness', 'comprehension', 'ux']
```

The standalone `MEASUREMENT_KINDS` array existed only to build the old geometric row; if `rg -n 'MEASUREMENT_KINDS' .claude/workflows/render-quality-exam.js` shows no other use, drop it (the replacement above already omits it). If it has another consumer, keep it verbatim above `COMPATIBLE_KINDS`.

- [x] **Step 2: Update the inlined `routeFinding` and `validateFinding`**

In the inlined `routeFinding` (line ~518), replace:

```js
  if (finding.claimType === 'geometric' && corroborations.length > 0) return 'CORROBORATED'
```

with:

```js
  if (GEOMETRIC_CLAIM_TYPES.includes(finding.claimType) && corroborations.length > 0) return 'CORROBORATED'
```

In the inlined `validateFinding`, replace the `needsFalsifier` clause `finding.claimType === 'geometric' ||` with `GEOMETRIC_CLAIM_TYPES.includes(finding.claimType) ||` (same shape as the module's Task 2 Step 2 edit).

- [x] **Step 3: Widen the `FINDINGS_SCHEMA` enum and rewrite the evaluator prompt bullet**

Line 212, replace:

```js
          claimType: { type: 'string', enum: ['geometric', 'interaction', 'absence', 'subjective'] },
```

with:

```js
          claimType: { type: 'string', enum: ['geometric-placement', 'geometric-routing', 'geometric-collision', 'interaction', 'absence', 'subjective'] },
```

In the prompt text at lines 299-303, replace the single `geometric` bullet:

```js
- \`geometric\`: a claim about where things are in the rendered picture - a chip off its own line, two boxes overlapping, an edge crossing a card, a dot off its trunk, text clipped by a box. Anything settled by coordinates.
```

with three bullets:

```js
- \`geometric-placement\`: a claim about where a chip, label or card decoration sits - a chip off its own line, a chip overlapping a card, text clipped by a box, a dot off its trunk. Settled by chip-tier coordinates.
- \`geometric-routing\`: a claim about where an edge runs - an edge crossing a card, an edge piercing its own card, two runs overlapping. Settled by segment-tier coordinates.
- \`geometric-collision\`: a claim that an edge stroke crosses a chip or label box. Settled by crossing coordinates.
```

Keep the surrounding interaction / absence / subjective bullets untouched.

- [x] **Step 4: Extend the parity table with cross-tier cases**

In `tools/exam/workflow-parity.test.ts`, extend the fixture import to add `SEG` and `XING`, then add to `CASES` after the three non-geometric kind cases (`:132-137`):

```ts
  kase("placement claim over a co-located segment measurement", finding({ claimType: "geometric-placement" }), {
    measurements: [SEG],
  }),
  kase("routing claim over a co-located chip measurement", finding({ claimType: "geometric-routing" })),
  kase("routing claim over its own tier's segment measurement", finding({ claimType: "geometric-routing" }), {
    measurements: [SEG],
  }),
  kase("collision claim over its own tier's crossing", finding({ claimType: "geometric-collision" }), {
    measurements: [XING],
  }),
  kase(
    "retired geometric claim type is rejected",
    finding({ claimType: "geometric" as Finding["claimType"] }),
  ),
```

(`kase` defaults `measurements` to `[CHIP]`, so the second case pairs a routing claim with chip-tier geometry.) The expected rows are computed from the module by `expectedRow`, so no hand-written expectations are needed; the cases exist to make a one-sided edit of either copy fail the diff. Check whether the `Finding` type import is already present for the cast; `:139-153` already casts unknown claim types, so follow whatever import that uses.

- [x] **Step 5: Run the full exam suite and typecheck**

Run: `npx vitest run tools/exam && bun run typecheck:tools`
Expected: all suites PASS (triage, workflow-parity, capture, measurements, probe, tiling), 58 + the new tests. The parity "exercises every route" meta-test must still see all five routes; the new mismatch cases route REFUTE_INDIVIDUAL (major severity default), which was already covered, so no change to that assertion.

- [x] **Step 6: Commit both copies together**

```bash
git add tools/exam/triage.ts tools/exam/triage-fixtures.ts tools/exam/triage.test.ts tools/exam/workflow-parity.test.ts .claude/workflows/render-quality-exam.js docs/plans/2026-08-08-exam-triage-kind-split.md
git commit -m "Split geometric claim type into placement, routing and collision sub-kinds

- Map each measurement kind to the one sub-claim it can witness
- Reject the retired undivided geometric claim type
- Widen the evaluator schema enum and prompt to the sub-kinds
- Add cross-tier mismatch cases to the parity table"
```

---

### Task 4: Regression test from the crystal dry run

**Files:**
- Modify: `tools/exam/triage.test.ts` (new `describe` block at the end of the file)

**Interfaces:**
- Consumes: `corroborationsFor`, `routeFinding`, `finding` from Tasks 1-3. No production code changes.

The live false corroboration from issue #35: plan `crystal`, finding "rate chips overhang the target card" (chip-tier), corroborated by three `segment-vs-card` measurements of edge `e:7` grazing card `u:class:q:5`. The measurements and tile below are verbatim from `.artifacts/exam/crystal/scene.json` in this worktree. The issue body's evidence rects (`[1004,400,80,27]` etc.) do not project onto these measurements through the committed scene's cameras - they came from a different capture run - so the fixture uses a rect drawn directly over the projected footprints (world `x:345,y:138` through zoom 0.75, offset `x:422.4,y:309.375` lands at image `681,413`). That makes co-location and proportionality both pass, proving the kind axis alone refuses the join.

- [x] **Step 1: Write the regression tests**

Append to `tools/exam/triage.test.ts`:

```ts
// The live false corroboration from the first dry run: a chip-tier claim on
// plan crystal rode three segment-vs-card grazes of an unrelated edge to
// CORROBORATED and was filed unchecked. Scene data verbatim from
// .artifacts/exam/crystal/scene.json; the evidence rect is drawn over the
// projected footprints so co-location and proportionality both pass and only
// the kind axis can refuse.
describe("crystal dry-run regression: chip claim over segment grazes", () => {
  const tile: TileFrame = {
    file: "10-tile-r0c0.png",
    kind: "tile",
    viewportTransform: { x: 422.4, y: 309.375, zoom: 0.75 },
    safeRegion: { x: 8, y: 8, width: 1543, height: 926 },
  };
  const grazes: Measurement[] = [
    {
      kind: "segment-vs-card",
      elementIds: ["e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3", "u:class:q:5"],
      footprint: { x: 345, y: 138, width: 23.5, height: 0 },
      detail:
        "edge e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3 segment (345.0,138.0)->(368.5,138.0) enters the padding of card u:class:q:5",
    },
    {
      kind: "segment-vs-card",
      elementIds: ["e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3", "u:class:q:5"],
      footprint: { x: 368.5, y: 138, width: 3.5, height: 3.5 },
      detail:
        "edge e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3 segment (368.5,138.0)->(372.0,141.5) enters the padding of card u:class:q:5",
    },
    {
      kind: "segment-vs-card",
      elementIds: ["e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3", "u:class:q:5"],
      footprint: { x: 372, y: 141.5, width: 0, height: 48.5 },
      detail:
        "edge e:7:u:class:q:7->u:class:q:4:plant_moss_seed_3 segment (372.0,141.5)->(372.0,294.5) enters the padding of card u:class:q:5",
    },
  ];
  const chipClaim = finding({
    planId: "crystal",
    title: "rate chips overhang the target card",
    observation: "rate chips sit over the body of card u:class:q:5",
    claimType: "geometric-placement",
    evidence: [
      { image: tile.file, rect: [676, 408, 30, 12], where: "over card u:class:q:5" },
    ],
  });

  test("the segment grazes cannot corroborate the chip claim", () => {
    expect(corroborationsFor(chipClaim, grazes, [tile])).toEqual([]);
  });

  test("the finding goes to an individual refuter, not CORROBORATED", () => {
    const corroborations = corroborationsFor(chipClaim, grazes, [tile]);
    expect(routeFinding(chipClaim, corroborations)).toBe("REFUTE_INDIVIDUAL");
  });

  test("a routing claim at the same mark still joins all three grazes", () => {
    const routingClaim = finding({
      planId: "crystal",
      title: "edge grazes the planting card",
      observation: "edge e:7 runs through the padding of card u:class:q:5",
      claimType: "geometric-routing",
      evidence: [
        { image: tile.file, rect: [676, 408, 30, 12], where: "over card u:class:q:5" },
      ],
    });
    expect(corroborationsFor(routingClaim, grazes, [tile])).toEqual(grazes);
  });
});
```

The third test is the control: it proves the fixture rect genuinely co-locates (the join succeeds when the kind matches), so the first two tests cannot pass vacuously.

- [x] **Step 2: Run the suite**

Run: `npx vitest run tools/exam/triage.test.ts`
Expected: PASS, including all three new tests.

- [x] **Step 3: Full verification**

Run: `npx vitest run tools/exam && bun run typecheck:tools && bun run lint`
Expected: all green.

- [x] **Step 4: Commit**

```bash
git add tools/exam/triage.test.ts
git commit -m "Pin the crystal dry-run false corroboration as a regression test"
```

---

## Verification checklist (whole plan)

- [x] `npx vitest run tools/exam` green (was 58 tests; final count 186, zero skips)
- [x] `bun run typecheck:tools` green
- [x] `rg -n '"geometric"' tools/exam .claude/workflows/render-quality-exam.js` returns 3 adjudicated hits, not zero: the checklist as written conflicts with the plan's own mandated retired-type rejection tests (two `"geometric" as Finding["claimType"]` casts) plus one doc comment. Review ruling: the mandated code governs; the substantive guarantee (the literal is fail-closed everywhere) holds.
- [x] The parity meta-test still observes all five routes plus the invalid path
- [x] GitHub issue #35 can be closed with a comment linking the two commits and noting the schema/prompt widening (the evaluator now declares the sub-kind; nothing infers it)
