# Render-exam harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the render exam's agent-written screenshot capture with a deterministic, coverage-proving CLI, and replace its single-pass evaluation with typed findings that get corroborated or refuted before filing.

**Architecture:** A bun CLI at `tools/exam/` drives Playwright against a running preview server, positions the camera exactly through a new `?exam=1` app hook, tiles the plan at a fixed zoom until every element is provably covered, and writes `scene.json` (measurements, not verdicts). The rewritten workflow evaluates screenshots blind, joins findings to measurements by pixel footprint, and refutes what geometry cannot corroborate.

**Tech Stack:** TypeScript, bun, Playwright (`@playwright/test`, already a devDependency — do NOT add `playwright` as a direct dependency), React 19 + `@xyflow/react` 12, Vitest 4.

**Spec:** `docs/specs/2026-07-27-render-exam-harness-design.md` in this worktree. Read it before Task 1.

## Global Constraints

- Branch `feat/exam-harness`, worktree `STC/.claude/worktrees/feat/exam-harness`. Never switch branches; never touch another worktree.
- Do not add or upgrade any npm dependency. `@playwright/test` re-exports `chromium`; import from there, never from `playwright`.
- ASCII only in all comments, commit messages, and docs. No em dashes, no smart quotes, no Unicode arrows.
- Comments must not reference external docs, ADRs, tickets, wikis, or other Markdown files.
- Commit messages: imperative mood, single line for small changes.
- Coordinate contract: every rect written to `scene.json` is CSS pixels relative to the `.react-flow` element's top-left, EXCEPT fields explicitly named `worldRect` / `contentRect`, which are React Flow world units.
- Screenshots are always taken with `scale: "css"` at `deviceScaleFactor: 2`.
- Target zoom default `0.75`; tile cap default `64`; seam margin default `64` CSS px; tile overlap `0.15`.
- LOD gate values are imported from `src/canvas/ItemEdge.tsx` (`LABEL_MIN_ZOOM`, `CHIP_ICON_ONLY_MAX_ZOOM`). Never write `0.35` or `0.32` as a literal.
- The e2e success criterion is an UNCHANGED pass/fail set, not a green run. `develop` carries known pre-existing failures.

---

## File structure

| Path | Responsibility |
| --- | --- |
| `src/canvas/Canvas.tsx` (modify) | Install `window.__stcExam` when `?exam=1` is present |
| `src/canvas/Canvas.exam.test.tsx` (create) | Hook presence/absence and behaviour |
| `test/e2e/collect.ts` (create) | All in-page DOM collectors, shared by the audit spec and the exam |
| `test/e2e/geometry-audit.spec.ts` (modify) | Import collectors instead of defining them |
| `tools/exam/tiling.ts` (create) | Pure geometry: safe region, tile grid, viewport math, coverage |
| `tools/exam/tiling.test.ts` (create) | Unit tests for the above |
| `tools/exam/scene.ts` (create) | Assemble `scene.json` from collector output plus `geometry.ts` measurements |
| `tools/exam/capture.ts` (create) | The `capture` CLI |
| `tools/exam/probe.ts` (create) | The `probe` CLI and its named ops |
| `tools/exam/triage.ts` (create) | Corroboration join and routing |
| `tools/exam/triage.test.ts` (create) | Unit tests for the join |
| `vitest.config.ts` (modify) | Add `tools/exam/**` to `include` |
| `.claude/skills/render-exam/SKILL.md` (modify) | Rewritten procedure |
| `.claude/workflows/render-quality-exam.js` (modify) | Evaluate + triage + Refute |

---

## Phase 1 - the harness

### Task 1: The `?exam=1` camera hook

**Files:**
- Modify: `src/canvas/Canvas.tsx`
- Create: `src/canvas/Canvas.exam.test.tsx`

**Interfaces:**
- Consumes: `contentBounds(nodes, edges): ContentRect | null` from `src/canvas/chipSeating.ts:1631`, where `ContentRect = {x, y, width, height}` (`chipSeating.ts:1589`).
- Produces: a global `window.__stcExam` with this exact shape, relied on by Tasks 5 and 7:

```ts
type StcExamHook = {
  setViewport(v: { x: number; y: number; zoom: number }): void;
  fitView(): void;
  contentBounds(): { x: number; y: number; width: number; height: number } | null;
};
```

- [ ] **Step 1: Write the failing test**

Create `src/canvas/Canvas.exam.test.tsx`. Follow the render helper pattern already used in `src/canvas/Canvas.test.tsx` (read it first; reuse its `renderCanvas` setup rather than inventing a new one).

```tsx
import { describe, expect, test, beforeEach, afterEach } from "vitest";
// ... reuse the imports and renderCanvas helper shape from Canvas.test.tsx

declare global {
  interface Window {
    __stcExam?: {
      setViewport(v: { x: number; y: number; zoom: number }): void;
      fitView(): void;
      contentBounds(): { x: number; y: number; width: number; height: number } | null;
    };
  }
}

describe("exam camera hook", () => {
  beforeEach(() => {
    delete window.__stcExam;
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
    delete window.__stcExam;
  });

  test("is absent without the exam query param", () => {
    window.history.replaceState(null, "", "/");
    renderCanvas(HOVER_NODES, []);
    expect(window.__stcExam).toBeUndefined();
  });

  test("is installed when exam=1 is present", () => {
    window.history.replaceState(null, "", "/?exam=1");
    renderCanvas(HOVER_NODES, []);
    expect(typeof window.__stcExam?.setViewport).toBe("function");
    expect(typeof window.__stcExam?.fitView).toBe("function");
    expect(typeof window.__stcExam?.contentBounds).toBe("function");
  });

  test("contentBounds returns null for an empty graph", () => {
    window.history.replaceState(null, "", "/?exam=1");
    renderCanvas([], []);
    expect(window.__stcExam?.contentBounds()).toBeNull();
  });

  test("contentBounds returns a finite rect for a populated graph", () => {
    window.history.replaceState(null, "", "/?exam=1");
    renderCanvas(HOVER_NODES, []);
    const b = window.__stcExam!.contentBounds()!;
    expect(Number.isFinite(b.x)).toBe(true);
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  });

  test("uninstalls on unmount", () => {
    window.history.replaceState(null, "", "/?exam=1");
    const { unmount } = renderCanvas(HOVER_NODES, []);
    unmount();
    expect(window.__stcExam).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun run test -- src/canvas/Canvas.exam.test.tsx
```

