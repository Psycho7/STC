import { test, expect, type Page } from "@playwright/test";
import { CENSUS_ZOOM, bootExamPage, loadCensusScenario } from "./viewport";
import { SCENARIOS, extraScenariosFromEnv, scenarioHash } from "./scenarios";
import {
  CARD_INTRUSION_BUDGET,
  auditCardFrames,
  auditChipCardIntrusion,
  auditChipForeignStrokes,
  auditChipPortCover,
  auditChipsOnOwnPath,
  auditChipsVsCards,
  auditDotsUnderChips,
  auditEndpointParity,
  auditFaninChipsOnOwnLeg,
  auditFanoutChipsOnOwnLeg,
  auditFrameRides,
  auditOwnCardPierces,
  auditReserveZoneStrokes,
  auditSegmentsVsCards,
  auditSegmentsVsChips,
  auditTrunkChipReserves,
  countCrossings,
  crossingCueCoverage,
  endpointManhattan,
  fmtSeg,
  parsePath,
  polylineLength,
  toRawEdges,
  trunkChipSeats,
  type ChipCensusHit,
  type ChipRect,
  type DotRect,
  type GapZones,
  type NodeRect,
  type PortFurnitureRect,
  type RawEdge,
} from "./geometry";
import { collectAudit, collectGeometry, type AuditChipRect } from "./collect";

// The P1 acceptance gate for the placement campaign: a DOM-geometry audit run
// against the live client rects the user actually sees. Two invariants per
// scenario at fit zoom on 1920x1080:
//   (a) no two .flow-chip boxes overlap (a chip draws its natural CSS box, so
//       its client rect is the on-screen box - no unscaling needed);
//   (b) every recipe handle sits vertically centred on its .rn-row (handles are
//       row-embedded, xyflow centres them with top:50% translate(-50%,-50%)).
// Nothing is selected during measurement: a selected node draws a 2px border vs
// the normal 1px, which shifts rects. The spec only loads and reads - no clicks.

test.use({ viewport: { width: 1920, height: 1080 } });

// Chips can legitimately abut edge-to-edge when the trunk pitch equals the chip
// box height. A shared boundary
// (a.bottom == b.top) is not an overlap, so require strict interpenetration of
// more than this many pixels on BOTH axes before flagging a pair.
const OVERLAP_EPS_PX = 0.5;
// Row-embedded handles centre on their row via CSS; the only slack is subpixel
// rounding of two independently laid-out client rects.
const HANDLE_CENTER_TOL_PX = 1;

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

// The fixed corpus plus whatever EXAM_EXTRA_SCENARIOS names. The extras are
// rotating exam plans: they get every ZERO-TOLERANCE check in this file (those
// state an invariant, not a count, so they hold on any plan), but none of the
// per-scenario baseline tables below has an entry for them, and a table is a
// pinned measurement -- a missing entry is unknown, never zero.
const AUDIT_SCENARIOS = [...SCENARIOS, ...extraScenariosFromEnv()];

// The fixed corpus, which every table below is required to pin in full.
const FIXED_IDS = new Set(SCENARIOS.map((s) => s.id));

// A baseline read that tolerates a scenario the table does not pin. Returns null
// and records why, so the caller can leave that one ratchet unasserted while the
// rest of the test runs. Only a rotating id earns that tolerance: a fixed-corpus
// id with no entry means the table lost a row, so it throws instead of quietly
// downgrading its own membership guard to a skip.
function baselineFor(
  table: Record<string, number>,
  tableName: string,
  scenarioId: string,
  unpinned: string[],
): number | null {
  const pinned = table[scenarioId];
  if (pinned === undefined) {
    if (FIXED_IDS.has(scenarioId))
      throw new Error(
        `${tableName} has no entry for fixed-corpus scenario "${scenarioId}": ` +
          `every SCENARIOS id must stay pinned in every baseline table`,
      );
    unpinned.push(`${scenarioId} has no ${tableName} entry (rotating plan)`);
    return null;
  }
  return pinned;
}

// Ends a test as skipped when any ratchet in it had no baseline entry, naming
// every table it could not read. Call it LAST: test.skip aborts the test where
// it is called, so anything after it would not run, while assertions made before
// it still stand -- a soft failure recorded earlier still reddens the test
// rather than being swallowed by the skip. That ordering is what lets one test
// both report its zero-tolerance verdict and declare its ratchets unmeasured.
function skipUnpinnedRatchets(unpinned: string[]): void {
  if (unpinned.length > 0) test.skip(true, unpinned.join("; "));
}

