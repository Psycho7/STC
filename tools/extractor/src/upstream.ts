// Shape of vendor/endfield-calc/data.json. Only the fields the
// extractor reads are typed; unused fields (icons sprite metadata, limitations,
// defaults, modHash) are intentionally omitted.

export interface UpstreamData {
  version: Record<string, string>;
  categories: UpstreamCategory[];
  locations: UpstreamLocation[];
  items: UpstreamItem[];
  recipes: UpstreamRecipe[];
}

export interface UpstreamCategory {
  id: string;
  name: string;
  icon: string;
}

export interface UpstreamLocation {
  id: string;
  name: string;
  icon: string;
}

export interface UpstreamItem {
  id: string;
  name: string;
  stack?: number;
  category: string;
  row: number;
  icon: string;
  buildIcon?: string[];
  machine?: UpstreamMachine;
  belt?: UpstreamTransport;
  pipe?: UpstreamTransport;
}

export interface UpstreamMachine {
  speed: number;
  type: "electric" | "burner";
  usage?: number | null;
  hideRate?: boolean;
  size?: [number, number] | null;
  locations?: string[] | null;
  totalRecipe?: boolean | null;
}

export interface UpstreamTransport {
  speed: number;
}

export interface UpstreamRecipe {
  id: string;
  name: string;
  category: string;
  row: number;
  icon: string;
  time: number;
  in: Record<string, number>;
  out: Record<string, number>;
  producers: string[];
  locations?: string[];
  flags?: string[];
  usage?: number;
  cost?: number;
}

// Shape of vendor/endfield-calc/i18n/<locale>.json. Upstream packs
// items+machines+transports together under `items`; the extractor splits them
// against the recipe-pack's entity-kind sets at join time.
export interface UpstreamI18n {
  name: string;
  version: Record<string, string>;
  categories: Record<string, string>;
  locations: Record<string, string>;
  items: Record<string, string>;
  recipes: Record<string, string>;
}
