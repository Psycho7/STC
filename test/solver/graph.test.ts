import { describe, it, expect } from "vitest";
import type { Recipe, RecipePack } from "@aef/schema";
import { buildRecipeGraph } from "../../src/solver/graph";
import { UnknownRecipeError } from "../../src/solver/types";
import type { Target } from "../../src/data/targets";

function makeRecipe(
  id: string,
  inItems: string[],
  outItems: string[],
  extras: Partial<Recipe> = {},
): Recipe {
  return {
    id,
    name: id,
    category: "material",
    icon: id,
    row: 0,
    time: 1,
    in: inItems.map((item) => ({ item, qty: 1 })),
    out: outItems.map((item) => ({ item, qty: 1 })),
    producers: ["m1"],
    ...extras,
  } as Recipe;
}

function pack(recipes: Recipe[]): RecipePack {
  return {
    schemaVersion: "0.1",
    source: {
      name: "test",
      submodulePath: "",
      submoduleSha: "0",
      gameVersion: "x",
      extractedAt: "",
    },
    categories: [],
    locations: [],
    items: [],
    machines: [
      {
        id: "m1",
        name: "m1",
        icon: "m1",
        speed: 1,
        powerType: "electric",
        powerKw: 0,
        hideRate: false,
      },
    ],
    transports: [],
    recipes,
  } as unknown as RecipePack;
}

function tgt(recipeId: string): Target {
  return { recipeId, ratePerSec: { num: "1", denom: "1" } };
}

