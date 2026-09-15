// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { cssBlock, cssPx, cssValue } from "./cssContract.testkit";
import { ENV_CAP_WIDTH, ENV_ROW_HEIGHT, envBannerLayers } from "./envBanner";
import { RECIPE_HEADER_HEIGHT, RECIPE_WIDTH } from "./dimensions";

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

// A catalyst is supplied from the plan boundary, so its row carries a target
// Handle in the `cat:` namespace and no transport glyph unless the port map
// names a kind. The row declares the draw the way an input row does: the
// aggregate across every machine, as a bare number. The charge is per MACHINE,
// though, so the aggregate counts whole machines: a card running 2.5 machines
// holds three machines' worth, and the per-machine figure moves to the row's
// tooltip.
test("a catalyst renders a cat: port row carrying the whole-machine aggregate draw", () => {
  // qty 1 over a 10s cycle at speed 1 is the pack's 6/min catalyst draw.
  const recipe: Recipe = {
    ...RECIPE,
    time: 10,
    catalyst: [{ item: "gas_xiranite", qty: 1 }],
  };
  const props = makeRecipeNodeProps({
    recipe,
    kind: "recipe",
    multiplicity: { num: "5", denom: "2" },
  });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));

  const row = container.querySelector<HTMLElement>(".rn-row.catalyst");
  expect(row).not.toBeNull();
  const handles = row!.querySelectorAll<HTMLElement>("[data-handleid]");
  expect(handles.length).toBe(1);
  expect(handles[0]!.getAttribute("data-handleid")).toBe("cat:gas_xiranite");
  // 2.5 machines hold three machines' charge: 3 * 6/min. The port rows below
  // still scale by the fractional 2.5, so the two figures differ on purpose.
  expect(row!.querySelector(".rate")?.textContent).toBe("18");
  expect(row!.getAttribute("title")).toBe("6/min per machine");
  // The port rows are untouched: the row adds one target handle on the left
  // and nothing on the right.
  expect(container.querySelectorAll('[data-handlepos="left"]').length).toBe(2);
  expect(container.querySelectorAll('[data-handlepos="right"]').length).toBe(1);
});

