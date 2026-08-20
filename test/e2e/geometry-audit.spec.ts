import { test, expect, type Page } from "@playwright/test";
import { SCENARIOS, scenarioHash } from "./scenarios";
import {
  auditChipsOnOwnPath,
  auditChipsVsCards,
  auditOwnCardPierces,
  auditSegmentsVsCards,
  auditSegmentsVsChips,
  countCrossings,
  endpointManhattan,
  fmtSeg,
  parsePath,
  polylineLength,
  toRawEdges,
  type ChipRect,
  type NodeRect,
  type RawEdge,
} from "./geometry";
import { collectAudit, collectGeometry, type AuditChipRect } from "./collect";

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

// Strict interpenetration on both axes, beyond the abutment epsilon.
function overlapPx(
  a: AuditChipRect,
  b: AuditChipRect,
): { dx: number; dy: number } | null {
  const dx = Math.min(a.right, b.right) - Math.max(a.x, b.x);
  const dy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
  if (dx > OVERLAP_EPS_PX && dy > OVERLAP_EPS_PX) return { dx, dy };
  return null;
}

function fmtRect(r: AuditChipRect): string {
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

      const {
        chips,
        rows,
        multPairs,
        recipeNodeCount,
        containerRect,
        flowChipZ,
        busJunctionZ,
      } = await page.evaluate(collectAudit);

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

      // (a2) Every chip sits inside the visible pane at fit zoom. fitBounds
      // frames the node cards PLUS the seated chip extents (contentBounds), so a
      // chip cascaded below the deepest lane band or nudged past a card edge is
      // inside the viewport instead of clipped at the rim. A chip whose box pokes
      // past any container edge by more than the epsilon is clipped.
      const clipped: string[] = [];
      for (const c of chips) {
        const dxOut = Math.max(
          containerRect.x - c.x,
          c.right - containerRect.right,
        );
        const dyOut = Math.max(
          containerRect.y - c.y,
          c.bottom - containerRect.bottom,
        );
        if (dxOut > OVERLAP_EPS_PX || dyOut > OVERLAP_EPS_PX) {
          clipped.push(
            `"${c.label}" ${fmtRect(c)} pokes past the pane ` +
              `[${containerRect.x.toFixed(1)},${containerRect.y.toFixed(1)} ` +
              `${containerRect.right.toFixed(1)}x${containerRect.bottom.toFixed(1)}] ` +
              `by ${Math.max(0, dxOut).toFixed(1)}x${Math.max(0, dyOut).toFixed(1)}px`,
          );
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
      expect(
        clipped,
        `${scenario.id}: ${clipped.length} chip(s) clipped outside the pane among ${chips.length} chips:\n${clipped.join("\n")}`,
      ).toEqual([]);

      // (d2) Flow chips paint ABOVE bus junction dots. Both are portaled into
      // the shared .react-flow__edgelabel-renderer stacking context, and a chip
      // counter-scales up to 2x about its centre, so an enlarged aggregate chip
      // envelops the world-fixed dot. The dot is decorative (aria-hidden); the
      // chip carries the digits, so it must win. A strict order is required: the
      // lowest chip z-index must exceed the highest dot z-index, or a sibling
      // member edge's dot could still paint over the owner's chip on DOM order.
      // Only asserted where a scenario renders both.
      if (flowChipZ.length > 0 && busJunctionZ.length > 0) {
        const minChipZ = Math.min(...flowChipZ);
        const maxDotZ = Math.max(...busJunctionZ);
        expect(
          minChipZ,
          `${scenario.id}: flow-chip z-index (min ${minChipZ}) must be strictly above bus-junction z-index (max ${maxDotZ}) among ${flowChipZ.length} chips and ${busJunctionZ.length} junction dots`,
        ).toBeGreaterThan(maxDotZ);
      }
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
//
// NOTE on all ratchet tables below: baselines do NOT auto-tighten. When a change
// improves a scenario, re-record the lower count manually (downward freely). A
// baseline moves UP only with a recorded controller ruling, never as a silent
// accommodation of a regression. Six such rulings stand: battery5 off-path
// 5 -> 6 (card-hardness pushes one pinned chip's seat off its line), the P4
// aggregate-visibility raise (chip-segment default 0 -> 2, multi6 0 -> 3,
// battery5-xiranite 0 -> 7), the own-side bus-column guard (padding grazes
// battery5-xiranite 7 -> 14), the #25 per-trunk column separation
// (crossing census default / multi6, detailed at CROSSING_BASELINE below), the
// contentBounds fix raising the fit zoom past both chip LOD gates, which drew
// the chips that were already colliding (battery5-xiranite chip-segment
// 7 -> 23 and off-path 0 -> 2, detailed at the two tables below), and the
// port-drift raise (off-path battery5-xiranite 2 -> 3, detailed at
// CHIP_OFFPATH_BASELINE below).
// At the aggregate-chip removal all five tables were re-measured wholesale and
// re-pinned DOWN to the actuals; no count rose at THAT re-measure, so it added
// no ruling of its own. Later re-measures are recorded per table.
// The per-table rationale lines below record how a pin ONCE moved, which no
// longer matches its current value wherever the re-measure tightened it.
// The own-side guard keeps a bus drop / rise on the port
// side of its own endpoint card. On battery5-xiranite it moved three columns
// that used to run through their own endpoint body onto the port-side gutter
// instead -- verified per edge against the pre-guard build (4cc2725): e:26 and
// e:65 (rises into the liquid_water target q:27, base column 4086 inside the
// card body -> 3714 / 3730 off-own) and e:17 (drop out of the xiranite source
// q:22, base column 1832 inside the source body -> 1865 off-own) each traded an
// own-body traversal for a packed-gutter graze -- one graze plus two three-
// segment approaches, the 7 new grazes -- and the tier-1 raw gate stays at zero.
// The guard does NOT eliminate own-endpoint traversals everywhere: where the
// port-side corridor is fully walled the pierce rescue's last resort still lands
// inside the own endpoint card (e.g. e:15 rises to 2476, inside its own target
// q:35 body, at BOTH base and HEAD -- no off-own column exists there). The
// endpoint-exempting tier-1 audit cannot see those runs; the OWN_PIERCE_BASELINE
// ratchet below (auditOwnCardPierces) tracks that residue directly.

// Pre-P2 crossing baseline, recorded from the P1-gate commit a17bec1 by running
// the same countCrossings logic over the seven scenarios at fit zoom (a detached
// worktree, since deleted). Current routing must never produce MORE crossings
// than this per scenario. Not a target -- an upper bound that ratchets down.
//
// #25 per-trunk column separation ruling. Baseline bumps: default 0 -> 9,
// multi6 236 -> 415 (the prior 236 was stale pre-P2 slack; the actual measured
// pre-#25 multi6 count was 158, so the real delta is +257). clearBusColumns now
// steps two DISTINCT-item trunks that resolve onto the SAME drop or rise column
// in one band apart by one entry-slot pitch. The counts rise because formerly-
// coincident columns HID their crossings as colinear vertical overlaps -- the
// candy stripe WAS the degenerate crossing -- and separating them converts each
// into a proper crossing the counter can see. Bus-member pair multiplicity
// inflates the raw count (~6x per visual crossing on multi6); deduplicated to
// distinct visual crossing POINTS the change is 67 -> 86, the price of removing
// 7 distinct-item stripes up to 1455px long. On default all 9 crossings are
// between the two separated trunks themselves (copper members e:8/e:9 crossing
// water members e:13/e:14), not past any sub-graph. No new card pierces
// (battery5 / multi6 RAW stays at 1); confirmed clean in-browser on default.
const CROSSING_BASELINE: Record<string, number> = {
  default: 9,
  battery5: 8,
  "battery5-xiranite": 56,
  crystal: 1,
  equip4: 1,
  multi6: 415,
  tundra: 0,
};

// Padding-graze baseline (tier 3): segments that clip only a foreign card's
// padding overhang (entry-chip reserve / port stub), never the raw box. All
// remaining grazes live where sibling paddings overlap inside a packed column,
// with no padded-clear column in the routing model (the raw fallback threads
// the raw gap instead, trading a raw strike for a graze). Recorded post-fix at
// this commit's measured counts; the ratchet only tightens.
// battery5-xiranite raised 7 -> 14 by the own-side bus-column guard (see the
// NOTE above): keeping bus drop / rise columns on the port side of their own
// endpoint card moved three columns off their own-body traversals and onto
// packed port-side gutters -- two liquid_water rises into q:27 (e:26, e:65) and
// one xiranite drop out of q:22 (e:17), one graze plus two three-segment
// approaches. Where the corridor is fully walled the column still tunnels its
// own endpoint body (tracked by OWN_PIERCE_BASELINE, not this tier).
const PADDED_GRAZE_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 8,
  "battery5-xiranite": 3,
  crystal: 3,
  equip4: 3,
  multi6: 12,
  tundra: 0,
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
// default (0 -> 2), multi6 (0 -> 3), and battery5-xiranite (0 -> 7) rose with the
// P4 aggregate-chip work: the owner's aggregate chip is now exempt from the
// label zoom gate (visible at fit), and it seats on the SHARED TRUNK (never the
// private branch leg). On the trunk near the source, its wide box grazes the
// source's OTHER output line (e.g. the sewage surplus feed) -- a foreign flow
// line passing under a chip box, the softest and already-ratcheted residue of
// this tier. Before, the aggregate hid down on a branch leg away from those
// lines (count 0); the ratified "aggregate on the trunk" placement trades that
// for the graze. The hard tiers (chip overlaps, chip-vs-card, and the
// clipped-chip gate) stay zero.
// battery5-xiranite rose 7 -> 23 with the contentBounds fix. Nothing moved: the
// fit zoom rose from 0.280 to 0.377, which crosses both the icon-only gate
// (0.32) and the label gate (0.35), so the scenario went from 3 chips drawn
// (all icon-only) to 42 drawn with text. The collisions were always there; the
// LOD gates were hiding the chips that collide. Measured both sides in a
// browser before re-pinning. Re-pinned rather than reverted because a fit view
// nobody can read is the worse defect, and the newly visible collisions are
// tracked separately.
// Re-pinned DOWN at the least-crossed graze seat (battery5 5 -> 3, battery5-
// xiranite 23 -> 11): the graze tier now scores every hard-clear on-line
// candidate by the foreign lines its box would cross and seats at the minimum
// instead of the first hit, so half the corpus's line occlusions disappear
// without any chip leaving its own line (off-path, chip-card and raw all held).
const CHIP_SEGMENT_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 3,
  "battery5-xiranite": 11,
  crystal: 0,
  equip4: 1,
  multi6: 0,
  tundra: 0,
};
// battery5 rose 5 -> 6 when chip-vs-card went hard: one pinned chip's on-line
// candidates all overlap a card, so card-hardness pushes its seat off the line.
// battery5-xiranite rose 0 -> 2 for the same reason its chip-segment count rose:
// the higher fit zoom draws 42 chips where 3 were drawn before, and two of the
// newly drawn ones (both Xircon Effluent) seat off their polyline, one by 48px.
// Counted as part of the same tracked collision follow-up.
// battery5-xiranite rose 2 -> 3 with the port-drift correction (RULING,
// 2026-08-20). Chip seating now reconstructs each edge's endpoints in the DRAWN
// frame, where React Flow anchors a path at the outer edge of the handle box,
// a few units off the model port. The old frame was wrong by up to 5 units,
// which both faked one violation and hid others: the 1.00px seat it invented
// (e:5) is gone, and two chips whose on-line candidate sets it had mis-scored
// now take a genuine least-bad escape (e:18 17.19px, e:34 20.52px). The
// correction EXPOSED those two seats, it did not cause them -- both sit in the
// short-corridor family tracked by #41, whose slab-spacing fix is the remedy;
// they are not absorbable by the seat tiers, since an escape leaves the line by
// definition and no on-line rescoring can pull it back.
// multi6 is unmeasured rather than clean at fit zoom 0.21: both LOD gates
// suppress every label chip there, and the surviving gate-exempt bus chips are
// skipped by the off-path audit (label kind only). Four of those bus chips sit
// 144-192 units off their own path today. If a fit-zoom change ever lifts
// multi6 past the label gate, expect its counts to jump for battery5-xiranite
// reasons, not because that change broke anything.
const CHIP_OFFPATH_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 1,
  "battery5-xiranite": 3,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
};

// Own-endpoint-pierce ratchet: segments that run inside their OWN source /
// target card's RAW body. The foreign segment audit (tier 1) exempts an edge's
// own endpoint cards, so this residue is its blind spot -- a rise / drop that
// the pierce rescue lands inside its own endpoint card (the last-resort 3b
// traversal, taken only where the port-side corridor is so packed that no
// off-own column clears) never shows up there. Held per scenario and ratcheted
// DOWN only, under the same manual-ruling convention as the tables above.
// Recorded at this fix's measured counts: battery5 (6: e:10 and e:40, three
// segments each, rising into their own liquid_water target q:18) and battery5-
// xiranite (16: target rises e:15 and source drops e:19 / e:20 / e:22 / e:23 /
// e:50, each a walled corridor with no off-own column). Zero elsewhere.
const OWN_PIERCE_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 0,
  "battery5-xiranite": 2,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
};

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
      const chips = geom.chips as ChipRect[];
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

      // Own-endpoint-pierce ratchet: segments running inside their OWN source /
      // target card's raw body. Tier 1 exempts endpoint cards and cannot see
      // these; the pierce rescue's last-resort own-card traversal lands here.
      // Ratchets down only.
      const ownPierces = auditOwnCardPierces(rawEdges, nodes);
      const ownPierceInventory = ownPierces.map(
        (v) =>
          `  ${v.edgeId} seg ${fmtSeg(v.seg)} runs inside own ${v.role} card ${v.card}`,
      );
      const ownPierceBaseline = OWN_PIERCE_BASELINE[scenario.id]!;
      expect
        .soft(
          ownPierces.length,
          `${scenario.id}: ${ownPierces.length} own-card pierce(s) exceeds baseline ${ownPierceBaseline}:\n${ownPierceInventory.join("\n")}`,
        )
        .toBeLessThanOrEqual(ownPierceBaseline);

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

      const readLoad = async (): Promise<{
        edges: Record<string, string>;
        transform: string;
      }> => {
        await loadScenario(page, hash);
        const { edges } = await page.evaluate(collectGeometry);
        const transform = await page.evaluate(
          () =>
            document.querySelector<HTMLElement>(".react-flow__viewport")?.style
              .transform ?? "",
        );
        const map: Record<string, string> = {};
        for (const e of edges) map[e.id] = e.d;
        return { edges: map, transform };
      };

      const first = await readLoad();
      const second = await readLoad();

      const ids = new Set([
        ...Object.keys(first.edges),
        ...Object.keys(second.edges),
      ]);
      const diffs: string[] = [];
      for (const id of ids) {
        if (first.edges[id] !== second.edges[id]) {
          diffs.push(
            `  ${id}:\n    load1 ${first.edges[id]}\n    load2 ${second.edges[id]}`,
          );
        }
      }
      expect(
        diffs.length,
        `${scenario.id}: ${diffs.length} edge path(s) differ across reloads:\n${diffs.join("\n")}`,
      ).toBe(0);

      // Camera-drift tripwire: the fit-view transform must be byte-identical
      // across reloads (a deterministic content-bounds fit produces the same pan
      // and zoom every load).
      expect(
        second.transform,
        `${scenario.id}: viewport transform drifted across reloads:\n    load1 ${first.transform}\n    load2 ${second.transform}`,
      ).toBe(first.transform);
    });
  }
});
