// Second-vendor oracle: the game's own TableCfg files, vendored under
// vendor/akedata/. Nothing here writes to the pack. The extractor loads the
// snapshot, joins it to the rows it has already built, and throws on any field
// the two vendors both carry and disagree about.
//
// The join is two staged passes over the pack's recipes:
//   stage 1  single-producer craft rows, keyed on (producer, out, in)
//   stage 2  everything the craft table does not model that way: the
//            multi-producer crafts (one craft per producer) and the five
//            side tables (miner, gas miner, fluid pump, fluid consume, and
//            fuel x power station)
// What neither stage reaches is unmatched by design: the domain-transfer,
// coupon and gate recipes have no table rows at all.

import { resolve } from "node:path";
import {
  TRANSPORT_KIND,
  type EnvironmentId,
  type Item,
  type Machine,
  type Recipe,
  type TransportKindId,
} from "./schema.ts";

// AKEData entity tables carry bare int64 ids that exceed the JS safe-integer
// range, so they are quoted before JSON.parse. This is the regex the site's own
// loader uses.
const INT64_ID = /("id"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g;

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const AKEDATA_DIR = resolve(REPO_ROOT, "vendor/akedata");

// Item ids correspond after this prefix is stripped from the AKEData side.
const ITEM_PREFIX = "item_";

// Pack item id -> AKEData id without the ITEM_PREFIX. Everything else matches
// by name.
const ITEM_ALIASES: Record<string, string> = {
  "iron_bottle-liquid_plant_grass_1": "fbottle_iron_grass_1",
  "iron_bottle-liquid_plant_grass_2": "fbottle_iron_grass_2",
  "copper_bottle-liquid_plant_grass_1": "fbottle_copper_grass_1",
  "copper_bottle-liquid_plant_grass_2": "fbottle_copper_grass_2",
};

// Pack machine id -> AKEData id. The remaining machine ids are identical.
const MACHINE_ALIASES: Record<string, string> = {
  cmpt_mc_1: "component_mc_1",
  tools_asm_mc_1: "tools_assebling_mc_1",
  phase_trans_1: "transmuter_1",
  phase_trans_2: "transmuter_2",
  seedcol_1: "seedcollector_1",
  filling_pd_mc_1: "filling_powder_mc_1",
  power_sta_1: "power_station_1",
};

// The pack's transport phases, by FactoryItemTable.phaseType.
const TRANSPORT_KIND_BY_PHASE: Record<number, TransportKindId> = {
  1: TRANSPORT_KIND.BELT,
  2: TRANSPORT_KIND.PIPE,
  4: TRANSPORT_KIND.GAS,
};

// The atmosphere a craft demands, by FactoryMachineCraftTable.gasEnv; 0 means
// any. FactoryVaporizerTable spells the whole enum (1 inert, 2 water, 3 acid,
// 4 xiranite), but only these two carry a craft today and the pack has no
// spelling for the other two, so an unlisted value throws.
const ENVIRONMENT_BY_GAS_ENV: Record<number, EnvironmentId> = {
  1: "stable",
  3: "acidic",
};

// The domain that maps to the pack's jinlong location. domain_1 is tundra and
// is carried only by buildings the pack does not ship.
const JINLONG_DOMAIN = "domain_2";
const TUNDRA_DOMAIN = "domain_1";

// Every domain-transfer recipe hands back the same hub value, so the output
// quantity is a function of the item's FactoryItemTable value.
const DOMAIN_TRANSFER_MACHINE = "__domain_transfer";
const DOMAIN_TRANSFER_VALUE = 1500;

// Tundra hub items that the pack does not sell back through the transfer.
const DOMAIN_TRANSFER_EXCLUDED: readonly string[] = [
  "originium_ore",
  "quartz_sand",
  "iron_ore",
];

const MS_PER_SECOND = 1000;

// The only pack rows the snapshot has no counterpart for. Everything else must
// join: a snapshot row that disappears would otherwise quietly drop its row out
// of the stack, phase, power, location and size assertions while every count
// below stays green, so the sets are asserted rather than reported.
const UNJOINED_ITEMS: readonly string[] = [
  "domain_key_tundra",
  "jinlong_coupon",
  "tundra_coupon",
];

const UNJOINED_MACHINES: readonly string[] = [
  "__domain_transfer",
  "liquid_clean_gate",
  "liquid_recycle_gate",
  "settlement-jinlong",
  "settlement-jinlong_coupon",
  "settlement-tundra",
  "settlement-tundra_coupon",
];

export interface AkeSource {
  name: string;
  repo: string;
  version: string;
  gameVersion: string;
  hotfixVersion: string;
  tableCfgPath: string;
  publishedAt: string;
  snapshotDate: string;
}

interface AkeCraftGroupEntry {
  group: { id: string; count: number }[];
}

export interface AkeCraft {
  machineId: string;
  formulaGroupId: string;
  progressRound: number;
  gasEnv: number;
  ingredients: AkeCraftGroupEntry[];
  outcomes: AkeCraftGroupEntry[];
}

export interface AkeCraftGroup {
  msPerRound: number;
}

export interface AkeItem {
  maxBackpackStackCount: number;
}

export interface AkeFactoryItem {
  phaseType: number;
  value: number;
  showInHubDomainIds: string[];
}

export interface AkeBuilding {
  needPower: boolean;
  powerConsume: number;
  recommendDomains: string[];
  range: { width: number; depth: number };
}

interface AkeMineable {
  miningItemId: string;
  produceRate: number;
}

export interface AkeMiner {
  msPerRound: number;
  mineable: AkeMineable[];
}

export interface AkeFluidPump {
  msPerRound: number;
  enableLiquidIds: string[];
}

export interface AkeFluidConsume {
  msPerRound: number;
  liquidable: string[];
}

export interface AkePowerStation {
  msPerRound: number;
}

export interface AkeFuelItem {
  progressRound: number;
  powerProvide: number;
}

export interface AkeSnapshot {
  source: AkeSource;
  items: Record<string, AkeItem>;
  factoryItems: Record<string, AkeFactoryItem>;
  buildings: Record<string, AkeBuilding>;
  crafts: Record<string, AkeCraft>;
  craftGroups: Record<string, AkeCraftGroup>;
  miners: Record<string, AkeMiner>;
  gasMiners: Record<string, AkeMiner>;
  fluidPumps: Record<string, AkeFluidPump>;
  fluidConsumers: Record<string, AkeFluidConsume>;
  powerStations: Record<string, AkePowerStation>;
  fuelItems: Record<string, AkeFuelItem>;
}

export interface AkeJoin {
  // pack recipe id -> craft id, matched on the exact (producer, out, in) key.
  crafts: Map<string, string>;
  // pack recipe id -> one craft id per producer, for the multi-producer rows
  // stage 2 resolves. Those ids are absent from `crafts`, which holds the
  // single-producer matches only.
  producerCrafts: Map<string, string[]>;
  // pack recipe id -> the table that resolved it, for the rows stage 1 leaves.
  sideTable: Map<string, string>;
  // Recipes no table models: domain transfer, coupon exchange, purification gate.
  unmatchedRecipes: string[];
  unmatchedItems: string[];
  unmatchedMachines: string[];
  // Always empty on a successful join: an ambiguous recipe throws.
  ambiguous: string[];
}

export async function loadAkeData(): Promise<AkeSnapshot> {
  const source = (await Bun.file(
    resolve(AKEDATA_DIR, "SOURCE.json"),
  ).json()) as AkeSource;
  const dir = resolve(
    AKEDATA_DIR,
    source.gameVersion,
    source.hotfixVersion,
    "TableCfg",
  );

  return {
    source,
    items: await readTable<AkeItem>(dir, "ItemTable"),
    factoryItems: await readTable<AkeFactoryItem>(dir, "FactoryItemTable"),
    buildings: await readTable<AkeBuilding>(dir, "FactoryBuildingTable"),
    crafts: await readTable<AkeCraft>(dir, "FactoryMachineCraftTable"),
    craftGroups: await readTable<AkeCraftGroup>(
      dir,
      "FactoryMachineCraftGroupTable",
    ),
    miners: await readTable<AkeMiner>(dir, "FactoryMinerTable"),
    gasMiners: await readTable<AkeMiner>(dir, "FactoryGasMinerTable"),
    fluidPumps: await readTable<AkeFluidPump>(dir, "FactoryFluidPumpInTable"),
    fluidConsumers: await readTable<AkeFluidConsume>(
      dir,
      "FactoryFluidConsumeTable",
    ),
    powerStations: await readTable<AkePowerStation>(
      dir,
      "FactoryPowerStationTable",
    ),
    fuelItems: await readTable<AkeFuelItem>(dir, "FactoryFuelItemTable"),
  };
}

async function readTable<T>(
  dir: string,
  name: string,
): Promise<Record<string, T>> {
  const raw = await Bun.file(resolve(dir, `${name}.json`)).text();
  return JSON.parse(raw.replace(INT64_ID, '$1"$2"')) as Record<string, T>;
}

export function akeItemId(packId: string): string {
  return ITEM_PREFIX + (ITEM_ALIASES[packId] ?? packId);
}

export function akeMachineId(packId: string): string {
  return MACHINE_ALIASES[packId] ?? packId;
}

// The transport phase the game gives one pack item, or undefined when the
// snapshot has no factory-item row for it. A phase the pack cannot spell throws:
// the item would otherwise ship on a carrier the game does not put it on.
export function akeTransportKind(
  packId: string,
  ake: AkeSnapshot,
): TransportKindId | undefined {
  const row = ake.factoryItems[akeItemId(packId)];
  if (!row) return undefined;

  const kind = TRANSPORT_KIND_BY_PHASE[row.phaseType];
  if (!kind) {
    throw new Error(
      `item ${packId} has unknown akedata phaseType ${row.phaseType}`,
    );
  }
  return kind;
}

// Join the built pack to the snapshot and assert every field both vendors
// carry. Throws on the first disagreement, naming the row and both values.
// Synthetic pack rows (the gas_pipe carrier, any __ id) have no AKEData
// counterpart and fall out as unmatched rather than needing a skip list.
export function joinAndAssert(
  pack: { items: Item[]; machines: Machine[]; recipes: Recipe[] },
  ake: AkeSnapshot,
): AkeJoin {
  const join = joinRecipes(pack.recipes, ake);
  assertItems(pack.items, ake, join);
  assertMachines(pack.machines, ake, join);
  assertUnjoined("items", join.unmatchedItems, UNJOINED_ITEMS);
  assertUnjoined("machines", join.unmatchedMachines, UNJOINED_MACHINES);
  assertDomainTransfer(pack.items, pack.recipes, ake);
  return join;
}

// The atmosphere requirement of every craft that declares one, keyed by pack
// recipe id. It reads the join rather than the craft table alone, so it runs
// after joinAndAssert; a craft demanding an atmosphere the pack cannot name, or
// which no pack recipe matched, fails the extract rather than losing the
// requirement silently.
export function deriveEnvironments(
  ake: AkeSnapshot,
  join: AkeJoin,
): Map<string, EnvironmentId> {
  const recipeByCraft = new Map<string, string>();
  for (const [recipeId, craftId] of join.crafts) {
    recipeByCraft.set(craftId, recipeId);
  }
  for (const [recipeId, craftIds] of join.producerCrafts) {
    for (const craftId of craftIds) recipeByCraft.set(craftId, recipeId);
  }

  const environments = new Map<string, EnvironmentId>();
  // The craft this recipe's atmosphere was read off, so a second craft that
  // disagrees can name it.
  const readFrom = new Map<string, string>();

  for (const [craftId, craft] of Object.entries(ake.crafts)) {
    const environment = craftEnvironment(craftId, craft);
    const recipeId = recipeByCraft.get(craftId);
    if (!recipeId) {
      if (!environment) continue;
      throw new Error(
        `craft ${craftId} demands a ${environment} atmosphere but matches no pack recipe`,
      );
    }

    // A multi-producer recipe matches one craft per producer, and the pack
    // carries a single environment per recipe, so the crafts have to agree.
    const first = readFrom.get(recipeId);
    if (first === undefined) {
      readFrom.set(recipeId, craftId);
      if (environment) environments.set(recipeId, environment);
      continue;
    }
    if (environments.get(recipeId) !== environment) {
      throw new Error(
        `recipe ${recipeId} joins crafts ${first} and ${craftId} with different atmospheres`,
      );
    }
  }
  return environments;
}

function craftEnvironment(
  craftId: string,
  craft: AkeCraft,
): EnvironmentId | undefined {
  if (craft.gasEnv === 0) return undefined;

  const environment = ENVIRONMENT_BY_GAS_ENV[craft.gasEnv];
  if (!environment) {
    throw new Error(
      `craft ${craftId} has unknown akedata gasEnv ${craft.gasEnv}`,
    );
  }
  return environment;
}

function assertUnjoined(
  kind: string,
  actual: string[],
  expected: readonly string[],
): void {
  const missing = actual.filter((id) => !expected.includes(id));
  const joined = expected.filter((id) => !actual.includes(id));
  if (missing.length === 0 && joined.length === 0) return;

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`no akedata row for ${missing.sort().join(", ")}`);
  }
  if (joined.length > 0) {
    parts.push(`unexpectedly joined ${joined.slice().sort().join(", ")}`);
  }
  throw new Error(`akedata ${kind} join: ${parts.join("; ")}`);
}

