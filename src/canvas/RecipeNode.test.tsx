// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

// The machine-count multiplier is CRITICAL info and rides the header title
// line right after the machine name, not the old absolute .rn-mult-badge
// overlay that collided with the rate block. It must be theme-styled (readable
// contrast), not the dead light-theme inline color:#444 / fontSize:11.
test("multiplier chip rides the title line with no inline color or font size", () => {
  const props = {
    data: { recipe: RECIPE, multiplier: 3 },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  // Exactly one multiplier element, inline in the machine title line.
  const chips = container.querySelectorAll(".rn-mult-chip");
  expect(chips.length).toBe(1);
  const chip = chips[0] as HTMLElement;
  expect(chip.textContent).toBe("x3");
  expect(chip.parentElement?.className).toBe("machine-title");
  // Not inside the rate block, so it never collides with the rate figures.
  expect(container.querySelector(".rn-rate-block .rn-mult-chip")).toBeNull();
  // The old absolute overlay is gone entirely.
  expect(container.querySelector(".rn-mult-badge")).toBeNull();
  expect(chip.style.color).toBe("");
  expect(chip.style.fontSize).toBe("");
});

// zoom-low LOD drops the sub-legible rate figures (value / unit label /
// per-machine line) but the multiplier chip is critical and survives as the sole
// surviving rate-area element. It lives outside .rn-rate-block, so the block's
// hide rules never reach it. Inject the real canvas.css zoom-low selectors and
// assert the cascade: chip visible, rate figures hidden.
test("multiplier chip survives zoom-low while the rate figures hide", () => {
  document.head.insertAdjacentHTML(
    "beforeend",
    `<style id="zoom-low-probe">
       .ak-canvas-theme.zoom-low .rn-head .rn-rate-block .rate-val,
       .ak-canvas-theme.zoom-low .rn-head .rn-rate-block .rate-lbl,
       .ak-canvas-theme.zoom-low .rn-head .rn-rate-block .rate-sub {
         display: none;
       }
     </style>`,
  );
  const props = {
    data: { recipe: RECIPE, multiplier: 3 },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = render(
    <ReactFlowProvider>
      <LocaleProvider locale="en">
        <ItemPackProvider value={packWithSpeed(1)}>
          <div className="ak-canvas-theme zoom-low">
            <RecipeNode {...props} />
          </div>
        </ItemPackProvider>
      </LocaleProvider>
    </ReactFlowProvider>,
  );
  const chip = container.querySelector<HTMLElement>(".rn-mult-chip")!;
  const rateVal = container.querySelector<HTMLElement>(".rate-val")!;
  const rateLbl = container.querySelector<HTMLElement>(".rate-lbl")!;
  const rateSub = container.querySelector<HTMLElement>(".rate-sub")!;
  expect(getComputedStyle(chip).display).not.toBe("none");
  expect(getComputedStyle(rateVal).display).toBe("none");
  expect(getComputedStyle(rateLbl).display).toBe("none");
  expect(getComputedStyle(rateSub).display).toBe("none");
  document.getElementById("zoom-low-probe")?.remove();
});

// The header title identifies the machine; the produced items ride the
// secondary .rn-products line instead of the old .product title line.
test("header title is the machine name with the products on the secondary line", () => {
  const props = {
    data: { recipe: RECIPE, multiplier: 3 },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  const title = container.querySelector(".machine-title .cn");
  expect(title?.textContent).toBe("mk1");
  expect(container.querySelector(".product")).toBeNull();
  expect(container.querySelector(".rn-products")?.textContent).toBe("plate");
});

// A recipe with several outputs lists every product, in declaration order,
// with the full list hoverable via the title attribute.
test("multi-output recipe lists all products on the secondary line", () => {
  const recipe = {
    ...RECIPE,
    out: [
      { item: "plate", qty: 1 },
      { item: "slag", qty: 2 },
    ],
  } as unknown as Recipe;
  const props = {
    data: { recipe },
  } as unknown as ComponentProps<typeof RecipeNode>;
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  const products = container.querySelector(".rn-products");
  expect(products?.textContent).toBe("plate ·\u00A0slag");
  expect(products?.getAttribute("title")).toBe("plate ·\u00A0slag");
});

// The products line is the only per-recipe discriminator on the card (the title
// is the machine name, so same-machine cards share it), and one ellipsized 11px
// line fits about 21 characters, which cuts most item names before they differ.
// It clamps to two lines instead; the pinned 80px header has the headroom.
// jsdom does no layout, so the rule text itself is the assertable contract.
test("the header products line clamps to two lines instead of one ellipsized line", () => {
  const css = readFileSync(
    resolve(process.cwd(), "src/canvas/canvas.css"),
    "utf8",
  );
  const block = css.match(/^\.rn-head \.rn-products\s*\{[^}]*\}/m);
  expect(block).not.toBeNull();
  expect(block![0]).toMatch(/-webkit-line-clamp:\s*2/);
  expect(block![0]).not.toMatch(/white-space:\s*nowrap/);
  // CJK text breaks between any two Han characters by default, which splits
  // a single item name mid-word across the clamp's two lines (zh exam Z4b).
  // keep-all restricts breaks to the separator spaces the join provides.
  expect(block![0]).toMatch(/word-break:\s*keep-all/);
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
  const mult = container.querySelector(".rn-mult-chip");
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

// The per-machine figure survives as a labeled secondary line so the aggregate
// stays reconcilable to one machine's throughput; the machine count is promoted
// to the header multiplier chip (outside the .rate-sub line) instead.
test("per-machine rate renders as labeled secondary text, count as the header chip", () => {
  const { sub, mult } = renderedWithMultiplicity(1, { num: "2", denom: "1" });
  expect(sub).not.toBeNull();
  expect(sub!.textContent).toContain("10");
  expect(sub!.querySelector(".rate-sub-ea")).not.toBeNull();
  // The count is no longer in the secondary line.
  expect(sub!.textContent).not.toContain("x2");
  expect(sub!.querySelector(".rn-mult-chip")).toBeNull();
  // It renders once, in the header chip.
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

// 8B: each port's React Flow Handle and its PortGlyph render INSIDE the
// .rn-row for that item, so the DOM row center is the anchor truth instead of a
// computed constant offset. The handle carries no inline `top` (it centers via
// CSS top:50%), and per-side handle ids/counts are unchanged.
test("handle and port glyph render inside their recipe row", () => {
  const props = {
    data: {
      recipe: RECIPE,
      portTransportKinds: new Map([
        ["in:ore", "belt"],
        ["out:plate", "belt"],
      ]),
    },
  } as unknown as ComponentProps<typeof RecipeNode>;
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
