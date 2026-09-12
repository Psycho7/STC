import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { assignSplitRoles } from "../../src/solver/replicate";

// Direct unit tests against the split decision inside replicatePerConsumer.
// They exercise the rule without constructing a RecipeGraph / Condensation; the
// public-entry tests in replicate.test.ts continue to cover the integrated
// behaviour.

// Helper: build an SCC member from a flat (id, rate, in, out) record so each
// test reads as data, not setup.
function member(
  id: string,
  rate: Fraction,
  inStoich: Array<{ item: string; qty: number }>,
  outStoich: Array<{ item: string; qty: number }>,
) {
  return { id, rate, in: inStoich, out: outStoich };
}

describe("assignSplitRoles", () => {
  // A real SCC member always has an intra outgoing edge (that is what makes the
  // component strongly connected), so this shape can only arrive from a
  // malformed condensation. The case guards the fail-safe branch: no intra
  // edges means no loop to split off, whatever the condensation claims.
  it("returns single when there are no intra-SCC outgoing edges", () => {
    const d = assignSplitRoles({
      recipeId: "R",
      members: [member("R", new Fraction(2), [], [{ item: "x", qty: 1 }])],
      intraEdges: [],
      crossEdges: [{ item: "x", target: "C" }],
      targetOutItems: new Set<string>(),
    });
    expect(d.kind).toBe("single");
  });

  it("returns single when intra exists but no cross and no targeted output", () => {
    const d = assignSplitRoles({
      recipeId: "R",
      members: [
        member("R", new Fraction(2), [], [{ item: "x", qty: 1 }]),
        member("M", new Fraction(1), [{ item: "x", qty: 1 }], []),
      ],
      intraEdges: [{ item: "x", target: "M" }],
      crossEdges: [],
      targetOutItems: new Set<string>(),
    });
    expect(d.kind).toBe("single");
  });

  it("returns single when recipeRate is zero (no flow to split)", () => {
    const d = assignSplitRoles({
      recipeId: "R",
      members: [
        member("R", new Fraction(0), [], [{ item: "x", qty: 1 }]),
        member("M", new Fraction(1), [{ item: "x", qty: 1 }], []),
      ],
      intraEdges: [{ item: "x", target: "M" }],
      crossEdges: [{ item: "x", target: "C" }],
      targetOutItems: new Set<string>(),
    });
    expect(d.kind).toBe("single");
  });

  it("splits 50/50 in the symmetric Sandleaf case", () => {
    // PLANTER: 1 seed -> 1 plant @ rate 2; intra consumer PICKER @ rate 1
    // consumes 1 plant/sec; cross consumer DOWN consumes 1 plant/sec.
    const d = assignSplitRoles({
      recipeId: "PLANTER",
      members: [
        member(
          "PLANTER",
          new Fraction(2),
          [{ item: "seed", qty: 1 }],
          [{ item: "plant", qty: 1 }],
        ),
        member(
          "PICKER",
          new Fraction(1),
          [{ item: "plant", qty: 1 }],
          [{ item: "seed", qty: 2 }],
        ),
      ],
      intraEdges: [{ item: "plant", target: "PICKER" }],
      crossEdges: [{ item: "plant", target: "DOWN" }],
      targetOutItems: new Set<string>(),
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
      recipeId: "R",
      members: [
        member("R", new Fraction(2), [], [{ item: "a", qty: 1 }]),
        member("M2", new Fraction(1), [{ item: "a", qty: 1 }], []),
      ],
      intraEdges: [{ item: "a", target: "M2" }],
      crossEdges: [],
      targetOutItems: new Set(["a"]),
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
      recipeId: "R",
      members: [
        member("R", new Fraction(4), [], [{ item: "x", qty: 1 }]),
        member("I", new Fraction(1), [{ item: "x", qty: 1 }], []),
      ],
      intraEdges: [{ item: "x", target: "I" }],
      crossEdges: [{ item: "x", target: "C" }],
      targetOutItems: new Set<string>(),
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
      recipeId: "R",
      members: [
        member("R", new Fraction(2), [], [{ item: "a", qty: 1 }]),
        member("M1", new Fraction(1, 2), [{ item: "a", qty: 1 }], []),
        member("M2", new Fraction(1, 2), [{ item: "a", qty: 1 }], []),
      ],
      intraEdges: [
        { item: "a", target: "M1" },
        { item: "a", target: "M2" },
      ],
      crossEdges: [{ item: "a", target: "D" }],
      targetOutItems: new Set<string>(),
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    expect([...d.looperFilter].sort()).toEqual(["a|M1", "a|M2"]);
    expect([...d.delivererFilter]).toEqual(["a|D"]);
  });

  it("caps the looped demand at intra production when demand over-bills it", () => {
    // Intra demand 2/sec against a produced flow of 1: the loop cannot consume
    // more than the SCC produces, so the looper takes everything and the
    // deliverer is left at zero rather than the split going negative.
    const d = assignSplitRoles({
      recipeId: "R",
      members: [
        member("R", new Fraction(1), [], [{ item: "x", qty: 1 }]),
        member("M", new Fraction(2), [{ item: "x", qty: 1 }], []),
      ],
      intraEdges: [{ item: "x", target: "M" }],
      crossEdges: [{ item: "x", target: "C" }],
      targetOutItems: new Set<string>(),
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    expect(d.looperRate.equals(new Fraction(1))).toBe(true);
    expect(d.delivererRate.equals(new Fraction(0))).toBe(true);
  });

  it("bills a producer its produced-flow share of a multi-producer SCC's demand", () => {
    // Two intra producers of x: P1 at 3/s, P2 at 1/s (total intra production
    // 4/s). The SCC's only intra consumer of x is M, drawing 2/s. P1 must be
    // billed its 3/4 share of that demand (3/2), not the whole 2/s.
    const members = [
      member(
        "P1",
        new Fraction(3),
        [{ item: "y", qty: 1 }],
        [{ item: "x", qty: 1 }],
      ),
      member(
        "P2",
        new Fraction(1),
        [{ item: "y", qty: 1 }],
        [{ item: "x", qty: 1 }],
      ),
      member(
        "M",
        new Fraction(2),
        [{ item: "x", qty: 1 }],
        [{ item: "y", qty: 4 }],
      ),
    ];
    const d = assignSplitRoles({
      recipeId: "P1",
      members,
      intraEdges: [{ item: "x", target: "M" }],
      crossEdges: [{ item: "x", target: "OUT" }],
      targetOutItems: new Set<string>(),
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    // produced flow 3; intra flow = min(2, 4) * 3/4 = 3/2; cross flow = 3/2.
    // looperRate = 3 * (3/2)/3 = 3/2, delivererRate = 3 - 3/2 = 3/2.
    expect(d.looperRate.equals(new Fraction(3, 2))).toBe(true);
    expect(d.delivererRate.equals(new Fraction(3, 2))).toBe(true);
  });

  it("counts an SCC member's intra demand once however many producers feed it", () => {
    // M draws 3/s of x and is fed by both P1 and P2 (2/s each, 4/s of intra
    // production). Counting M's demand once per producer would bill 6/s,
    // cap at the 4/s produced, and leave P1 with a dead deliverer.
    const members = [
      member(
        "P1",
        new Fraction(2),
        [{ item: "y", qty: 1 }],
        [{ item: "x", qty: 1 }],
      ),
      member(
        "P2",
        new Fraction(2),
        [{ item: "y", qty: 1 }],
        [{ item: "x", qty: 1 }],
      ),
      member(
        "M",
        new Fraction(3),
        [{ item: "x", qty: 1 }],
        [{ item: "y", qty: 2 }],
      ),
    ];
    const d = assignSplitRoles({
      recipeId: "P1",
      members,
      intraEdges: [{ item: "x", target: "M" }],
      crossEdges: [{ item: "x", target: "OUT" }],
      targetOutItems: new Set<string>(),
    });
    expect(d.kind).toBe("split");
    if (d.kind !== "split") return;
    // produced flow 2; intra flow = min(3, 4) * 2/4 = 3/2; cross flow = 1/2.
    expect(d.looperRate.equals(new Fraction(3, 2))).toBe(true);
    expect(d.delivererRate.equals(new Fraction(1, 2))).toBe(true);
  });
});
