import { resolve } from "node:path";
import Fraction from "fraction.js";
import {
  LOCALES,
  SCHEMA_VERSION,
  TRANSPORT_KIND,
  type EnvironmentBadges,
  type EnvironmentId,
  type Item,
  type Locale,
  type LocaleNames,
  type Machine,
  type Recipe,
  type RecipePack,
  type RecipePackI18n,
  type SourceProvenance,
  type Stoich,
  type Transport,
  type TransportKindId,
} from "./schema.ts";
import type { UpstreamData, UpstreamI18n, UpstreamItem, UpstreamRecipe } from "./upstream.ts";

// Curated synthetic-item substitutions. The collapse pass rewrites references
// to these synthetic ids to their real counterparts, then drops the synthetic
// items, machines, and identity recipes that backed them.
const syntheticSubstitutions: Record<string, string> = {
  __miner_water: "liquid_water",
};

// The gas carrier the game added in v1.4. Upstream models only belt and pipe, so
// the carrier that moves gas items has to be synthesized here; without it the
// referential assertion below rejects every gas item for naming a Transport.kind
// no transport declares. The icon reuses the pipe sprite because nothing renders
// Transport.icon, and the speed reuses the pipe figure as an uncalibrated
// placeholder (transport-config.json carries the same note).
const SYNTHETIC_GAS_TRANSPORT: Transport = {
  id: "gas_pipe",
  kind: TRANSPORT_KIND.GAS,
  name: "气体管道",
  icon: "pipe",
  speed: 2,
};

// Display names for the synthetic carrier. The upstream i18n files have no key
// for an id upstream does not know about, so the sidecar builder injects these
// before the per-locale coverage assertion runs.
const SYNTHETIC_GAS_TRANSPORT_NAMES: Record<Locale, string> = {
  en: "Gas Pipe",
  ja: "ガスパイプ",
  ru: "Газопровод",
  zh: "气体管道",
};

// The purification nodes the player routes into on the map. Upstream used to
// mark them with a machine-side cost === -1 skip sentinel, but dropped that
// field in v1.5.3, so the set is pinned by hand here. Every recipe whose
// producers are all in this set gets the world-node flag.
export const WORLD_NODE_MACHINES: readonly string[] = ["liquid_clean_gate", "liquid_recycle_gate"];

// The waste sinks a plan must never fund on its own. Upstream used to put
// cost === -1 on all three and now leaves that sentinel on only one of them,
// so the extractor writes it on every id listed here whatever upstream says.
// Every other upstream cost passes through verbatim.
export const SKIP_SINK_RECIPES: readonly string[] = [
  "liquid_cleaner_1-sewage",
  "liquid_cleaner_1-xiranite_lowpoly",
  "liquid_cleaner_1-xiranite_poly",
];

// Limited-time event items. The event they belonged to has ended and the items
// are no longer obtainable in game, so the extractor removes them along with
// every recipe that produces or consumes one; that way no plan can route
// through a chain the player cannot build.
const RETIRED_EVENT_PREFIX = "activity_";

// The phase transmuters cycle xiranite instead of consuming it: the machine
// holds a charge while it runs and hands it back, so the draw belongs on
// Recipe.catalyst rather than Recipe.in. Which phase of xiranite it is depends
// only on the machine, so the table is keyed by producer and applies to every
// recipe that machine is the sole producer of. Upstream has no field for this.
export const CATALYST_BY_PRODUCER: Record<string, string> = {
  phase_trans_1: "liquid_xiranite",
  phase_trans_2: "gas_xiranite",
};

// The catalyst charge every transmuter draws, per minute at machine speed 1.
// Upstream folds the charge into the ordinary input entry, and on two recipes
// it folds it into a feed draw of the same item, so the per-cycle charge
// (time * 6 / 60) has to be subtracted back out.
const CATALYST_PER_MINUTE = 6;

// Recipes the game restricts to an atmosphere. Upstream ships no environment
// field - the stable recipes are recognisable only by their inert-gas variant
// naming and the acidic one only by its in-game banner - so the set is pinned
// by hand.
export const ENVIRONMENT_BY_RECIPE: Record<string, EnvironmentId> = {
  "gas_copper_enr-gas_inert": "stable",
  "gas_xiranite_enr-gas_inert": "stable",
  "xiranite_powder-carbon_mtl": "stable",
  gas_copper_enr2: "acidic",
};

