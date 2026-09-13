// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { ReactNode } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { cleanup, render } from "@testing-library/react";
import type { Recipe } from "@aef/schema";
import RecipeNode from "./RecipeNode";
import { ItemPackProvider, type ItemPackContextValue } from "./itemPackContext";
import {
  makeMachine,
  makePackValue,
  makeRecipeNodeProps,
} from "./node.testkit";
import { LocaleProvider } from "../data/i18n-context";

afterEach(cleanup);

function packWithSpeed(speed: number): ItemPackContextValue {
  return makePackValue({ machines: [makeMachine("mk1", { speed })] });
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
const RECIPE: Recipe = {
  id: "smelt",
  name: "smelt",
  category: "assemble",
  icon: "smelt",
  row: 0,
  time: 6,
  producers: ["mk1"],
  in: [{ item: "ore", qty: 1 }],
  out: [{ item: "plate", qty: 1 }],
};

function renderedRates(speed: number, multiplier?: number) {
  const props = makeRecipeNodeProps({
    recipe: RECIPE,
    ...(multiplier !== undefined ? { multiplier } : {}),
  });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(speed));
  const rows = [...container.querySelectorAll(".rn-row .rate")].map(
    (el) => el.textContent,
  );
  return { rows };
}

// Per-machine rates must carry the machine.speed factor the solver applies
// (executionRate = multiplicity * speed / time), or the node disagrees with
// the multiplicity-scaled edge rates by exactly the speed factor.
test("row rates scale by machine.speed", () => {
  const { rows } = renderedRates(2);
  expect(rows).toEqual(["20", "20"]);
});

test("fractional machine.speed stays exact", () => {
  const { rows } = renderedRates(0.5);
  expect(rows).toEqual(["5", "5"]);
});

// All shipped pack machines have speed 1; display must be byte-identical there.
test("speed-1 machine output is unchanged", () => {
  const { rows } = renderedRates(1);
  expect(rows).toEqual(["10", "10"]);
});

// The older boot path scales by the integer replica multiplier; the speed
// factor composes with it.
test("speed composes with the legacy multiplier path", () => {
  const { rows } = renderedRates(2, 3);
  expect(rows).toEqual(["60", "60"]);
});

// The machine-count multiplier is CRITICAL info and rides the header title
// line right after the machine name, not the old absolute .rn-mult-badge
// overlay. It must be theme-styled (readable contrast), not the dead
// light-theme inline color:#444 / fontSize:11.
test("multiplier chip rides the title line with no inline color or font size", () => {
  const props = makeRecipeNodeProps({ recipe: RECIPE, multiplier: 3 });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  // Exactly one multiplier element, inline in the machine title line.
  const chips = container.querySelectorAll(".rn-mult-chip");
  expect(chips.length).toBe(1);
  const chip = chips[0] as HTMLElement;
  expect(chip.textContent).toBe("x3");
  expect(chip.parentElement?.className).toBe("machine-title");
  // The old absolute overlay is gone entirely.
  expect(container.querySelector(".rn-mult-badge")).toBeNull();
  expect(chip.style.color).toBe("");
  expect(chip.style.fontSize).toBe("");
});

// The header title identifies the machine.
test("header title is the machine name", () => {
  const props = makeRecipeNodeProps({ recipe: RECIPE, multiplier: 3 });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  const title = container.querySelector(".machine-title .cn");
  expect(title?.textContent).toBe("mk1");
  expect(container.querySelector(".product")).toBeNull();
});

// The raw machine id (e.g. "mk1") reads as debug output; the localized machine
// name already identifies the producer, so the mono id line is dropped.
test("recipe node does not render the raw machine id line", () => {
  const props = makeRecipeNodeProps({ recipe: RECIPE, multiplier: 1 });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  expect(container.querySelector(".machine-mid")).toBeNull();
});

// Render-pipeline path: the node data carries a rational `multiplicity` (the
// solved machine count) instead of the boot path's integer `multiplier`.
function renderedWithMultiplicity(
  speed: number,
  multiplicity: { num: string; denom: string },
) {
  const props = makeRecipeNodeProps({
    recipe: RECIPE,
    kind: "recipe",
    multiplicity,
  });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(speed));
  const rows = [...container.querySelectorAll(".rn-row .rate")].map(
    (el) => el.textContent,
  );
  const mult = container.querySelector(".rn-mult-chip");
  return { rows, mult };
}

// UX-10: with a multiplicity of N the node must show the aggregate rate
// (per-machine x N) on its rows, so node numbers match the incident edge
// chips instead of showing one machine's share.
test("multiplicity scales rows to the aggregate rate", () => {
  const { rows } = renderedWithMultiplicity(1, {
    num: "2",
    denom: "1",
  });
  expect(rows).toEqual(["20", "20"]);
});

// At multiplicity 1 the aggregate equals the per-machine rate, so the row
// numbers are unchanged, with no redundant "x1" count chip.
test("multiplicity of one leaves row numbers unchanged with no chip", () => {
  const { rows, mult } = renderedWithMultiplicity(1, {
    num: "1",
    denom: "1",
  });
  expect(rows).toEqual(["10", "10"]);
  expect(mult).toBeNull();
});