Expected: FAIL, `window.__stcExam` is undefined in the install test.

- [ ] **Step 3: Implement the hook**

In `src/canvas/Canvas.tsx`, inside `CanvasInner`:

1. Add `setViewport` to the existing destructure at line ~206: `const { fitView, fitBounds, setViewport } = useReactFlow();`
2. Add this effect after the existing `fitContent` callback. Keep the comment ASCII and explain WHY the param gate exists, matching the file's commenting density:

```tsx
  // Exam hook: the render-quality exam needs exact camera placement to tile a
  // plan reproducibly, and wheel zoom cannot translate the view (it pins the
  // world point under the cursor). Nothing here mutates plan data; it is camera
  // control plus the same contentBounds the fit path already uses, so the
  // shipped bundle carries it inert unless a URL asks for it by name.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("exam") !== "1") return;
    window.__stcExam = {
      setViewport: (v) => {
        void setViewport(v);
      },
      fitView: () => {
        fitContent();
      },
      contentBounds: () => contentBounds(nodes as unknown as RFAnyNode[], edges),
    };
    return () => {
      delete window.__stcExam;
    };
  }, [setViewport, fitContent, nodes, edges]);
```

3. Declare the global. Put this at the top of `Canvas.tsx` below the imports:

```tsx
declare global {
  interface Window {
    __stcExam?: {
      setViewport(v: { x: number; y: number; zoom: number }): void;
      fitView(): void;
      contentBounds(): { x: number; y: number; width: number; height: number } | null;
    };
  }
}
```

- [ ] **Step 4: Run the test and the neighbours**

```bash
bun run test -- src/canvas/Canvas.exam.test.tsx src/canvas/Canvas.test.tsx
bun run typecheck && bun run lint
```

Expected: all PASS, no type or lint errors.

- [ ] **Step 5: Commit**

```bash
git add src/canvas/Canvas.tsx src/canvas/Canvas.exam.test.tsx
git commit -m "Add exam camera hook behind the exam query param"
```

---

### Task 2: Extract the in-page collectors

**Files:**
- Create: `test/e2e/collect.ts`
- Modify: `test/e2e/geometry-audit.spec.ts`

**Interfaces:**
- Produces: `export function collectAudit(): AuditData` and `export function collectGeometry(): Geometry`, plus the `AuditData`, `Geometry`, `EdgeGeom`, `NodeGeom`, `ChipGeom`, `ChipRect`, `RowCenter`, `MultPair` types they use. Tasks 3, 5 and 6 import from here.

**This is a behaviour-preserving move.** Playwright serialises these function bodies and evaluates them in the browser, so they must stay self-contained: no outer-scope references, no imported helpers, no module-level constants. `geometry-audit.spec.ts:566` already documents this rule. Helpers that live inside a collector today stay inside it.

- [ ] **Step 1: Record the pre-change e2e baseline**

```bash
bun run test:e2e -- geometry-audit 2>&1 | tail -20 > /tmp/e2e-before.txt
cat /tmp/e2e-before.txt
```

Write down the exact pass/fail counts and the names of any failing tests. This is the comparison target. Do NOT expect a green run.

- [ ] **Step 2: Create `test/e2e/collect.ts` by moving code**

Move, verbatim and without edits, out of `test/e2e/geometry-audit.spec.ts`:
- the `AuditData`, `ChipRect`, `RowCenter`, `MultPair` type declarations
- `function collectAudit(): AuditData` (defined at :115)
- the `EdgeGeom`, `NodeGeom`, `ChipGeom`, `Geometry` type declarations
- `function collectGeometry(): Geometry` (defined at :561), including its leading comment block

Add `export` to each. Add a file header explaining that these run in page context and why they must stay self-contained.

- [ ] **Step 3: Import them in the spec**

In `test/e2e/geometry-audit.spec.ts`, delete the moved declarations and add:

```ts
import { collectAudit, collectGeometry, type AuditData, type Geometry } from "./collect";
```

Keep every other line of the spec untouched, including all baseline tables and rulings.

- [ ] **Step 4: Verify the pass/fail set is unchanged**

```bash
bun run typecheck && bun run lint
bun run test:e2e -- geometry-audit 2>&1 | tail -20 > /tmp/e2e-after.txt
diff /tmp/e2e-before.txt /tmp/e2e-after.txt
```

Expected: the diff shows no change in which tests pass and which fail. If any test flips in either direction, the move was not behaviour-preserving — revert and redo it.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/collect.ts test/e2e/geometry-audit.spec.ts
git commit -m "Extract in-page collectors into a shared module"
```

---

### Task 3: The `collectScene` collector

**Files:**
- Modify: `test/e2e/collect.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (page context only).
- Produces:

```ts
export type SceneElement = {
  id: string;
  kind: "node" | "edge" | "chip" | "junction" | "band" | "glyph" | "group";
  itemId?: string;
  label?: string;
  clientRect: { x: number; y: number; width: number; height: number };   // relative to .react-flow
  worldRect: { x: number; y: number; width: number; height: number };
  polyline?: Array<[number, number]>;    // world units, edges only
};

export type SceneCollection = {
  transform: { x: number; y: number; zoom: number };
  paneRect: { x: number; y: number; width: number; height: number };     // .react-flow, viewport coords
  overlays: Array<{ name: string; x: number; y: number; width: number; height: number }>;
  elements: SceneElement[];
};

export function collectScene(): SceneCollection;
```

