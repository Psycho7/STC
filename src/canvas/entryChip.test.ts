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

test("entry stacks of two nearby targets never interleave into overlap", () => {
  // Two product targets share one column (same left edge, same entry-chip x).
  // T1's four same-port entries overflow its short card and, dodging T2's card
  // below, park in the open space under it; T2's own two entries stack downward
  // off its port into that same region. Without the cross-target placed check
  // the second T2 chip seats within one pitch of T1's parked chip (their stacks
  // are monotone only WITHIN a target); with it, every pair stays a full pitch
  // apart.
  const product = (id: string, x: number, y: number): unknown => ({
    id,
    type: "product",
    position: { x, y },
    width: 100,
    height: 60,
    data: { kind: "inputProduct", itemId: "water" },
  });
  const nodes = [
    product("t1", 600, 0), // port y 30
    product("t2", 600, 150), // port y 175
    product("a1", 0, 0),
    product("a2", 0, 0),
    product("a3", 0, 0),
    product("a4", 0, 0),
    product("b1", 0, 145),
    product("b2", 0, 145),
  ] as RFAnyNode[];
  const entry = (id: string, source: string, target: string): Edge => ({
    id,
    source,
    target,
    type: "item",
    data: { item: "water", rate: new Fraction(1), multiInputTarget: true },
  });
  const edges: Edge[] = [
    entry("e:1", "a1", "t1"),
    entry("e:2", "a2", "t1"),
    entry("e:3", "a3", "t1"),
    entry("e:4", "a4", "t1"),
    entry("e:5", "b1", "t2"),
    entry("e:6", "b2", "t2"),
  ];
  const out = deconflictChipAnchors(nodes, edges);
  const dyOf = (id: string): number =>
    ((out.find((e) => e.id === id)?.data ?? {}) as { entryChipDy?: number })
      .entryChipDy ?? 0;
  // Final chip centre ys: T1 anchors at its port (30), T2 at its port (175).
  const ys = [
    30 + dyOf("e:1"),
    30 + dyOf("e:2"),
    30 + dyOf("e:3"),
    30 + dyOf("e:4"),
    175 + dyOf("e:5"),
    175 + dyOf("e:6"),
  ];
  // All six chips share one x, so pairwise clearance is vertical: every pair
  // at least one full pitch apart.
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) {
      expect(Math.abs(ys[i]! - ys[j]!)).toBeGreaterThanOrEqual(
        ENTRY_CHIP_MIN_GAP,
      );
    }
  }
});