// Nothing in the data names the environments, so each badge borrows the icon of
// a recipe that already reads as that environment.
const ENVIRONMENT_BADGE_RECIPES: Record<keyof EnvironmentBadges, string> = {
  stable: "gas_copper_enr-gas_inert",
  acidic: "gas_copper_enr2",
};

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const VENDOR_PATH = "vendor/endfield-calc";
const INPUT_PATH = resolve(REPO_ROOT, VENDOR_PATH, "data.json");
const I18N_DIR = resolve(REPO_ROOT, VENDOR_PATH, "i18n");
const OUTPUT_PATH = resolve(REPO_ROOT, "data/aef/recipe-pack.json");
const I18N_OUTPUT_PATH = resolve(REPO_ROOT, "data/aef/recipe-pack.i18n.json");
const GAME_VERSION_KEY = "arknights-endfield";

export interface ExtractResult {
  pack: RecipePack;
  i18n: RecipePackI18n;
  // Sorted ids the retired-event drop removed, exposed so tests can pin them.
  droppedEventItems: string[];
  droppedEventRecipes: string[];
}

// Build the recipe-pack and i18n sidecar from the vendored upstream snapshot.
// Writes the artifacts to data/aef/ by default; pass { write: false } to build
// in-memory only (the test harness uses this so a test run never touches the
// committed artifacts).
async function main(opts: { write?: boolean } = {}): Promise<ExtractResult> {
  const write = opts.write ?? true;
  const upstream = (await Bun.file(INPUT_PATH).json()) as UpstreamData;
  const sourceMeta = (await Bun.file(resolve(REPO_ROOT, VENDOR_PATH, "SOURCE.json")).json()) as {
    repo: string;
    commit: string;
  };
  const gameVersion = upstream.version[GAME_VERSION_KEY];
  if (!gameVersion) {
    throw new Error(`upstream version key "${GAME_VERSION_KEY}" missing`);
  }

  const items: Item[] = [];
  const machines: Machine[] = [];
  const transports: Transport[] = [];

  for (const u of upstream.items) {
    const transportKinds = [u.belt && "belt", u.pipe && "pipe"].filter(Boolean);
    if (u.machine && transportKinds.length > 0) {
      throw new Error(`item ${u.id} is both a machine and a transport`);
    }
    if (transportKinds.length > 1) {
      throw new Error(`item ${u.id} declares both belt and pipe`);
    }

    if (u.machine) {
      const m: Machine = {
        id: u.id,
        name: u.name,
        icon: u.icon,
        speed: u.machine.speed,
        powerType: u.machine.type,
        powerKw: u.machine.usage ?? null,
        hideRate: u.machine.hideRate ?? false,
      };
      if (u.machine.size) m.size = [u.machine.size[0], u.machine.size[1]];
      if (u.machine.locations && u.machine.locations.length > 0) m.locations = [...u.machine.locations];
      if (u.machine.totalRecipe != null) m.totalRecipe = u.machine.totalRecipe;
      machines.push(m);
    } else if (u.belt) {
      transports.push({ id: u.id, kind: "belt", name: u.name, icon: u.icon, speed: u.belt.speed });
    } else if (u.pipe) {
      transports.push({ id: u.id, kind: "pipe", name: u.name, icon: u.icon, speed: u.pipe.speed });
    } else {
      items.push(toItem(u));
    }
  }

  transports.push({ ...SYNTHETIC_GAS_TRANSPORT });

  const upstreamRecipeIds = new Set(upstream.recipes.map((r) => r.id));
  for (const id of SKIP_SINK_RECIPES) {
    if (!upstreamRecipeIds.has(id)) {
      throw new Error(`skip-sink recipe "${id}" is missing from upstream`);
    }
  }
  for (const id of Object.keys(ENVIRONMENT_BY_RECIPE)) {
    if (!upstreamRecipeIds.has(id)) {
      throw new Error(`environment recipe "${id}" is missing from upstream`);
    }
  }

  const recipes: Recipe[] = upstream.recipes.map(toRecipe);

  const droppedEvents = dropRetiredEventRows({ items, recipes });

  const machineIds = new Set(machines.map((m) => m.id));
  for (const id of WORLD_NODE_MACHINES) {
    if (!machineIds.has(id)) {
      throw new Error(`world-node machine "${id}" is missing from upstream`);
    }
  }
  const skipMachines = new Set([
    ...WORLD_NODE_MACHINES,
    ...upstream.items.filter((u) => u.machine?.cost === -1).map((u) => u.id),
  ]);
  stampWorldNodes(recipes, skipMachines);

  const collapsed = collapseSyntheticChains({ items, machines, recipes });
  const dropped = {
    droppedMachines: collapsed.droppedMachines,
    droppedItems: new Set([...collapsed.droppedItems, ...droppedEvents.items]),
    droppedRecipes: new Set([...collapsed.droppedRecipes, ...droppedEvents.recipes]),
  };

  classifyRawItems(items, recipes);

  validateReferentialIntegrity({ items, machines, transports, recipes });

  const source: SourceProvenance = {
    name: "endfield-calc/factoriolab",
    sourceRepo: sourceMeta.repo,
    sourceCommit: sourceMeta.commit,
    gameVersion,
    extractedAt: new Date().toISOString(),
  };

  const pack: RecipePack = {
    schemaVersion: SCHEMA_VERSION,
    source,
    categories: upstream.categories.map((c) => ({ id: c.id, name: c.name, icon: c.icon })),
    locations: upstream.locations.map((l) => ({ id: l.id, name: l.name, icon: l.icon })),
    items,
    machines,
    transports,
    recipes,
    environmentBadges: buildEnvironmentBadges(upstream),
  };

  const i18n = await buildI18nSidecar(pack, source, dropped);

  if (write) {
    await Bun.write(OUTPUT_PATH, JSON.stringify(pack, null, 2) + "\n");
    await Bun.write(I18N_OUTPUT_PATH, JSON.stringify(i18n, null, 2) + "\n");

    console.log(`wrote ${OUTPUT_PATH}`);
    console.log(
      `  items=${items.length} machines=${machines.length} transports=${transports.length}` +
        ` recipes=${recipes.length} categories=${pack.categories.length} locations=${pack.locations.length}` +
        ` droppedEventItems=${droppedEvents.items.size} droppedEventRecipes=${droppedEvents.recipes.size}`,
    );
    console.log(`wrote ${I18N_OUTPUT_PATH}`);
    console.log(`  locales=${i18n.locales.join(",")}`);
    console.log(`  source: ${pack.source.name}@${sourceMeta.commit.slice(0, 12)} game=${gameVersion}`);
  }

  return {
    pack,
    i18n,
    droppedEventItems: [...droppedEvents.items].sort(),
    droppedEventRecipes: [...droppedEvents.recipes].sort(),
  };
}

