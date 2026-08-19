# Render Comprehension Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix GitHub issues #36 (control rail icons collapse to 2.4px), #38 (machine names truncate whenever a multiplier chip is present), #39 (Sigma aggregate chips read as extra flows: remove the bus aggregates, restyle + re-anchor the fan-in aggregate), #37 (bus aggregate chip cascades off its lane - closed structurally by the #39 removal), and #40 (replicated raw-tap cards read as independent sources: give them distinct tap chrome and a parent-share line).

**Architecture:** #36 and #38 are pure CSS in `src/canvas/canvas.css` (a generic `.ak-app-shell button` rule collapsing the controls' content box; a header grid whose reserved column widths the title can never reclaim). #39's bus removal touches `BusEdge.tsx` (stop rendering the aggregate drop chip when `busMemberCount > 1`) and `chipSeating.ts` (stop seating the phantom box, free the lane capacity it reserved, stop counting it in `contentBounds`); routing data (`busTotalRate`, `busChipOwner`, ...) stays stamped. The fan-in Sigma keeps its junction-dot-plus-chip structure but anchors beside the dot and gains a distinct `sigma` chip style. #40 threads a `parentRate` from the boundary-products aggregate onto its fanout slices through `layout.ts` into `ProductNode`, which renders a TAP classification, dashed chrome, and an "of total" share chip.

**Tech Stack:** TypeScript + React 19, Vitest (jsdom, `bun run test`), Playwright e2e (`bun run test:e2e`, auto-builds and serves on 4173), Bun as runner.

**Branch / worktree:** create `fix/render-comprehension` off `origin/develop`. From `STC-workspace/`:

```sh
git -C STC fetch origin
git -C STC worktree add .claude/worktrees/fix/render-comprehension -b fix/render-comprehension origin/develop
```

All paths below are relative to `STC/.claude/worktrees/fix/render-comprehension/`. Run all commands from that directory.

## Global Constraints

