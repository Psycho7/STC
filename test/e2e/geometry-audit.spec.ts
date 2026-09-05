import { test, expect, type Page } from "@playwright/test";
import { SCENARIOS, extraScenariosFromEnv, scenarioHash } from "./scenarios";
import {
  CARD_INTRUSION_BUDGET,
  auditBusChipsOutsideBand,
  auditCardFrames,
  auditChipCardIntrusion,
  auditChipForeignStrokes,
  auditChipSeatValidity,
  auditChipsOnOwnPath,
  auditChipsVsCards,
  auditDotsUnderChips,
  auditEndpointParity,
  auditFrameRides,
  auditOwnCardPierces,
  auditSegmentsVsCards,
  auditSegmentsVsChips,
  countCrossings,
  crossingCueCoverage,
  endpointManhattan,
  fmtSeg,
  parsePath,
  polylineLength,
  segmentEntersRect,
  segmentsOf,
  toRawEdges,
  type BandRect,
  type ChipCensusHit,
  type ChipRect,
  type DotRect,
  type NodeRect,
  type RawEdge,
  type RawRect,
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
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
      // The audit corpus polices the bus machinery, so every spec opts the
      // toggle on explicitly; the app default (off since the bus-lanes flip)
      // is a product decision this suite does not re-test.
      window.localStorage.setItem("aef.busLanes", "on");
    });
  });

  for (const scenario of AUDIT_SCENARIOS) {
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
// cards, and chips share one coordinate system), plus every junction dot's box.
// The pure scoring in ./geometry runs four tiers plus three independent checks,
// ALL evaluated on every run (soft assertions), so one failing tier never hides
// another:
//   tier 1 (HARD): zero edge segments entering a FOREIGN RAW (unpadded) card;
//   tier 2 (SOFT ratchet): segments entering a foreign chip box <= per-scenario
//     baseline (zero on sparse plans; 2B trades bounded line-occlusion on the
//     packed plans for the hard card clearance tier 4 enforces);
//   tier 3 (SOFT ratchet): padding-only grazes per scenario <= recorded
//     baseline (packed-layout residue where sibling paddings overlap);
//   tier 4 (P3): chip/foreign-card overlaps HARD ZERO on every scenario (the
//     ratified acceptance criterion), plus chips-off-own-line as a SOFT ratchet
//     (residue where parallel edges / bus lanes / card-hardness force a nudge);
//   dots (SOFT ratchet): junction dots hidden under a chip box <= per-scenario
//     baseline (the merge / split markers a chip's opaque box takes from the
//     reader; chips deliberately paint above the dots, so the seating pass is
//     what has to keep them apart);
//   frames (HARD): every drawn recipe card box equals the box the seating pass
//     measures chips against (card origin + model size + the card border), so
//     the two run in ONE frame;
//   parity (SOFT ratchet): every drawn path's first / last vertex within a
//     per-scenario tolerance of a model + PORT_DRIFT reconstruction of the same
//     endpoint (a MIRRORED copy of the port contract, checked against the frame
//     React Flow actually drew -- a negative control on that drawn frame, not a
//     probe of the seating pass's internals);
//   census: pairwise crossing count <= the pre-P2 baseline;
//   detour: the tundra ore feed within 1.5x its endpoints' Manhattan gap.
//
// NOTE on all ratchet tables below: baselines do NOT auto-tighten. When a change
// improves a scenario, re-record the lower count manually (downward freely). A
// baseline moves UP only with a recorded controller ruling, never as a silent
// accommodation of a regression. Eight such rulings stand: battery5 off-path
// 5 -> 6 (card-hardness pushes one pinned chip's seat off its line), the P4
// aggregate-visibility raise (chip-segment default 0 -> 2, multi6 0 -> 3,
// battery5-xiranite 0 -> 7), the own-side bus-column guard (padding grazes
// battery5-xiranite 7 -> 14), the #25 per-trunk column separation
// (crossing census default / multi6, detailed at CROSSING_BASELINE below), the
// contentBounds fix raising the fit zoom past both chip LOD gates, which drew
// the chips that were already colliding (battery5-xiranite chip-segment
// 7 -> 23 and off-path 0 -> 2, detailed at the two tables below), and the
// port-drift raise (off-path battery5-xiranite 2 -> 3, detailed at
// CHIP_OFFPATH_BASELINE below), the short-leg depth trade (chip-segment
// battery5-xiranite 11 -> 15, detailed at CHIP_SEGMENT_BASELINE below), and
// the slab-exposure raise (off-path battery5 1 -> 2, detailed at
// CHIP_OFFPATH_BASELINE below).
// At the aggregate-chip removal all five tables were re-measured wholesale and
// re-pinned DOWN to the actuals; no count rose at THAT re-measure, so it added
// no ruling of its own. Later re-measures are recorded per table.
// A SIXTH table joined during the trunk-rate legibility campaign
// (DOT_COVER_BASELINE, junction dots hidden under a chip). It adds no ruling of
// its own either: its first pins recorded the pre-keepoff state exactly as
// measured, so the seating change that followed had a committed diff base, and
// that change then re-pinned the table DOWN. It was re-pinned DOWN a second
// time (10 -> 6 -> 2) when short-leg fan-out branch chips began collapsing to
// their icon-only variant; the five tables above were re-measured at that
// commit too and every one of their thirty-five cells repeated the keep-off
// actuals recorded just below, multi6's padding graze included.
// That keep-off also SUPERSEDES, without retiring, the chips-over-dots ruling in
// canvas.css (.flow-chip z-index 2 over .bus-junction z-index 1): the z-order
// still decides who paints on top, but it is no longer the mechanism that
// handles a chip landing on a dot -- seating avoids the landing wherever a seat
// on the chip's own line allows, and this table ratchets what is left. The five
// tables above were re-measured at the same commit: every cell held, except
// multi6's padding graze, which read 0 instead of 1. That one is NOT re-pinned:
// multi6's fit zoom moved (0.208893 -> 0.206472, one top-band rise chip lifting
// a pitch grew the height-bound content box), and the graze audit reads node
// rects mapped back through the camera, so a sub-eps graze flips with the
// rounding. Edge paths and card positions are camera-independent and did not
// move.
// The row-chrome diet and the #41 slab-spacing fix, landed back to back,
// together triggered a second wholesale re-measure. Eight of the thirty-five
// cells moved: SEVEN moved DOWN and were re-pinned; ONE moved UP -- battery5
// off-path 1 -> 2 -- held red until the 2026-08-21 ruling ratified it (see
// CHIP_OFFPATH_BASELINE). None of the earlier standing
// rulings was retired by it: the port-drift raise still holds, since
// both escape seats it exposed survive the wider corridors (e:18 17.18px,
// e:34 20.52px).
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
// ratchet below (auditOwnCardPierces) tracks that residue directly. At the
// re-measure spanning the row-chrome diet and the #41 slab-spacing fix that
// residue recorded zero on every scenario -- the wider inter-layer corridors
// give the pierce rescue an off-own column where it previously had none, so
// the walled cases named above no longer occur. The paragraph is kept as the
// record of why the ratchet exists.
// A SEVENTH table joined in the same campaign (ENDPOINT_PARITY_TOL, drawn-vs-
// rebuilt edge endpoints). It adds no ruling of its own either, and unlike the
// six above it records no defect residue: it is a TOLERANCE, not a count, and
// it says that a mirrored description of a port still agrees with the port the
// DOM shows -- a negative control on the drawn frame, detailed at
// ENDPOINT_PARITY_TOL below. Its first pins were taken from an already-clean
// corpus.
// The card-frame check added alongside the cards[] frame move is a HARD
// criterion, NOT an eighth table: it holds at zero everywhere, carries no
// per-scenario baseline, and adds no ruling. The count of tables and of
// standing rulings above is unchanged by it.
// THREE SCENARIOS JOINED the corpus for the chip-seating F1+Z2 campaign:
// script43, coupon-web and gas-web, the v1.4 plans whose seating defects the
// campaign exists to fix. Every cell they add to the seven tables is a FIRST
// RECORDING -- the audit ran on the untouched branch and each cell holds what
// it reported -- so those cells state where the campaign starts, not a target
// and not a ruling. They add no ruling of their own: both hard gates (RAW
// segment/card, chip/foreign-card) and the card-frame check read zero on all
// three. From here they ratchet DOWN under the same convention as every table
// above. The measured figures are recorded per table below.
// FOUR MORE TABLES joined in the same campaign, and they are NOT part of this
// describe nor of the seven counted above: the reading-zoom seating census at
// the bottom of this file runs its own describe at its own camera, because every
// criterion here measures at fit zoom and one of them consumes that zoom. Its
// four counters are first recordings on the same untouched branch, under the
// same ratchet convention, and they add no ruling here. The one place the two
// surfaces touch is the census's foreign-stroke counter, which shares
// CHIP_SEGMENT_BASELINE's waiver code so no seat can be foreign to one and
// waived by the other.
//
// CAMPAIGN CLOSE-OUT -- chip seating F1 (rate chips ride onto their own cards)
// and Z2 (corridor braids, stranded bus chips, band escapes). Everything below
// was re-measured on the ten-scenario corpus at this commit.
//
// PIN MOVEMENT. Across the whole campaign exactly ONE cell in the seven tables
// above moved for a scenario that already existed: DOT_COVER_BASELINE battery5
// 0 -> 1, the trade written out in full at that table. Every other change those
// tables took is a first recording for the three scenarios that joined. The
// four census tables at the bottom of this file went 30 / 88 / 47 / 11 at their
// first recording to 18 / 70 / 39 / 0 here (seat validity, card intrusion,
// foreign stroke, outside band), and the deep on-card class inside card
// intrusion went 21 -> 18. Each move is attributed to the change that caused it
// in the per-table notes.
//
// THE RULINGS behind those numbers, in the order they were taken:
//   R1  No foreign-card work. Zero foreign-card chip overlaps corpus-wide, so
//       the hard foreign-card tier and its e2e gate were left untouched.
//   R2  Two chips with identical icon and identical rate text are a label
//       CONTENT problem, not a seat geometry one. Out of scope here.
//   R3  A bus rise slot is clamped into its own member's resolved run even when
//       that hides more chips for capacity: a hidden chip keeps its rate on the
//       target card's input row, a stranded one names nothing.
//   R4  The band pad is a constant -- one lane spacing plus a max-scale chip
//       half height -- and covers a chip lifted one cascade pitch INCLUSIVELY,
//       so containment assertions carry no eps margin.
//   R5  Item rate chips are never hidden. An off-path item chip stays visible
//       and stays counted.
//   R6  The census reads at a fixed reading zoom above both chip LOD gates,
//       never at fit zoom, so the chips that collide are the chips it measures.
//   R7  The lone-trunk drop chip's cascade is capped at one pitch and relaxes
//       dots before foreign lines inside the cap; chip-vs-chip stays hard.
//   R8  Own-card intrusion is a two-level SOFT rule (the tier-1 slide walks
//       past an over-budget candidate, the graze tier scores it). Foreign cards
//       stay hard everywhere.
//   R9  Seat validity is "the own polyline intersects the drawn box", not a
//       centre distance, so a sidestep seat counts as a valid seat.
//   R10 The census intrusion counter is a BOX-DEPTH rule while the seating
//       exemption is a CENTRE rule, so it can never floor at zero. The seat
//       work is judged on the deep class plus the total, not on zero.
//   R11 Ranking depth ABOVE crossings was measured and REJECTED: it trades a
//       legible-but-ugly occlusion for ownership ambiguity and hid a
//       default-plan rate chip. The lever taken instead was a realistic
//       per-chip reserved seat box.
//   R12 Coincident-column braids are a PERMANENT seating residual. Excluding a
//       foreign stroke a few units away while keeping the own stroke painted at
//       every zoom is impossible under any box model, so no seat offset clears
//       them. Disambiguation, if it is ever wanted, is a render-layer or a
//       routing change, not a seating one.
//   R13 The single UP move above, stated in full at DOT_COVER_BASELINE.
//
// WHAT THIS CLOSE-OUT DOES NOT CLAIM.
//   1. F1 is NOT closed. The deep on-card class ends at 18 -- an enumerated,
//      availability-bound residue under the realistic seat box -- and its
//      instances are enumerable from CARD_INTRUSION_BASELINE's note.
//   2. The coincidence-gated sidestep added for braid separation fired on ZERO
//      corpus seats, so it produced no Z2 movement here. Its value against a
//      braid is untested by this corpus.
//   3. The Z2 coincident-column braids are still on screen. They are the R12
//      residual: ratified, not fixed.
//
// EXAM-SURFACED FAMILIES CAMPAIGN, 2026-09-04 -- the R4 declared-output-row
// ruling. Recipe output rows now read the recipe's own declared order (in:
// every card of one recipe reads alike) instead of ELK's per-side port order,
// which flipped with consumer placement. Five pre-existing cells moved UP,
// all on the copper_nugget (Refining Unit) recipe whose port rows flipped;
// ratified the same day by controller ruling and re-pinned with cause:
// default foreign-stroke 0 -> 1 (sewage surplus stroke e:3 crosses the
// Cuprium chip box whose port moved to the top row), battery5 crossing
// 8 -> 9, script43 dot-cover 0 -> 1 (junction dot of e:3 hidden under the
// e:4 Cuprium share chip) and skipped-band 2 -> 3 (three copper_nugget rise
// chips bind to no lane band), gas-web card-intrusion 8 -> 9 (e:12
// copper_nugget-rise 40 units into card q:8). The dot-cover cell SUPERSEDES
// R13's "only UP move" restriction for this campaign: R13 spent the F1+Z2
// campaign's single sanctioned raise; this one is a separate, ratified trade
// of the exam-surfaced campaign. DOWN moves recorded at the same re-measure
// ride the per-table notes as usual.
//
// R8, same campaign -- the per-chip usable-width short-leg gate. Wide label
// chips that used to collapse to icon-only on straight legs (their arc length
// fell under the global SHORT_LEG_MAX even though the leg's x-extent fit the
// chip's own natural width) now stay full. The declared exposure,
// card-intrusion on default, HELD; the actual cost landed on five other
// scenarios as seven UP cells -- five card-intrusion arrivals (wide chips
// riding their own straight legs into card bodies) and two foreign-stroke
// arrivals -- detailed at the two tables. Ratified under the R7 precedent
// (controller best-judgment call recorded the same day); the family's
// follow-on tasks (fan-out branch window, per-chip bus seat box) are expected
// to buy some of it back.
//
// R9, same campaign -- loop returns leave the frames. Task 7's corridor
// routing moved 25 cells DOWN (multi6 crossing 415 -> 121 among them) and
// five UP: battery5 crossing 9 -> 13 and rot-bottled_food_3 3 -> 5 (rails
// now cross mid-graph corridors they used to overfly the whole graph; the
// Task 9 crossing cue exists to mark exactly these), coupon-web chip-segment
// 3 -> 4 and foreign-stroke 1 -> 2 (one event counted twice: e:15's corridor
// run under the e:8 chip), gas-web card-intrusion 7 -> 8 (a re-seated chip
// rode its rail's new anchor). Ratified under the R7 precedent (controller
// best-judgment call, ruling question unanswered, 2026-09-04).
//
// R10, same campaign -- out-of-band rail strikes padded by the full gap. A
// review pass found the y-window's struck-outside predicate comparing the
// candidate rail against raw card edges, so a backward rail could park one
// unit off a spanned card that the pre-band whole-graph behaviour always
// cleared by the full gap. Padding the predicate restores the documented
// clearance; dense-graph rails settle further out, costing four cells
// (multi6 crossing 121 -> 137 and foreign-stroke 10 -> 15, multi6
// card-intrusion 22 -> 23, gas-web crossing 39 -> 40 -- every one green at
// HEAD by differential rebuild). User-ratified 2026-09-04.

// TASK 7 -- loop returns in the corridor, not on the frame (2026-09-04). Two
// routing changes: clearRailY now escapes over only the CONNECTED BAND of
// strike intervals around the preferred y (a rail no longer hoists over every
// x-overlapping card at once), and a backward rail's two verticals keep
// CONTAINER_COLUMN_GAP off a container slab's side borders when both endpoints
// share that container (border-band obstacles; the raw fallback tier also
// widened from RAW_GAP to the container gap for every slab). Wholesale
// re-measure of every table on all twelve scenarios. DOWN moves are re-pinned
// with cause at each cell. FIVE cells measured ABOVE their pins and are LEFT
// AT THE HEAD PIN, red, pending a controller ruling (R7/R8 precedents noted;
// a new UP still needs one): CROSSING battery5 9 -> 13 and rot-bottled_food_3
// 3 -> 5 (rails now cross the mid-graph corridors they used to fly over),
// CHIP_SEGMENT coupon-web 3 -> 4 and FOREIGN_STROKE coupon-web 1 -> 2 (the
// e:15 gas_xiranite return's new corridor run at y 613 passes under the e:8
// "Separator Core" chip box), CARD_INTRUSION gas-web 7 -> 8 (a re-seated label
// chip laps a card past the budget). multi6's standing expected-failset RAW
// pierce (e:97 into q:56) is unchanged. An EIGHTH table joined: FRAME_RIDE
// (first recording, detailed at the table).
//
// TASK 8 -- fan-out branch chips confined to their own leg (2026-09-04).
// Three seating changes, all in chipSeating's fan-out branch path: the branch
// seat slides over the member's OWN leg (the suffix after the junction, the
// mirror of the aggregate seat's trunk truncation) instead of the
// trunk-including polyline; the branch short-leg rule gates on that leg's
// usable width (the item rule's per-chip measure) instead of the whole
// polyline's arc length, so a long shared trunk can no longer vouch for a
// 13-unit riser's full box; and every bending member of a DECLINED fan-out
// carries a junction-dot keep-off at its own peel-off column (dot-less
// corners included) through the same weakest-preference dot term. Wholesale
// re-measure of every table on all twelve scenarios: EIGHT cells moved, ALL
// DOWN, re-pinned with cause at each cell. NO cell rose (DOT_COVER's two
// departures are the family's own findings: rot-bottled_food_3's split dot
// under the 300/min riser chip, script43's e:3 dot under the e:4 share chip).
// The dot's rank in the seating preferences is untouched (R13).
//
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
// Re-pinned DOWN at the re-measure spanning BOTH the row-chrome diet and the
// #41 slab-spacing fix: battery5-xiranite 56 -> 55. The other six held exactly.
// The comparison is against the harvest taken before either change, and this
// cell was not differentially probed, so the single drop is not attributed to
// one of the two.
// First recordings for the three campaign scenarios: script43 55,
// coupon-web 14, gas-web 42.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): rot-bottled_food_3 3, rot-bottled_food_4 22.
const CROSSING_BASELINE: Record<string, number> = {
  default: 4, // 9 -> 4, Task 7 y-window re-measure
  // 8 -> 9 at the exam-surfaced R4 re-measure (declared output rows flip the
  // copper_nugget ports; ratified 2026-09-04). 9 -> 13 at R9 (2026-09-04):
  // loop returns stay in the mid-graph instead of flying over it, so their
  // rails cross corridors they used to overfly (Task 7; the crossing cue
  // marks them). rot-bottled_food_3 3 -> 5, same cause.
  battery5: 13,
  "battery5-xiranite": 47, // 55 -> 47, Task 7
  crystal: 1,
  equip4: 1,
  multi6: 137, // 415 -> 121, Task 7. 121 -> 137 at R10 (2026-09-04):
  // out-of-band rail strikes padded by the full gap, so multi6's dense
  // backward rails settle further out and cross more mid-graph corridors.
  tundra: 0,
  script43: 26, // 55 -> 26, Task 7
  "coupon-web": 13, // 14 -> 13, Task 7
  "gas-web": 40, // 42 -> 39, Task 7. 39 -> 40 at R10, same cause as
  // multi6.
  "rot-bottled_food_3": 5, // 3 -> 5 at R9, same cause as battery5
  "rot-bottled_food_4": 20, // 22 -> 20, Task 7
};

// Padding-graze baseline (tier 3): segments that clip only a foreign card's
// padding overhang (entry-chip reserve / port stub), never the raw box. All
// remaining grazes live where sibling paddings overlap inside a packed column,
// with no padded-clear column in the routing model (the raw fallback threads
// the raw gap instead, trading a raw strike for a graze). Recorded post-fix at
// this commit's measured counts; the ratchet only tightens.
// battery5-xiranite was once raised 7 -> 14 by the own-side bus-column guard
// (see the NOTE above): keeping bus drop / rise columns on the port side of
// their own endpoint card moved three columns off their own-body traversals and
// onto packed port-side gutters -- two liquid_water rises into q:27 (e:26, e:65)
// and one xiranite drop out of q:22 (e:17), one graze plus two three-segment
// approaches. That raise is history; later re-measures tightened the pin well
// past it, and the re-measure below took it to zero.
// Re-pinned DOWN wholesale at the re-measure spanning BOTH the row-chrome diet
// (which cuts row padding and the port-side inset, shifting port handle insets)
// and the #41 slab-spacing fix: battery5 8 -> 1, battery5-xiranite 3 -> 0,
// crystal 3 -> 0, equip4 3 -> 0, multi6 12 -> 1. No cell in this tier was
// differentially probed at the parent commit, so the split between the two
// changes is measured for none of them. The slab-corridor mechanism -- a
// widened corridor removes the sibling-padding overlap instead of re-routing
// around it -- applies to the slab-bearing scenarios (battery5,
// battery5-xiranite, multi6). crystal and equip4 have no verified loop
// container; their drops are consistent with the row-chrome inset shift flipping
// sub-10px grazes.
// The two survivors are outside slab interiors: a battery5 loop-group padding
// clip (e:4 down the liquid_xiranite_poly slab's outer edge) and a multi6 tap
// stub (e:79).
// First recordings for the three campaign scenarios: script43 2 and
// coupon-web 2 are one gas-tap approach each, counted twice because its
// vertical leg and its corner diagonal both clip the same card's padding
// (e:36 into q:10, e:16 into q:0); gas-web 1 is the corner diagonal of e:29
// into q:6. All three are tap stubs in packed gutters, the family the survivors
// above belong to.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): rot-bottled_food_3 2 (one plant_moss_3 drop column grazing
// two cards' padding), rot-bottled_food_4 1 (an iron_ore tap approach into
// loop:plant_grass_1).
const PADDED_GRAZE_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 1,
  "battery5-xiranite": 0,
  crystal: 0,
  equip4: 0,
  multi6: 0, // 1 -> 0, Task 7
  tundra: 0,
  script43: 2,
  "coupon-web": 2,
  "gas-web": 1,
  "rot-bottled_food_3": 0, // 2 -> 0, Task 7
  "rot-bottled_food_4": 1,
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
// Held on all seven at the re-measure spanning BOTH the row-chrome diet and the
// #41 slab-spacing fix: the counts are identical to the harvest taken before
// either change -- not to the immediate parent commit, which was not probed for
// this tier -- so nothing here is re-pinned. The occlusions this tier records
// live on shared vertical corridor legs, which the slab fix widens without
// separating -- a wider corridor still carries the same parallel bundle.
// battery5-xiranite measured 15, an UP move, at the re-measure spanning the
// icon-only chip collapse, the PORT_ZONE_DEPTH 12 -> 8 tracking edit and the
// declined-fan-out divergence dot. Differentially isolated to the depth edit:
// probed at the collapse commit it still measured 11, and at the depth commit
// it measured 15 with the same inventory the branch tip reports, so the dot
// commit moved nothing. One chip causes all four: the gas tap's "Xiragen x
// 30/min" used to escape 20.52px off its own polyline (it was the third
// off-path seat), and the shallower port zone lets it take an ON-LINE seat
// instead -- on the shared tap column that four sibling tap trunks run down, so
// four segments now pass under one box. The trade is one off-path seat for four
// line occlusions in the softest tier (RULING, 2026-08-21): the seating
// priority puts on-line above foreign-line clearance, so the trade is accepted,
// the depth edit stays, and the pin moves 11 -> 15.
// First recordings for the three campaign scenarios: script43 13,
// coupon-web 3, gas-web 20. Same family as the residue above -- long gas-tap
// and surplus columns running the full height of the plan pass under label
// chips seated on other edges' corridor legs. On gas-web a single tap column
// accounts for several hits at once (e:24 crosses four chips), so the counts
// track a handful of columns, not a spread of seats.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): rot-bottled_food_3 2, rot-bottled_food_4 2 -- the same
// full-height column passing under label chips family as above.
const CHIP_SEGMENT_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 3,
  "battery5-xiranite": 0, // 15 -> 0, Task 7
  crystal: 0,
  equip4: 1,
  multi6: 0,
  tundra: 0,
  // 13 -> 7, Task 7. 7 -> 5, Task 8: two (segment, chip) pairs left with the
  // fan-out branch chips the leg confinement re-seated (the surviving five
  // are the same full-height tap/surplus columns under label chips).
  script43: 5,
  // 3 -> 4 at R9 (2026-09-04): e:15's new corridor run (Task 7 loop-return
  // routing) passes under the e:8 "Separator Core" chip -- one event, also
  // counted by the coupon-web foreign-stroke cell.
  "coupon-web": 4,
  // 20 -> 9, Task 7. 9 -> 8, Task 8: one tap-column-under-chip event left
  // with the re-seated branch chips.
  "gas-web": 8,
  "rot-bottled_food_3": 0, // 2 -> 0, Task 7
  "rot-bottled_food_4": 2,
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
// now take a genuine least-bad escape (e:18 17.18px, e:34 20.52px). The
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
// Off-path re-measure. battery5-xiranite holds at 3, but its membership
// changed: e:18 (17.18px) and e:34 (20.52px) survive, so the port-drift ruling
// above is NOT retired, while the third seat moved to e:4 Xircon Effluent at
// 107.63px. battery5 measured 2, an UP move (e:18 Xircon Effluent 40.95px, up
// from 31.70px pre-fix, plus a new e:1 Originium Powder seat 8.50px) and was
// pinned 1 -> 2 (RULING, 2026-08-21): the slab-spacing fix exposed two genuine
// escape seats; both remain candidates for a future seating fix.
// Re-pinned DOWN 3 -> 2 on battery5-xiranite at the re-measure spanning the
// icon-only chip collapse, the PORT_ZONE_DEPTH 12 -> 8 tracking edit and the
// divergence dot. Differentially isolated to the depth edit (the collapse
// commit still measured 3; the depth commit measured 2 with the branch tip's
// inventory). The seat that left is e:34 "Xiragen x 30/min" at 20.52px: with
// the shallower port zone its on-line candidate clears, so it stops escaping.
// e:4 (107.63px) and e:18 (17.18px) survive, so the port-drift ruling above is
// still NOT retired. This cell and the battery5-xiranite chip-segment rise are
// the SAME chip moving -- reverting the depth edit puts both back, so revert
// this pin with it. battery5 measured 2 again, unchanged (ratified above).
// The three campaign scenarios first recorded zero: no label chip on any of
// them leaves its own polyline today.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): both zero, no label chip leaves its own polyline on either.
const CHIP_OFFPATH_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 0, // 2 -> 0, Task 7
  "battery5-xiranite": 0, // 2 -> 0, Task 7
  crystal: 0,
  equip4: 0,
  multi6: 0,
  tundra: 0,
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
};

