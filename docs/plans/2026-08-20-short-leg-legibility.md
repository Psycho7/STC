# Short-Leg Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issues #42, #41, and #43: recipe-row item names stop colliding after truncation, chips stop burying their own endpoint cards on short legs, and coincident fan-outs get a visible divergence marker.

**Architecture:** Four independent fixes, sequenced so the structural one lands first among the geometry changes: (1) a pure-CSS row-chrome diet in `canvas.css` (#42, zero geometry impact); (2) explicit ELK spacing options on loop-slab containers so slab interiors get real inter-layer corridors (#41 direction D, shared remedy for #43); (3) a short-leg flag stamped by `deconflictChipAnchors` into `edge.data` that collapses the rate chip to the existing `.icon-only` variant (#41 direction C); (4) a divergence `JunctionDot` stamped for plain-ItemEdge fan-out groups that `routeFanoutEdges` declines (#43 direction B). Fixes 2-4 each end with a geometry-audit re-measure and downward ratchet re-pin.

**Tech Stack:** Vite + React 19 + TS, @xyflow/react, elkjs, vitest (unit), Playwright 1.59.1 (e2e, NOT in CI), bun.

## Global Constraints

- Worktree: `/home/rins/workspace/STC-workspace/STC/.claude/worktrees/fix/short-leg-legibility` (branch `fix/short-leg-legibility` off develop@71d5a58). All paths below are relative to it.
- RAM: the box has 3.2GB total. Wrap every heavy command: `systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- <cmd>`. Never let Playwright's webServer chain the build: run `bun run build` alone first, then `bun run preview --port 4173 --strictPort` in background (`reuseExistingServer` picks it up). One scenario per `bunx playwright test` invocation via `-g <scenario-id>`. Chromium-1217 is installed; never install browsers. Never `pkill -f "vite preview"` (matches the calling shell's own cmdline).
- Ratchets (`test/e2e/geometry-audit.spec.ts`): five baseline tables, all `expect.soft`. Soft passes hide actuals - harvest via a temporary probe spec calling the same audit functions, then delete it. DOWN re-pins are free; an UP move needs an explicit user ruling recorded in the ruling NOTE block at geometry-audit.spec.ts:251-284 (six rulings stand - keep the enumeration correct).
- Expected-red e2e baseline (pre-existing on develop, NOT regressions): geometry-audit battery5 + multi6 tier-1 RAW soft failures (ratified family); inputs-panel 4 + raw-and-transport 1 (strict-mode product-node pin family); placement-shots fails 7/7 on the first run in a fresh worktree, passes on rerun. multi6 fit zoom 0.21 suppresses all label chips (off-path blind spot).
- Goldens (`test/e2e/__screenshots__/`) are gitignored and local; regeneration is a ledger note, never a commit.
- ASCII only in code, comments, and commit messages. Commit per task, imperative mood. Do not mention external docs or issue numbers' Markdown files in commits (bare `#NN` issue refs are fine).
- Visual verification is MANDATORY after each render-affecting task (Tasks 3-6): geometric probe + default-plan fit captures + zoomed crops, inspected for wrongness, not just presence.
- `gh pr merge` and `git stash` are classifier-blocked; the user merges. `gh issue comment`, `gh pr create`, `git push` are allowed. Merges target `develop`, so Closes-keywords never fire - issues are closed manually with evidence comments.
- Stale LSP diagnostics fire after subagent edits - trust `bunx tsc --noEmit`, not the diagnostics block.

---

### Task 1: Commit the plan and harvest the pre-change ratchet actuals

**Files:**
- Create: `docs/plans/2026-08-20-short-leg-legibility.md` (this file)
- Create (temporary): `test/e2e/ratchet-probe.spec.ts` - deleted again in this task
- Ledger: `.superpowers/sdd/progress.md` (gitignored)

**Interfaces:**
- Produces: a recorded table of pre-change actuals for all five audits x seven scenarios in the ledger. Later tasks diff against it.

- [ ] **Step 1: Commit the plan doc**

```bash
git add docs/plans/2026-08-20-short-leg-legibility.md
git commit -m "Add short-leg legibility campaign plan"
```

- [ ] **Step 2: Build and start the preview server**

