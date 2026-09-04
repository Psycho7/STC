// Crossing cues (exam-surfaced Task 9, unmarked-same-item-crossing). Where
// two polylines of DIFFERENT flows (item|source) properly cross, the seating
// pass stamps the crossing point on the edge of the pair that paints ABOVE
// and its renderer cuts a background-coloured gap in the z-beneath stroke
// there. The pinned behaviours:
//   (a) a genuine right-angle crossing between two same-item edges stamps the
//       exact intersection on the above edge only;
//   (b) LOAD-BEARING NEGATIVE: a fan-in pair joining collinearly at the port y
//       stamps NOTHING -- a merge is a merge, never a crossing cue;
//   (c) LOAD-BEARING NEGATIVE: two bus members sharing a lane stamp NOTHING --
//       their overlapping collinear runs and their drop/rise columns only ever
//       TOUCH (endpoints on interiors), which strict-interior crossing
//       semantics exclude by construction;
//   (d) the cue owner is picked by React Flow's paint key, not array order:
//       an edge with a container-member endpoint (its own svg sits at
//       z-index 1) paints above every top-level (z 0) edge regardless of
//       array position, and the erasing disk must ride the painter that is
//       ABOVE -- a disk on the beneath edge would erase nothing (its own
//       path repaints over it, then the above edge paints over both);
//   (e) each stamp is PARTNER-AWARE: it carries the other edge's id and the
//       partner's two endpoint node anchors as of seating, and a cue is
//       dropped at render time once the partner edge is gone or either of
//       its endpoints has moved past the shared stale eps -- a crossing is
//       only real while BOTH sides still stand where it was found, so a
//       dragged partner invalidates the cue until the next re-seat, exactly
//       as a dragged own polyline already does.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import {
  crossingPartnerBits,
  liveCrossingCues,
  type CrossingCue,
  type CrossingCuePartner,
} from "../../src/canvas/crossings";
import { HIDE_STALE_EPS } from "../../src/canvas/dimensions";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import { chamferBusPath } from "../../src/canvas/edgePath";
import { RECIPE_WIDTH } from "../../src/canvas/dimensions";
import type { RFAnyNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode, orderedRecipeNode } from "./busRouting.testkit";

// The stamped fields this suite reads: the cue list under test, plus the
// fan-in marker's x, asserted as the PREMISE of the collinear negative (the
// fixture only proves "a merge gets no cue" when the merge actually formed --
// the owner carries the dot stamp).
type CueData = {
  crossingCues?: Array<CrossingCue>;
  faninJunctionX?: number;
};

// chipSeating's own PORT_DRIFT.recipe row, mirrored here (the module does not
// export it): a recipe's drawn out-port sits 5 right of the card edge, its
// drawn in-port 3 left of it, and a resolved row one unit below the model row
// y. Same mirrors as the fan-in marker suite.
const PORT_SX = 5;
const PORT_TX = -3;
const PORT_DY = 1;

const dataOf = (edges: Edge[], id: string): CueData =>
  (edges.find((e) => e.id === id)?.data as CueData | undefined) ?? {};

const rateEdge = (
  id: string,
  source: string,
  target: string,
  item: string,
  rate: Fraction,
): Edge => ({ id, type: "item", source, target, data: { item, rate } });

