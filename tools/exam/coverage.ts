// Render-exam corpus coverage CLI.
// Usage:
//   bun run tools/exam/coverage.ts [--all | --scenarios <json>]
//                                  [--json] [--hashes <path>]
//
// Solves every scenario in the selected set headlessly (no browser, no
// layout), reads what each solved render plan actually exercises, and diffs
// the union against the shipped recipe pack. With no selector it runs the
// fixed core in CORE_SCENARIO_IDS; --all runs every entry in the e2e
// SCENARIOS list; --scenarios takes an inline JSON array in the Scenario
// shape.
//
// Coverage is measured on the pre-layout render plan, so what it reports is
// what the graph contains, never how the graph was placed. A recipe counts as
// covered only when the solution runs it; being reachable is not enough.
//
// Every run also rewrites the hash ledger (--hashes, default
// .artifacts/exam/hashes.tsv) with the pack fingerprint and the share hash of
// each scenario it just measured, so the capture step can replay exactly the
// plans this report describes.
//
// Exit codes:
//   0  report printed
//   1  bad flags or a solve that threw

import Fraction from "fraction.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Machine, Recipe, RecipePack } from "@aef/schema";
import { pack as shippedPack } from "../../src/data/load";
import { defaultTransportConfig } from "../../src/data/transport-config";
import { renderPlanFromSolve } from "../../src/pipeline/driver";
import {
  isInputProductUnit,
  isRecipeUnit,
  type Container,
  type RenderPlan,
} from "../../src/pipeline/types";
import { isExcludedProducer } from "../../src/data/recipe-category";
import { solvePlanWithIntermediates } from "../../src/solver/index";
import {
  SCENARIOS,
  scenarioHash,
  type Scenario,
} from "../../test/e2e/scenarios";

// The four plans the exam always runs. They were picked to saturate the three
// carriers and the tap-replication shapes between them, so a rotating set can
// be judged against a fixed floor.
export const CORE_SCENARIO_IDS = [
  "default",
  "battery5-xiranite",
  "multi6",
  "gas-web",
] as const;

export const DEFAULT_HASHES_PATH = ".artifacts/exam/hashes.tsv";

export type PackFingerprint = {
  sourceCommit: string;
  gameVersion: string;
};

// Occurrence counts for the render-plan features the exam cares about.
// multiplicityTotal is an exact rational string ("n/d", or "n" when d is 1):
// machine counts are rationals before layout rounds them, and summing them as
// floats would drift a pinned figure for no gain.
export type FeatureCounts = {
  loopBoxes: number;
  loopMembers: number;
  fanoutInputs: number;
  aggregateInputs: number;
  partialStamps: number;
  multiplicityTotal: string;
};

export type PlanCoverage = {
  id: string;
  hash: string;
  recipeIds: string[];
  machineIds: string[];
  selfConsumingRecipeIds: string[];
  features: FeatureCounts;
};

export type CoverageUnion = {
  recipeIds: Set<string>;
  machineIds: Set<string>;
  selfConsumingRecipeIds: Set<string>;
};

export type CoverageReport = {
  fingerprint: PackFingerprint;
  plans: PlanCoverage[];
  union: CoverageUnion;
  featureTotals: FeatureCounts;
};

export type NamedId = { id: string; name: string };

// ---------------------------------------------------------------------------
// Pack-derived helpers
// ---------------------------------------------------------------------------

// A recipe that lists the same item on both sides. The solver nets these away
// before it builds its recipe map, so the render plan never shows the loop and
// the property has to be read off the pack.
function isSelfConsumingRecipe(recipe: Recipe): boolean {
  return recipe.in.some((i) => recipe.out.some((o) => o.item === i.item));
}

function fingerprintOf(pack: RecipePack): PackFingerprint {
  return {
    sourceCommit: pack.source.sourceCommit,
    gameVersion: pack.source.gameVersion,
  };
}

// The denominator: every recipe a plan could legitimately draw. Excluded
// producers (cross-domain transfers, sentinel-cost sinks, extractors) are
// never walked or ranked, so they would sit permanently uncovered and drown
// the real gaps.
function denominatorRecipes(pack: RecipePack): Recipe[] {
  return pack.recipes.filter((r) => !isExcludedProducer(r));
}