```bash
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- bun run build
# then, in background:
bun run preview --port 4173 --strictPort
```
Expected: build green (tsc + vite), preview serving on 4173.

- [ ] **Step 3: Write the temporary probe spec**

Create `test/e2e/ratchet-probe.spec.ts`. It mirrors the segment-placement describe in `geometry-audit.spec.ts:462-612` (same imports from `./geometry`, `./collect`, `./scenarios`, same `loadScenario`/`waitForCanvasReady`/`waitForStableViewport` local helpers copied from geometry-audit.spec.ts:42-71 and :439-444) but instead of asserting, logs one line per scenario:

```ts
console.log(
  `${scenario.id}: crossings=${crossings} paddedGrazes=${grazes.length} ` +
    `chipSeg=${chipHits.length} offPath=${offPath.length} ownPierce=${pierces.length}`,
);
```

using the exact same audit calls the ratchet tiers use (`countCrossings`, the padded-graze audit, `auditSegmentsVsChips`, `auditChipsOnOwnPath`, `auditOwnCardPierces`).

- [ ] **Step 4: Run the probe, one scenario per invocation**

```bash
for s in default battery5 battery5-xiranite crystal equip4 multi6 tundra:
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- \
  bunx playwright test test/e2e/ratchet-probe.spec.ts -g "<s>"
```
Expected: printed actuals match the committed baselines (CROSSING default 9 / battery5 8 / battery5-xiranite 56 / crystal 1 / equip4 1 / multi6 415 / tundra 0; PADDED_GRAZE 0/8/3/3/3/12/0; CHIP_SEGMENT 0/3/11/0/1/0/0; CHIP_OFFPATH 0/1/3/0/0/0/0; OWN_PIERCE 0/0/2/0/0/0/0). Record the full table in the ledger. Any mismatch vs the committed tables is a STOP - report before proceeding.

- [ ] **Step 5: Delete the probe and verify clean tree**

```bash
rm test/e2e/ratchet-probe.spec.ts
git status --short   # only untracked run artifacts, no tracked changes
```

---

### Task 2: #42 - recipe-row chrome diet with collision guard (TDD)

**Files:**
- Create: `test/e2e/row-collisions.spec.ts`
- Modify: `src/canvas/canvas.css:2053-2082` (`.rn-row`, `.rn-row.input`, `.rn-row.output`)

**Interfaces:**
- Consumes: nothing from other tasks (fully independent; zero ELK/ratchet impact - `RECIPE_WIDTH`, `RECIPE_ROW_HEIGHT`, port handles untouched).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Write the failing collision-guard spec**

Create `test/e2e/row-collisions.spec.ts`. Pattern follows `test/e2e/title-truncation.spec.ts` (en-locale seed via `addInitScript`, wait on rendered rows) but loads two scenarios via `scenarioHash` and asserts zero within-card visible-string collisions:

```ts
import { expect, test } from "@playwright/test";
import { SCENARIOS, scenarioHash } from "./scenarios";

// Issue #42: fixed row chrome left .rn-row .lbl 65-83px of a 150px half-card,
// so sibling rows sharing a long prefix ellipsized to the byte-identical
// visible string ("Dense Orig..." twice on equip4's Refining Unit). Guard the
// reader-facing failure directly: no two DIFFERENT item names inside one card
// may render the same visible string. Stronger and more stable than asserting
// zero clipped rows (some truncation is fine while strings stay distinct).
for (const id of ["default", "equip4"] as const) {
  test(`no within-card visible-string collisions: ${id}`, async ({ page }) => {
    const scenario = SCENARIOS.find((s) => s.id === id)!;
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
    });
    await page.goto("/#" + (await scenarioHash(scenario)), {
      waitUntil: "load",
    });
    await page
      .locator(".rn-row .lbl")
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    const collisions = await page.evaluate(() => {
      const out: string[] = [];
      for (const card of document.querySelectorAll(".recipe-node")) {
        const seen = new Map<string, string>();
        for (const el of card.querySelectorAll<HTMLElement>(".rn-row .lbl")) {
          const full = el.textContent ?? "";
          let visible = full;
          if (el.scrollWidth > el.clientWidth + 1) {
            // Binary-search the longest prefix that fits with the ellipsis,
            // measured in the label's own font.
            const probe = document.createElement("span");
            probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${getComputedStyle(el).font}`;
            document.body.appendChild(probe);
            let lo = 0;
            let hi = full.length;
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1;
              probe.textContent = full.slice(0, mid) + "…";
              if (probe.getBoundingClientRect().width <= el.clientWidth)
                lo = mid;
              else hi = mid - 1;
            }
            visible = full.slice(0, lo) + "…";
            probe.remove();
          }
          const prev = seen.get(visible);
          if (prev !== undefined && prev !== full) {
            out.push(`"${visible}": "${prev}" vs "${full}"`);
          }
          seen.set(visible, full);
        }
      }
      return out;
    });
    expect(collisions).toEqual([]);
  });
}
```

Note: check how `title-truncation.spec.ts:9-11` actually seeds the locale and copy that exact mechanism (it may set `aef.locale` differently); the snippet above is the intent, the existing spec is the authority.

- [ ] **Step 2: Run it to verify it fails on equip4**

```bash
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- \
  bunx playwright test test/e2e/row-collisions.spec.ts -g "equip4"
