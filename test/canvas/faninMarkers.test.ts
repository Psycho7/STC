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
import { formatRatePerMin } from "../../src/data/rate-format";
import type { RFAnyNode } from "../../src/canvas/layout";
import {
  mkRecipe,
  recipeNode,
  orderedRecipeNode,
  productNode,
} from "./busRouting.testkit";

type FaninData = {
  labelDx?: number;
  labelDy?: number;
  faninSigmaDx?: number;
  faninSigmaDy?: number;
  faninJunctionX?: number;
  faninJunctionY?: number;
  faninSigmaX?: number;
  faninTotalRate?: Fraction;
  faninDisplayTotalRate?: Fraction;
  faninMemberCount?: number;
  faninChipHidden?: boolean;
  busTotalRate?: Fraction;
  busChipOwner?: boolean;
  fanout?: boolean;
};

const dataOf = (edges: Edge[], id: string): FaninData =>
  (edges.find((e) => e.id === id)?.data as FaninData | undefined) ?? {};

// chipSeating's own MAX_CHIP_SCALE * CHIP_BOX_WIDTH / 2, the half-box the Sigma
// keeps clear of the merge dot. Mirrored here (the module does not export it).
const CHIP_HALF_W_WIDE = 120;

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
    // Anchored beside the junction (mergeX + keepoff), not mid-run, so the
    // total visually binds to the merge dot it summarizes. This run is short
    // enough that the keepoff is half of it; see the long-run case below for
    // the seat that tells the two anchors apart.
    const runLen = tx - 900;
    const keepoff = Math.min(CHIP_HALF_W_WIDE, runLen / 2);
    expect(owner.faninSigmaX).toBe(900 + keepoff);

    // The non-owner carries no marker.
    expect(other.faninJunctionX).toBeUndefined();
    expect(other.faninSigmaX).toBeUndefined();

    // The straight member's own chip is on the shared run -> suppressed; the bent
    // member's chip is on its own bend leg -> kept.
    expect(other.faninChipHidden).toBe(true);
    expect(owner.faninChipHidden).toBeUndefined();
  });

  it("seats the Sigma beside the merge dot on a long shared run, not mid-run", () => {
    // Same shape as above but with the straight member far enough left that the
    // shared run exceeds two chip half-boxes, so the keepoff seat (mergeX + 120)
    // and the old run-midpoint seat are distinguishable.
    const tgtRecipe = mkRecipe("tgt", ["s"], []);
    const tgt = orderedRecipeNode("tgt", 1000, 100, ["s"]);
    const ty = 100 + measureRecipe(tgtRecipe).inHandleYs[0]!;
    const tx = 1000;

    const srcA = recipeNode("srcA", 0, 0, mkRecipe("srcA", [], ["s"]));
    const srcBRecipe = mkRecipe("srcB", [], ["s"]);
    const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
    const srcB = recipeNode("srcB", 200, ty - srcBOutY0, srcBRecipe);

    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const edges: Edge[] = [
      rateEdge("e:1:srcA->tgt:s", "srcA", "tgt", "s", new Fraction(4)),
      rateEdge("e:2:srcB->tgt:s", "srcB", "tgt", "s", new Fraction(1)),
    ];

    const out = deconflictChipAnchors(nodes, edges);
    const owner = dataOf(out, "e:1:srcA->tgt:s");
    const mergeX = owner.faninJunctionX!;
    const runLen = tx - mergeX;
    expect(runLen).toBeGreaterThan(2 * CHIP_HALF_W_WIDE); // the seats differ
    expect(owner.faninSigmaX).toBe(mergeX + CHIP_HALF_W_WIDE);
  });

  it("slides the Sigma down-run when a chip already holds the junction side", () => {
    // The keepoff anchor is only where the Sigma STARTS. seatRateChip's slide
    // runs along the shared run, and the run it is given begins AT the anchor,
    // so the only direction it can move is away from the dot -- which it does
    // whenever a chip is already seated beside the junction (chip-vs-chip is
    // hard). That is the common case on a real plan, where a member's own rate
    // chip seats on its pre-merge leg right beside the dot; here a foreign
    // edge's chip plays that neighbour, seated at its own straight-line anchor
    // (988, ty - 37) between two product cards, so the crowding is one known box.
    //
    // The pair below is the same fixture with and without that neighbour: the
    // seat is recomputed from the anchor every layout, so it returns to the dot
    // the moment the neighbour is gone -- nothing about the slide is sticky.
    const NEIGHBOUR_X = 988;
    const build = (crowded: boolean): Edge[] => {
      const tgtRecipe = mkRecipe("tgt", ["s"], []);
      const tgt = orderedRecipeNode("tgt", 1400, 100, ["s"]);
      const ty = 100 + measureRecipe(tgtRecipe).inHandleYs[0]!;
      const srcA = recipeNode("srcA", 0, 0, mkRecipe("srcA", [], ["s"]));
      const srcBRecipe = mkRecipe("srcB", [], ["s"]);
      const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
      const srcB = recipeNode("srcB", 200, ty - srcBOutY0, srcBRecipe);
      const nodes: RFAnyNode[] = [srcA, srcB, tgt];
      const edges: Edge[] = [
        rateEdge("e:1:srcA->tgt:s", "srcA", "tgt", "s", new Fraction(4)),
        rateEdge("e:2:srcB->tgt:s", "srcB", "tgt", "s", new Fraction(1)),
      ];
      if (crowded) {
        // Ports at ty - 37 (inside a chip half-height of the run, so the boxes
        // collide) and right/left edges at 888 / 1088, so the straight line's
        // chip anchor is their midpoint, NEIGHBOUR_X.
        nodes.push(
          productNode("fs", 788, ty - 67, 100, 60),
          productNode("ft", 1088, ty - 67, 100, 60),
        );
        edges.push(rateEdge("e:0:fs->ft:w", "fs", "ft", "w", new Fraction(3)));
      }
      return deconflictChipAnchors(nodes, edges);
    };

    const clear = build(false);
    const clearOwner = dataOf(clear, "e:1:srcA->tgt:s");
    // Uncrowded: the Sigma rests on its keepoff anchor, beside the dot.
    expect(clearOwner.faninSigmaX).toBe(clearOwner.faninJunctionX! + CHIP_HALF_W_WIDE);
    expect(clearOwner.faninSigmaDx).toBeUndefined();
    expect(clearOwner.faninSigmaDy).toBeUndefined();

    const crowded = build(true);
    const owner = dataOf(crowded, "e:1:srcA->tgt:s");
    // The neighbour held its own anchor, so it is the box the Sigma had to clear.
    const neighbour = dataOf(crowded, "e:0:fs->ft:w");
    expect(neighbour.labelDx).toBeUndefined();
    expect(neighbour.labelDy).toBeUndefined();
    // The Sigma is pushed down-run, and only down-run: it stays on the shared
    // run (no vertical lift) and clears the neighbour by the full wide-chip
    // separation, so it ends up a chip-box away from the dot it summarizes.
    expect(owner.faninSigmaX).toBe(owner.faninJunctionX! + CHIP_HALF_W_WIDE);
    expect(owner.faninSigmaDx!).toBeGreaterThan(0);
    expect(owner.faninSigmaDy).toBeUndefined();
    expect(owner.faninSigmaX! + owner.faninSigmaDx!).toBeGreaterThanOrEqual(
      NEIGHBOUR_X + 2 * CHIP_HALF_W_WIDE,
    );
  });

  it("sums the members' DISPLAYED rates into the aggregate, keeping the exact total", () => {
    // 4.256/min and 2.856/min each round UP on their own chips (4.26 + 2.86 =
    // 7.12), while the exact sum 7.112/min rounds DOWN to 7.11. The aggregate
    // shows the sum of the visible member chips; the exact total stays for the
    // hover tooltip.
    const tgtRecipe = mkRecipe("tgt", ["s"], []);
    const tgt = orderedRecipeNode("tgt", 1000, 100, ["s"]);
    const ty = 100 + measureRecipe(tgtRecipe).inHandleYs[0]!;

    const srcA = recipeNode("srcA", 0, 0, mkRecipe("srcA", [], ["s"]));
    const srcBRecipe = mkRecipe("srcB", [], ["s"]);
    const srcBOutY0 = measureRecipe(srcBRecipe).outHandleYs[0]!;
    const srcB = recipeNode("srcB", 600, ty - srcBOutY0, srcBRecipe);

    const nodes: RFAnyNode[] = [srcA, srcB, tgt];
    const edges: Edge[] = [
      rateEdge(
        "e:1:srcA->tgt:s",
        "srcA",
        "tgt",
        "s",
        new Fraction("4.256").div(60),
      ),
      rateEdge(
        "e:2:srcB->tgt:s",
        "srcB",
        "tgt",
        "s",
        new Fraction("2.856").div(60),
      ),
    ];

    const out = deconflictChipAnchors(nodes, edges);
    const owner = dataOf(out, "e:1:srcA->tgt:s");
    expect(formatRatePerMin(owner.faninDisplayTotalRate!)).toBe("7.12");
    expect(owner.faninTotalRate!.equals(new Fraction("7.112").div(60))).toBe(
      true,
    );
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
      expect(d.faninTotalRate).toBeUndefined();
      expect(d.faninChipHidden).toBeUndefined();
    }
  });

  it("marks no fan-in on a mixed-feed port (an out-of-scope same-item feed enters too)", () => {
    // Two forward item edges into tgt's port PLUS a BACKWARD same-item edge into
    // the same port (enters via the gutter rail, off the shared run). A Sigma
    // over just the two forward members would understate the card's input row,
    // so the whole port gets no marker.
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
      expect(d.faninTotalRate).toBeUndefined();
      expect(d.faninChipHidden).toBeUndefined();
    }
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