// Own-endpoint-pierce ratchet: segments that run inside their OWN source /
// target card's RAW body. The foreign segment audit (tier 1) exempts an edge's
// own endpoint cards, so this residue is its blind spot -- a rise / drop that
// the pierce rescue lands inside its own endpoint card (the last-resort 3b
// traversal, taken only where the port-side corridor is so packed that no
// off-own column clears) never shows up there. Held per scenario and ratcheted
// DOWN only, under the same manual-ruling convention as the tables above.
// First recorded at the own-side-guard fix with battery5 at 6 (e:10 and e:40,
// three segments each, rising into their own liquid_water target q:18) and
// battery5-xiranite at 16 (target rise e:15 and source drops e:19 / e:20 /
// e:22 / e:23 / e:50, each a walled corridor with no off-own column). Later
// re-measures tightened both -- battery5 to 0 and battery5-xiranite to 2 -- and
// the re-measure spanning BOTH the row-chrome diet and the #41 slab-spacing fix
// takes the whole corpus to zero. The only cell left to move was
// battery5-xiranite 2 -> 0, a slab-bearing scenario the slab-corridor mechanism
// covers: with real inter-layer corridors the rescue finds an off-own column, so
// the last-resort own-body traversal never fires. It was not differentially
// probed at the parent commit. Pinned at zero everywhere, which
// makes this tier an effective hard gate until something reintroduces a walled
// corridor.
// The three campaign scenarios first recorded zero too, so the gate now holds
// across the ten-scenario corpus.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): both zero.
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

};

