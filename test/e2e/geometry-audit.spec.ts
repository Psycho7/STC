import { test, expect, type Page } from "@playwright/test";
import {
  CENSUS_ZOOM,
  READING_ZOOM,
  bootExamPage,
  loadCensusScenario,
} from "./viewport";
import { SCENARIOS, extraScenariosFromEnv, scenarioHash } from "./scenarios";
import {
  CARD_INTRUSION_BUDGET,
  auditCardFrames,
  auditChipCardIntrusion,
  auditChipForeignStrokes,
  auditChipNearCard,
  auditChipPortCover,
  auditChipBoxOverlaps,
  auditChipsOnOwnPath,
  auditChipsVsCards,
  auditDotsOnForeignStrokes,
  auditDotsUnderChips,
  auditEndpointParity,
  auditHiddenCues,
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
      await loadScenario(page, hash, scenario.area);

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
        // supply node. So it
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
// junction dots hidden under a chip, junction dots sitting on a foreign flow's
// stroke, and the endpoint-parity tolerance. The
// 0.6 chip seating census below carries three more, and the reading-zoom census
// at the bottom of this file six.
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
//
// SECOND WHOLESALE RE-PIN, 2026-09-14, cited to
// docs/plans/2026-09-14-render-findings.md: the routing findings branch changes
// where an adjacent-layer step drops (at the target entry column), floors the
// distance between distinct-edge verticals in a gap, and reserves the
// first / last leg of a trunk for its chip. Every table also gains rows for the
// two plans that campaign reported (copper-script43, script43-xiranite), pinned
// at their measured counts as first pins. One cell moved UP and carries its own
// ruling note below (CROSSING_BASELINE battery5-xiranite); every other cell
// held or fell.
//
// CATALYST EXAM FIXES 2026-09-15, docs/plans/2026-09-15-catalyst-exam-fixes.md
// (T9): nine cells moved UP on the integrated campaign branch, seven crossing
// counts and two padding grazes, each noted at its cell below. They are one
// family. T6 gives forward horizontal runs of different edges a y floor of a
// chip box (I2), so a run that used to hide inside a neighbour's stroke now
// steps off it and crosses whatever that neighbour's corridor holds; T7 layers
// each container interior in its own scope, which moves the cards a step apart
// on the plans that have containers; and T2 / T3 change what a card is tall,
// which moves every row a stroke lands on. A separation the reader can see,
// bought with crossings the cue mask already marks. Nothing else in either
// table moved, and no counter in the 0.6 census or the reading-zoom census
// moved at all. Both directions are harvested in one run (every ratchet here is
// a soft expect), but only an exceeded pin prints its measurement, so a cell
// that FELL is invisible to this harvest and keeps its old pin.

// Crossing census: pairwise proper crossings between segments of different
// edges, at fit zoom. An upper bound that ratchets down, not a target -- a plan
// that routes more flows through one corridor legitimately crosses more.
const CROSSING_BASELINE: Record<string, number> = {
  // CANVAS DEFECT CASEBOOK 2026-09-19 (family B): 2 -> 4. The gap's two fan-out
  // columns swap, so the Cuprium Ore split dot comes off the Clean Water leg.
  // With two trunks in one gap both orders force a crossing -- the ore column
  // crosses the water stub whenever it stands left, the water column crosses the
  // ore leg whenever it stands right -- and the old order hid one of them inside
  // the dot. The four here are all cued, all clear of a chip box and of every
  // dot's keep-off. UP move, carrying the casebook's own ruling.
  default: 4,
  // MERGE 2026-09-13 (placement rule on the develop merge): 12 -> 14. The
  // catalyst supply edge e:23 u:in:liquid_xiranite -> u:class:q:2 runs the
  // width of the graph and crosses two more corridors.
  //
  // CATALYST NODE REVIEW 2026-09-14 (PR B, T5b): 14 -> 15. A placed rail's
  // level now blocks a CHAMFER-tall band instead of the bare line, so a second
  // rail that used to sit a couple of units under the first (drawn as one
  // thick stroke) steps clear of it and crosses one more corridor on the way.
  // Measured: with that band back at zero height the count is 14 again, every
  // other cell in this file unchanged. UP move, listed for ruling.
  battery5: 15,
  // CATALYST NODE 2026-09-14 (PR B): 21 -> 26. Both xiranite pools took their
  // own boundary card, and their supply runs cross the chain. Measured 25 with
  // the rail deconfliction switched off, so four of the five added crossings
  // are the topology and one is a rail stepping off a column it used to share.
  // UP move, listed for ruling.
  //
  // CATALYST EXAM FIXES 2026-09-15 (T6): 26 -> 27. One forward horizontal takes
  // the new chip-box floor off the run it shared and crosses one more corridor
  // on its way down. UP move, listed for ruling.
  //
  // FAN-IN TRUNK KEY 2026-09-19 (#154): 27 -> 25. The card's catalyst row and
  // input row of gas_xiranite stopped merging into one fan-in trunk, so gap 2
  // drops a junction column and the layers right of it move 32 units left.
  "battery5-xiranite": 25,
  crystal: 1,
  // CATALYST NODE 2026-09-14 (PR B): 1 -> 2. The plan's one catalyst charge
  // moved to its own card, one layer further from its consumer. UP move,
  // listed for ruling.
  equip4: 2,
  // ROUTING FINDINGS 2026-09-14: 90 -> 88, re-measured on this branch.
  //
  // CATALYST EXAM FIXES 2026-09-15 (T7 with T6): 88 -> 90. The plan's loop
  // containers are laid out in their own scopes now, which spreads the cards
  // the supply runs cross, and the forward floor lifts two of those runs off
  // their neighbours. UP move, listed for ruling.
  //
  // CANVAS DEFECT CASEBOOK 2026-09-19 (T4, families F then D): 90 -> 95. UP
  // move, listed for ruling. F alone measures 89 -- a jog that stops riding the
  // plant_grass_2 frame crosses one corridor less -- and D then adds 6: the two
  // loop-return rails that used to lie inside a forward run's floor (e:43 with
  // e:79, e:45 with e:77) step a chip box clear of it, and their columns now
  // cross the runs they used to be drawn on top of. Every counted crossing
  // carries its cue.
  multi6: 95,
  tundra: 0,
  // CATALYST NODE 2026-09-14 (PR B of the catalyst supply pools plan): every
  // catalyst charge now leaves the item's own u:cat:* boundary card instead of
  // its ordinary u:in:* one: the three gas_xiranite runs leave the new card and
  // cross more of the chain they feed. UP move, listed for ruling.
  //
  // CATALYST EXAM FIXES 2026-09-15 (T6): 31 -> 32. The gas_xiranite charge run
  // e:0 is the loser of the new forward floor against the raw supply run it used
  // to shadow, and crosses one more corridor at its new level. UP move, listed
  // for ruling.
  script43: 32,
  // CATALYST NODE 2026-09-14 (PR B of the catalyst supply pools plan): every
  // catalyst charge now leaves the item's own u:cat:* boundary card instead of
  // its ordinary u:in:* one, so each transmuter plan gained a card and a set of
  // supply runs that cross the chain they feed. Both cells: UP moves, listed
  // for ruling.
  // CATALYST EXAM FIXES 2026-09-15 (T6 with T2 / T3): 5 -> 7. A small plan, so
  // every stroke that steps clear of another crosses the few corridors there
  // are; the taller cards move the rows those runs land on as well. UP move,
  // listed for ruling.
  // EVENT RECIPE COHORTS 2026-09-16 (develop merged into the cohort branch):
  // 7 -> 21. The coupon target is an event item, so the plan now solves through
  // the event chain instead of stopping short of it -- 15 recipes where the old
  // cell was measured on a graph that could not reach them. The two counts
  // describe different graphs, and all 21 crossings carry a drawn cue. UP move,
  // ruled by the user.
  "coupon-web": 21,
  // ONE BOUNDARY CARD PER IMPORTED ITEM 2026-09-25 (L3): 18 -> 23. The free
  // Inergen target no longer draws its own :target card at the top; the export
  // now leaves the item's one pool card and its straight run to the output
  // card crosses the band five times at right angles. UP move, ruled by stc-13.
  "gas-web": 23,
  "rot-bottled_food_3": 2,
  "rot-bottled_food_4": 3,
  // CATALYST NODE 2026-09-14 (PR B of the catalyst supply pools plan): every
  // catalyst charge now leaves the item's own u:cat:* boundary card instead of
  // its ordinary u:in:* one, so each transmuter plan gained a card and a set of
  // supply runs that cross the chain they feed. UP move, listed for ruling.
  //
  // CATALYST EXAM FIXES 2026-09-15 (T6 with T2 / T3): 22 -> 24. Two of those
  // supply runs take the forward floor off the lines they shadowed, at rows the
  // taller cards moved. UP move, listed for ruling.
  transmuters: 24,
  // ROUTING FINDINGS 2026-09-14 (docs/plans/2026-09-14-render-findings.md): the
  // two reported plans join the corpus. Both route several flows through one
  // corridor (a 14x refinery fan-in on script43-xiranite), so these are first
  // pins at the measured count, not raises.
  //
  // CATALYST NODE 2026-09-14 (PR B of the catalyst supply pools plan): every
  // catalyst charge now leaves the item's own u:cat:* boundary card instead of
  // its ordinary u:in:* one, so each transmuter plan gained a card and a set of
  // supply runs that cross the chain they feed. Both cells: UP moves, listed
  // for ruling.
  //
  // CATALYST EXAM FIXES 2026-09-15 (T6, T7): copper-script43 31 -> 38,
  // script43-xiranite 30 -> 31. The largest move in this table is
  // copper-script43, whose two long supply corridors ran several flows within a
  // couple of units of each other: the floor lifts them apart, and each run it
  // moves crosses the chain at its new level. Seven is the largest move in this
  // table. Both cells: UP moves, listed for ruling.
  "copper-script43": 38,
  "script43-xiranite": 31,
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
  // CATALYST NODE 2026-09-14 (PR B): 0 -> 2. The gas_xiranite catalyst card
  // sits one column off the chain it feeds, and two of its supply runs clip a
  // foreign card's padding overhang on the way. UP move, listed for ruling.
  multi6: 2,
  tundra: 0,
  // CATALYST EXAM FIXES 2026-09-15 (T6): script43 0 -> 1, script43-xiranite
  // 0 -> 1. One graze, the same on both plans: the charge run
  // e:0 u:cat:gas_xiranite -> u:class:q:20, jogged off the raw supply run it
  // used to shadow by the forward floor, clips u:class:q:23's padding overhang
  // at the level it lands on. The padding, not the box -- tier 1 stays at zero.
  // Both cells: UP moves, listed for ruling.
  script43: 1,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  // ROUTING FINDINGS 2026-09-14: 1 -> 0. e:24's liquid_xiranite supply run no
  // longer clips u:class:q:13's padding.
  transmuters: 0,
  "copper-script43": 0,
  "script43-xiranite": 1,
};

// Chip-segment ratchet: (segment, chip) pairs where a foreign flow's line passes
// under a chip box. Not zero, and not an invariant: a chip stands on the run its
// own edge draws, and in a packed corridor that run shares its row with other
// flows' legs. The hard tiers above forbid the escapes that would clear them.
const CHIP_SEGMENT_BASELINE: Record<string, number> = {
  // ROUTING FINDINGS 2026-09-14: 1 -> 0. No foreign leg draws under a chip on
  // the landing plan any more.
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
  // CATALYST NODE 2026-09-14 (PR B): 0 -> 1. One catalyst supply run from the
  // new card shares its row with a chip of the flow it feeds. UP move, listed
  // for ruling.
  transmuters: 1,
  "copper-script43": 0,
  "script43-xiranite": 0,
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
  "copper-script43": 0,
  "script43-xiranite": 0,
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
  "copper-script43": 0,
  "script43-xiranite": 0,
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Frame-ride ratchet: edge segments running ALONG a container slab's border,
// so the stroke and the border read as one line. A backward rail counts on
// both axes within FRAME_RIDE_TOL; a forward edge counts on its HORIZONTALS
// within the wider FORWARD_FRAME_RIDE_TOL, with its own containers and a
// port-row straight run exempt (auditFrameRides states why for each). Blind by
// design to a stroke that crosses or corners near a frame: only a RUN along it
// counts.
//
// CANVAS DEFECT CASEBOOK 2026-09-19: forward horizontals joined the scope, so
// every cell below is a FIRST PIN of the widened counter at its harvested
// count, not a raise of the backward-only counter (which stays where it was).
// The casebook re-reports a forward jog hugging a slab border (family F) with
// no measurement behind it; this is that measurement.
const FRAME_RIDE_BASELINE: Record<string, number> = {
  // Structural zero with no bands drawn.
  default: 0,
  battery5: 0,
  // CANVAS DEFECT CASEBOOK 2026-09-19 (T4, family F): 1 -> 0. The copper_ore
  // supply run that lay 22.5 under the plant_moss_3 loop box's top border now
  // relocates to 32 off it (e:28, 759.5 -> 711.5).
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  // CANVAS DEFECT CASEBOOK 2026-09-19 (T4, family F): 3 -> 0. The three supply
  // runs that lay 12, 16 and 16 off the two plant_grass loop boxes' borders now
  // keep CONTAINER_JOG_GAP off them (e:67 1054 -> 1038, e:69 1393 -> 1018,
  // e:81 1673 -> 1657).
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  // ROUTING FINDINGS 2026-09-14: 1 -> 0. No stroke runs along a slab or band
  // border on this plan any more.
  "rot-bottled_food_3": 0,
  // CANVAS DEFECT CASEBOOK 2026-09-19 (T4, family F): 2 -> 1. The jogged run
  // moved (e:14, 57 -> 41); the survivor is e:12, an unjogged port-to-port run 23 off the
  // bottom border (its ports sit half a unit apart, so it is not straight in
  // isStraightRun's sense and still counts); no level search ever reaches it,
  // so it needs a jog trigger, not a gap, and is out of this task's scope.
  "rot-bottled_food_4": 1,
  transmuters: 0,
  "copper-script43": 0,
  "script43-xiranite": 0,
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Dot-on-foreign-stroke ratchet (CANVAS DEFECT CASEBOOK 2026-09-19, family B):
// junction dots with a stroke of a different flow inside their drawn disc. The
// dot says "one flow meeting itself", so a foreign line through it is read as a
// member of that merge or split -- a join the plan does not have. First pins at
// the harvested counts.
const DOT_FOREIGN_STROKE_BASELINE: Record<string, number> = {
  // CANVAS DEFECT CASEBOOK 2026-09-19 (family B): 1 -> 0. The Cuprium Ore split
  // dot at (334.5, 239.5) had the Clean Water leg e:12 1.5 off its centre; the
  // fan-out slot order stands the water column right of the ore one, so the leg
  // now starts past the dot.
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  // Both cells are the same site: the gas_xiranite CATALYST divergence dot with
  // the item's ordinary supply run inside its disc, the pair the forward level
  // floor separated as lines but not as dot and line.
  "coupon-web": 1,
  // ONE INPUT CARD PER ITEM (free-target export joins the item's pool): 1 -> 0.
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
  "copper-script43": 0,
  "script43-xiranite": 0,
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
  "copper-script43": 0.5,
  "script43-xiranite": 0.5,
};

async function loadScenario(
  page: Page,
  hash: string,
  area: string | undefined,
): Promise<void> {
  await bootExamPage(page, {
    url: `/#${hash}`,
    locale: "en",
    area,
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
      await loadScenario(page, hash, scenario.area);

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

      // Frame-ride ratchet: segments running along a container slab's border --
      // a backward rail on either axis, a forward edge on its horizontals
      // (forward tap descents may share a border line by convention and are
      // still not counted). Stroke-on-frame braids are the loop-return family
      // this counter was built for, and the forward jog hugging a frame is the
      // family it was widened for; see FRAME_RIDE_BASELINE above.
      const frameRides = auditFrameRides(rawEdges, nodes);
      const frameRideInventory = frameRides.map(
        (v) =>
          `  ${v.edgeId} rides the ${v.border} border of ${v.target} ` +
          `${v.distance.toFixed(1)} off it (${v.direction}), seg ${fmtSeg(v.seg)}`,
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

      // Dot-on-foreign-stroke ratchet: junction dots with another flow's
      // stroke inside the disc. Same DOM-measured disc the hidden-dot ratchet
      // reads, so the radius is the one the dot renders at this camera; the
      // zoom only converts the half-stroke allowance into graph units.
      const dotStrokes = auditDotsOnForeignStrokes(
        geom.dots as DotRect[],
        rawEdges,
        geom.zoom,
      );
      const dotStrokeInventory = dotStrokes.map(
        (v) =>
          `  ${v.dotId} at (${v.at[0].toFixed(1)},${v.at[1].toFixed(1)}) has ${v.strokes.length} foreign stroke(s) in its disc, nearest ${v.distance.toFixed(1)} off: ${v.strokes.join(", ")}`,
      );
      const dotStrokeBaseline = baselineFor(
        DOT_FOREIGN_STROKE_BASELINE,
        "DOT_FOREIGN_STROKE_BASELINE",
        scenario.id,
        unpinned,
      );
      if (dotStrokeBaseline !== null) {
        expect
          .soft(
            dotStrokes.length,
            `${scenario.id}: ${dotStrokes.length} junction dot(s) sitting on a foreign stroke exceeds baseline ${dotStrokeBaseline} among ${geom.dots.length} dots:\n${dotStrokeInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(dotStrokeBaseline);
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Foreign strokes: chips with at least one foreign flow's stroke through the
// box. Same waiver set as CHIP_SEGMENT_BASELINE above (shared code, not a
// re-implementation), so no seat can be foreign to one and waived by the other.
// Three things make this count differ from that table: it counts CHIPS where
// that one counts (segment, chip) pairs, and it reads at the census camera
// rather than at fit zoom, where far more chips are drawn.
//
// FOREIGN VERTICAL SLIDE 2026-09-19: every cell re-harvested and re-pinned to
// the measured count, which is 0 on all fifteen plans. The seating pass now
// slides a 1-to-1 chip clear of the foreign verticals crossing its run, and
// that retired the whole catalyst-supply family the cells below carried
// (battery5 5, battery5-xiranite 9, multi6 7, the three script43 pairs 2 each,
// crystal 1, equip4 1, script43 1). Before this harvest the table was an upper
// bound 30 above the picture; a bound that loose passes a relocation in
// silence, so the numbers are stated as measured.
const FOREIGN_STROKE_BASELINE: Record<string, number> = {
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Near cards: chips whose box stands closer than CHIP_CARD_CLEARANCE to a
// card that is not one of their own endpoints'. The clearance constant is the
// seating rule's own (imported from src/canvas/edgePath via geometry.ts), so
// this table reads the seated picture against the rule that seated it. A
// 1-to-1 chip slides to a seat that clears by construction, so the residue is
// the families the slide does not cover: reserve-placed trunk chips that may
// not leave their reserve. Target state zero; ratchets down.
const NEAR_CARD_BASELINE: Record<string, number> = {
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Port cover: chips whose drawn box covers a handle, glyph or row strip of their
// own endpoint card. The furniture band straddling a port is a keep-out, so a
// chip anchored a port stub out of it clears it by construction. Target state
// zero; ratchets down.
//
// CHIP-CARD CLEARANCE 2026-09-24: every cell re-harvested and re-pinned to the
// measured count, which is 0 on all fifteen plans. The slide now seats the box
// CHIP_CARD_CLEARANCE past the furniture tier too, which retired the one family
// the pinned cells carried: a 1-to-1 chip that used to stop flush against the
// target card, lapping the port glyph standing outside the border (battery5 2,
// battery5-xiranite 2, multi6 1).
const PORT_COVER_BASELINE: Record<string, number> = {
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
  "copper-script43": 0,
  "script43-xiranite": 0,
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
  nearCard: number;
} = {
  cardIntrusion: 0,
  // ROUTING FINDINGS 2026-09-14: 30 -> 18, the sum of FOREIGN_STROKE_BASELINE
  // after that branch's re-pin.
  // CATALYST NODE 2026-09-14 (PR B): 18 -> 30, the sum after the catalyst
  // cards' supply runs joined five scenarios' chip census. Arithmetic on the
  // table above, not a separate ruling.
  // FOREIGN VERTICAL SLIDE 2026-09-19: 30 -> 0, the sum after that harvest.
  foreignStroke: 0,
  // CHIP-CARD CLEARANCE 2026-09-24: 5 -> 0, the sum of PORT_COVER_BASELINE
  // after that harvest (the slide now clears the furniture tier by the
  // clearance instead of stopping flush).
  portCover: 0,
  // CHIP-CARD CLEARANCE 2026-09-24: 0, the sum of NEAR_CARD_BASELINE pinned at
  // the post-fix counts (the slide now holds CHIP_CARD_CLEARANCE out).
  nearCard: 0,
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
    expect(sumOf(NEAR_CARD_BASELINE), "nearCard totals").toBe(
      CENSUS_TOTALS.nearCard,
    );
  });

  for (const scenario of AUDIT_SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const unpinned: string[] = [];
      const hash = await scenarioHash(scenario);
      await loadCensusScenario(page, hash, CENSUS_ZOOM, {
        locale: "en",
        area: scenario.area,
      });

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

      // Near-card: a chip box keeps CHIP_CARD_CLEARANCE from every card that
      // is not one of its own endpoints'. Target state zero, ratchets down.
      const nearCard = auditChipNearCard(chips, rawEdges, nodes);
      const nearCardPin = baselineFor(
        NEAR_CARD_BASELINE,
        "NEAR_CARD_BASELINE",
        scenario.id,
        unpinned,
      );
      if (nearCardPin !== null) {
        expect
          .soft(
            nearCard.length,
            `${scenario.id}: ${nearCard.length} chip(s) closer than the card clearance to a foreign card exceeds baseline ${nearCardPin} among ${chips.length} chips:\n${censusInventory(nearCard)}`,
          )
          .toBeLessThanOrEqual(nearCardPin);
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

// -- reading-zoom census ------------------------------------------------------
//
// A third describe with a THIRD page load, at READING_ZOOM (0.75) rather than
// the 0.6 census camera or the app's fit camera. Its own load for the same
// reason the 0.6 census has one: auditDotsUnderChips consumes geom.zoom and
// every counter here is a reading at ONE camera, so moving the camera inside
// another describe would silently re-frame its ratchets.
//
// Why a THIRD camera rather than one more counter on the 0.6 census: 0.75 is the
// zoom the exam capture CLI shoots its tiles at (READING_ZOOM, imported by
// tools/exam/capture.ts), and the chip LOD gates make WHICH chips are mounted
// and which are collapsed to icons zoom-specific. So this is the only table set
// whose numbers describe the same picture an exam image shows, and it is where a
// chip collision or a buried dot that a reader reported is confirmed or refuted.
//
// The counters are the seat-identity ones -- what a chip stands ON, and whether
// anything is lost under it -- rather than the card-relation ones the 0.6 census
// carries: a chip off its own run, a member chip off its own leg or stub, a
// junction dot swallowed, two chip boxes on each other, and a crossing cue
// swallowed.
//
// NOTE 2026-09-15, docs/plans/2026-09-15-catalyst-exam-fixes.md (I7, T8): every
// cell of every table below was pinned from ONE harvest on the integrated
// campaign branch, at the commit where the container-aware layer model (T7)
// landed. They are first pins, not moves: no earlier reading at this camera
// exists. From here they ratchet DOWN under the convention stated for the tables
// above; a rise needs a fresh ruling. The overlap and buried-dot tables are zero
// on every plan, which is the browser-side confirmation of the node-side pin in
// test/canvas/chipOverlap.corpus.test.ts.

// Chips off every horizontal run of their own polyline, at reading zoom. The
// hard tier at fit zoom asserts this at zero; here it is a table only because
// far more chips are mounted, so a seat the fit camera never drew is measured
// for the first time. Target state zero.
const READING_OWN_PATH_BASELINE: Record<string, number> = {
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Fan-out member chips off their own leg (the suffix right of the shared
// junction column), at reading zoom.
const READING_FANOUT_LEG_BASELINE: Record<string, number> = {
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Fan-in chips off their own stretch (a member off its source stub, an
// aggregate off the shared leg into the target), at reading zoom.
const READING_FANIN_LEG_BASELINE: Record<string, number> = {
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Junction dots whose whole disc sits under a chip box at reading zoom. Chips
// paint above the dots, so a covered dot is a deleted one and the split or merge
// it marks reads as an ordinary corner. Zero everywhere.
const READING_DOT_COVER_BASELINE: Record<string, number> = {
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Pairs of chip boxes standing on each other at reading zoom. PAIRS, like the
// node-side pin. Zero everywhere: two chips on one seat is the defect the scoped
// layer model was built to end.
const READING_CHIP_OVERLAP_BASELINE: Record<string, number> = {
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
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Hidden-cue ratchet (CANVAS DEFECT CASEBOOK 2026-09-19, family A): drawn
// crossing cues whose centre sits under a chip box or inside a junction dot's
// disc. Both paint above the edge layer, so the gap that says "crossing, not a
// merge" is simply not there -- and a dot sitting on the crossing says the
// opposite. The cue-coverage criterion in the P2 describe is hard zero and
// blind to this: it asks whether a cue was STAMPED, not whether it can be seen.
// This is the measurement the #131 "cue mask stays" ruling assumed and never
// had.
//
// It lives at THIS camera because what hides a cue is mostly a chip box, and a
// dense plan's fit zoom sits under the chip LOD gates: at fit zoom multi6 and
// battery5-xiranite mount no chips at all, so the sites the casebook reports
// there cannot be measured. First pins at the harvested counts.
//
// CASEBOOK FAMILY A 2026-09-19: 10 -> 1. The chip seat now slides clear of
// every vertical stroke of another flow, so no chip box can cover a cue:
// battery5 1 -> 0, battery5-xiranite 1 -> 0, multi6 4 -> 0 (the fourth is the
// cue family F stamped earlier in this stack), transmuters 2 -> 0,
// copper-script43 1 -> 0. The cell A leaves standing is `default`'s, and it is
// the one cue no chip hides -- see below.
//
// CASEBOOK FAMILY B 2026-09-19: 1 -> 0. The slot order clears that last cell,
// so this table is zero across the corpus.
const HIDDEN_CUE_BASELINE: Record<string, number> = {
  // The only dot site in the corpus: the Cuprium Ore split dot stood on the
  // crossing it marks, which is the one shape the cue exists to deny. A chip
  // slide could not reach it; family B's slot order moves the crossing out from
  // under the dot.
  default: 0,
  battery5: 0,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  // Three sites the casebook named on this plan -- a loop-return column, a
  // jogged leg and a fan-in source column, each crossing a chip's own run
  // inside the chip's box -- and family F added a fourth: the e:43 rail column
  // crossing e:46's run at (2316.5, 1333), a crossing that was already there
  // and is now cued, under the SAME chip that hid its own cue at
  // (2340.5, 1333). That was family A's multi6 e:46 site, and A retires all
  // four in this stack: the seat slides clear, so no chip covers a cue here.
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
  transmuters: 0,
  "copper-script43": 0,
  "script43-xiranite": 0,
};

// Corpus-wide totals, one per counter, asserted arithmetically against the
// tables above (see CENSUS_TOTALS for why: the suite is often run one scenario
// at a time, and a total summed over a run would then say nothing).
const READING_TOTALS: {
  ownPath: number;
  fanoutLeg: number;
  faninLeg: number;
  dotCover: number;
  chipOverlap: number;
  hiddenCue: number;
} = {
  ownPath: 0,
  fanoutLeg: 0,
  faninLeg: 0,
  dotCover: 0,
  chipOverlap: 0,
  // CASEBOOK FAMILIES A AND B 2026-09-19: 10 -> 1 -> 0, the sum of
  // HIDDEN_CUE_BASELINE after the foreign-vertical slide (the four multi6 cues
  // F leaves standing included) and then after default's dot site cleared.
  // Arithmetic on that table, not a separate ruling.
  hiddenCue: 0,
};

test.describe("reading-zoom census", () => {
  test("corpus totals match the per-scenario tables", () => {
    expect(sumOf(READING_OWN_PATH_BASELINE), "ownPath totals").toBe(
      READING_TOTALS.ownPath,
    );
    expect(sumOf(READING_FANOUT_LEG_BASELINE), "fanoutLeg totals").toBe(
      READING_TOTALS.fanoutLeg,
    );
    expect(sumOf(READING_FANIN_LEG_BASELINE), "faninLeg totals").toBe(
      READING_TOTALS.faninLeg,
    );
    expect(sumOf(READING_DOT_COVER_BASELINE), "dotCover totals").toBe(
      READING_TOTALS.dotCover,
    );
    expect(sumOf(READING_CHIP_OVERLAP_BASELINE), "chipOverlap totals").toBe(
      READING_TOTALS.chipOverlap,
    );
    expect(sumOf(HIDDEN_CUE_BASELINE), "hiddenCue totals").toBe(
      READING_TOTALS.hiddenCue,
    );
  });

  for (const scenario of AUDIT_SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const unpinned: string[] = [];
      const hash = await scenarioHash(scenario);
      await loadCensusScenario(page, hash, READING_ZOOM, {
        locale: "en",
        area: scenario.area,
      });

      const geom = await page.evaluate(collectGeometry);

      // The commanded camera has to be the camera that was measured: every count
      // below is a reading at ONE zoom, and setViewport assigns the transform
      // verbatim without promising the store kept it.
      expect(
        geom.zoom,
        `${scenario.id}: reading camera did not land at ${READING_ZOOM}`,
      ).toBeCloseTo(READING_ZOOM, 5);

      const chips = geom.chips as ChipRect[];
      const dots = geom.dots as DotRect[];
      const rawEdges = toRawEdges(geom.edges);

      // Premise: this camera really does mount chips on this plan, so the zeros
      // below are verdicts rather than an empty scan. Hard, because every
      // counter under it is vacuous without it.
      expect(
        chips.length,
        `${scenario.id}: no chips mounted at ${READING_ZOOM}; every count below would be a vacuous zero`,
      ).toBeGreaterThan(0);

      // Soft throughout: one red counter must not hide the other four.

      const offPath = auditChipsOnOwnPath(chips, rawEdges);
      const ownPathPin = baselineFor(
        READING_OWN_PATH_BASELINE,
        "READING_OWN_PATH_BASELINE",
        scenario.id,
        unpinned,
      );
      if (ownPathPin !== null) {
        const inventory = offPath.map(
          (v) =>
            `  chip ${v.chipId} of ${v.chipEdgeId} ("${v.chipLabel}") is ${v.distance.toFixed(2)} off every horizontal run of its own polyline`,
        );
        expect
          .soft(
            offPath.length,
            `${scenario.id}: ${offPath.length} chip(s) off their own polyline exceeds baseline ${ownPathPin} among ${chips.length} chips:\n${inventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(ownPathPin);
      }

      const offLeg = auditFanoutChipsOnOwnLeg(chips, rawEdges, dots);
      const fanoutPin = baselineFor(
        READING_FANOUT_LEG_BASELINE,
        "READING_FANOUT_LEG_BASELINE",
        scenario.id,
        unpinned,
      );
      if (fanoutPin !== null) {
        const inventory = offLeg.map(
          (v) =>
            `  chip ${v.chipId} of ${v.chipEdgeId} ("${v.chipLabel}") is ${v.distance.toFixed(2)} off its own fan-out leg`,
        );
        expect
          .soft(
            offLeg.length,
            `${scenario.id}: ${offLeg.length} fan-out member chip(s) off their own leg exceeds baseline ${fanoutPin}:\n${inventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(fanoutPin);
      }

      const offStub = auditFaninChipsOnOwnLeg(chips, rawEdges, dots);
      const faninPin = baselineFor(
        READING_FANIN_LEG_BASELINE,
        "READING_FANIN_LEG_BASELINE",
        scenario.id,
        unpinned,
      );
      if (faninPin !== null) {
        const inventory = offStub.map(
          (v) =>
            `  chip ${v.chipId} of ${v.chipEdgeId} ("${v.chipLabel}") is ${v.distance.toFixed(2)} off its own fan-in stretch`,
        );
        expect
          .soft(
            offStub.length,
            `${scenario.id}: ${offStub.length} fan-in chip(s) off their own stretch exceeds baseline ${faninPin}:\n${inventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(faninPin);
      }

      const hiddenDots = auditDotsUnderChips(chips, dots, geom.zoom);
      const dotPin = baselineFor(
        READING_DOT_COVER_BASELINE,
        "READING_DOT_COVER_BASELINE",
        scenario.id,
        unpinned,
      );
      if (dotPin !== null) {
        const inventory = hiddenDots.map(
          (v) =>
            `  ${v.dotId} at (${v.at[0].toFixed(1)},${v.at[1].toFixed(1)}) hidden under the chip of ${v.chipEdgeId} ("${v.chipLabel}")`,
        );
        expect
          .soft(
            hiddenDots.length,
            `${scenario.id}: ${hiddenDots.length} junction dot(s) hidden under a chip exceeds baseline ${dotPin} among ${dots.length} dots:\n${inventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(dotPin);
      }

      const hiddenCues = auditHiddenCues(geom.crossingCues, chips, dots);
      const hiddenCuePin = baselineFor(
        HIDDEN_CUE_BASELINE,
        "HIDDEN_CUE_BASELINE",
        scenario.id,
        unpinned,
      );
      if (hiddenCuePin !== null) {
        const inventory = hiddenCues.map(
          (v) =>
            `  cue of ${v.edgeId} at (${v.at[0].toFixed(1)},${v.at[1].toFixed(1)}) is hidden under ${v.hiddenBy}`,
        );
        expect
          .soft(
            hiddenCues.length,
            `${scenario.id}: ${hiddenCues.length} crossing cue(s) hidden under a chip or a dot exceeds baseline ${hiddenCuePin} among ${geom.crossingCues.length} cues:\n${inventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(hiddenCuePin);
      }

      const collisions = auditChipBoxOverlaps(chips);
      const overlapPin = baselineFor(
        READING_CHIP_OVERLAP_BASELINE,
        "READING_CHIP_OVERLAP_BASELINE",
        scenario.id,
        unpinned,
      );
      if (overlapPin !== null) {
        const inventory = collisions.map(
          (v) =>
            `  ${v.aId} ("${v.aLabel}") and ${v.bId} ("${v.bLabel}") interpenetrate ${v.dx.toFixed(1)}x${v.dy.toFixed(1)}`,
        );
        expect
          .soft(
            collisions.length,
            `${scenario.id}: ${collisions.length} overlapping chip pair(s) exceeds baseline ${overlapPin} among ${chips.length} chips:\n${inventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(overlapPin);
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
        await loadScenario(page, hash, scenario.area);
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
