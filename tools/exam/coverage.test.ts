import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecipePack } from "@aef/schema";
import type { Scenario } from "../../test/e2e/scenarios";
import {
  CORE_SCENARIO_IDS,
  collectCoverage,
  fillGaps,
  uncoveredMachines,
  uncoveredRecipes,
  writeHashesTsv,
  writeRotatingJson,
  type CoverageReport,
} from "./coverage";

// Synthetic pack: two recipes make the same item, one of them strictly
// cheaper, plus the two shapes the denominator filter must drop (a
// __domain_transfer supply recipe and an input-less extraction recipe). The
// cheaper producer is named last in id order on purpose, so a report that
// fell back to a lexicographic pick instead of reading the solution would
// name the wrong winner.
function synthPack(): RecipePack {
  return {
    schemaVersion: "0.2",
    source: {
      name: "synth",
      sourceRepo: "synth",
      sourceCommit: "cafe1234",
      gameVersion: "v0.0",
      extractedAt: "1970-01-01T00:00:00.000Z",
    },
    categories: [],
    locations: [],
    items: [
      { id: "ore", name: "ore", category: "test", icon: "", row: 0, raw: true, transportKind: "belt" },
      { id: "domain_key", name: "domain_key", category: "test", icon: "", row: 0, raw: true, transportKind: "belt" },
      { id: "widget", name: "widget", category: "test", icon: "", row: 0, raw: false, transportKind: "belt" },
    ],
    machines: [
      { id: "m_poor", name: "poor press", icon: "", speed: 1, powerType: "electric", powerKw: 0, hideRate: false },
      { id: "m_good", name: "good press", icon: "", speed: 1, powerType: "electric", powerKw: 0, hideRate: false },
      { id: "m_extract", name: "miner", icon: "", speed: 1, powerType: "electric", powerKw: 0, hideRate: false },
      { id: "__domain_transfer", name: "transfer", icon: "", speed: 1, powerType: "electric", powerKw: 0, hideRate: true },
    ],
    transports: [],
    recipes: [
      {
        id: "aa_widget_poor",
        name: "poor widget",
        category: "test",
        icon: "",
        row: 0,
        time: 1,
        in: [{ item: "ore", qty: 1 }],
        out: [{ item: "widget", qty: 1 }],
        producers: ["m_poor"],
      },
      {
        id: "zz_widget_good",
        name: "good widget",
        category: "test",
        icon: "",
        row: 0,
        time: 1,
        // Self-consuming: widget appears in both in and out, netting to 2.
        in: [{ item: "ore", qty: 1 }, { item: "widget", qty: 1 }],
        out: [{ item: "widget", qty: 3 }],
        producers: ["m_good"],
      },
      {
        id: "transfer_widget",
        name: "widget transfer",
        category: "__domain_transfer",
        icon: "",
        row: 999,
        time: 3600,
        in: [{ item: "domain_key", qty: 1 }],
        out: [{ item: "widget", qty: 150 }],
        producers: ["__domain_transfer"],
      },
      {
        id: "ore_extract",
        name: "ore miner",
        category: "test",
        icon: "",
        row: 0,
        time: 1,
        in: [],
        out: [{ item: "ore", qty: 1 }],
        producers: ["m_extract"],
      },
    ],
  } as unknown as RecipePack;
}

const SYNTH_SCENARIO: Scenario = {
  id: "synth",
  title: "synth",
  targets: [{ itemId: "widget", ratePerSec: { num: "1", denom: "1" } }],
  maxDiffPixels: 0,
};

describe("CORE_SCENARIO_IDS", () => {
  it("is the fixed four-plan core", () => {
    expect([...CORE_SCENARIO_IDS]).toEqual([
      "default",
      "battery5-xiranite",
      "multi6",
      "gas-web",
    ]);
  });
});