function joinRecipes(recipes: Recipe[], ake: AkeSnapshot): AkeJoin {
  const craftIndex = indexCrafts(ake);
  const join: AkeJoin = {
    crafts: new Map(),
    producerCrafts: new Map(),
    sideTable: new Map(),
    unmatchedRecipes: [],
    unmatchedItems: [],
    unmatchedMachines: [],
    ambiguous: [],
  };

  for (const r of recipes) {
    const key = stoichKey(r);
    const producers = r.producers.map(akeMachineId);

    if (producers.length === 1) {
      const hits = craftIndex.get(`${producers[0]}|${key}`) ?? [];
      if (hits.length > 1) join.ambiguous.push(r.id);
      if (hits.length === 1) {
        const craftId = hits[0]!;
        join.crafts.set(r.id, craftId);
        assertCraftTime(r, craftId, ake);
        continue;
      }
    }

    // Stage 2. A recipe with N producers claims one craft per producer, which
    // is how the mix-pool rows are modelled; the remaining leftovers live in
    // the side tables.
    const perProducer = producers.map(
      (p) => craftIndex.get(`${p}|${key}`) ?? [],
    );
    if (producers.length > 1 && perProducer.every((h) => h.length === 1)) {
      for (const hits of perProducer) assertCraftTime(r, hits[0]!, ake);
      join.producerCrafts.set(
        r.id,
        perProducer.map((hits) => hits[0]!),
      );
      join.sideTable.set(r.id, "FactoryMachineCraftTable");
      continue;
    }

    const table = matchSideTable(r, producers, ake);
    if (table) join.sideTable.set(r.id, table);
    else join.unmatchedRecipes.push(r.id);
  }

  // A recipe matching two crafts means the join key no longer identifies a
  // craft, so every assertion below it would silently stop running.
  if (join.ambiguous.length > 0) {
    throw new Error(
      `akedata join is ambiguous for ${join.ambiguous.join(", ")}`,
    );
  }
  return join;
}

