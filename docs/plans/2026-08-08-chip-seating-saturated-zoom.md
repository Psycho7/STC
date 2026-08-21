# Chip Seating at Saturated Counter-Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub issue #34 - at saturated counter-scale (fit zoom <= 0.5, chip footprint 240 graph units) the rate-chip seating gives up: the graze tier takes the FIRST hard-clear candidate instead of the least-crossed one, and a 3-5 unit port-model drift between the seating reconstruction and the drawn handles smears every seat by up to 1px. Land the two non-ADR fixes: (1) align the seating pass's port model with the drawn endpoints, (2) make the graze tier score candidates by foreign-line crossings and take the minimum. Then re-pin the geometry ratchets downward and record the deferred rulings.

**Architecture:** `deconflictChipAnchors` (`src/canvas/chipSeating.ts`) reconstructs every edge polyline offline from `edgeEndpoints` (model ports: node position + model width + model row y) and stamps `labelDx/labelDy` seat offsets; `ItemEdge.tsx` applies those offsets to the DRAWN anchor from xyflow's measured handles. The two coordinate systems disagree by a few units (DOM borders + xyflow's 8px handle box), which is fix 1. The seat ladder in `seatRateChip` runs tiers fully-clear slide -> sidestep -> graze -> nudge -> escape; the graze tier at `chipSeating.ts:630` is `slideAlong(hardClearAt, () => "graze")`, first-hit, no scoring - fix 2 replaces it with a min-crossings scan using a new counting method on `ClearanceField`. Ratchets live in `test/e2e/geometry-audit.spec.ts` as five per-scenario baseline tables asserted with `expect.soft`.

**Tech Stack:** TypeScript + React 19, Vitest (unit, jsdom), Playwright (e2e; `webServer` auto-builds and serves on 4173), Bun as runner.

**Branch / worktree:** create `fix/chip-seating` off `origin/develop`. From `STC-workspace/`:

```sh
git -C STC fetch origin
git -C STC worktree add .claude/worktrees/fix/chip-seating -b fix/chip-seating origin/develop
```

All paths below are relative to `STC/.claude/worktrees/fix/chip-seating/`. Run all commands from that directory.

## Global Constraints

- ASCII characters only in comments and commit messages; no references to external docs, tickets, or Markdown files in either.
- Ratchet baselines move DOWN freely when measured lower; they move UP only with a recorded controller ruling (stated verbatim at `test/e2e/geometry-audit.spec.ts:385-393`). This plan must not raise any baseline.
- The seat-tier priority order is ratified and must not change: chip/chip and chip/card clearance are hard; staying on the own line and clearing foreign lines are yielding preferences. Fix 2 changes WHICH graze candidate wins, never the tier order.
- The geometry audit already pins locale `en` via `page.addInitScript` in all three describes - the issue's zh-vs-en caveat needs no code change; do not add locale handling.
- Visual verification is mandatory after render-affecting changes: captures plus zoomed crops, inspected for wrongness.
- e2e baseline: develop carries 7 stable pre-existing failures outside the geometry audit (geometry ruling, inputs-panel pins, copper premise) plus a rotating placement-shots flake. Measure `bun run test:e2e` on the fresh branch BEFORE any change and compare against that, never against zero.
- Unit gate before every commit: `bun run test && bun run typecheck && bun run lint` all green.

---

### Task 1: Record the pre-change baselines

**Files:**
- No source changes. Produces two recorded artifacts (paste into the task log / PR notes, do not commit): the e2e failure list and the measured actuals of all five ratchet tables.

**Interfaces:**
- Produces: the "before" numbers every later task's "verify" step compares against.

- [x] **Step 1: Run the unit suite and e2e suite untouched** - the failure list was re-measured on the post-merge tree; the plan's "7 pre-existing failures" was stale. Actual: geometry-audit RAW gate on battery5 + multi6, inputs-panel 4, raw-and-transport 1, plus the placement-shots first-run flake.

Run: `bun run test`
Expected: green (develop baseline).

Run: `bun run test:e2e 2>&1 | tail -40`
Expected: the known pre-existing failures only. Record the exact list of failing test titles.

- [x] **Step 2: Measure the true actuals behind all five ratchet tables** - measured through a temporary probe calling the same audit functions instead of zeroing the tables (same numbers, no working-tree churn). Full 7x5 matrix recorded in the campaign ledger.

