import { describe, expect, it, vi } from "vitest";
import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import { assertInvariants, type SolverInvariantArgs } from "./invariants";
import { solvePlanWithIntermediates } from "./index";
import { solveLp } from "./lp";
import { netSelfConsumption } from "./net-self";
import { pack } from "../data/load";
import { defaultTransportConfig } from "../data/transport-config";
import type { ItemTarget } from "../data/targets";

// Both mocks delegate to the real implementation and only record what passed
// through, so behaviour is unchanged and the recordings can be compared by
// object identity.
const recorded = vi.hoisted(() => ({
  nettedPacks: [] as RecipePack[],
  assertedArgs: [] as SolverInvariantArgs[],
}));

vi.mock("./net-self", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./net-self")>();
  return {
    ...actual,
    netSelfConsumption: (p: RecipePack): RecipePack => {
      const netted = actual.netSelfConsumption(p);
      recorded.nettedPacks.push(netted);
      return netted;
    },
  };
});

vi.mock("./invariants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./invariants")>();
  return {
    ...actual,
    assertInvariants: (args: SolverInvariantArgs): void => {
      recorded.assertedArgs.push(args);
      actual.assertInvariants(args);
    },
  };
});

const headlineTargets: ItemTarget[] = [
  {
    itemId: "xiranite_enr_powder",
    ratePerSec: { num: "6", denom: "60" },
  },
];

// Production solves the netted pack, so the fixture nets too: a raw-pack solve
// would build a different problem than the one `full` came from.
function nettedArgs(): SolverInvariantArgs {
  const netted = netSelfConsumption(pack);
  return {
    full: solvePlanWithIntermediates(
      headlineTargets,
      pack,
      defaultTransportConfig,
    ),
    result: solveLp({ targets: headlineTargets, pack: netted }),
    pack: netted,
    targets: headlineTargets,
    itemOverrides: [],
  };
}

describe("assertInvariants", () => {
  it("passes on a valid headline solve", () => {
    expect(() => assertInvariants(nettedArgs())).not.toThrow();
  });

  it("throws when the solve result is corrupted (mass balance broken)", () => {
    const args = nettedArgs();
    // Zero out every recipe rate: production collapses while the demand
    // remains, so checkMassBalance fires.
    for (const key of [...args.result.rates.keys()]) {
      args.result.rates.set(key, new Fraction(0));
    }
    expect(() => assertInvariants(args)).toThrow(/invariants violated/);
  });

  it("asserts against the same netted pack the pipeline solved on", () => {
    recorded.nettedPacks.length = 0;
    recorded.assertedArgs.length = 0;

    solvePlanWithIntermediates(headlineTargets, pack, defaultTransportConfig);

    expect(recorded.nettedPacks.length).toBe(1);
    expect(recorded.assertedArgs.length).toBe(1);
    expect(recorded.assertedArgs[0]!.pack).toBe(recorded.nettedPacks[0]);
    expect(recorded.assertedArgs[0]!.pack).not.toBe(pack);
  });
});
