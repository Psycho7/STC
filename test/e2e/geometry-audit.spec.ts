import { test, expect, type Page } from "@playwright/test";
import { SCENARIOS, scenarioHash } from "./scenarios";
import {
  auditChipsOnOwnPath,
  auditChipsVsCards,
  auditSegmentsVsCards,
  auditSegmentsVsChips,
  countCrossings,
  endpointManhattan,
  fmtSeg,
  parsePath,
  polylineLength,
  type ChipRect as GeomChipRect,
  type NodeRect,
  type RawEdge,
} from "./geometry";

// The P1 acceptance gate for the placement campaign: a DOM-geometry audit run
// against the live client rects the user actually sees. Two invariants per
// scenario at fit zoom on 1920x1080:
//   (a) no two .flow-chip boxes overlap (chips counter-scale about their centre,
//       so their client rects are the on-screen boxes - no unscaling needed);
//   (b) every recipe handle sits vertically centred on its .rn-row (handles are
//       row-embedded, xyflow centres them with top:50% translate(-50%,-50%)).
// Nothing is selected during measurement: a selected node draws a 2px border vs
// the normal 1px, which shifts rects. The spec only loads and reads - no clicks.

test.use({ viewport: { width: 1920, height: 1080 } });

// Chips can legitimately abut edge-to-edge when the trunk pitch equals the
// max-scale box height (boxes touch at zoom <= 0.5). A shared boundary
// (a.bottom == b.top) is not an overlap, so require strict interpenetration of
// more than this many pixels on BOTH axes before flagging a pair.
const OVERLAP_EPS_PX = 0.5;
// Row-embedded handles centre on their row via CSS; the only slack is subpixel
// rounding of two independently laid-out client rects.
const HANDLE_CENTER_TOL_PX = 1;

type ChipRect = {
  label: string;
  x: number;
  y: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type RowCenter = {
  nodeId: string;
  item: string;
  rowClass: string;
  rowCenterY: number;
  handleCenterY: number | null;
};

// Per recipe node that shows a machine-multiplier chip: the chip's box and the
// adjacent rate-block box. Audit issue 5 was the old absolute .rn-mult-badge
// overlapping the rate figures; the promoted header cell must keep them apart.
type MultPair = {
  nodeId: string;
  chip: ChipRect;
  rate: ChipRect;
};

type AuditData = {
  chips: ChipRect[];
  rows: RowCenter[];
  multPairs: MultPair[];
  recipeNodeCount: number;
};

async function waitForCanvasReady(page: Page): Promise<void> {
  const anyNode = page
    .locator(".react-flow")
    .locator(
      ".react-flow__node-recipe, .react-flow__node-loop, .react-flow__node-product",
    )
    .first();
  await expect(anyNode).toBeVisible({ timeout: 30_000 });
}

// Fit-view is a one-shot, no-animation camera move applied once layout lands.
// Measuring mid-move would read stale rects, so block until the viewport
// transform holds identical across two animation frames.
async function waitForStableViewport(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
      if (vp === null) return false;
      const now = vp.style.transform;
      const prev = (vp as unknown as { __auditPrevTransform?: string })
        .__auditPrevTransform;
      (
        vp as unknown as { __auditPrevTransform?: string }
      ).__auditPrevTransform = now;
      return prev !== undefined && prev === now && now !== "";
    },
    undefined,
    { timeout: 10_000, polling: "raf" },
  );
}