The audit asserts `expect.soft(count).toBeLessThanOrEqual(baseline)`, so a count far below its pin is invisible. To read actuals, temporarily zero every entry of the five tables in `test/e2e/geometry-audit.spec.ts` (`CROSSING_BASELINE:429-437`, `PADDED_GRAZE_BASELINE:452-460`, `CHIP_SEGMENT_BASELINE:487-503`, `CHIP_OFFPATH_BASELINE:504-518`, `OWN_PIERCE_BASELINE:531-539`), run the audit, and harvest the reported counts from the soft-failure messages:

Run: `bunx playwright test geometry-audit 2>&1 | tee /tmp/claude-1000/-home-rins-workspace-STC-workspace-STC/a426295a-8d12-4b8e-8dfe-452f040c30fe/scratchpad/ratchet-actuals-before.txt`

Record a 7-scenario x 5-table matrix of actuals. Expected per issue #34's exam: `battery5-xiranite` chip-segment 23 / off-path 2; `battery5` off-path ~1 actual vs 6 pinned; `equip4` off-path 0 actual vs 7 pinned.

- [x] **Step 3: Revert the zeroed tables** - nothing to revert; the probe was deleted instead and the tree verified clean.

Run: `git checkout -- test/e2e/geometry-audit.spec.ts && git status --short`
Expected: clean tree.

---

### Task 2: Measure the port-model drift in-browser

**Files:**
- Modify (temporarily): `test/e2e/geometry-audit.spec.ts` (a probe describe, removed in Task 3)

**Interfaces:**
- Produces: a measured drift table `{recipe: {sourceDx, targetDx, dy}, product: {sourceDx, targetDx, dy}}` consumed by Task 3. Issue #34's exam reported source x drawn = model + 5 (recipe) / + 4 (product), target x drawn = model - 3, row y drawn = model + 1; this task confirms or replaces those numbers - no repo constant encodes them and the CSS facts (content-box cards with 1px/3px borders, xyflow's 8px handle box translated onto the edge) do not derive them unambiguously.

- [x] **Step 1: Add the probe describe** - the probe reused the audit's own `collectGeometry` and geometry helpers instead of the inline collector below, so the flow frame matches the one every ratchet derives.

Append to `test/e2e/geometry-audit.spec.ts` a new describe. Copy the navigation and locale `beforeEach` verbatim from the `DOM geometry audit` describe at `test/e2e/geometry-audit.spec.ts:222-227` (same `addInitScript` pinning `aef.locale` to `en`, same per-scenario `page.goto` the existing tests use - reuse whatever helper they call). Then for the `battery5-xiranite` and `default` scenarios run:

```ts
test.describe("port drift probe (temporary)", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
    });
  });
  // For each item edge: drawn path endpoints from the SVG `d`, versus the model
  // ports (node flow position + model width 300/148, row y 97 + 22*i). The
  // deltas are the drift table.
  for (const scenario of SCENARIOS.filter((s) =>
    ["default", "battery5-xiranite"].includes(s.id),
  )) {
    test(`drift ${scenario.id}`, async ({ page }) => {
      // ... same goto/wait as the DOM geometry audit describe ...
      const rows = await page.evaluate(() => {
        const vp = document.querySelector(".react-flow__viewport") as HTMLElement;
        const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
        const zoom = m.a;
        const pane = (
          document.querySelector(".react-flow__pane") as HTMLElement
        ).getBoundingClientRect();
        const toFlowX = (cx: number) => (cx - pane.left - m.e) / zoom;
        const toFlowY = (cy: number) => (cy - pane.top - m.f) / zoom;
        const nodes = new Map<
          string,
          { left: number; top: number; h: number; kind: string }
        >();
        for (const el of document.querySelectorAll<HTMLElement>(
          ".react-flow__node",
        )) {
          const r = el.getBoundingClientRect();
          const kind = el.classList.contains("react-flow__node-recipe")
            ? "recipe"
            : el.classList.contains("react-flow__node-product")
              ? "product"
              : "other";
          nodes.set(el.dataset["id"] ?? "", {
            left: toFlowX(r.left),
            top: toFlowY(r.top),
            h: r.height / zoom,
            kind,
          });
        }
        const out: string[] = [];
        for (const edgeEl of document.querySelectorAll<HTMLElement>(
          ".react-flow__edge",
        )) {
          const id = edgeEl.dataset["id"] ?? "";
          const path = edgeEl.querySelector<SVGPathElement>(
            ".react-flow__edge-path",
          );
          const d = path?.getAttribute("d") ?? "";
          const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
          if (nums.length < 4) continue;
          const core = id.replace(/^e:\d+:/, "");
          const arrow = core.indexOf("->");
          if (arrow < 0) continue;
          const src = core.slice(0, arrow);
          const rest = core.slice(arrow + 2);
          const tgt = rest.slice(0, rest.lastIndexOf(":"));
          const s = nodes.get(src);
          const t = nodes.get(tgt);
          if (!s || !t || s.kind === "other" || t.kind === "other") continue;
          const sw = s.kind === "recipe" ? 300 : 148;
          const sx = nums[0]!;
          const sy = nums[1]!;
          const tx = nums[nums.length - 2]!;
          const ty = nums[nums.length - 1]!;
          const dSx = sx - (s.left + sw);
          const dTx = tx - t.left;
          const rowIdx = Math.round((sy - s.top - 97) / 22);
          const dSy =
            s.kind === "recipe"
              ? sy - (s.top + 97 + 22 * rowIdx)
              : sy - (s.top + s.h / 2);
          const tRowIdx = Math.round((ty - t.top - 97) / 22);
          const dTy =
            t.kind === "recipe"
              ? ty - (t.top + 97 + 22 * tRowIdx)
              : ty - (t.top + t.h / 2);
          out.push(
            `${id} src=${s.kind} dSx=${dSx.toFixed(2)} dSy=${dSy.toFixed(2)} tgt=${t.kind} dTx=${dTx.toFixed(2)} dTy=${dTy.toFixed(2)}`,
          );
        }
        return out;
      });
      console.log(rows.join("\n"));
    });
  }
});
```

