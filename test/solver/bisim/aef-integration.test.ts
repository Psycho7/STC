import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import { solvePlanWithIntermediates } from "../../../src/solver";
import { pack } from "../../../src/data/load";
import { defaultTransportConfig } from "../../../src/data/transport-config";
import { defaultTargets } from "../../../src/data/targets";
import { buildRecipeGraph } from "../../../src/solver/graph";
import { bisimQuotient, deriveReplicaEdges } from "../../../src/solver/bisim";
import type { Target } from "../../../src/data/targets";

describe("AEF round-trip with bisim", () => {
  it("structural invariants hold on a sample target", () => {
    const targetRecipe = pack.recipes[0]!;
    const targets: Target[] = [
      { recipeId: targetRecipe.id, ratePerSec: { num: "1", denom: "1" } },
    ];
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    expect(full.replicas.length).toBeGreaterThan(0);

    // Ceiling invariant: assignMultipliers ceils idealCount, so for every
    // quotient replica the integer multiplier must be >= the rational ideal.
    for (const r of full.replicas) {
      const mult = full.multipliers.get(r.id);
      const ideal = full.idealCount.get(r.id);
      if (mult === undefined || ideal === undefined) continue;
      expect(new Fraction(mult).compare(ideal)).toBeGreaterThanOrEqual(0);
    }

    // Quotient cardinality: bisim never grows the replica set, so the
    // number of raw replicas (classByReplicaId.size) is an upper bound on
    // the number of quotient replicas (full.replicas.length).
    expect(full.classByReplicaId.size).toBeGreaterThanOrEqual(
      full.replicas.length,
    );

    // Surjection: every distinct class value in classByReplicaId maps to a
    // quotient replica, and every quotient replica id appears in
    // classToQuotient.values().
    const seenClasses = new Set(full.classByReplicaId.values());
    for (const cid of seenClasses) {
      expect(full.classToQuotient.has(cid)).toBe(true);
    }
    const quotientIds = new Set(full.replicas.map((r) => r.id));
    for (const qid of full.classToQuotient.values()) {
      expect(quotientIds.has(qid)).toBe(true);
    }
  });

  it("idempotence: re-running bisim on the wired output produces no further merges", () => {
    // Pick a multi-target plan (the seed plan) so the input is large
    // enough to exercise the bisim machinery meaningfully. The contract
    // we verify: feeding the quotient replicas + freshly-derived edges
    // back through bisimQuotient must yield the same partition. This is
    // the real round-trip property the unit tests prove on synthetic
    // graphs; this test proves it on real AEF data threaded through the
    // wired pipeline.
    const targets = defaultTargets();
    const full = solvePlanWithIntermediates(
      targets,
      pack,
      defaultTransportConfig,
      [],
    );
    expect(full.replicas.length).toBeGreaterThan(0);

    const g = buildRecipeGraph(targets, pack, []);
    const quotientEdges = deriveReplicaEdges(g, full.replicas);
    const pinned = new Set(
      full.replicas.filter((r) => r.sharedAtArticulation).map((r) => r.id),
    );
    const second = bisimQuotient({
      replicas: full.replicas,
      edges: quotientEdges,
      pinnedReplicaIds: pinned,
    });
    // Second-pass replica count must equal first-pass replica count: no
    // class can split (deterministic refinement) and no further merge can
    // happen (idempotence).
    expect(second.quotientReplicas.length).toBe(full.replicas.length);
    // Every second-pass class must be a singleton.
    const secondClasses = new Set(second.classByReplicaId.values());
    expect(secondClasses.size).toBe(full.replicas.length);
  });
});
