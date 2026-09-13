// The environment frame's layout footprint. A recipe that must run in a gas
// environment draws banner plates and a haze on a frame rectangle beyond its
// card box (ENV_FRAME_EXTENTS in dimensions.ts), so the layout has to reserve
// that rectangle or the plates land on the neighbour below. Three contracts:
//
//   1. the ELK adapter hands ELK the CARD box grown by the extents, with the
//      recipe's ports stamped at their card-box handle coordinates plus the
//      frame's inner-rectangle offset, so the box ELK spaces is the frame;
//   2. the ELK-to-React-Flow position mapping adds the offset back, so the
//      card box lands at the frame's inner rectangle and every DOM handle
//      keeps its plain-card position relative to the card box;
//   3. the default spacings then guarantee the vertical clearances two stacked
//      cards need: 36 above an environment card, 22 below it, so 58 between
//      two of them, with no spacing change.

import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";

import {
  fromElkRenderLayout,
  renderPlanToElkGraph,
  type ElkGraph,
  type LayoutInput,
} from "../../src/canvas/layout";
import {
  ENV_FRAME_EXTENTS,
  PORT_HEIGHT,
  PORT_WIDTH,
} from "../../src/canvas/dimensions";
import { measureRecipe } from "../../src/canvas/recipeGeometry";
import {
  drawnPortsOf,
  nodeHeight,
  nodeIndexOf,
  nodeWidth,
  portOffsetY,
} from "../../src/canvas/nodeGeometry";
import { layoutSolved } from "../../src/canvas/layoutSolved";
import { solveForRender } from "../../src/pipeline/solveForRender";
import { pack } from "../../src/data/load";
import type { ItemTarget } from "../../src/data/targets";
import type { Edge } from "@xyflow/react";
import { mkRecipe } from "./busRouting.testkit";
import type {
  RenderEdge,
  RenderPlan,
  RenderUnitRecipe,
} from "../../src/pipeline/types";

const mkRecipeUnit = (id: string, recipeId: string): RenderUnitRecipe => ({
  id,
  kind: "recipe",
  recipeId,
  count: 1,
  multiplicity: { num: "1", denom: "1" },
});

const mkEdge = (
  fromUnit: string,
  toUnit: string,
  item: string,
): RenderEdge => ({
  fromUnit,
  toUnit,
  item,
  rate: new Fraction(1),
  transportKind: "belt",
});

const envRecipe = {
  ...mkRecipe("r:env", ["i"], ["o"]),
  environment: "stable" as const,
};
const plainRecipe = mkRecipe("r:plain", ["o"], ["i"]);

const envPlanInput = (): LayoutInput => {
  const plan: RenderPlan = {
    units: [mkRecipeUnit("u:env", "r:env"), mkRecipeUnit("u:plain", "r:plain")],
    edges: [mkEdge("u:env", "u:plain", "o")],
    containers: [],
  };
  return {
    plan,
    recipeById: new Map([
      ["r:env", envRecipe],
      ["r:plain", plainRecipe],
    ]),
    itemById: new Map(),
  };
};

describe("renderPlanToElkGraph: the environment footprint", () => {
  it("grows an environment recipe's box by the frame extents", () => {
    const graph = renderPlanToElkGraph(envPlanInput());
    const env = graph.children.find((c) => c.id === "u:env");
    const geom = measureRecipe(envRecipe);
    expect(env?.width).toBe(
      geom.width + ENV_FRAME_EXTENTS.left + ENV_FRAME_EXTENTS.right,
    );
    expect(env?.height).toBe(
      geom.height + ENV_FRAME_EXTENTS.top + ENV_FRAME_EXTENTS.bottom,
    );
  });

  it("stamps the environment recipe's ports at the card-box handles plus the offset", () => {
    const graph = renderPlanToElkGraph(envPlanInput());
    const env = graph.children.find((c) => c.id === "u:env");
    const geom = measureRecipe(envRecipe);
    // The port box's CENTRE sits on the card-box model anchor (west x=0 /
    // east x=width, y = the row's handle y) shifted by the inner-rectangle
    // offset, so the graph ELK receives describes where the DOM handles are.
    const centre = (p: { x?: number; y?: number }) => ({
      x: (p.x ?? 0) + PORT_WIDTH / 2,
      y: (p.y ?? 0) + PORT_HEIGHT / 2,
    });
    const west = env?.ports?.find((p) => p.id === "u:env.in:i");
    expect(centre(west ?? {})).toEqual({
      x: ENV_FRAME_EXTENTS.left,
      y: ENV_FRAME_EXTENTS.top + (geom.inHandleYs[0] ?? 0),
    });
    const east = env?.ports?.find((p) => p.id === "u:env.out:o");
    expect(centre(east ?? {})).toEqual({
      x: ENV_FRAME_EXTENTS.left + geom.width,
      y: ENV_FRAME_EXTENTS.top + (geom.outHandleYs[0] ?? 0),
    });
  });

  it("leaves a plain recipe's box and ports untouched", () => {
    const graph = renderPlanToElkGraph(envPlanInput());
    const plain = graph.children.find((c) => c.id === "u:plain");
    const geom = measureRecipe(plainRecipe);
    expect(plain?.width).toBe(geom.width);
    expect(plain?.height).toBe(geom.height);
    for (const p of plain?.ports ?? []) {
      expect(p.x).toBeUndefined();
      expect(p.y).toBeUndefined();
    }
  });
});