// Small-rate corpus regression: a fractional multiplicity must not leave nodes
// claiming the per-machine ~30/min on a 0.06/min plan.
test("fractional multiplicity shows the small aggregate, not the per-machine rate", () => {
  const { rows } = renderedWithMultiplicity(3, {
    num: "1",
    denom: "500",
  });
  expect(rows).toEqual(["0.06", "0.06"]);
});

// React Flow puts the `selected` flag on the wrapper and passes it as a
// NodeProp; the inner .recipe-node must forward it so the crafted
// .recipe-node.selected lime treatment can fire (it was dead CSS before).
test("selected prop forwards the selected class onto the card", () => {
  const props = makeRecipeNodeProps({ recipe: RECIPE }, true);
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  expect(container.querySelector(".recipe-node")?.className).toContain(
    "selected",
  );
});

test("an unselected node carries no selected class", () => {
  const props = makeRecipeNodeProps({ recipe: RECIPE });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  expect(container.querySelector(".recipe-node")?.className).not.toContain(
    "selected",
  );
});

// Selected-path reveal contract for the row-rate overlay (jsdom cannot
// drive :hover; the rate-reveal e2e covers the pointer path). Inject the
// canvas.css rules verbatim -- base hide, hover/selected reveal, zoom-low
// suppression -- and assert the cascade a browser would compute: a
// selected card's row rates show, an unselected card's stay hidden.
test("a selected card reveals its row rates; an unselected card keeps them hidden", () => {
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="rate-reveal-probe">
       .rn-row .rate {
         display: none;
       }
       .recipe-node:hover .rn-row .rate,
       .recipe-node.selected .rn-row .rate {
         display: block;
       }
       .ak-canvas-theme.zoom-low .recipe-node .rn-row .rate {
         display: none;
       }
     </style>`,
  );
  const selected = wrap(
    <RecipeNode {...makeRecipeNodeProps({ recipe: RECIPE }, true)} />,
    packWithSpeed(1),
  );
  const unselected = wrap(
    <RecipeNode {...makeRecipeNodeProps({ recipe: RECIPE })} />,
    packWithSpeed(1),
  );
  const displays = (container: HTMLElement) =>
    [...container.querySelectorAll(".rn-row .rate")].map(
      (el) => getComputedStyle(el).display,
    );
  expect(displays(selected.container as HTMLElement)).toEqual([
    "block",
    "block",
  ]);
  expect(displays(unselected.container as HTMLElement)).toEqual([
    "none",
    "none",
  ]);
  document.getElementById("rate-reveal-probe")?.remove();
});

// 8B: each port's React Flow Handle and its PortGlyph render INSIDE the
// .rn-row for that item, so the DOM row center is the anchor truth instead of a
// computed constant offset. The handle carries no inline `top` (it centers via
// CSS top:50%), and per-side handle ids/counts are unchanged.
test("handle and port glyph render inside their recipe row", () => {
  const props = makeRecipeNodeProps({
    recipe: RECIPE,
    portTransportKinds: new Map([
      ["in:ore", "belt"],
      ["out:plate", "belt"],
    ]),
  });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));

  const inputRow = container.querySelector<HTMLElement>(
    ".rn-side.in .rn-row.input",
  );
  const outputRow = container.querySelector<HTMLElement>(
    ".rn-side.out .rn-row.output",
  );
  expect(inputRow).not.toBeNull();
  expect(outputRow).not.toBeNull();

  const inHandle = inputRow!.querySelector<HTMLElement>("[data-handleid]");
  expect(inHandle).not.toBeNull();
  expect(inHandle!.getAttribute("data-handleid")).toBe("in:ore");
  expect(inHandle!.style.top).toBe("");
  expect(inputRow!.querySelector("[data-glyph]")).not.toBeNull();

  const outHandle = outputRow!.querySelector<HTMLElement>("[data-handleid]");
  expect(outHandle).not.toBeNull();
  expect(outHandle!.getAttribute("data-handleid")).toBe("out:plate");
  expect(outHandle!.style.top).toBe("");
  expect(outputRow!.querySelector("[data-glyph]")).not.toBeNull();

  // Per-side handle counts unchanged: one target, one source.
  expect(container.querySelectorAll('[data-handlepos="left"]').length).toBe(1);
  expect(container.querySelectorAll('[data-handlepos="right"]').length).toBe(1);
});

// A corrupt fixture can reference a missing machine; the rate falls back to
// speed 1 instead of crashing.
test("missing machine record falls back to speed 1", () => {
  const props = makeRecipeNodeProps({ recipe: RECIPE });
  const emptyPack = makePackValue();
  const { container } = wrap(<RecipeNode {...props} />, emptyPack);
  const rows = [...container.querySelectorAll(".rn-row .rate")].map(
    (el) => el.textContent,
  );
  expect(rows).toEqual(["10", "10"]);
});