describe("buildRecipeGraph", () => {
  it("returns a single-node graph for a target with no upstream", () => {
    const p = pack([makeRecipe("root", [], ["root_out"])]);
    const g = buildRecipeGraph([tgt("root")], p);
    expect([...g.nodes.keys()]).toEqual(["root"]);
    expect(g.outgoing.get("root")).toEqual([]);
  });

  it("walks a linear chain upstream", () => {
    const p = pack([
      makeRecipe("a", [], ["x"]),
      makeRecipe("b", ["x"], ["y"]),
      makeRecipe("c", ["y"], ["z"]),
    ]);
    const g = buildRecipeGraph([tgt("c")], p);
    expect([...g.nodes.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(g.outgoing.get("a")?.map((e) => e.target)).toEqual(["b"]);
    expect(g.outgoing.get("b")?.map((e) => e.target)).toEqual(["c"]);
  });

  it("selects multi-producer item by lex-min recipeId", () => {
    const p = pack([
      makeRecipe("alt_z", [], ["z"]),
      makeRecipe("aaa_z", [], ["z"]),
      makeRecipe("consumer", ["z"], ["out"]),
    ]);
    const g = buildRecipeGraph([tgt("consumer")], p);
    expect(g.nodes.has("aaa_z")).toBe(true);
    expect(g.nodes.has("alt_z")).toBe(false);
  });

  it("excludes cost === -1 producers unless they are the target", () => {
    const p = pack([
      makeRecipe("clean_z", [], ["z"], { cost: -1 } as Partial<Recipe>),
      makeRecipe("normal_z", [], ["z"]),
      makeRecipe("consumer", ["z"], ["out"]),
    ]);
    const g = buildRecipeGraph([tgt("consumer")], p);
    expect(g.nodes.has("normal_z")).toBe(true);
    expect(g.nodes.has("clean_z")).toBe(false);
  });

  it("permits cost === -1 when it IS the target", () => {
    const p = pack([
      makeRecipe("sink", ["w"], [], { cost: -1 } as Partial<Recipe>),
      makeRecipe("waste_producer", [], ["w"]),
    ]);
    const g = buildRecipeGraph([tgt("sink")], p);
    expect(g.nodes.has("sink")).toBe(true);
  });

  it("throws UnknownRecipeError for unresolved target id", () => {
    const p = pack([makeRecipe("a", [], ["x"])]);
    expect(() => buildRecipeGraph([tgt("nonexistent")], p)).toThrow(
      UnknownRecipeError,
    );
  });
});

describe("buildRecipeGraph / raw-distance depth maps", () => {
  function packWithItems(
    recipes: Recipe[],
    items: Array<{ id: string; raw: boolean }>,
  ): RecipePack {
    const fullItems = items.map((i) => ({
      id: i.id,
      name: i.id,
      category: "c",
      icon: "i",
      row: 0,
      raw: i.raw,
      transportKind: "belt",
    }));
    return {
      schemaVersion: "0.1",
      source: {
        name: "test",
        submodulePath: "",
        submoduleSha: "0",
        gameVersion: "x",
        extractedAt: "",
      },
      categories: [],
      locations: [],
      items: fullItems,
      machines: [
        {
          id: "m1",
          name: "m1",
          icon: "m1",
          speed: 1,
          powerType: "electric",
          powerKw: 0,
          hideRate: false,
        },
      ],
      transports: [],
      recipes,
    } as unknown as RecipePack;
  }

  it("assigns depth 0 to raw items, depth 1 to recipes consuming only raws", () => {
    const p = packWithItems(
      [makeRecipe("r1", ["raw_a"], ["intermediate"])],
      [
        { id: "raw_a", raw: true },
        { id: "intermediate", raw: false },
      ],
    );
    const g = buildRecipeGraph([tgt("r1")], p);
    expect(g.depthToItem.get("raw_a")).toBe(0);
    expect(g.depthToRecipe.get("r1")).toBe(1);
    expect(g.depthToItem.get("intermediate")).toBe(1);
  });

  it("propagates depth through a 2-hop chain", () => {
    const p = packWithItems(
      [
        makeRecipe("r1", ["raw_a"], ["mid"]),
        makeRecipe("r2", ["mid"], ["final"]),
      ],
      [
        { id: "raw_a", raw: true },
        { id: "mid", raw: false },
        { id: "final", raw: false },
      ],
    );
    const g = buildRecipeGraph([tgt("r2")], p);
    expect(g.depthToRecipe.get("r1")).toBe(1);
    expect(g.depthToRecipe.get("r2")).toBe(2);
    expect(g.depthToItem.get("final")).toBe(2);
  });

  it("leaves a truly-closed cycle (no external entry) at POSITIVE_INFINITY", () => {
    const p = packWithItems(
      [
        makeRecipe("cyc_a", ["item_b"], ["item_a"]),
        makeRecipe("cyc_b", ["item_a"], ["item_b"]),
      ],
      [
        { id: "item_a", raw: false },
        { id: "item_b", raw: false },
      ],
    );
    // No target inside the cycle would build a graph because there is no
    // raw-rooted ancestor; we only care about the depth maps here.
    const g = buildRecipeGraph([], p);
    expect(g.depthToRecipe.get("cyc_a")).toBe(Number.POSITIVE_INFINITY);
    expect(g.depthToRecipe.get("cyc_b")).toBe(Number.POSITIVE_INFINITY);
    expect(g.depthToItem.get("item_a")).toBe(Number.POSITIVE_INFINITY);
    expect(g.depthToItem.get("item_b")).toBe(Number.POSITIVE_INFINITY);
  });

  it("assigns finite depth to a cycle whose items have a raw-rooted alternative producer", () => {
    // The load-bearing case: a cycle with an external alternative is
    // not truly closed. cyc_b can run because item_a has a raw-rooted
    // producer (entry); cyc_a then runs because item_b becomes reachable.
    const p = packWithItems(
      [
        makeRecipe("cyc_a", ["item_b"], ["item_a"]),
        makeRecipe("cyc_b", ["item_a"], ["item_b"]),
        makeRecipe("entry", ["raw_seed"], ["item_a"]),
      ],
      [
        { id: "raw_seed", raw: true },
        { id: "item_a", raw: false },
        { id: "item_b", raw: false },
      ],
    );
    const g = buildRecipeGraph([tgt("cyc_b")], p);
    expect(g.depthToRecipe.get("entry")).toBe(1);
    // entry seeds item_a at depth 1; cyc_b consumes item_a, output item_b at
    // depth 2; cyc_a consumes item_b, output item_a at depth 3 (the alternative
    // path is longer than entry's, so item_a stays at min depth 1).
    expect(g.depthToItem.get("item_a")).toBe(1);
    expect(g.depthToRecipe.get("cyc_b")).toBe(2);
    expect(g.depthToItem.get("item_b")).toBe(2);
    expect(g.depthToRecipe.get("cyc_a")).toBe(3);
  });

  it("pickProducer prefers a raw-rooted recipe over an alphabetically-earlier cycle recipe", () => {
    // Models the AEF quartz_glass-quartz_powder vs quartz_glass-quartz_sand
    // case: under alphabetic sort the cycle producer wins, under raw-distance
    // ranking the raw-rooted producer wins.
    const p = packWithItems(
      [
        // Cycle producer: name sorts earlier alphabetically.
        makeRecipe("glass_cycle", ["powder"], ["glass"]),
        makeRecipe("powder_cycle", ["glass"], ["powder"]),
        // Raw-rooted alternative for glass.
        makeRecipe("glass_raw", ["sand"], ["glass"]),
        makeRecipe("consumer", ["glass"], ["bottle"]),
      ],
      [
        { id: "sand", raw: true },
        { id: "glass", raw: false },
        { id: "powder", raw: false },
        { id: "bottle", raw: false },
      ],
    );
    const g = buildRecipeGraph([tgt("consumer")], p);
    // Raw-rooted producer wins despite alphabetic order putting glass_cycle first.
    expect(g.nodes.has("glass_raw")).toBe(true);
    expect(g.nodes.has("glass_cycle")).toBe(false);
    expect(g.nodes.has("powder_cycle")).toBe(false);
  });

  it("pickProducer falls back to a cycle recipe when no raw-rooted alternative exists", () => {
    const p = packWithItems(
      [
        makeRecipe("cyc_a", ["item_b"], ["item_a"]),
        makeRecipe("cyc_b", ["item_a"], ["item_b"]),
        // External seed for item_a so the consumer can be reached without
        // the cycle being raw-rooted; the cycle is still the only producer
        // for item_b.
        makeRecipe("seed", ["raw_seed"], ["item_a"]),
        makeRecipe("consumer", ["item_b"], ["out"]),
      ],
      [
        { id: "raw_seed", raw: true },
        { id: "item_a", raw: false },
        { id: "item_b", raw: false },
        { id: "out", raw: false },
      ],
    );
    const g = buildRecipeGraph([tgt("consumer")], p);
    // item_b's only producer is cyc_b; pickProducer must return it despite
    // its higher depth.
    expect(g.nodes.has("cyc_b")).toBe(true);
  });

  it("excludes __domain_transfer recipes from depthToRecipe entirely", () => {
    const p = packWithItems(
      [
        makeRecipe("transfer_tundra_x", ["domain_key"], ["item_x"], {
          category: "__domain_transfer",
        }),
        makeRecipe("real_producer", ["raw_b"], ["item_x"]),
        makeRecipe("consumer", ["item_x"], ["out"]),
      ],
      [
        { id: "domain_key", raw: true },
        { id: "raw_b", raw: true },
        { id: "item_x", raw: false },
        { id: "out", raw: false },
      ],
    );
    const g = buildRecipeGraph([tgt("consumer")], p);
    // Excluded recipes have no entry in depthToRecipe.
    expect(g.depthToRecipe.has("transfer_tundra_x")).toBe(false);
    expect(g.depthToRecipe.get("real_producer")).toBe(1);
    // Item depth is derived from non-excluded producers only.
    expect(g.depthToItem.get("item_x")).toBe(1);
  });
});
