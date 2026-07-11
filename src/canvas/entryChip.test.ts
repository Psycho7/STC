import { expect, test } from "vitest";
import Fraction from "fraction.js";
import type { Edge } from "@xyflow/react";
import {
  ENTRY_CHIP_MIN_GAP,
  stackEntryAnchors,
  deconflictChipAnchors,
} from "./busRouting";
import { entryChipAnchor } from "./ItemEdge";
import type { RFAnyNode } from "./layout";
import type { Recipe } from "@aef/schema";

test("stackEntryAnchors pushes a coincident anchor clear of the previous one", () => {
  const out = stackEntryAnchors([100, 100]);
  expect(out[0]).toBe(100);
  expect(out[1]! - out[0]!).toBeGreaterThanOrEqual(ENTRY_CHIP_MIN_GAP);
});

test("stackEntryAnchors spaces coincident anchors at least a max-scale pitch (48) apart", () => {
  // At the fit-zoom counter-scale cap (2x), a 24px rate-chip box renders 48px
  // tall, so the graph-space stack pitch must be at least 48 to keep chips
  // clear.
  const out = stackEntryAnchors([0, 0, 0]);
  expect(out[1]! - out[0]!).toBeGreaterThanOrEqual(48);
  expect(out[2]! - out[1]!).toBeGreaterThanOrEqual(48);
});

test("stackEntryAnchors leaves already-separated anchors untouched", () => {
  const out = stackEntryAnchors([100, 100 + ENTRY_CHIP_MIN_GAP + 5]);
  expect(out).toEqual([100, 100 + ENTRY_CHIP_MIN_GAP + 5]);
});

test("entryChipAnchor offsets x left of the port and applies the stack dy", () => {
  const a = entryChipAnchor(500, 200, 24);
  expect(a.x).toBeLessThan(500);
  expect(a.y).toBe(224);
});

const RECIPE = {
  id: "r",
  category: "assemble",
  time: 1,
  producers: ["mk1"],
  in: [
    { item: "water", qty: 1 },
    { item: "ore", qty: 1 },
  ],
  out: [{ item: "widget", qty: 1 }],
} as unknown as Recipe;

test("deconflictChipAnchors stacks two entry chips arriving at one node", () => {
  const nodes = [
    {
      id: "s1",
      type: "product",
      position: { x: 0, y: 0 },
      width: 148,
      height: 60,
      data: { kind: "inputProduct", itemId: "water" },
    },
    {
      id: "s2",
      type: "product",
      position: { x: 0, y: 200 },
      width: 148,
      height: 60,
      data: { kind: "inputProduct", itemId: "water" },
    },
    {
      id: "t",
      type: "recipe",
      position: { x: 600, y: 0 },
      data: {
        recipe: RECIPE,
        kind: "recipe",
        inputOrder: ["water", "ore"],
        outputOrder: ["widget"],
      },
    },
  ] as unknown as RFAnyNode[];
  // Two forward item edges carrying the same item into the same input port, both
  // flagged multiInputTarget, so their entry chips pin to the identical anchor.
  const edges: Edge[] = [
    {
      id: "e:1",
      source: "s1",
      target: "t",
      type: "item",
      data: { item: "water", rate: new Fraction(1), multiInputTarget: true },
    },
    {
      id: "e:2",
      source: "s2",
      target: "t",
      type: "item",
      data: { item: "water", rate: new Fraction(1), multiInputTarget: true },
    },
  ];
  const out = deconflictChipAnchors(nodes, edges);
  const dys = out.map(
    (e) => (e.data as { entryChipDy?: number }).entryChipDy ?? 0,
  );
  // The two chips no longer coincide: at least one is offset, and the gap
  // between them clears the minimum.
  expect(dys.some((d) => d !== 0)).toBe(true);
  expect(Math.abs(dys[0]! - dys[1]!)).toBeGreaterThanOrEqual(ENTRY_CHIP_MIN_GAP);
});