// Frame-ride ratchet (Task 7, loop-backedge-braids-container family): edge
// segments running ALONG a container slab's border (within FRAME_RIDE_TOL = 16,
// matching CONTAINER_COLUMN_GAP, for more than two port stubs of overlap) and
// backward item edges running along a bus band's border, either side. The
// stroke and the border then read as one line -- the #29 follow-on the rail-gap
// fix left behind on the VERTICALS, plus the band-bottom variant. A FIRST
// RECORDING at the Task 7 fix commit, so every cell states where the campaign
// is after the y-window and container-column fixes, not a target; it ratchets
// DOWN under the same convention as every table above. The two rot- cells are
// campaign-first measurements (2026-09-04) like their rows in the tables above.
// Note the counter's blind spots by design: a stroke within 16 of a frame for
// LESS than two port stubs (a crossing or corner) never counts, and container
// borders are read from the drawn DOM rects.
// First-recording residue, two hits corpus-wide, both shapes the Task 7 fix
// deliberately does not touch: battery5's e:9 (xiranite_poly) keeps its
// default column 9 off loop:liquid_xiranite_poly's right border because only
// its SOURCE is a member (the shared-parent un-exemption needs both), and
// rot-bottled_food_4's e:12 is a FORWARD tap's jog-descent column 2 off
// loop:plant_grass_1's left border -- a jogForwardLegs column, outside the
// loop-return family. Every loop-return column and rail the fix owns reads
// 16+ off its frame (multi6 e:48 at 1340/580 vs borders 1356/564,
// rot-bottled_rec_hp_1 e:3 at 1086/294 vs 1070/278, verified by probe).
// Re-pinned DOWN at the round-2 per-side bands fix (same campaign): battery5
// 1 -> 0. Each endpoint's OWN container now joins its side's column scan as
// border bands, so e:9 -- whose only member endpoint is its source -- holds
// the full gap off the loop's right border instead of riding it. The rot-
// bottled_food_4 cell re-measured unchanged in the same pass: e:12 is a
// forward jog descent, not a return column, and no fix in this family moves
// it; it stays the sole recorded residue.
const FRAME_RIDE_BASELINE: Record<string, number> = {
  default: 0,
  // 1 -> 0, round-2 per-side bands (e:9); first recording was Task 7.
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
  // First recording, Task 7 (e:12); held at the round-2 per-side bands
  // re-measure (a jog descent, not a return column). 1 -> 0 once the audit
  // scoped itself to backward edges: the e:12 descent is a forward tap's
  // entry column, the shape the convention doc exempts.
  "rot-bottled_food_4": 0,

};

