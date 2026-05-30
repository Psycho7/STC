import { resolve } from "node:path";
import {
  LOCALES,
  SCHEMA_VERSION,
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
} from "./schema.ts";
import type { UpstreamData, UpstreamI18n, UpstreamItem, UpstreamRecipe } from "./upstream.ts";

// Curated synthetic-item substitutions. The collapse pass rewrites references
// to these synthetic ids to their real counterparts, then drops the synthetic
// items, machines, and identity recipes that backed them.
const syntheticSubstitutions: Record<string, string> = {
  __miner_water: "liquid_water",
};

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const VENDOR_PATH = "vendor/endfield-calc";
const INPUT_PATH = resolve(REPO_ROOT, VENDOR_PATH, "data.json");
const I18N_DIR = resolve(REPO_ROOT, VENDOR_PATH, "i18n");
const OUTPUT_PATH = resolve(REPO_ROOT, "data/aef/recipe-pack.json");
const I18N_OUTPUT_PATH = resolve(REPO_ROOT, "data/aef/recipe-pack.i18n.json");
const GAME_VERSION_KEY = "arknights-endfield";

async function main(): Promise<void> {
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

  const recipes: Recipe[] = upstream.recipes.map(toRecipe);

  const dropped = collapseSyntheticChains({ items, machines, recipes });

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
  };

  const i18n = await buildI18nSidecar(pack, source, dropped);

  await Bun.write(OUTPUT_PATH, JSON.stringify(pack, null, 2) + "\n");
  await Bun.write(I18N_OUTPUT_PATH, JSON.stringify(i18n, null, 2) + "\n");

  console.log(`wrote ${OUTPUT_PATH}`);
  console.log(
    `  items=${items.length} machines=${machines.length} transports=${transports.length}` +
      ` recipes=${recipes.length} categories=${pack.categories.length} locations=${pack.locations.length}`,
  );
  console.log(`wrote ${I18N_OUTPUT_PATH}`);
  console.log(`  locales=${i18n.locales.join(",")}`);
  console.log(`  source: ${pack.source.name}@${sourceMeta.commit.slice(0, 12)} game=${gameVersion}`);
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
    transportKind: typeof u.stack === "number" ? "belt" : "pipe",
  };
  if (typeof u.stack === "number") item.stack = u.stack;
  if (u.buildIcon && u.buildIcon.length > 0) item.buildIcon = [...u.buildIcon];
  return item;
}

function toRecipe(u: UpstreamRecipe): Recipe {
  const recipe: Recipe = {
    id: u.id,
    name: u.name,
    category: u.category,
    icon: u.icon,
    row: u.row,
    time: u.time,
    in: toStoich(u.in),
    out: toStoich(u.out),
    producers: [...u.producers],
  };
  if (u.locations && u.locations.length > 0) recipe.locations = [...u.locations];
  if (u.flags && u.flags.length > 0) recipe.flags = [...u.flags];
  if (u.usage != null) recipe.usage = u.usage;
  if (u.cost != null) recipe.cost = u.cost;
  return recipe;
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
  // recipe's stoichiometric `in` / `out` item ids. Note this checks ITEM ids
  // on stoichiometry only; recipe ids, category strings, and producer machine
  // ids are not in scope and may still carry a __-prefix legitimately (e.g.,
  // recipes whose category is __domain_transfer or __internal).
  for (const r of pack.recipes) {
    for (const s of [...r.in, ...r.out]) {
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

function validateReferentialIntegrity(pack: {
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
    for (const s of [...r.in, ...r.out]) {
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

    // The upstream recipe i18n includes identity-recipe entries for the
    // synthetic recipes we dropped; strip them so the coverage check matches
    // the collapsed pack. Key on droppedRecipes (recipe ids) rather than
    // droppedItems (item ids) so a future substitution whose identity recipe
    // id differs from the item id still produces a clean i18n sidecar.
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
      // Upstream i18n carries a translation for the synthetic id we just
      // collapsed; the substituted-to item (or dropped machine) no longer
      // appears in the pack, so drop the orphan key silently.
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