function collectAudit(): AuditData {
  const chips = Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      label:
        el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "(chip)",
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  });

  const toRect = (el: HTMLElement, label: string): ChipRect => {
    const r = el.getBoundingClientRect();
    return {
      label,
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
    };
  };

  const recipeNodes = Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node-recipe"),
  );
  const rows: RowCenter[] = [];
  const multPairs: MultPair[] = [];
  for (const node of recipeNodes) {
    const nodeId = node.getAttribute("data-id") ?? "(node)";
    const chipEl = node.querySelector<HTMLElement>(".rn-mult-chip");
    const rateEl = node.querySelector<HTMLElement>(".rn-rate-block");
    if (chipEl !== null && rateEl !== null) {
      multPairs.push({
        nodeId,
        chip: toRect(chipEl, "mult-chip"),
        rate: toRect(rateEl, "rate-block"),
      });
    }
    for (const row of Array.from(
      node.querySelectorAll<HTMLElement>(".rn-row"),
    )) {
      const rr = row.getBoundingClientRect();
      const handle = row.querySelector<HTMLElement>(".react-flow__handle");
      const hr = handle?.getBoundingClientRect() ?? null;
      rows.push({
        nodeId,
        item: row.querySelector(".lbl")?.getAttribute("title") ?? row.className,
        rowClass: row.className,
        rowCenterY: rr.y + rr.height / 2,
        handleCenterY: hr === null ? null : hr.y + hr.height / 2,
      });
    }
  }

  return { chips, rows, multPairs, recipeNodeCount: recipeNodes.length };
}

// Strict interpenetration on both axes, beyond the abutment epsilon.
function overlapPx(
  a: ChipRect,
  b: ChipRect,
): { dx: number; dy: number } | null {
  const dx = Math.min(a.right, b.right) - Math.max(a.x, b.x);
  const dy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
  if (dx > OVERLAP_EPS_PX && dy > OVERLAP_EPS_PX) return { dx, dy };
  return null;
}

function fmtRect(r: ChipRect): string {
  return `[${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.width.toFixed(1)}x${r.height.toFixed(1)}]`;
}

test.describe("DOM geometry audit", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
    });
  });

  for (const scenario of SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const hash = await scenarioHash(scenario);
      await page.goto(`/#${hash}`, { waitUntil: "load" });
      await waitForCanvasReady(page);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await waitForStableViewport(page);

      const { chips, rows, multPairs, recipeNodeCount } =
        await page.evaluate(collectAudit);

      // (a) Zero pairwise chip overlaps. Collect the full inventory so one run
      // reports every offending pair, not just the first.
      const overlaps: string[] = [];
      for (let i = 0; i < chips.length; i++) {
        for (let j = i + 1; j < chips.length; j++) {
          const hit = overlapPx(chips[i]!, chips[j]!);
          if (hit !== null) {
            overlaps.push(
              `"${chips[i]!.label}" ${fmtRect(chips[i]!)} vs ` +
                `"${chips[j]!.label}" ${fmtRect(chips[j]!)} ` +
                `overlap ${hit.dx.toFixed(1)}x${hit.dy.toFixed(1)}px`,
            );
          }
        }
      }

      // (b) Every row handle centred on its row (vertical axis).
      const offCenter: string[] = [];
      for (const row of rows) {
        if (row.handleCenterY === null) {
          offCenter.push(
            `${row.nodeId} row "${row.item}" (${row.rowClass}) has no handle`,
          );
          continue;
        }
        const delta = Math.abs(row.handleCenterY - row.rowCenterY);
        if (delta > HANDLE_CENTER_TOL_PX) {
          offCenter.push(
            `${row.nodeId} row "${row.item}" (${row.rowClass}) ` +
              `handle centre off by ${delta.toFixed(2)}px ` +
              `(row ${row.rowCenterY.toFixed(1)}, handle ${row.handleCenterY.toFixed(1)})`,
          );
        }
      }

      // (c) The machine-multiplier chip and the rate block never overlap. The
      // promoted header cell replaced the old absolute .rn-mult-badge overlay
      // (audit issue 5); the two boxes must stay disjoint on every node that
      // shows a chip.
      const chipCollisions: string[] = [];
      for (const pair of multPairs) {
        const hit = overlapPx(pair.chip, pair.rate);
        if (hit !== null) {
          chipCollisions.push(
            `${pair.nodeId}: mult-chip ${fmtRect(pair.chip)} overlaps ` +
              `rate-block ${fmtRect(pair.rate)} by ` +
              `${hit.dx.toFixed(1)}x${hit.dy.toFixed(1)}px`,
          );
        }
      }

      // Handle centring is a per-node CSS invariant independent of chip layout;
      // assert it first so that if a scenario also has chip overlaps, reaching
      // the overlap assertion still confirms the handles were centred.
      expect(
        offCenter,
        `${scenario.id}: ${offCenter.length} off-centre handle(s) among ${rows.length} rows in ${recipeNodeCount} recipe node(s):\n${offCenter.join("\n")}`,
      ).toEqual([]);
      expect(
        chipCollisions,
        `${scenario.id}: ${chipCollisions.length} mult-chip/rate-block overlap(s) among ${multPairs.length} chipped node(s):\n${chipCollisions.join("\n")}`,
      ).toEqual([]);
      expect(
        overlaps,
        `${scenario.id}: ${overlaps.length} chip overlap(s) among ${chips.length} chips:\n${overlaps.join("\n")}`,
      ).toEqual([]);
    });
  }
});