// Hidden-junction-dot ratchet: dots whose whole drawn disc sits under a chip
// box at fit zoom. Chips paint ABOVE the dots by design (the z-order tier
// asserted in the P1 gate above), so a chip seated on a dot does not merely
// overlap it -- it deletes it, and the merge / split the dot marks reads as an
// ordinary corner. First recorded here at the campaign's pre-keepoff state, so
// the counts below are a measurement of the defect, not a target; like every
// table above it ratchets DOWN freely and moves UP only on a recorded ruling.
// Two families made up the first recording (10 corpus-wide): a lane rise chip
// covering a junction dot 8-13 units from its own centre (its own dot, or a
// coincident sibling member's), and the restored fan-in owner chip covering the
// merge dot on battery5-xiranite's e:14 (the shared-run owner chip that replaced
// the removed sigma, which used to keep a half-box off the junction).
// Re-pinned DOWN to 6 by the seating keep-off (#50), which walks a chip along
// its own line (or one pitch off its lane) to a seat that leaves the dot
// visible, whenever such a seat exists. Cleared: default's water rise, the
// battery5 and battery5-xiranite iron_powder rises, and multi6's
// originium_enr_powder rise -- four lane rises that had a clear lane-side slot.
// Re-pinned DOWN again, to 2, by the short-leg collapse (#50): a fan-out member
// whose whole polyline is shorter than one chip box now draws its branch chip
// icon-only, and its seat reserves that same square box, so the four Sandleaf
// trunk chips (battery5 e:8, battery5-xiranite e:13, crystal e:8, equip4 e:10)
// -- each seated 9 units past its trunk's split dot on a 118-unit leg, with a
// box wider than the whole leg -- now slide clear of the dot ON their own line.
// The share digits they shed stay on their hover title and aria-label.
// The TWO survivors are the cases where no seat on the chip's own polyline
// clears the dot and no collapse applies, measured per case:
//   - battery5-xiranite's fan-in owner chip (e:14) has 89 units of reach along
//     its polyline against the ~93 its drawn box needs to clear the merge dot
//     (its leg is long enough that the short-leg rule does not fire);
//   - multi6's gas_inert rise (e:74) has its one lane-side slot blocked.
// The two are stuck for different reasons. Clearing e:14 means taking a chip
// OFF its own polyline, which the off-path ratchet forbids without a ruling.
// e:74 is not an off-path case at all: the keep-off's one-pitch lane-side probe
// is the seat that would clear it, and that slot is occupied -- crowding, not
// the ratchet, is what holds it. Both are reported as they stand.
// First recordings for the three campaign scenarios: script43 0, coupon-web 0,
// gas-web 1 -- a copper_nugget fan-out chip (e:11) covering the merge dot of
// its sibling e:10 at (1233,349), the same fan-in owner shape as the
// battery5-xiranite survivor above.
//
// RE-MEASURED at 4 after the per-chip reserved seat box (Task 6b): battery5
// 0 -> 1, one arrival, and it is a RATIFIED TRADE rather than a keep-off
// regression. battery5 e:18 (Xircon Effluent 240/min) used to have no seat on
// its own polyline at all and sat 40.9 units OFF it -- an orphan chip, counted
// in seat validity, with its fan-in merge dot visible only because the chip had
// left. With the narrower box the chip seats back ON its line and its box now
// covers that dot. The pass's own priority order decides this one: keeping off
// a junction dot is the WEAKEST preference there is and never costs a chip its
// line (chipSeating's header), so a chip on its line over a dot beats a chip
// floating beside its line with the dot showing. SEAT_VALIDITY_BASELINE's
// battery5 cell drops from 2 to 1 in the same move.
// The dot is not the only cost, and the whole trade is stated here: the same
// on-line seat also deepens that chip's OWN-card intrusion on u:class:q:17 from
// 27.7 to 40.0, so battery5 e:18 is simultaneously one of the six deep-class
// arrivals enumerated in CARD_INTRUSION_BASELINE's note below. So the move buys
// one seat-validity case with one junction dot AND one deep-class saturation.
// RATIFIED at the Task 6b review as ruling R13 (the campaign plan carries the
// same trade): seat validity is structural, the dot is the weakest preference in
// the pass, and the depth is the crossings-over-depth precedence R11 declined to
// reopen. It remains the campaign's only UP move on a pre-existing pin.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): rot-bottled_food_3 1 and rot-bottled_food_4 1, both a bus
// rise chip covering its own junction dot.
const DOT_COVER_BASELINE: Record<string, number> = {
  default: 0,
  battery5: 1,
  "battery5-xiranite": 0, // 1 -> 0, Task 7
  crystal: 0,
  equip4: 0,
  multi6: 0, // 1 -> 0, Task 7
  tundra: 0,
  // 0 -> 1 at the exam-surfaced R4 re-measure: the junction dot of e:3 hides
  // under the e:4 Cuprium share chip whose port row flipped (ratified
  // 2026-09-04; supersedes R13's single-raise restriction for this campaign).
  // 1 -> 0, Task 8: the branch chip seats on its own leg now and the riser
  // legs collapse to the icon box, so the share chip no longer parks over
  // the split.
  script43: 0,
  "coupon-web": 0,
  "gas-web": 0, // 1 -> 0, Task 7
  // 1 -> 0, Task 8: the Sandleaf 300/min riser chip (the family's own
  // finding) collapses to the icon box and slides down its 13-unit leg clear
  // of the split dot it used to bury from the trunk side.
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 1,
};

// Endpoint-parity tolerance, in GRAPH UNITS, per scenario: the largest
// per-axis gap allowed between an edge's drawn first / last vertex and a
// reconstruction of that same endpoint from the node's card origin, the model
// port geometry, and PORT_DRIFT (auditEndpointParity). The reconstruction runs
// off a MIRRORED copy of chipSeating's port contract -- the same drift constants
// and the same row math -- so what this table states is that that contract still
// agrees with the DOM.
//
// It anchors on the DRAWN card origin, which makes it a NEGATIVE CONTROL on the
// drawn frame: it says the frame did not move, and it catches a row-index or
// port-contract regression, which lands a full row pitch out. It is NOT
// sensitive to chipSeating's src-side internals -- zeroing the source PORT_DRIFT
// leaves it green. See the mirror comment above PORT_DRIFT in test/e2e/geometry.ts
// for that one-directionality and its blind spots.
//
// A tolerance rather than a count, and deliberately coarse: the disagreement it
// exists to catch is an endpoint resolving to the WRONG ROW, which lands a full
// row pitch (22 units) or a whole card width out. Sub-unit residue is not a
// defect -- ItemEdge's HIDE_STALE_EPS comment records ~1 unit of port-model
// noise between a reconstruction and React Flow's measured handles, and sets its
// own guard well above it for the same reason.
//
// Measured at the pin commit, per scenario, as the max over both axes and every
// endpoint: default 0.000, battery5 0.004, battery5-xiranite 0.005,
// crystal 0.002, equip4 0.001, multi6 0.005, tundra 0.000 (24-224 endpoints
// each). Every one is double-precision residue from mapping client rects back
// through the inverse viewport transform -- nothing structural survives -- so
// the pins are a flat measured-max-plus-headroom 0.5, two orders of magnitude
// above the noise and one and a half below a row pitch. They ratchet DOWN like
// the tables above; a rise needs the same recorded ruling.
// The three campaign scenarios measured the same residue and take the same flat
// 0.5 pin: script43 0.003 (76 endpoints), coupon-web 0.001 (38), gas-web 0.001
// (62).
// The two exam-surfaced scenarios (campaign-first measurement 2026-09-04,
// exam-surfaced-families Task 0, re-measurable within the campaign) measured
// the same residue and take the same flat 0.5 pin: rot-bottled_food_3 0.001
// (38 endpoints), rot-bottled_food_4 0.003 (42).
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

// One DRAWN bus-band caption (the faint "BUS" tag BusBands paints inside each
// band tint), in graph coordinates: the band it rides plus the tag's box. Read
// by a spec-local self-contained collector (page.evaluate cannot close over
// imports) that mirrors collectGeometry's viewport-inverse mapping, so a tag
// box compares directly with edge paths. The caption is DECORATION, not an
// obstacle the seating passes measure against (the exam-surfaced campaign's R5
// moved it into the band's top pad rather than registering it), so the shared
// collectors deliberately do not carry it and this check reads it itself.
type BandTagRect = RawRect & { band: string };

async function collectBandTags(page: Page): Promise<BandTagRect[]> {
  return page.evaluate(() => {
    const rf = document.querySelector<HTMLElement>(".react-flow");
    const vp = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (rf === null || vp === null) return [];
    const rfRect = rf.getBoundingClientRect();
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
    const toGraphX = (x: number): number => (x - rfRect.left - m.e) / m.a;
    const toGraphY = (y: number): number => (y - rfRect.top - m.f) / m.a;
    return Array.from(
      document.querySelectorAll<HTMLElement>(".bus-band-tag"),
    ).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        band: el.closest<HTMLElement>(".bus-band")?.dataset.testid ?? "(band)",
        left: toGraphX(r.left),
        top: toGraphY(r.top),
        right: toGraphX(r.right),
        bottom: toGraphY(r.bottom),
      };
    });
  });
}