function indexCrafts(ake: AkeSnapshot): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [craftId, craft] of Object.entries(ake.crafts)) {
    const key = `${craft.machineId}|${flatKey(craft.outcomes)}|${flatKey(craft.ingredients)}`;
    const bucket = index.get(key);
    if (bucket) bucket.push(craftId);
    else index.set(key, [craftId]);
  }
  return index;
}

function flatKey(groups: AkeCraftGroupEntry[]): string {
  const entries: string[] = [];
  for (const g of groups ?? []) {
    for (const e of g.group) entries.push(`${e.id}*${e.count}`);
  }
  return entries.sort().join(",");
}

// The pack-side half of the craft key: the outputs and inputs as sorted
// multisets. The catalyst side is deliberately absent - the extractor lifts the
// transmuter charge off `in`, which is exactly the shape the craft table has.
function stoichKey(r: Recipe): string {
  const side = (rows: { item: string; qty: number }[]) =>
    rows
      .map((s) => `${akeItemId(s.item)}*${s.qty}`)
      .sort()
      .join(",");
  return `${side(r.out)}|${side(r.in)}`;
}

function assertCraftTime(r: Recipe, craftId: string, ake: AkeSnapshot): void {
  const craft = ake.crafts[craftId]!;
  const group = ake.craftGroups[craft.formulaGroupId];
  if (!group) {
    throw new Error(
      `recipe ${r.id} matches craft ${craftId} whose group ${craft.formulaGroupId} is missing`,
    );
  }
  assertTime(r, (craft.progressRound * group.msPerRound) / MS_PER_SECOND);
}