Two adaptation points when wiring it in: (a) import `SCENARIOS` (or whatever the scenario array is exported as) the same way the neighbouring describes do; (b) the `goto`/wait line is copied from those describes, not invented. The `evaluate` body above is complete as written.

Note the caveat: the DOM node rect is the border-box while the model position is the RF node position - those coincide (RF positions the node div at `position.x/y` and the border grows inward or outward depending on box-sizing), so `s.left` IS the model left. If `dSy` comes out non-constant across rows of one card, the row formula assumption is wrong - stop and investigate `measureRecipe` before proceeding.

- [x] **Step 2: Run the probe and record the drift table** - recipe `{+5, -3, +1}` CONFIRMED; product REPLACED - measured `{+4, -4, 0}`, not the predicted `{4, -3, 1}`. Constant per (kind, side) across all seven scenarios; loop/group endpoints do not occur in the corpus.

Run: `bunx playwright test geometry-audit -g "port drift probe" 2>&1 | tee /tmp/claude-1000/-home-rins-workspace-STC-workspace-STC/a426295a-8d12-4b8e-8dfe-452f040c30fe/scratchpad/port-drift.txt`

Expected: per-edge delta lines. The deltas must be CONSTANT per (node kind, endpoint side) across all edges and both scenarios - that constancy is what makes a static correction valid. Record the four-or-six distinct values. If they are not constant, stop: fix 1's premise fails and the task escalates to the user instead of guessing.

---

### Task 3: Align the seating pass's port model with the drawn handles

**Files:**
- Modify: `src/canvas/chipSeating.ts:669-687` (`edgeEndpoints`)
- Modify (revert): `test/e2e/geometry-audit.spec.ts` (remove the Task 2 probe)

**Interfaces:**
- Consumes: the measured drift table from Task 2.
- Produces: `edgeEndpoints` returning drawn-frame coordinates; every reconstructed polyline, anchor, and seat stamp now lands exactly on the drawn geometry. No signature changes.

- [x] **Step 1: Encode the drift in `edgeEndpoints`** - encoded with the measured product row `{4, -4, 0}`; loop/container get an explicit zero row; the recipe `dy` is skipped on the `nodeHeight/2` fallback path.

