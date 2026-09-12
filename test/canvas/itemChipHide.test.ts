// The item phase's displaced-chip hide. A rate chip seated MORE THAN ONE
// max-scale chip pitch off its own polyline reads as an orphan naming nothing
// (the issue-#9 shape), so it is hidden instead, the way a fan-out branch chip
// with no on-line seat is: the exact rate stays on the target card's input row
// and on the edge's hover tooltip. The rule is a distance, not a tier: a seat
// at or under a pitch still draws (the #28 sidestep, a one-pitch step beside a
// coincident twin), and so does the short-leg chip ruling R15 steps off a line
// that could never have carried it.

import { describe, it, expect } from "vitest";
import type { Edge } from "@xyflow/react";

import { deconflictChipAnchors } from "../../src/canvas/chipSeating";
import { CHIP_BOX_HEIGHT, MAX_CHIP_SCALE } from "../../src/canvas/dimensions";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import type { RFAnyNode } from "../../src/canvas/layout";
import { pack } from "../../src/data/load";
import { solveForRender } from "../../src/pipeline/solveForRender";
import type { ItemTarget } from "../../src/data/targets";
import { mkEdge, productNode } from "./busRouting.testkit";

// chipSeating's CHIP_PITCH_Y, mirrored from the exported dimensions the way
// the other seating suites mirror it: the vertical separation two max-scale
// boxes need, and the threshold this hide is judged at.
const CHIP_PITCH_Y = MAX_CHIP_SCALE * CHIP_BOX_HEIGHT;

const CARD_W = 100;
const CARD_H = 60;
const TARGET_X = 700;

type SeatData = {
  labelDx?: number;
  labelDy?: number;
  itemChipHidden?: true;
  itemChipHiddenAt?: { x: number; y: number };
};

// Two product cards on one row with a single item edge between them, plus one
// foreign card straddling the corridor the edge crosses. The foreign card's
// height decides which tier seats the chip: a card taller than the ladder's
// bounded lifts leaves only the escape cascade.
const blockedCorridor = (
  blockerTop: number,
  blockerHeight: number,
): SeatData => {
  const nodes: RFAnyNode[] = [
    productNode("src", 0, 0, CARD_W, CARD_H),
    productNode("tgt", TARGET_X, 0, CARD_W, CARD_H),
    productNode("blk", 140, blockerTop, 520, blockerHeight),
  ];
  const edges = [mkEdge("e:1:src->tgt:w", "src", "tgt", "w")];
  return deconflictChipAnchors(nodes, edges)[0]!.data as SeatData;
};

describe("an item chip displaced past one chip pitch hides", () => {
  it("hides a chip the escape cascade had to place, stamping its anchor", () => {
    // The blocker spans 660 units around the corridor, deeper than any bounded
    // lift clears, so the seat comes from the chips-and-cards cascade.
    const data = blockedCorridor(-300, 660);
    expect(data.itemChipHidden).toBe(true);
    // The chip draws nothing, so it carries no offset at all...
    expect(data.labelDx).toBeUndefined();
    expect(data.labelDy).toBeUndefined();
    // ...and the stamp is the label anchor, the frame ItemEdge re-derives on
    // every render and compares the hide against.
    expect(data.itemChipHiddenAt).toEqual({ x: 400, y: CARD_H / 2 });
  });

  it("hides a chip lifted past the pitch off the same corridor", () => {
    // The same corridor behind a 180-unit blocker: one vertical lift clears it,
    // but it lands three pitches out, where the line is nowhere near the box.
    const data = blockedCorridor(-60, 180);
    expect(data.itemChipHidden).toBe(true);
    expect(data.labelDy).toBeUndefined();
  });

  it("keeps a chip stepped exactly one pitch off its line", () => {
    // The boundary, and the shape busRouting.chips.test.ts pins: two parallel
    // edges share one source and one target, so their anchors coincide exactly
    // and the second (by edge id) steps one pitch down to clear the first. A
    // pitch is the separation the seating pass is built on, so that chip still
    // reads as sitting beside its own line and draws.
    const nodes: RFAnyNode[] = [
      productNode("s", 0, 170, CARD_W, CARD_H),
      productNode("t", 300, 170, CARD_W, CARD_H),
    ];
    const edges: Edge[] = ["m:1", "m:2"].map((id) => mkEdge(id, "s", "t", "w"));
    const out = deconflictChipAnchors(nodes, edges);
    const second = out.find((e) => e.id === "m:2")!.data as SeatData;
    // Premise: the step really is exactly one pitch, the threshold's edge.
    expect(second.labelDy).toBe(CHIP_PITCH_Y);
    expect(second.itemChipHidden).toBeUndefined();
  });

  it("keeps the short-leg chip ruling R15 steps off its line", () => {
    // Three cards 36 units apart: each leg's band-clipped window is 16 units,
    // narrower than the 24-unit icon square the seat reserves, so no on-line
    // seat exists at all and R15 has these chips step off rather than hide.
    // The hide must not swallow them -- the line they label could never have
    // carried the box, so there is no on-line seat to prefer.
    const nodes: RFAnyNode[] = [0, 1, 2].map((i) =>
      productNode(`n${i}`, i * (CARD_W + 36), 0, CARD_W, CARD_H),
    );
    const edges = [0, 1].map((i) =>
      mkEdge(`e:${i}:n${i}->n${i + 1}:w`, `n${i}`, `n${i + 1}`, "w"),
    );
    for (const seated of deconflictChipAnchors(nodes, edges)) {
      const data = seated.data as SeatData & { chipIconOnly?: true };
      // Premise: these are the collapsed short-leg chips R15 ruled on.
      expect(data.chipIconOnly).toBe(true);
      expect(data.itemChipHidden).toBeUndefined();
      expect(data.labelDy).not.toBe(0);
      expect(data.labelDy).not.toBeUndefined();
    }
  });
});

describe("battery5 keeps its bounded sidestep chip", () => {
  // e:14 (Sewage) with lanes on is the twin-corridor seat ratified under closed
  // #28: a bounded 16-unit step off a corridor vertical, under the chip's own
  // painted half-width, so the line still runs inside the box. The e2e audit
  // pins it (CHIP_OFFPATH_BASELINE_ON battery5 = 1 in
  // test/e2e/geometry-audit.spec.ts), and the hide must not swallow it.
  const targets: ItemTarget[] = [
    { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "2" } },
  ];

  it("hides no item chip on the plan the sidestep was ratified on", async () => {
    const { edges } = await layoutSolved(solveForRender({ targets, pack }), {
      busLanesEnabled: true,
    });
    const sidestepped = edges.find(
      (e) => e.id === "e:14:u:class:q:5->u:class:q:9:liquid_sewage",
    );
    // Premise: the sidestep seat is still there to be judged.
    expect((sidestepped?.data as SeatData | undefined)?.labelDx).not.toBe(0);

    const hidden = edges
      .filter((e) => (e.data as SeatData).itemChipHidden === true)
      .map((e) => e.id);
    expect(hidden).toEqual([]);
  }, 60_000);
});
