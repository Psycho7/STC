// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { cleanup, render } from "@testing-library/react";
import type { Recipe } from "@aef/schema";
import RecipeNode from "./RecipeNode";
import { ItemPackProvider, type ItemPackContextValue } from "./itemPackContext";
import { LocaleProvider } from "../data/i18n-context";

afterEach(cleanup);

function packWithSpeed(speed: number) {
  return {
    itemById: new Map(),
    overrides: [],
    machineById: new Map([["mk1", { id: "mk1", icon: "mk1", speed }]]),
  } as unknown as ItemPackContextValue;
}

function wrap(ui: ReactNode, pack: ItemPackContextValue) {
  return render(
    <ReactFlowProvider>
      <LocaleProvider locale="en">
        <ItemPackProvider value={pack}>{ui}</ItemPackProvider>
      </LocaleProvider>
    </ReactFlowProvider>,
  );
}

// The verifier probe's fixture: 1 ore -> 1 plate every 6s. At speed 1 a single
// machine runs 1/6 exec/s, so every port moves 10 items/min.
const RECIPE = {
  id: "smelt",
  category: "assemble",
  time: 6,
  producers: ["mk1"],
  in: [{ item: "ore", qty: 1 }],
  out: [{ item: "plate", qty: 1 }],
} as unknown as Recipe;

function renderedRates(speed: number, multiplier?: number) {
  const props = {
    data: { recipe: RECIPE, multiplier },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(speed));
  const header = container.querySelector(".rate-val")?.textContent;
  const rows = [...container.querySelectorAll(".rn-row .rate")].map(
    (el) => el.textContent,
  );
  return { header, rows };
}

// Per-machine rates must carry the machine.speed factor the solver applies
// (executionRate = multiplicity * speed / time), or the node disagrees with
// the multiplicity-scaled edge rates by exactly the speed factor.
test("row and header rates scale by machine.speed", () => {
  const { header, rows } = renderedRates(2);
  expect(header).toBe("20");
  expect(rows).toEqual(["20", "20"]);
});

test("fractional machine.speed stays exact", () => {
  const { header, rows } = renderedRates(0.5);
  expect(header).toBe("5");
  expect(rows).toEqual(["5", "5"]);
});

// All shipped pack machines have speed 1; display must be byte-identical there.
test("speed-1 machine output is unchanged", () => {
  const { header, rows } = renderedRates(1);
  expect(header).toBe("10");
  expect(rows).toEqual(["10", "10"]);
});

// The older boot path scales by the integer replica multiplier; the speed
// factor composes with it.
test("speed composes with the legacy multiplier path", () => {
  const { header, rows } = renderedRates(2, 3);
  expect(header).toBe("60");
  expect(rows).toEqual(["60", "60"]);
});

// The machine-count badge must be theme-styled (readable contrast), not the
// dead light-theme inline color:#444 / fontSize:11.
test("multiplicity badge carries a class and no inline color or font size", () => {
  const props = {
    data: { recipe: RECIPE, multiplier: 3 },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  const badge = container.querySelector(".rn-mult-badge");
  expect(badge).not.toBeNull();
  expect(badge!.textContent).toBe("x3");
  expect((badge as HTMLElement).style.color).toBe("");
  expect((badge as HTMLElement).style.fontSize).toBe("");
});

// The raw machine id (e.g. "mk1") reads as debug output; the localized machine
// name already identifies the producer, so the mono id line is dropped.
test("recipe node does not render the raw machine id line", () => {
  const props = {
    data: { recipe: RECIPE, multiplier: 1 },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  expect(container.querySelector(".machine-mid")).toBeNull();
});

// A corrupt fixture can reference a missing machine; the rate falls back to
// speed 1 instead of crashing.
test("missing machine record falls back to speed 1", () => {
  const props = {
    data: { recipe: RECIPE },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const emptyPack = {
    itemById: new Map(),
    overrides: [],
    machineById: new Map(),
  } as unknown as ItemPackContextValue;
  const { container } = wrap(<RecipeNode {...props} />, emptyPack);
  expect(container.querySelector(".rate-val")?.textContent).toBe("10");
});