In `src/canvas/chipSeating.ts`, above `edgeEndpoints`, add (values from Task 2; the numbers shown are issue #34's reported measurements and stand in only until the probe confirms them):

```ts
// Drawn-vs-model port drift, measured in-browser. The DOM cards carry borders
// outside the model width and xyflow centres its 8px handle box on the bordered
// edge, so the drawn path endpoints sit a few units off the model ports. The
// seating pass promises to reconstruct the DRAWN geometry (labelDx/labelDy are
// applied to the drawn anchor), so it must speak the drawn frame. Re-measure
// these if card borders, padding, or handle sizing change.
const PORT_DRIFT = {
  recipe: { sourceDx: 5, targetDx: -3, dy: 1 },
  product: { sourceDx: 4, targetDx: -3, dy: 1 },
} as const;

function portDrift(node: RFAnyNode): { sourceDx: number; targetDx: number; dy: number } {
  if (node.type === "recipe") return PORT_DRIFT.recipe;
  if (node.type === "product") return PORT_DRIFT.product;
  return { sourceDx: 0, targetDx: 0, dy: 0 };
}
```

Then change the return of `edgeEndpoints`:

```ts
  const sd = portDrift(source);
  const td = portDrift(target);
  return {
    sx: absoluteLeft(source, byId) + nodeWidth(source) + sd.sourceDx,
    sy: absoluteTop(source, byId) + portOffsetY(source, item, "out") + sd.dy,
    tx: absoluteLeft(target, byId) + td.targetDx,
    ty: absoluteTop(target, byId) + portOffsetY(target, item, "in") + td.dy,
  };
```

If Task 2 showed `other`-kind nodes (loop boxes) carrying a consistent nonzero drift, add a third row to `PORT_DRIFT` with those values instead of zeros.

- [x] **Step 2: Check the shared consumer** - green; no `contentBounds`/fit-zoom pin moved. One anchor pin did: the fan-in junction x in `test/canvas/faninMarkers.test.ts`, 900 -> 905.

`edgeEndpoints` is shared by the seating pass and `contentBounds` (the function's own doc comment says both reconstruct the drawn geometry). The drift makes `contentBounds` more accurate but can move fit zoom by a fraction of a percent. Run:

Run: `bun run test && bun run typecheck`
Expected: green. If a `contentBounds`/fit-zoom unit pin fails by a hair (`test/canvas/chipSeating.bounds.test.ts:57,111`), update the pinned expected values to the new computed numbers - that is the drift correction expressing itself, not a regression. Any failure outside bounds/anchor pins is a real break: stop and investigate.

- [x] **Step 3: Remove the Task 2 probe describe** - probe and its temporary `src/canvas/dimensions` import removed together; zero diff in the spec.

Delete the `port drift probe (temporary)` describe from `test/e2e/geometry-audit.spec.ts`.

Run: `git diff --stat test/e2e/geometry-audit.spec.ts`
Expected: no remaining diff in that file.

- [x] **Step 4: Verify against the audit** - the predicted DOWN move did not happen. The 1.00px drift artifact (e:5) is gone as predicted, but the corrected frame moved two other chips' on-line candidate sets and both now take a genuine escape (e:18 17.19px, e:34 20.52px), so `battery5-xiranite` off-path went UP 2 -> 3, not down to 1. Not re-pinned here; escalated, then ratified by the user on 2026-08-20 - see Task 6 Step 2 and the checklist ruling.

Run: `bunx playwright test geometry-audit -g "battery5-xiranite"`
Expected: PASS. Then zero `CHIP_OFFPATH_BASELINE` only (as in Task 1 Step 2), run `bunx playwright test geometry-audit`, and read the off-path actuals plus their reported distances:
- `battery5-xiranite`: 1 violation (the 48.33px escape-tier chip), the 1.00px drift artifact gone.
- The 0.50px residues on other scenarios gone; sub-`tol` values do not appear at all.
Revert the zeroing (`git checkout -- test/e2e/geometry-audit.spec.ts`), then re-pin `CHIP_OFFPATH_BASELINE` downward to the measured actuals (e.g. `"battery5-xiranite": 1`; take every other scenario's measured value from this run, moving only down).

- [x] **Step 5: Regenerate visual baselines shifted by the chip moves** - nothing to regenerate here: placement-shots 7/7 at this commit (crystal's first-run flake passed on rerun). The battery5 golden went stale later, at Task 5's seat moves, and was regenerated in Task 6.

Chips move by up to the drift magnitude (<= 5 units), so committed screenshots may diff:

Run: `bunx playwright test placement-shots`
Expected: pass, or diffs within each scenario's `maxDiffPixels`. If a scenario exceeds its budget, inspect the diff image under `test-results/` - only chip nudges of a few px are acceptable; anything else (edges moving, cards moving) is a break. Regenerate accepted baselines with `bunx playwright test placement-shots --update-snapshots`; they live in the gitignored `test/e2e/__screenshots__/` and are never committed.

- [x] **Step 6: Commit** - commit 9df1371, without the off-path re-pin (escalated) and with the faninMarkers anchor pin instead of a bounds pin.

```bash
git add src/canvas/chipSeating.ts test/e2e/geometry-audit.spec.ts test/canvas/chipSeating.bounds.test.ts
git commit -m "Align seating port model with drawn handle coordinates

- Add measured per-kind port drift to edgeEndpoints
- Re-pin chip off-path baselines to the post-drift actuals"
```

(Drop `test/canvas/chipSeating.bounds.test.ts` from the `git add` if Step 2 changed nothing there.)

---

### Task 4: Least-bad graze - crossing count on the clearance field

**Files:**
- Modify: `src/canvas/chipSeating.ts` (`ClearanceField` type + `makeClearanceField`)
- Test: `test/canvas/chipSeating.seat.test.ts` (graze-tier describe at `:52`)

**Interfaces:**
- Produces: `foreignLineCrossings(box: ChipBox, flowKey: string, target: string, entryBand?: EntryBand, ownIds?: ReadonlySet<string>): number` on `ClearanceField` - the number of foreign (edge, segment) pairs intersecting the box, with exactly `onForeignLine`'s own/cluster exemptions. Counting (edge, segment) pairs deliberately matches what `auditSegmentsVsChips` ratchets, so minimizing the score minimizes the audit count.
- Consumes: existing `segIntersectsChipBox`, `centreInBand`.

- [x] **Step 1: Write the failing test** - placed in its own `ClearanceField` describe (the subject is not `seatRateChip`) and widened to 6 cases so every exemption is covered.

Add to the graze-tier describe in `test/canvas/chipSeating.seat.test.ts` (follow the file's existing fixture style for `EdgeSegments` / `CardRect` construction; the shapes below use the public API only):

```ts
  test("foreignLineCrossings counts intersecting foreign segments", () => {
    // Own flow is "own"; three foreign edges: two verticals crossing the
    // corridor near x=40 and x=56, and one horizontal running parallel 10
    // units below the own line, spanning the whole corridor.
    const field = makeClearanceField(
      [
        { id: "f1", flowKey: "a", target: "other", segs: [[40, 0, 40, 200]] },
        { id: "f2", flowKey: "b", target: "other", segs: [[56, 0, 56, 200]] },
        { id: "f3", flowKey: "c", target: "other", segs: [[0, 110, 1200, 110]] },
      ],
      [],
    );
    const box = { x: 48, y: 100, halfW: 120, halfH: 24 };
    const farBox = { x: 300, y: 100, halfW: 120, halfH: 24 };
    const band = { left: 2000, right: 2100, top: 0, bottom: 200 };
    expect(field.foreignLineCrossings(box, "own", "T", band)).toBe(3);
    expect(field.foreignLineCrossings(farBox, "own", "T", band)).toBe(1);
  });
```

If the file's existing tests build `EdgeSegments` through a helper, use that helper with the same coordinates instead of raw literals.

- [x] **Step 2: Run it to verify it fails**

Run: `bunx vitest run test/canvas/chipSeating.seat.test.ts`
Expected: FAIL - `field.foreignLineCrossings is not a function`.

- [x] **Step 3: Implement the counting method**

In the `ClearanceField` type (`src/canvas/chipSeating.ts:229-253`), add below `onForeignLine`:

```ts
  // Counting sibling of onForeignLine, same own-flow and arrival-cluster
  // exemptions: the number of foreign (edge, segment) pairs intersecting the
  // box. Counts pairs rather than distinct edges because that is what the
  // segment-vs-chip audit ratchets, so a seat minimizing this score minimizes
  // the audited count. Kept separate from the boolean so the hot tier-1 slide
  // keeps its early exit.
  foreignLineCrossings(
    box: ChipBox,
    flowKey: string,
    target: string,
    entryBand?: EntryBand,
    ownIds?: ReadonlySet<string>,
  ): number;
```

In `makeClearanceField`, add below the `onForeignLine` implementation, mirroring its exemption logic exactly:

```ts
    foreignLineCrossings: (box, flowKey, target, entryBand, ownIds) => {
      const clusterExempt =
        entryBand === undefined || centreInBand(box.x, box.y, entryBand);
      let count = 0;
      for (const e of segments) {
        const own = ownIds !== undefined ? ownIds.has(e.id) : e.flowKey === flowKey;
        if (own) continue;
        if (clusterExempt && e.target === target) continue;
        for (const [x0, y0, x1, y1] of e.segs) {
          if (segIntersectsChipBox(x0, y0, x1, y1, box)) count++;
        }
      }
      return count;
    },
```

- [x] **Step 4: Run the test to verify it passes**

Run: `bunx vitest run test/canvas/chipSeating.seat.test.ts`
Expected: PASS (new test and all pre-existing).

- [x] **Step 5: Commit** - commit 4fe5f6d.

```bash
git add src/canvas/chipSeating.ts test/canvas/chipSeating.seat.test.ts
git commit -m "Add foreign-line crossing count to the clearance field"
```

---

### Task 5: Least-bad graze - score the slide instead of taking the first clear seat

**Files:**
- Modify: `src/canvas/chipSeating.ts:630` (the graze fallback inside `seatRateChip`)
- Test: `test/canvas/chipSeating.seat.test.ts` (graze-tier describe)

**Interfaces:**
- Consumes: `foreignLineCrossings` from Task 4; existing locals `slideAlong`'s candidate walk (`anchorLen`, `total`, `pts`, `crossesBarrier`, `boxAt`, `hardClearAt`, `seat`).
- Produces: unchanged `RateSeat` shape; graze seats still carry tier `"graze"`.

- [x] **Step 1: Write the failing test** - added, plus a companion pinning that an all-equal line still seats at the anchor.

Add to the graze-tier describe:

```ts
  test("graze seats at the least-crossed candidate, not the first clear one", () => {
    // Own line runs horizontally (0,100)->(1200,100), anchor at x=48. A
    // parallel foreign line 10 units below poisons every candidate (so tier 1
    // and the sidestep both fail and the ladder reaches graze), and two
    // foreign verticals near the anchor make the anchor a 3-crossing seat.
    // From x=176 the box (halfW 120) sheds both verticals, leaving score 1.
    // First-hit grazing seats at the anchor; least-bad must slide to the
    // first arc step at or past x=176, which is x=192 (48 + 6*24).
    const field = makeClearanceField(
      [
        { id: "f1", flowKey: "a", target: "other", segs: [[40, 0, 40, 200]] },
        { id: "f2", flowKey: "b", target: "other", segs: [[56, 0, 56, 200]] },
        { id: "f3", flowKey: "c", target: "other", segs: [[0, 110, 1200, 110]] },
      ],
      [],
    );
    const seat = seatRateChip(
      field,
      { pts: [[0, 100], [1200, 100]], anchorX: 48, anchorY: 100 },
      "own",
      "T",
      { whole: new Set(), zones: new Map() },
      { left: 2000, right: 2100, top: 0, bottom: 200 },
    );
    expect(seat.tier).toBe("graze");
    expect(seat.dy).toBe(0);
    expect(seat.dx).toBe(144);
  });
```

Adapt the `CardExemption` / `EntryBand` literals to the file's existing fixture helpers if it has them. Sanity of the setup: with no cards and no placed chips, every on-line candidate is hard-clear, so first-hit grazing returns `dx: 0` today.

- [x] **Step 2: Run it to verify it fails**

Run: `bunx vitest run test/canvas/chipSeating.seat.test.ts`
Expected: FAIL with `seat.dx` = 0 (anchor) instead of 144.

- [x] **Step 3: Replace the graze fallback** - preceded by a behaviour-neutral extraction of the shared foreign-edge predicate (commit d744912), which the Task 4 review required before the boolean and the count could share a definition; the scan itself is commit 67b33cd.

In `seatRateChip`, replace the single line at `src/canvas/chipSeating.ts:630`:

```ts
  const grazed = slideAlong(hardClearAt, () => "graze");
  if (grazed !== null) return grazed;
```

with:

```ts
  // Graze, least-bad: no candidate on the line is fully clear, so every seat
  // crosses at least one foreign line (a zero-crossing hard-clear point would
  // have been taken by tier 1). Instead of seating at the FIRST hard-clear
  // candidate - which at saturated counter-scale is usually the anchor, in the
  // thick of the fan - walk the same slide, score every hard-clear candidate
  // by its foreign-line crossings, and take the minimum. Strict less-than
  // keeps the nearest-first, forward-first preference on ties, and a score of
  // 1 is optimal so the walk stops there.
  let bestGraze: { px: number; py: number; score: number } | null = null;
  for (let k = 0; k <= SLIDE_MAX_STEPS && (bestGraze === null || bestGraze.score > 1); k++) {
    const deltas = k === 0 ? [0] : [k * SLIDE_STEP, -k * SLIDE_STEP];
    for (const delta of deltas) {
      const len = anchorLen + delta;
      if (len < 0 || len > total) continue;
      const [px, py] = pathPointAtPts(pts, total === 0 ? 0 : len / total);
      if (crossesBarrier(py)) continue;
      if (!hardClearAt(px, py)) continue;
      const score = field.foreignLineCrossings(
        boxAt(px, py),
        flowKey,
        target,
        entryBand,
        ownIds,
      );
      if (bestGraze === null || score < bestGraze.score) {
        bestGraze = { px, py, score };
      }
    }
  }
  if (bestGraze !== null) return seat(bestGraze.px, bestGraze.py, "graze");
```

- [x] **Step 4: Run the unit suites** - green; no pre-existing pin needed updating.

Run: `bunx vitest run test/canvas/chipSeating.seat.test.ts && bun run test && bun run typecheck && bun run lint`
Expected: all green. Pre-existing graze-tier tests must still pass - they assert tier and clearance invariants, which are preserved; if one pinned an exact `dx/dy` that the scoring legitimately improves, update the pin and say so in the commit body.

- [x] **Step 5: Commit** - commits d744912 + 67b33cd. Corpus chip-segment 24 -> 14 (battery5 5 -> 3, battery5-xiranite 19 -> 11), with off-path, chip-card, raw and crossings all held. e:18 / e:34 were NOT absorbed: an escape seat leaves the line by definition, so on-line rescoring cannot pull it back.

```bash
git add src/canvas/chipSeating.ts test/canvas/chipSeating.seat.test.ts
git commit -m "Seat grazing chips at the least-crossed candidate

The graze tier took the first hard-clear slide candidate, which at
saturated counter-scale is usually the anchor inside the fan. Score
every hard-clear candidate by foreign-line crossings and take the
minimum; hard tiers and the on-own-line preference are unchanged."
```

---

### Task 6: Re-pin the ratchets and record the rulings

**Files:**
- Modify: `test/e2e/geometry-audit.spec.ts` (five baseline tables + the NOTE comment block at `:385-393`)

**Interfaces:**
- Consumes: Task 1's before-matrix, Tasks 3+5 landed.

- [x] **Step 1: Measure the after-actuals** - measured with the same probe as Tasks 1 and 3; nothing rose on any scenario relative to Task 5.

Zero all five tables (as in Task 1 Step 2), run the full audit, harvest the 7x5 matrix:

Run: `bunx playwright test geometry-audit 2>&1 | tee /tmp/claude-1000/-home-rins-workspace-STC-workspace-STC/a426295a-8d12-4b8e-8dfe-452f040c30fe/scratchpad/ratchet-actuals-after.txt`

Expected direction (from issue #34's inventory): `battery5-xiranite` chip-segment well below 23 (the e:20 seven-hit chip and the x=522 four-fan grazes should relocate); `battery5` chip-segment below 29; off-path unchanged from Task 3's re-pin. Every scenario must be at or below its Task 1 before-actual - a rise anywhere is a regression: stop, diagnose with the audit's violation listings, do not re-pin upward.

- [x] **Step 2: Restore the tables with the measured values** - four moves, not the wholesale slack the plan expected: three DOWN (chip-segment battery5 5 -> 3 and battery5-xiranite 23 -> 11, padded graze multi6 13 -> 12) and one UP, off-path battery5-xiranite 2 -> 3, taken only under the user's explicit ruling. Every other entry already equalled its actual - the battery5 off-path 6 and equip4 off-path 7 the plan expected to bank were already pinned at their actuals.

Revert the zeroing, then set every entry of all five tables to its measured after-actual wherever that is LOWER than the current pin (this also banks the slack the issue flagged: battery5 off-path 6 -> measured, equip4 off-path 7 -> measured, default/crystal/tundra to their actuals). Leave any entry whose actual equals its pin untouched.

- [x] **Step 3: Record the multi6 caveat in the NOTE block** - added verbatim above the off-path table, alongside the ruling NOTE for the off-path raise and a note above `CHIP_SEGMENT_BASELINE` recording the DOWN move.

Extend the NOTE comment block at `test/e2e/geometry-audit.spec.ts:385-393` with:

```ts
// multi6 is unmeasured rather than clean at fit zoom 0.21: both LOD gates
// suppress every label chip there, and the surviving gate-exempt bus chips are
// skipped by the off-path audit (label kind only). Four of those bus chips sit
// 144-192 units off their own path today. If a fit-zoom change ever lifts
// multi6 past the label gate, expect its counts to jump for battery5-xiranite
// reasons, not because that change broke anything.
```

- [x] **Step 4: Full verification** - unit, typecheck and lint green; e2e failure list identical to Task 1's. battery5's placement-shots golden was stale (uniform ~10px camera shift plus two chips slid along their own lines, nothing stranded) and was regenerated after inspecting the diff; goldens are gitignored, so nothing tracked changed.

Run: `bunx playwright test geometry-audit && bun run test && bun run typecheck && bun run lint`
Expected: all green with the tightened pins.

Run: `bun run test:e2e 2>&1 | tail -40`
Expected: exactly the Task 1 failure list, nothing new. If placement-shots diffs exceed budgets from the graze moves, inspect the diff images (chip relocations along their own lines are the expected change), regenerate the gitignored baselines with `--update-snapshots`, and re-inspect.

- [x] **Step 5: Commit** - three commits: 36dd28f (re-pins and NOTEs), 25ee8cc (tie-rule test), 1ca390d (comment rewrap).

```bash
git add test/e2e/geometry-audit.spec.ts
git commit -m "Tighten geometry ratchets to post-fix actuals

- Re-pin all five baseline tables to measured counts, downward only
- Note the multi6 LOD blind spot beside the ratchet rules"
```

---

### Task 7: Visual verification and close-out

**Files:**
- No tracked changes. Captures go to the scratchpad, not the repo.

- [x] **Step 1: Capture and inspect (mandatory protocol)** - fit shots plus zoom-1.0 crops of the named chips, captured with a scratch CLI rather than the exam harness (the harness tiles whole plans). battery5, battery5-xiranite, default and equip4 inspected; multi6 excluded as an LOD blind spot. The x=522 trunk column now pierces one chip instead of two, the sewage run is down from three consecutive segments to one, e:18 and e:34 are least-bad seats binding unambiguously to their own cards (e:34 covers part of its own tap subtitle - legibility nit, recorded not fixed), and the 48.33px escape chip remains, out of scope as predicted.

With the audit's preview server (`bun run build && bun run preview --port 4173 --strictPort` if not already up), capture via playwright: the default plan at fit, `battery5-xiranite` at fit, and zoomed crops of the four locations issue #34 names (the x=522 gas trunk column, the x=2292 sewage run, the two Xircon Effluent chips). Compare against the issue's before-description: the four-fan trunk should no longer pierce both chips at their old seats, the sewage triple-pierce should relocate or shrink, the 48.33px chip is expected to REMAIN off-path (escape tier - out of scope, say so rather than hiding it). Inspect for wrongness, not presence: chips still on their own polylines, no new overlaps introduced at the relocated seats.

- [x] **Step 2: Push, open the PR** - PR #47 to `develop`, "Improve rate-chip seating on packed plans", humanizer-passed, before/after ratchet matrix in Testing, CI green, not merged.

Open a PR to `develop` following the repo's PR guideline (goal-focused imperative title, Summary / Changes / Testing with facts-only evidence; run title and body through the humanizer skill first). Include the before/after ratchet matrix in Testing.

- [x] **Step 3: Draft the issue #34 comment** - drafted with the measured numbers (off-path 2 -> 3 under the ruling rather than 2 -> 1; chip-segment battery5-xiranite 23 -> 11, battery5 5 -> 3), not posted; open-vs-close left to the user.

Post on issue #34 (adjusting numbers to the measured results):

> Landed on `fix/chip-seating` (PR #NN): the port-model drift is folded into `edgeEndpoints` (off-path baseline battery5-xiranite 2 -> 1; the 0.50-1.00px residues are gone), and the graze tier now scores hard-clear candidates by foreign-line crossings and takes the minimum (chip-segment battery5-xiranite 23 -> N, battery5 29 -> N). All five ratchet tables re-pinned to measured actuals, downward only.
>
> Deferred, per the exam's own analysis: the family cannot reach zero while a 240-unit chip box sits in corridors of 110-160 units - eliminating it needs one of the ADR-scale changes (larger `BETWEEN_LAYERS_SPACING`, lower `MAX_CHIP_SCALE`, or a lane/gutter allocation at saturated zoom). Width estimation at seat time is rejected (no text metrics offline; an underestimate breaches the hard chip-vs-chip tier). Counting visual collisions instead of (edge, segment) pairs re-bases every ratchet and needs its own ruling. The multi6 LOD blind spot is now noted beside the ratchet rules.

Leave the issue OPEN if the deferred ADR-scale work should stay tracked there, or close it and file a slimmer follow-up - user's call at review time.

---

## Verification checklist (whole plan)

- [x] `bun run test`, `bun run typecheck`, `bun run lint` green (128 files, 1340 pass + 1 skip)
- [x] `bunx playwright test geometry-audit` green with tightened pins, except the pre-existing ratified RAW gate on battery5 + multi6, which stays red; one baseline was raised, under the ruling below
- [x] `bun run test:e2e` failure list identical to the Task 1 recording
- [x] Off-path: battery5-xiranite pinned at 3, NOT the 1 this plan predicted. RULING (user, 2026-08-20): the raise 2 -> 3 is accepted. The port-drift correction exposed rather than caused two genuine least-bad escape seats (e:18 17.19px, e:34 20.52px) of the #41 short-corridor family, whose slab-spacing fix is the remedy; the 1.00px artifact the plan predicted away is indeed gone, and the seat tiers cannot absorb an escape. Recorded in the spec's ruling NOTE block, taking the standing count to six.
- [x] Chip-segment: battery5-xiranite 23 -> 11 and battery5 3 (its pin was 5, not the 29 this plan assumed); corpus 24 -> 14
- [x] No probe or zeroed-table residue in the committed spec
- [x] Visual captures inspected; PR #47 opened to develop; issue #34 comment drafted, not posted