// A recipe with no catalyst renders exactly what it did before.
test("a catalyst-free recipe renders no catalyst row", () => {
  const props = makeRecipeNodeProps({ recipe: RECIPE });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  expect(container.querySelector(".rn-row.catalyst")).toBeNull();
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

// --- Environment requirement ----------------------------------------------
//
// Some recipes only run inside a gas environment the player builds a
// disperser for. The requirement shows on the card root: the data attribute
// marks it and the hover title names it in the active locale.

function renderedRoot(
  environment: "stable" | "acidic",
  locale: "en" | "zh" = "en",
) {
  const recipe: Recipe = { ...RECIPE, environment };
  const props = makeRecipeNodeProps({ recipe });
  const { container } = render(
    <ReactFlowProvider>
      <LocaleProvider locale={locale}>
        <ItemPackProvider value={packWithSpeed(1)}>
          <RecipeNode {...props} />
        </ItemPackProvider>
      </LocaleProvider>
    </ReactFlowProvider>,
  );
  return container.querySelector<HTMLElement>('[data-testid="recipe-node"]')!;
}

test("an environment recipe's root carries data-environment and a localised title; a plain recipe's carries neither", () => {
  const root = renderedRoot("stable");
  expect(root.getAttribute("data-environment")).toBe("stable");
  expect(root.getAttribute("title")).toBe("Stable environment");
  // The title localises, naming the environment in the active locale.
  expect(renderedRoot("stable", "zh").getAttribute("title")).toBe("稳定环境");
  expect(renderedRoot("acidic").getAttribute("data-environment")).toBe(
    "acidic",
  );

  const plainProps = makeRecipeNodeProps({ recipe: RECIPE });
  const { container } = wrap(<RecipeNode {...plainProps} />, packWithSpeed(1));
  const plainRoot = container.querySelector<HTMLElement>(
    '[data-testid="recipe-node"]',
  )!;
  expect(plainRoot.hasAttribute("data-environment")).toBe(false);
  expect(plainRoot.hasAttribute("title")).toBe(false);
  expect(container.querySelector(".rn-env")).toBeNull();
});

// The plate itself: one aria-hidden child the stylesheet paints the caps, the
// glyph and the haze from. canvas.css is never loaded under jsdom, so the
// token lookup feeding the SVG data URIs returns "" (probed: getComputedStyle
// on the bare documentElement yields the empty string for --ak-env-*); the
// three layer properties are therefore pinned against the URIs envBanner emits
// for that same plate colour, never against an embedded hue.
test("an environment card renders one aria-hidden .rn-env carrying the banner layer properties; a plain card renders none", () => {
  for (const environment of ["stable", "acidic"] as const) {
    const root = renderedRoot(environment);
    const plates = root.querySelectorAll(".rn-env");
    expect(plates.length).toBe(1);
    const el = plates[0] as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");

    const plate = getComputedStyle(document.documentElement)
      .getPropertyValue(`--ak-env-${environment}`)
      .trim();
    const layers = envBannerLayers(environment, plate);
    expect(el.style.getPropertyValue("--rn-env-glyph")).toBe(layers.glyph.uri);
    expect(el.style.getPropertyValue("--rn-env-cap-left")).toBe(
      layers.leftCap.uri,
    );
    expect(el.style.getPropertyValue("--rn-env-cap-right")).toBe(
      layers.rightCap.uri,
    );
    // The plate colour is the fourth property; the CSSOM drops an empty
    // value, so under jsdom exactly the three layer URIs are declared inline
    // and the browser run carries all four.
    expect(el.style.length).toBe(3);
  }
});

// The plate is the card's FIRST row: it stands above the header in the DOM,
// which is what puts it inside the card box instead of over the neighbour
// above.
test("the plate is the first child of an environment card, ahead of the header", () => {
  const root = renderedRoot("stable");
  const first = root.firstElementChild;
  expect(first?.className).toBe("rn-env");
  expect(first?.nextElementSibling?.className).toBe("rn-head");
});

// --- Environment frame contract (canvas.css) -------------------------------
//
// The DOM half above proves the element and its properties; this half pins
// the paint against the stylesheet text, the way every geometry contract is
// pinned.

// canvas.css with comments stripped, for rule-level scans the shared testkit
// does not expose (it pins single rules only).
const CANVAS_CSS = readFileSync(
  resolve(process.cwd(), "src/canvas/canvas.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

// Every whole rule whose selector list carries an entry containing `marker`.
function rulesWithSelectorContaining(marker: string): string[] {
  return [...CANVAS_CSS.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) =>
      m[1]!.split(",").some((entry) => entry.trim().includes(marker)),
    )
    .map((m) => m[0]!.trim());
}

describe("environment plate CSS contract", () => {
  test("keeps .rn-env in flow as a card row: one row tall, content width, no inset", () => {
    // One banner row tall, the height recipeHeight charges the card for.
    expect(cssPx(".rn-env", "height", 0)).toBe(ENV_ROW_HEIGHT);
    expect(cssValue(".rn-env", "pointer-events")).toBe("none");
    // In flow and unshifted: a block child of the card takes the card's
    // content width (.recipe-node is a 240px content box), so any width,
    // margin, inset or positioning here would break that identity.
    const block = cssBlock(".rn-env");
    expect(block).not.toMatch(
      /[;{]\s*(position|inset|top|left|right|bottom)\s*:/,
    );
    expect(block).not.toMatch(/[;{]\s*(width|margin|padding|border)\s*:/);
    expect(cssPx(".recipe-node", "width", 0)).toBe(RECIPE_WIDTH);
  });

  test("paints the haze as ::before behind the card", () => {
    expect(cssValue(".rn-env::before", "z-index")).toBe("-1");
    expect(cssValue(".rn-env::before", "inset")).toBe("0");
    expect(cssValue(".rn-env::before", "background")).toBe(
      "color-mix(in srgb, var(--rn-env-plate) 12%, transparent)",
    );
    expect(cssValue(".rn-env::before", "box-shadow")).toBe(
      "0 0 18px 4px color-mix(in srgb, var(--rn-env-plate) 14%, transparent)",
    );
  });

  test("paints the plate as four ordered background layers on the row itself", () => {
    const SOLID = "linear-gradient(var(--rn-env-plate), var(--rn-env-plate))";
    // Layer order is paint order: the glyph rides on top of the left cap, the
    // stretched solid and the right cap. There is no second plate.
    expect(cssValue(".rn-env", "background-image")).toBe(
      [
        "var(--rn-env-glyph)",
        "var(--rn-env-cap-left)",
        SOLID,
        "var(--rn-env-cap-right)",
      ].join(", "),
    );
    // A one-row cap SVG is ENV_CAP_WIDTH x ENV_ROW_HEIGHT natural and draws
    // at that size; the solid is 2px wider than the span between the two cap
    // boxes (2 * 72 - 2 = 142) so it peeks 1px into each cap's transparent
    // chevron gap instead of underfilling the seam. The glyph is 29/36 of the
    // row's height.
    expect(cssValue(".rn-env", "background-size")).toBe(
      [
        "auto calc(18px * 29 / 36)",
        "72px 18px",
        "calc(100% - 142px) 18px",
        "72px 18px",
      ].join(", "),
    );
    expect(2 * ENV_CAP_WIDTH - 2).toBe(142);
    // Glyph 3.5/36 from the top of the row, centred; the caps anchor to the
    // row's two ends.
    expect(cssValue(".rn-env", "background-position")).toBe(
      "center calc(18px * 3.5 / 36), left top, center top, right top",
    );
    expect(cssValue(".rn-env", "background-repeat")).toBe("no-repeat");
  });

  test("keeps the card's own box and header contract off the environment attribute", () => {
    for (const rule of rulesWithSelectorContaining(
      ".recipe-node[data-environment]",
    )) {
      expect(rule).not.toMatch(
        /[;{]\s*(border-color|border-width|width|height)\s*:/,
      );
    }
    expect(cssPx(".rn-head", "height")).toBe(RECIPE_HEADER_HEIGHT);
  });

  test("suppresses the outer selection ring on environment cards, after the ring rule itself", () => {
    expect(
      cssValue(".recipe-node.selected[data-environment]::before", "content"),
    ).toBe("none");
    // The override also has to sit after the ring rule in the stylesheet:
    // winning on source order as well as specificity keeps the cascade
    // readable and safe against a future specificity regression.
    const ringAt = CANVAS_CSS.indexOf(".recipe-node.selected::before");
    const suppressAt = CANVAS_CSS.indexOf(
      ".recipe-node.selected[data-environment]::before",
    );
    expect(ringAt).toBeGreaterThanOrEqual(0);
    expect(suppressAt).toBeGreaterThan(ringAt);
    // The card's own lime border rule is untouched by the suppression.
    expect(cssValue(".recipe-node.selected", "border")).toBe(
      "2px solid var(--ak-accent-lime)",
    );
  });

  test("zoom bands never gate the plate and their recipe border rules are unchanged", () => {
    const zoomRules = [
      ...rulesWithSelectorContaining("zoom-low"),
      ...rulesWithSelectorContaining("zoom-mid"),
    ];
    expect(zoomRules.length).toBeGreaterThan(0);
    for (const rule of zoomRules) {
      expect(rule).not.toMatch(/rn-env|data-environment/);
    }
    // The plate draws at every zoom band: no rule anywhere hides it.
    for (const rule of rulesWithSelectorContaining(".rn-env")) {
      expect(rule).not.toMatch(/display:\s*none/);
    }
    // The zoom-band recipe border rules stay as develop wrote them.
    const oneLine = (block: string) => block.trim().replace(/\s+/g, " ");
    expect(oneLine(cssBlock(".ak-canvas-theme.zoom-low .recipe-node"))).toBe(
      ".ak-canvas-theme.zoom-low .recipe-node { background: var(--ak-bg-secondary); border-color: var(--ak-divider-strong); }",
    );
    expect(oneLine(cssBlock(".ak-canvas-theme.zoom-mid .recipe-node"))).toBe(
      ".ak-canvas-theme.zoom-mid .recipe-node, .ak-canvas-theme.zoom-mid .product-node { border-color: var(--ak-divider-strong); }",
    );
  });
});