function assertTime(r: Recipe, expected: number): void {
  if (r.time !== expected) {
    throw new Error(
      `recipe ${r.id} time ${r.time} disagrees with akedata ${expected}`,
    );
  }
}

// Resolve one stage-2 recipe against the side tables, asserting the duration
// (and, for the power station, the generated usage) each table implies.
// Returns the table name, or undefined when no table models the recipe.
function matchSideTable(
  r: Recipe,
  producers: string[],
  ake: AkeSnapshot,
): string | undefined {
  // The extraction tables are keyed on what the machine produces; the consumer
  // and power tables on what it takes in. Either side can be empty - a power
  // recipe has no output and a miner recipe has no input - so each branch only
  // reads the side its table is keyed on.
  const out = r.out[0];
  const outId = out ? akeItemId(out.item) : undefined;
  const input = r.in[0];
  const inputId = input ? akeItemId(input.item) : undefined;

  if (outId !== undefined && producers.every((p) => ake.miners[p])) {
    const rates = producers.map((p) =>
      ake.miners[p]!.mineable.find((m) => m.miningItemId === outId),
    );
    if (rates.some((m) => !m)) return undefined;
    for (const [i, m] of rates.entries()) {
      assertTime(
        r,
        ake.miners[producers[i]!]!.msPerRound / m!.produceRate / MS_PER_SECOND,
      );
    }
    return "FactoryMinerTable";
  }

  if (outId !== undefined && producers.every((p) => ake.gasMiners[p])) {
    const rows = producers.map((p) => ake.gasMiners[p]!);
    if (!rows.every((g) => g.mineable.some((m) => m.miningItemId === outId))) {
      return undefined;
    }
    for (const g of rows) assertTime(r, g.msPerRound / MS_PER_SECOND);
    return "FactoryGasMinerTable";
  }

  if (outId !== undefined && producers.every((p) => ake.fluidPumps[p])) {
    const rows = producers.map((p) => ake.fluidPumps[p]!);
    if (!rows.every((p) => p.enableLiquidIds.includes(outId))) return undefined;
    for (const p of rows) assertTime(r, p.msPerRound / MS_PER_SECOND);
    return "FactoryFluidPumpInTable";
  }

  if (inputId === undefined) return undefined;

  if (producers.every((p) => ake.fluidConsumers[p])) {
    const rows = producers.map((p) => ake.fluidConsumers[p]!);
    if (!rows.every((c) => c.liquidable.includes(inputId))) return undefined;
    for (const c of rows) assertTime(r, c.msPerRound / MS_PER_SECOND);
    return "FactoryFluidConsumeTable";
  }

  if (producers.every((p) => ake.powerStations[p])) {
    const fuel = ake.fuelItems[inputId];
    if (!fuel) return undefined;
    for (const p of producers) {
      assertTime(
        r,
        (fuel.progressRound * ake.powerStations[p]!.msPerRound) / MS_PER_SECOND,
      );
    }
    const usage = -fuel.powerProvide;
    if (r.usage !== usage) {
      throw new Error(
        `recipe ${r.id} usage ${r.usage} disagrees with akedata ${usage}`,
      );
    }
    return "FactoryFuelItemTable";
  }

  return undefined;
}