describe("collectCoverage on a synthetic pack", () => {
  it("covers only the producer the solve chose", async () => {
    const pack = synthPack();
    const report = await collectCoverage(pack, [SYNTH_SCENARIO]);

    expect(report.fingerprint).toEqual({
      sourceCommit: "cafe1234",
      gameVersion: "v0.0",
    });
    expect(report.plans).toHaveLength(1);

    const plan = report.plans[0]!;
    expect(plan.id).toBe("synth");
    expect(plan.hash.startsWith("v1.")).toBe(true);
    expect(plan.recipeIds).toEqual(["zz_widget_good"]);
    expect(plan.machineIds).toEqual(["m_good"]);
    expect(plan.selfConsumingRecipeIds).toEqual(["zz_widget_good"]);

    expect([...report.union.recipeIds]).toEqual(["zz_widget_good"]);
    expect([...report.union.machineIds]).toEqual(["m_good"]);
  });

  it("reports the un-chosen producer as uncovered and never the excluded ones", async () => {
    const pack = synthPack();
    const report = await collectCoverage(pack, [SYNTH_SCENARIO]);

    expect(uncoveredRecipes(pack, report.union)).toEqual([
      { id: "aa_widget_poor", name: "poor widget" },
    ]);
    expect(uncoveredMachines(pack, report.union)).toEqual([
      { id: "m_poor", name: "poor press" },
    ]);
  });
});

describe("uncoveredRecipes denominator", () => {
  it("drops transfer and extraction recipes even when nothing is covered", () => {
    const pack = synthPack();
    const empty = {
      recipeIds: new Set<string>(),
      machineIds: new Set<string>(),
      selfConsumingRecipeIds: new Set<string>(),
    };
    expect(uncoveredRecipes(pack, empty).map((r) => r.id)).toEqual([
      "aa_widget_poor",
      "zz_widget_good",
    ]);
    expect(uncoveredMachines(pack, empty).map((m) => m.id)).toEqual([
      "m_good",
      "m_poor",
    ]);
  });
});

describe("writeHashesTsv", () => {
  it("writes the fingerprint comment then one row per plan", async () => {
    const pack = synthPack();
    const report = await collectCoverage(pack, [SYNTH_SCENARIO]);
    const dir = await mkdtemp(join(tmpdir(), "stc-coverage-"));
    const path = join(dir, "nested", "hashes.tsv");
    await writeHashesTsv(path, pack, report.plans);

    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines[0]).toBe("# pack cafe1234 v0.0");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`synth\t${report.plans[0]!.hash}`);
  });
});

// Synthetic pack for the gap filler. Everything hangs off one raw ore:
//
//   ore -> mid -> left  \
//              -> right  -> top -> (sink)
//   ore -> mid            (a second, dearer mid producer the LP never runs)
//   ore -> alpha
//   ore -> zeta
//   ore -> ghost          (producer machine does not exist: the solve throws)
//
// r_mid yields 2 per cycle against r_alt_mid's 1, so the LP runs r_mid at half
// the rate and r_alt_mid never appears. Targeting "top" therefore covers four
// recipes in one plan while "left" and "right" cover two overlapping ones, so
// a greedy pick must take top first even though "alpha" sorts ahead of it.
const item = (id: string, raw: boolean) => ({
  id, name: id, category: "test", icon: "", row: 0, raw, transportKind: "belt",
});
const machine = (id: string) => ({
  id, name: id, icon: "", speed: 1, powerType: "electric", powerKw: 0, hideRate: false,
});
const recipe = (
  id: string,
  ins: [string, number][],
  outs: [string, number][],
  producer: string,
) => ({
  id, name: `${id} name`, category: "test", icon: "", row: 0, time: 1,
  in: ins.map(([i, qty]) => ({ item: i, qty })),
  out: outs.map(([i, qty]) => ({ item: i, qty })),
  producers: [producer],
});