describe("fromElkRenderLayout: the inner-rectangle offset", () => {
  it("lands an environment card box at the grown box's inner rectangle", () => {
    const input = envPlanInput();
    const graph = renderPlanToElkGraph(input);
    const laid: ElkGraph = {
      ...graph,
      children: graph.children.map((c, i) => ({
        ...c,
        x: i * 400,
        y: i * 500,
      })),
      edges: graph.edges,
    };
    const { nodes } = fromElkRenderLayout(laid, input);
    const env = nodes.find((n) => n.id === "u:env");
    const plain = nodes.find((n) => n.id === "u:plain");
    // The grown box sits at (0, 0); the card box is the inner rectangle.
    expect(env?.position).toEqual({
      x: ENV_FRAME_EXTENTS.left,
      y: ENV_FRAME_EXTENTS.top,
    });
    // A plain card maps 1:1.
    expect(plain?.position).toEqual({ x: 400, y: 500 });
  });
});

// nodeGeometry's PORT_DRIFT, mirrored the way the other real-plan suites
// mirror it (the module keeps its table unexported as a negative control): the
// drawn endpoint sits a few units off the model port React Flow positions by.
const DRIFT = {
  sourceDx: 5,
  targetDx: -3,
  dy: 1,
};

// The gas-web scenario: three environment cards among plain neighbours.
const GAS_WEB: ItemTarget[] = [
  { itemId: "gas_xiranite_enr", ratePerSec: { num: "1", denom: "2" } },
  { itemId: "gas_copper_enr2", ratePerSec: { num: "1", denom: "2" } },
  { itemId: "gas_inert", ratePerSec: { num: "1", denom: "4" } },
];

type CardBox = {
  id: string;
  env: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

async function topLevelCards(targets: ItemTarget[]): Promise<CardBox[]> {
  const { nodes } = await layoutSolved(solveForRender({ targets, pack }));
  // Top-level only: a parented node's position is container-relative, which
  // would need the parentId hop nodeGeometry's absoluteLeft does.
  return nodes
    .filter(
      (n) =>
        (n as { parentId?: string }).parentId === undefined &&
        (n.type === "recipe" || n.type === "product"),
    )
    .map((n) => ({
      id: n.id,
      env: n.type === "recipe" && n.data.recipe.environment !== undefined,
      left: n.position.x,
      top: n.position.y,
      right: n.position.x + nodeWidth(n),
      bottom: n.position.y + nodeHeight(n),
    }));
}

describe("layoutRenderPlan on gas-web: the frame's vertical clearances", () => {
  it("keeps every stacked pair clear of the plates", async () => {
    const cards = await topLevelCards(GAS_WEB);
    const envCards = cards.filter((c) => c.env);
    // Premise: this plan draws three environment cards with stacked pairs to
    // check; without them the clearance assertions below are vacuous.
    expect(envCards.length).toBe(3);

    const EPS = 0.5;
    const violations: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i]!;
        const b = cards[j]!;
        const xOverlap = a.left < b.right - EPS && b.left < a.right - EPS;
        if (!xOverlap) continue;
        // Same column: the higher card is the one whose top is smaller.
        const upper = a.top <= b.top ? a : b;
        const lower = upper === a ? b : a;
        if (upper.bottom > lower.top + EPS) {
          violations.push(`${upper.id} and ${lower.id} boxes overlap`);
          continue;
        }
        const gap = lower.top - upper.bottom;
        // The plates above an environment card reach ENV_FRAME_EXTENTS.top
        // past its box, the plate below ENV_FRAME_EXTENTS.bottom; the gap
        // between the two CARD boxes must cover them.
        const need =
          upper.env && lower.env
            ? ENV_FRAME_EXTENTS.top + ENV_FRAME_EXTENTS.bottom
            : !upper.env && lower.env
              ? ENV_FRAME_EXTENTS.top
              : upper.env && !lower.env
                ? ENV_FRAME_EXTENTS.bottom
                : 0;
        if (gap < need - EPS) {
          violations.push(
            `${upper.id} (env=${upper.env}) above ${lower.id} (env=${lower.env}): gap ${gap.toFixed(1)} < ${need}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  }, 60_000);

  it("keeps every environment card's port handles at plain-card offsets", async () => {
    const { nodes, edges } = await layoutSolved(
      solveForRender({ targets: GAS_WEB, pack }),
    );
    const byId = nodeIndexOf(nodes);

    const checked: string[] = [];
    for (const edge of edges as Edge[]) {
      const ends = drawnPortsOf(edge, byId);
      if (ends === null) continue;
      const item = (edge.data as { item?: string } | undefined)?.item;
      const pairs = [
        {
          id: edge.source,
          x: ends.sourceX,
          y: ends.sourceY,
          side: "out" as const,
          dx: DRIFT.sourceDx,
        },
        {
          id: edge.target,
          x: ends.targetX,
          y: ends.targetY,
          side: "in" as const,
          dx: DRIFT.targetDx,
        },
      ];
      for (const end of pairs) {
        const node = byId.get(end.id);
        if (node?.type !== "recipe") continue;
        if (node.data.recipe.environment === undefined) continue;
        const left = node.position.x;
        const top = node.position.y;
        // Byte-identical to a plain card: the drawn endpoint relative to the
        // card box is the model port (box edge / row slot) plus PORT_DRIFT.
        expect(end.x - left, `${edge.id} ${end.side} x on ${end.id}`).toBe(
          (end.side === "out" ? nodeWidth(node) : 0) + end.dx,
        );
        expect(end.y - top, `${edge.id} ${end.side} y on ${end.id}`).toBe(
          portOffsetY(node, item, end.side) + DRIFT.dy,
        );
        checked.push(`${edge.id}:${end.side}`);
      }
    }
    // Premise: the plan wires at least one edge into or out of an environment
    // card, so the assertions above were exercised.
    expect(checked.length).toBeGreaterThan(0);
  }, 60_000);
});
