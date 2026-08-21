// Fan-in markers (issue #26). Where 2+ forward same-item edges enter one target
// in-port, their final legs run collinear at the port y from a merge point to
// the port -- fan-in is otherwise structurally unmodeled. deconflictChipAnchors
// stamps ONE merge dot on the elected owner item edge, and suppresses any
// NON-OWNER member whose own rate chip would sit on the shared run. The owner is
// exempt from that hide: since the summed aggregate was removed (issue #39,
// #45), the owner's own rate chip is the only number the shared run can carry.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { routeFanoutEdges } from "../../src/canvas/busRouting";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  orderedRecipeNode,
} from "./busRouting.testkit";

type FaninData = {
  labelDx?: number;
  labelDy?: number;
  faninJunctionX?: number;
  faninJunctionY?: number;
  faninChipHidden?: boolean;
  busTotalRate?: Fraction;
  busChipOwner?: boolean;
  fanout?: boolean;
};

// chipSeating's own PORT_DRIFT.recipe.dy, mirrored here (the module does not
// export it): a recipe's drawn handle row sits one unit below the model row y,
// so every drawn port y is the model port y plus this.
const PORT_DY = 1;

// The collinearity tolerance the fan-in detection applies, mirrored from
// chipSeating's FANIN_EPS, and the two-decimal rounding every emitted path
// coordinate carries (edgePath's `r`).
const FANIN_EPS = 1;
const r2 = (n: number): number => Math.round(n * 100) / 100;

const dataOf = (edges: Edge[], id: string): FaninData =>
  (edges.find((e) => e.id === id)?.data as FaninData | undefined) ?? {};

const rateEdge = (
  id: string,
  source: string,
  target: string,
  item: string,
  rate: Fraction,
): Edge => ({ id, type: "item", source, target, data: { item, rate } });

