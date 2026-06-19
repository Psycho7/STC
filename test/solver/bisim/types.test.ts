import { describe, it, expect } from "vitest";
import {
  canonicalEncodeNeighbors,
  type ClassId,
} from "../../../src/solver/bisim/types";

describe("bisim types", () => {
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
});
