// Fan-in markers (issue #26). Where 2+ forward same-item edges enter one target
// in-port, their final legs run collinear at the port y from a merge point to
// the port -- fan-in is otherwise structurally unmodeled. deconflictChipAnchors
// stamps ONE merge dot and ONE summed Sigma on the elected owner item edge, and
// suppresses any member whose own rate chip would sit on the shared run.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { routeFanoutEdges } from "../../src/canvas/busRouting";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
import { mkRecipe, recipeNode, orderedRecipeNode } from "./busRouting.testkit";

type FaninData = {
  faninJunctionX?: number;
  faninJunctionY?: number;
  faninSigmaX?: number;
  faninTotalRate?: Fraction;
  faninMemberCount?: number;
  faninChipHidden?: boolean;
  busTotalRate?: Fraction;
  busChipOwner?: boolean;
  fanout?: boolean;
};

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
  it("stamps one junction + summed Sigma on the owner and suppresses on-run members", () => {
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

    // The owner carries the whole marker.
    expect(owner.faninMemberCount).toBe(2);
    expect(owner.faninTotalRate).toBeInstanceOf(Fraction);
    expect(owner.faninTotalRate!.equals(new Fraction(5))).toBe(true);
    expect(owner.faninJunctionY).toBe(ty);
    // The dot marks where the last member joins the shared run (rightmost join),
    // which is the straight member's source-right edge at x = 900.
    expect(owner.faninJunctionX).toBe(900);
    // The Sigma sits on the shared run between the merge and the port.
    expect(owner.faninSigmaX!).toBeGreaterThan(900);
    expect(owner.faninSigmaX!).toBeLessThan(tx);

    // The non-owner carries no marker.
    expect(other.faninJunctionX).toBeUndefined();
    expect(other.faninSigmaX).toBeUndefined();

    // The straight member's own chip is on the shared run -> suppressed; the bent
    // member's chip is on its own bend leg -> kept.
    expect(other.faninChipHidden).toBe(true);
    expect(owner.faninChipHidden).toBeUndefined();
  });

  it("counts a dual-role edge once: fan-out total unchanged, fan-in Sigma sums own rates", () => {
    // Source S fans out to two adjacent-layer targets A and B (a fan-out trunk).
    // Target A also receives an item edge from T. At A's port, the fan-out member
    // S->A and the item edge T->A form a fan-in: the Sigma sums each by its OWN
    // rate, and S's fan-out total is untouched.
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
    expect(owner.faninMemberCount).toBe(2);
    expect(owner.faninTotalRate!.equals(new Fraction(7))).toBe(true); // 2 + 5

    // The dual-role edge S->A keeps its fan-out role, uncounted twice: its
    // fan-out total is unchanged and it carries no fan-in ownership or hide.
    const saAfter = dataOf(out, "e:1:S->A:s");
    expect(saAfter.fanout).toBe(true);
    expect(saAfter.busTotalRate!.equals(new Fraction(5))).toBe(true);
    expect(saAfter.faninJunctionX).toBeUndefined();
    expect(saAfter.faninChipHidden).toBeUndefined();
  });
});
