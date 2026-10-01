import { describe, expect, it } from "vitest";
import solver from "javascript-lp-solver";
import { CORPUS, type CorpusScenario } from "./corpus";
import {
  BIG_M_COST,
  readTableauPrimals,
  RATE_ZERO,
  solveLp,
  type LpModel,
} from "./lp";

// The engine's default precision, and the rounding generateSolutionSet applies
// to every primal before Solve returns it.
const ENGINE_PRECISION = 1e-8;
const ROUNDING_COEFF = Math.round(1 / ENGINE_PRECISION);
const engineRound = (v: number): number =>
  Math.round((Number.EPSILON + v) * ROUNDING_COEFF) / ROUNDING_COEFF;

const RESULT_KEYS = new Set(["feasible", "result", "bounded", "isIntegral"]);

// A column's coefficients on the rows every pass shares: the objective and the
// tie-break cap rows are what a pass is allowed to change.
const PASS_OWN_KEYS = new Set(["objective", "cost_cap", "boundary_cap"]);
function rowCoefs(column: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(column).filter(([key]) => !PASS_OWN_KEYS.has(key)),
  );
}

function modelsOf(scenario: CorpusScenario): [string, LpModel][] {
  const models: [string, LpModel][] = [];
  solveLp({
    targets: scenario.targets,
    pack: scenario.pack,
    ...(scenario.itemOverrides
      ? { itemOverrides: scenario.itemOverrides }
      : {}),
    ...(scenario.recipeCosts ? { recipeCosts: scenario.recipeCosts } : {}),
    onModel: (mode, model) => models.push([mode, structuredClone(model)]),
  });
  return models;
}

describe("tableau primal read", () => {
  // Pins the read against the engine's own output: rounded the way the engine
  // rounds, the tableau read must give exactly the non-zero set Solve returns.
  // A library upgrade that changes the tableau layout breaks this first.
  it("rounded to the engine precision, equals Solve's non-zero primals on every corpus pass", () => {
    let passes = 0;
    for (const scenario of CORPUS) {
      for (const [mode, model] of modelsOf(scenario)) {
        const read = readTableauPrimals(structuredClone(model));
        const expected = solver.Solve(structuredClone(model)) as Record<
          string,
          unknown
        >;
        const fromEngine: Record<string, number> = {};
        for (const [key, value] of Object.entries(expected)) {
          if (RESULT_KEYS.has(key)) continue;
          fromEngine[key] = value as number;
        }
        const fromTableau: Record<string, number> = {};
        for (const [key, value] of read.primals) {
          const rounded = engineRound(value);
          if (rounded !== 0) fromTableau[key] = rounded;
        }
        const label = `${scenario.name} ${mode}`;
        expect(fromTableau, label).toEqual(fromEngine);
        expect(read.feasible, label).toBe(expected.feasible);
        expect(read.bounded, label).toBe(expected.bounded);
        passes++;
      }
    }
    expect(passes).toBeGreaterThan(CORPUS.length);
  });
});

describe("tie-break models", () => {
  // The boundary and lex models differ from the primary model only by their
  // objective, their cap rows, and the big-M columns pass 1 left at zero.
  it("leave out exactly the big-M columns pass 1 kept at zero", () => {
    let dropped = 0;
    for (const scenario of CORPUS) {
      const models = modelsOf(scenario);
      const primary = models.find(([mode]) => mode === "primary")?.[1];
      if (primary === undefined) throw new Error(scenario.name);
      const pass1 = readTableauPrimals(structuredClone(primary)).primals;

      for (const [mode, model] of models) {
        if (mode === "primary") continue;
        const label = `${scenario.name} ${mode}`;

        const rows = Object.keys(model.constraints).filter(
          (name) => name !== "cost_cap" && name !== "boundary_cap",
        );
        expect(rows, label).toEqual(Object.keys(primary.constraints));

        for (const [name, coefs] of Object.entries(primary.variables)) {
          const column = model.variables[name];
          if (column === undefined) {
            expect(name.startsWith("x_"), `${label} ${name}`).toBe(true);
            expect(coefs.objective, `${label} ${name}`).toBeGreaterThanOrEqual(
              BIG_M_COST,
            );
            expect(
              pass1.get(name) ?? 0,
              `${label} ${name}`,
            ).toBeLessThanOrEqual(RATE_ZERO);
            dropped++;
            continue;
          }
          expect(rowCoefs(column), `${label} ${name}`).toEqual(rowCoefs(coefs));
        }
        for (const name of Object.keys(model.variables)) {
          expect(primary.variables[name], `${label} ${name}`).toBeDefined();
        }
      }
    }
    expect(dropped).toBeGreaterThan(0);
  });
});