test.describe("segment placement audit", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
      window.localStorage.setItem("aef.busLanes", "on");
    });
  });

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
      const offPathBaseline = baselineFor(
        CHIP_OFFPATH_BASELINE,
        "CHIP_OFFPATH_BASELINE",
        scenario.id,
        unpinned,
      );
      if (offPathBaseline !== null) {
        expect
          .soft(
            offPath.length,
            `${scenario.id}: ${offPath.length} label chip(s) off their own polyline exceeds baseline ${offPathBaseline}:\n${offPathInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(offPathBaseline);
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

      // Frame-ride ratchet (Task 7): backward item edges' segments running
      // along a container slab's border or a bus band's border (forward tap
      // descents may share a border line by convention and are not counted). Stroke-on-frame braids are the loop-return family this counter
      // exists to hold at zero; see FRAME_RIDE_BASELINE above.
      const frameRides = auditFrameRides(
        rawEdges,
        nodes,
        geom.bands as BandRect[],
      );
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
            `${scenario.id}: ${frameRides.length} frame/band ride(s) exceeds baseline ${frameRideBaseline} among ${geom.bands.length} band(s):\n${frameRideInventory.join("\n")}`,
          )
          .toBeLessThanOrEqual(frameRideBaseline);
      }

      // Hidden-dot ratchet: junction dots swallowed by a chip box at fit zoom.
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

      // Census: pairwise crossings never regress past the pre-P2 baseline.
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
            `${scenario.id}: ${crossings} crossings exceeds pre-P2 baseline ${baseline}`,
          )
          .toBeLessThanOrEqual(baseline);
      }

      // Crossing-cue coverage (Task 9): every counted crossing between
      // DIFFERENT flows (different item|source) must carry a DRAWN cue on
      // one edge of the pair -- the stroke masked out around the crossing,
      // whichever of the two the seating pass picked (a transparent gap
      // reads the same in either paint order, so no z key is involved).
      // ZERO-TOLERANCE by design, no baseline table: the seating pass stamps
      // a cue for every cross-flow proper crossing by construction, and the
      // renderers cut every stamped cue that still sits on their live
      // polyline, so a miss means the stamp pass or the render broke --
      // there is no legitimate residue class to pin. Same-flow crossings (between one flow's own
      // edges: trunk members overlapping a lane, fan-out slices sharing a
      // trajectory) are one visual line by the flowKey doctrine and
      // deliberately NEVER cued; they are reported in the message so a plan
      // where that class suddenly grows stays visible instead of silently
      // living outside the assertion.
      // First recordings (2026-09-04, informational, not a ratchet) --
      // crossFlow / sameFlow per scenario, cued equalled crossFlow on every
      // one: default 4/0, battery5 13/0, battery5-xiranite 46/1, crystal 1/0,
      // equip4 1/0, multi6 130/7, tundra 0/0, script43 26/0, coupon-web 13/0,
      // gas-web 39/1, rot-bottled_food_3 5/0, rot-bottled_food_4 20/0. The
      // drawn-cue count can sit BELOW cued (multi6 120 gaps for 130 cued
      // crossings): the stamp pass dedupes per edge and point, so trunk
      // members sharing a lane that crosses one foreign edge together draw
      // one gap where the census counts each member pair.
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

      // ZERO-TOLERANCE (exam-surfaced campaign, ruling R5): no edge path
      // segment enters a bus-band caption's box. The caption is a decorative
      // tag, never an obstacle -- nothing in the routing model avoids it --
      // so the invariant is held by WHERE IT SITS: in the band's OUTER pad,
      // the BAND_Y_PAD strip (one lane spacing 48 plus a max-scale chip half
      // height 24 = 72 flow units) on the far side of the graph. Every bus
      // drop / rise column ends at its own lane and lanes sit graph-side, so
      // no path vertex enters an outer pad and the 20-unit tag pinned 4 off
      // the pad edge clears the outermost vertex by 48 units. The top band
      // anchors at its top pad and the bottom band at its bottom pad because
      // the pads are NOT interchangeable: the bottom band's top pad is the
      // corridor its members' columns descend through from the graph
      // (multi6: five tap columns at x 192-208 cross its full height), so
      // top-anchoring both bands drops the caption back under strokes. The
      // caption moved from mid-band, where a stroke crossed the text at the
      // leftmost column (the caption half of stroke-crosses-foreign-chip:
      // multi6 bus-label-under-stroke, rot-bottled_food_4
      // loop-label-crossed-by-back-edge). The check reads the DRAWN box, so a
      // CSS regression that re-centres the caption on the lanes reddens it
      // directly; the tag rides the viewport transform (no counter-scale), so
      // its graph-space rect -- like the paths -- is the same at every zoom
      // and one fit-zoom reading states the invariant at all of them.
      // Rotating plans get this check through extraScenariosFromEnv like
      // every zero-tolerance criterion here.
      const bandTags = await collectBandTags(page);
      const tagHits: string[] = [];
      for (const tag of bandTags) {
        for (const edge of rawEdges) {
          for (const [seg0, seg1] of segmentsOf(parsePath(edge.d))) {
            if (segmentEntersRect(seg0, seg1, tag, 0.5)) {
              tagHits.push(
                `  ${edge.id} seg ${fmtSeg([seg0, seg1])} enters the BUS caption of ${tag.band}`,
              );
            }
          }
        }
      }
      expect
        .soft(
          tagHits.length,
          `${scenario.id}: ${tagHits.length} segment(s) strike the BUS caption(s) among ${bandTags.length} band tag(s):\n${tagHits.join("\n")}`,
        )
        .toBe(0);

      skipUnpinnedRatchets(unpinned);
    });
  }
});

// -- reading-zoom seating census ---------------------------------------------
//
// Its OWN describe with its OWN page load, deliberately: every criterion in the
// P2 describe above measures at FIT zoom (auditDotsUnderChips even consumes
// geom.zoom), so moving the camera inside that test would silently re-frame
// seven ratchets. Nothing is shared between the two but the collectors.
//
// The camera is a fixed reading zoom of 0.6, commanded through the exam hook the
// app installs under `?exam=1` (Canvas.tsx). Why a fixed zoom at all: at
// multi6's fit zoom (~0.21) BOTH chip LOD gates fire and nearly every chip is
// not drawn, so a fit-zoom census of that plan measures almost nothing --
// exactly why CHIP_OFFPATH_BASELINE["multi6"] is "unmeasured rather than clean".
// 0.6 clears LABEL_MIN_ZOOM (0.35) and CHIP_ICON_ONLY_MAX_ZOOM (0.32) on every
// plan, so every chip is drawn with its digits. React Flow does not virtualise
// nodes or the edge-label layer here, so the chips that fall outside the pane at
// that zoom are still mounted and still measure.
//
// The camera also fixes the chip BOX SIZE, which is why the numbers below are
// only comparable to each other. A chip counter-scales by min(2, 1/zoom) about
// its centre, so in graph units its box is 1.667x its natural size here, against
// 2x at any fit zoom below 0.5 and 1.333x at the 0.75 the exam evidence was
// gathered at. Every count in the four tables is therefore a reading at zoom
// 0.6 and nothing else; re-measure the whole table if the camera moves.
//
// The pan keeps the world point that was at the pane centre at fit zoom in the
// pane centre, so the frame is the middle of the plan on every scenario. It is
// arbitrary for the measurement (all rects are mapped back to graph coordinates
// and nothing is culled) and is fixed only so a debugging screenshot of a census
// failure shows the same region every run.
const CENSUS_ZOOM = 0.6;

// The exam camera handle the app installs under `?exam=1`, declared locally the
// same way tools/exam does: the app puts it on Window from a module this spec
// has no reason to load, and the type is erased before any of it reaches the
// browser.
type ExamHook = { setViewport(v: { x: number; y: number; zoom: number }): void };
type ExamWindow = Window & { __stcExam?: ExamHook };

async function loadCensusScenario(page: Page, hash: string): Promise<void> {
  await page.goto(`/?exam=1#${hash}`, { waitUntil: "load" });
  await waitForCanvasReady(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await waitForStableViewport(page);
  await page.waitForFunction(
    () => (window as ExamWindow).__stcExam !== undefined,
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate((zoom) => {
    const hook = (window as ExamWindow).__stcExam!;
    const pane = document
      .querySelector<HTMLElement>(".react-flow")!
      .getBoundingClientRect();
    const vp = document.querySelector<HTMLElement>(".react-flow__viewport")!;
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
    const worldCx = (pane.width / 2 - m.e) / m.a;
    const worldCy = (pane.height / 2 - m.f) / m.a;
    hook.setViewport({
      x: pane.width / 2 - worldCx * zoom,
      y: pane.height / 2 - worldCy * zoom,
      zoom,
    });
  }, CENSUS_ZOOM);
  await waitForStableViewport(page);
}

// FIRST RECORDINGS, all four tables. They were measured on the campaign's
// pre-fix branch tip with every cell pinned at zero and the reported actual
// read back out of the failure message, scenario by scenario. They state where
// the campaign starts -- not a target, not a ruling -- and from here they
// ratchet DOWN under the same convention as the seven tables above. Because
// this campaign first recorded them, they may also be RE-measured freely inside
// the campaign with the cause annotated; that licence ends when the campaign
// does.
//
// Seat validity: chips whose own edge's polyline does not pass through their own
// drawn box. Structural, all chip kinds, so it sees what auditChipsOnOwnPath
// (label chips only, centre distance) cannot: the lane rise chips stranded at a
// trunk-wide slot index and the drop chips cascaded off their lane. It is also
// STRICTLY WEAKER than that centre rule for the chips both cover -- a sidestep
// seat holds the line inside the box while moving the centre off it -- which is
// why CHIP_OFFPATH_BASELINE reads 0 on the three plans that dominate here.
// Measured 30 corpus-wide: 28 BUS chips -- the family the off-path ratchet
// cannot see at all -- and 2 label chips. The 28 are lane rise chips parked at a
// trunk-wide slot index far from where their own member leaves the lane (multi6
// e:67 / e:77 / e:86 / e:88 / e:90 / e:92 / e:94 / e:108, script43's five
// gas_xiranite rises e:24 / e:26 / e:27 / e:28 / e:29, gas-web's five, and so
// on) plus the drop-side case with no guard at all (multi6 e:74, cascaded 144.2
// off its lane). The 2 label chips are battery5 e:18 and battery5-xiranite e:4,
// two of the four seats CHIP_OFFPATH_BASELINE already pins; the other two
// (battery5 e:1 at 8.50 and battery5-xiranite e:18 at 17.18) keep their own line
// inside the box and so are valid seats here. That is the "strictly weaker"
// relation in numbers.
//
// It does NOT make the counter immune to a sidestep, as first recorded here.
// The seat reserves a worst-case box (max counter-scale, full label width) and
// the reach that keeps the own line "inside the box" is measured against THAT,
// while this census measures the box the chip actually paints -- 20% narrower
// at this camera before any label-width slack. A step at the flush end of the
// reach therefore holds the line inside the reserve and outside the paint.
// Measured: an unbounded scored sidestep put multi6 e:18 at the flush 120 and
// this counter read 19, the chip floating a full half-width off its line with
// its two foreign strokes shed. The shipped tier caps its reach at half the
// reserve for exactly that reason, and the counter holds at 18. Task 6b
// extended that same bound to the FULLY CLEAR step (tier 1c), which had kept the
// full reach: measured against the per-chip box, leaving 1c uncapped read 19
// here while capping it holds 18 and drops card-intrusion and foreign-stroke
// further as well (ruling R12).
//
// RE-MEASURED at 18 after the rise-slot clamp and the drop cascade cap. The
// x-stranding family is gone: no chip is off its own line by more than one
// cascade pitch any more (the worst was 663 units), and multi6 e:74's drop now
// holds its junction. What is left is 16 bus chips at exactly 48.0 -- rise chips
// lifted ONE pitch off their lane, by the junction-dot keep-off (#50) or by
// crowding -- plus the same 2 label chips. That residue is structural at this
// camera: the drawn box is 40 tall here, so a chip one pitch off its lane can
// never touch it, while the seating pass ratifies one pitch as "beside the lane"
// and hides anything past it. Clamping a stranded slot lands it at its own run's
// far end, which is where that run's junction dot sits, so the keep-off lifts it
// -- beside its own run beats spread onto a sibling's stroke.
// RE-MEASURED at 18 after the per-chip reserved seat box (Task 6b). The total
// holds; two cells swap. battery5 2 -> 1: e:18 had no seat on its own polyline
// under the worst-case box and sat 40.9 units off it; the narrower box gives it
// one (it pays a junction dot for it, see DOT_COVER_BASELINE). multi6 5 -> 6:
// e:35 (Ferrium Powder 600/min) went the other way, displaced off its line by
// the re-seating cascade as its neighbours took the corridor room the narrower
// boxes freed. Both cells are campaign-own measurements, re-measured with cause.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): both zero; every chip holds its own line inside its box.
const SEAT_VALIDITY_BASELINE: Record<string, number> = {
  default: 0, // 1 -> 0, Task 7
  battery5: 0, // 1 -> 0, Task 7
  "battery5-xiranite": 4,
  crystal: 0,
  equip4: 0,
  // 6 -> 1, Task 7. 1 -> 0, Task 8: the fan-out branch chips seat on their
  // own legs now, and the one chip whose box had left its line came home
  // with the narrower collapsed reserve.
  multi6: 0,
  tundra: 0,
  script43: 1, // 3 -> 1, Task 7
  "coupon-web": 0, // 1 -> 0, Task 7
  // 2 -> 0 at the Task 5 rise-seat re-measure (2026-09-04): the plan's
  // gas_xiranite lane-trunk rise chips moved off their trunk-wide spread slots
  // into their own rise-end windows, and the one seat that sat a pitch off its
  // own polyline now sits flush on its run. The gas-web cell had 1 of headroom
  // against the pin even before this (measured 1 at Task 3); the re-pin takes
  // the measured 0.
  "gas-web": 0,
  "rot-bottled_food_3": 0,
  "rot-bottled_food_4": 0,
};

// Card intrusion: chips whose box reaches more than CARD_INTRUSION_BUDGET deep
// past a node card's border, OWN cards included, container slabs excluded. A
// depth rule, sharing its budget with the seating pass's own-card port-strip
// exemption, so a chip lying across the port strip on its own line -- the normal
// on-line state -- never counts however wide it is. Distinct from the tier-4
// hard gate above, which is a CENTRE rule against foreign cards plus
// chipEntersOwnCardBody on own ones; that gate stays at zero and is untouched.
// Measured 88 corpus-wide, the largest of the four counters and the F1 family
// the campaign names: a chip anchored on its own line a stub's length off the
// port has half a box left over, and that half lands on the card. The depths
// run from just past the budget to a full 40, and 21 of the 88 are at that 40:
// 40 is the drawn chip HEIGHT at this camera, so the depth has saturated on the
// vertical axis and the box is swallowed whole in x, sitting on the card body
// with only its centre still out in the port strip (multi6 e:30 / e:49,
// script43 e:18 / e:21). Two are bus rise chips (script43 e:3 / e:4); the other
// 86 are label chips.
// Unmoved by the rise-slot clamp and the drop cascade cap: every cell re-read
// identical. Both are lane-frame changes and this counter is dominated by label
// chips at node ports.
//
// RE-MEASURED at 84 after the seating pass gained its own box-depth rule: the
// tier-1 slide and the graze scorer now rank a candidate's depth into its OWN
// endpoint cards (below the junction-dot keep-off in tier 1, below the
// foreign-line crossing count in the graze tier), so a chip that used to stop
// at the first otherwise-clear point keeps walking its line to one whose BOX
// also clears the card. Six seats moved off a card (battery5 e:19,
// battery5-xiranite e:28, multi6 e:12 / e:83 / e:84 / e:110, depths 9.5 to
// 29.1) and two moved onto one at shallow depth (multi6 e:5 at 10.5, script43
// e:17 at 15.4, both chips that shifted along their own lines as the seats
// around them changed) -- hence script43 15, one ABOVE its first recording.
// That cell is a measurement this campaign took, not a ratified trade, and the
// plan's ratchet rule lets it be re-measured with its cause recorded.
//
// The DEEP class -- 21 chips whose depth saturates at the drawn box height, the
// ones a reader sees lying ON a card -- did NOT move, and the reason is
// availability, not ranking. Traced candidate by candidate at this camera: 12
// of them (battery5 e:6 / e:11 / e:12, battery5-xiranite e:11 / e:14 / e:21,
// crystal e:5, multi6 e:49, script43 e:21 / e:31 / e:32 / e:33) have exactly
// one fully clear point on the whole line and it is the buried one -- every
// shallower point on the corridor crosses a foreign line, and crossings
// outrank depth by ruling; 7 (battery5-xiranite e:18 / e:20, gas-web e:17 /
// e:25, multi6 e:30 / e:99, script43 e:18) have NO fully clear point, so their
// seat comes from the sidestep or the graze scorer where the same precedence
// applies; 2 (battery5-xiranite e:19, gas-web e:18) had a within-budget graze
// candidate that lost on crossings. All 21 reserve a 240-wide worst-case box
// while drawing 120-200 here, which is what makes the corridor interior look
// blocked. Closing them needs either that box model or the crossings-vs-depth
// precedence revisited, not another seat-preference term.
//
// RE-MEASURED at 81 after the sidestep tier started scoring its steps instead
// of taking the first fully clear one (script43 15 -> 14, gas-web 10 -> 8).
// That tier fires where NO point on the own line is clear, and until now it
// took the nearest clear horizontal step whatever that step landed on -- so it
// could park a box on the chip's own card that the slide above it had walked
// its whole line to avoid. It now carries the same own-card depth term the two
// on-line tiers carry, and three seats (script43 e:37, gas-web e:9 / e:30, 13
// to 18 deep) stepped one pitch further to a slot off the card. The deep class
// is untouched by it: none of those three saturated.
//
// RE-MEASURED at 70 after the per-chip reserved seat box (Task 6b), which
// reserves an upper bound on what each chip will DRAW (chrome + its own rate
// text + the widest localized unit, clamped by the CSS max-width) instead of the
// widest box that clamp allows -- 166 to 234 units against a flat 240 across
// this corpus. Counted by chip identity, SEVENTEEN intrusions left the counter
// and six arrived (81 - 17 + 6 = 70); the DEEP class went 21 -> 18.
// The two sixes below are DIFFERENT SETS that overlap in five. A COUNTER
// arrival is a chip that was off this counter entirely and now laps a card past
// the budget at any depth; a DEEP arrival is a chip whose depth saturates at the
// drawn box height. multi6 e:52's rise chip is a counter arrival that is not
// deep (34.7 -- past the budget, short of saturation), and battery5 e:18 is a
// deep arrival that is not a counter arrival (it was already counted at 27.7 and
// deepened to 40.0 on u:class:q:17, the same seat DOT_COVER_BASELINE's ruling
// note above trades for). The other five are both.
// Nine of the original deep saturations cleared: the eight
// Task 5 traced to "the only fully clear point on the line IS the buried one"
// (battery5 e:6, battery5-xiranite e:11, crystal e:5, multi6 e:49, script43
// e:21 / e:31 / e:32 / e:33 -- the narrower box makes a shallower point on the
// same corridor clear) plus battery5-xiranite e:19, whose within-budget graze
// candidate stopped losing on crossings. Six arrived (battery5 e:18,
// battery5-xiranite e:34, multi6 e:18 / e:41 / e:43, gas-web's copper_nugget
// fan-out share chip): chips that gained on-line candidates and settled on one
// the crossing count ranks above depth, which is the precedence ruling R11 kept.
// The twelve survivors run 166 to 234 wide; the widest of them
// (battery5-xiranite e:20, "238.36/min") is 3% off the CSS clamp and had nothing
// to gain, exactly as the box model predicts.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): rot-bottled_food_3 2 (shallow, 9.5 and 10.8 deep),
// rot-bottled_food_4 5 (10.7 to 21.7), all label chips on their own endpoint
// cards.
const CARD_INTRUSION_BASELINE: Record<string, number> = {
  default: 5,
  battery5: 3, // 4 -> 3, Task 7
  // R8 (2026-09-04), the per-chip usable-width short-leg gate: wide label
  // chips that used to collapse now stay full on straight legs, and the
  // un-collapsed arrivals lap their own endpoint cards -- battery5-xiranite
  // 7 -> 8 (e:3 "238.36/min"), multi6 22 -> 23 (e:53 "Steel x 300/min",
  // 15 deep), script43 11 -> 12 (e:2 + e:16 "150/min", 13.4 deep),
  // coupon-web 7 -> 8 (e:0 "5.56/min", 9.1 vs budget 9), rot-bottled_food_3
  // 2 -> 3 (e:9 "300/min", 17 deep). default HELD at 5 (the plan's declared
  // exposure; e:1 lapped nothing). Ratified under the R7 precedent.
  "battery5-xiranite": 7, // 8 -> 7, Task 7
  crystal: 2,
  equip4: 3,
  multi6: 23, // 23 -> 22, Task 7. 22 -> 23 at R10 (2026-09-04): a chip
  // rode its rail's further-out landing into a card band.
  tundra: 1,
  // 12 -> 11, Task 7. 11 -> 10, Task 8: one of the R8 un-collapsed-arrival
  // laps left with the branch-leg re-seating (the re-seated riser chips no
  // longer ride their trunks into the card band).
  script43: 10,
  "coupon-web": 8,
  // 8 -> 9 at the exam-surfaced R4 re-measure: the e:12 copper_nugget-rise
  // chip lands 40 units into card q:8 (ratified 2026-09-04). Back to 8 at the
  // R3 share-form reservation (2026-09-04, Task 3): a fan-out branch chip now
  // reserves the plain rate + unit, and e:12's wider reserve re-seats it off
  // q:8's body -- trading that deep lap for one foreign stroke under its box
  // (gas-web foreignStroke actual 8 -> 9, still under its pin).
  // 8 -> 7 at the Task 5 rise-seat re-measure (2026-09-04): the same
  // rise-window re-seating that emptied the seat-validity cell moved the
  // re-seated gas_xiranite rise chip off the card body it had been lapping.
  // foreignStroke on this plan held at 9 (pin 10).
  // 7 -> 8 at R9 (2026-09-04): a re-seated chip rode its rail's new anchor
  // (Task 7). 8 -> 7, Task 8: that R9 arrival left with the branch-leg
  // re-seating.
  "gas-web": 7,
  "rot-bottled_food_3": 3,
  "rot-bottled_food_4": 5,
};

// Foreign strokes: chips with at least one foreign flow's stroke through the
// box. Same waiver set as CHIP_SEGMENT_BASELINE above (shared code, not a
// re-implementation), so no seat can be foreign to one and waived by the other.
// Three things make this count differ from that table: it counts CHIPS where
// that one counts (segment, chip) pairs, it covers bus chips as well as label
// chips, and it reads at the census camera rather than at fit zoom.
// Measured 47 corpus-wide, 44 label chips and 3 bus chips (script43 1, gas-web
// 2). The shape matches CHIP_SEGMENT_BASELINE's own note -- a few full-height
// tap and surplus columns passing under many chips -- which is why the chip
// count here (gas-web 11) sits below that table's pair count (20) for the same
// plan. multi6 runs the other way, 16 here against 0 there: at its fit zoom the
// chips that collide are not drawn at all, which is the blind spot the reading
// camera exists to remove.
//
// RE-MEASURED at 48 after the drop cascade cap: multi6 16 -> 17, every other
// cell identical. The one addition is multi6 e:74's gas_inert DROP chip, and it
// is the R7 trade itself -- that chip used to clear the foreign stroke by
// cascading three pitches into empty canvas (where it counted in seat validity
// and outside-band instead); capped at one pitch it stays on its own junction
// and grazes the stroke. A stroke through the box beats a rate chip with nothing
// under it.
//
// RE-MEASURED at 39 after the per-chip reserved seat box (Task 6b), the largest
// single drop this campaign has taken on any counter. It is the mechanism
// working directly rather than a ranking change: this counter reads the DRAWN
// box, and most of its population was class C from the Task 6 enumeration --
// full-height tap and surplus columns passing under a box the seat had to
// reserve at the full clamp width. A box reserved at its own text width both
// straddles fewer columns and has more clear seats to choose from. Nine chips
// left across seven scenarios; none arrived.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): both 2, each one full-height column passing under two label
// chips.
const FOREIGN_STROKE_BASELINE: Record<string, number> = {
  // 0 -> 1 at the exam-surfaced R4 re-measure: the sewage surplus stroke e:3
  // crosses the e:2 Cuprium chip box whose port moved to the top row
  // (ratified 2026-09-04).
  default: 1,
  battery5: 2,
  "battery5-xiranite": 5,
  crystal: 0,
  equip4: 1,
  // R8 (2026-09-04): multi6 14 -> 15 (e:108 originium tap) and script43
  // 6 -> 7 (the same e:2/e:16 arrivals the card-intrusion cell names) at the
  // per-chip usable-width short-leg gate. Ratified under the R7 precedent.
  multi6: 15, // 15 -> 10, Task 7. 10 -> 15 at R10 (2026-09-04): five
  // chips' boxes take foreign strokes where their rails now run.
  tundra: 0,
  // 7 -> 6, Task 7. 6 -> 5, Task 8: the same departure the script43
  // chip-segment cell names (one stroke-under-chip event left with the
  // re-seated branch chips).
  script43: 5,
  // 1 -> 2 at R9 (2026-09-04): the other half of the e:15-under-e:8 event
  // the chip-segment cell names (Task 7 corridor run).
  "coupon-web": 2,
  // 10 -> 8, Task 7. 8 -> 7, Task 8: one tap-column-under-chip event left
  // with the re-seated branch chips (the gas-web chip-segment cell's twin).
  "gas-web": 7,
  "rot-bottled_food_3": 0, // 2 -> 0, Task 7
  "rot-bottled_food_4": 2,
};

// Outside band: bus chips whose box shares no vertical extent with the band its
// own lane runs in. The band is bound from the LANE (the owner edge's horizontal
// run inside a band strip), never from the chip box, or an escaped chip would
// pick whichever band it landed near and the escape would vanish. Horizontal
// overruns are reported in the same failure message but are NOT in this count.
// Measured 11 corpus-wide: default e:14, battery5 e:16, battery5-xiranite e:2,
// multi6 e:74 (drop) / e:94 / e:108, script43 e:24 / e:27 / e:28, gas-web
// e:20 / e:23. Every one is exactly one cascade pitch out -- a box 40 tall
// seated 48 off its lane, against a band that reserves 24 -- which is the whole
// mechanism. The separately reported x-overflows measured 6 (default 1,
// battery5 2, battery5-xiranite 2, multi6 1): a band's x-run is its trunk's own
// drop-to-rise span plus a stub, and a chip seated at either end sticks out past
// it. That is a band-width question, not a stranded chip, so it is reported and
// not ratcheted. Crystal and equip4 pin 0 because they render bus chips but NO
// band rects (counter is unjudgeable there, not clean); tundra has no bus chips
// at all.
//
// RE-MEASURED at 15 after the rise-slot clamp and the drop cascade cap
// (battery5-xiranite 1 -> 3, multi6 3 -> 4, coupon-web 0 -> 1). The counter rose
// for one reason: a clamped slot lands at its own run's far end, where that
// run's junction dot sits, so the keep-off pass (#50) lifts the chip one pitch
// and a band that reserves 24 does not cover it. The mechanism is unchanged --
// every escape is still exactly one pitch out, and the population is now purely
// rise chips: multi6 e:74, the corpus's only escaped DROP, came home when its
// cascade was capped.
//
// RE-MEASURED at 0 after BAND_Y_PAD grew to one cascade pitch plus a chip
// half-height (24 -> 72): every escape in the corpus was a chip lifted exactly
// one pitch, so the whole population is inside the tint now and the counter is a
// hard zero on all ten scenarios. It is a real floor rather than a coincidence
// of this corpus -- the seating cascade only leaves the pitch when no seat
// within it clears a placed chip, and that escape hatch fires nowhere here. A
// future escape means a chip past one pitch, which is exactly what this counter
// should surface -- with one blind spot: the test is "shares NO vertical extent
// with the band rect", so it alarms an escape off an OUTER lane, while a chip on
// an INTERIOR lane of a multi-lane band can be lifted two pitches and still land
// inside that band's rect, unregistered.
// The x-overflows measure 7 (default 1, battery5 2,
// battery5-xiranite 2, multi6 2) and did NOT move with the pad: measured before
// and after the same build, cell for cell. They are one higher than the 6 noted
// above because multi6 gained one at the rise-slot clamp, which was never
// re-measured for this counter. The pad is a y-axis change and BAND_X_MARGIN is
// untouched, so this stays a band-width question, reported and not ratcheted.
// The magnitudes across the campaign reconcile too, though they read as if they
// grew: the one recorded before the campaign (multi6 e:3, 25 past the band's
// right edge) was measured in exam-camera SCREEN px at zoom 0.75, about 33 world
// units, and multi6 also GAINED an overflow at the T3 rise-slot clamp. So the
// ~45 world units that chip overhangs today is a unit difference plus growth
// already recorded at the clamp, not a new drift. Either way the counter tracks
// the COUNT, so no magnitude moves it.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): both zero, and no x-overflows on either.
const OUTSIDE_BAND_BASELINE: Record<string, number> = {
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

};

// BAND-UNBOUND INVENTORY (#58). Bus chips the outside-band counter SKIPS
// because their edge binds to no lane band: fan-out formations, short runs,
// and band-less plans. An EXACT pin, not a ratchet, in either direction: the
// hard zeros above are only trustworthy while this set is accounted for, and a
// routing change that silently unbinds a lane chip moves it here instead of
// vanishing from the audit. Re-measure and re-pin (with the inventory from the
// failure message) whenever routing legitimately changes what forms a band.
// Measured 2026-08-30 (post #81/#83: contested tap fan-outs spread, lone-trunk
// drop chips gone): every entry is a fan-out formation chip or a short-run
// rise, except the two zeros, whose bus chips all carry an in-band lane run.
// First recordings for the two exam-surfaced scenarios (campaign-first
// measurement 2026-09-04, exam-surfaced-families Task 0, re-measurable within
// the campaign): rot-bottled_food_3 pins 4 (two Sandleaf Powder and two
// Sandleaf Seed rise chips on band-less runs; that plan renders no band rects
// at all), rot-bottled_food_4 pins 0.
const SKIPPED_BAND_INVENTORY: Record<string, number> = {
  default: 4,
  battery5: 2,
  "battery5-xiranite": 2,
  crystal: 2,
  equip4: 2,
  multi6: 13,
  tundra: 0,
  // 2 -> 3 at the exam-surfaced R4 re-measure: the copper_nugget rise chips
  // e:3/e:4/e:5 (out of q:11) bind to no lane band (ratified 2026-09-04).
  script43: 3,
  "coupon-web": 0,
  "gas-web": 3,
  "rot-bottled_food_3": 4,
  "rot-bottled_food_4": 0,
};

// TIER-1 SLIDE DRIFT, re-measured after the per-chip reserved seat box
// (Task 6b, ruling R11). Not a counter and not ratcheted -- a measurement
// recorded next to the counters it belongs with, because the audit surface
// cannot pin it (see the last paragraph).
//
// Drift is how far along its own polyline a rate chip walks from its anchor
// before it settles: the arc-length offset the on-line tiers (tier 1 and the
// graze scorer) choose in seatRateChip. Task 5's fourth concern recorded that
// nearest-first became only a TIEBREAK there -- a chip crosses the whole line to
// shave one unit of own-card depth if every nearer candidate laps deeper -- and
// the T6b audit predicted narrowing the box could make it WORSE, since a
// narrower box also makes MORE distant candidates clear. Measured rather than
// assumed. One slide step is SLIDE_STEP = 24 world units and the walk is capped
// at SLIDE_MAX_STEPS = 48 steps, so the reach is 1152 units either way.
//
// Per scenario, over the seats that took an on-line tier, "before" at the Task
// 6b parent (939a7aa) and "after" at the per-chip box, same corpus, same
// en locale:
//
//   scenario           drifted/seats before   after      max before -> after
//   default                   1/13            6/13        504 -> 504  (21 steps)
//   battery5                 11/21           14/23        960 -> 960  (40 steps)
//   battery5-xiranite        21/33           21/34        744 -> 720  (31 -> 30)
//   crystal                   2/10            2/10         72 ->  48  ( 3 ->  2)
//   equip4                    3/13            3/13        288 -> 240  (12 -> 10)
//   multi6                   48/85           55/86        792 -> 696  (33 -> 29)
//   tundra                    2/7             3/7          48 ->  48  ( 2 steps)
//   script43                 21/28           24/28       1080 -> 1032 (45 -> 43)
//   coupon-web                4/16            5/16        288 -> 288  (12 steps)
//   gas-web                  17/24           19/24       1080 -> 1032 (45 -> 43)
//   corpus                  130/250         152/254
//
// Two readings, and they point in opposite directions:
//   - the MAXIMA did not get worse anywhere. Six scenarios fell, four held, none
//     rose, and the far tail is the same edges on both sides (battery5 e:4 at 40
//     steps, script43 e:10 and gas-web e:3 at 45 -> 43). So the audit's R-d
//     prediction did not land on the distances.
//   - it did land on the COUNT. 22 more chips leave their anchor at all, and
//     every one of those additions is SHORT: bucketed by step count the corpus
//     goes 0 steps 120 -> 102, 1-2 steps 47 -> 81, 3-5 steps 39 -> 28, 6-10
//     23 -> 26, 11-20 9 -> 6, 21+ 12 -> 11. More chips move, and they move one
//     or two steps, while the long walks thin out. That is the narrower box
//     giving the dot and depth terms shallower candidates to prefer, which is
//     the mechanism the whole task rests on.
//
// So drift is MATERIAL -- 11 chips still walk 21 steps or more, up to 43 steps
// (1032 units, about five of their own box widths off the anchor) -- and it is
// PRE-EXISTING rather than anything Task 6b introduced. It is a real follow-up
// for the campaign, ranked as its own question: a distance cap on the walk would
// trade card depth back for nearness, which is a ruling, not a tuning.
//
// Why there is no baseline TABLE here. Every counter above is measured from
// DRAWN rects, and drift is a distance from the chip's ANCHOR -- the
// clear-segment anchor edgePath returns per route shape, a layout-internal point
// no DOM read recovers (the chip renders at anchor + labelDx/labelDy, and only
// the sum is visible). Pinning drift means mirroring that anchor in
// test/e2e/geometry.ts the way PORT_DRIFT mirrors the port contract, across
// every route shape -- its own task, not a comment. The numbers above were taken
// by temporarily recording the winning candidate's arc-length delta in
// seatRateChip's two on-line walks, building, and reading the record per
// scenario through tools/exam/probe.ts --eval; the instrumentation was reverted,
// and the recipe is repeatable from this note.
//
// Corpus-wide totals, one per counter. The census is a campaign-level ratchet,
// so the single number per counter is the figure the campaign moves; the
// per-scenario tables above are what a failure is diagnosed from. Asserted
// arithmetically against the tables (see the totals test) rather than summed
// over a run, so it holds even when the suite is run one scenario at a time.
// R10 (2026-09-04) moves multi6 cardIntrusion +1 and foreignStroke +5
// (cells detailed at the two tables); totals follow: 76 -> 77, 35 -> 40.
const CENSUS_TOTALS = {
  // 16 -> 6 at the Task 7 loop-return re-measure (2026-09-04): backward chip
  // anchors ride their rails' new local-band y, and five plans' stranded seats
  // re-seated onto their own lines (default 1 -> 0, battery5 1 -> 0, multi6
  // 6 -> 1, script43 3 -> 1, coupon-web 1 -> 0).
  // 6 -> 5 at the Task 8 branch-leg re-measure (multi6 1 -> 0).
  seatValidity: 5,
  // 81 -> 77 at the Task 7 loop-return re-measure (battery5 4 -> 3,
  // battery5-xiranite 8 -> 7, multi6 23 -> 22, script43 12 -> 11). gas-web
  // measured 8 against its pin 7 and is LEFT AT 7 (STOP, see the Task 7 note
  // above), so the pin sum is 77 while the measured sum is 78.
  // R9 (2026-09-04) ratifies that held cell: 77 -> 78.
  // 78 -> 76 at the Task 8 branch-leg re-measure (script43 11 -> 10,
  // gas-web 8 -> 7).
  cardIntrusion: 77,
  // 46 -> 36 at the Task 7 loop-return re-measure (multi6 15 -> 10, script43
  // 7 -> 6, gas-web 10 -> 8, rot-bottled_food_3 2 -> 0). coupon-web measured 2
  // against its pin 1 and is LEFT AT 1 (STOP), so the pin sum is 36 while the
  // measured sum is 37.
  // R9 (2026-09-04) ratifies the two held STOP cells: 77 -> 78 (gas-web
  // card intrusion, the re-seated chip on its rail's new anchor) and
  // 36 -> 37 (coupon-web foreign stroke, the e:15-under-e:8 corridor run).
  // 37 -> 35 at the Task 8 branch-leg re-measure (script43 6 -> 5,
  // gas-web 8 -> 7).
  foreignStroke: 40,
  outsideBand: 0,
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
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
      window.localStorage.setItem("aef.busLanes", "on");
    });
  });

  test("corpus totals match the per-scenario tables", () => {
    expect(sumOf(SEAT_VALIDITY_BASELINE)).toBe(CENSUS_TOTALS.seatValidity);
    expect(sumOf(CARD_INTRUSION_BASELINE)).toBe(CENSUS_TOTALS.cardIntrusion);
    expect(sumOf(FOREIGN_STROKE_BASELINE)).toBe(CENSUS_TOTALS.foreignStroke);
    expect(sumOf(OUTSIDE_BAND_BASELINE)).toBe(CENSUS_TOTALS.outsideBand);
  });

  for (const scenario of AUDIT_SCENARIOS) {
    test(scenario.id, async ({ page }) => {
      const unpinned: string[] = [];
      const hash = await scenarioHash(scenario);
      await loadCensusScenario(page, hash);

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

      // Soft throughout, like the P2 describe: one red counter must not hide the
      // other three, since the campaign moves them one fix at a time.

      const invalid = auditChipSeatValidity(chips, geom.edges);
      const seatBaseline = baselineFor(
        SEAT_VALIDITY_BASELINE,
        "SEAT_VALIDITY_BASELINE",
        scenario.id,
        unpinned,
      );
      if (seatBaseline !== null) {
        expect
          .soft(
            invalid.length,
            `${scenario.id}: ${invalid.length} chip(s) whose own line misses their box exceeds baseline ${seatBaseline} among ${chips.length} chips:\n${censusInventory(invalid)}`,
          )
          .toBeLessThanOrEqual(seatBaseline);
      }

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

      const { escapes, xOverflows, skipped } = auditBusChipsOutsideBand(
        chips,
        geom.edges,
        geom.bands as BandRect[],
      );
      const bandBaseline = baselineFor(
        OUTSIDE_BAND_BASELINE,
        "OUTSIDE_BAND_BASELINE",
        scenario.id,
        unpinned,
      );
      if (bandBaseline !== null) {
        expect
          .soft(
            escapes.length,
            `${scenario.id}: ${escapes.length} bus chip(s) outside their band exceeds baseline ${bandBaseline} among ${geom.bands.length} band(s); ${xOverflows.length} x-overflow(s) reported, not counted:\n${censusInventory(escapes)}\n${censusInventory(xOverflows)}`,
          )
          .toBeLessThanOrEqual(bandBaseline);
      }

      const skippedPin = baselineFor(
        SKIPPED_BAND_INVENTORY,
        "SKIPPED_BAND_INVENTORY",
        scenario.id,
        unpinned,
      );
      if (skippedPin !== null) {
        expect
          .soft(
            skipped.length,
            `${scenario.id}: ${skipped.length} band-unbound bus chip(s) != inventory pin ${skippedPin}:\n${censusInventory(skipped)}`,
          )
          .toBe(skippedPin);
      }

      skipUnpinnedRatchets(unpinned);
    });
  }
});

test.describe("edge reload determinism", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("aef.locale", "en");
      window.localStorage.setItem("aef.busLanes", "on");
    });
  });

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
