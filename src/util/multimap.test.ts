import { expect, it } from "vitest";
import { pushInto } from "./multimap";

it("pushInto appends under a key, keeping first-insertion key order", () => {
  const m = new Map<string, number[]>();
  pushInto(m, "b", 1);
  pushInto(m, "a", 2);
  pushInto(m, "b", 3);
  expect([...m.entries()]).toEqual([
    ["b", [1, 3]],
    ["a", [2]],
  ]);
});