Tasks 5 and 6 consume `SceneCollection`.

**Selectors, verified against `src/canvas/` on this branch:**

| kind | selector | id source |
| --- | --- | --- |
| node | `.react-flow__node` | `data-id` |
| edge | `.react-flow__edge-path` | element `id` |
| chip | `.flow-chip` | `data-testid`, falling back to `data-edge-id` |
| junction | `.bus-junction` | `data-testid` |
| band | `.bus-band` | `bus-band-<index>` |
| glyph | `[data-glyph]` | `glyph-<index>` |
| group | `.rf-group-box`, `[data-testid="loop-node"]` | enclosing node's `data-id` |

Overlays to measure: `.react-flow__controls` (always present) and `.react-flow__minimap` (present only above 15 nodes; emit only if found).

- [ ] **Step 1: Write the failing test**

The collector runs in page context, so test it through Playwright rather than jsdom. Create `test/e2e/collect-scene.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { SCENARIOS, scenarioHash } from "./scenarios";
import { collectScene } from "./collect";

test.use({ viewport: { width: 1920, height: 1080 } });

test("collectScene inventories every element kind on a dense plan", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("aef.locale", "en");
  });
  const scenario = SCENARIOS.find((s) => s.id === "battery5-xiranite")!;
  const hash = await scenarioHash(scenario);
  await page.goto(`/#${hash}`, { waitUntil: "load" });
  await expect(
    page.locator(".react-flow").locator(".react-flow__node-recipe").first(),
  ).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const scene = await page.evaluate(collectScene);

  const kinds = new Set(scene.elements.map((e) => e.kind));
  expect(kinds.has("node")).toBe(true);
  expect(kinds.has("edge")).toBe(true);
  expect(kinds.has("chip")).toBe(true);
  expect(kinds.has("band")).toBe(true);
  expect(scene.elements.every((e) => e.id !== "")).toBe(true);
  expect(new Set(scene.elements.map((e) => e.id)).size).toBe(scene.elements.length);
  expect(scene.overlays.some((o) => o.name === "controls")).toBe(true);
  expect(scene.transform.zoom).toBeGreaterThan(0);
  for (const e of scene.elements) {
    expect(Number.isFinite(e.worldRect.x)).toBe(true);
    expect(Number.isFinite(e.clientRect.x)).toBe(true);
  }
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun run test:e2e -- collect-scene
```

Expected: FAIL, `collectScene` is not exported.

- [ ] **Step 3: Implement `collectScene` in `test/e2e/collect.ts`**

Self-contained, same rule as Task 2. Structure:

1. Read `.react-flow` and `.react-flow__viewport`; derive `k`, `tx`, `ty` from `getComputedStyle(vp).transform` via `DOMMatrixReadOnly`, exactly as `collectGeometry` does.
2. Define local `toWorldX` / `toWorldY` closures inside the function body.
3. For each selector row in the table above, query, measure `getBoundingClientRect()`, subtract the pane's `left`/`top` for `clientRect`, and map through the inverse transform for `worldRect`.
4. For edges, also parse the `d` attribute into `polyline` (world units). Reuse the same parsing shape `collectGeometry` uses; do not import `parsePath` from `geometry.ts` — page context cannot see it, so inline the minimal parse.
5. Ensure ids are unique: when a selector yields no stable id, suffix by index (`bus-band-0`, `glyph-12`).
6. Collect overlays by selector, naming them `controls` and `minimap`.

- [ ] **Step 4: Run the test**

```bash
bun run test:e2e -- collect-scene
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/collect.ts test/e2e/collect-scene.spec.ts
git commit -m "Add scene collector for bands, junctions, glyphs and groups"
```

---

### Task 4: Tiling and coverage math

**Files:**
- Create: `tools/exam/tiling.ts`
- Create: `tools/exam/tiling.test.ts`
- Modify: `vitest.config.ts`

**Interfaces:**
- Produces, consumed by Task 5:

```ts
export type Rect = { x: number; y: number; width: number; height: number };
export type Viewport = { x: number; y: number; zoom: number };
export type TileSpec = { row: number; col: number; center: { x: number; y: number }; worldRect: Rect };

export function safeRegion(pane: Rect, overlays: readonly Rect[], inset: number): Rect;
export function viewportFor(center: { x: number; y: number }, zoom: number, safe: Rect): Viewport;
export function tileGrid(content: Rect, safe: Rect, targetZoom: number, overlap: number): TileSpec[];

export type CoverageElement = {
  id: string;
  kind: "point" | "extended";
  worldRect: Rect;
  polyline?: Array<[number, number]>;
};
export type CoverageResult = {
  covered: string[];
  uncovered: Array<{ id: string; kind: string; reason: string }>;
};
export function computeCoverage(
  elements: readonly CoverageElement[],
  tileWorldRects: readonly Rect[],
  seamMarginWorld: number,
): CoverageResult;
```

**Semantics that the tests pin:**
- `safeRegion` subtracts each overlay from the pane by shrinking on the axis where the overlay touches an edge, then applies `inset` on all four sides. Overlays that do not touch a pane edge are ignored (they cannot be subtracted without splitting the region).
- `viewportFor` satisfies React Flow's mapping `screen = world * zoom + offset`, placing `center` at the centre of `safe`: `x = safe.x + safe.width/2 - center.x*zoom`, `y = safe.y + safe.height/2 - center.y*zoom`.
- `tileGrid` covers `content` with tiles of world size `safe.width/targetZoom` by `safe.height/targetZoom`, stepping by `(1 - overlap)` of that size. Always at least one tile.
- `computeCoverage`: a `point` element is covered when its `worldRect` is fully inside one tile rect. An `extended` element is covered when every segment of its `polyline` (or, absent one, its `worldRect`) is contained in the union, AND at least one tile contains some part of it with `seamMarginWorld` of slack on one side.

- [ ] **Step 1: Add the vitest include**

In `vitest.config.ts`, extend `include` (keep the existing entries and the comment above them intact):

```ts
      include: [
        "test/**/*.{test,spec}.{ts,tsx}",
        "src/**/*.{test,spec}.{ts,tsx}",
        "tools/solver-cli/**/*.{test,spec}.{ts,tsx}",
        "tools/exam/**/*.{test,spec}.{ts,tsx}",
      ],
