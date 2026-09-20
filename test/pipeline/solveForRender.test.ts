import { describe, expect, it, vi } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The spy arrays have to exist before the vi.mock factories run, and those are
// hoisted above the imports.
const calls = vi.hoisted(() => ({
  solve: [] as unknown[][],
  render: [] as unknown[][],
}));

vi.mock("../../src/solver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/solver")>();
  return {
    ...actual,
    solvePlanWithIntermediates: (
      ...args: Parameters<typeof actual.solvePlanWithIntermediates>
    ) => {
      calls.solve.push(args);
      return actual.solvePlanWithIntermediates(...args);
    },
  };
});

vi.mock("../../src/pipeline/driver", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/pipeline/driver")>();
  const original = actual.renderPlanFromSolve;
  return {
    ...actual,
    renderPlanFromSolve: (...args: Parameters<typeof original>) => {
      calls.render.push(args);
      return original(...args);
    },
  };
});

import {
  solveForRender,
  solveFromPlan,
} from "../../src/pipeline/solveForRender";
import { CLOSED_FORM_FIXTURES } from "../../src/solver/closed-form-fixtures";
import { defaultPlan, type ItemOverride, type Plan } from "../../src/data/plan";
import { pack } from "../../src/data/load";
import {
  unavailableCauses,
  unavailableItems,
  unavailableRecipeIds,
} from "../../src/data/availability";
import { attributeShortfall } from "../../src/data/shortfall";

const chain = CLOSED_FORM_FIXTURES.find((f) => f.name === "chain")!;

describe("solveForRender: one pack, one targets list, one overrides list", () => {
  it("hands the solver and the render pipeline the same three values", () => {
    calls.solve.length = 0;
    calls.render.length = 0;
    // A cap far above the solved draw: it rides both calls without changing
    // what either produces.
    const itemOverrides: ItemOverride[] = [
      { itemId: "R", ratePerSec: { num: "1000", denom: "1" } },
    ];

    const out = solveForRender({
      targets: chain.targets,
      itemOverrides,
      pack: chain.pack,
    });

    expect(calls.solve).toHaveLength(1);
    expect(calls.render).toHaveLength(1);
    const [solveTargets, solvePack, solveOverrides] = calls.solve[0]!;
    const [renderFull, renderPack, renderTargets, renderOverrides] =
      calls.render[0]!;

    expect(solvePack).toBe(chain.pack);
    expect(renderPack).toBe(solvePack);
    expect(solveTargets).toBe(chain.targets);
    expect(renderTargets).toBe(solveTargets);
    expect(solveOverrides).toBe(itemOverrides);
    expect(renderOverrides).toBe(solveOverrides);
    expect(renderFull).toBe(out.full);
  });

  it("defaults the overrides to one empty list shared by both calls", () => {
    calls.solve.length = 0;
    calls.render.length = 0;

    solveForRender({ targets: chain.targets, pack: chain.pack });

    const solveOverrides = calls.solve[0]![2];
    expect(solveOverrides).toEqual([]);
    expect(calls.render[0]![3]).toBe(solveOverrides);
  });
});

// copper_jar at 1/s needs more inert gas than the 1/2 per second cap allows,
// and no recipe produces gas_inert, so the shortfall cannot be routed around:
// the LP funds a deficit column and returns a partial plan instead of throwing.
const CAPPED: Plan = {
  ...defaultPlan(pack),
  targets: [{ itemId: "copper_jar", ratePerSec: { num: "1", denom: "1" } }],
  itemOverrides: [
    { itemId: "gas_inert", ratePerSec: { num: "1", denom: "2" } },
  ],
};