// -- P2 segment-placement audit ----------------------------------------------
//
// A DOM-geometry audit of the edge polylines the user actually sees, at fit zoom
// on 1920x1080, in flow (graph) coordinates. The browser side reads every edge
// path's `d` (already in flow coordinates -- the viewport <g> carries the
// pan/zoom transform) plus every node's raw card rect and every chip's box
// (client rects mapped back through the inverse viewport transform, so edges,
// cards, and chips share one coordinate system). The pure scoring in ./geometry
// runs four tiers plus two independent checks, ALL evaluated on every run
// (soft assertions), so one failing tier never hides another:
//   tier 1 (HARD): zero edge segments entering a FOREIGN RAW (unpadded) card;
//   tier 2 (SOFT ratchet): segments entering a foreign chip box <= per-scenario
//     baseline (zero on sparse plans; 2B trades bounded line-occlusion on the
//     packed plans for the hard card clearance tier 4 enforces);
//   tier 3 (SOFT ratchet): padding-only grazes per scenario <= recorded
//     baseline (packed-layout residue where sibling paddings overlap);
//   tier 4 (P3): chip/foreign-card overlaps HARD ZERO on every scenario (the
//     ratified acceptance criterion), plus chips-off-own-line as a SOFT ratchet
//     (residue where parallel edges / bus lanes / card-hardness force a nudge);
//   census: pairwise crossing count <= the pre-P2 baseline;
//   detour: the tundra ore feed within 1.5x its endpoints' Manhattan gap.

// Pre-P2 crossing baseline, recorded from the P1-gate commit a17bec1 by running
// the same countCrossings logic over the seven scenarios at fit zoom (a detached
// worktree, since deleted). Current routing must never produce MORE crossings
// than this per scenario. Not a target -- an upper bound that ratchets down.
const CROSSING_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 187,
  "battery5-xiranite": 771,
  crystal: 1,
  equip4: 26,
  multi6: 236,
  tundra: 13,
};

// Padding-graze baseline (tier 3): segments that clip only a foreign card's
// padding overhang (entry-chip reserve / port stub), never the raw box. All
// remaining grazes live where sibling paddings overlap inside a packed column,
// with no padded-clear column in the routing model (the raw fallback threads
// the raw gap instead, trading a raw strike for a graze). Recorded post-fix at
// this commit's measured counts; the ratchet only tightens.
const PADDED_GRAZE_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 11,
  "battery5-xiranite": 7,
  crystal: 3,
  equip4: 11,
  multi6: 15,
  tundra: 3,
};

// P3 chip-tier ratchets. Chip seating follows the ratified priority order:
// chip-vs-chip and chip-vs-CARD clearance are HARD (both asserted at zero
// below, so neither appears here); staying on the own polyline and clearing
// foreign flow lines are preferences that yield when the hard pair forces an
// escape. The two residues below are per-scenario ratchets, zero on the sparse
// plans and held at the packed plans' measured counts. They only tighten.
//   chip-vs-segment: a foreign flow line passing under a chip box. NOT zero
//     because the 2B anchor seats rate chips on the vertical corridor legs,
//     which in a packed plan also carry the parallel flow bundles: a wide chip
//     box there necessarily occludes a crossing sibling line, and the hard
//     chip/card invariant forbids the escapes that would clear it.
//   chip-off-path: a chip nudged off its own polyline. NOT zero because
//     coincident parallel edges and shared bus lanes cannot separate along one
//     shared line, and card-hardness can push the escape past every on-line
//     candidate; the seat stays as near the line as the hard pair allows.
const CHIP_SEGMENT_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 29,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 4,
  multi6: 0,
  tundra: 1,
};
// battery5 rose 5 -> 6 when chip-vs-card went hard: one pinned chip's on-line
// candidates all overlap a card, so card-hardness pushes its seat off the line.
const CHIP_OFFPATH_BASELINE: Record<string, number> = {
  default: 1,
  battery5: 6,
  "battery5-xiranite": 0,
  crystal: 1,
  equip4: 7,
  multi6: 0,
  tundra: 2,
};