```

- [ ] **Step 2: Write the failing tests**

Create `tools/exam/tiling.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  safeRegion,
  viewportFor,
  tileGrid,
  computeCoverage,
  type Rect,
} from "./tiling";

const PANE: Rect = { x: 0, y: 0, width: 1920, height: 1080 };

describe("safeRegion", () => {
  test("subtracts a bottom-left overlay by raising the floor", () => {
    const controls: Rect = { x: 0, y: 1000, width: 40, height: 80 };
    const safe = safeRegion(PANE, [controls], 0);
    expect(safe.height).toBe(1000);
    expect(safe.y).toBe(0);
  });

  test("applies the inset on all four sides", () => {
    const safe = safeRegion(PANE, [], 10);
    expect(safe).toEqual({ x: 10, y: 10, width: 1900, height: 1060 });
  });

  test("ignores an overlay that touches no pane edge", () => {
    const floating: Rect = { x: 800, y: 400, width: 100, height: 100 };
    expect(safeRegion(PANE, [floating], 0)).toEqual(PANE);
  });
});

describe("viewportFor", () => {
  test("places the world centre at the centre of the safe region", () => {
    const safe: Rect = { x: 20, y: 20, width: 1880, height: 1040 };
    const vp = viewportFor({ x: 500, y: 300 }, 0.75, safe);
    expect(500 * vp.zoom + vp.x).toBeCloseTo(safe.x + safe.width / 2, 6);
    expect(300 * vp.zoom + vp.y).toBeCloseTo(safe.y + safe.height / 2, 6);
    expect(vp.zoom).toBe(0.75);
  });
});

describe("tileGrid", () => {
  const safe: Rect = { x: 0, y: 0, width: 1000, height: 1000 };

  test("returns a single tile when content fits", () => {
    const grid = tileGrid({ x: 0, y: 0, width: 100, height: 100 }, safe, 1, 0.15);
    expect(grid).toHaveLength(1);
    expect(grid[0]!.row).toBe(0);
    expect(grid[0]!.col).toBe(0);
  });

  test("tiles a plan four times wider than one tile", () => {
    const grid = tileGrid({ x: 0, y: 0, width: 4000, height: 1000 }, safe, 1, 0.15);
    const cols = new Set(grid.map((t) => t.col));
    expect(cols.size).toBeGreaterThanOrEqual(4);
    expect(new Set(grid.map((t) => t.row)).size).toBe(1);
  });

  test("neighbouring tiles overlap by the requested fraction", () => {
    const grid = tileGrid({ x: 0, y: 0, width: 4000, height: 1000 }, safe, 1, 0.15);
    const a = grid.find((t) => t.col === 0)!;
    const b = grid.find((t) => t.col === 1)!;
    const overlap = a.worldRect.x + a.worldRect.width - b.worldRect.x;
    expect(overlap).toBeCloseTo(1000 * 0.15, 6);
  });

  test("tile world size scales inversely with target zoom", () => {
    const at1 = tileGrid({ x: 0, y: 0, width: 10, height: 10 }, safe, 1, 0.15)[0]!;
    const at05 = tileGrid({ x: 0, y: 0, width: 10, height: 10 }, safe, 0.5, 0.15)[0]!;
    expect(at05.worldRect.width).toBeCloseTo(at1.worldRect.width * 2, 6);
  });
});

describe("computeCoverage", () => {
  const tile: Rect = { x: 0, y: 0, width: 100, height: 100 };

  test("a point element fully inside one tile is covered", () => {
    const r = computeCoverage(
      [{ id: "chip-1", kind: "point", worldRect: { x: 10, y: 10, width: 5, height: 5 } }],
      [tile],
      0,
    );
    expect(r.covered).toEqual(["chip-1"]);
    expect(r.uncovered).toEqual([]);
  });

  test("a point element straddling every tile boundary is uncovered", () => {
    const r = computeCoverage(
      [{ id: "chip-2", kind: "point", worldRect: { x: 95, y: 10, width: 20, height: 5 } }],
      [tile, { x: 100, y: 0, width: 100, height: 100 }],
      0,
    );
    expect(r.covered).toEqual([]);
    expect(r.uncovered[0]!.id).toBe("chip-2");
  });

  test("an extended element split across two tiles is covered by the union", () => {
    const r = computeCoverage(
      [
        {
          id: "e:1",
          kind: "extended",
          worldRect: { x: 0, y: 50, width: 200, height: 1 },
          polyline: [
            [0, 50],
            [200, 50],
          ],
        },
      ],
      [tile, { x: 90, y: 0, width: 110, height: 100 }],
      5,
    );
    expect(r.covered).toEqual(["e:1"]);
  });

  test("an extended element leaving the union is uncovered", () => {
    const r = computeCoverage(
      [
        {
          id: "e:2",
          kind: "extended",
          worldRect: { x: 0, y: 50, width: 300, height: 1 },
          polyline: [
            [0, 50],
            [300, 50],
          ],
        },
      ],
      [tile],
      0,
    );
    expect(r.uncovered[0]!.id).toBe("e:2");
  });
});
```

- [ ] **Step 3: Run and confirm failure**

```bash
bun run test -- tools/exam/tiling.test.ts
```

Expected: FAIL, module not found.

- [ ] **Step 4: Implement `tools/exam/tiling.ts`**

Pure functions only. No Playwright import, no DOM, no I/O — this module must stay unit-testable in jsdom. Include a file header explaining the coordinate contract (world vs CSS px) in ASCII.

- [ ] **Step 5: Run the tests**

```bash
bun run test -- tools/exam/tiling.test.ts
bun run typecheck && bun run lint
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tools/exam/tiling.ts tools/exam/tiling.test.ts vitest.config.ts
git commit -m "Add tiling and coverage math for the exam harness"
```

---

### Task 5: The `capture` CLI

**Files:**
- Create: `tools/exam/capture.ts`
- Create: `tools/exam/scene.ts`

**Interfaces:**
- Consumes: `collectScene`, `collectGeometry` from `test/e2e/collect.ts`; everything from `tools/exam/tiling.ts`; `window.__stcExam` from Task 1.
- Produces: `<out>/<planId>/scene.json` in the shape given in spec section 6, plus `00-fit.png`, `10-tile-r<r>c<c>.png`, `20-corrective-<id>.png`. Task 6 fills the `measurements` array; Task 7's probe reuses `bootPage` from `capture.ts`.
- Produces (exported for reuse by Task 7):

```ts
export type BootOptions = { baseUrl: string; hash: string; locale: string };
export async function bootPage(browser: Browser, opts: BootOptions): Promise<{ page: Page; consoleErrors: string[] }>;
```

**CLI contract:**

```
bun tools/exam/capture.ts --base-url <url> --hash <planHash> --plan-id <id> --out <dir>
                          [--target-zoom 0.75] [--locale en] [--max-tiles 64] [--seam-margin 64]
