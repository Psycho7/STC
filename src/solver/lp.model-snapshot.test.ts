import { createHash } from "node:crypto";
import Fraction from "fraction.js";
import { describe, expect, it } from "vitest";
import { CORPUS, type CorpusScenario } from "./corpus";
import { solveLp, type LpModel } from "./lp";

// A digest of every LP model the corpus builds, taken before the catalyst term
// leaves the model. The catalyst term only ever attaches to an item with a
// finite POSITIVE cap, so every scenario without one must produce a byte-equal
// model afterwards; the digests below are what that later change is held to.
//
// The digest is over a canonical JSON form (keys sorted at every level,
// Fractions as their string form), so it is stable across runs and across
// property insertion order.

function canonicalize(value: unknown): unknown {
  if (value instanceof Fraction) return value.toFraction();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function digestOf(pairs: ReadonlyArray<[string, LpModel]>): string {
  const json = JSON.stringify(canonicalize(pairs));
  return createHash("sha256").update(json).digest("hex");
}

// A finite positive cap is the only thing the catalyst block reacts to, so a
// scenario carrying one is expected to change and is left out.
function hasFinitePositiveCap(scenario: CorpusScenario): boolean {
  return (scenario.itemOverrides ?? []).some((o) => {
    if (o.ratePerSec === undefined) return false;
    return Number(o.ratePerSec.num) / Number(o.ratePerSec.denom) > 0;
  });
}

describe("LP model snapshot over the solver corpus", () => {
  const scenarios = CORPUS.filter((s) => !hasFinitePositiveCap(s));

  it("covers every corpus scenario without a finite positive cap", () => {
    const skipped = CORPUS.filter(hasFinitePositiveCap).map((s) => s.name);
    expect(skipped).toEqual(["splitTargetProducers"]);
    expect(scenarios.length).toBe(CORPUS.length - skipped.length);
  });

  it("matches the recorded model digests", () => {
    const digests: Record<string, string> = {};
    for (const scenario of scenarios) {
      const observed: [string, LpModel][] = [];
      solveLp({
        targets: scenario.targets,
        pack: scenario.pack,
        ...(scenario.itemOverrides
          ? { itemOverrides: scenario.itemOverrides }
          : {}),
        ...(scenario.recipeCosts ? { recipeCosts: scenario.recipeCosts } : {}),
        onModel: (mode, model) => {
          observed.push([mode, model]);
        },
      });
      // Pass 1 always runs; pass 2 only when pass 1 came back feasible and
      // bounded, so the observed count is part of what the digest pins.
      expect(observed.length, scenario.name).toBeGreaterThan(0);
      digests[scenario.name] = digestOf(observed);
    }
    expect(digests).toMatchSnapshot();
  });
});