// Remove the retired event items and every recipe that touches one, in place.
// Runs before the world-node stamp and the synthetic collapse so the later
// passes and the referential-integrity check only ever see surviving rows.
function dropRetiredEventRows(pack: { items: Item[]; recipes: Recipe[] }): {
  items: Set<string>;
  recipes: Set<string>;
} {
  const items = new Set(
    pack.items.filter((i) => i.id.startsWith(RETIRED_EVENT_PREFIX)).map((i) => i.id),
  );
  const recipes = new Set(
    pack.recipes
      .filter((r) => [...r.in, ...r.out].some((s) => items.has(s.item)))
      .map((r) => r.id),
  );
  pack.items.splice(0, pack.items.length, ...pack.items.filter((i) => !items.has(i.id)));
  pack.recipes.splice(0, pack.recipes.length, ...pack.recipes.filter((r) => !recipes.has(r.id)));
  return { items, recipes };
}

// Transport phase for one upstream item. Upstream carries no phase field, so the
// signals are the stack size and the id prefix: a stack size means the item rides
// a belt, and among the unstackable items the gas_ prefix separates gases from
// liquids. An unstackable item with an unrecognised prefix stays on pipe rather
// than throwing, so an upstream rename degrades to one item drawn with the wrong
// stroke instead of a failed extract.
function classifyTransportKind(u: UpstreamItem): TransportKindId {
  if (typeof u.stack === "number") return TRANSPORT_KIND.BELT;
  if (u.id.startsWith("gas_")) return TRANSPORT_KIND.GAS;
  return TRANSPORT_KIND.PIPE;
}

function toItem(u: UpstreamItem): Item {
  const item: Item = {
    id: u.id,
    name: u.name,
    category: u.category,
    icon: u.icon,
    row: u.row,
    // raw is computed after the collapse pass; default false here and let the
    // classifier overwrite it before emit.
    raw: false,
    transportKind: classifyTransportKind(u),
  };
  if (typeof u.stack === "number") item.stack = u.stack;
  if (u.buildIcon && u.buildIcon.length > 0) item.buildIcon = [...u.buildIcon];
  return item;
}

