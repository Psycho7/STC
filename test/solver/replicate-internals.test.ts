import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import {
  assignSplitRoles,
  propagateGroups,
  type ResolvedIntraEdge,
} from "../../src/solver/replicate";

// Direct unit tests against the two pure seams inside replicatePerConsumer.
// These exercise the split decision and the GroupId derivation rule without
// constructing a RecipeGraph / Condensation; the public-entry tests in
// replicate.test.ts continue to cover the integrated behaviour.

// Helper: build a ResolvedIntraEdge from a flat (item, target, rate, inQty)
// record so each test reads as data, not setup.
function intra(
  item: string,
  target: string,
  rate: Fraction,
  inQty: number,
): ResolvedIntraEdge {
  return { item, target, consumerRate: rate, consumerInQty: inQty };
}

describe("propagateGroups", () => {
  it("scc role formats as scc:<sccId>", () => {
    expect(propagateGroups({ kind: "scc", sccId: "S1" })).toBe("scc:S1");
  });

  it("apShared role formats as shared:<recipeId>", () => {
    expect(propagateGroups({ kind: "apShared", recipeId: "Q" })).toBe(
      "shared:Q",
    );
  });

  it("target role formats as target:<recipeId>", () => {
    expect(propagateGroups({ kind: "target", recipeId: "T" })).toBe("target:T");
  });

  it("inherit role returns the consumer's group verbatim", () => {
    expect(
      propagateGroups({ kind: "inherit", consumerGroupId: "target:X" }),
    ).toBe("target:X");
    expect(
      propagateGroups({ kind: "inherit", consumerGroupId: "scc:S2" }),
    ).toBe("scc:S2");
  });
});

describe("assignSplitRoles", () => {
  it("returns single when there are no intra-SCC outgoing edges", () => {
    const d = assignSplitRoles({
      recipeRate: new Fraction(2),
      primaryOutQty: 1,
      intraEdges: [],
      crossEdges: [{ item: "x", target: "C" }],
      isTarget: false,
    });
    expect(d.kind).toBe("single");
  });

  it("returns single when intra exists but no cross and not a target", () => {
    const d = assignSplitRoles({
      recipeRate: new Fraction(2),
      primaryOutQty: 1,
      intraEdges: [intra("x", "M", new Fraction(1), 1)],
      crossEdges: [],
      isTarget: false,
    });
    expect(d.kind).toBe("single");
  });

  it("returns single when recipeRate is zero (no flow to split)", () => {
    const d = assignSplitRoles({
      recipeRate: new Fraction(0),
      primaryOutQty: 1,
      intraEdges: [intra("x", "M", new Fraction(1), 1)],
      crossEdges: [{ item: "x", target: "C" }],
      isTarget: false,
    });
    expect(d.kind).toBe("single");
  });

  it("splits 50/50 in the symmetric Sandleaf case", () => {
    // PLANTER: 1 seed -> 1 plant @ rate 2; intra consumer PICKER @ rate 1
    // consumes 1 plant/sec; cross consumer DOWN consumes 1 plant/sec.
    const d = assignSplitRoles({
      recipeRate: new Fraction(2),
      primaryOutQty: 1,
      intraEdges: [intra("plant", "PICKER", new Fraction(1), 1)],
      crossEdges: [{ item: "plant", target: "DOWN" }],
      isTarget: false,
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    expect(d.looperRate.equals(new Fraction(1))).toBe(true);
    expect(d.delivererRate.equals(new Fraction(1))).toBe(true);
    // Mass balance: looper + deliverer == recipe rate.
    expect(d.looperRate.add(d.delivererRate).equals(new Fraction(2))).toBe(
      true,
    );
  });

  it("splits a target-only deliverer with empty crossEdges", () => {
    // SCC interior recipe that is ALSO a user target: the boundary-products
    // pass synthesizes the target edge later, so crossEdges is empty here
    // but the deliverer still owns the synthetic target output role.
    const d = assignSplitRoles({
      recipeRate: new Fraction(2),
      primaryOutQty: 1,
      intraEdges: [intra("a", "M2", new Fraction(1), 1)],
      crossEdges: [],
      isTarget: true,
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    expect(d.looperFilter.has("a|M2")).toBe(true);
    // Empty cross filter -- the boundary-products pass routes the target
    // output from this replica's stamps without an outgoing edge.
    expect(d.delivererFilter.size).toBe(0);
    expect(d.looperRate.add(d.delivererRate).equals(new Fraction(2))).toBe(
      true,
    );
  });

  it("splits asymmetrically when intra and cross flows differ", () => {
    // recipeRate 4, produces 1 plant per cycle (so total flow = 4 plant/s).
    // intra consumes 1 plant/s, cross consumes 3 plant/s.
    // Looper rate = 4 * 1/4 = 1; deliverer = 4 - 1 = 3.
    const d = assignSplitRoles({
      recipeRate: new Fraction(4),
      primaryOutQty: 1,
      intraEdges: [intra("x", "I", new Fraction(1), 1)],
      crossEdges: [{ item: "x", target: "C" }],
      isTarget: false,
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    expect(d.looperRate.equals(new Fraction(1))).toBe(true);
    expect(d.delivererRate.equals(new Fraction(3))).toBe(true);
  });

  it("emits filters keyed by outgoingEdgeKey(item, target)", () => {
    // Two intra-SCC edges sharing the item but distinct targets verify
    // both that the filter is keyed on (item, target) and that the helper
    // distinguishes them correctly under parallel-edge-shaped fixtures.
    const d = assignSplitRoles({
      recipeRate: new Fraction(2),
      primaryOutQty: 1,
      intraEdges: [
        intra("a", "M1", new Fraction(1, 2), 1),
        intra("a", "M2", new Fraction(1, 2), 1),
      ],
      crossEdges: [{ item: "a", target: "D" }],
      isTarget: false,
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    expect([...d.looperFilter].sort()).toEqual(["a|M1", "a|M2"]);
    expect([...d.delivererFilter]).toEqual(["a|D"]);
  });

  it("clamps negative cross-flow to zero (defensive invariant)", () => {
    // Engineer a case where intraFlow > producedFlow (impossible in practice
    // for a well-formed solve, but the clamp is documented). Setting
    // primaryOutQty=1 and recipeRate=1 yields producedFlow=1; the intra side
    // claims 2 plants/sec consumed. crossFlow would be -1; clamp -> 0.
    const d = assignSplitRoles({
      recipeRate: new Fraction(1),
      primaryOutQty: 1,
      intraEdges: [intra("x", "M", new Fraction(2), 1)],
      crossEdges: [{ item: "x", target: "C" }],
      isTarget: false,
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    // totalFlow == intra (cross clamped to 0), so the whole recipe rate is
    // attributed to the looper.
    expect(d.looperRate.equals(new Fraction(1))).toBe(true);
    expect(d.delivererRate.equals(new Fraction(0))).toBe(true);
  });
});