describe("deconflictChipAnchors: fan-in markers", () => {
  it("stamps one junction dot on the owner and suppresses on-run non-owner members", () => {
    // Target recipe consuming item "s" on its single in-port.
    const tgtRecipe = mkRecipe("tgt", ["s"], []);
    const tgt = orderedRecipeNode("tgt", 1000, 100, ["s"]);
    const ty = 100 + measureRecipe(tgtRecipe).inHandleYs[0]!;
    const tx = 1000;

    // Source A (bent): its out-port y differs from the port y, so its final leg
    // bends up/down into the port and its own chip sits on the bend, off the run.
    const srcA = recipeNode("srcA", 0, 0, mkRecipe("srcA", [], ["s"]));

    // Source B (straight): place it so its out-port y equals the port y, so its
    // whole line runs at the port y and its own chip lands on the shared run.
    const srcBRecipe = mkRecipe("srcB", [], ["s"]);
    const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
    const srcB = recipeNode("srcB", 600, ty - srcBOutY0, srcBRecipe);

    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const edges: Edge[] = [
      rateEdge("e:1:srcA->tgt:s", "srcA", "tgt", "s", new Fraction(4)),
      rateEdge("e:2:srcB->tgt:s", "srcB", "tgt", "s", new Fraction(1)),
    ];

    const out = deconflictChipAnchors(nodes, edges);
    const owner = dataOf(out, "e:1:srcA->tgt:s"); // lexicographically smallest id
    const other = dataOf(out, "e:2:srcB->tgt:s");

    // The owner carries the marker, stamped on the DRAWN port row (a unit below
    // the model row y) so the dot sits on the line the member is drawn along.
    expect(owner.faninJunctionY).toBe(ty + PORT_DY);
    // The dot marks where the last member joins the shared run (rightmost join),
    // which is the straight member's drawn source-right endpoint: model right
    // edge 900 plus the recipe source port drift of 5.
    expect(owner.faninJunctionX).toBe(905);
    expect(tx).toBeGreaterThan(905); // the run the dot sits on is real

    // The non-owner carries no marker.
    expect(other.faninJunctionX).toBeUndefined();

    // The straight member's own chip is on the shared run -> suppressed; the bent
    // member's chip is on its own bend leg -> kept.
    expect(other.faninChipHidden).toBe(true);
    expect(owner.faninChipHidden).toBeUndefined();
  });

  it("detects the merge when the drawn approach carries sub-unit noise", () => {
    // Saturation guard. The detection compares the member's final leg against
    // the target port; both sides must be read in the DRAWN frame. Reading the
    // raw model port instead leaves a constant PORT_DY of slack between them,
    // which is the whole FANIN_EPS budget -- so ANY real sub-unit noise on the
    // drawn approach tips a genuine merge out of detection.
    //
    // The noise here is the one every laid-out plan carries: ELK positions cards
    // at fractional y, and the path builder rounds each emitted coordinate to
    // two decimals, so the drawn leg lands a few thousandths off the drawn port.
    // The fixture is the first one above with the target nudged onto such a y.
    const NUDGE = 0.006;
    const tgtRecipe = mkRecipe("tgt", ["s"], []);
    const tgt = orderedRecipeNode("tgt", 1000, 100 + NUDGE, ["s"]);
    const modelTy = 100 + NUDGE + measureRecipe(tgtRecipe).inHandleYs[0]!;
    const drawnTy = modelTy + PORT_DY;
    const legY = r2(drawnTy); // what the emitted path puts the final leg at

    // Premise: this leg is collinear with the port within eps in the drawn
    // frame, and outside eps in the model frame. One geometry, two verdicts --
    // which frame the comparison runs in decides whether the merge is seen.
    expect(Math.abs(legY - drawnTy)).toBeLessThan(FANIN_EPS);
    expect(Math.abs(legY - modelTy)).toBeGreaterThan(FANIN_EPS);

    const srcA = recipeNode("srcA", 0, 0, mkRecipe("srcA", [], ["s"]));
    const srcBRecipe = mkRecipe("srcB", [], ["s"]);
    const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
    const srcB = recipeNode("srcB", 600, modelTy - srcBOutY0, srcBRecipe);

    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const out = deconflictChipAnchors(nodes, [
      rateEdge("e:1:srcA->tgt:s", "srcA", "tgt", "s", new Fraction(4)),
      rateEdge("e:2:srcB->tgt:s", "srcB", "tgt", "s", new Fraction(1)),
    ]);

    // The merge is still detected: dot on the owner, at the drawn port row.
    const owner = dataOf(out, "e:1:srcA->tgt:s");
    expect(owner.faninJunctionX).toBe(905);
    expect(owner.faninJunctionY).toBeCloseTo(drawnTy, 6);
    // And the on-run test that hides the non-owner reads the same frame.
    expect(dataOf(out, "e:2:srcB->tgt:s").faninChipHidden).toBe(true);
  });

  it("keeps the owner's own chip when the owner is the member seated on the run", () => {
    // The fixture above with the ids swapped, so the STRAIGHT member -- the one
    // whose chip lands on the shared run -- is the elected owner. The shared-run
    // hide is non-owner only: with the summed aggregate gone, hiding the owner
    // too would leave the merged run carrying no number at all.
    const tgtRecipe = mkRecipe("tgt", ["s"], []);
    const tgt = orderedRecipeNode("tgt", 1000, 100, ["s"]);
    const ty = 100 + measureRecipe(tgtRecipe).inHandleYs[0]!;

    const srcA = recipeNode("srcA", 0, 0, mkRecipe("srcA", [], ["s"]));
    const srcBRecipe = mkRecipe("srcB", [], ["s"]);
    const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
    const srcB = recipeNode("srcB", 600, ty - srcBOutY0, srcBRecipe);

    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const edges: Edge[] = [
      rateEdge("e:1:srcB->tgt:s", "srcB", "tgt", "s", new Fraction(1)),
      rateEdge("e:2:srcA->tgt:s", "srcA", "tgt", "s", new Fraction(4)),
    ];

    const out = deconflictChipAnchors(nodes, edges);
    const owner = dataOf(out, "e:1:srcB->tgt:s"); // the straight member now
    expect(owner.faninJunctionX).toBe(905); // it does own the marker
    expect(owner.faninChipHidden).toBeUndefined();
  });

  it("marks no fan-in for two edges from ONE source (a parallel bundle is one flow)", () => {
    // Same (item, source) edges share one visual line; a junction dot there
    // would invent a merge that does not exist.
    const tgt = orderedRecipeNode("tgt", 1000, 100, ["s"]);
    const src = recipeNode("src", 0, 80, mkRecipe("src", [], ["s"]));
    const nodes: RFAnyNode[] = [src, tgt];
    const edges: Edge[] = [
      rateEdge("e:1:src->tgt:s", "src", "tgt", "s", new Fraction(4)),
      rateEdge("e:2:src->tgt:s", "src", "tgt", "s", new Fraction(1)),
    ];

    const out = deconflictChipAnchors(nodes, edges);
    for (const id of ["e:1:src->tgt:s", "e:2:src->tgt:s"]) {
      const d = dataOf(out, id);
      expect(d.faninJunctionX).toBeUndefined();
      expect(d.faninChipHidden).toBeUndefined();
    }
  });

  it("marks no fan-in on a mixed-feed port (an out-of-scope same-item feed enters too)", () => {
    // Two forward item edges into tgt's port PLUS a BACKWARD same-item edge into
    // the same port (enters via the gutter rail, off the shared run). A dot over
    // just the two forward members would mark a merge that is not the whole
    // merge, so the port gets no marker.
    const tgtRecipe = mkRecipe("tgt", ["s"], []);
    const tgt = orderedRecipeNode("tgt", 1000, 100, ["s"]);
    const ty = 100 + measureRecipe(tgtRecipe).inHandleYs[0]!;
    const srcA = recipeNode("srcA", 0, 0, mkRecipe("srcA", [], ["s"]));
    const srcBRecipe = mkRecipe("srcB", [], ["s"]);
    const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
    const srcB = recipeNode("srcB", 600, ty - srcBOutY0, srcBRecipe);
    // Backward feeder: sits RIGHT of the target, so its edge routes as a rail.
    const back = recipeNode("back", 1600, 100, mkRecipe("back", [], ["s"]));

    const nodes: RFAnyNode[] = [srcA, srcB, back, tgt];
    const edges: Edge[] = [
      rateEdge("e:1:srcA->tgt:s", "srcA", "tgt", "s", new Fraction(4)),
      rateEdge("e:2:srcB->tgt:s", "srcB", "tgt", "s", new Fraction(1)),
      rateEdge("e:3:back->tgt:s", "back", "tgt", "s", new Fraction(2)),
    ];

    const out = deconflictChipAnchors(nodes, edges);
    for (const e of out) {
      const d = e.data as FaninData;
      expect(d.faninJunctionX).toBeUndefined();
      expect(d.faninChipHidden).toBeUndefined();
    }
  });

  it("marks a dual-role edge once: fan-out total unchanged, fan-in dot on the item member", () => {
    // Source S fans out to two adjacent-layer targets A and B (a fan-out trunk).
    // Target A also receives an item edge from T. At A's port, the fan-out member
    // S->A and the item edge T->A form a fan-in: the merge dot goes on the item
    // member that draws it, and S's fan-out total is untouched.
    const S = recipeNode("S", 0, 100, mkRecipe("S", [], ["s"]));
    const A = orderedRecipeNode("A", 500, 0, ["s"]);
    const B = orderedRecipeNode("B", 500, 260, ["s"]);
    // T sits well below the fan-out column's y-span so it cannot block the trunk.
    const T = recipeNode("T", 100, 520, mkRecipe("T", [], ["s"]));

    const nodes: RFAnyNode[] = [S, A, B, T];
    const raw: Edge[] = [
      rateEdge("e:1:S->A:s", "S", "A", "s", new Fraction(2)),
      rateEdge("e:2:S->B:s", "S", "B", "s", new Fraction(3)),
      rateEdge("e:3:T->A:s", "T", "A", "s", new Fraction(5)),
    ];

    // Form the fan-out trunk first (retypes S->A, S->B to bus fanout members).
    const fanned = routeFanoutEdges(nodes, raw);
    const sa = dataOf(fanned, "e:1:S->A:s");
    expect(sa.fanout).toBe(true); // precondition: the fan-out actually formed
    const saFanoutTotal = sa.busTotalRate!;
    expect(saFanoutTotal.equals(new Fraction(5))).toBe(true); // 2 + 3

    const out = deconflictChipAnchors(nodes, fanned);

    // The item edge T->A owns the fan-in marker (only item member of the group).
    const owner = dataOf(out, "e:3:T->A:s");
    expect(owner.faninJunctionX).toBeGreaterThan(0);

    // The dual-role edge S->A keeps its fan-out role, uncounted twice: its
    // fan-out total is unchanged and it carries no fan-in ownership or hide.
    const saAfter = dataOf(out, "e:1:S->A:s");
    expect(saAfter.fanout).toBe(true);
    expect(saAfter.busTotalRate!.equals(new Fraction(5))).toBe(true);
    expect(saAfter.faninJunctionX).toBeUndefined();
    expect(saAfter.faninChipHidden).toBeUndefined();
  });
});
