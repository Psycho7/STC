import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import {
  canonicalEncodeNeighbors,
  type ClassId,
  type ReplicaEdge,
  type QuotientEdge,
} from "../../../src/solver/bisim/types";

describe("bisim types", () => {
  it("ClassId is a branded string", () => {
    const cid: ClassId = "c:0" as ClassId;
    expect(typeof cid).toBe("string");
  });

  it("canonicalEncodeNeighbors sorts by (item, classId) and preserves duplicates", () => {
    const a = canonicalEncodeNeighbors([
      { item: "iron", classId: "c:1" as ClassId },
      { item: "copper", classId: "c:0" as ClassId },
      { item: "iron", classId: "c:1" as ClassId },
    ]);
    const b = canonicalEncodeNeighbors([
      { item: "iron", classId: "c:1" as ClassId },
      { item: "iron", classId: "c:1" as ClassId },
      { item: "copper", classId: "c:0" as ClassId },
    ]);
    expect(a).toBe(b);
    const c = canonicalEncodeNeighbors([
      { item: "iron", classId: "c:1" as ClassId },
      { item: "copper", classId: "c:0" as ClassId },
    ]);
    expect(a).not.toBe(c);
  });

  it("ReplicaEdge and QuotientEdge type-check", () => {
    const re: ReplicaEdge = {
      source: "r:0",
      target: "r:1",
      item: "iron",
      rate: new Fraction(1),
    };
    const qe: QuotientEdge = {
      sourceClass: "c:0" as ClassId,
      targetClass: "c:1" as ClassId,
      item: "iron",
      rate: new Fraction(1),
    };
    expect(re.source).toBe("r:0");
    expect(qe.sourceClass).toBe("c:0");
  });
});