function assertItems(items: Item[], ake: AkeSnapshot, join: AkeJoin): void {
  for (const item of items) {
    const id = akeItemId(item.id);
    const row = ake.items[id];
    const factoryRow = ake.factoryItems[id];
    if (!row || !factoryRow) {
      join.unmatchedItems.push(item.id);
      continue;
    }

    // A zero backpack stack is how the game spells "this item is a fluid", and
    // the pack spells the same thing by leaving stack absent.
    const stack =
      row.maxBackpackStackCount === 0 ? undefined : row.maxBackpackStackCount;
    if (item.stack !== stack) {
      throw new Error(
        `item ${item.id} stack ${item.stack} disagrees with akedata ${stack}`,
      );
    }

    const kind = akeTransportKind(item.id, ake);
    if (item.transportKind !== kind) {
      throw new Error(
        `item ${item.id} transportKind ${item.transportKind} disagrees with akedata ${kind}`,
      );
    }
  }
}

function assertMachines(
  machines: Machine[],
  ake: AkeSnapshot,
  join: AkeJoin,
): void {
  for (const machine of machines) {
    const row = ake.buildings[akeMachineId(machine.id)];
    if (!row) {
      join.unmatchedMachines.push(machine.id);
      continue;
    }

    const powerType = row.needPower ? "electric" : "burner";
    if (machine.powerType !== powerType) {
      throw new Error(
        `machine ${machine.id} powerType ${machine.powerType} disagrees with akedata ${powerType}`,
      );
    }

    // A burner draws no grid power at all, which the pack spells as null while
    // the table spells it as a powerConsume of 0.
    const powerKw = row.needPower ? row.powerConsume : null;
    if (machine.powerKw !== powerKw) {
      throw new Error(
        `machine ${machine.id} powerKw ${machine.powerKw} disagrees with akedata ${powerKw}`,
      );
    }

    assertLocations(machine, row);

    // Every building the table ships has a footprint, so a joined machine that
    // lacks one is a disagreement like any other.
    const size = [row.range.width, row.range.depth];
    if (
      machine.size === undefined ||
      machine.size[0] !== size[0] ||
      machine.size[1] !== size[1]
    ) {
      throw new Error(
        `machine ${machine.id} size ${machine.size?.join("x") ?? "absent"} disagrees with akedata ${size.join("x")}`,
      );
    }
  }
}