function toRecipe(u: UpstreamRecipe): Recipe {
  const inputs = toStoich(u.in);
  const catalyst = splitCatalyst(u, inputs);
  const recipe: Recipe = {
    id: u.id,
    name: u.name,
    category: u.category,
    icon: u.icon,
    row: u.row,
    time: u.time,
    in: inputs,
    out: toStoich(u.out),
    producers: [...u.producers],
  };
  if (catalyst) recipe.catalyst = catalyst;
  if (u.locations && u.locations.length > 0) recipe.locations = [...u.locations];
  if (u.flags && u.flags.length > 0) recipe.flags = [...u.flags];
  if (u.usage != null) recipe.usage = u.usage;
  if (u.cost != null) recipe.cost = u.cost;
  // The hand-pinned skip sentinel wins over whatever upstream carries.
  if (SKIP_SINK_RECIPES.includes(u.id)) recipe.cost = -1;
  const environment = ENVIRONMENT_BY_RECIPE[u.id];
  if (environment) recipe.environment = environment;
  return recipe;
}

// Lift the catalyst charge off a transmuter recipe's inputs. Mutates `inputs`:
// the charge is subtracted from the matching entry, and the entry is dropped
// when nothing is left of it. Returns undefined for every recipe the catalyst
// table does not cover. Arithmetic runs on exact rationals because the upstream
// quantities are decimals a double cannot hold (0.2, 1.2) and the charge has to
// come back out of a folded entry without drift.
export function splitCatalyst(u: UpstreamRecipe, inputs: Stoich[]): Stoich[] | undefined {
  if (u.producers.length !== 1) {
    // A transmuter that gains a second producer must not fall through as an
    // ordinary recipe: its charge would stay folded into `in` and the plan
    // would consume the cycled xiranite instead of holding it.
    const cycler = u.producers.find((p) => CATALYST_BY_PRODUCER[p] !== undefined);
    if (cycler !== undefined) {
      throw new Error(
        `recipe ${u.id} lists ${u.producers.length} producers but ${cycler} cycles a catalyst`,
      );
    }
    return undefined;
  }
  const producer = u.producers[0]!;
  const item = CATALYST_BY_PRODUCER[producer];
  if (item === undefined) return undefined;

  const index = inputs.findIndex((s) => s.item === item);
  const entry = inputs[index];
  if (!entry) {
    throw new Error(`recipe ${u.id} runs on ${producer} but draws no ${item} to cycle as catalyst`);
  }

  const charge = new Fraction(u.time).mul(CATALYST_PER_MINUTE).div(60);
  const drawn = new Fraction(entry.qty);
  if (drawn.compare(charge) < 0) {
    throw new Error(
      `recipe ${u.id} draws ${entry.qty} ${item} per cycle, below the ${charge.valueOf()} catalyst charge`,
    );
  }

  const feed = drawn.sub(charge);
  if (feed.compare(0) === 0) inputs.splice(index, 1);
  else entry.qty = feed.valueOf();

  // An input-less recipe reads as a map deposit downstream and is banned from
  // every solution, so a recipe left with nothing but its catalyst charge has
  // to fail the extract rather than disappear from the solver silently.
  if (inputs.length === 0) {
    throw new Error(`recipe ${u.id} draws nothing but its catalyst charge`);
  }

  const qty = charge.valueOf();
  // The charge is emitted as a double, so re-read it as a rational and confirm
  // the round trip still rates at exactly the catalyst draw.
  if (!new Fraction(qty).mul(60).div(u.time).equals(CATALYST_PER_MINUTE)) {
    throw new Error(`recipe ${u.id} catalyst charge ${qty} does not rate at ${CATALYST_PER_MINUTE}/min`);
  }
  return [{ item, qty }];
}

