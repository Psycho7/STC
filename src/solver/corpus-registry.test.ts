// Guards the CORPUS registry against the one way it can rot: a scenario const
// added to corpus.ts and never listed, or listed twice under drifting names.
// The registry is the join key between the goldens here and the oracle's
// classification table in tools/oracle, so a silent omission is invisible drift.

import { describe, expect, it } from "vitest";

import * as corpus from "./corpus";
import { CORPUS } from "./corpus";

type ScenarioLike = { pack: unknown; targets: unknown };

function isScenario(value: unknown): value is ScenarioLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "pack" in value &&
    "targets" in value
  );
}

// Every scenario const exported from corpus.ts, by export name.
const exportedScenarios = Object.entries(
  corpus as Record<string, unknown>,
).filter((entry): entry is [string, ScenarioLike] => isScenario(entry[1]));

describe("CORPUS registry", () => {
  it("gives every entry a unique name", () => {
    const names = CORPUS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("lists every scenario exported from corpus.ts exactly once", () => {
    const byName = new Map(CORPUS.map((entry) => [entry.name, entry]));
    const missing = exportedScenarios
      .map(([name]) => name)
      .filter((name) => !byName.has(name));
    expect(missing).toEqual([]);
    expect(CORPUS.length).toBe(exportedScenarios.length);
  });

  it("carries the same pack and targets as the named export", () => {
    for (const [name, scenario] of exportedScenarios) {
      const entry = CORPUS.find((e) => e.name === name)!;
      expect(entry.pack).toBe(scenario.pack);
      expect(entry.targets).toBe(scenario.targets);
    }
  });
});