```

Follow the flag-parsing and usage-header style of `tools/solver-cli/main.ts` (read it first).

- [ ] **Step 1: Implement `bootPage` and the fail-fast checks**

- Reject a missing or unreachable `--base-url` before launching a browser: `fetch(baseUrl)` with a 5s timeout; on failure print the URL and `process.exit(2)`.
- `bootPage` navigates to `${baseUrl}/?exam=1#${hash}`. The query MUST precede the fragment.
- `page.addInitScript` sets `aef.locale`.
- Context options: `viewport: {width: 1920, height: 1080}`, `deviceScaleFactor: 2`.
- Wait sequence, in order: `waitUntil: "load"`; `.react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product` visible with a 30s timeout; `.canvas-annot.bottom-right` containing `READY`; `await page.evaluate(() => document.fonts.ready.then(() => undefined))`.
- If `READY` is not reached, `process.exit(3)` with the plan id on stderr.
- Collect `page.on("console")` errors into the returned array from the first navigation.

- [ ] **Step 2: Implement the capture loop**

1. `const bounds = await page.evaluate(() => window.__stcExam!.contentBounds())`. If null, exit 3 with "empty graph".
2. Screenshot `.react-flow` as `00-fit.png` with `{ scale: "css" }`, and record the fit transform.
3. Measure the pane rect and overlay rects via `collectScene`, then `safeRegion(pane, overlays, 8)`.
4. `tileGrid(bounds, safe, targetZoom, 0.15)`.
5. For each tile: `await page.evaluate((v) => window.__stcExam!.setViewport(v), viewportFor(tile.center, targetZoom, safe))`, wait 250ms for React Flow to settle, move the mouse to `(3, 3)` and wait 400ms so no hover-dim state is captured, then screenshot `.react-flow` with `{ scale: "css" }`, then `collectScene` to record per-tile element rects.
6. Union the per-tile element inventories into the element set at target zoom.
7. `computeCoverage(...)`. For each uncovered element, add a corrective tile centred on its `worldRect` centre and repeat step 5 for it. Stop at `--max-tiles`; set `status: "partial"` and keep the residual list.
8. Write `scene.json` through `tools/exam/scene.ts`.

- [ ] **Step 3: Smoke-test against the default plan**

```bash
bun run build && (bun run preview --port 4174 --strictPort &) && sleep 5
bun tools/exam/capture.ts --base-url http://localhost:4174 \
  --hash "$(bun -e 'import {SCENARIOS, scenarioHash} from "./test/e2e/scenarios"; console.log(await scenarioHash(SCENARIOS.find(s=>s.id==="default")))')" \
  --plan-id default --out .artifacts/exam
jq '.status, .coverage.uncovered, (.tiles | length)' .artifacts/exam/default/scene.json
```

Expected: `"complete"`, `[]`, and a small tile count (1-2 for the default plan).

- [ ] **Step 4: Determinism check**

Run the same command a second time into a different `--out`, then:

```bash
jq -S '.tiles | map({file, viewportTransform, safeRegion})' .artifacts/exam/default/scene.json > /tmp/a.json
jq -S '.tiles | map({file, viewportTransform, safeRegion})' .artifacts/exam2/default/scene.json > /tmp/b.json
diff /tmp/a.json /tmp/b.json
```

Expected: empty diff. Image bytes may differ by anti-aliasing; tile geometry must not.

- [ ] **Step 5: Commit**

```bash
git add tools/exam/capture.ts tools/exam/scene.ts
git commit -m "Add deterministic exam capture CLI"
```

---

### Task 6: Measurements and footprints in `scene.json`

**Files:**
- Modify: `tools/exam/scene.ts`
- Create: `tools/exam/measurements.test.ts`

**Interfaces:**
- Consumes: the audit functions from `test/e2e/geometry.ts` — `auditChipsOnOwnPath`, `auditChipsVsCards`, `auditSegmentsVsCards`, `auditSegmentsVsChips`, `auditOwnCardPierces`, `countCrossings`.
- Produces:

```ts
export type Measurement = {
  kind: "chip-off-own-path" | "chip-vs-card" | "segment-vs-card" | "own-card-pierce" | "chip-vs-segment";
  elementIds: string[];
  footprint: { x: number; y: number; width: number; height: number };   // world units
  detail: string;
};
export function measurementsFor(geom: Geometry, scene: SceneCollection): {
  measurements: Measurement[];
  crossingCensus: { count: number };
};
```

**Footprint derivation, one rule per kind (the audit payload shapes are at `test/e2e/geometry.ts:164, 210, 266, 366, 465`):**

| kind | source type | footprint |
| --- | --- | --- |
| `segment-vs-card` | `SegmentViolation.seg` | bounding rect of the segment |
| `own-card-pierce` | `OwnCardPierce.seg` | bounding rect of the segment |
| `chip-vs-segment` | `ChipViolation.seg` | bounding rect of the segment |
| `chip-vs-card` | `ChipCardViolation` (ids only) | chip world rect intersected with the card world rect; if they do not intersect, the chip world rect |
| `chip-off-own-path` | `ChipOffPathViolation` (distance only) | the chip's world rect |

`countCrossings` returns a bare number with no participating ids, so it is recorded as `crossingCensus` and is NEVER a measurement. Nothing may corroborate a finding from it.

- [ ] **Step 1: Write the failing test**

`tools/exam/measurements.test.ts` — construct small synthetic `Geometry` and `SceneCollection` values by hand (no browser) and assert one measurement of each kind gets a finite, non-empty footprint, and that `crossingCensus` is populated while `measurements` contains no crossing entry.

- [ ] **Step 2: Run and confirm failure**

```bash
bun run test -- tools/exam/measurements.test.ts
```

- [ ] **Step 3: Implement `measurementsFor` in `tools/exam/scene.ts`**

- [ ] **Step 4: Run the tests, then re-capture and inspect**

```bash
bun run test -- tools/exam/measurements.test.ts
bun tools/exam/capture.ts --base-url http://localhost:4174 --hash <battery5-xiranite hash> \
  --plan-id battery5-xiranite --out .artifacts/exam
jq '.measurements | group_by(.kind) | map({kind: .[0].kind, n: length}), .crossingCensus' \
  .artifacts/exam/battery5-xiranite/scene.json
```

Expected: nonzero counts across several kinds (this plan has accepted residue: 23 chip/segment, 16 own-pierce, 14 padded grazes), every entry carrying a finite footprint. These are measurements, not defects.

- [ ] **Step 5: Commit**

```bash
git add tools/exam/scene.ts tools/exam/measurements.test.ts
git commit -m "Record geometry measurements with footprints in scene.json"
```

---

### Task 7: The `probe` CLI

**Files:**
- Create: `tools/exam/probe.ts`

**Interfaces:**
- Consumes: `bootPage` from Task 5; `viewportFor` from Task 4.
- Produces the CLI that Task 11's refuters call.

```
bun tools/exam/probe.ts --base-url <url> --hash <hash> [--locale en]
                        [--zoom <z> --center <wx>,<wy>]
                        [--op <name> --arg k=v ...] [--eval <file.js>] [--shot <out.png>]
```

Prints one JSON object to stdout:

```ts
type ProbeResult = {
  ok: boolean;
  transform: { x: number; y: number; zoom: number };
  op?: string;
  opResult?: unknown;
  evalResult?: unknown;
  consoleErrors: string[];
};
```

**Ops to implement:**

| op | args | result |
| --- | --- | --- |
| `hover-edge` | `id` | `{hoverEngaged, pointsTried, observedDimmed: string[], expectedDimmed: string[]}` |
| `hover-node` | `id` | same shape |
| `contrast` | `selector` | `{ratio, fg, bg}` WCAG 2.1 relative-luminance ratio |
| `delta-e` | `a`, `b` (element selectors) | `{deltaE76}` over sRGB converted to Lab |
| `chip-binding` | `id` | `{ownPathDistance, nearestOtherPathDistance, nearestOtherEdgeId}` |
| `rect` | `id` | `{clientRect, worldRect}` |
| `computed-style` | `selector`, `props` (comma list) | `{[prop]: value}` |
| `text-overflow` | `selector` | `{scrollWidth, clientWidth, clipped: boolean}` |

**`hover-edge` is the load-bearing one — it exists because issue #30 was a capture artifact.** It must never use Playwright's element hover:

1. In page context, find the edge's interaction path (`.react-flow__edge[data-id="<id>"] .react-flow__edge-interaction`, falling back to `.react-flow__edge-path`).
2. Sample `getPointAtLength` at fractions `[0.5, 0.25, 0.75, 0.1, 0.9]` of `getTotalLength()`, mapping each through `getScreenCTM()` to viewport coordinates.
3. For each sample in order: `page.mouse.move(x, y)`, wait 250ms (past the 150ms hover-intent delay documented by `src/canvas/Canvas.test.tsx:208`), then check whether `.ak-canvas-theme` carries `hover-active`. Stop at the first sample that engages.
4. Report `hoverEngaged`, `pointsTried`, the observed set of elements carrying `dimmed`, and the **expected** complement derived from the scene's adjacency: everything not in the hovered edge's ego-network (its endpoints and their incident edges).

An empty observed set is only a defect when the expected set is non-empty. `hoverEngaged: false` after all samples means the probe could not engage and the finding is a capture miss, not a product defect.

**`--eval` constraints:** the file must export a single self-contained arrow function taking no arguments; run it with `page.evaluate` under a 5s timeout; JSON-stringify the result and truncate at 8 KB, marking `truncated: true` when cut.

- [ ] **Step 1: Implement the CLI and the ops**

- [ ] **Step 2: Verify against the #30 scenario**

This is acceptance criterion 5 from the spec: the harness must show hover DOES engage on the two plans where the old exam reported it dead.

