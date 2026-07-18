import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";
import { clearRailY, chamferStepPath, type ObstacleRect } from "./edgePath";
import { clampBackwardRails } from "./busRouting";
import type { RFAnyNode } from "./layout";

const CARD: ObstacleRect = { left: 100, right: 400, top: 90, bottom: 210 };

test("clearRailY returns the preferred y when no card is spanned", () => {
  // The rail's x-span is left of the card, so nothing to avoid.
  expect(clearRailY(150, 0, 80, [CARD])).toBe(150);
});

test("clearRailY moves the rail clear of every spanned card's y-extent", () => {
  // preferredY sits inside the card, and the rail spans it horizontally.
  const y = clearRailY(150, 120, 380, [CARD]);
  expect(y < CARD.top || y > CARD.bottom).toBe(true);
});

test("clearRailY clears all spanned cards at once", () => {
  const cards: ObstacleRect[] = [
    { left: 100, right: 300, top: 80, bottom: 160 },
    { left: 250, right: 500, top: 140, bottom: 260 },
  ];
  const y = clearRailY(150, 120, 480, cards);
  for (const c of cards) {
    expect(y < c.top || y > c.bottom).toBe(true);
  }
});

test("clearRailY pushes a moat-preferred rail out to the full container band", () => {
  // A rail whose preferred y misses the container's padded rect but lands in
  // the moat between the border and the wide clearance band would otherwise be
  // left hugging the slab; the widened container strike band pushes it out.
  const slab: ObstacleRect = {
    left: 100,
    right: 400,
    top: 100,
    bottom: 200,
    container: true,
  };
  const y = clearRailY(91, 120, 380, [slab], 8, 48);
  expect(y).toBe(slab.top - 48);
});

test("clearRailY leaves a moat-preferred rail alone off a plain card", () => {
  // Same geometry without the container flag: 91 is outside the card's rect,
  // so a plain obstacle keeps the narrow strike band and the rail stays put.
  const card: ObstacleRect = { left: 100, right: 400, top: 100, bottom: 200 };
  expect(clearRailY(91, 120, 380, [card], 8, 48)).toBe(91);
});

test("chamferStepPath honors a railY override in its backward branch", () => {
  const [path] = chamferStepPath({
    sourceX: 400,
    sourceY: 100,
    targetX: 0,
    targetY: 100,
    railY: 500,
  });
  // The overridden rail level appears as a vertex y in the emitted polyline.
  expect(path).toContain(",500");
});

test("clampBackwardRails threads a clear railY onto a card-crossing recycle edge", () => {
  // A backward edge (target left of source) whose midway rail would cut through
  // a card sitting between them.
  const nodes = [
    {
      id: "src",
      type: "product",
      position: { x: 800, y: 0 },
      width: 148,
      height: 60,
      data: { kind: "inputProduct", itemId: "water" },
    },
    {
      id: "tgt",
      type: "product",
      position: { x: 0, y: 0 },
      width: 148,
      height: 60,
      data: { kind: "inputProduct", itemId: "water" },
    },
    {
      id: "mid",
      type: "product",
      position: { x: 400, y: 0 },
      width: 148,
      height: 200,
      data: { kind: "inputProduct", itemId: "water" },
    },
  ] as unknown as RFAnyNode[];
  const edges: Edge[] = [
    {
      id: "e:1",
      source: "src",
      target: "tgt",
      type: "item",
      data: { item: "water", rate: new Fraction(1) },
    },
  ];
  const out = clampBackwardRails(nodes, edges);
  const railY = (out[0]!.data as { railY?: number }).railY;
  expect(railY).toBeDefined();
  // The threaded rail clears the mid card's y-extent (top 0, bottom 200).
  expect(railY! < 0 || railY! > 200).toBe(true);
});

test("the chip label layer is lifted above node cards via z-index", () => {
  const css = readFileSync(
    resolve(process.cwd(), "src/canvas/canvas.css"),
    "utf8",
  );
  expect(css).toMatch(
    /\.react-flow__edgelabel-renderer\s*\{[^}]*z-index:\s*\d+/,
  );
});
