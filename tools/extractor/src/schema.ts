// Project-owned recipe-pack schema.
// The extractor produces this; the planner consumes it.

export const SCHEMA_VERSION = "0.2";

// Open-set identifier for the transport phase an item flows on. Canonical
// values live in TRANSPORT_KIND; the type stays string so new game kinds slot
// in without a type change.
export type TransportKindId = string;

export const TRANSPORT_KIND = { BELT: "belt", PIPE: "pipe" } as const;

// Locales joined into the i18n sidecar. The order here is the order written to
// the sidecar's `locales` array.
export const LOCALES = ["en", "ja", "ru", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

export interface RecipePack {
  schemaVersion: typeof SCHEMA_VERSION;
  source: SourceProvenance;
  categories: Category[];
  locations: Location[];
  items: Item[];
  machines: Machine[];
  transports: Transport[];
  recipes: Recipe[];
}

export interface SourceProvenance {
  name: string;
  sourceRepo: string;
  sourceCommit: string;
  gameVersion: string;
  extractedAt: string;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
}

export interface Location {
  id: string;
  name: string;
  icon: string;
}

export interface Item {
  id: string;
  name: string;
  category: string;
  // Stack size for solid items. Omitted for fluids (liquids and other
  // unstackable items). Use absence as a "this item is fluid-like" signal.
  stack?: number;
  icon: string;
  row: number;
  buildIcon?: string[];
  // Whether this item is a raw input boundary in the production graph.
  // Computed by the extractor after synthetic-chain collapse.
  raw: boolean;
  // Transport phase this item flows on. Computed by the extractor from the
  // upstream factoriolab signal (stack -> belt, no stack -> pipe).
  transportKind: TransportKindId;
}

export type PowerType = "electric" | "burner";

export interface Machine {
  id: string;
  name: string;
  icon: string;
  speed: number;
  powerType: PowerType;
  // Default per-recipe power draw in kW. Negative on burner machines (null) and
  // on synthetic/internal machines that have no real power load.
  powerKw: number | null;
  hideRate: boolean;
  // [width, height] in tiles. Null for synthetic machines (e.g. __domain_transfer).
  size?: [number, number];
  // If present, the machine is only available in these locations.
  locations?: string[];
  // Upstream marker; semantics unclear. Preserved verbatim.
  totalRecipe?: boolean;
}

export interface Transport {
  id: string;
  kind: TransportKindId;
  name: string;
  icon: string;
  speed: number;
}

export interface Stoich {
  item: string;
  qty: number;
}

export interface Recipe {
  id: string;
  name: string;
  category: string;
  icon: string;
  row: number;
  time: number;
  in: Stoich[];
  out: Stoich[];
  producers: string[];
  locations?: string[];
  flags?: string[];
  // Per-recipe power override in kW. Negative => the recipe generates power
  // (e.g. power-gen recipes). When absent, the machine's powerKw applies.
  usage?: number;
  // Upstream solver hint. cost === -1 marks recipes the default solver should
  // skip (e.g. waste-disposal sinks). Other values are priority weights.
  cost?: number;
}

// Sidecar i18n file. One file holds all locales, name maps split by entity
// kind to mirror the recipe-pack split (so callers look up by id without
// re-disambiguating).
export interface RecipePackI18n {
  schemaVersion: typeof SCHEMA_VERSION;
  source: SourceProvenance;
  locales: Locale[];
  names: Record<Locale, LocaleNames>;
}

export interface LocaleNames {
  categories: Record<string, string>;
  locations: Record<string, string>;
  items: Record<string, string>;
  machines: Record<string, string>;
  transports: Record<string, string>;
  recipes: Record<string, string>;
}
