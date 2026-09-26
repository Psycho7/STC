// contentBounds: the rect Canvas hands to fitBounds. It must frame the node
// cards AND every drawn chip box, without inflating the frame beyond them --
// an over-wide rect depresses the fit zoom (issue #16), an under-wide one clips
// a chip at the viewport rim. These tests pin both directions: the rect equals
// the exact union of the cards with each chip's box at its RULE anchor.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";

import { contentBounds } from "../../src/canvas/chipSeating";
import {
  chamferFanoutPath,
  chamferStepPath,
  routingHintsFromData,
} from "../../src/canvas/edgePath";
import {
  aggregateChipText,
  branchChipText,
  chipSeatHalfW,
  rateChipText,
  CHIP_HALF_H,
} from "../../src/canvas/chipMetrics";
import {
  absoluteLeft,
  absoluteTop,
  nodeHeight,
  nodeWidth,
} from "../../src/canvas/nodeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
import { mkRecipe, productNode, recipeNode } from "./busRouting.testkit";
import { pack } from "../../src/data/load";
import type { Plan } from "../../src/data/plan";
import { solveFromPlan } from "../../src/pipeline/solveForRender";
import { layoutSolved } from "../../src/canvas/layoutSolved";

// Two product cards a corridor apart: 148 x 78 at x = 0 and x = 600, so the
// node box spans (0, 0) - (748, 78) and a forward step path runs between them.
const NODE_W = 148;
const NODE_H = 78;
const left = productNode("a", 0, 0, NODE_W, NODE_H);
const right = productNode("b", 600, 0, NODE_W, NODE_H);
const NODES: RFAnyNode[] = [left, right];
// Product nodes resolve no per-item port, so both ports sit at the card's
// vertical centre (portOffsetY's fallback).
const SX = NODE_W;
const SY = NODE_H / 2;
const TX = 600;
const TY = NODE_H / 2;
const PORTS = { sourceX: SX, sourceY: SY, targetX: TX, targetY: TY };

// The union of the node box with one chip box.
const framing = (
  cx: number,
  cy: number,
  halfW: number,
): { x: number; y: number; width: number; height: number } => {
  const l = Math.min(0, cx - halfW);
  const r = Math.max(TX + NODE_W, cx + halfW);
  const t = Math.min(0, cy - CHIP_HALF_H);
  const b = Math.max(NODE_H, cy + CHIP_HALF_H);
  return { x: l, y: t, width: r - l, height: b - t };
};

