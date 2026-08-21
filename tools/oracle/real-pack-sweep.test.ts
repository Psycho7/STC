// Real-pack vendor-oracle sweep: every app-valid (producible) item as a
// single-item target, at rate 1/s and at 1/1000 per second (the small-rate
// axis), STC vs the extracted FactorioLab GLPK solver via compareScenario.
//
// This file GATES nothing beyond "the harness ran": it emits
// .sweep/vendor-oracle-v14.jsonl (one CompareRecord summary per scenario) and
// .sweep/vendor-oracle-v14-summary.md for offline analysis. A disagreement is
// reported in the artifact, never fudged; classification happens downstream.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadModule } from "glpk-ts";
import { beforeAll, describe, expect, it } from "vitest";

import { pack as realPack } from "../../src/data/load";
import { producibleItemIds } from "../../src/data/recipe-category";
import type { ItemTarget } from "../../src/data/targets";

import { compareScenario, type CompareRecord } from "./compare";

beforeAll(async () => {
  await loadModule("node_modules/glpk-wasm/dist/glpk.all.wasm");
});

interface Row {
  item: string;
  rate: string;
  stcVerdict: string;
  glpkVerdict: string;
  verdictAgree: boolean;
  targetMetAgree: boolean;
  stcTargetMet: boolean;
  glpkTargetMet: boolean;
  stcSoftFeasible: boolean;
  stcHasDeficit: boolean;
  activeSetAgree: boolean;
  stcActive: number;
  glpkActive: number;
  tier2Eligible: boolean;
  ratesAgree: boolean | null;
  stcMachines: number;
  glpkMachines: number;
  machDelta: number;
}

function toRow(item: string, rate: string, r: CompareRecord): Row {
  return {
    item,
    rate,
    stcVerdict: r.stcVerdict,
    glpkVerdict: r.glpkVerdict,
    verdictAgree: r.verdictAgree,
    targetMetAgree: r.targetMetAgree,
    stcTargetMet: r.stcTargetMet,
    glpkTargetMet: r.glpkTargetMet,
    stcSoftFeasible: r.stcSoftFeasible,
    stcHasDeficit: r.stcHasDeficit,
    activeSetAgree: r.activeSetAgree,
    stcActive: r.stcActiveSet.length,
    glpkActive: r.glpkActiveSet.length,
    tier2Eligible: r.tier2Eligible,
    ratesAgree: r.ratesAgree,
    stcMachines: r.stcMachineEstimate,
    glpkMachines: r.glpkMachineTotal,
    machDelta: Math.abs(r.stcMachineEstimate - r.glpkMachineTotal),
  };
}

const RATES: { label: string; num: string; denom: string }[] = [
  { label: "1", num: "1", denom: "1" },
  { label: "1/100", num: "1", denom: "100" },
  { label: "1/1000", num: "1", denom: "1000" },
];

describe("real-pack vendor-oracle sweep (v1.4, item targets)", () => {
  it("sweeps every producible item at rate 1 and 1/1000", () => {
    const items = [...producibleItemIds(realPack.recipes)].sort();
    expect(items.length).toBeGreaterThan(0);

    const rows: Row[] = [];
    const failures: { item: string; rate: string; error: string }[] = [];

    for (const item of items) {
      for (const rate of RATES) {
        const targets: ItemTarget[] = [
          { itemId: item, ratePerSec: { num: rate.num, denom: rate.denom } },
        ];
        try {
          const rec = compareScenario({
            name: `sweep:${item}@${rate.label}`,
            pack: realPack,
            targets,
          });
          rows.push(toRow(item, rate.label, rec));
        } catch (e) {
          failures.push({ item, rate: rate.label, error: String(e) });
        }
      }
    }

    const outDir = path.resolve(__dirname, "../../.sweep");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      path.join(outDir, "vendor-oracle-v14.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );

    const disagree = rows.filter((r) => !r.verdictAgree || !r.targetMetAgree);
    const bothSat = rows.filter(
      (r) => r.verdictAgree && r.stcTargetMet && r.glpkTargetMet,
    );
    const machOff = bothSat.filter(
      (r) =>
        r.machDelta > 1e-6 * Math.max(1, Math.abs(r.glpkMachines)),
    );
    const t2 = rows.filter((r) => r.tier2Eligible);
    const t2Miss = t2.filter((r) => r.ratesAgree === false);

    const lines = [
      "# Real-pack vendor-oracle sweep (v1.4, item targets)",
      "",
      `- items: ${items.length}, scenarios: ${rows.length}, harness errors: ${failures.length}`,
      `- Tier-1 disagreements (verdict or target-met): ${disagree.length}`,
      `- both-satisfiable scenarios: ${bothSat.length}; machine-total deltas beyond 1e-6 rel: ${machOff.length}`,
      `- Tier-2 eligible: ${t2.length}; rate misses: ${t2Miss.length}`,
      "",
      "## Tier-1 disagreements",
      ...disagree.map(
        (r) =>
          `- ${r.item}@${r.rate}: STC=${r.stcVerdict}(met=${r.stcTargetMet},sf=${r.stcSoftFeasible},def=${r.stcHasDeficit}) GLPK=${r.glpkVerdict}(met=${r.glpkTargetMet})`,
      ),
      "",
      "## Machine-total deltas (both satisfiable)",
      ...machOff.map(
        (r) =>
          `- ${r.item}@${r.rate}: STC~${r.stcMachines.toFixed(6)} GLPK=${r.glpkMachines.toFixed(6)} d=${r.machDelta.toExponential(2)} (activeSetAgree=${r.activeSetAgree})`,
      ),
      "",
      "## Tier-2 misses",
      ...t2Miss.map((r) => `- ${r.item}@${r.rate}`),
      "",
      "## Harness errors",
      ...failures.map((f) => `- ${f.item}@${f.rate}: ${f.error}`),
      "",
    ];
    writeFileSync(
      path.join(outDir, "vendor-oracle-v14-summary.md"),
      lines.join("\n"),
    );

    expect(failures).toEqual([]);
  }, 600_000);
});
