// contentBounds: the rect Canvas hands to fitBounds. It must frame the node
// cards AND every drawn chip box, without inflating the frame beyond them --
// an over-wide rect depresses the fit zoom (issue #16), an under-wide one clips
// a chip at the viewport rim. These tests pin both directions: the rect equals
// the exact union of the cards with each chip's reconstructed seated box.

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
  CHIP_BOX_HEIGHT,
  CHIP_BOX_WIDTH,
  HIDE_STALE_EPS,
  MAX_CHIP_SCALE,
} from "../../src/canvas/dimensions";
import {
  absoluteLeft,
  absoluteTop,
  nodeHeight,
  nodeWidth,
} from "../../src/canvas/nodeGeometry";
import type { RFAnyNode } from "../../src/canvas/layout";
import { productNode } from "./busRouting.testkit";
import { pack } from "../../src/data/load";
import type { Plan } from "../../src/data/plan";
import { planToSolverArgs } from "../../src/solver/planToSolverArgs";
import { solvePlanWithIntermediates } from "../../src/solver";
import { renderPlanFromSolve } from "../../src/pipeline/driver";
import { layoutRenderPlan } from "../../src/canvas/layout";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";

const CHIP_HALF_W = (MAX_CHIP_SCALE * CHIP_BOX_WIDTH) / 2;
const CHIP_HALF_H = (MAX_CHIP_SCALE * CHIP_BOX_HEIGHT) / 2;

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

describe("contentBounds: chip extents", () => {
  it("frames the real seated chip box, not a global-max pad", () => {
    // One item edge whose chip cascaded 900 units DOWN from its anchor. The
    // frame must grow downward by that chip's box and nowhere else: the old
    // global-max pad grew all four sides by 900, costing ~2.5x of fit zoom.
    const data = { item: "ore", rate: new Fraction(1), labelDy: 900 };
    const edges: Edge[] = [
      { id: "e1", type: "item", source: "a", target: "b", data },
    ];
    const [, lx, ly] = chamferStepPath({
      sourceX: SX,
      sourceY: SY,
      targetX: TX,
      targetY: TY,
      ...routingHintsFromData(data),
    });
    const chipTop = ly + 900 - CHIP_HALF_H;
    const chipBottom = ly + 900 + CHIP_HALF_H;
    const boxLeft = Math.min(0, lx - CHIP_HALF_W);
    const boxRight = Math.max(TX + NODE_W, lx + CHIP_HALF_W);
    const boxTop = Math.min(0, chipTop);
    const boxBottom = Math.max(NODE_H, chipBottom);

    expect(contentBounds(NODES, edges)).toEqual({
      x: boxLeft,
      y: boxTop,
      width: boxRight - boxLeft,
      height: boxBottom - boxTop,
    });
  });

  it("contains a bus chip parked outside the node box", () => {
    // A lane rise chip whose slot sits 1000 units right of the rightmost card.
    // Its x was never unioned before (only the lane y was), so the chip fell
    // outside the fitted rect entirely.
    const busChipX = 748 + 1000;
    const data = {
      item: "ore",
      rate: new Fraction(1),
      laneY: 400,
      busChipX,
      busChipOwner: false,
    };
    const edges: Edge[] = [
      { id: "e1", type: "bus", source: "a", target: "b", data },
    ];

    const bounds = contentBounds(NODES, edges)!;
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(
      busChipX + CHIP_HALF_W,
    );
  });
});