describe("solveFromPlan: the targets the drawn plan misses", () => {
  it("names a target the plan feeds below its declared rate", () => {
    // The DEV render-invariant hook throws on exactly this plan, which would
    // mask the reported list the production UI reads.
    vi.stubEnv("DEV", false);
    try {
      const out = solveFromPlan(CAPPED);

      expect(out.underDelivered).toEqual(["copper_jar"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports nothing for the same target with no cap starving it", () => {
    const out = solveFromPlan({ ...CAPPED, itemOverrides: [] });

    expect(out.underDelivered).toEqual([]);
  });
});

// The evidence the shortfall strip may name a supply cap on: a cap the drawn
// plan pulls in full. A cap above the draw constrains nothing, so naming it
// would be a guess.
describe("solveFromPlan: the caps the drawn plan exhausts", () => {
  it("reports an explicit cap the plan draws in full", () => {
    vi.stubEnv("DEV", false);
    try {
      const out = solveFromPlan(CAPPED);

      expect(out.cappedAtLimit).toEqual(["gas_inert"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports nothing for a cap the plan stays under", () => {
    const out = solveFromPlan({
      ...CAPPED,
      itemOverrides: [
        { itemId: "gas_inert", ratePerSec: { num: "50", denom: "1" } },
      ],
    });

    expect(out.underDelivered).toEqual([]);
    expect(out.cappedAtLimit).toEqual([]);
  });
});

// The C1 regression, exactly as the review probe measured it on the shipped
// pack: the deficits land on the three default targets, every one of their
// direct producers is available, and the item the settlement actually blocks
// carries no deficit at all. Attribution therefore has nothing to name.
describe("the default plan under tundra", () => {
  const settings = { eventOverrides: {}, area: "tundra" };

  it("puts its deficits on targets whose direct producers are all available", () => {
    vi.stubEnv("DEV", false);
    try {
      const unavailable = unavailableRecipeIds(
        unavailableCauses(pack, settings),
      );
      const out = solveFromPlan(defaultPlan(pack), undefined, unavailable);
      const deficits = new Map(
        [...out.full.feasibility.deficits].map(([item, rate]) => [
          item,
          rate.toFraction(),
        ]),
      );

      expect(out.full.feasibility.softFeasible).toBe(false);
      expect(deficits).toEqual(
        new Map([
          ["copper_bottle", "2"],
          ["copper_powder", "1/2"],
          // Solver float noise, not a restriction: see the investigation in the
          // T6 report. The snapped iron_powder rate lands 1/666660 per second
          // under its 1/4 demand, which the LP extraction reports honestly.
          ["iron_powder", "1/666660"],
        ]),
      );
      expect(out.underDelivered.sort()).toEqual([
        "copper_bottle",
        "copper_powder",
        "iron_powder",
      ]);
      // No declared cap anywhere in the default plan.
      expect(out.cappedAtLimit).toEqual([]);

      const itemCauses = unavailableItems(pack, settings);
      for (const item of deficits.keys()) {
        expect(itemCauses.get(item)).toBeUndefined();
      }
      // The one item the settlement does block never shows up as a deficit, so
      // the deficit map cannot lead back to it.
      expect(itemCauses.get("copper_nugget")).toEqual({
        kind: "area",
        area: "tundra",
      });
      expect(deficits.has("copper_nugget")).toBe(false);

      // Hence: unmet demand, no supported explanation.
      expect(
        attributeShortfall({
          underDelivered: out.underDelivered,
          deficitItemIds: [...deficits.keys()],
          itemCauses,
          cappedAtLimit: out.cappedAtLimit,
        }).clauses,
      ).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// The bun CLIs (tools/solver-cli, tools/exam/coverage) run this chain headless,
// so no module reachable from the entry by a VALUE import may pull elkjs. Type
// imports are erased before anything runs, so the walk skips them -- that is
// why a type-only reference to src/canvas/layout is not a violation.
const SRC_ALIASES: Record<string, string> = {
  "@aef/schema": join("tools", "extractor", "src", "schema.ts"),
};

const IMPORT_STATEMENT = /\b(?:import|export)\b([\s\S]*?)\bfrom\s+"([^"]+)"/g;

function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const [, clause, specifier] of source.matchAll(IMPORT_STATEMENT)) {
    if (clause!.trim().startsWith("type")) continue;
    specifiers.push(specifier!);
  }
  return specifiers;
}

function isSourceFile(path: string): boolean {
  if (!path.endsWith(".ts") && !path.endsWith(".tsx")) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveModule(specifier: string, fromFile: string): string | null {
  const aliased = SRC_ALIASES[specifier];
  if (aliased !== undefined) return aliased;
  if (!specifier.startsWith(".")) return null;

  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
  ]) {
    if (isSourceFile(candidate)) return candidate;
  }
  return null;
}

type ImportGraph = {
  files: string[];
  /** Unresolved (package) specifiers, tagged with the file that imports them. */
  external: { file: string; specifier: string }[];
};

function staticImportGraph(entry: string): ImportGraph {
  const seen = new Set<string>();
  const external: { file: string; specifier: string }[] = [];
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const specifier of valueImportSpecifiers(
      readFileSync(file, "utf-8"),
    )) {
      const resolved = resolveModule(specifier, file);
      if (resolved === null) {
        external.push({ file, specifier });
        continue;
      }
      queue.push(resolve(resolved));
    }
  }

  return { files: [...seen], external };
}

describe("solveForRender: the headless entry pulls no elk", () => {
  const graph = staticImportGraph(join("src", "pipeline", "solveForRender.ts"));

  it("reaches no module that value-imports elkjs", () => {
    const elkImports = graph.external.filter((e) =>
      e.specifier.startsWith("elkjs"),
    );
    expect(elkImports).toEqual([]);
  });

  it("walks a graph big enough for the check to mean something", () => {
    expect(graph.files.length).toBeGreaterThan(5);
  });
});