```
Expected: FAIL with two collisions ("Dense Ori..." pair and "Originiu..." pair). Also run `-g "default"`: expected PASS (0 collisions even pre-fix).

- [ ] **Step 3: Apply the row-chrome diet**

In `src/canvas/canvas.css`:

```css
.rn-row {
  display: flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 6px;
  font-size: 12px;
  line-height: 1;
  position: relative;
}

.rn-row.input {
  padding-left: 8px;
}

.rn-row.output {
  padding-right: 8px;
  flex-direction: row-reverse;
}
```

(was: gap 8px, padding 0 12px, outer 14px). The 8px outer pad still clears the accent tab (5px wide at left/right -1, canvas.css:2109-2131). Add a one-line comment on `.rn-row` stating the constraint: the label is the only flexible item against a hard 300px card, so row chrome is kept to the minimum that clears the accent tab.

- [ ] **Step 4: Rebuild, verify the guard passes and nothing else regressed**

```bash
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- bun run build
systemd-run ... -- bunx playwright test test/e2e/row-collisions.spec.ts -g "equip4"
systemd-run ... -- bunx playwright test test/e2e/row-collisions.spec.ts -g "default"
systemd-run ... -- bunx playwright test test/e2e/title-truncation.spec.ts
```
Expected: all PASS. Visual check: capture equip4 fit + a Refining Unit zoom crop; both "Dense Orig..." rows must now read distinctly (83px reaches past the divergence point).

- [ ] **Step 5: Commit**

```bash
git add src/canvas/canvas.css test/e2e/row-collisions.spec.ts
git commit -m "Slim recipe-row chrome so item names stay distinguishable (#42)"
```

---

### Task 3: #41-D - real inter-layer spacing inside loop slabs

**Files:**
- Modify: `src/canvas/layout.ts:355-367` (container `layoutOptions` block)
- Create: `test/canvas/slabSpacing.test.ts`

**Interfaces:**
- Consumes: `NODE_NODE_SPACING` (30), `BETWEEN_LAYERS_SPACING` (110) from `src/canvas/dimensions.ts:67,71`.
- Produces: slab-interior corridors >= BETWEEN_LAYERS_SPACING. Task 4 re-measures everything downstream; Task 6 re-checks whether battery5's Seed-Picking fan-out still declines `FANOUT_SPAN_MIN`.

Background (from the #41/#43 diagnoses): loop-slab containers declare only padding, so their interior layout falls back to ~30gu corridors while open layout gets 110; 20 of the 48 own-card chip overlaps sit in those 34gu corridors, and battery5's 28gu fan-out gap is the same defect. The two user-ratified escape seats (e:18/e:34, offPath battery5-xiranite baseline 3) are in this family and should disappear.

- [ ] **Step 1: Write the failing corridor test**

Create `test/canvas/slabSpacing.test.ts`. Reuse the container fixture pattern from `test/canvas/layout-mapping.test.ts:181` ("nests blueprint-group members as children of the container node") - build a plan whose container holds two recipe units connected by an edge so ELK layers them horizontally, run the layout, and assert the corridor:

```ts
import { describe, expect, it } from "vitest";
import { BETWEEN_LAYERS_SPACING } from "../../src/canvas/dimensions";
// reuse the plan-builder helpers layout-mapping.test.ts uses (same imports)