describe("contentBounds: chip extents", () => {
  it("frames the chip box its text draws, at its rule anchor", () => {
    // A rate chip on a straight corridor: the anchor is the centre of the one
    // horizontal run, and the framed box is the box THIS chip draws -- not the
    // widest box a chip may ever take, which would inflate the frame.
    const data = { item: "ore", rate: new Fraction(1) };
    const edges: Edge[] = [
      { id: "e1", type: "item", source: "a", target: "b", data },
    ];
    const [, lx, ly] = chamferStepPath({
      ...PORTS,
      ...routingHintsFromData(data),
    });
    const halfW = chipSeatHalfW(rateChipText(edges[0]!), false);

    expect(contentBounds(NODES, edges)).toEqual(framing(lx, ly, halfW));
  });

  it("frames a chip that stands outside the cards", () => {
    // The same edge with its target card dragged far below and an early bend
    // column, which makes the run INTO that card the longest horizontal: the
    // chip rides it, well under the node box, and the frame has to grow down to
    // it or the chip clips at the viewport rim.
    const data = { item: "ore", rate: new Fraction(1), bendX: 200 };
    const edges: Edge[] = [
      { id: "e1", type: "item", source: "a", target: "b", data },
    ];
    const low = productNode("b", 600, 900, NODE_W, NODE_H);
    const nodes: RFAnyNode[] = [left, low];
    const [, lx, ly] = chamferStepPath({
      ...PORTS,
      targetY: 900 + NODE_H / 2,
      ...routingHintsFromData(data),
    });
    const halfW = chipSeatHalfW(rateChipText(edges[0]!), false);
    const bounds = contentBounds(nodes, edges)!;

    expect(ly).toBe(900 + NODE_H / 2);
    expect(bounds.y + bounds.height).toBe(
      Math.max(900 + NODE_H, ly + CHIP_HALF_H),
    );
    expect(bounds.x).toBe(Math.min(0, lx - halfW));
  });

  it("frames both chips of a trunk owner and one of a plain member", () => {
    const base = {
      item: "ore",
      rate: new Fraction(1),
      fanout: true,
      busTotalRate: new Fraction(3),
      busMemberCount: 3,
      junctionX: 400,
    };
    const edgeWith = (owner: boolean): Edge => ({
      id: "e1",
      type: "bus",
      source: "a",
      target: "b",
      data: { ...base, busChipOwner: owner },
    });
    const fan = chamferFanoutPath({
      ...PORTS,
      ...routingHintsFromData(base),
      aggHalfW: chipSeatHalfW(aggregateChipText(edgeWith(true)), false),
      memberHalfW: chipSeatHalfW(branchChipText(edgeWith(true)), false),
    });
    const memberHalfW = chipSeatHalfW(branchChipText(edgeWith(true)), false);
    const aggHalfW = chipSeatHalfW(aggregateChipText(edgeWith(true)), false);

    // The member chip alone on a non-owner.
    expect(contentBounds(NODES, [edgeWith(false)])).toEqual(
      framing(fan.branchAnchor.x, fan.branchAnchor.y, memberHalfW),
    );
    // The owner adds the aggregate box on the trunk run.
    const owned = contentBounds(NODES, [edgeWith(true)])!;
    const agg = framing(fan.trunkAnchor.x, fan.trunkAnchor.y, aggHalfW);
    expect(owned.x).toBe(Math.min(agg.x, fan.branchAnchor.x - memberHalfW));
  });
});

describe("contentBounds: card extents", () => {
  it("frames a recipe card at the extreme by its drawn box", () => {
    // A recipe card is the right-most and bottom-most node. Its drawn border
    // box is 2 wider and 2 taller than the model size, and the frame must reach
    // that drawn edge or the card's border clips at the viewport rim.
    const card = recipeNode("r", 600, 300, mkRecipe("r", ["ore"], ["plate"]));
    const bounds = contentBounds([left, card], [])!;

    expect(bounds.x).toBe(0);
    expect(bounds.y).toBe(0);
    expect(bounds.x + bounds.width).toBe(600 + nodeWidth(card) + 2);
    expect(bounds.y + bounds.height).toBe(300 + nodeHeight(card) + 2);
  });
});

describe("contentBounds: dense plan", () => {
  it("stays close to the node box on the battery5 plan", async () => {
    const plan: Plan = {
      version: 1,
      pack: {
        id: pack.source.name,
        schemaVersion: pack.schemaVersion,
        submoduleSha: pack.source.sourceCommit,
      },
      title: "battery5",
      targets: [
        { itemId: "proc_battery_5", ratePerSec: { num: "1", denom: "2" } },
      ],
    };
    const laid = await layoutSolved(solveFromPlan(plan, pack));

    let nl = Infinity;
    let nt = Infinity;
    let nr = -Infinity;
    let nb = -Infinity;
    for (const n of laid.nodes) {
      const x = absoluteLeft(n);
      const y = absoluteTop(n);
      nl = Math.min(nl, x);
      nt = Math.min(nt, y);
      nr = Math.max(nr, x + nodeWidth(n));
      nb = Math.max(nb, y + nodeHeight(n));
    }

    const bounds = contentBounds(laid.nodes, laid.edges)!;
    // Lane bands legitimately extend the content box past the cards, so this is
    // a bound on the overshoot, not equality. The global-max pad returned
    // 2.50x the node height and 1.30x its width here.
    expect(bounds.height).toBeLessThan(1.5 * (nb - nt));
    expect(bounds.width).toBeLessThan(1.2 * (nr - nl));
  }, 120000);
});