// The two stamped hides (a fan-in member's rate chip, a fan-out member's branch
// chip) are decided at a stamped anchor and never recomputed on drag, so both
// renderers drop a hide whose stamp has drifted past HIDE_STALE_EPS from the
// live anchor and draw the chip again. The fit rect has to agree with them:
// framing a chip the canvas hides depresses the fit zoom for nothing, and
// skipping one it draws clips that chip at the viewport rim.
describe("contentBounds: stale hides frame the chip again", () => {
  // The bare node box, the rect when no chip reaches outside the cards.
  const NODE_BOX = {
    x: 0,
    y: 0,
    width: TX + NODE_W,
    height: NODE_H,
  };

  const faninEdges = (hiddenAtY: number): Edge[] => {
    const data = {
      item: "ore",
      rate: new Fraction(1),
      labelDy: 900,
      faninChipHidden: true,
      faninChipHiddenAtY: hiddenAtY,
    };
    return [{ id: "e1", type: "item", source: "a", target: "b", data }];
  };

  it("skips a fan-in member chip whose stamp still matches the live port", () => {
    // Stamp == the live target port y: the hide holds, ItemEdge draws no chip,
    // so the 900-unit cascade below the cards frames nothing.
    expect(contentBounds(NODES, faninEdges(TY))).toEqual(NODE_BOX);
  });

  it("frames a fan-in member chip whose stamp has drifted off the live port", () => {
    // A drag moved the port exactly HIDE_STALE_EPS off the stamp. The renderer
    // treats that as stale (its test is >=) and draws the chip, so the rect has
    // to grow down to it.
    const edges = faninEdges(TY + HIDE_STALE_EPS);
    const [, lx, ly] = chamferStepPath({
      sourceX: SX,
      sourceY: SY,
      targetX: TX,
      targetY: TY,
      ...routingHintsFromData(edges[0]!.data),
    });
    const boxLeft = Math.min(0, lx - CHIP_HALF_W);
    const boxRight = Math.max(TX + NODE_W, lx + CHIP_HALF_W);
    const boxTop = Math.min(0, ly + 900 - CHIP_HALF_H);
    const boxBottom = Math.max(NODE_H, ly + 900 + CHIP_HALF_H);

    expect(contentBounds(NODES, edges)).toEqual({
      x: boxLeft,
      y: boxTop,
      width: boxRight - boxLeft,
      height: boxBottom - boxTop,
    });
  });

  // A non-owner fan-out member (busChipOwner false, so no aggregate chip is
  // framed) whose branch chip cascaded 900 units below its leg.
  const fanoutEdges = (hiddenAt: { x: number; y: number }): Edge[] => {
    const data = {
      item: "ore",
      rate: new Fraction(1),
      fanout: true,
      busChipOwner: false,
      fanoutBranchDy: 900,
      fanoutBranchHidden: true,
      fanoutBranchHiddenAt: hiddenAt,
    };
    return [{ id: "e1", type: "bus", source: "a", target: "b", data }];
  };
  const branchAnchorOf = (edges: Edge[]): { x: number; y: number } =>
    chamferFanoutPath({
      sourceX: SX,
      sourceY: SY,
      targetX: TX,
      targetY: TY,
      ...routingHintsFromData(edges[0]!.data),
    }).branchAnchor;

  it("skips a fan-out branch chip whose stamp still matches the live anchor", () => {
    const live = branchAnchorOf(fanoutEdges({ x: 0, y: 0 }));
    expect(contentBounds(NODES, fanoutEdges(live))).toEqual(NODE_BOX);
  });

  it("frames a fan-out branch chip whose stamp has drifted off the live anchor", () => {
    // Drift on x alone is enough: BusEdge's rule is per-axis and strict, so a
    // gap of exactly HIDE_STALE_EPS is already stale.
    const live = branchAnchorOf(fanoutEdges({ x: 0, y: 0 }));
    const edges = fanoutEdges({ x: live.x + HIDE_STALE_EPS, y: live.y });
    const cy = live.y + 900;
    const boxLeft = Math.min(0, live.x - CHIP_HALF_W);
    const boxRight = Math.max(TX + NODE_W, live.x + CHIP_HALF_W);
    const boxTop = Math.min(0, cy - CHIP_HALF_H);
    const boxBottom = Math.max(NODE_H, cy + CHIP_HALF_H);

    expect(contentBounds(NODES, edges)).toEqual({
      x: boxLeft,
      y: boxTop,
      width: boxRight - boxLeft,
      height: boxBottom - boxTop,
    });
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
    const { targets, itemOverrides, recipeCosts } = planToSolverArgs(plan);
    const tConfig = loadTransportConfig(defaultTransportConfig, pack);
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      tConfig,
      itemOverrides,
      recipeCosts,
    );
    const itemById = new Map(pack.items.map((i) => [i.id, i]));
    const { plan: renderPlan } = renderPlanFromSolve(
      full,
      pack,
      targets,
      itemOverrides,
    );
    const laid = await layoutRenderPlan({
      plan: renderPlan,
      recipeById: full.recipeById,
      itemById,
    });

    const byId = new Map(laid.nodes.map((n) => [n.id, n]));
    let nl = Infinity;
    let nt = Infinity;
    let nr = -Infinity;
    let nb = -Infinity;
    for (const n of laid.nodes) {
      const x = absoluteLeft(n, byId);
      const y = absoluteTop(n, byId);
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