describe("loop-slab interior spacing", () => {
  it("gives slab members a full inter-layer corridor", async () => {
    // plan: container "lc:1" with members u:a -> u:b (one edge between them)
    const nodes = await layoutPlanFromFixture(); // adapt the :181 fixture
    const members = nodes.filter((n) => n.parentId === "lc:1");
    expect(members.length).toBe(2);
    const [left, right] = [...members].sort(
      (a, b) => a.position.x - b.position.x,
    );
    const gap =
      right!.position.x - (left!.position.x + (left!.width ?? 0));
    expect(gap).toBeGreaterThanOrEqual(BETWEEN_LAYERS_SPACING);
  });
});
```

The fixture-builder call is whatever `layout-mapping.test.ts` names it - read that file first and mirror it exactly; do not invent a parallel harness.

- [ ] **Step 2: Run it to verify it fails**

```bash
systemd-run --user --scope -q -p MemoryMax=2200M -p MemorySwapMax=512M -- \
  bunx vitest run test/canvas/slabSpacing.test.ts
```
Expected: FAIL - gap ~30 (the NODE_NODE_SPACING fallback), well under 110.

- [ ] **Step 3: Add explicit spacing options to the container block**

In `src/canvas/layout.ts:360-365`, extend the container `layoutOptions`:

```ts
      layoutOptions: {
        // Reserve a taller top band for the caption strip so a member card
        // flush against the corner cannot cover the "LOOP - N" label; keep the
        // other sides tight so members do not leave large empty quadrants.
        "org.eclipse.elk.padding": "[top=28,left=10,bottom=10,right=10]",
        // Slab interiors do not inherit the root spacing pair: without these
        // the members pack at the plain node-node distance (~30) and the
        // corridor cannot hold a rate chip (chips are ~99-110 units wide), so
        // every chip in a slab buries its own endpoint card. Mirror the root
        // values so a slab corridor equals an open-layout corridor.
        "elk.spacing.nodeNode": String(NODE_NODE_SPACING),
        "elk.layered.spacing.nodeNodeBetweenLayers": String(
          BETWEEN_LAYERS_SPACING,
        ),
      },