```bash
EDGE=$(jq -r '.edges[0].id' .artifacts/exam/battery5-xiranite/scene.json)
bun tools/exam/probe.ts --base-url http://localhost:4174 --hash <battery5-xiranite hash> \
  --op hover-edge --arg id=$EDGE | jq '.opResult | {hoverEngaged, pointsTried, observed: (.observedDimmed|length), expected: (.expectedDimmed|length)}'
```

Expected: `hoverEngaged: true`, and a non-empty observed dimmed set. If it reports false, fix the point sampling before continuing — the whole refute phase depends on this op being trustworthy.

- [ ] **Step 3: Verify `contrast` reproduces the #27 measurement**

```bash
bun tools/exam/probe.ts --base-url http://localhost:4174 --hash <battery5-xiranite hash> \
  --op contrast --arg selector='.react-flow__edge[data-id="<a sewage edge id>"] .react-flow__edge-path' | jq '.opResult'
```

Expected: a ratio at or above 4.5. `src/canvas/itemColor.ts` has enforced a 4.5:1 floor since 86c2921, so a lower number means the op is measuring the wrong backdrop, not that the app regressed.

- [ ] **Step 4: Commit**

```bash
git add tools/exam/probe.ts
git commit -m "Add exam probe CLI with named runtime operations"
```

---

### Task 8: Rewrite the skill procedure

**Files:**
- Modify: `.claude/skills/render-exam/SKILL.md`

- [ ] **Step 1: Rewrite the procedure section**

New steps, replacing the current 1-7:

1. Build and preview (unchanged, port 4174).
2. Generate plan hashes from `test/e2e/scenarios.ts` (unchanged).
3. `bun tools/exam/capture.ts` per plan. No smoke-test step: capture fails fast by itself.
4. Run `bun run test:e2e -- geometry-audit` and record baseline EXCEEDANCES. These are the machine findings. The exam does not compute defects from raw measurements.
5. Extract measurements and coverage from each `scene.json` with `jq`, and pass them to the workflow as args.
6. Run the workflow (Evaluate, triage, Refute).
7. Group into families and file issues (unchanged), reporting any plan with `status: "partial"` and any console errors.

- [ ] **Step 2: Rewrite the gotcha table**

Delete the traps the harness now makes impossible: hash-only goto, pan-drag corruption, mouse-rest hover-dim, the LOD zoom floor, JSON-stringified args, and the chromium OOM chunking. Keep and add:

| Trap | Rule |
| --- | --- |
| A plan captured at `status: "partial"` has blind spots | Report it; never let an evaluator make absence claims about uncovered ids |
| Raw geometry measurements are not defects | Baselines in `geometry-audit.spec.ts` permit large nonzero counts after written rulings |
| `hoverEngaged: false` is a capture miss, not a product defect | Re-probe another point before believing an absence claim |
| The exam runs `?exam=1` | Without it `window.__stcExam` is absent and capture exits non-zero |

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/render-exam/SKILL.md
git commit -m "Rewrite render-exam procedure around the frozen harness"
```

---

## Phase 2 - the workflow

### Task 9: The corroboration join

**Files:**
- Create: `tools/exam/triage.ts`
- Create: `tools/exam/triage.test.ts`

**Interfaces:**
- Consumes: `Measurement` from `tools/exam/scene.ts` (Task 6) and `Rect` from `tools/exam/tiling.ts` (Task 4).
- Produces, consumed by Task 10:

```ts
export type ClaimType = "geometric" | "interaction" | "absence" | "subjective";
export type Finding = {
  id: string;
  planId: string;
  title: string;
  observation: string;
  claimType: ClaimType;
  evidence: Array<{ image: string; rect: [number, number, number, number]; where: string }>;
  severity: "major" | "minor" | "nit";
  aspect: "correctness" | "comprehension" | "ux";
  falsifier?: { op: string; args: Record<string, string>; expectedIfFalse: string };
  mechanismHypothesis?: string;
};
export type Route = "CORROBORATED" | "REFUTE_INDIVIDUAL" | "REFUTE_BATCH" | "HUMAN_RULING";

export function corroborationsFor(
  finding: Finding,
  measurements: readonly Measurement[],
  tiles: readonly { file: string; viewportTransform: { x: number; y: number; zoom: number }; safeRegion: Rect }[],
): Measurement[];