// Icon id per environment, checked against the upstream sprite sheet so a
// vendor refresh that renames or drops a sprite fails the extract instead of
// shipping a badge that renders as a hole.
function buildEnvironmentBadges(upstream: UpstreamData): EnvironmentBadges {
  const iconIds = new Set(upstream.icons.map((i) => i.id));
  const byRecipeId = new Map(upstream.recipes.map((r) => [r.id, r]));
  const badges = {} as EnvironmentBadges;
  for (const [environment, recipeId] of Object.entries(ENVIRONMENT_BADGE_RECIPES) as [
    keyof EnvironmentBadges,
    string,
  ][]) {
    const recipe = byRecipeId.get(recipeId);
    if (!recipe) throw new Error(`environment badge recipe "${recipeId}" is missing from upstream`);
    if (!iconIds.has(recipe.icon)) {
      throw new Error(`environment badge icon "${recipe.icon}" is missing from upstream icons`);
    }
    badges[environment] = recipe.icon;
  }
  return badges;
}

// A recipe whose every producer is a skip machine is a world node - a fixture
// the player routes into on the map, not a step a plan builds. The pack Machine
// type has no cost field, so the signal has to live on the recipes: stamp the
// flag and drop the upstream cost hint, which on these recipes is a bonus the
// upstream solver awards itself for consuming waste and which STC never reads.
// On the shipped pack that is the two purification-node recipes (sewage-treat,
// sewage-treat-export).
function stampWorldNodes(recipes: Recipe[], skipMachines: ReadonlySet<string>): void {
  if (skipMachines.size === 0) return;
  for (const r of recipes) {
    if (r.producers.length === 0) continue;
    if (!r.producers.every((p) => skipMachines.has(p))) continue;
    r.flags = [...(r.flags ?? []), "world-node"];
    delete r.cost;
  }
}

function toStoich(map: Record<string, number>): Stoich[] {
  return Object.entries(map).map(([item, qty]) => ({ item, qty }));
}

// Rewrite every stoichiometric reference to a synthetic substitution key
// across all recipes, then drop the backing items, identity recipes, and
// synthetic producer machines. Fails if a __-prefix reference survives or if
// rewriting would collapse two distinct stoichiometric entries to the same
// item on the same recipe. Returns the set of dropped synthetic machine ids
// so i18n splitting can ignore them.
export function collapseSyntheticChains(
  pack: {
    items: Item[];
    machines: Machine[];
    recipes: Recipe[];
  },
  subs: Record<string, string> = syntheticSubstitutions,
): {
  droppedMachines: Set<string>;
  droppedItems: Set<string>;
  droppedRecipes: Set<string>;
} {
  const syntheticIds = new Set(Object.keys(subs));
  if (syntheticIds.size === 0) {
    return {
      droppedMachines: new Set(),
      droppedItems: new Set(),
      droppedRecipes: new Set(),
    };
  }

  // Identity recipes are recipes whose id is a substitution key. Their
  // producers are the synthetic machines that backed the synthetic item.
  const identityRecipes = pack.recipes.filter((r) => syntheticIds.has(r.id));
  const syntheticMachines = new Set<string>();
  for (const r of identityRecipes) {
    for (const p of r.producers) syntheticMachines.add(p);
  }

  // Rewrite stoichiometric entries on surviving recipes. Detect collisions:
  // if rewriting would produce two entries with the same item id on the same
  // recipe side, fail rather than silently summing.
  for (const r of pack.recipes) {
    if (syntheticIds.has(r.id)) continue;
    rewriteStoichSide(r.id, "in", r.in, subs);
    rewriteStoichSide(r.id, "out", r.out, subs);
  }

  // Drop identity recipes, synthetic items, and synthetic producer machines.
  pack.recipes.splice(
    0,
    pack.recipes.length,
    ...pack.recipes.filter((r) => !syntheticIds.has(r.id)),
  );
  pack.items.splice(
    0,
    pack.items.length,
    ...pack.items.filter((i) => !syntheticIds.has(i.id)),
  );
  pack.machines.splice(
    0,
    pack.machines.length,
    ...pack.machines.filter((m) => !syntheticMachines.has(m.id)),
  );

  // Referential-integrity guard: no __-prefix references may survive on any
  // recipe's `in` / `out` / `catalyst` item ids. The substitution pass rewrites
  // the two stoichiometric sides only, so a synthetic catalyst id fails here
  // rather than shipping. Note this checks ITEM ids only; recipe ids, category
  // strings, and producer machine ids are not in scope and may still carry a
  // __-prefix legitimately (e.g., recipes whose category is __domain_transfer
  // or __internal).
  for (const r of pack.recipes) {
    for (const s of [...r.in, ...r.out, ...(r.catalyst ?? [])]) {
      if (s.item.startsWith("__")) {
        throw new Error(
          `recipe ${r.id} still references synthetic item ${s.item} after collapse`,
        );
      }
    }
  }

  // The dropped-recipe set is the identity-recipe ids today (which equal the
  // synthetic-item ids by convention), but conceptually the i18n splitter
  // needs to know which recipes were dropped, not which items. Track the two
  // sets separately so a future substitution whose identity recipe has an id
  // different from the item it produced won't silently leak an orphan recipe
  // i18n entry.
  const droppedRecipes = new Set(identityRecipes.map((r) => r.id));
  return {
    droppedMachines: syntheticMachines,
    droppedItems: syntheticIds,
    droppedRecipes,
  };
}

