// Render-exam corpus coverage CLI.
// Usage:
//   bun run tools/exam/coverage.ts [--all | --scenarios <json>]
//                                  [--json] [--hashes <path>]
//                                  [--fill [--max <n>] [--out <path>]]
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
// --fill then greedily grows a rotating set on top of that floor: it targets
// the outputs the uncovered recipes make, solves each once, and repeatedly
// takes whichever single-target plan brings in the most still-uncovered
// recipes. The picks land in --out (default .artifacts/exam/rotating.json) and
// are appended to the ledger after the core rows. Whatever stays uncovered is
// printed as a residue with the reason it could not be reached, alongside how
// much of that residue a larger --max would still have reached. A candidate
// whose solve throws is listed and skipped, never fatal.
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
import {
  isExcludedProducer,
  isSinkRecipe,
  producibleItemIds,
} from "../../src/data/recipe-category";
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
export const DEFAULT_ROTATING_PATH = ".artifacts/exam/rotating.json";

// How many rotating plans a fill run may add on top of the core.
export const DEFAULT_FILL_MAX = 4;

// The rate every rotating plan asks for: 30/min, the modal rate across the
// existing corpus, as the exact rational the wire format carries.
const FILL_RATE = { num: "1", denom: "2" } as const;

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

// Write the rotating scenario set: a JSON array in the Scenario shape, ready
// to hand back to --scenarios or to a capture run. Parent directories are
// created.
export async function writeRotatingJson(
  path: string,
  scenarios: ReadonlyArray<Scenario>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(scenarios, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Gap filling
// ---------------------------------------------------------------------------

// Why a still-uncovered recipe stayed that way.
export type ResidueReason =
  // A candidate solve made one of this recipe's outputs and ran something else
  // to do it. The recipe is reachable; the LP just never prefers it.
  | "LP prefers another producer"
  // No candidate plan brought the recipe in, and none produced its output by
  // another route either.
  | "no candidate scored"
  // Every candidate item this recipe offers threw when solved.
  | "candidate solve failed";

export type ResidueEntry = NamedId & { reason: ResidueReason };

// A candidate whose solve threw. Non-fatal, but reported: a silent skip hides
// a broken pack entry behind a residue line that blames the LP.
export type FailedCandidate = { itemId: string; message: string };

export type FillOptions = {
  // Cap on rotating plans. Defaults to DEFAULT_FILL_MAX.
  max?: number;
};

export type FillResult = {
  // The rotating plans, in pick order.
  picked: Scenario[];
  // What each pick exercises, same order and ids as picked.
  plans: PlanCoverage[];
  // Recipes still uncovered after the picks, by id, with the reason.
  residue: ResidueEntry[];
  // Candidates whose solve threw, in item id order.
  failed: FailedCandidate[];
  // How many "no candidate scored" residue recipes some unpicked candidate's
  // solution already runs. Those are not unreachable, only out of budget: the
  // three reason classes describe the run, this counts what a larger --max
  // would reach.
  reachableByUnpicked: number;
};

// One rotating plan: a single target for one item at the corpus-modal rate.
// The title feeds the share hash, so it is the id and nothing else - a title
// derived from pack text would move the hash whenever the pack renamed a thing.
function rotatingScenario(itemId: string): Scenario {
  const id = `rot-${itemId}`;
  return {
    id,
    title: id,
    targets: [{ itemId, ratePerSec: { ...FILL_RATE } }],
    maxDiffPixels: 0,
  };
}

// The items one recipe offers a rotating plan to aim a rate at: its positive
// outputs, minus anything outside producibleItemIds (what the plan loader
// itself accepts as a target). A sink recipe offers none - it has no outputs
// at all, so the guard is intent rather than arithmetic.
function candidateItemsOf(
  recipe: Recipe,
  producible: ReadonlySet<string>,
): string[] {
  if (isSinkRecipe(recipe)) return [];
  return recipe.out
    .filter((o) => o.qty > 0 && producible.has(o.item))
    .map((o) => o.item);
}

// Every item a rotating plan may target: the candidate items of the recipes
// the core left uncovered. Sorted, so every downstream tie-break is stable.
function candidateItems(
  pack: RecipePack,
  uncovered: ReadonlySet<string>,
  producible: ReadonlySet<string>,
): string[] {
  const items = new Set<string>();
  for (const r of pack.recipes) {
    if (!uncovered.has(r.id)) continue;
    for (const item of candidateItemsOf(r, producible)) items.add(item);
  }
  return [...items].sort();
}

// Greedy set cover over the recipes the core missed.
//
// Every candidate is solved once up front: a candidate's solution does not
// change as picks accumulate, only its score against the shrinking uncovered
// set does. Each solve keeps only its PlanCoverage summary; the render plan
// behind it is dropped before the next candidate runs, so a hundred-candidate
// sweep never holds a hundred solutions.
export async function fillGaps(
  pack: RecipePack,
  coverage: CoverageReport,
  opts: FillOptions = {},
): Promise<FillResult> {
  const max = opts.max ?? DEFAULT_FILL_MAX;
  const producible = producibleItemIds(pack.recipes);
  const remaining = new Set(
    uncoveredRecipes(pack, coverage.union).map((r) => r.id),
  );
  const items = candidateItems(pack, remaining, producible);

  const solved = new Map<string, PlanCoverage>();
  const failed: FailedCandidate[] = [];
  for (const itemId of items) {
    try {
      solved.set(itemId, await coverOne(pack, rotatingScenario(itemId)));
    } catch (err: unknown) {
      failed.push({
        itemId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const picked: Scenario[] = [];
  const plans: PlanCoverage[] = [];
  const taken = new Set<string>();
  while (picked.length < max) {
    let bestItem: string | undefined;
    let bestScore = 0;
    // items is sorted and the comparison is strict, so a tie keeps the
    // lexicographically first item and the run stays byte-identical.
    for (const itemId of items) {
      if (taken.has(itemId)) continue;
      const cov = solved.get(itemId);
      if (!cov) continue;
      let score = 0;
      for (const id of cov.recipeIds) if (remaining.has(id)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestItem = itemId;
      }
    }
    if (bestItem === undefined) break;
    taken.add(bestItem);
    const cov = solved.get(bestItem)!;
    picked.push(rotatingScenario(bestItem));
    plans.push(cov);
    for (const id of cov.recipeIds) remaining.delete(id);
  }

  const { residue, reachableByUnpicked } = classifyResidue(
    pack,
    remaining,
    solved,
    new Set(failed.map((f) => f.itemId)),
    producible,
    taken,
  );
  return { picked, plans, residue, failed, reachableByUnpicked };
}

// Label what is left. A recipe whose every candidate item threw is reported as
// a failed solve; otherwise, if any candidate solve made one of its outputs
// without running it, the LP had the choice and took another producer; failing
// both, nothing a candidate plan reached ever touched it.
//
// Those three classes describe the run, not the pack: a recipe an unpicked
// candidate would have covered lands in "no candidate scored" once --max runs
// out. Counting those separately keeps the classes as specified and still says
// how much of the residue is only a budget away.
function classifyResidue(
  pack: RecipePack,
  remaining: ReadonlySet<string>,
  solved: ReadonlyMap<string, PlanCoverage>,
  failed: ReadonlySet<string>,
  producible: ReadonlySet<string>,
  taken: ReadonlySet<string>,
): { residue: ResidueEntry[]; reachableByUnpicked: number } {
  const recipeById = new Map(pack.recipes.map((r) => [r.id, r]));

  // What each candidate solve made, so "the LP had another producer" can be
  // asked once per solve rather than re-walked per recipe.
  const madeBy: { made: Set<string>; ran: Set<string> }[] = [];
  // Everything an unpicked candidate's solution runs: the recipes a larger
  // --max could still have taken.
  const unpickedRuns = new Set<string>();
  for (const [itemId, cov] of solved) {
    const made = new Set<string>();
    for (const id of cov.recipeIds) {
      for (const o of recipeById.get(id)?.out ?? []) made.add(o.item);
    }
    madeBy.push({ made, ran: new Set(cov.recipeIds) });
    if (!taken.has(itemId))
      for (const id of cov.recipeIds) unpickedRuns.add(id);
  }

  const out: ResidueEntry[] = [];
  let reachableByUnpicked = 0;
  for (const { id, name } of denominatorRecipes(pack)
    .filter((r) => remaining.has(r.id))
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const own = candidateItemsOf(recipeById.get(id)!, producible);
    let reason: ResidueReason;
    if (own.length > 0 && own.every((i) => failed.has(i))) {
      reason = "candidate solve failed";
    } else if (
      madeBy.some((s) => !s.ran.has(id) && own.some((i) => s.made.has(i)))
    ) {
      reason = "LP prefers another producer";
    } else {
      reason = "no candidate scored";
      if (unpickedRuns.has(id)) reachableByUnpicked += 1;
    }
    out.push({ id, name, reason });
  }
  return { residue: out, reachableByUnpicked };
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
  fill: FillResult | undefined,
  rotatingPath: string,
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

  if (fill) lines.push(...fillSection(pack, fill, report.union));

  lines.push(`hashes ${hashesPath}`);
  if (fill) lines.push(`rotating ${rotatingPath}`);
  return lines.join("\n");
}

// The rotating picks and the residue. "new" is what a pick added on top of the
// core plus the picks before it, so the column sums to the coverage the whole
// rotating set bought.
function fillSection(
  pack: RecipePack,
  fill: FillResult,
  base: CoverageUnion,
): string[] {
  const lines: string[] = [];
  const covered = new Set(base.recipeIds);
  const machines = new Set(base.machineIds);

  const rows = fill.plans.map((p) => {
    const added = p.recipeIds.filter((id) => !covered.has(id));
    for (const id of added) covered.add(id);
    for (const id of p.machineIds) machines.add(id);
    return [
      p.id,
      String(p.recipeIds.length),
      String(p.machineIds.length),
      String(added.length),
    ];
  });
  lines.push(`# rotating (${fill.picked.length})`);
  lines.push(...table(["id", "recipes", "machines", "new"], rows));
  lines.push(
    `after fill: recipes ${covered.size}/${denominatorRecipes(pack).length}` +
      `  machines ${machines.size}/${denominatorMachines(pack).length}`,
  );
  lines.push("");

  if (fill.failed.length > 0) {
    lines.push(`# failed candidates (${fill.failed.length})`);
    lines.push(
      ...table(
        ["item", "error"],
        fill.failed.map((f) => [f.itemId, f.message]),
      ),
    );
    lines.push("");
  }

  const byReason = new Map<string, number>();
  for (const r of fill.residue)
    byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  lines.push(`# residue (${fill.residue.length})`);
  for (const [reason, n] of [...byReason].sort()) {
    // The budget note rides on the class it qualifies: those recipes are out of
    // budget, not out of reach.
    const note =
      reason === "no candidate scored" && fill.reachableByUnpicked > 0
        ? ` (${fill.reachableByUnpicked} reachable by an unpicked candidate; raise --max)`
        : "";
    lines.push(`${reason}: ${n}${note}`);
  }
  lines.push(
    ...table(
      ["id", "name", "reason"],
      fill.residue.map((r) => [r.id, r.name, r.reason]),
    ),
  );
  lines.push("");
  return lines;
}

function toJson(
  pack: RecipePack,
  report: CoverageReport,
  hashesPath: string,
  fill: FillResult | undefined,
  rotatingPath: string,
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
      ...(fill
        ? {
            rotating: {
              path: rotatingPath,
              scenarios: fill.picked,
              plans: fill.plans,
              residue: fill.residue,
              reachableByUnpicked: fill.reachableByUnpicked,
              failed: fill.failed,
            },
          }
        : {}),
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
  let fill = false;
  let max = DEFAULT_FILL_MAX;
  // Presence, not value: --max 4 or --out with the default path is still a
  // flag that does nothing without --fill, and should say so.
  let sawMax = false;
  let sawOut = false;
  let scenariosJson: string | undefined;
  let hashesPath = DEFAULT_HASHES_PATH;
  let rotatingPath = DEFAULT_ROTATING_PATH;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") {
      all = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--fill") {
      fill = true;
    } else if (a === "--max") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        return "error: --max requires a value";
      max = Number(argv[++i]);
      sawMax = true;
      if (!Number.isInteger(max) || max < 1)
        return "error: --max must be a positive integer";
    } else if (a === "--out") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--"))
        return "error: --out requires a value";
      rotatingPath = argv[++i]!;
      sawOut = true;
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
  if (!fill && (sawMax || sawOut))
    return "error: --max and --out only apply with --fill";

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
  const filled = fill
    ? await fillGaps(shippedPack, report, { max })
    : undefined;

  // Core rows first, then the rotating ones, so the ledger reads in the order
  // the exam runs them. Duplicate ids would make a row unaddressable, and a
  // hand-written --scenarios set can collide with the rot- names.
  const rows = [...report.plans, ...(filled?.plans ?? [])];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id))
      return `error: duplicate scenario id "${r.id}" in the hash ledger`;
    seen.add(r.id);
  }
  await writeHashesTsv(hashesPath, shippedPack, rows);
  if (filled) await writeRotatingJson(rotatingPath, filled.picked);

  return json
    ? toJson(shippedPack, report, hashesPath, filled, rotatingPath)
    : formatReport(shippedPack, report, hashesPath, filled, rotatingPath);
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