export function routeFinding(finding: Finding, corroborations: readonly Measurement[]): Route;
export function validateFinding(finding: Finding): string[];   // schema violations, empty when valid
```

**Rules:**
- `corroborationsFor` requires BOTH: (a) the measurement's world footprint, projected into the cited tile's image space via that tile's `viewportTransform`, intersects the evidence rect; and (b) the kinds are compatible per this table.

| `claimType` | compatible measurement kinds |
| --- | --- |
| `geometric` | all five |
| `interaction` | none |
| `absence` | none |
| `subjective` | none |

Shared element id alone never corroborates: a long edge can be measured at one end while the evidence rect sits hundreds of pixels away on the same edge.

- `routeFinding`: `subjective` -> `HUMAN_RULING`. `absence` or `interaction` or a present `mechanismHypothesis` -> `REFUTE_INDIVIDUAL`. `geometric` with a non-empty corroboration list -> `CORROBORATED`. Uncorroborated `major` -> `REFUTE_INDIVIDUAL`. Everything else -> `REFUTE_BATCH`.
- `validateFinding`: `falsifier` required when `claimType` is `geometric`, `interaction` or `absence`, or when `mechanismHypothesis` is present; forbidden when `claimType` is `subjective`. Empty `observation` or empty `evidence` is a violation.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum: a geometric finding whose evidence rect overlaps a projected footprint is corroborated; the same finding with the rect moved 500 px away is NOT corroborated even though the element id matches; an interaction claim is never corroborated; a subjective finding with a falsifier fails validation; a geometric finding without a falsifier fails validation; routing for each of the four outcomes.

- [ ] **Step 2: Run and confirm failure**

```bash
bun run test -- tools/exam/triage.test.ts
```

- [ ] **Step 3: Implement `tools/exam/triage.ts`**

- [ ] **Step 4: Run the tests**

```bash
bun run test -- tools/exam/triage.test.ts && bun run typecheck && bun run lint
```

- [ ] **Step 5: Commit**

```bash
git add tools/exam/triage.ts tools/exam/triage.test.ts
git commit -m "Add corroboration join and finding routing"
```

---

### Task 10: Rewrite the workflow's Evaluate phase

**Files:**
- Modify: `.claude/workflows/render-quality-exam.js`

**Interfaces:**
- Consumes: `args` of shape `{plans: [{id, dir, url, images: [{file, what}], coverage}], measurements: {[planId]: Measurement[]}, examDir}`.
- Produces: the findings array Task 11 refutes.

- [ ] **Step 1: Delete the Capture phase**

Remove `CAPTURE_SCHEMA`, `capturePrompt`, the chunk loop, and the `model: "opus"` capture agents entirely. Capture now happens before the workflow runs.

- [ ] **Step 2: Replace `FINDINGS_SCHEMA`**

Encode exactly the Task 9 `Finding` type, with `claimType`, `falsifier` and `mechanismHypothesis`, plus `evidence[].rect` as a 4-number array. Add `blindSpotsAcknowledged` at the top level.

- [ ] **Step 3: Rewrite `evalPrompt`**

Keep the domain briefing and the intentional-behaviours list from the current prompt. Add:
- the coverage ledger, verbatim, with the instruction that no absence claim may be made about an uncovered element id;
- the claim-type taxonomy and when each applies;
- the falsifier rule: required for geometric/interaction/absence and for any mechanism hypothesis, forbidden for subjective;
- the instruction to cite a pixel rect in every evidence entry;
- an explicit statement that mechanism is optional and that a symptom with no cause is a complete, valuable finding.

Do NOT pass measurements into this prompt. The evaluator judges cold; that independence is the design's premise.

- [ ] **Step 4: Verify the phase runs**

Run the workflow against one already-captured plan and confirm findings validate:

```bash
jq '.findings[] | {claimType, hasFalsifier: (.falsifier != null), rects: [.evidence[].rect]}' <workflow output>
```

Expected: every non-subjective finding carries a falsifier; every evidence entry carries a 4-number rect.

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/render-quality-exam.js
git commit -m "Rewrite exam workflow evaluate phase around typed findings"
```

---

### Task 11: Add the Refute phase

**Files:**
- Modify: `.claude/workflows/render-quality-exam.js`

- [ ] **Step 1: Add the triage step**

Between Evaluate and Refute, in plain JS inside the workflow script (no agent). Import is impossible in a workflow script, so inline the routing rules from Task 9 — and keep them identical to `tools/exam/triage.ts`. Log the routing histogram with `log()` so a run reports how many findings took each path.

- [ ] **Step 2: Add `REFUTE_SCHEMA`**

```js
const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    findingId: { type: 'string' },
    observationVerdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNCERTAIN'] },
    mechanismVerdict: { type: 'string', enum: ['CONFIRMED', 'REFUTED', 'UNCERTAIN'] },
    probeCommand: { type: 'string' },
    probeOutput: { type: 'string' },
    reasoning: { type: 'string' },
    correctedObservation: { type: 'string' },
  },
  required: ['findingId', 'observationVerdict', 'probeCommand', 'probeOutput', 'reasoning'],
}
```

- [ ] **Step 3: Add the refuter prompt**

It must state: the refuter's job is to DISPROVE the finding; it must run `bun tools/exam/probe.ts` and paste the real command and output; a screenshot is not acceptable evidence for an absence claim; `UNCERTAIN` is the correct verdict when the probe is inconclusive, and is preferred over guessing; observation and mechanism are judged separately, and "symptom real, cause wrong" is a common and expected outcome.

- [ ] **Step 4: Wire the routing**

- `REFUTE_INDIVIDUAL` -> one agent per finding.
- `REFUTE_BATCH` -> one agent per plan handling all its batched findings, returning an array of verdicts.
- `CORROBORATED` -> no agent; synthesise `{observationVerdict: 'CONFIRMED'}` carrying the corroborating measurement ids.
- `HUMAN_RULING` -> no agent; pass through flagged.
- Any null agent result, or a verdict missing `probeOutput`, is coerced to `UNCERTAIN`.

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/render-quality-exam.js
git commit -m "Add refute phase with per-claim verdicts"
```

---

### Task 12: Acceptance run

**Files:**
- Modify: `.claude/skills/render-exam/SKILL.md` (only if the run exposes a gap)

- [ ] **Step 1: Full verification**

```bash
bun run typecheck && bun run lint && bun run test
bun run test:e2e 2>&1 | tail -20
```

Expected: typecheck, lint, vitest all pass. For e2e, compare the pass/fail set against the baseline recorded in Task 2 — unchanged, not green.

- [ ] **Step 2: Capture the full corpus**

Capture `default`, `crystal`, `battery5-xiranite`, `multi6`. Record for each: tile count, `status`, `coverage.uncovered` length, and wall-clock.

Expected tile counts from the fit zooms in `src/canvas/ItemEdge.tsx:137-147`: default 1-2, crystal ~6, battery5-xiranite ~16, multi6 ~36. A count far above these means the safe region or the grid step is wrong.

- [ ] **Step 3: Check the acceptance criteria**

Walk spec section 11 and record pass/fail for each of the five criteria, with evidence.

- [ ] **Step 4: Commit and report**

```bash
git add -A && git commit -m "Record exam harness acceptance run"
```

Report the corpus table, the five criteria, and anything deferred.