function rewriteStoichSide(
  recipeId: string,
  side: "in" | "out",
  entries: Stoich[],
  subs: Record<string, string>,
): void {
  const seen = new Set<string>();
  // Pre-populate with current items so we can detect a collision with an
  // already-present entry (not from substitution).
  for (const s of entries) seen.add(s.item);

  for (const s of entries) {
    const replacement = subs[s.item];
    if (replacement === undefined) continue;
    // Did the recipe also carry an entry for the replacement item already?
    if (s.item !== replacement && seen.has(replacement)) {
      throw new Error(
        `recipe ${recipeId} ${side} collision: substituting ${s.item} -> ${replacement} would duplicate ${replacement}`,
      );
    }
    s.item = replacement;
    seen.add(replacement);
  }
}

// Compute Item.raw:
//   raw === true iff
//     (a) at least one recipe with flags: ["mining"] outputs the item, OR
//     (b) the item has no producer in the pack at all.
// Mutates items in place.
function classifyRawItems(items: Item[], recipes: Recipe[]): void {
  const minedItems = new Set<string>();
  const producedItems = new Set<string>();
  for (const r of recipes) {
    const isMining = r.flags?.includes("mining") ?? false;
    for (const s of r.out) {
      producedItems.add(s.item);
      if (isMining) minedItems.add(s.item);
    }
  }
  for (const item of items) {
    item.raw = minedItems.has(item.id) || !producedItems.has(item.id);
  }
}

export function validateReferentialIntegrity(pack: {
  items: Item[];
  machines: Machine[];
  transports: Transport[];
  recipes: Recipe[];
}): void {
  const itemIds = new Set(pack.items.map((i) => i.id));
  const machineIds = new Set(pack.machines.map((m) => m.id));
  const transportIds = new Set(pack.transports.map((t) => t.id));
  const transportKinds = new Set(pack.transports.map((t) => t.kind));

  assertNoDuplicates("items", pack.items);
  assertNoDuplicates("machines", pack.machines);
  assertNoDuplicates("transports", pack.transports);
  assertNoDuplicates("recipes", pack.recipes);

  for (const id of [...itemIds]) {
    if (machineIds.has(id) || transportIds.has(id)) {
      throw new Error(`id ${id} appears as both an item and a machine/transport`);
    }
  }

  // Machines and transports share no id either. The item loop above leaves this
  // pair unchecked, and a collision would make any id-keyed lookup that spans
  // both kinds resolve to whichever map is consulted first.
  for (const id of machineIds) {
    if (transportIds.has(id)) {
      throw new Error(`id ${id} appears as both a machine and a transport`);
    }
  }

  // Integrity assertion: every Item.transportKind value resolves to a
  // Transport.kind present in the pack. The SPA's loadTransportConfig
  // load-time guard depends on this invariant; failing fast at extract time
  // catches a future upstream-data shape regression before it reaches the
  // app.
  for (const item of pack.items) {
    if (!transportKinds.has(item.transportKind)) {
      throw new Error(
        `item ${item.id} references unknown Transport.kind ${item.transportKind}`,
      );
    }
  }

  for (const r of pack.recipes) {
    for (const s of [...r.in, ...r.out, ...(r.catalyst ?? [])]) {
      if (!itemIds.has(s.item)) {
        throw new Error(`recipe ${r.id} references unknown item ${s.item}`);
      }
    }
    if (r.producers.length === 0) {
      throw new Error(`recipe ${r.id} has no producers`);
    }
    for (const p of r.producers) {
      if (!machineIds.has(p)) {
        throw new Error(`recipe ${r.id} references unknown producer ${p}`);
      }
    }
  }
}

function assertNoDuplicates(kind: string, rows: { id: string }[]): void {
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.id)) throw new Error(`duplicate ${kind} id: ${r.id}`);
    seen.add(r.id);
  }
}

