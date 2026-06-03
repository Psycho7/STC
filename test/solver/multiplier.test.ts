import { describe, it, expect } from "vitest";
import Fraction from "fraction.js";
import {
  assignIdealMultipliers,
  assignMultipliers,
} from "../../src/solver/multiplier";
import { MissingMachineError, type Replica } from "../../src/solver/types";
import type { Machine, Recipe } from "@aef/schema";

function rep(id: string, recipeId: string, rate: Fraction): Replica {
  return {
    id,
    recipeId,
    executionRate: rate,
    consumerPath: [],
    blueprintGroupId: "g",
    sharedAtArticulation: false,
  };
}

const machine: Machine = {
  id: "m1",
  name: "m1",
  icon: "m1",
  speed: 1,
  powerType: "electric",
  powerKw: 0,
  hideRate: false,
} as Machine;
const machineFast: Machine = { ...machine, id: "m2", speed: 2 };
const machineById = new Map<string, Machine>([
  ["m1", machine],
  ["m2", machineFast],
]);

const recipeNormal = {
  id: "r1",
  in: [{ item: "x", qty: 1 }],
  out: [{ item: "y", qty: 1 }],
  producers: ["m1"],
  time: 2,
} as unknown as Recipe;
const recipeSink = {
  id: "r2",
  in: [{ item: "x", qty: 1 }],
  out: [],
  producers: ["m1"],
  time: 1,
} as unknown as Recipe;
const recipeMissingMachine = {
  id: "r3",
  in: [],
  out: [{ item: "z", qty: 1 }],
  producers: ["mZZ"],
  time: 1,
} as unknown as Recipe;
const recipeById = new Map<string, Recipe>([
  ["r1", recipeNormal],
  ["r2", recipeSink],
  ["r3", recipeMissingMachine],
]);

describe("assignMultipliers", () => {
  it("rate 1 cycle/sec, time 2 s, speed 1 -> multiplier 2", () => {
    const result = assignMultipliers(
      [rep("a", "r1", new Fraction(1))],
      machineById,
      recipeById,
    );
    expect(result.get("a")).toBe(2);
  });
  it("rate 1/2 cycle/sec, time 2 s, speed 2 -> multiplier ceil(0.5) = 1", () => {
    const fast = { ...recipeNormal, producers: ["m2"] } as unknown as Recipe;
    const recipeMap = new Map<string, Recipe>([["r1", fast]]);
    const result = assignMultipliers(
      [rep("a", "r1", new Fraction(1, 2))],
      machineById,
      recipeMap,
    );
    expect(result.get("a")).toBe(1);
  });
  it("sink recipe works (no special branch)", () => {
    const result = assignMultipliers(
      [rep("s", "r2", new Fraction(3))],
      machineById,
      recipeById,
    );
    expect(result.get("s")).toBe(3);
  });
  it("missing machine throws MissingMachineError", () => {
    expect(() =>
      assignMultipliers(
        [rep("x", "r3", new Fraction(1))],
        machineById,
        recipeById,
      ),
    ).toThrow(MissingMachineError);
  });
  it("zero rate filters the replica out", () => {
    const result = assignMultipliers(
      [rep("z", "r1", new Fraction(0))],
      machineById,
      recipeById,
    );
    expect(result.has("z")).toBe(false);
  });
});

describe("assignIdealMultipliers", () => {
  it("returns exact Fraction without ceiling", () => {
    // rate 3/2, time 2, speed 1 -> ideal = 3/2 * 2 / 1 = 3
    const result = assignIdealMultipliers(
      [rep("a", "r1", new Fraction(3, 2))],
      machineById,
      recipeById,
    );
    expect(result.get("a")!.equals(new Fraction(3))).toBe(true);
  });

  it("preserves fractional ideal (no ceil)", () => {
    // rate 1, time 2, speed 3 -> ideal = 1 * 2 / 3 = 2/3
    const fast = {
      ...recipeNormal,
      producers: ["m2"],
      time: 2,
    } as unknown as Recipe;
    const recipeMap = new Map<string, Recipe>([["r1", fast]]);
    const slowFast: Machine = { ...machine, id: "m2", speed: 3 };
    const machineMap = new Map<string, Machine>([["m2", slowFast]]);
    const result = assignIdealMultipliers(
      [rep("a", "r1", new Fraction(1))],
      machineMap,
      recipeMap,
    );
    expect(result.get("a")!.equals(new Fraction(2, 3))).toBe(true);
  });

  it("zero-rate replicas excluded", () => {
    const result = assignIdealMultipliers(
      [rep("z", "r1", new Fraction(0))],
      machineById,
      recipeById,
    );
    expect(result.has("z")).toBe(false);
  });

  it("missing machine throws same error as assignMultipliers", () => {
    expect(() =>
      assignIdealMultipliers(
        [rep("x", "r3", new Fraction(1))],
        machineById,
        recipeById,
      ),
    ).toThrow(MissingMachineError);
  });
});