- ASCII characters only in comments and commit messages; no references to external docs, tickets, or Markdown files in either.
- Geometry ratchet baselines (`test/e2e/geometry-audit.spec.ts`) move DOWN freely, UP only with a recorded ruling in the NOTE block at `:385-393`. The #39 removal is a ratified ruling: if surfacing previously capacity-hidden member chips raises a count, record it there as "#39 aggregate removal surfaced member chips" and say so in the PR body.
- Sequencing with the chip-seating plan (`docs/plans/2026-08-08-chip-seating-saturated-zoom.md`): both plans move chips and re-pin ratchets. Run the two plans sequentially, never in parallel worktrees, and whichever runs second must re-measure its baselines from the then-current develop instead of trusting numbers recorded here.
- Playwright screenshot baselines under `test/e2e/__screenshots__/` are machine-generated and gitignored - regenerate and inspect them locally, never commit them.
- Recorded design tradeoff (part of the #39 ruling, surface it at review): with multi-member aggregates gone, a bus trunk below `LABEL_MIN_ZOOM` (0.35) shows only its junction dots and tinted lane - no rate text - until the reader zooms in or hovers. The fit-zoom "something flows here" signal the aggregate's icon-only collapse used to carry is intentionally given up.
- Unit gate before every commit: `bun run test && bun run typecheck && bun run lint` all green.
- e2e baseline: measure `bun run test:e2e` once on the fresh branch before any change and compare later runs against that failure list (develop carries known pre-existing failures), never against zero.

---

### Task 1: Control rail icons (#36)

**Files:**
- Modify: `src/canvas/canvas.css:1447-1455` (the `.ak-canvas-theme .react-flow__controls-button` rule)
- Test: `src/canvas/Canvas.test.tsx`

**Interfaces:** none - CSS only.

Root cause (from the issue, confirmed in code): `.ak-app-shell button` (`canvas.css:288-297`) overrides the xyflow vendor's `padding: 4px; border: none` on `.react-flow__controls-button` with `padding: 4px 10px; border: 1px solid ...`, collapsing the 26px button's content box to 4px; the project's `svg { max-width: 60% }` (`canvas.css:1463-1467`) then yields 2.4px icons. The project rule that re-pins the button to 26x26 never restores padding or border.

- [ ] **Step 1: Write the failing test**

Add to `src/canvas/Canvas.test.tsx`, following the file-reading regex pattern used by `src/canvas/RecipeNode.test.tsx:186-197`:

```tsx
test("controls buttons re-assert the vendor padding and border the app-shell rule overrides", () => {
  const css = readFileSync(
    join(__dirname, "canvas.css"),
    "utf8",
  );
  const rule = css.match(
    /\.ak-canvas-theme \.react-flow__controls-button \{[^}]*\}/,
  )?.[0];
  expect(rule).toBeDefined();
  expect(rule).toMatch(/padding:\s*4px;/);
  expect(rule).toMatch(/border:\s*none;/);
});
```

Add `import { readFileSync } from "node:fs";` and `import { join } from "node:path";` if the file does not already import them (mirror the imports `RecipeNode.test.tsx` uses for its CSS assertion).

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test src/canvas/Canvas.test.tsx`
Expected: FAIL - the rule matches neither pattern.

- [ ] **Step 3: Fix the CSS**

In `src/canvas/canvas.css`, change the controls-button rule to:

```css
.ak-canvas-theme .react-flow__controls-button {
  background: var(--ak-bg-secondary);
  /* The generic .ak-app-shell button rule reaches these buttons and replaces
     the vendor's padding:4px / border:none, collapsing the content box the
     icon svg is sized from (60% of 4px measured 2.4px). Re-assert both;
     border-bottom below re-adds the divider between buttons. */
  padding: 4px;
  border: none;
  border-bottom: 1px solid var(--ak-divider);
  color: var(--ak-text-secondary);
  /* React Flow ships 16px buttons; enlarge past the 24px minimum hit target so
     the fit-view escape hatch is easy to find and press. */
  width: 26px;
  height: 26px;
}
```

(This is the existing rule with `padding` and `border: none` added; keep the existing comment about the hit target.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/canvas/Canvas.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/canvas/canvas.css src/canvas/Canvas.test.tsx
git commit -m "Restore controls-button padding and border the app-shell rule collapsed"
```

---

### Task 2: Machine-title truncation (#38)

**Files:**
- Modify: `src/canvas/canvas.css:2093-2107` (`.rn-head`), `:2153-2162` (`.rn-rate-block`)
- Create: `test/e2e/title-truncation.spec.ts`

**Interfaces:** none - CSS only. Card width stays `RECIPE_WIDTH = 300`; header height stays 80px; node geometry and ELK sizing are untouched.

Root cause: the header grid `52px 1fr auto` reserves 11px the 28px icon never uses (icon 28 + 12 padding + 1 border = 41), and `.rn-rate-block`'s `min-width: 64px` + `padding: 0 12px` (content-box) reserves ~30px more than its widest line inks. The `1fr` title column gets the fixed remainder; the chip is `flex-shrink: 0`, so its width comes straight out of the name.

- [ ] **Step 1: Write the failing e2e test**

Create `test/e2e/title-truncation.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

// Issue #38: every card carrying a multiplier chip clipped its machine name
// even though the header had slack locked in unused grid-column reservations.
// The default plan carries both chip-bearing and chip-free cards, so an empty
// clipped list here means the title column can reclaim the slack.
test("default plan machine titles do not truncate", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("aef.locale", "en");
  });
  await page.goto("/");
  await page.waitForSelector(".machine-title .cn");
  const clipped = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".machine-title .cn"))
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.textContent ?? ""),
  );
  expect(clipped).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test:e2e test/e2e/title-truncation.spec.ts`
Expected: FAIL, listing the chip-bearing names ("Refining Unit", "Shredding Unit", ...).

- [ ] **Step 3: Reclaim the reserved widths**

In `src/canvas/canvas.css`:

1. `.rn-head`: change `grid-template-columns: 52px 1fr auto;` to `grid-template-columns: auto 1fr auto;` and extend the rule's comment with one line: `Column 1 sizes to the icon block (28px icon + padding + border) instead of a fixed 52px, so the title column reclaims the difference.`
2. `.rn-rate-block`: delete the `min-width: 64px;` line and change `padding: 0 12px;` to `padding: 0 8px;`. The `auto` grid column already grows to the widest rate line; the floor and wide padding only reserved dead space.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test:e2e test/e2e/title-truncation.spec.ts`
Expected: PASS. Contingency (bounded): if a name still clips by a few px, additionally change `.rn-recipe-block` `padding: 10px 12px;` to `padding: 10px 8px;` and re-run; if it STILL clips, stop and report the residual card rather than shrinking the 17px title font.

- [ ] **Step 5: Unit gate and header-geometry sanity**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: green - the header tests (`src/canvas/RecipeNode.test.tsx`) assert structure and zoom-low visibility, not pixel columns, so nothing there pins 52px or the min-width. jsdom does not lay out grids, so no layout assertions can move.

- [ ] **Step 6: Commit**

```bash
git add src/canvas/canvas.css test/e2e/title-truncation.spec.ts
git commit -m "Let the machine title reclaim reserved header slack

The header grid fixed its icon column at 52px against a 41px icon block
and floored the rate column at 64px against ~30px of ink, so any
multiplier chip clipped the name while the header showed empty space."
```

---

### Task 3: Remove the multi-member bus aggregate chip (#39, closes #37)

**Files:**
- Modify: `src/canvas/BusEdge.tsx:111-168` (drop-chip text/marker), `:295-297` (render gate)
- Test: `test/canvas/BusEdge.test.tsx`, `test/canvas/focus-dim.test.tsx`

**Interfaces:**
- Consumes: `busMemberCount` from `BusAggregate` edge data (already stamped by `routeBusEdges`; default 1 when absent).
- Produces: the drop chip renders only for single-member trunks (where it is the edge's plain label, no Sigma). Routing data (`busTotalRate`, `busDisplayTotalRate`, `busMemberCount`, `busChipOwner`) stays stamped and asserted - Task 4 handles the seating side.

Scope ruling: the removal covers BOTH trunk variants (lane and fan-out) - `BusEdge` draws the aggregate identically for both, and both totals restate a source card's own rate one card-width away. Member (rise/branch) chips are untouched.

- [ ] **Step 1: Rewrite the component tests to the new contract**

In `test/canvas/BusEdge.test.tsx`, adjust every test whose fixture stamps `busMemberCount: 2` or more (single-member fixtures are unaffected - verify each fixture's `busMemberCount` before touching the test):

- `:217` "marks a multi-member trunk's aggregate with a sum glyph, not a count" - replace with:

```tsx
test("draws no aggregate chip on a multi-member trunk", () => {
  // ... same fixture as before (busMemberCount: 2, busChipOwner: true) ...
  expect(
    document.querySelector('[data-testid="bus-edge-label-e1-drop"]'),
  ).toBeNull();
  const rise = document.querySelector('[data-testid="bus-edge-label-e1-rise"]');
  expect(rise!.textContent).toBe("60/min");
});
```

- `:252` "renders the aggregate as the sum of the members' displayed rates" - delete (the displayed-sum only existed for the multi-member chip; the routing-level display-total test in `src/canvas/BusEdge.test.tsx:69` keeps the data covered).
- `:382` "renders only the aggregate drop chip below the zoom threshold" - if the fixture is multi-member, the expectation becomes zero chips below the gate; if single-member, unchanged.
- `:406` "reveals a focused member's rise chip below the zoom threshold" - drop-chip queries in it become null-expectations when the fixture is multi-member.
- `:473` / `:520` icon-only aggregate tests - keep the behaviour on a SINGLE-member fixture (a lone member's drop chip is still zoom-exempt and collapses to icon-only with an empty text body and the exact-rate title); change the fixtures to `busMemberCount: 1` and drop every `"Σ"` expectation.
- `:497` "keeps the aggregate's sum glyph when collapsed" - delete; the glyph no longer exists.
- `:560` "keeps a multi-member trunk's rise chips gated on a long detour" - the drop expectation becomes null; the gating expectation on rises is unchanged.
- `:164` / `:183` / `:197` - single-member or count-absent fixtures: unchanged.

In `test/canvas/focus-dim.test.tsx`: inspect the fixture trunks. For every trunk with `busMemberCount > 1`, remove its `-drop` id from `BUS_CHIP_IDS` (`:68-74`) so `waitForChips` stops requiring a chip that no longer mounts, and re-point the `:323` "not the aggregate chip" assertion at a surviving element of the same trunk (its junction dot `bus-junction-...` or a single-member trunk's drop chip). If the fixtures are single-member, nothing changes.

- [ ] **Step 2: Run the suite to verify the rewritten tests fail**

Run: `bun run test test/canvas/BusEdge.test.tsx test/canvas/focus-dim.test.tsx`
Expected: the rewritten tests FAIL (the aggregate chip still renders); untouched tests pass.

- [ ] **Step 3: Gate the drop chip in `BusEdge.tsx`**

Three edits:

1. Delete `const sumMarker = memberCount > 1 ? "Σ" : "";` (`:157`) and remove `${sumMarker}` from `dropText`, `dropLabel`, and `dropTitle`:

```tsx
  const dropText = showAggChip && dropRateStr ? `${dropRateStr}${unit}` : "";
  const dropLabel =
    edgeData && dropRateStr
      ? `${i18n.displayName(edgeData.item)} x ${dropRateStr}${unit}`
      : "";
  const dropTitle =
    edgeData && dropRateStr && totalRate
      ? `${i18n.displayName(edgeData.item)} x ${formatRateExactPerMin(totalRate)}${unit}`
      : "";
```

2. Change the render gate at `:295-297` (dropping the now-gone `sumMarker` argument):

```tsx
      {isOwner && memberCount === 1 && dropText
        ? renderChip("drop", aggX, aggY, dropText, dropLabel, dropTitle)
        : null}
```

3. Rewrite the drop-chip comment block (`:119-126`) to state the new contract:

```tsx
  // Drop chip: drawn only on a SINGLE-member trunk, where it is that edge's
  // plain rate label at the junction. A multi-member trunk draws no aggregate:
  // the summed total restated the source card's own rate while reading as one
  // more flow, so the members' own chips and the card rates carry the
  // information (issue #39). The junction dot still marks the trunk.
```

- [ ] **Step 4: Run the suites to verify they pass**

Run: `bun run test test/canvas/BusEdge.test.tsx test/canvas/focus-dim.test.tsx && bun run test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/canvas/BusEdge.tsx test/canvas/BusEdge.test.tsx test/canvas/focus-dim.test.tsx
git commit -m "Stop drawing the aggregate chip on multi-member bus trunks

The summed Sigma chip restated the source card's rate while reading as
one more flow, and its unbounded lane-escape cascade could park it in
empty canvas. Single-member trunks keep their plain drop label; member
chips and junction dots are unchanged."
```

---

### Task 4: Free the seating and bounds the aggregate reserved (#39 / #37)

**Files:**
- Modify: `src/canvas/chipSeating.ts` (`BusSlot` build ~`:855-916`, drop seat loop `:930-950`, capacity check `:951-991`, fan-out aggregate seat `:1121-1133`, `contentBounds` `:1673-1695`)
- Test: `test/canvas/busRouting.chips.test.ts`, `test/canvas/chipSeating.bounds.test.ts`

**Interfaces:**
- Consumes: `busMemberCount` on lane and fan-out edge data.
- Produces: no phantom aggregate box for multi-member trunks; lane capacity no longer reserves the aggregate's column, so previously `busRiseHidden` members may now seat. `busDropDy` is only ever stamped for single-member trunks.

- [ ] **Step 1: Update the seating tests to the new capacity rule**

In `test/canvas/busRouting.chips.test.ts` (`describe("deconflictChipAnchors: bus lane cascade")`):

- `:61` "hides a crowded trunk's overflow rise chips, keeping only the aggregate on the lane" - rename to "keeps the rises the short run supports; no aggregate column is reserved" and recompute the expected `busRiseHidden` flags: with the aggregate's `keptX` seed gone, the farthest-first ordering keeps rises while each new `riseChipX` is `>= 240` (`2 * CHIP_HALF_W_WIDE`) from every kept one. Derive the expected flags from the fixture's `riseChipX` values by that rule and pin them; also expect `busDropDyOf` to be absent/0 for the multi-member trunk (nothing seats a drop).
- `:92` "keeps the farther rise chip and hides the near one when only one fits" - re-derive the same way; with no aggregate column the near rise may now also fit; pin whatever the 240-separation rule yields for the fixture's coordinates.
- `:140` "leaves a well-spread trunk's chips on the lane" - drop-chip expectations become "no busDropDy stamped"; rise expectations unchanged.
- `:163` "holds a drop chip on its junction unless a foreign trunk's line crosses it" - keep, on a SINGLE-member fixture (set `busMemberCount: 1`); this behaviour survives for lone-member trunks.
- `describe(...: fan-out aggregate seat (3b)")` `:349` / `:379` - fan-out trunks are multi-member by construction, so the aggregate no longer seats: rewrite `:349` to assert no `fanoutAggDx/Dy` is stamped, and `:379` (branch chip hidden because the aggregate box covered its short path) to assert the branch chip now SEATS (`fanoutBranchHidden` absent) since the covering box is gone.

Do not touch `test/canvas/chipSeating.seat.test.ts:211` and `:288` - they exercise `seatRateChip` directly, which the fan-in Sigma still uses.

- [ ] **Step 2: Run to verify the rewritten tests fail**

Run: `bun run test test/canvas/busRouting.chips.test.ts`
Expected: the rewritten expectations FAIL against the current seating.

- [ ] **Step 3: Implement the seating changes**

In `src/canvas/chipSeating.ts`:

1. `BusSlot` build (`:855-916`): add `memberCount: data.busMemberCount ?? 1` to the slot object and its type.
2. Drop seat loop (`:930-950`): change the guard to `if (!slot.owner || slot.memberCount > 1) continue;` and note above it: `// Multi-member trunks draw no aggregate chip (issue #39), so seat none.`
3. Capacity check (`:951-991`): change `const keptX = [aggX];` to `const keptX: number[] = [];` (keep `aggX` for the farthest-first ordering - the junction is still the natural reference point) and rewrite the comment's "the aggregate (drop) chip, already seated above, stays the trunk's one on-lane truth" sentence to: `// No aggregate chip exists on a multi-member trunk (issue #39); the run's capacity all goes to member rises, farthest from the junction first.`
4. Fan-out aggregate seat loop (`:1121-1133`): guard each job with `if ((data.busMemberCount ?? 1) > 1) continue;` (matching however the loop reads its edge data), with the same one-line comment.
5. `contentBounds`: in the lane branch (`:1689-1691`) change the drop union guard to `if (data.busChipOwner !== false && (data.busMemberCount ?? 1) === 1)`; apply the equivalent guard to the fan-out aggregate union in `:1673-1686`.

- [ ] **Step 4: Run the suites**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: green. `test/canvas/chipSeating.bounds.test.ts:112` (battery5 full-plan fitted rect) may shift because the aggregate no longer stretches the bounds - if its pinned numbers fail, update them to the newly computed rect and say so in the commit body. Any other failure is a real break.

- [ ] **Step 5: Commit**

```bash
git add src/canvas/chipSeating.ts test/canvas/busRouting.chips.test.ts test/canvas/chipSeating.bounds.test.ts
git commit -m "Stop seating and bounding the removed multi-member aggregate chip

The phantom drop box no longer blocks the lane, the capacity check no
longer reserves the aggregate's column, and contentBounds no longer
stretches to a chip that does not render."
```

---

### Task 5: Restyle and re-anchor the fan-in Sigma (#39)

**Files:**
- Modify: `src/canvas/chipSeating.ts:1385-1400` (the fan-in seat job anchor), `src/canvas/ItemEdge.tsx` (`FlowChip` component + the fan-in call site), `src/canvas/canvas.css` (new `.flow-chip.sigma` rule)
- Test: `src/canvas/ItemEdge.test.tsx` (or `test/canvas/ItemEdge.test.tsx`, wherever the fan-in Sigma test at `:199` lives), `test/canvas/faninMarkers.test.ts`

**Interfaces:**
- Produces: `FlowChip` accepts `variant?: "sigma"` and appends the `sigma` class; the fan-in chip's default anchor moves from the run midpoint to the junction side (`mergeX + keepoff`, the closest non-covering seat beside the merge dot).

- [ ] **Step 1: Write the failing tests**

In the ItemEdge test file containing the `:199` fan-in Sigma test, add:

```tsx
test("the fan-in Sigma chip carries the sigma variant class", () => {
  // Same fixture as the icon-only Sigma test (faninJunctionX/Y, faninSigmaX/Y,
  // faninTotalRate, faninMemberCount stamped on the owner edge).
  const sigma = document.querySelector<HTMLElement>(
    '[data-testid="bus-edge-fanin-e1-drop"]',
  );
  expect(sigma).not.toBeNull();
  expect(sigma!.classList.contains("sigma")).toBe(true);
});
```

In `test/canvas/faninMarkers.test.ts`, extend the `:43` test with an anchor assertion (the fixture's merge point is 900 and `keepoff = min(CHIP_HALF_W_WIDE, runLen / 2)`):

```ts
  // Anchored beside the junction (mergeX + keepoff), not mid-run, so the
  // total visually binds to the merge dot it summarizes.
  const runLen = tx - 900;
  const keepoff = Math.min(120, runLen / 2);
  expect(owner.faninSigmaX).toBe(900 + keepoff);
```

(Adapt `tx` to how the test already computes the target port x; `120` is `CHIP_HALF_W_WIDE` = `MAX_CHIP_SCALE * CHIP_BOX_WIDTH / 2`.)

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test test/canvas/faninMarkers.test.ts src/canvas/ItemEdge.test.tsx test/canvas/ItemEdge.test.tsx`
Expected: both new tests FAIL (mid-run anchor; no `sigma` class). Existing `faninSigmaX` range assertions (`> 900`, `< tx`) keep passing before and after.

- [ ] **Step 3: Move the anchor**

In `src/canvas/chipSeating.ts`, in the fan-in seat-job push (`:1390-1400`), change:

```ts
      anchorX: (mergeX + tx) / 2,
```

to:

```ts
      // Beside the junction dot, not mid-run: the Sigma is a summary tag of
      // the merge, so it seats at the closest point that does not cover the
      // dot (the keepoff), and the slide only moves it when that seat is
      // blocked.
      anchorX: mergeX + keepoff,
```

- [ ] **Step 4: Add the variant to `FlowChip` and the call site**

In `src/canvas/ItemEdge.tsx`, add `variant?: "sigma"` to `FlowChip`'s props type and append `" sigma"` to its className construction when set (the component builds `nodrag nopan flow-chip` plus `icon-only`/`dimmed` modifiers around `:235-268`; extend that expression the same way those modifiers do). Then pass `variant="sigma"` at the fan-in chip call site (`:544-563`, the `FlowChip` with `testId={`bus-edge-fanin-${id}-drop`}`).

- [ ] **Step 5: Add the CSS**

In `src/canvas/canvas.css`, after the `.flow-chip.dimmed` rule (`:1801-1803`):

```css
/* Fan-in aggregate: a summary tag bound to the merge junction beside it, not
   another flow chip. The dashed outline separates "total of the merged runs"
   from the solid per-edge rate chips it sums; the leading sum glyph stays. */
.flow-chip.sigma {
  border-style: dashed;
  background: rgba(20, 23, 27, 0.92);
}
```

- [ ] **Step 6: Run the suites**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: green, including the two new tests.

- [ ] **Step 7: Commit**

```bash
git add src/canvas/chipSeating.ts src/canvas/ItemEdge.tsx src/canvas/canvas.css test/canvas/faninMarkers.test.ts src/canvas/ItemEdge.test.tsx test/canvas/ItemEdge.test.tsx
git commit -m "Bind the fan-in Sigma chip to its merge junction

Anchor the summed-total chip beside the junction dot instead of mid-run
and give it a dashed sigma variant, so it reads as a summary of the
merge rather than one more flow."
```

(Drop whichever ItemEdge test path does not exist from the `git add`.)

---

### Task 6: Tap chrome for replicated raw-input cards (#40)

**Files:**
- Modify: `src/pipeline/types.ts:140-149` (`RenderUnitInputProduct`), `src/pipeline/render/boundary-products.ts:541-552` (slice emission), `src/canvas/layout.ts:816-832` (data threading), `src/canvas/ProductNode.tsx` (data type, chrome, share chip), `src/canvas/productNodeMetadata.ts:32-68` (`buildPnKind`), `src/data/i18n.ts` (two new keys, all four locales), `src/canvas/canvas.css` (tap chrome + share chip)
- Test: `test/canvas/ProductNode.test.tsx`, `src/canvas/productNodeMetadata.test.ts`, `test/pipeline/policy-product-units.test.ts`

**Interfaces:**
- Produces: `RenderUnitInputProduct.parentRate?: RationalString` (the aggregate's total, stamped on every fanout slice); `ProductNodeData` inputProduct variant gains `parentRate?: RationalString`; fanout slices render class `product-node input tap`, caption `In · tap`, and a `.pn-rate__of` share chip reading `of <total>/min`.
- Scope ruling: the chrome applies to ALL `isFanout` slices - per-consumer taps AND per-container slices - since both are derived views of the `u:in:<item>` aggregate card that is also on screen. The aggregate and single-bucket cards keep `In · raw` / `In · import` unchanged.

- [ ] **Step 1: Write the failing tests**

In `test/canvas/ProductNode.test.tsx`, following the file's existing render helper:

```tsx
test("renders a fanout slice with tap chrome and the parent share", () => {
  // rate 1/2 per sec = 30/min; parentRate 9/2 per sec = 270/min.
  const { container } = renderNode({
    kind: "inputProduct",
    itemId: "copper_ore",
    rate: "1/2",
    isFanout: true,
    parentRate: "9/2",
  });
  const node = container.querySelector(".product-node");
  expect(node?.classList.contains("tap")).toBe(true);
  expect(container.querySelector(".pn-kind")?.textContent).toBe("In · tap");
  expect(container.querySelector(".pn-rate__of")?.textContent).toBe(
    "of 270/min",
  );
});

test("a non-fanout input keeps the raw chrome with no share chip", () => {
  const { container } = renderNode({
    kind: "inputProduct",
    itemId: "copper_ore",
    rate: "9/2",
  });
  expect(
    container.querySelector(".product-node")?.classList.contains("tap"),
  ).toBe(false);
  expect(container.querySelector(".pn-kind")?.textContent).toBe("In · raw");
  expect(container.querySelector(".pn-rate__of")).toBeNull();
});
```

(`renderNode` stands for whatever helper the file's existing tests use to mount `ProductNode` with data - reuse it verbatim; `copper_ore` is the raw item its fixtures already use.)

In `src/canvas/productNodeMetadata.test.ts`, add a `buildPnKind` case: an inputProduct with `isFanout: true` yields the tap classification regardless of `item.raw`.

In `test/pipeline/policy-product-units.test.ts`, extend the `:1420` multi-bucket test: every emitted slice carries `parentRate` equal to the aggregate's `rate`, and the aggregate itself carries none:

```ts
  expect(byId.get("u:in:water")!.parentRate).toBeUndefined();
  expect(tapA.parentRate).toBe(byId.get("u:in:water")!.rate);
  expect(tapB.parentRate).toBe(byId.get("u:in:water")!.rate);
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun run test test/canvas/ProductNode.test.tsx src/canvas/productNodeMetadata.test.ts test/pipeline/policy-product-units.test.ts`
Expected: all three new tests FAIL (`tap` class absent, `In · raw` rendered, `parentRate` undefined).

- [ ] **Step 3: Thread the data**

1. `src/pipeline/types.ts` - add to `RenderUnitInputProduct`:

```ts
  // The parent aggregate's total realized rate, stamped on every fanout slice
  // so the card can show its share of the source it taps.
  parentRate?: RationalString;
```

2. `src/pipeline/render/boundary-products.ts` - in the multi-bucket slice loop (`:541-552`), add `parentRate: rationalToString(aggregateRate),` to the pushed slice object.
3. `src/canvas/layout.ts:816-826` - in the `inputProduct` data build, add `...(unit.parentRate !== undefined ? { parentRate: unit.parentRate } : {}),` beside the `isFanout` spread.
4. `src/canvas/ProductNode.tsx` - add `parentRate?: RationalString;` to the inputProduct variant of `ProductNodeData` (beside `isFanout`).

- [ ] **Step 4: Render the chrome**

1. `src/canvas/ProductNode.tsx` `chromeClasses` (`:40-46`):

```tsx
function chromeClasses(data: ProductNodeData): string {
  if (data.kind === "inputProduct") {
    // A fanout slice is a derived view of the item's aggregate card, not an
    // independent source; the tap class mutes it (issue #40).
    return data.isFanout ? "product-node input tap" : "product-node input";
  }
  return `product-node output ${data.flavor}`;
}
```

2. `src/canvas/productNodeMetadata.ts` `buildPnKind` - change the inputProduct branch:

```ts
  if (data.kind === "inputProduct") {
    const classification = i18n.t(
      data.isFanout
        ? "product.class.tap"
        : item.raw
          ? "product.class.raw"
          : "product.class.import",
    );
    return `${i18n.t("product.dir.in")} · ${classification}`;
  }
```

3. `src/canvas/ProductNode.tsx` - beside the `capValue` computation add:

```tsx
  // Share of the parent aggregate, fanout slices only: "of <total>/min" points
  // the reader back at the source card this tap draws from.
  const shareOf =
    isInput && data.isFanout && data.parentRate !== undefined
      ? formatRationalPerMin(data.parentRate)
      : null;
```

and in the `pn-rate` row, after the cap chip:

```tsx
        {shareOf !== null ? (
          <span className="pn-rate__of">
            {i18n.t("product.tap.share", { rate: shareOf })}
          </span>
        ) : null}
```

4. `src/data/i18n.ts` - add two keys to EVERY locale table, placed beside `product.class.raw`:

| key | en | zh | ja | ru |
| --- | --- | --- | --- | --- |
| `product.class.tap` | `tap` | `分接` | `タップ` | `отвод` |
| `product.tap.share` | `of {rate}/min` | `共 {rate}/min` | `全 {rate}/min` | `из {rate}/min` |

(Follow the table's existing `{rate}` interpolation convention, matching `inputs.rate.cap`.)

5. `src/canvas/canvas.css` - after the `.pn-rate__cap` rule (`:1907-1919`):

```css
/* Per-consumer / per-container tap slice of a bussed raw input: a derived view
   of the aggregate source card, not another source. Dashed accent and a muted
   name keep it from being counted as an independent input; the share chip
   under the rate points back at the parent's total (issue #40). */
.product-node.input.tap {
  border-left-style: dashed;
  background: var(--ak-bg-secondary);
}

.product-node.input.tap .pn-name {
  color: var(--ak-text-secondary);
}

.pn-rate__of {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 1px 5px;
  border: 1px dashed var(--ak-divider);
  font-family: var(--ak-font-mono);
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.05em;
  color: var(--ak-text-secondary);
}
```

- [ ] **Step 5: Run the suites**

Run: `bun run test && bun run typecheck && bun run lint`
Expected: green. Sweep for whole-object comparisons that the new `parentRate` field breaks: `rg -n "toEqual" test/pipeline/policy-product-units.test.ts` - update any full-unit `toEqual` fixtures to include `parentRate`. The zh locale test (`src/canvas/ProductNode.test.tsx:59`) uses a non-fanout fixture and is unaffected; confirm.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/render/boundary-products.ts src/canvas/layout.ts src/canvas/ProductNode.tsx src/canvas/productNodeMetadata.ts src/data/i18n.ts src/canvas/canvas.css test/canvas/ProductNode.test.tsx src/canvas/productNodeMetadata.test.ts test/pipeline/policy-product-units.test.ts
git commit -m "Mark raw-input fanout slices as taps of their aggregate source

- Dashed tap chrome and an In-tap caption replace the raw badge on slices
- Thread the aggregate's total onto each slice as an of-total share chip
- A naive read of the input column now counts each source once"
```

---

### Task 7: Ratchets, visual verification, PR

**Files:**
- Modify: `test/e2e/geometry-audit.spec.ts` (baseline re-pins; a ruling note only if a count rises)

- [ ] **Step 1: Full e2e run against the Task-0 baseline**

Run: `bun run test:e2e 2>&1 | tail -40`
Expected: only the pre-recorded pre-existing failures plus geometry-audit deltas from the chip changes. Placement-shots diffs are expected (chips removed/moved, titles longer, tap cards restyled): inspect each diff image under `test-results/`, confirm only the intended changes, then regenerate the local baselines with `bunx playwright test placement-shots --update-snapshots` (they are gitignored - do not commit).

- [ ] **Step 2: Re-measure and re-pin the geometry ratchets**

Temporarily zero the five baseline tables in `test/e2e/geometry-audit.spec.ts` (`CROSSING_BASELINE`, `PADDED_GRAZE_BASELINE`, `CHIP_SEGMENT_BASELINE`, `CHIP_OFFPATH_BASELINE`, `OWN_PIERCE_BASELINE`), run `bunx playwright test geometry-audit`, harvest the per-scenario actuals from the soft-failure messages, revert the zeroing, then:

- Every count at or below its pin and at or below the pre-change actual: re-pin downward to the measured value.
- Any count ABOVE the pre-change actual: expected only where freed lane capacity now seats member chips that were hidden (multi6 and battery5 are the candidates). Confirm the new collisions trace to surfaced member chips (the violation listings name the chips), then re-pin with a ruling line added to the NOTE block at `:385-393`: `// #39 aggregate removal: multi-member trunks draw member chips where the one aggregate sat, raising <scenario> <table> from N to M.` Anything not explained by a surfaced member chip is a regression - stop and fix before re-pinning.

Run: `bunx playwright test geometry-audit`
Expected: green with the new pins.

```bash
git add test/e2e/geometry-audit.spec.ts
git commit -m "Re-pin geometry ratchets after the aggregate-chip removal"
```

- [ ] **Step 3: Visual verification (mandatory protocol)**

Capture and inspect at 1920x1080, locale en, against each issue's repro:

- Any plan: the four control-rail icons render at ~11px, not dots (#36).
- Default plan: chip-bearing cards show full machine names (#38); the copper and water trunks show NO floating Sigma chips above the band (#39/#37); the sewage fan-in Sigma sits dashed beside its junction dot (#39); the tap column reads as dashed tap cards with "of 270/min" shares, and summing only the solid `IN · RAW` cards gives the true plan input (#40).
- battery5-xiranite at fit: no regression in overall readability from the trunk-label removal - this is the recorded tradeoff; capture it explicitly for the user's review.

- [ ] **Step 4: Push and open the PR**

Open a PR to `develop` per the repo's PR guideline (goal-focused imperative title; Summary / Changes / Testing with one-line effect bullets and facts-only evidence; run title and body through the humanizer skill). State the two recorded rulings in the body: the fit-zoom trunk-label tradeoff, and any ratchet raise from surfaced member chips.

- [ ] **Step 5: Issue close-outs**

After merge: close #36, #38, #40 with one-line fix references; close #39 citing both halves (bus removal, fan-in rebind); close #37 as structurally resolved (the chip that cascaded no longer exists; the drop-seat cascade now runs only for single-member trunks, whose anchor is their own junction).

---

## Verification checklist (whole plan)

- [ ] `bun run test`, `bun run typecheck`, `bun run lint` green
- [ ] `bunx playwright test geometry-audit` green; every baseline change is downward or carries a written surfaced-member ruling
- [ ] `test/e2e/title-truncation.spec.ts` passes and is committed as a permanent guard
- [ ] `bun run test:e2e` failure list matches the pre-change recording
- [ ] No `Σ` remains in `BusEdge.tsx`; `rg -n 'sumMarker' src/` returns nothing
- [ ] Visual captures inspected against all five issues' repro descriptions; the fit-zoom tradeoff capture is in the PR
- [ ] PR opened to develop; issues #36-#40 have close-out comments queued