const SYNTH_SOURCE = {
  name: "synth",
  sourceRepo: "synth",
  sourceCommit: "cafe1234",
  gameVersion: "v0.0",
  extractedAt: "1970-01-01T00:00:00.000Z",
};

function fillPack(): RecipePack {
  return {
    schemaVersion: "0.2",
    source: SYNTH_SOURCE,
    categories: [],
    locations: [],
    items: [
      item("ore", true),
      item("mid", false),
      item("left", false),
      item("right", false),
      item("top", false),
      item("alpha", false),
      item("zeta", false),
      item("ghost", false),
    ],
    machines: [machine("m1"), machine("m2")],
    transports: [],
    recipes: [
      recipe("r_mid", [["ore", 1]], [["mid", 2]], "m1"),
      recipe("r_alt_mid", [["ore", 1]], [["mid", 1]], "m2"),
      recipe("r_left", [["mid", 1]], [["left", 1]], "m1"),
      recipe("r_right", [["mid", 1]], [["right", 1]], "m1"),
      recipe("r_top", [["left", 1], ["right", 1]], [["top", 1]], "m1"),
      recipe("r_alpha", [["ore", 1]], [["alpha", 1]], "m1"),
      recipe("r_zeta", [["ore", 1]], [["zeta", 1]], "m1"),
      recipe("r_sink", [["top", 1]], [], "m1"),
      recipe("r_ghost", [["ore", 1]], [["ghost", 1]], "m_missing"),
    ],
  } as unknown as RecipePack;
}

// Synthetic pack where one candidate item throws while a recipe that also
// makes it is covered by another pick:
//
//   ore -> a + b          (r_pair, sound)
//   ore -> b (x3)         (r_b_fast, producer machine does not exist)
//
// Targeting "b" is cheaper through r_b_fast (three per cycle against one), so
// that solve throws; targeting "a" runs r_pair and covers it, byproduct b and
// all. So b is a failed candidate whose other producing recipe still lands in
// a pick.
function failedCandidatePack(): RecipePack {
  return {
    schemaVersion: "0.2",
    source: SYNTH_SOURCE,
    categories: [],
    locations: [],
    items: [item("ore", true), item("a", false), item("b", false)],
    machines: [machine("m1")],
    transports: [],
    recipes: [
      recipe(
        "r_pair",
        [["ore", 1]],
        [
          ["a", 1],
          ["b", 1],
        ],
        "m1",
      ),
      recipe("r_b_fast", [["ore", 1]], [["b", 3]], "m_missing"),
    ],
  } as unknown as RecipePack;
}

const EMPTY_UNION = () => ({
  recipeIds: new Set<string>(),
  machineIds: new Set<string>(),
  selfConsumingRecipeIds: new Set<string>(),
});

// A coverage report whose core covered nothing, so the filler faces the whole
// denominator.
function emptyCoverage(pack: RecipePack): CoverageReport {
  return {
    fingerprint: {
      sourceCommit: pack.source.sourceCommit,
      gameVersion: pack.source.gameVersion,
    },
    plans: [],
    union: EMPTY_UNION(),
    featureTotals: {
      loopBoxes: 0,
      loopMembers: 0,
      fanoutInputs: 0,
      aggregateInputs: 0,
      partialStamps: 0,
      multiplicityTotal: "0",
    },
  };
}