type EdgeGeom = { id: string; d: string };
type NodeGeom = {
  nodeId: string;
  type: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};
type ChipGeom = {
  edgeId: string;
  label: string;
  kind: "entry" | "label" | "bus";
  left: number;
  top: number;
  right: number;
  bottom: number;
};
type Geometry = { edges: EdgeGeom[]; nodes: NodeGeom[]; chips: ChipGeom[] };

// Read the live flow-coordinate geometry: every edge path's id + `d`, every
// node's raw card rect, and every edge-owned chip box (data-edge-id, the
// FlowChip ownership hook). Rects come from getBoundingClientRect mapped back
// through the inverse viewport transform (translate + uniform scale), so cards,
// chips, and edge segments are directly comparable. Self-contained for
// page.evaluate (no outer-scope references).
function collectGeometry(): Geometry {
  const rf = document.querySelector<HTMLElement>(".react-flow");
  const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
  const rfRect = rf!.getBoundingClientRect();
  const m = new DOMMatrixReadOnly(getComputedStyle(vp!).transform);
  const k = m.a;
  const tx = m.e;
  const ty = m.f;
  const toGraphX = (clientX: number): number =>
    (clientX - rfRect.left - tx) / k;
  const toGraphY = (clientY: number): number => (clientY - rfRect.top - ty) / k;

  const edges = Array.from(
    document.querySelectorAll<SVGPathElement>(".react-flow__edge-path"),
  ).map((p) => ({ id: p.id, d: p.getAttribute("d") ?? "" }));

  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(".react-flow__node"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    const cls = el.className;
    const match = /react-flow__node-(\w+)/.exec(cls);
    return {
      nodeId: el.getAttribute("data-id") ?? "(node)",
      type: match?.[1] ?? "(type)",
      left: toGraphX(r.left),
      top: toGraphY(r.top),
      right: toGraphX(r.right),
      bottom: toGraphY(r.bottom),
    };
  });

  const chips = Array.from(
    document.querySelectorAll<HTMLElement>(".flow-chip[data-edge-id]"),
  ).map((el) => {
    const r = el.getBoundingClientRect();
    const testId = el.getAttribute("data-testid") ?? "";
    return {
      edgeId: el.getAttribute("data-edge-id") ?? "",
      label: el.getAttribute("aria-label") ?? "(chip)",
      // Three chip families: entry markers pinned at a port, lane-anchored bus
      // drop/rise chips (out of scope for the corridor invariants), and item
      // rate chips ("label"). Only rate chips ride the clear-segment anchor.
      kind: (testId.startsWith("item-edge-entry-")
        ? "entry"
        : testId.startsWith("bus-edge-")
          ? "bus"
          : "label") as "entry" | "label" | "bus",
      left: toGraphX(r.left),
      top: toGraphY(r.top),
      right: toGraphX(r.right),
      bottom: toGraphY(r.bottom),
    };
  });

  return { edges, nodes, chips };
}

// Parse an edge id `e:<index>:<from>-><to>:<item>` (layout.ts) into its source,
// target, and item. from / to are ELK unit ids (no `->` or trailing `:item`).
function parseEdgeId(
  id: string,
): { source: string; target: string; item: string } | null {
  const m = /^e:\d+:(.+)->(.+):([^:]+)$/.exec(id);
  if (m === null) return null;
  return { source: m[1]!, target: m[2]!, item: m[3]! };
}