test.describe("DOM geometry audit", () => {
  for (const scenario of AUDIT_SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const hash = await scenarioHash(scenario);
      await loadScenario(page, hash);

      const {
        chips,
        rows,
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
      // frames the node cards PLUS the chip extents (contentBounds), so a chip
      // standing out past a card edge is inside the viewport instead of clipped
      // at the rim. A chip whose box pokes past any container edge by more than
      // the epsilon is clipped.
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
        // A catalyst row is an input the machine cycles rather than
        // consumes, and it draws its own edge from the item's boundary
        // supply node (CATALYST_SUPPLY_EDGES in src/flags.ts, on). So it
        // carries exactly one handle, on the `cat:` namespace rather than
        // `in:`, seated inside the row like every other port: a row without
        // one leaves that edge no endpoint to land on, and a second handle
        // would offer the arriving edge a choice of two.
        if (row.rowClass.split(" ").includes("catalyst")) {
          const catIds = row.handleIds.filter((id) => id.startsWith("cat:"));
          const seated =
            row.handleCenterY !== null &&
            row.handleCenterY >= row.rowTop &&
            row.handleCenterY <= row.rowBottom;
          if (row.handleIds.length !== 1 || catIds.length !== 1 || !seated) {
            offCenter.push(
              `${row.nodeId} catalyst row "${row.item}" carries ` +
                `[${row.handleIds.join(", ")}] instead of one seated ` +
                `cat: handle (row ${row.rowTop.toFixed(1)}-${row.rowBottom.toFixed(1)}, ` +
                `handle ${row.handleCenterY === null ? "none" : row.handleCenterY.toFixed(1)})`,
            );
          }
          continue;
        }
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

      // Handle centring is a per-node CSS invariant independent of chip layout;
      // assert it first so that if a scenario also has chip overlaps, reaching
      // the overlap assertion still confirms the handles were centred.
      expect(
        offCenter,
        `${scenario.id}: ${offCenter.length} off-centre handle(s) among ${rows.length} rows in ${recipeNodeCount} recipe node(s):\n${offCenter.join("\n")}`,
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
      // the shared .react-flow__edgelabel-renderer stacking context, and a
      // chip's box can envelop the world-fixed dot. The dot is decorative (aria-hidden); the
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
// cards, and chips share one coordinate system), plus every junction dot's box
// and the layout's gap reserves (through the exam hook: a reserve is room the
// layout set aside, not a drawn thing, so no rect can report it).
//
// The pure scoring in ./geometry runs HARD criteria and SOFT ratchets, ALL
// evaluated on every run (soft assertions), so one failing criterion never hides
// another.
//
// HARD -- an invariant of the placement rule or of the routing model, never a
// measurement, so there is no table and no residue class to pin:
//   raw cards     zero edge segments entering a FOREIGN raw (unpadded) card;
//   chip vs card  zero chip boxes entering a foreign raw card;
//   chip on run   every chip -- an item edge's rate chip, a trunk's aggregate
//                 drop chip, a member's own rise chip -- centred on a
//                 HORIZONTAL segment of its OWN polyline. A chip is a
//                 horizontal box: a seat on a vertical or on a chamfer diagonal
//                 does not read as a label of the run beneath it;
//   reserve       every TRUNK chip's box inside the gap reserve beside the port
//                 it labels, clear of its own junction dot by
//                 RESERVE_COLUMN_PAD, and no foreign stroke crossing that
//                 reserve at the chip's row. layerModel widens each gap to hold
//                 exactly these boxes, so a chip outside its zone stands in room
//                 charged to something else;
//   frames        every drawn recipe card box equals the box the seating pass
//                 measures chips against, so the two run in ONE frame;
//   cues          every cross-flow crossing carries a drawn cue on one of its
//                 two edges.
//
// SOFT (per-scenario ratchet tables, detailed at each table below): the crossing
// census, padding-only grazes, foreign strokes through a chip box, chips off
// their own trunk leg in each direction, own-endpoint pierces, frame rides,
// junction dots hidden under a chip, and the endpoint-parity tolerance. The
// reading-zoom census at the bottom of this file carries three more.
//
// NOTE on all ratchet tables in this file. Baselines do NOT auto-tighten: when a
// change improves a scenario, re-record the lower count manually (downward
// freely), and a baseline moves UP only with a recorded controller ruling, never
// as a silent accommodation of a regression. Every cell of every table was
// re-pinned ONCE, wholesale, from a zero-pin harvest, on the ruling that
// introduced the chip placement rule (issue #131): chips are no longer seated by
// a scoring pass but anchored where the path is drawn -- on a horizontal run of
// their own line, and for a trunk chip inside its gap's reserve -- and the
// routing that feeds them was rebuilt on the layer model at the same time. Every
// counter that reads a chip box or a trunk column therefore measures a different
// picture, in both directions, and no cell's earlier history describes its
// current value. That single re-pin is this campaign's only ruling; from here
// the tables ratchet DOWN under the convention above and any rise needs a fresh
// one. The tolerance table (ENDPOINT_PARITY_TOL) is not part of it: it states a
// noise floor, not a count, and keeps its flat pin.

// Crossing census: pairwise proper crossings between segments of different
// edges, at fit zoom. An upper bound that ratchets down, not a target -- a plan
// that routes more flows through one corridor legitimately crosses more.
const CROSSING_BASELINE: Record<string, number> = {
  default: 2,
  // MERGE 2026-09-13 (placement rule on the develop merge): 12 -> 14. The
  // catalyst supply edge e:23 u:in:liquid_xiranite -> u:class:q:2 runs the
  // width of the graph and crosses two more corridors.
  battery5: 14,
  "battery5-xiranite": 20,
  crystal: 1,
  equip4: 1,
  // MERGE 2026-09-13 (placement rule on the develop merge): 83 -> 90. Three
  // catalyst supply edges (e:69 / e:71 / e:72 off u:in:gas_xiranite) span this
  // 92-edge graph from the boundary column to the transmuters deep in it.
  multi6: 90,
  tundra: 0,
  // MERGE 2026-09-13 (placement rule on the develop merge): 23 -> 27, the
  // three gas_xiranite catalyst supply edges crossing the chain.
  script43: 27,
  "coupon-web": 1,
  "gas-web": 13,
  "rot-bottled_food_3": 2,
  "rot-bottled_food_4": 3,
  // MERGE 2026-09-13 (placement rule on the develop merge): the transmuters
  // scenario rejoins the corpus with the catalyst supply edges, so it takes a
  // row here. Seeded at the pin it carried on the develop side and re-measured
  // on the merged tree below.
  transmuters: 27,
};

// Padding-graze ratchet (tier 3): segments that clip only a foreign card's
// padding overhang (entry-gutter reserve / port stub), never the raw box. The
// residue of a packed column, where sibling paddings overlap and the raw
// fallback threads the raw gap instead.
const PADDED_GRAZE_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 1,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  // RECIPE CARD TRIM + CATALYST EDGES (2026-09-13): 0 -> 1. e:24, the
  // liquid_xiranite catalyst supply run off the copper_powder loop-return
  // node, crosses the gutter at y 263 and clips u:class:q:13's padding on the
  // way. UP move, listed for ruling.
  transmuters: 1,
};

// Chip-segment ratchet: (segment, chip) pairs where a foreign flow's line passes
// under a chip box. Not zero, and not an invariant: a chip stands on the run its
// own edge draws, and in a packed corridor that run shares its row with other
// flows' legs. The hard tiers above forbid the escapes that would clear them.
const CHIP_SEGMENT_BASELINE: Record<string, number> = {
  // MERGE 2026-09-13 (placement rule on the develop merge): default 0 -> 1.
  // The merged corridor packs one foreign leg under a chip on the landing plan.
  default: 1,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  // MERGE 2026-09-13 (placement rule on the develop merge): the transmuters
  // scenario rejoins the corpus with the catalyst supply edges. Seeded at the
  // pin it carried on the develop side.
  transmuters: 4,
};
// Fan-out leg ratchet: member chips whose centre lies off the member's OWN leg,
// the polyline suffix right of the shared junction column. A branch chip names
// its member by standing on that member's leg; the column belongs to every
// member of the fan-out, so a chip parked there names none of them.
const FANOUT_LEG_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
};

// Fan-in leg ratchet, the mirror of the table above: a member chip off its own
// SOURCE STUB (the prefix left of the junction column), or an aggregate chip off
// the shared leg from the merge dot into the target. The two chips of a fan-in
// sit on opposite sides of its dot, and each names the stretch it stands on.
const FANIN_LEG_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
};

// Own-endpoint-pierce ratchet: segments that run inside their OWN source /
// target card's RAW body. The foreign-segment tier exempts an edge's own
// endpoint cards, so this residue is its blind spot -- a run that lands inside
// its own endpoint card because no off-own column cleared.
const OWN_PIERCE_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
};

// Frame-ride ratchet: edge segments running ALONG a container slab's border
// (within FRAME_RIDE_TOL = 16, for more than two port stubs of overlap), and
// backward item edges running along a band border. The stroke and the border
// then read as one line. Blind by design to a stroke that crosses or corners
// near a frame: only a RUN along it counts.
const FRAME_RIDE_BASELINE: Record<string, number> = {
  // Structural zero with no bands drawn.
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 1,
  "rot-bottled_food_4": 0,
  transmuters: 0,
};

// Hidden-junction-dot ratchet: dots whose whole drawn disc sits under a chip box
// at fit zoom. Chips paint ABOVE the dots by design, so a chip over a dot does
// not merely overlap it -- it deletes it, and the merge / split the dot marks
// reads as an ordinary corner. Distinct from the hard reserve criterion above,
// which is a trunk chip against its OWN trunk's dot: this one counts any dot a
// reader lost, whichever chip took it.
const DOT_COVER_BASELINE: Record<string, number> = {
  // The one survivor is battery5's fan-in owner chip (e:18, ruling R13).
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
};

// Endpoint-parity tolerance, in GRAPH UNITS, per scenario: the largest per-axis
// gap allowed between an edge's drawn first / last vertex and a reconstruction
// of that same endpoint from the node's card origin, the model port geometry,
// and PORT_DRIFT (auditEndpointParity). The reconstruction runs off a MIRRORED
// copy of the port contract -- the same drift constants and the same row math --
// so what this table states is that that contract still agrees with the DOM.
//
// It anchors on the DRAWN card origin, which makes it a NEGATIVE CONTROL on the
// drawn frame: it says the frame did not move, and it catches a row-index or
// port-contract regression, which lands a full row pitch out.
//
// A tolerance rather than a count, and deliberately coarse: the disagreement it
// exists to catch is an endpoint resolving to the WRONG ROW, which lands a full
// row pitch (22 units) or a whole card width out. Sub-unit residue is not a
// defect -- what every scenario measures is double-precision dust from mapping
// client rects back through the inverse viewport transform -- so the pins are a
// flat 0.5, two orders of magnitude above the noise and one and a half below a
// row pitch.
const ENDPOINT_PARITY_TOL: Record<string, number> = {
  default: 0.5,
  battery5: 0.5,
  "battery5-xiranite": 0.5,
  crystal: 0.5,
  equip4: 0.5,
  multi6: 0.5,
  tundra: 0.5,
  script43: 0.5,
  "coupon-web": 0.5,
  "gas-web": 0.5,
  "rot-bottled_food_3": 0.5,
  "rot-bottled_food_4": 0.5,
  transmuters: 0.5,
};

async function loadScenario(page: Page, hash: string): Promise<void> {
  await bootExamPage(page, {
    url: `/#${hash}`,
    locale: "en",
    readiness: "nodes",
    settle: "both",
  });
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
  for (const scenario of AUDIT_SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const unpinned: string[] = [];
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

      // SOFT ratchet: segments entering a foreign edge's chip box stay at or
      // below the per-scenario baseline (see CHIP_SEGMENT_BASELINE).
      const chips = geom.chips as ChipRect[];
      const chipHits = auditSegmentsVsChips(rawEdges, chips, nodes);
      const chipInventory = chipHits.map(
        (v) =>
          `  ${v.edgeId} seg ${fmtSeg(v.seg)} pierces chip of ${v.chipEdgeId} ("${v.chipLabel}")`,
      );
      const chipSegBaseline = baselineFor(
        CHIP_SEGMENT_BASELINE,
        "CHIP_SEGMENT_BASELINE",
        scenario.id,
        unpinned,
      );
      if (chipSegBaseline !== null) {
        expect
          .soft(
            chipHits.length,
            `${scenario.id}: ${chipHits.length} segment/chip intersection(s) exceeds baseline ${chipSegBaseline} among ${geom.chips.length} chips:\n${chipInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(chipSegBaseline);
      }

      // HARD: zero chip boxes entering a FOREIGN raw card, on every scenario.
      // A chip box on a card reads as that card's own label. The 1-to-1 rule
      // slides its anchor along its own run to a card-clear seat; a trunk chip
      // stands in a reserve the gap was widened for, which is outside every
      // card by construction.
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

      // HARD: every chip stands on a horizontal segment of its OWN polyline.
      // The anchor is computed off the drawn path, so this holds by
      // construction at rest; a chip flagged here is riding a stamp that
      // outlived the geometry it was measured on.
      const offRule = auditChipsOnOwnPath(chips, rawEdges);
      const offRuleInventory = offRule.map(
        (v) =>
          `  chip ${v.chipId} of ${v.chipEdgeId} ("${v.chipLabel}") is ${v.distance.toFixed(2)} off every horizontal run of its own polyline`,
      );
      expect
        .soft(
          offRule.length,
          `${scenario.id}: ${offRule.length} chip(s) off every horizontal run of their own polyline among ${chips.length} chips:\n${offRuleInventory.join("\n")}`,
        )
        .toBe(0);

      // HARD: every trunk chip inside the gap reserve beside the port it
      // labels, clear of its own junction dot, with no foreign stroke through
      // that reserve at its row. The zones come from the exam hook (nothing in
      // the DOM records them), so a plan whose hook reported none -- a
      // single-layer graph -- contributes no seats and no assertion.
      const seats = trunkChipSeats(
        chips,
        rawEdges,
        geom.dots as DotRect[],
        geom.gapZones as GapZones[],
      );
      const reserves = auditTrunkChipReserves(seats);
      expect
        .soft(
          reserves.outside.length,
          `${scenario.id}: ${reserves.outside.length} trunk chip(s) outside their gap reserve among ${seats.length} trunk chip seats:\n${censusInventory(reserves.outside)}`,
        )
        .toBe(0);
      expect
        .soft(
          reserves.onDot.length,
          `${scenario.id}: ${reserves.onDot.length} trunk chip(s) inside their junction dot's column pad among ${seats.length} trunk chip seats:\n${censusInventory(reserves.onDot)}`,
        )
        .toBe(0);
      const zoneStrokes = auditReserveZoneStrokes(seats, rawEdges, nodes);
      expect
        .soft(
          zoneStrokes.length,
          `${scenario.id}: ${zoneStrokes.length} reserve zone(s) crossed by a foreign stroke among ${seats.length} trunk chip seats:\n${censusInventory(zoneStrokes)}`,
        )
        .toBe(0);

      // Trunk leg ratchets: a member chip off the stretch that is its own, in
      // each direction. The fan-out leg is the suffix right of the shared
      // column; the fan-in stub is the prefix left of it, and a fan-in
      // aggregate rides the shared leg into the target.
      const offLeg = auditFanoutChipsOnOwnLeg(
        chips,
        rawEdges,
        geom.dots as DotRect[],
      );
      const offLegInventory = offLeg.map(
        (v) =>
          `  chip ${v.chipId} of ${v.chipEdgeId} ("${v.chipLabel}") is ${v.distance.toFixed(2)}px off its own fan-out leg`,
      );
      const offLegBaseline = baselineFor(
        FANOUT_LEG_BASELINE,
        "FANOUT_LEG_BASELINE",
        scenario.id,
        unpinned,
      );
      if (offLegBaseline !== null) {
        expect
          .soft(
            offLeg.length,
            `${scenario.id}: ${offLeg.length} fan-out member chip(s) off their own leg exceeds baseline ${offLegBaseline}:\n${offLegInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(offLegBaseline);
      }

      const offStub = auditFaninChipsOnOwnLeg(
        chips,
        rawEdges,
        geom.dots as DotRect[],
      );
      const offStubInventory = offStub.map(
        (v) =>
          `  chip ${v.chipId} of ${v.chipEdgeId} ("${v.chipLabel}") is ${v.distance.toFixed(2)}px off its own fan-in stretch`,
      );
      const offStubBaseline = baselineFor(
        FANIN_LEG_BASELINE,
        "FANIN_LEG_BASELINE",
        scenario.id,
        unpinned,
      );
      if (offStubBaseline !== null) {
        expect
          .soft(
            offStub.length,
            `${scenario.id}: ${offStub.length} fan-in chip(s) off their own stretch exceeds baseline ${offStubBaseline}:\n${offStubInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(offStubBaseline);
      }

      // Tier 3 (SOFT ratchet): padding-only grazes stay at or below the
      // recorded baseline. These clip a foreign card's padding overhang (entry
      // chip reserve / port stub) where sibling paddings overlap in a packed
      // column; they never touch the raw box.
      const grazes = violations.filter((v) => !v.raw);
      const grazeInventory = grazes.map(
        (v) => `  ${v.edgeId} seg ${fmtSeg(v.seg)} grazes padding of ${v.card}`,
      );
      const grazeBaseline = baselineFor(
        PADDED_GRAZE_BASELINE,
        "PADDED_GRAZE_BASELINE",
        scenario.id,
        unpinned,
      );
      if (grazeBaseline !== null) {
        expect
          .soft(
            grazes.length,
            `${scenario.id}: ${grazes.length} padding graze(s) exceeds baseline ${grazeBaseline}:\n${grazeInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(grazeBaseline);
      }

      // Own-endpoint-pierce ratchet: segments running inside their OWN source /
      // target card's raw body. Tier 1 exempts endpoint cards and cannot see
      // these; the pierce rescue's last-resort own-card traversal lands here.
      // Ratchets down only.
      const ownPierces = auditOwnCardPierces(rawEdges, nodes);
      const ownPierceInventory = ownPierces.map(
        (v) =>
          `  ${v.edgeId} seg ${fmtSeg(v.seg)} runs inside own ${v.role} card ${v.card}`,
      );
      const ownPierceBaseline = baselineFor(
        OWN_PIERCE_BASELINE,
        "OWN_PIERCE_BASELINE",
        scenario.id,
        unpinned,
      );
      if (ownPierceBaseline !== null) {
        expect
          .soft(
            ownPierces.length,
            `${scenario.id}: ${ownPierces.length} own-card pierce(s) exceeds baseline ${ownPierceBaseline}:\n${ownPierceInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(ownPierceBaseline);
      }

      // Frame-ride ratchet: backward item edges' segments running
      // along a container slab's border (forward tap descents may share a border
      // line by convention and are not counted). Stroke-on-frame braids are the
      // loop-return family this counter exists to hold at zero; see
      // FRAME_RIDE_BASELINE above.
      const frameRides = auditFrameRides(rawEdges, nodes);
      const frameRideInventory = frameRides.map(
        (v) =>
          `  ${v.edgeId} rides the ${v.border} border of ${v.target} ` +
          `${v.distance.toFixed(1)} off it (${v.kind}), seg ${fmtSeg(v.seg)}`,
      );
      const frameRideBaseline = baselineFor(
        FRAME_RIDE_BASELINE,
        "FRAME_RIDE_BASELINE",
        scenario.id,
        unpinned,
      );
      if (frameRideBaseline !== null) {
        expect
          .soft(
            frameRides.length,
            `${scenario.id}: ${frameRides.length} frame ride(s) exceeds baseline ${frameRideBaseline}:\n${frameRideInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(frameRideBaseline);
      }

      // Hidden-dot ratchet: junction dots swallowed by any chip box at fit zoom.
      // The dot rects come from the DOM, so they carry the zoom-clamped radius
      // the dot actually renders at; the camera zoom only converts the
      // one-screen-pixel visibility tolerance into graph units.
      const hiddenDots = auditDotsUnderChips(
        chips,
        geom.dots as DotRect[],
        geom.zoom,
      );
      const hiddenDotInventory = hiddenDots.map(
        (v) =>
          `  ${v.dotId} at (${v.at[0].toFixed(1)},${v.at[1].toFixed(1)}) hidden under the chip of ${v.chipEdgeId} ("${v.chipLabel}")`,
      );
      const dotBaseline = baselineFor(
        DOT_COVER_BASELINE,
        "DOT_COVER_BASELINE",
        scenario.id,
        unpinned,
      );
      if (dotBaseline !== null) {
        expect
          .soft(
            hiddenDots.length,
            `${scenario.id}: ${hiddenDots.length} junction dot(s) hidden under a chip exceeds baseline ${dotBaseline} among ${geom.dots.length} dots:\n${hiddenDotInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(dotBaseline);
      }

      // Card frames: the box the seating pass measures a recipe card by is the
      // box the browser paints. Unlike the parity check below, which anchors on
      // the drawn origin and so cannot see the seating pass's own frame, this
      // one compares a DRAWN size against a rebuilt one, so a seating frame two
      // units off the border box reddens it. Hard zero, no baseline.
      const frameMismatches = auditCardFrames(geom.nodes);
      const frameInventory = frameMismatches.map(
        (m) =>
          `  ${m.nodeId}: drawn ${m.drawnWidth.toFixed(2)}x${m.drawnHeight.toFixed(2)} ` +
          `vs seating ${m.seatingWidth.toFixed(2)}x${m.seatingHeight.toFixed(2)}`,
      );
      expect
        .soft(
          frameMismatches.length,
          `${scenario.id}: ${frameMismatches.length} recipe card(s) drawn in a different frame than the seating pass measures:\n${frameInventory.join("\n")}`,
        )
        .toBe(0);

      // Endpoint parity: each drawn path starts and ends where a model +
      // PORT_DRIFT reconstruction of the same port says it should. The two
      // descriptions are independent -- the drawn vertex comes from React Flow's
      // handle anchoring, the rebuilt one from the card origin plus the row
      // geometry the routing model computes -- so a port resolving to the wrong
      // row shows here as a full row-pitch gap. Reported as the worst endpoint,
      // with every endpoint past the tolerance named.
      const parities = auditEndpointParity(rawEdges, geom.nodes);
      const worstParity = parities.reduce((m, p) => Math.max(m, p.delta), 0);
      const parityTol = baselineFor(
        ENDPOINT_PARITY_TOL,
        "ENDPOINT_PARITY_TOL",
        scenario.id,
        unpinned,
      );
      if (parityTol !== null) {
        const parityInventory = parities
          .filter((p) => p.delta > parityTol)
          .map(
            (p) =>
              `  ${p.edgeId} ${p.end} on ${p.nodeType} ${p.nodeId}: ` +
              `drawn (${p.drawn[0].toFixed(2)},${p.drawn[1].toFixed(2)}) vs ` +
              `rebuilt (${p.rebuilt[0].toFixed(2)},${p.rebuilt[1].toFixed(2)}), ` +
              `d=(${p.dx.toFixed(2)},${p.dy.toFixed(2)})`,
          );
        expect
          .soft(
            worstParity,
            `${scenario.id}: worst endpoint parity ${worstParity.toFixed(3)} exceeds tolerance ${parityTol} among ${parities.length} endpoints (${parityInventory.length} past tolerance):\n${parityInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(parityTol);
      }

      // Census: pairwise crossings never regress past the baseline.
      const crossings = countCrossings(geom.edges);
      const baseline = baselineFor(
        CROSSING_BASELINE,
        "CROSSING_BASELINE",
        scenario.id,
        unpinned,
      );
      if (baseline !== null) {
        expect
          .soft(
            crossings,
            `${scenario.id}: ${crossings} crossings exceeds baseline ${baseline}`,
          )
          .toBeLessThanOrEqual(baseline);
      }

      // Crossing-cue coverage (Task 9): every counted crossing between
      // DIFFERENT flows (different item|source) must carry a DRAWN cue on
      // one edge of the pair -- the stroke masked out around the crossing,
      // whichever of the two the stamp pass picked (a transparent gap
      // reads the same in either paint order, so no z key is involved).
      // ZERO-TOLERANCE by design, no baseline table: the stamp pass stamps
      // a cue for every cross-flow proper crossing by construction, and the
      // renderers cut every stamped cue that still sits on their live
      // polyline, so a miss means the stamp pass or the render broke --
      // there is no legitimate residue class to pin. Same-flow crossings
      // (between one flow's own edges: a trunk's members sharing their column,
      // fan-out slices sharing a trajectory) are one visual line and
      // deliberately NEVER cued; they are reported in the message so a plan
      // where that class suddenly grows stays visible instead of silently
      // living outside the assertion.
      // The drawn-cue count can sit BELOW the cued count: the stamp pass
      // dedupes per edge and point, so trunk members sharing a column that
      // crosses one foreign edge together draw one gap where the census counts
      // each member pair.
      const coverage = crossingCueCoverage(geom.edges, geom.crossingCues);
      expect
        .soft(
          coverage.uncued.length,
          `${scenario.id}: ${coverage.uncued.length} of ${coverage.crossFlow} cross-flow crossing(s) carry no cue on either edge` +
            ` (same-flow crossings, never cued: ${coverage.sameFlow}):\n${coverage.uncued.join("\n")}`,
        )
        .toBe(0);

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

      skipUnpinnedRatchets(unpinned);
    });
  }
});

// -- reading-zoom seating census ---------------------------------------------
//
// Its OWN describe with its OWN page load, deliberately: every criterion in the
// P2 describe above measures at FIT zoom (auditDotsUnderChips even consumes
// geom.zoom), so moving the camera inside that test would silently re-frame
// every ratchet in it. Nothing is shared between the two but the collectors.
//
// The camera is a fixed reading zoom (CENSUS_ZOOM), commanded through the exam
// hook the app installs under `?exam=1` (Canvas.tsx). Why a fixed zoom at all:
// at a dense plan's fit zoom the chip LOD bands collapse or drop nearly every
// chip, so a fit-zoom census of that plan measures almost nothing. The census
// camera sits above both gates, so every chip is drawn with its digits. React
// Flow does not virtualise nodes or the edge-label layer here, so chips outside
// the pane are still mounted and still measure.
//
// The camera fixes which chips are DRAWN and nothing else about their size: a
// chip draws its natural box in graph units at every zoom. Re-measure all three
// tables if the camera moves.
//
// The pan keeps the world point that was at the pane centre at fit zoom in the
// pane centre, so the frame is the middle of the plan on every scenario. It is
// arbitrary for the measurement (all rects are mapped back to graph coordinates
// and nothing is culled) and is fixed only so a debugging screenshot of a census
// failure shows the same region every run.

// Card intrusion: chips whose box reaches more than CARD_INTRUSION_BUDGET deep
// past a node card's border, OWN cards included, container slabs excluded. A
// depth rule, sharing its budget with the seating pass's own-card port-strip
// exemption, so a chip lying across the port strip on its own line -- the normal
// on-line state -- never counts however wide it is. Distinct from the hard
// chip-vs-card gate above, which is a CENTRE rule against foreign cards.
//
// Not zero, and not reducible to zero by the placement rule alone: a trunk chip
// stands in the reserve beside the port it labels and may not leave it, so where
// a card overhangs that reserve the box laps it. The two fan-out member chips on
// multi6 that stand over a card are the same residue, pinned by identity in
// test/canvas/chipAnchors.corpus.test.ts.
const CARD_INTRUSION_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
};

// Foreign strokes: chips with at least one foreign flow's stroke through the
// box. Same waiver set as CHIP_SEGMENT_BASELINE above (shared code, not a
// re-implementation), so no seat can be foreign to one and waived by the other.
// Three things make this count differ from that table: it counts CHIPS where
// that one counts (segment, chip) pairs, and it reads at the census camera
// rather than at fit zoom, where far more chips are drawn.
const FOREIGN_STROKE_BASELINE: Record<string, number> = {
  // MERGE 2026-09-13 (placement rule on the develop merge): 0 -> 1.
  default: 1,
  // MERGE 2026-09-13 (placement rule on the develop merge): 1 -> 5, the
  // liquid_xiranite catalyst supply run crossing the chips of the chain it
  // feeds.
  battery5: 5,
  "battery5-xiranite": 5,
  crystal: 1,
  equip4: 1,
  // MERGE 2026-09-13 (placement rule on the develop merge): 8 -> 10, the three
  // gas_xiranite catalyst supply runs.
  multi6: 10,
  tundra: 0,
  script43: 1,
  "coupon-web": 0,
  // MERGE 2026-09-13 (chips graph objects on the develop merge): 2 -> 3. e:14's
  // "Cuprium Ore x 180/min" chip takes e:25's liquid_water tap stroke, the tap
  // column the 240px card re-packed against it.
  "gas-web": 3,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  // RECIPE CARD TRIM + CATALYST EDGES (2026-09-13): 2 -> 3. e:21's "Xiragen
  // x 12/min" rise chip, off the gas_xiranite loop-return supply node, now
  // takes e:9's copper_nugget stroke through its box; the e:8-under-e:11
  // surplus stroke and e:23's rise chip stay. UP move, listed for ruling.
  transmuters: 3,
};

// Port cover: chips whose drawn box covers a handle, glyph or row strip of their
// own endpoint card. The furniture band straddling a port is a keep-out, so a
// chip anchored a port stub out of it clears it by construction. Target state
// zero; ratchets down.
//
// The five pinned cells are one family, and one the placement rule cannot clear
// on its own: a 1-to-1 chip slid along its run to the nearest CARD-clear seat
// stops flush against the target card, where the box still laps the port glyph
// standing outside the border (battery5 e:7 / e:17, battery5-xiranite e:3 /
// e:12, multi6 e:54, all the two wide Sandleaf Seed / Inert Xircon Effluent
// labels). The slide clears cards, and the glyph is not part of the card box.
const PORT_COVER_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 2,
  "battery5-xiranite": 2,
  crystal: 0,
  equip4: 0,
  multi6: 1,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
};

// Corpus-wide totals, one per counter. The census is a campaign-level ratchet,
// so the single number per counter is the figure the campaign moves; the
// per-scenario tables above are what a failure is diagnosed from. Asserted
// arithmetically against the tables (see the totals test) rather than summed
// over a run, so it holds even when the suite is run one scenario at a time.
const CENSUS_TOTALS: {
  cardIntrusion: number;
  foreignStroke: number;
  portCover: number;
} = {
  cardIntrusion: 0,
  // MERGE 2026-09-13 (placement rule on the develop merge): 19 -> 30, the sum
  // of FOREIGN_STROKE_BASELINE on the merged tree (transmuters rejoining at 3,
  // and the default / battery5 / multi6 / gas-web raises the catalyst supply
  // edges brought with them).
  foreignStroke: 30,
  portCover: 5,
};

function censusInventory(hits: ReadonlyArray<ChipCensusHit>): string {
  return hits
    .map((h) => `  ${h.chipId} (${h.chipKind}, "${h.chipLabel}"): ${h.detail}`)
    .join("\n");
}

function sumOf(table: Record<string, number>): number {
  return Object.values(table).reduce((a, b) => a + b, 0);
}

test.describe("chip seating census", () => {
  test("corpus totals match the per-scenario tables", () => {
    expect(sumOf(CARD_INTRUSION_BASELINE), "cardIntrusion totals").toBe(
      CENSUS_TOTALS.cardIntrusion,
    );
    expect(sumOf(FOREIGN_STROKE_BASELINE), "foreignStroke totals").toBe(
      CENSUS_TOTALS.foreignStroke,
    );
    expect(sumOf(PORT_COVER_BASELINE), "portCover totals").toBe(
      CENSUS_TOTALS.portCover,
    );
  });

  for (const scenario of AUDIT_SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const unpinned: string[] = [];
      const hash = await scenarioHash(scenario);
      await loadCensusScenario(page, hash, { locale: "en" });

      const geom = await page.evaluate(collectGeometry);

      // The commanded camera has to be the camera that was measured: setViewport
      // assigns the transform verbatim, but a driver that assumes its own zoom
      // landed is exactly the mistake Canvas.tsx's hook comment warns about, and
      // every count below is a reading at ONE zoom.
      expect(
        geom.zoom,
        `${scenario.id}: census camera did not land at ${CENSUS_ZOOM}`,
      ).toBeCloseTo(CENSUS_ZOOM, 5);

      const chips = geom.chips as ChipRect[];
      const rawEdges = toRawEdges(geom.edges);
      const nodes: NodeRect[] = geom.nodes.map((n) => ({
        nodeId: n.nodeId,
        type: n.type,
        left: n.left,
        top: n.top,
        right: n.right,
        bottom: n.bottom,
      }));

      // Soft throughout, like the P2 describe: one red counter must not hide
      // the other two.

      const intruding = auditChipCardIntrusion(chips, nodes);
      const intrusionBaseline = baselineFor(
        CARD_INTRUSION_BASELINE,
        "CARD_INTRUSION_BASELINE",
        scenario.id,
        unpinned,
      );
      if (intrusionBaseline !== null) {
        expect
          .soft(
            intruding.length,
            `${scenario.id}: ${intruding.length} chip(s) more than ${CARD_INTRUSION_BUDGET} deep inside a card exceeds baseline ${intrusionBaseline} among ${chips.length} chips:\n${censusInventory(intruding)}`,
          )
          .toBeLessThanOrEqual(intrusionBaseline);
      }

      const braided = auditChipForeignStrokes(chips, rawEdges, nodes);
      const strokeBaseline = baselineFor(
        FOREIGN_STROKE_BASELINE,
        "FOREIGN_STROKE_BASELINE",
        scenario.id,
        unpinned,
      );
      if (strokeBaseline !== null) {
        expect
          .soft(
            braided.length,
            `${scenario.id}: ${braided.length} chip(s) with a foreign stroke through the box exceeds baseline ${strokeBaseline} among ${chips.length} chips:\n${censusInventory(braided)}`,
          )
          .toBeLessThanOrEqual(strokeBaseline);
      }

      // Port-cover: a chip never covers its own endpoint card's port
      // furniture. Target state zero, ratchets down.
      const portCover = auditChipPortCover(
        chips,
        rawEdges,
        geom.portFurniture as PortFurnitureRect[],
      );
      const portCoverPin = baselineFor(
        PORT_COVER_BASELINE,
        "PORT_COVER_BASELINE",
        scenario.id,
        unpinned,
      );
      if (portCoverPin !== null) {
        expect
          .soft(
            portCover.length,
            `${scenario.id}: ${portCover.length} chip(s) covering their own endpoint's port furniture exceeds baseline ${portCoverPin} among ${chips.length} chips:\n${censusInventory(portCover)}`,
          )
          .toBeLessThanOrEqual(portCoverPin);
      }

      skipUnpinnedRatchets(unpinned);
    });
  }
});

test.describe("edge reload determinism", () => {
  for (const scenario of AUDIT_SCENARIOS) {
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