describe("fillGaps", () => {
  it("picks by cover size, breaks ties by item id, and classes the residue", async () => {
    const pack = fillPack();
    const fill = await fillGaps(pack, emptyCoverage(pack));

    expect(fill.picked.map((s) => s.id)).toEqual([
      "rot-top",
      "rot-alpha",
      "rot-zeta",
    ]);
    expect(fill.picked[0]).toEqual({
      id: "rot-top",
      title: "rot-top",
      targets: [{ itemId: "top", ratePerSec: { num: "1", denom: "2" } }],
      maxDiffPixels: 0,
    });

    expect(fill.plans.map((p) => p.id)).toEqual([
      "rot-top",
      "rot-alpha",
      "rot-zeta",
    ]);
    expect(fill.plans[0]!.recipeIds).toEqual([
      "r_left",
      "r_mid",
      "r_right",
      "r_top",
    ]);
    expect(fill.plans[0]!.hash.startsWith("v1.")).toBe(true);

    expect(fill.residue).toEqual([
      {
        id: "r_alt_mid",
        name: "r_alt_mid name",
        reason: "LP prefers another producer",
      },
      { id: "r_ghost", name: "r_ghost name", reason: "candidate solve failed" },
      { id: "r_sink", name: "r_sink name", reason: "no candidate scored" },
    ]);
  });

  it("never turns a sink recipe into a candidate", async () => {
    const pack = fillPack();
    const fill = await fillGaps(pack, emptyCoverage(pack), { max: 99 });
    // r_sink yields nothing, so no target rate can ask for it. The sink filter
    // itself is unobservable - a sink has no outputs, so it contributes no
    // candidate item either way - and what can be asserted is the consequence:
    // r_sink stays uncovered however large the budget grows.
    expect(fill.residue.find((r) => r.id === "r_sink")?.reason).toBe(
      "no candidate scored",
    );
  });

  it("stops at --max and leaves the rest in the residue", async () => {
    const pack = fillPack();
    const fill = await fillGaps(pack, emptyCoverage(pack), { max: 1 });

    expect(fill.picked.map((s) => s.id)).toEqual(["rot-top"]);
    expect(fill.residue.map((r) => r.id)).toEqual([
      "r_alpha",
      "r_alt_mid",
      "r_ghost",
      "r_sink",
      "r_zeta",
    ]);
  });

  it("counts budget-exhausted residue as reachable by an unpicked candidate", async () => {
    const pack = fillPack();
    const fill = await fillGaps(pack, emptyCoverage(pack), { max: 1 });

    // r_alpha and r_zeta are only uncovered because the budget ran out: their
    // own candidate plans solved and were never picked. r_sink is genuinely
    // unreachable, so it must not be counted.
    const scored = fill.residue.filter(
      (r) => r.reason === "no candidate scored",
    );
    expect(scored.map((r) => r.id)).toEqual(["r_alpha", "r_sink", "r_zeta"]);
    expect(fill.reachableByUnpicked).toBe(2);
  });

  it("lists a failed candidate even when another pick covers its recipe", async () => {
    const pack = failedCandidatePack();
    const fill = await fillGaps(pack, emptyCoverage(pack));

    expect(fill.picked.map((s) => s.id)).toEqual(["rot-a"]);
    // r_pair also makes b, and the rot-a pick covers it - the failure is still
    // reported, because it is a fact about the candidate, not about the gap.
    expect(fill.plans[0]!.recipeIds).toEqual(["r_pair"]);
    expect(fill.failed).toEqual([
      {
        itemId: "b",
        message: "recipe r_b_fast has no resolvable producer (m_missing)",
      },
    ]);
  });

  it("skips recipes the core already covered", async () => {
    const pack = fillPack();
    const coverage = emptyCoverage(pack);
    for (const id of ["r_mid", "r_left", "r_right", "r_top"])
      coverage.union.recipeIds.add(id);

    const fill = await fillGaps(pack, coverage, { max: 4 });
    expect(fill.picked.map((s) => s.id)).toEqual(["rot-alpha", "rot-zeta"]);
  });
});

describe("writeRotatingJson", () => {
  it("writes the scenario array as pretty JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stc-rotating-"));
    const path = join(dir, "nested", "rotating.json");
    const scenario: Scenario = {
      id: "rot-top",
      title: "rot-top",
      targets: [{ itemId: "top", ratePerSec: { num: "1", denom: "2" } }],
      maxDiffPixels: 0,
    };
    await writeRotatingJson(path, [scenario]);

    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual([scenario]);
  });
});
