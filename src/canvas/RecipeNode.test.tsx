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

// Render-pipeline path: the node data carries a rational `multiplicity` (the
// solved machine count) instead of the boot path's integer `multiplier`.
function renderedWithMultiplicity(
  speed: number,
  multiplicity: { num: string; denom: string },
) {
  const props = {
    data: { recipe: RECIPE, kind: "recipe", multiplicity },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(speed));
  const header = container.querySelector(".rate-val")?.textContent;
  const rows = [...container.querySelectorAll(".rn-row .rate")].map(
    (el) => el.textContent,
  );
  const sub = container.querySelector(".rate-sub");
  const mult = container.querySelector(".rate-sub-mult");
  return { header, rows, sub, mult };
}

// UX-10: with a multiplicity of N the node must show the aggregate rate
// (per-machine x N) as the primary figure on rows and header, so node numbers
// match the incident edge chips instead of showing one machine's share.
test("multiplicity scales rows and header to the aggregate rate", () => {
  const { header, rows } = renderedWithMultiplicity(1, {
    num: "2",
    denom: "1",
  });
  expect(header).toBe("20");
  expect(rows).toEqual(["20", "20"]);
});

// The per-machine figure and machine count survive as a labeled secondary line
// so the aggregate stays reconcilable to one machine's throughput.
test("per-machine rate and count render as labeled secondary text", () => {
  const { sub, mult } = renderedWithMultiplicity(1, { num: "2", denom: "1" });
  expect(sub).not.toBeNull();
  expect(sub!.textContent).toContain("10");
  expect(sub!.querySelector(".rate-sub-ea")).not.toBeNull();
  expect(mult).not.toBeNull();
  expect(mult!.textContent).toBe("x2");
});

// At multiplicity 1 the aggregate equals the per-machine rate, so the primary
// numbers are unchanged; only the explicit per-machine scope label is added,
// with no redundant "x1" count.
test("multiplicity of one leaves primary numbers unchanged with a scope label", () => {
  const { header, rows, sub, mult } = renderedWithMultiplicity(1, {
    num: "1",
    denom: "1",
  });
  expect(header).toBe("10");
  expect(rows).toEqual(["10", "10"]);
  expect(sub).not.toBeNull();
  expect(sub!.querySelector(".rate-sub-ea")).not.toBeNull();
  expect(mult).toBeNull();
});

// Small-rate corpus regression: a fractional multiplicity must not leave nodes
// claiming the per-machine ~30/min on a 0.06/min plan.
test("fractional multiplicity shows the small aggregate, not the per-machine rate", () => {
  const { header, rows } = renderedWithMultiplicity(3, {
    num: "1",
    denom: "500",
  });
  expect(header).toBe("0.06");
  expect(rows).toEqual(["0.06", "0.06"]);
});

// React Flow puts the `selected` flag on the wrapper and passes it as a
// NodeProp; the inner .recipe-node must forward it so the crafted
// .recipe-node.selected lime treatment can fire (it was dead CSS before).
test("selected prop forwards the selected class onto the card", () => {
  const props = {
    data: { recipe: RECIPE },
    selected: true,
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  expect(container.querySelector(".recipe-node")?.className).toContain(
    "selected",
  );
});

test("an unselected node carries no selected class", () => {
  const props = {
    data: { recipe: RECIPE },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  expect(container.querySelector(".recipe-node")?.className).not.toContain(
    "selected",
  );
});

// UX-20: the UPM unit label is a load-bearing node internal and must localize.
// In zh it renders the localized units-per-minute abbreviation, not "UPM".
test("UPM label localizes under zh", () => {
  const props = {
    data: { recipe: RECIPE },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = render(
    <ReactFlowProvider>
      <LocaleProvider locale="zh">
        <ItemPackProvider value={packWithSpeed(1)}>
          <RecipeNode {...props} />
        </ItemPackProvider>
      </LocaleProvider>
    </ReactFlowProvider>,
  );
  const lbl = container.querySelector(".rate-lbl")?.textContent;
  expect(lbl).toBe("件/分");
  expect(lbl).not.toBe("UPM");
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
