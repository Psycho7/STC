import { pack } from "./load";
import type {
  LogicalEdge,
  LogicalGraph,
  LogicalGroupNode,
  LogicalNode,
  LogicalRecipeNode,
} from "../canvas/layout";

const FIXTURE_RECIPE_IDS = [
  "copper_ore-liquid_water",
  "copper_nugget",
  "liquid_water",
  "copper_powder",
  "copper_bottle",
  "liquid_cleaner_1-sewage",
] as const;

const SMELT_GROUP_RECIPES: ReadonlySet<string> = new Set([
  "copper_ore-liquid_water",
  "copper_nugget",
]);

const MULTIPLIERS: Record<string, number> = { copper_powder: 3 };

function recipeById(id: string) {
  const recipe = pack.recipes.find((r) => r.id === id);
  if (!recipe) throw new Error(`fixture recipe not found in pack: ${id}`);
  return recipe;
}

function makeEdge(source: string, item: string, target: string): LogicalEdge {
  const sourcePort = `out:${item}`;
  const targetPort = `in:${item}`;
  return {
    id: `${source}:${sourcePort}->${target}:${targetPort}`,
    source,
    target,
    sourcePort,
    targetPort,
  };
}

function makeRecipeNode(id: string): LogicalRecipeNode {
  const inGroup = SMELT_GROUP_RECIPES.has(id);
  const base: LogicalRecipeNode = {
    kind: "recipe",
    id,
    recipe: recipeById(id),
    multiplier: MULTIPLIERS[id] ?? 1,
    expanded: false,
  };
  return inGroup ? { ...base, parentId: "g:smelt" } : base;
}

export function buildFixture(): LogicalGraph {
  const nodes: LogicalNode[] = [
    { kind: "group", id: "g:smelt", label: "Smelting" },
    ...FIXTURE_RECIPE_IDS.map(makeRecipeNode),
  ];
  const edges: LogicalEdge[] = [
    makeEdge("copper_ore-liquid_water", "copper_ore", "copper_nugget"),
    makeEdge("liquid_water", "liquid_water", "copper_nugget"),
    makeEdge("copper_nugget", "copper_nugget", "copper_powder"),
    makeEdge("copper_nugget", "copper_nugget", "copper_bottle"),
    makeEdge("copper_nugget", "liquid_sewage", "liquid_cleaner_1-sewage"),
  ];
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Larger fixture: 30 recipes spread across 3 groups.
// ---------------------------------------------------------------------------

export const SPIKE2_RECIPE_IDS = [
  "activity_xiranite_bottle",
  "activity_xiranite_cmpt",
  "activity_xiranite_enr_cmpt",
  "activity_xiranite_enr_hulu",
  "activity_xiranite_enr_tool",
  "activity_xiranite_hulu",
  "carbon_enr",
  "carbon_enr_powder-carbon_powder",
  "carbon_enr_powder-plant_moss_enr_powder_1",
  "carbon_mtl-plant_grass_1",
  "carbon_mtl-plant_grass_2",
  "carbon_powder-carbon_mtl",
  "carbon_powder-plant_grass_powder_1",
  "carbon_powder-plant_grass_powder_2",
  "copper_enr",
  "copper_nugget",
  "copper_powder",
  "liquid_copper",
  "liquid_copper_enr",
  "liquid_xiranite",
  "liquid_xiranite_poly",
  "liquid_xiranite_poly-purifier",
  "plant_grass_1",
  "plant_grass_2",
  "plant_grass_powder_1",
  "plant_grass_powder_2",
  "plant_grass_seed_1",
  "plant_grass_seed_2",
  "xiranite_poly",
  "xiranite_powder",
] as const;

export const SPIKE2_GROUP_MAP: Record<
  string,
  "g:smelt" | "g:process" | "g:assembly"
> = {
  activity_xiranite_bottle: "g:assembly",
  activity_xiranite_cmpt: "g:assembly",
  activity_xiranite_enr_cmpt: "g:assembly",
  activity_xiranite_enr_hulu: "g:assembly",
  activity_xiranite_enr_tool: "g:assembly",
  activity_xiranite_hulu: "g:assembly",
  carbon_enr: "g:smelt",
  "carbon_enr_powder-carbon_powder": "g:process",
  "carbon_enr_powder-plant_moss_enr_powder_1": "g:smelt",
  "carbon_mtl-plant_grass_1": "g:smelt",
  "carbon_mtl-plant_grass_2": "g:smelt",
  "carbon_powder-carbon_mtl": "g:process",
  "carbon_powder-plant_grass_powder_1": "g:smelt",
  "carbon_powder-plant_grass_powder_2": "g:smelt",
  copper_enr: "g:smelt",
  copper_nugget: "g:smelt",
  copper_powder: "g:process",
  liquid_copper: "g:smelt",
  liquid_copper_enr: "g:smelt",
  liquid_xiranite: "g:smelt",
  liquid_xiranite_poly: "g:smelt",
  "liquid_xiranite_poly-purifier": "g:smelt",
  plant_grass_1: "g:process",
  plant_grass_2: "g:process",
  plant_grass_powder_1: "g:process",
  plant_grass_powder_2: "g:process",
  plant_grass_seed_1: "g:process",
  plant_grass_seed_2: "g:process",
  xiranite_poly: "g:smelt",
  xiranite_powder: "g:smelt",
};

// [id, label] pairs for the three groups.
export const SPIKE2_GROUPS: [string, string][] = [
  ["g:smelt", "Smelting"],
  ["g:process", "Processing"],
  ["g:assembly", "Assembly"],
];

export function buildSpike2Fixture(): LogicalGraph {
  const groupNodes: LogicalGroupNode[] = SPIKE2_GROUPS.map(([id, label]) => ({
    kind: "group",
    id,
    label,
  }));

  const recipeNodes: LogicalRecipeNode[] = SPIKE2_RECIPE_IDS.map((id) => {
    const parentId = SPIKE2_GROUP_MAP[id];
    if (!parentId)
      throw new Error(`spike-2 fixture: no group for recipe ${id}`);
    return {
      kind: "recipe",
      id,
      recipe: recipeById(id),
      multiplier: 1,
      expanded: false,
      parentId,
    };
  });

  const nodes: LogicalNode[] = [...groupNodes, ...recipeNodes];

  // Wire up edges by matching outputs to inputs: for each ordered pair of
  // recipes (A, B) and each item, draw an edge when A produces that item and
  // B consumes it.
  const edges: LogicalEdge[] = [];
  for (const a of recipeNodes) {
    const aOutItems = new Set(a.recipe.out.map((s) => s.item));
    for (const b of recipeNodes) {
      for (const s of b.recipe.in) {
        if (aOutItems.has(s.item)) {
          edges.push(makeEdge(a.id, s.item, b.id));
        }
      }
    }
  }

  return { nodes, edges };
}
