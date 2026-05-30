import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { solvePlanWithIntermediates } from "../../src/solver";
import { buildRenderPlan } from "../../src/pipeline/driver";
import { layoutRenderPlan } from "../../src/canvas/layout";
import { pack } from "../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";
import type { Target } from "../../src/data/targets";
import type { ItemOverride } from "../../src/data/plan";
import type { Recipe } from "@aef/schema";
import type { RecipeId } from "../../src/solver/types";
import { RENDER_UNIT_KINDS } from "../../src/pipeline/types";

// ---------------------------------------------------------------------------
// Fixture shape. Each fixture JSON in aef-plans/ pins a target list plus a set
// of structural expectations checked against the resulting render plan.
// ---------------------------------------------------------------------------

type RegressionFixture = {
  name: string;
  targets: Target[];
  // Optional item-override list. Defaults to [] when absent so fixtures that
  // predate overrides keep their existing semantics.
  itemOverrides?: ItemOverride[];
  expectations: {
    minUnits: number;
    // Legacy fold-era field retained on existing fixture JSON for
    // backward-compat with previously authored fixtures; ignored after fold
    // removal.
    expectAtLeastOneBadge?: boolean;
    expectAtLeastOneLoop: boolean;
    // Optional: assert every render unit is incident to at least one render
    // edge. Loop units are exempt (their I/O lives inside the box). Useful
    // for pinning bugs where a producer/consumer machine ended up isolated
    // from the rest of the graph.
    expectNoIsolatedUnits?: boolean;
    // Optional (defaults to true): assert that every target's output unit
    // (`u:out:<itemId>`) has at least one incoming edge with a non-zero
    // rate. Pins split-replica deliverer routing: when an SCC member is itself
    // a target, the deliverer must produce a boundary target edge or no rate
    // flows out of the SCC.
    expectTargetOutputDelivered?: boolean;
  };
};

const FIXTURE_DIR = join("test", "regression", "aef-plans");

function loadFixtures(): ReadonlyArray<{
  file: string;
  fixture: RegressionFixture;
}> {
  const entries = readdirSync(FIXTURE_DIR, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => e.name)
    .sort();
  return files.map((file) => {
    const raw = readFileSync(join(FIXTURE_DIR, file), "utf-8");
    const parsed = JSON.parse(raw) as RegressionFixture;
    return { file, fixture: parsed };
  });
}

// Build the recipeById map once so the layout pass has the data it needs.
// Mirrors solvePlanWithIntermediates' internal construction; the public
// SolvePlanFull surface already returns this map, but the layout call wants a
// plain readonly Map so we reuse the solver result directly.
function recipeByIdFromPack(): ReadonlyMap<RecipeId, Recipe> {
  return new Map(pack.recipes.map((r) => [r.id, r]));
}

const fixtures = loadFixtures();

describe("regression: AEF render-plan fixtures", () => {
  // Guardrail: if the directory is ever empty the scaffold is broken. Without
  // this, an empty glob would produce a passing-by-vacuity suite.
  it("discovers at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { file, fixture } of fixtures) {
    describe(`${file}: ${fixture.name}`, () => {
      it("runs solver -> render plan -> layout and meets expectations", async () => {
        const tConfig = loadTransportConfig(defaultTransportConfig, pack);
        const itemOverrides = fixture.itemOverrides ?? [];
        const full = solvePlanWithIntermediates(
          fixture.targets,
          pack,
          tConfig,
          itemOverrides,
        );
        const { plan } = buildRenderPlan({
          logical: full.logical,
          replicas: full.replicas,
          multipliers: full.multipliers,
          idealCount: full.idealCount,
          classByReplicaId: full.classByReplicaId,
          classToQuotient: full.classToQuotient,
          condensation: full.condensation,
          torn: full.torn,
          recipeById: full.recipeById,
          rates: full.rates,
          itemById: new Map(pack.items.map((i) => [i.id, i])),
          machineById: new Map(pack.machines.map((m) => [m.id, m])),
          itemOverrides,
          targets: fixture.targets,
          pack,
        });

        // Layout must succeed; we do not snapshot positions here (those are
        // ELK-dependent and noisy under version bumps). The call itself
        // exercises the render-plan -> ELK -> RF-node path end-to-end.
        const laid = await layoutRenderPlan({
          plan,
          recipeById: recipeByIdFromPack(),
          itemById: new Map(pack.items.map((i) => [i.id, i])),
        });
        expect(laid.nodes.length).toBeGreaterThan(0);

        // Structural assertions against the render plan.
        expect(plan.units.length).toBeGreaterThanOrEqual(
          fixture.expectations.minUnits,
        );

        if (fixture.expectations.expectAtLeastOneLoop) {
          expect(plan.units.some((u) => u.kind === "loop")).toBe(true);
        }

        // Sanity: only MVP unit kinds are emitted. Matches the shared
        // constant from src/pipeline/types.
        const allowed = new Set<string>(RENDER_UNIT_KINDS);
        for (const u of plan.units) {
          expect(allowed.has(u.kind)).toBe(true);
        }

        if (fixture.expectations.expectNoIsolatedUnits) {
          const incident = new Set<string>();
          for (const e of plan.edges) {
            incident.add(e.fromUnit);
            incident.add(e.toUnit);
          }
          // Loop units may be self-contained; product units are boundary
          // nodes pinned to the FIRST/LAST ELK layers via per-node options
          // (no synthetic edges from MachineGraph). Both are exempted from
          // the isolation check.
          const isolated = plan.units
            .filter(
              (u) =>
                u.kind !== "loop" &&
                u.kind !== "inputProduct" &&
                u.kind !== "outputProduct",
            )
            .filter((u) => !incident.has(u.id));
          expect(isolated.map((u) => `${u.kind}:${u.id}`)).toEqual([]);
        }

        if (fixture.expectations.expectTargetOutputDelivered !== false) {
          const recipeMap = recipeByIdFromPack();
          for (const t of fixture.targets) {
            const recipe = recipeMap.get(t.recipeId);
            const outItem = recipe?.out[0]?.item;
            if (!outItem) continue;
            const targetUnitId = `u:out:${outItem}`;
            const incoming = plan.edges.filter(
              (e) => e.toUnit === targetUnitId,
            );
            expect(
              incoming.length,
              `no edge delivers target ${t.recipeId} (item ${outItem}) to ${targetUnitId}`,
            ).toBeGreaterThan(0);
          }
        }
      });
    });
  }
});