describe("deconflictChipAnchors: crossing cues", () => {
  it("stamps a right-angle crossing between two same-item edges at the exact intersection, on the later edge only", () => {
    // Edge 1 (EARLIER in the array): a straight same-rail line at the drawn
    // port y. Source A1 at (0,0), target A2 at (1000,0): both first rows sit
    // at drawn y 98, so chamferStepPath takes the straight branch
    // M 305,98 L 997,98.
    const A1 = recipeNode("A1", 0, 0, mkRecipe("A1", [], ["s"]));
    const A2 = orderedRecipeNode("A2", 1000, 0, ["s"]);
    const row0 = measureRecipe(mkRecipe("x", [], ["s"])).outHandleYs[0]!;
    const railY = 0 + row0 + PORT_DY;

    // Edge 2 (LATER): B1 at (100,-160) drops a full forward step to B2 at
    // (900,200). Drawn source port (405,-62), drawn target port (897,298):
    // gap 492 hosts the full stub+chamfer shape, |dy| = 360 hosts a full
    // vertical, and the default bend column is the corridor midpoint
    // (405+897)/2 = 651. The vertical at 651 spans y -54..290, crossing
    // edge 1's rail at y 98 strictly interior to both segments.
    const B1 = recipeNode("B1", 100, -160, mkRecipe("B1", [], ["s"]));
    const B2 = orderedRecipeNode("B2", 900, 200, ["s"]);

    const nodes: RFAnyNode[] = [A1, A2, B1, B2];
    const e1 = "e:1:A1->A2:s";
    const e2 = "e:2:B1->B2:s";
    const edges: Edge[] = [
      rateEdge(e1, "A1", "A2", "s", new Fraction(4)),
      rateEdge(e2, "B1", "B2", "s", new Fraction(1)),
    ];

    const out = deconflictChipAnchors(nodes, edges);

    // Premise: a 1-row recipe's in and out handles share a row y, so with both
    // cards at y=0 edge 1's drawn ports agree and its line is the straight
    // rail at railY that edge 2's step crosses at a right angle.
    expect(measureRecipe(mkRecipe("x", ["s"], [])).inHandleYs[0]).toBe(row0);

    // The stamp lands on the edge painting ABOVE only -- here the LATER one,
    // because both edges are top-level (z 0) and array order is the tiebreak
    // -- at the exact intersection of the reconstructed polylines: bend
    // column 651 x rail y 98. The record also names the partner edge and
    // carries the partner's two endpoint node anchors as of seating, so the
    // render layer can drop the cue when the partner moves (the (e) clause).
    expect(dataOf(out, e2).crossingCues).toEqual([
      {
        x: 651,
        y: railY,
        partner: {
          edgeId: e1,
          source: { x: 0, y: 0 },
          target: { x: 1000, y: 0 },
        },
      },
    ]);
    expect(dataOf(out, e1).crossingCues).toBeUndefined();
  });

  it("stamps the partner's endpoint anchors with the crossing, so the render layer can see the other side move", () => {
    // Same right-angle fixture as the stamp test above, read for the partner
    // record alone: the cue on e2 must name e1 as its partner and record
    // e1's SOURCE and TARGET node origins (absolute, one container level
    // resolved like every seating coordinate) as of the seating pass. The
    // own-polyline stale check cannot see the partner at all: a partner
    // dragged away leaves a background-coloured disk cutting a gap where
    // nothing crosses anymore, so the stamp is where the other side's
    // identity has to survive.
    const A1 = recipeNode("A1", 0, 0, mkRecipe("A1", [], ["s"]));
    const A2 = orderedRecipeNode("A2", 1000, 0, ["s"]);
    const B1 = recipeNode("B1", 100, -160, mkRecipe("B1", [], ["s"]));
    const B2 = orderedRecipeNode("B2", 900, 200, ["s"]);
    const e1 = "e:1:A1->A2:s";
    const e2 = "e:2:B1->B2:s";
    const out = deconflictChipAnchors(
      [A1, A2, B1, B2],
      [
        rateEdge(e1, "A1", "A2", "s", new Fraction(4)),
        rateEdge(e2, "B1", "B2", "s", new Fraction(1)),
      ],
    );

    const cue = dataOf(out, e2).crossingCues?.[0];
    expect(cue).toBeDefined();
    expect(cue!.partner).toEqual({
      edgeId: e1,
      source: { x: 0, y: 0 },
      target: { x: 1000, y: 0 },
    });
  });

  it("stamps the container-member edge painting above, even when it is EARLIER in the array", () => {
    // React Flow gives every edge its own <svg style={{zIndex}}>: an edge
    // with a container-member endpoint sits at z 1 (elevated above the
    // container box) and a top-level edge at z 0, and CSS z-index beats DOM
    // (array) order -- array order is only the tiebreak. So the container
    // member paints ABOVE even when it comes FIRST in the edges array, and
    // the cue -- the erasing disk -- must land on IT: only the above
    // painter's group can erase the beneath stroke around the crossing (a
    // disk on the beneath edge would sit under the above edge's continuous
    // stroke and erase nothing). An array-order owner rule stamps the wrong
    // edge here; that is exactly what this test pins.
    // Same geometry as the right-angle fixture above, except A2 (the
    // straight rail's target) lives INSIDE a container G sitting at
    // (950,-50): A2's relative position (50,50) resolves to the same
    // absolute (1000,0), so the rail and the crossing point are unchanged.
    const A1 = recipeNode("A1", 0, 0, mkRecipe("A1", [], ["s"]));
    const G = {
      id: "G",
      type: "group",
      position: { x: 950, y: -50 },
      width: 200,
      height: 150,
      data: { containerKind: "blueprint-group", containerId: "G", memberCount: 1 },
    } as unknown as RFAnyNode;
    const A2 = {
      ...orderedRecipeNode("A2", 50, 50, ["s"]),
      parentId: "G",
    } as RFAnyNode;
    const row0 = measureRecipe(mkRecipe("x", [], ["s"])).outHandleYs[0]!;
    const railY = 0 + row0 + PORT_DY;
    const B1 = recipeNode("B1", 100, -160, mkRecipe("B1", [], ["s"]));
    const B2 = orderedRecipeNode("B2", 900, 200, ["s"]);

    const e1 = "e:1:A1->A2:s"; // EARLIER in the array, z 1 (container member)
    const e2 = "e:2:B1->B2:s"; // later, z 0 (both endpoints top-level)
    const out = deconflictChipAnchors([A1, G, A2, B1, B2], [
      rateEdge(e1, "A1", "A2", "s", new Fraction(4)),
      rateEdge(e2, "B1", "B2", "s", new Fraction(1)),
    ]);

    // The cue lands on the z-1 edge -- the EARLIER array entry -- at the same
    // exact intersection, naming the top-level edge as its partner, and the
    // top-level edge itself carries nothing.
    expect(dataOf(out, e1).crossingCues).toEqual([
      {
        x: 651,
        y: railY,
        partner: {
          edgeId: e2,
          source: { x: 100, y: -160 },
          target: { x: 900, y: 200 },
        },
      },
    ]);
    expect(dataOf(out, e2).crossingCues).toBeUndefined();
  });

  it("stamps nothing for a fan-in pair joining collinearly at the port y", () => {
    // The fan-in fixture from the marker suite: srcA bends into the port, srcB
    // runs straight at the port y, and the two final legs overlap collinearly
    // on the shared run -- the geometry a merge dot MARKS, and exactly the
    // geometry a crossing cue must not touch (a cued merge would deny the
    // merge).
    const tgtRecipe = mkRecipe("tgt", ["s"], []);
    const tgt = orderedRecipeNode("tgt", 1000, 100, ["s"]);
    const ty = 100 + measureRecipe(tgtRecipe).inHandleYs[0]!;
    const srcA = recipeNode("srcA", 0, 0, mkRecipe("srcA", [], ["s"]));
    const srcBRecipe = mkRecipe("srcB", [], ["s"]);
    const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
    const srcB = recipeNode("srcB", 600, ty - srcBOutY0, srcBRecipe);

    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const eA = "e:1:srcA->tgt:s";
    const eB = "e:2:srcB->tgt:s";
    const out = deconflictChipAnchors(nodes, [
      rateEdge(eA, "srcA", "tgt", "s", new Fraction(4)),
      rateEdge(eB, "srcB", "tgt", "s", new Fraction(1)),
    ]);

    // Premise: the fan-in actually formed here -- the owner carries the merge
    // dot stamp, so the negative below is about a REAL join, not a fixture
    // that secretly has no merge at all.
    const owner = dataOf(out, eA);
    expect(owner.faninJunctionX).toBe(905);

    // The load-bearing negative: no cue anywhere in the group.
    for (const e of out) {
      expect((e.data as CueData).crossingCues).toBeUndefined();
    }
  });

  it("stamps nothing for two bus members sharing a lane (overlapping collinear runs)", () => {
    // Two SINGLE-member lane trunks of DIFFERENT items whose members share one
    // laneY, so the flowKey skip cannot be what saves the fixture: the runs
    // overlap collinearly and every drop/rise column only ever touches the
    // other member's run at its own laneY endpoint. Strict-interior semantics
    // must be what keeps the stamps empty.
    const laneY = 200;
    const row0 = measureRecipe(mkRecipe("x", [], ["iron"])).outHandleYs[0]!;
    // Drawn ports: source (x + RECIPE_WIDTH + 5, y + row0 + 1), target
    // (x - 3, y + row0 + 1). All four cards sit on the same rows so the
    // members share the corridor.
    const A = recipeNode("A", 0, 0, mkRecipe("A", [], ["iron"]));
    const T1 = orderedRecipeNode("T1", 1000, 0, ["iron"]);
    const B = recipeNode("B", 200, 0, mkRecipe("B", [], ["copper"]));
    const T2 = orderedRecipeNode("T2", 1200, 0, ["copper"]);

    const busEdge = (
      id: string,
      source: string,
      target: string,
      item: string,
    ): Edge => ({
      id,
      type: "bus",
      source,
      target,
      data: { item, rate: new Fraction(1), laneY, trunkKey: item + "|" + source },
    });
    const e1 = "e:1:A->T1:iron";
    const e2 = "e:2:B->T2:copper";
    const out = deconflictChipAnchors([A, T1, B, T2], [
      busEdge(e1, "A", "T1", "iron"),
      busEdge(e2, "B", "T2", "copper"),
    ]);

    // Premise: the two reconstructed lane runs really do overlap. Rebuilt
    // with the same builder and the same drawn ports the reconstruction uses.
    const sy = 0 + row0 + PORT_DY;
    const m1 = chamferBusPath({
      sourceX: 0 + RECIPE_WIDTH + PORT_SX,
      sourceY: sy,
      targetX: 1000 + PORT_TX,
      targetY: sy,
      laneY,
    });
    const m2 = chamferBusPath({
      sourceX: 200 + RECIPE_WIDTH + PORT_SX,
      sourceY: sy,
      targetX: 1200 + PORT_TX,
      targetY: sy,
      laneY,
    });
    // Member 2 drops inside member 1's run and member 1 rises inside member
    // 2's run: both lane runs overlap, by hundreds of units.
    expect(m2.dropX).toBeGreaterThan(m1.dropX);
    expect(m2.dropX).toBeLessThan(m1.riseX);
    expect(m1.riseX).toBeGreaterThan(m2.dropX);
    expect(m1.riseX).toBeLessThan(m2.riseX);

    // The load-bearing negative: no cue on either member.
    expect(dataOf(out, e1).crossingCues).toBeUndefined();
    expect(dataOf(out, e2).crossingCues).toBeUndefined();
  });

  it("drops a cue whose partner's endpoints moved beyond the eps; an unmoved partner keeps it", () => {
    // The render-side half of the (e) clause, driven through the same pure
    // pieces the edge components use: crossingPartnerBits reads the store
    // lookups (one bit per cue: does the partner edge still exist with both
    // endpoints within the stale eps of the stamped anchors), and
    // liveCrossingCues folds those bits into the existing own-polyline
    // filter. A cue whose own stamp sits on its edge's line survives ONLY
    // while the partner still stands where the crossing was found.
    const partner: CrossingCuePartner = {
      edgeId: "e:1:A1->A2:s",
      source: { x: 0, y: 0 },
      target: { x: 1000, y: 0 },
    };
    const cue: CrossingCue = { x: 10, y: 10, partner };
    const ownPts: Array<readonly [number, number]> = [
      [0, 0],
      [10, 10],
      [20, 20],
    ];
    // The minimal store shape crossingPartnerBits reads: the edge lookup by
    // id and the node lookup's absolute positions -- exactly the two maps
    // React Flow's store exposes.
    const stateOf = (
      edges: Array<{ id: string; source: string; target: string }>,
      nodes: Array<{ id: string; x: number; y: number }>,
    ) => ({
      edgeLookup: new Map(edges.map((e) => [e.id, e])),
      nodeLookup: new Map(
        nodes.map((n) => [
          n.id,
          { internals: { positionAbsolute: { x: n.x, y: n.y } } },
        ]),
      ),
    });
    const partnerEdge = { id: partner.edgeId, source: "A1", target: "A2" };
    const stillNodes = [
      { id: "A1", x: 0, y: 0 },
      { id: "A2", x: 1000, y: 0 },
    ];

    // Unmoved partner: the bit is live and the cue survives both filters.
    const still = crossingPartnerBits(
      [cue],
      stateOf([partnerEdge], stillNodes),
    );
    expect(still).toEqual([true]);
    expect(
      liveCrossingCues([cue], ownPts, (_, i) => still[i] === true),
    ).toEqual([{ x: 10, y: 10 }]);

    // Partner's SOURCE dragged past the eps: the crossing it formed is gone
    // from that side, so the cue must drop even though its own stamp still
    // sits on its own polyline.
    const movedState = stateOf(
      [partnerEdge],
      [
        { id: "A1", x: 0 + HIDE_STALE_EPS + 5, y: 0 },
        { id: "A2", x: 1000, y: 0 },
      ],
    );
    const moved = crossingPartnerBits([cue], movedState);
    expect(moved).toEqual([false]);
    expect(
      liveCrossingCues([cue], ownPts, (_, i) => moved[i] === true),
    ).toEqual([]);

    // Partner edge deleted entirely: nothing crosses there anymore.
    expect(crossingPartnerBits([cue], stateOf([], stillNodes))).toEqual([
      false,
    ]);

    // A cue WITHOUT a partner record (a hand-built stamp) keeps the
    // own-polyline rule alone: the bits treat absent partner info as live
    // rather than dropping a cue they cannot judge.
    expect(crossingPartnerBits([{ x: 10, y: 10 }], stateOf([], []))).toEqual([
      true,
    ]);
  });
});
