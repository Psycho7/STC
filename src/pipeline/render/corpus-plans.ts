// The multi-target half of the render corpus, kept in its own module so more
// than one suite can sweep the same plan list without duplicating it (a test
// file cannot be imported by another test file without re-registering its
// suites).

// Representative multi-target plans. Each mixes a copper-chain target with an
// xiranite target to exercise shared SCCs and byproduct accounting across more
// than one target.
export const MULTI_TARGET_PLANS: ReadonlyArray<{
  name: string;
  recipeIds: ReadonlyArray<string>;
}> = [
  {
    name: "xiranite_poly+iron_powder",
    recipeIds: ["xiranite_poly", "iron_powder"],
  },
  {
    name: "proc_battery_5+xiranite_enr_powder",
    recipeIds: ["proc_battery_5", "xiranite_enr_powder"],
  },
  {
    name: "copper_enr+liquid_xiranite_enr",
    recipeIds: ["copper_enr", "liquid_xiranite_enr"],
  },
  // Two targets sharing a byproduct supplier (both co-produce liquid_sewage).
  // copper_enr is reached both as a target seed and as a byproduct-shared
  // source, so its whole upstream copper chain is replicated twice instead of
  // shared (per-consumer over-replication).
  {
    name: "copper_enr+xiranite_poly",
    recipeIds: ["copper_enr", "xiranite_poly"],
  },
  // Two mutual-recycling members of one SCC: production of the shared item nets
  // to zero against consumption + demand, but split-role surplus accounting
  // surfaces a phantom surplus (multi-producer SCC routing).
  {
    name: "crystal_powder-crystal_shell+crystal_shell-crystal_powder",
    recipeIds: ["crystal_powder-crystal_shell", "crystal_shell-crystal_powder"],
  },
  // A target recipe that is ALSO an upstream producer of another target. The
  // seed loop registers a target only in the byproductShared cache, so a target
  // reached again as a producer is minted a second time and its whole chain
  // over-replicates ~2x. Two sub-cases of the same gap:
  //   - carbon_enr is a (trivial-SCC) articulation producer of the carbon_enr
  //     that equip_script_4's xiranite chain consumes -> AP-shared double-mint.
  //   - iron_nugget-iron_ore produces the iron_nugget that bottled_food_2's
  //     chain consumes -> non-shared per-consumer double-mint.
  {
    name: "carbon_enr+equip_script_4",
    recipeIds: ["carbon_enr", "equip_script_4"],
  },
  {
    name: "iron_nugget-iron_ore+bottled_food_2",
    recipeIds: ["iron_nugget-iron_ore", "bottled_food_2"],
  },
  // Phantom surplus from production split across render units. The surplus pass
  // differenced produced-vs-outgoing per unit and kept only positive residuals,
  // so when an item's production splits across units -- a loop recipe torn across
  // SCC sibling units, or a target item co-produced by an SCC and a leaf recipe
  // -- one unit's positive residual surfaced as an amber surplus while the
  // matching per-unit deficit was clamped away. Net production for the item is
  // exactly its genuine surplus (zero here), so the leftover is phantom. The
  // surplus pass now emits the genuine surplus (production - consumption -
  // demand) per item, the same quantity checkBoundaryProductsJustified validates.
  //   - proc_battery_5+xiranite_enr_powder: liquid_xiranite_poly / lowpoly are
  //     non-target loop intermediates torn across SCC siblings.
  //   - copper_powder+equip_script_4: crystal_powder, a non-target loop item with
  //     a degenerate sub-tolerance residual.
  //   - carbon_powder-plant_grass_powder_2+plant_grass_2: plant_grass_2 is a
  //     TARGET loop item.
  //   - iron_nugget-iron_powder+jinlong_coupon-proc_battery_5: iron_nugget is a
  //     TARGET item co-produced by an SCC and a separate leaf recipe.
  {
    name: "copper_powder+equip_script_4",
    recipeIds: ["copper_powder", "equip_script_4"],
  },
  {
    name: "carbon_powder-plant_grass_powder_2+plant_grass_2",
    recipeIds: ["carbon_powder-plant_grass_powder_2", "plant_grass_2"],
  },
  {
    name: "iron_nugget-iron_powder+jinlong_coupon-proc_battery_5",
    recipeIds: ["iron_nugget-iron_powder", "jinlong_coupon-proc_battery_5"],
  },
];