// Machines the denominator recipes name as producers, in pack order.
function denominatorMachines(pack: RecipePack): Machine[] {
  const named = new Set<string>();
  for (const r of denominatorRecipes(pack)) {
    for (const m of r.producers ?? []) named.add(m);
  }
  return pack.machines.filter((m) => named.has(m.id));
}

// Recipes in the denominator that the union never ran.
export function uncoveredRecipes(
  pack: RecipePack,
  union: CoverageUnion,
): NamedId[] {
  return denominatorRecipes(pack)
    .filter((r) => !union.recipeIds.has(r.id))
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Machines in the denominator that no covered recipe names as a producer.
export function uncoveredMachines(
  pack: RecipePack,
  union: CoverageUnion,
): NamedId[] {
  return denominatorMachines(pack)
    .filter((m) => !union.machineIds.has(m.id))
    .map((m) => ({ id: m.id, name: m.name }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function isLoopBox(c: Container): boolean {
  return c.kind === "loop-box";
}

function featuresOf(
  plan: RenderPlan,
  partialStamps: number,
): FeatureCounts {
  const loopBoxIds = new Set(
    plan.containers.filter(isLoopBox).map((c) => c.id),
  );
  let loopMembers = 0;
  let fanoutInputs = 0;
  let aggregateInputs = 0;
  let multiplicity = new Fraction(0);

  for (const u of plan.units) {
    if (isRecipeUnit(u)) {
      if (u.containerId !== undefined && loopBoxIds.has(u.containerId))
        loopMembers += 1;
      multiplicity = multiplicity.add(
        new Fraction(`${u.multiplicity.num}/${u.multiplicity.denom}`),
      );
    } else if (isInputProductUnit(u)) {
      if (u.isFanout) fanoutInputs += 1;
      if (u.isAggregate) aggregateInputs += 1;
    }
  }

  return {
    loopBoxes: loopBoxIds.size,
    loopMembers,
    fanoutInputs,
    aggregateInputs,
    partialStamps,
    multiplicityTotal: multiplicity.toFraction(),
  };
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

// Solve one scenario and read off what its render plan exercises. The chain is
// the app's own: targets -> solvePlanWithIntermediates -> renderPlanFromSolve,
// with no layout pass and no browser.
async function coverOne(
  pack: RecipePack,
  scenario: Scenario,
): Promise<PlanCoverage> {
  const hash = await scenarioHash(scenario);
  const full = solvePlanWithIntermediates(
    scenario.targets,
    pack,
    defaultTransportConfig,
    [],
    undefined,
  );
  const out = renderPlanFromSolve(full, pack, scenario.targets, []);

  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));
  const recipeIds = new Set<string>();
  const machineIds = new Set<string>();
  const selfConsuming = new Set<string>();

  for (const u of out.plan.units) {
    if (!isRecipeUnit(u)) continue;
    recipeIds.add(u.recipeId);
    const recipe = recipeById.get(u.recipeId);
    if (!recipe) continue;
    for (const m of recipe.producers ?? []) machineIds.add(m);
    if (isSelfConsumingRecipe(recipe)) selfConsuming.add(recipe.id);
  }

  const partialStamps = out.machineGraph.vertices.filter(
    (v) => v.kind === "machine" && v.partial === true,
  ).length;

  return {
    id: scenario.id,
    hash,
    recipeIds: sorted(recipeIds),
    machineIds: sorted(machineIds),
    selfConsumingRecipeIds: sorted(selfConsuming),
    features: featuresOf(out.plan, partialStamps),
  };
}

export async function collectCoverage(
  pack: RecipePack,
  scenarios: ReadonlyArray<Scenario>,
): Promise<CoverageReport> {
  const plans: PlanCoverage[] = [];
  for (const s of scenarios) plans.push(await coverOne(pack, s));

  const union: CoverageUnion = {
    recipeIds: new Set<string>(),
    machineIds: new Set<string>(),
    selfConsumingRecipeIds: new Set<string>(),
  };
  const totals: FeatureCounts = {
    loopBoxes: 0,
    loopMembers: 0,
    fanoutInputs: 0,
    aggregateInputs: 0,
    partialStamps: 0,
    multiplicityTotal: "0",
  };
  let multiplicity = new Fraction(0);

  for (const p of plans) {
    for (const id of p.recipeIds) union.recipeIds.add(id);
    for (const id of p.machineIds) union.machineIds.add(id);
    for (const id of p.selfConsumingRecipeIds)
      union.selfConsumingRecipeIds.add(id);
    totals.loopBoxes += p.features.loopBoxes;
    totals.loopMembers += p.features.loopMembers;
    totals.fanoutInputs += p.features.fanoutInputs;
    totals.aggregateInputs += p.features.aggregateInputs;
    totals.partialStamps += p.features.partialStamps;
    multiplicity = multiplicity.add(new Fraction(p.features.multiplicityTotal));
  }
  totals.multiplicityTotal = multiplicity.toFraction();

  return { fingerprint: fingerprintOf(pack), plans, union, featureTotals: totals };
}

// ---------------------------------------------------------------------------
// Hash ledger
// ---------------------------------------------------------------------------

// Rewrite the hash ledger: the pack fingerprint as a leading comment, then one
// "<id>\t<hash>" row per plan. Parent directories are created.
export async function writeHashesTsv(
  path: string,
  pack: RecipePack,
  rows: ReadonlyArray<{ id: string; hash: string }>,
): Promise<void> {
  const fp = fingerprintOf(pack);
  const lines = [`# pack ${fp.sourceCommit} ${fp.gameVersion}`];
  for (const r of rows) lines.push(`${r.id}\t${r.hash}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Scenario selection
// ---------------------------------------------------------------------------

// Resolve the fixed core out of the e2e list, failing loudly if an id in
// CORE_SCENARIO_IDS no longer exists rather than silently examining fewer
// plans than the core promises.
export function coreScenarios(
  all: ReadonlyArray<Scenario> = SCENARIOS,
): Scenario[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  return CORE_SCENARIO_IDS.map((id) => {
    const s = byId.get(id);
    if (!s) throw new Error(`core scenario "${id}" is not in SCENARIOS`);
    return s;
  });
}

// Parse an inline --scenarios payload. Only the fields this CLI reads are
// checked; maxDiffPixels is a screenshot budget nothing here consults, so it
// defaults to 0 when absent.
function parseScenarioJson(raw: string): Scenario[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "--scenarios value is not valid JSON";
  }
  if (!Array.isArray(parsed)) return "--scenarios value must be a JSON array";
  const out: Scenario[] = [];
  for (const [i, entry] of parsed.entries()) {
    if (typeof entry !== "object" || entry === null)
      return `--scenarios[${i}] is not an object`;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id)
      return `--scenarios[${i}] needs a non-empty string id`;
    if (!Array.isArray(e.targets) || e.targets.length === 0)
      return `--scenarios[${i}] needs a non-empty targets array`;
    for (const [j, t] of e.targets.entries()) {
      const tt = t as Record<string, unknown> | null;
      const rate = (tt?.ratePerSec ?? null) as Record<string, unknown> | null;
      if (
        typeof tt !== "object" ||
        tt === null ||
        typeof tt.itemId !== "string" ||
        typeof rate?.num !== "string" ||
        typeof rate?.denom !== "string"
      )
        return `--scenarios[${i}].targets[${j}] must be { itemId, ratePerSec: { num, denom } }`;
    }
    out.push({
      id: e.id,
      title: typeof e.title === "string" ? e.title : e.id,
      targets: e.targets as Scenario["targets"],
      maxDiffPixels:
        typeof e.maxDiffPixels === "number" ? e.maxDiffPixels : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering the report
// ---------------------------------------------------------------------------

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i] ?? 0)).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

function formatReport(
  pack: RecipePack,
  report: CoverageReport,
  hashesPath: string,
): string {
  const lines: string[] = [];
  lines.push(
    `pack ${report.fingerprint.sourceCommit} ${report.fingerprint.gameVersion}`,
  );
  lines.push("");

  lines.push("# plans");
  const header = [
    "id",
    "recipes",
    "machines",
    "loopBox",
    "loopMem",
    "fanout",
    "aggregate",
    "partial",
    "multiplicity",
  ];
  const rows = report.plans.map((p) => [
    p.id,
    String(p.recipeIds.length),
    String(p.machineIds.length),
    String(p.features.loopBoxes),
    String(p.features.loopMembers),
    String(p.features.fanoutInputs),
    String(p.features.aggregateInputs),
    String(p.features.partialStamps),
    p.features.multiplicityTotal,
  ]);
  const t = report.featureTotals;
  rows.push([
    "TOTAL",
    String(report.union.recipeIds.size),
    String(report.union.machineIds.size),
    String(t.loopBoxes),
    String(t.loopMembers),
    String(t.fanoutInputs),
    String(t.aggregateInputs),
    String(t.partialStamps),
    t.multiplicityTotal,
  ]);
  lines.push(...table(header, rows));
  lines.push("");

  const recipeDenom = denominatorRecipes(pack);
  const machineDenom = denominatorMachines(pack);
  const selfDenom = recipeDenom.filter(isSelfConsumingRecipe);
  const missRecipes = uncoveredRecipes(pack, report.union);
  const missMachines = uncoveredMachines(pack, report.union);

  lines.push("# union");
  lines.push(`recipes ${report.union.recipeIds.size}/${recipeDenom.length}`);
  lines.push(`machines ${report.union.machineIds.size}/${machineDenom.length}`);
  lines.push(
    `selfConsuming ${report.union.selfConsumingRecipeIds.size}/${selfDenom.length}`,
  );
  lines.push("");

  lines.push(`# uncovered recipes (${missRecipes.length})`);
  lines.push(...table(["id", "name"], missRecipes.map((r) => [r.id, r.name])));
  lines.push("");

  lines.push(`# uncovered machines (${missMachines.length})`);
  lines.push(...table(["id", "name"], missMachines.map((m) => [m.id, m.name])));
  lines.push("");

  lines.push(`hashes ${hashesPath}`);
  return lines.join("\n");
}

function toJson(
  pack: RecipePack,
  report: CoverageReport,
  hashesPath: string,
): string {
  return JSON.stringify(
    {
      pack: report.fingerprint,
      hashesPath,
      plans: report.plans,
      union: {
        recipeIds: sorted(report.union.recipeIds),
        machineIds: sorted(report.union.machineIds),
        selfConsumingRecipeIds: sorted(report.union.selfConsumingRecipeIds),
      },
      featureTotals: report.featureTotals,
      denominators: {
        recipes: denominatorRecipes(pack).length,
        machines: denominatorMachines(pack).length,
        selfConsuming: denominatorRecipes(pack).filter(isSelfConsumingRecipe)
          .length,
      },
      uncoveredRecipes: uncoveredRecipes(pack, report.union),
      uncoveredMachines: uncoveredMachines(pack, report.union),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function runCli(argv: string[]): Promise<string> {
  let all = false;
  let json = false;
  let scenariosJson: string | undefined;
  let hashesPath = DEFAULT_HASHES_PATH;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") {
      all = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--scenarios") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        return "error: --scenarios requires a value";
      scenariosJson = argv[++i];
    } else if (a === "--hashes") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        return "error: --hashes requires a value";
      hashesPath = argv[++i]!;
    } else {
      return `error: unknown argument "${a}"`;
    }
  }

  if (all && scenariosJson !== undefined)
    return "error: provide at most one of --all or --scenarios";

  let scenarios: Scenario[];
  if (scenariosJson !== undefined) {
    const parsed = parseScenarioJson(scenariosJson);
    if (typeof parsed === "string") return `error: ${parsed}`;
    scenarios = parsed;
  } else if (all) {
    scenarios = [...SCENARIOS];
  } else {
    scenarios = coreScenarios();
  }

  const report = await collectCoverage(shippedPack, scenarios);
  await writeHashesTsv(hashesPath, shippedPack, report.plans);
  return json
    ? toJson(shippedPack, report, hashesPath)
    : formatReport(shippedPack, report, hashesPath);
}

if (import.meta.main) {
  runCli(process.argv.slice(2))
    .then((out) => {
      console.log(out);
      if (out.startsWith("error:")) process.exit(1);
    })
    .catch((err: unknown) => {
      console.error("fatal:", err);
      process.exit(1);
    });
}
