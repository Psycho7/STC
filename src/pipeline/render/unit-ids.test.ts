import { expect, test } from "vitest";
import {
  unitIdForCatalystAggregate,
  unitIdForClass,
  unitIdForInputAggregate,
  unitIdForOutputProduct,
  unitIdForScc,
  unitIdForSurplus,
} from "./unit-ids";

// These are exact-string pins, not round-trips. Emitters and the render
// checkers now share one grammar, so a unilateral rename no longer makes the
// two sides disagree at runtime; this suite is what catches a rename instead.
// Every string below is byte-identical to the literal its constructor
// replaced, and the render corpus golden depends on all of them.

test("unitIdForScc pins the loop form", () => {
  expect(unitIdForScc("s1")).toBe("u:scc:s1");
});

test("unitIdForClass pins the equivalence-class form", () => {
  expect(unitIdForClass("r:iron_plate#0")).toBe("u:class:r:iron_plate#0");
});

test("unitIdForInputAggregate pins the item-level input form", () => {
  expect(unitIdForInputAggregate("water")).toBe("u:in:water");
});

test("unitIdForCatalystAggregate pins the item-level catalyst form", () => {
  expect(unitIdForCatalystAggregate("water")).toBe("u:cat:water");
});

test("unitIdForOutputProduct pins the export form", () => {
  expect(unitIdForOutputProduct("iron")).toBe("u:out:iron");
});

test("unitIdForSurplus pins the surplus-export form", () => {
  expect(unitIdForSurplus("iron")).toBe("u:surplus:iron");
});