```

If Step 4 still fails with gap ~30, the corridor is a same-layer node-node gap, not a between-layers gap: then raise the container's `elk.spacing.nodeNode` to `String(BETWEEN_LAYERS_SPACING)` instead and note in the comment that within a slab the two spacings are deliberately equal. Decide from the measured failure, not by guessing.

- [ ] **Step 4: Run the test until it passes, then the full unit suite**

```bash
systemd-run ... -- bunx vitest run test/canvas/slabSpacing.test.ts   # PASS
systemd-run ... -- bunx vitest run                                    # full suite
```
Expected: full suite green. No unit test pins the container option string today (verified), so failures mean real geometry fallout - investigate, do not blind-fix.

- [ ] **Step 5: Commit**

```bash
git add src/canvas/layout.ts test/canvas/slabSpacing.test.ts
git commit -m "Give loop-slab interiors real inter-layer spacing (#41)"
```

---

### Task 4: Post-slab-spacing re-measure and downward re-pin

**Files:**
- Modify: `test/e2e/geometry-audit.spec.ts:305-437` (the five baseline tables)
- Create (temporary): `test/e2e/ratchet-probe.spec.ts` (same probe as Task 1, deleted again)
- Ledger: record the full before/after table and the battery5 fan-out gap.

**Interfaces:**
- Consumes: Task 3's layout change.
- Produces: re-pinned baselines that Tasks 5-6 measure against; the battery5 Seed-Picking gap measurement that decides Task 6's scope.

- [ ] **Step 1: Rebuild and harvest actuals**

Recreate the Task-1 probe, rebuild, run all seven scenarios one per invocation (same commands as Task 1 Steps 2-4). Record actuals in the ledger next to the Task-1 table.

- [ ] **Step 2: Interpret the moves**

Expected direction: battery5 / battery5-xiranite / multi6 chipSeg and offPath DOWN (the 20-of-48 slab population dissolves; the two ratified escape seats e:18/e:34 should vanish - offPath battery5-xiranite 3 -> 1 or 0). Crossings and grazes may move EITHER way (wider slabs shift wrap and gutters). Any UP move: STOP and present it to the user for a ruling before re-pinning - never silently accommodate.

- [ ] **Step 3: Re-pin the tables downward**

Edit the five tables in `geometry-audit.spec.ts` to the new actuals (DOWN moves only, per the ruling NOTE contract). If the e:18/e:34 seats vanished, also revert the ratified offPath comment sentence for battery5-xiranite in the NOTE block to record the ruling as retired (keep the enumeration accurate: state the port-drift raise was superseded by the slab-spacing fix, do not delete history).

- [ ] **Step 4: Measure the battery5 fan-out gap for Task 6**

With the preview still up, load battery5 in the probe (or via `collectGeometry`) and measure the Seed-Picking -> Planting layer gap that was 28gu. Record whether it now exceeds `FANOUT_SPAN_MIN` (64): if yes, `routeFanoutEdges` claims the group and it gets a junction dot via BusEdge already - Task 6 then targets remaining declined groups generally, with battery5 as a regression check instead of the repro.

- [ ] **Step 5: Run geometry-audit for the seven scenarios**

One scenario per invocation. Expected: green except the expected-red families (battery5 + multi6 tier-1 RAW). Delete the probe spec.

- [ ] **Step 6: Visual verification (mandatory)**

Fit captures + slab zoom crops for battery5, battery5-xiranite, multi6, default. Inspect: slab corridors visibly hold chips clear of cards; no new pathology (giant slabs, broken wrap, caption overlap). Record capture paths in the ledger.

- [ ] **Step 7: Commit**

```bash
git add test/e2e/geometry-audit.spec.ts
git commit -m "Re-pin geometry ratchets after slab spacing fix"
```

---

### Task 5: #41-C - collapse chips to icon-only on short legs

**Files:**
- Modify: `src/canvas/chipSeating.ts` (item phase + final stamping in `deconflictChipAnchors`)
- Modify: `src/canvas/ItemEdge.tsx` (`ItemEdgeData` type :17-112, `FlowChip` :192-289, rate-chip call site :504-519)
- Create: `test/canvas/shortLegChips.test.ts`

**Interfaces:**
- Consumes: `CHIP_HALF_W_WIDE` (chipSeating.ts:69), the item-phase `ItemGeom.pts` (chipSeating.ts:847-852), the `edge.data` stamping pattern (chipSeating.ts:1683-1755), `FlowChip`'s `iconOnly` gate (ItemEdge.tsx:250-252).
- Produces: `ItemEdgeData.chipIconOnly?: boolean` (stamped on edges whose polyline is shorter than one chip); `FlowChip` prop `compact?: boolean`.

- [ ] **Step 1: Write the failing seating test**

Create `test/canvas/shortLegChips.test.ts`, mirroring the harness in `test/canvas/faninMarkers.test.ts` (synthetic nodes + edges through `deconflictChipAnchors` - read that file and reuse its node/edge builders' shape):

```ts
import { describe, expect, it } from "vitest";
import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
// node/edge builders mirrored from faninMarkers.test.ts