async function buildI18nSidecar(
  pack: RecipePack,
  source: SourceProvenance,
  dropped: {
    droppedMachines: Set<string>;
    droppedItems: Set<string>;
    droppedRecipes: Set<string>;
  },
): Promise<RecipePackI18n> {
  const itemIds = new Set(pack.items.map((i) => i.id));
  const machineIds = new Set(pack.machines.map((m) => m.id));
  const transportIds = new Set(pack.transports.map((t) => t.id));
  const recipeIds = new Set(pack.recipes.map((r) => r.id));
  const categoryIds = new Set(pack.categories.map((c) => c.id));
  const locationIds = new Set(pack.locations.map((l) => l.id));

  const names: Record<Locale, LocaleNames> = {} as Record<Locale, LocaleNames>;

  for (const locale of LOCALES) {
    const path = resolve(I18N_DIR, `${locale}.json`);
    const raw = (await Bun.file(path).json()) as UpstreamI18n;

    const split = splitLocale(raw, { itemIds, machineIds, transportIds, dropped });

    // splitLocale can only route keys upstream actually ships, and upstream has
    // no key for the synthetic gas carrier, so its name is injected here before
    // the coverage assertion below demands one.
    split.transports[SYNTHETIC_GAS_TRANSPORT.id] = SYNTHETIC_GAS_TRANSPORT_NAMES[locale];

    // The upstream recipe i18n includes entries for the identity recipes the
    // collapse dropped and for the retired event recipes; strip them so the
    // coverage check matches the emitted pack. Key on droppedRecipes (recipe
    // ids) rather than droppedItems (item ids) so a future substitution whose
    // identity recipe id differs from the item id still produces a clean i18n
    // sidecar.
    const recipeNames: Record<string, string> = {};
    for (const [id, name] of Object.entries(raw.recipes)) {
      if (dropped.droppedRecipes.has(id)) continue;
      recipeNames[id] = name;
    }

    assertCoverage(locale, "categories", categoryIds, raw.categories);
    assertCoverage(locale, "locations", locationIds, raw.locations);
    assertCoverage(locale, "items", itemIds, split.items);
    assertCoverage(locale, "machines", machineIds, split.machines);
    assertCoverage(locale, "transports", transportIds, split.transports);
    assertCoverage(locale, "recipes", recipeIds, recipeNames);

    names[locale] = {
      categories: { ...raw.categories },
      locations: { ...raw.locations },
      items: split.items,
      machines: split.machines,
      transports: split.transports,
      recipes: recipeNames,
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    source,
    locales: [...LOCALES],
    names,
  };
}

function splitLocale(
  raw: UpstreamI18n,
  sets: {
    itemIds: Set<string>;
    machineIds: Set<string>;
    transportIds: Set<string>;
    dropped: {
      droppedMachines: Set<string>;
      droppedItems: Set<string>;
      droppedRecipes: Set<string>;
    };
  },
): { items: Record<string, string>; machines: Record<string, string>; transports: Record<string, string> } {
  const items: Record<string, string> = {};
  const machines: Record<string, string> = {};
  const transports: Record<string, string> = {};
  for (const [id, name] of Object.entries(raw.items)) {
    if (sets.machineIds.has(id)) machines[id] = name;
    else if (sets.transportIds.has(id)) transports[id] = name;
    else if (sets.itemIds.has(id)) items[id] = name;
    else if (sets.dropped.droppedItems.has(id) || sets.dropped.droppedMachines.has(id)) {
      // Upstream i18n carries a translation for an id the extractor dropped -
      // a collapsed synthetic item, its machine, or a retired event item. None
      // of them appear in the pack, so drop the orphan key silently.
      continue;
    } else throw new Error(`i18n key items.${id} does not match any recipe-pack id`);
  }
  return { items, machines, transports };
}

function assertCoverage(
  locale: Locale,
  kind: string,
  expected: Set<string>,
  got: Record<string, string>,
): void {
  for (const id of expected) {
    if (!(id in got)) throw new Error(`i18n ${locale}.${kind} missing translation for ${id}`);
  }
  for (const id of Object.keys(got)) {
    if (!expected.has(id)) throw new Error(`i18n ${locale}.${kind} has orphan key ${id}`);
  }
}

if (import.meta.main) {
  await main();
}

export { main };
