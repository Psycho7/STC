import { expect, test } from "vitest";
import {
  unitIdForClass,
  unitIdForInputAggregate,
  unitIdForInputContainer,
  unitIdForInputTap,
  unitIdForInputTargetFeed,
  unitIdForOutputProduct,
  unitIdForRecipe,
  unitIdForScc,
  unitIdForSurplus,
} from "./unit-ids";

// These are exact-string pins, not round-trips. Emitters and the render
// checkers now share one grammar, so a unilateral rename no longer makes the
// two sides disagree at runtime; this suite is what catches a rename instead.
// Every string below is byte-identical to the literal its constructor
// replaced, and the render corpus golden depends on all of them.

test("unitIdForRecipe pins the bare machine-vertex form", () => {
  expect(unitIdForRecipe("r:iron_plate~0:0")).toBe("u:r:iron_plate~0:0");
});

test("unitIdForScc pins the loop form", () => {
  expect(unitIdForScc("s1")).toBe("u:scc:s1");
});

test("unitIdForClass pins the equivalence-class form", () => {
  expect(unitIdForClass("r:iron_plate#0")).toBe("u:class:r:iron_plate#0");
});

test("unitIdForInputAggregate pins the item-level input form", () => {
  expect(unitIdForInputAggregate("water")).toBe("u:in:water");
});

test("unitIdForInputContainer pins the per-container slice form", () => {
  expect(unitIdForInputContainer("water", "c0")).toBe("u:in:water:c0");
});

test("unitIdForInputTap pins the loose-consumer slice form", () => {
  expect(unitIdForInputTap("water", "u:r:pump")).toBe(
    "u:in:water:tap:u:r:pump",
  );
});

test("unitIdForInputTargetFeed pins the passthrough-feed form", () => {
  expect(unitIdForInputTargetFeed("water")).toBe("u:in:water:target");
});

test("unitIdForOutputProduct pins the export form", () => {
  expect(unitIdForOutputProduct("iron")).toBe("u:out:iron");
});

test("unitIdForSurplus pins the surplus-export form", () => {
  expect(unitIdForSurplus("iron")).toBe("u:surplus:iron");
});