describe("short-leg icon-only flag", () => {
  it("stamps chipIconOnly on an edge shorter than one chip", () => {
    // one edge whose whole polyline is ~28 units (source and target cards
    // 28 units apart, straight leg) - mirrors battery5's e:8
    const out = deconflictChipAnchors(nodes, [shortEdge]);
    expect(out[0]!.data?.["chipIconOnly"]).toBe(true);
  });

  it("leaves a full-corridor edge unflagged", () => {
    // straight leg ~130 units (an open-layout corridor)
    const out = deconflictChipAnchors(nodes, [longEdge]);
    expect(out[0]!.data?.["chipIconOnly"]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify both fail** (`bunx vitest run test/canvas/shortLegChips.test.ts` under systemd-run). Expected: FAIL - flag never stamped.

- [ ] **Step 3: Implement the flag in chipSeating.ts**

Near `CHIP_HALF_W_WIDE` (:69):

```ts
// A leg shorter than this cannot hold the full rate chip anywhere on its own
// line (rendered chips measure ~99-110 units; slideAlong clamps to the arc, so
// on such a leg the anchor is the only candidate). Those chips collapse to the
// icon-only variant instead of burying their endpoint cards; the exact rate
// stays on the hover title.
const SHORT_LEG_MAX = CHIP_HALF_W_WIDE;
```

In the item phase (where `ItemGeom` is built, ~:910), accumulate polyline length with the same inline loop `seatRateChip` uses (chipSeating.ts:593-599) and collect flagged indices:

```ts
const shortLegByIndex = new Set<number>();
// inside the per-item-edge loop, after geom.pts is available:
let legLen = 0;
for (let i = 1; i < geom.pts.length; i++) {
  legLen += Math.hypot(
    geom.pts[i]![0] - geom.pts[i - 1]![0],
    geom.pts[i]![1] - geom.pts[i - 1]![1],
  );
}
if (legLen < SHORT_LEG_MAX) shortLegByIndex.add(index);
```

In the final `edges.map` stamping block (:1683-1755), alongside `labelDx`/`labelDy`:

```ts
...(shortLegByIndex.has(i) ? { chipIconOnly: true } : {}),
```

- [ ] **Step 4: Thread it through ItemEdge**

`ItemEdgeData` (ItemEdge.tsx:17-112): add

```ts
  // Stamped by the seating pass on an edge whose whole polyline is shorter
  // than one rendered chip: the chip renders icon-only (rate on hover) because
  // no seat on the line can hold the full box.
  chipIconOnly?: boolean;
```

`FlowChip` (:192-289): add prop `compact?: boolean | undefined` and widen the gate at :250-252:

```ts
  const iconOnly =
    (compact === true ||
      (zoom !== undefined && zoom < CHIP_ICON_ONLY_MAX_ZOOM)) &&
    !focused;
```

Rate-chip call site (:504-519): pass `compact={edgeData?.chipIconOnly === true}`. Do NOT pass it to the Sigma call site (:554-568) - aggregates keep their digits.

- [ ] **Step 5: Run the new tests, then the full unit suite**

```bash
systemd-run ... -- bunx vitest run test/canvas/shortLegChips.test.ts  # PASS
systemd-run ... -- bunx vitest run                                     # full suite green
```

- [ ] **Step 6: Commit**

```bash
git add src/canvas/chipSeating.ts src/canvas/ItemEdge.tsx test/canvas/shortLegChips.test.ts
git commit -m "Collapse rate chips to icon-only on legs shorter than a chip (#41)"
```

---

### Task 6: #43-B - divergence junction dot for declined fan-outs

**Files:**
- Modify: `src/canvas/chipSeating.ts` (new stamp block in `deconflictChipAnchors`, near the fan-in block :1394-1579)
- Modify: `src/canvas/ItemEdge.tsx` (`ItemEdgeData` + render block near the fan-in dot :534-546)
- Create: `test/canvas/fanoutMarkers.test.ts`

**Interfaces:**
- Consumes: `flowKeyOf` (chipSeating.ts:844-845), `FANIN_EPS` (:1396), `ItemGeom.pts`, the fan-in junction stamp pattern (`faninJunctionByIndex`, :1552; stamped :1730-1743), `JunctionDot` (ItemEdge.tsx:323-354), the staleness-guard pattern (:401-415).
- Produces: `ItemEdgeData.fanoutJunctionX?/fanoutJunctionY?: number` stamped on one owner edge per declined fan-out group.

Scope note: real fan-out trunks (`routeFanoutEdges`, gap in (64, 410]) already draw dots via BusEdge. This task covers groups left as plain ItemEdges. If Task 4 found battery5's group now routes as a real fan-out, battery5 becomes the regression check (a dot must exist, from either subsystem) and the unit test is the repro.

- [ ] **Step 1: Write the failing marker test**

Create `test/canvas/fanoutMarkers.test.ts`, same harness as `faninMarkers.test.ts`:

```ts
describe("declined fan-out divergence dot", () => {
  it("stamps the owner with the divergence point", () => {
    // two item edges, same item, same source port, distinct targets,
    // 28-unit gap (below FANOUT_SPAN_MIN): e:a straight, e:b bends down
    // after a shared horizontal prefix
    const out = deconflictChipAnchors(nodes, [edgeA, edgeB]);
    const owner = out.find((e) => e.id === "e:a")!; // lex-smallest id
    expect(owner.data?.["fanoutJunctionX"]).toBe(/* last shared x */);
    expect(owner.data?.["fanoutJunctionY"]).toBe(/* source port y */);
    expect(out.find((e) => e.id === "e:b")!.data?.["fanoutJunctionX"]).toBeUndefined();
  });

  it("stamps nothing for a single edge", () => { /* one edge -> no stamp */ });

  it("stamps nothing for a parallel bundle into one target", () => {
    /* two edges same source AND same target -> no stamp (not a fan-out) */
  });
});
```

Fill the expected junction values from the synthetic geometry (e.g. source right edge x=900+drift, straight prefix to the bent member's last on-row vertex).

- [ ] **Step 2: Run to verify it fails.** Expected: FAIL - no `fanoutJunctionX` stamped.

- [ ] **Step 3: Implement the stamp in chipSeating.ts**

New block in `deconflictChipAnchors`, after the fan-in group election (so it can reuse the same index/geometry maps), commented as the #43 counterpart:

```ts
  // Declined fan-outs (#43): N >= 2 same-(item, source) item edges into >= 2
  // distinct targets whose gap fell below FANOUT_SPAN_MIN stay plain ItemEdges
  // with coincident prefixes -- the reader gets no signal a split happened and
  // reads a member rate as the trunk rate. Mark the divergence with a junction
  // dot on one owner edge. No aggregate chip: a total would sit a few pixels
  // from the source card's own output row (the #39 redundancy) and the run is
  // too short to hold it anyway.
  const fanoutJunctionByIndex = new Map<number, { x: number; y: number }>();
  const fanoutGroups = new Map<number, number[]>(); // keyed like flowKeyOf via a map from key->indices
  // group plain item edges by flowKeyOf; skip groups with < 2 members or < 2
  // distinct targets. For each member, walk its pts: the divergence candidate
  // is the last vertex x before the path first leaves the source row
  // (|y - sy| > FANIN_EPS). junctionX = min over bent members; skip the group
  // if no member bends or junctionX is not strictly past the source point.
  // Owner = lexicographically smallest edge id (mirrors the fan-in election).
```

Concrete divergence walk per member (pts from `ItemGeom`):

```ts
const sy = pts[0]![1];
let bendX: number | undefined;
for (let i = 1; i < pts.length; i++) {
  if (Math.abs(pts[i]![1] - sy) > FANIN_EPS) {
    bendX = pts[i - 1]![0];
    break;
  }
}
```

Stamp in the final `edges.map` exactly like `faninJunctionByIndex` (:1730-1743):

```ts
...(fanoutJunctionByIndex.has(i)
  ? {
      fanoutJunctionX: fanoutJunctionByIndex.get(i)!.x,
      fanoutJunctionY: fanoutJunctionByIndex.get(i)!.y,
    }
  : {}),
```

- [ ] **Step 4: Render it in ItemEdge.tsx**

`ItemEdgeData`: add `fanoutJunctionX?: number; fanoutJunctionY?: number;` with a comment naming the #43 declined-fan-out contract. Next to the fan-in guards (:401-415):

```ts
  const fanoutMarkerLive =
    edgeData?.fanoutJunctionY !== undefined &&
    Math.abs(edgeData.fanoutJunctionY - sourceY) < HIDE_STALE_EPS;
```

Render block beside the fan-in dot (:534-546):

```tsx
      {/* Declined fan-out divergence dot (#43, owner only): where coincident
          same-flow item edges split. Same markup and stacking as the fan-in
          merge dot; stale-dropped against the live source y. */}
      {fanoutMarkerLive && edgeData?.fanoutJunctionX !== undefined ? (
        <JunctionDot
          testId={`fanout-junction-${id}`}
          x={edgeData.fanoutJunctionX}
          y={edgeData.fanoutJunctionY!}
          color={kindStyle.stroke}
          dimmed={edgeData.dimmed}
          zoom={zoom}
        />
      ) : null}
```

- [ ] **Step 5: Run the new tests + full unit suite** (systemd-run wrapped). Expected: all green, including `faninMarkers.test.ts` untouched.

- [ ] **Step 6: Commit**

```bash
git add src/canvas/chipSeating.ts src/canvas/ItemEdge.tsx test/canvas/fanoutMarkers.test.ts
git commit -m "Mark declined fan-out divergence with a junction dot (#43)"
```

---

### Task 7: Final re-measure, e2e sweep, and visual sign-off

**Files:**
- Modify: `test/e2e/geometry-audit.spec.ts` (tables, if Tasks 5-6 moved counts)
- Create (temporary): `test/e2e/ratchet-probe.spec.ts` (deleted again)
- Ledger: final before/after table; capture paths.

**Interfaces:**
- Consumes: everything above.
- Produces: the evidence for Task 8's PR body and issue comments.

- [ ] **Step 1: Rebuild, harvest actuals, re-pin DOWN** (same probe procedure). Expected moves from Task 5: chipSeg/offPath in the battery5 family DOWN further (icon-only boxes are ~25 units wide). Task 6 adds only `.bus-junction` divs - dots sit below chips in z (the P1 d2 check covers this) and should not move any table. Any UP move: STOP for a ruling.

- [ ] **Step 2: Run the e2e board, one spec x scenario per invocation**

- `geometry-audit.spec.ts` x 7 scenarios: green except expected-red (battery5/multi6 tier-1 RAW - verify the failures are the SAME counts as the pre-existing family, not new ones).
- `row-collisions.spec.ts` (both), `title-truncation.spec.ts`: green.
- `placement-shots.spec.ts`: first run in this worktree fails 7/7 (fresh goldens), rerun passes. Ledger note, no commit.
- `inputs-panel` + `raw-and-transport`: expected-red counts unchanged (4 + 1).
- `bunx tsc --noEmit` + `bun run lint` + full `bunx vitest run`: green.

- [ ] **Step 3: Visual verification protocol (mandatory)**

Captures: default / battery5 / battery5-xiranite / equip4 / multi6 fit, plus zoom crops of (a) battery5 Seed-Picking divergence - the new dot (or the promoted real fan-out) visible, no chip mid-shared-run reading as trunk rate; (b) a former 34gu slab corridor - chips clear of cards; (c) equip4 Refining Unit rows - names distinct; (d) an icon-only short-leg chip - hover reveals the rate. Inspect for wrongness (misplaced dots, orphaned chips, slab caption overlap), not presence. Record paths in the ledger.

- [ ] **Step 4: Commit any re-pin**

```bash
git add test/e2e/geometry-audit.spec.ts
git commit -m "Re-pin geometry ratchets after short-leg chip and divergence dot fixes"
```

---

### Task 8: PR and issue evidence

**Files:** none (gh + git only).

- [ ] **Step 1: Push and open the PR**

Follow `docs/pr-guideline.md`: goal-focused imperative title, Summary / Changes / Testing with one-line effect-focused bullets, facts-only testing evidence (the before/after ratchet table). Run title AND body through the `humanizer` skill before `gh pr create --base develop`. Reference #41/#42/#43 in the body (no Closes keywords - they would not fire against develop anyway).

- [ ] **Step 2: Comment evidence on #41, #42, #43**

One comment each via `gh issue comment`: what landed (commits), the measured before/after for that issue's family, residuals if any (e.g. #41: whether e:18/e:34 vanished; #43: whether the battery5 group promoted to a real fan-out or got the declined-group dot). Do NOT close the issues - closing happens after the user merges.

- [ ] **Step 3: Check the plan boxes**

Tick every completed checkbox in this file, annotate deviations inline (the style of `docs/plans/2026-08-08-chip-seating-saturated-zoom.md`), commit:

```bash
git add docs/plans/2026-08-20-short-leg-legibility.md
git commit -m "Check off short-leg legibility campaign plan"
git push
```