function toRawEdges(edges: EdgeGeom[]): RawEdge[] {
  const out: RawEdge[] = [];
  for (const e of edges) {
    const parsed = parseEdgeId(e.id);
    if (parsed === null) continue;
    out.push({ id: e.id, d: e.d, ...parsed });
  }
  return out;
}

async function loadScenario(page: Page, hash: string): Promise<void> {
  await page.goto(`/#${hash}`, { waitUntil: "load" });
  await waitForCanvasReady(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await waitForStableViewport(page);
}

// The tundra ore-feed edge: the ore item entering the tundra chain. Selected by
// item id so the bound tracks the same physical edge across routing changes; the
// longest-span ore edge (largest endpoint Manhattan) is the cross-graph feed the
// detour bound targets, ties broken by edge id for determinism.
function tundraOreFeed(edges: RawEdge[]): RawEdge | null {
  const ore = edges.filter((e) => e.item.includes("ore"));
  if (ore.length === 0) return null;
  ore.sort((a, b) => {
    const da = endpointManhattan(parsePath(a.d));
    const db = endpointManhattan(parsePath(b.d));
    if (da !== db) return db - da;
    return a.id < b.id ? -1 : 1;
  });
  return ore[0]!;
}

test.describe("segment placement audit", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
    });
  });

  for (const scenario of SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const hash = await scenarioHash(scenario);
      await loadScenario(page, hash);

      const geom = await page.evaluate(collectGeometry);
      const rawEdges = toRawEdges(geom.edges);
      const nodes: NodeRect[] = geom.nodes.map((n) => ({
        nodeId: n.nodeId,
        type: n.type,
        left: n.left,
        top: n.top,
        right: n.right,
        bottom: n.bottom,
      }));

      // Every criterion below asserts SOFT so a failing tier never hides the
      // others: the census and detour bound are still evaluated (and reported)
      // even when a card tier is red.

      const violations = auditSegmentsVsCards(rawEdges, nodes);

      // Tier 1 (HARD gate): zero segments entering a foreign RAW card box.
      const rawHits = violations.filter((v) => v.raw);
      const rawInventory = rawHits.map(
        (v) => `  ${v.edgeId} seg ${fmtSeg(v.seg)} pierces RAW card ${v.card}`,
      );
      expect
        .soft(
          rawHits.length,
          `${scenario.id}: ${rawHits.length} RAW segment/card intersection(s):\n${rawInventory.join("\n")}`,
        )
        .toBe(0);

      // Tier 2 (SOFT ratchet): segments entering a foreign edge's chip box stay
      // at or below the per-scenario baseline. Zero on the sparse plans; the 2B
      // anchor trades a bounded set of line-occlusions on the packed plans (see
      // CHIP_SEGMENT_BASELINE) for the chip/card clearance the next tier checks.
      const chips = geom.chips as GeomChipRect[];
      const chipHits = auditSegmentsVsChips(rawEdges, chips, nodes);
      const chipInventory = chipHits.map(
        (v) =>
          `  ${v.edgeId} seg ${fmtSeg(v.seg)} pierces chip of ${v.chipEdgeId} ("${v.chipLabel}")`,
      );
      const chipSegBaseline = CHIP_SEGMENT_BASELINE[scenario.id]!;
      expect
        .soft(
          chipHits.length,
          `${scenario.id}: ${chipHits.length} segment/chip intersection(s) exceeds baseline ${chipSegBaseline} among ${geom.chips.length} chips:\n${chipInventory.join("\n")}`,
        )
        .toBeLessThanOrEqual(chipSegBaseline);

      // Tier 4 (P3). Chip-vs-card is the RATIFIED HARD gate: zero chip boxes
      // entering a FOREIGN raw card, on every scenario. The seating pass
      // upholds it by priority order -- when the on-line slide cannot clear,
      // the escape cascade treats cards (like chips) as hard obstacles and
      // yields the softer preferences instead (on-own-line, foreign-line
      // clearance), which are the ratcheted residues asserted after it.
      const chipCardHits = auditChipsVsCards(chips, rawEdges, nodes);
      const chipCardInventory = chipCardHits.map(
        (v) =>
          `  ${v.chipKind} chip of ${v.chipEdgeId} ("${v.chipLabel}") enters RAW card ${v.card}`,
      );
      expect
        .soft(
          chipCardHits.length,
          `${scenario.id}: ${chipCardHits.length} chip/card intersection(s) among ${chips.length} chips:\n${chipCardInventory.join("\n")}`,
        )
        .toBe(0);

      const offPath = auditChipsOnOwnPath(chips, rawEdges);
      const offPathInventory = offPath.map(
        (v) =>
          `  chip of ${v.chipEdgeId} ("${v.chipLabel}") is ${v.distance.toFixed(2)}px off its polyline`,
      );
      const offPathBaseline = CHIP_OFFPATH_BASELINE[scenario.id]!;
      expect
        .soft(
          offPath.length,
          `${scenario.id}: ${offPath.length} label chip(s) off their own polyline exceeds baseline ${offPathBaseline}:\n${offPathInventory.join("\n")}`,
        )
        .toBeLessThanOrEqual(offPathBaseline);

      // Tier 3 (SOFT ratchet): padding-only grazes stay at or below the
      // recorded baseline. These clip a foreign card's padding overhang (entry
      // chip reserve / port stub) where sibling paddings overlap in a packed
      // column; they never touch the raw box.
      const grazes = violations.filter((v) => !v.raw);
      const grazeInventory = grazes.map(
        (v) => `  ${v.edgeId} seg ${fmtSeg(v.seg)} grazes padding of ${v.card}`,
      );
      const grazeBaseline = PADDED_GRAZE_BASELINE[scenario.id]!;
      expect
        .soft(
          grazes.length,
          `${scenario.id}: ${grazes.length} padding graze(s) exceeds baseline ${grazeBaseline}:\n${grazeInventory.join("\n")}`,
        )
        .toBeLessThanOrEqual(grazeBaseline);

      // Census: pairwise crossings never regress past the pre-P2 baseline.
      const crossings = countCrossings(geom.edges);
      const baseline = CROSSING_BASELINE[scenario.id]!;
      expect
        .soft(
          crossings,
          `${scenario.id}: ${crossings} crossings exceeds pre-P2 baseline ${baseline}`,
        )
        .toBeLessThanOrEqual(baseline);

      // Detour: the tundra ore feed stays within 1.5x its endpoints' Manhattan
      // distance. Only tundra carries the long ore feed the bound targets.
      if (scenario.id === "tundra") {
        const feed = tundraOreFeed(rawEdges);
        expect(feed, "tundra ore-feed edge present").not.toBeNull();
        const pts = parsePath(feed!.d);
        const len = polylineLength(pts);
        const direct = endpointManhattan(pts);
        expect
          .soft(
            len,
            `tundra ore feed ${feed!.id}: path ${len.toFixed(1)} exceeds 1.5x Manhattan ${direct.toFixed(1)}`,
          )
          .toBeLessThanOrEqual(1.5 * direct);
      }
    });
  }
});

test.describe("edge reload determinism", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
    });
  });

  for (const scenario of SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const hash = await scenarioHash(scenario);

      const readEdges = async (): Promise<Record<string, string>> => {
        await loadScenario(page, hash);
        const { edges } = await page.evaluate(collectGeometry);
        const map: Record<string, string> = {};
        for (const e of edges) map[e.id] = e.d;
        return map;
      };

      const first = await readEdges();
      const second = await readEdges();

      const ids = new Set([...Object.keys(first), ...Object.keys(second)]);
      const diffs: string[] = [];
      for (const id of ids) {
        if (first[id] !== second[id]) {
          diffs.push(
            `  ${id}:\n    load1 ${first[id]}\n    load2 ${second[id]}`,
          );
        }
      }
      expect(
        diffs.length,
        `${scenario.id}: ${diffs.length} edge path(s) differ across reloads:\n${diffs.join("\n")}`,
      ).toBe(0);
    });
  }
});