function assertLocations(machine: Machine, row: AkeBuilding): void {
  const domains = row.recommendDomains;
  const restricted = domains.length === 1 && domains[0] === JINLONG_DOMAIN;
  if (domains.length > 0 && !restricted) {
    throw new Error(
      `machine ${machine.id} has unexpected akedata recommendDomains ${domains.join(", ")}`,
    );
  }

  const locations = machine.locations ?? [];
  const expected = restricted ? ["jinlong"] : [];
  if (locations.join(",") !== expected.join(",")) {
    throw new Error(
      `machine ${machine.id} locations ${locations.join(", ")} disagree with akedata ${expected.join(", ")}`,
    );
  }
}

// The domain transfer sells an item back to the hub for a fixed value, so both
// the per-recipe quantity and the set of items it covers are derivable.
function assertDomainTransfer(
  items: Item[],
  recipes: Recipe[],
  ake: AkeSnapshot,
): void {
  const transferred = new Set<string>();
  for (const r of recipes) {
    if (!r.producers.includes(DOMAIN_TRANSFER_MACHINE)) continue;
    const out = r.out[0];
    if (!out || r.out.length !== 1) {
      throw new Error(`recipe ${r.id} is a domain transfer without one output`);
    }
    transferred.add(out.item);

    const row = ake.factoryItems[akeItemId(out.item)];
    if (!row) {
      throw new Error(
        `recipe ${r.id} transfers ${out.item}, which has no akedata row`,
      );
    }
    const value = out.qty * row.value;
    if (value !== DOMAIN_TRANSFER_VALUE) {
      throw new Error(
        `recipe ${r.id} transfers ${value} of hub value, not ${DOMAIN_TRANSFER_VALUE}`,
      );
    }
  }

  const expected = new Set(
    items
      .filter((i) => !DOMAIN_TRANSFER_EXCLUDED.includes(i.id))
      .filter((i) =>
        ake.factoryItems[akeItemId(i.id)]?.showInHubDomainIds.includes(
          TUNDRA_DOMAIN,
        ),
      )
      .map((i) => i.id),
  );
  for (const id of expected) {
    if (!transferred.has(id)) {
      throw new Error(`item ${id} is a hub item with no domain transfer`);
    }
  }
  for (const id of transferred) {
    if (!expected.has(id)) {
      throw new Error(`item ${id} has a domain transfer but is not a hub item`);
    }
  }
}
