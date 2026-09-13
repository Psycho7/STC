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
import { envBannerLayers } from "./envBanner";
import { RECIPE_HEADER_HEIGHT } from "./dimensions";

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
  const props = makeRecipeNodeProps({ recipe: RECIPE, multiplier: 3 });
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
  const props = makeRecipeNodeProps({ recipe: RECIPE, multiplier: 3 });
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
  const props = makeRecipeNodeProps({ recipe: RECIPE, multiplier: 3 });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));
  const title = container.querySelector(".machine-title .cn");
  expect(title?.textContent).toBe("mk1");
  expect(container.querySelector(".product")).toBeNull();
  expect(container.querySelector(".rn-products")?.textContent).toBe("plate");
});

// A recipe with several outputs lists every product, in declaration order,
// with the full list hoverable via the title attribute.
test("multi-output recipe lists all products on the secondary line", () => {
  const recipe: Recipe = {
    ...RECIPE,
    out: [
      { item: "plate", qty: 1 },
      { item: "slag", qty: 2 },
    ],
  };
  const props = makeRecipeNodeProps({ recipe });
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
  const block = cssBlock(".rn-head .rn-products");
  expect(block).toMatch(/-webkit-line-clamp:\s*2/);
  expect(block).not.toMatch(/white-space:\s*nowrap/);
  // CJK text breaks between any two Han characters by default, which splits
  // a single item name mid-word across the clamp's two lines (zh exam Z4b).
  // keep-all restricts breaks to the separator spaces the join provides.
  expect(block).toMatch(/word-break:\s*keep-all/);
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

// UX-20: the UPM unit label is a load-bearing node internal and must localize.
// In zh it renders the localized units-per-minute abbreviation, not "UPM".
test("UPM label localizes under zh", () => {
  const props = makeRecipeNodeProps({ recipe: RECIPE });
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

// A catalyst is cycled, not consumed, so its row carries no Handle: an edge
// endpoint that landed on it would claim a supplier the plan never builds. The
// row still declares the draw, in full units, at the per-machine figure.
test("a catalyst renders a port-less row carrying the per-machine draw", () => {
  // qty 1 over a 10s cycle at speed 1 is the pack's 6/min catalyst draw.
  const recipe: Recipe = {
    ...RECIPE,
    time: 10,
    catalyst: [{ item: "gas_xiranite", qty: 1 }],
  };
  const props = makeRecipeNodeProps({
    recipe,
    kind: "recipe",
    multiplicity: { num: "3", denom: "1" },
  });
  const { container } = wrap(<RecipeNode {...props} />, packWithSpeed(1));

  const row = container.querySelector<HTMLElement>(".rn-row.catalyst");
  expect(row).not.toBeNull();
  expect(row!.querySelectorAll("[data-handleid]").length).toBe(0);
  expect(row!.querySelector("[data-glyph]")?.getAttribute("data-glyph")).toBe(
    "catalyst",
  );
  // Per machine even at multiplicity 3, and carrying the unit the aggregate
  // port rows leave to the header.
  expect(row!.querySelector(".rate")?.textContent).toBe("6/min");
  // The ports are untouched: one target, one source, neither on this row.
  expect(container.querySelectorAll('[data-handlepos="left"]').length).toBe(1);
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
  expect(container.querySelector(".rate-val")?.textContent).toBe("10");
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

// The frame itself: one aria-hidden child the stylesheet paints the plates
// and the haze from. canvas.css is never loaded under jsdom, so the token
// lookup feeding the SVG data URIs returns "" (probed: getComputedStyle on
// the bare documentElement yields the empty string for --ak-env-*); the five
// layer properties are therefore pinned against the URIs envBanner emits for
// that same plate colour, never against an embedded hue.
test("an environment card renders one aria-hidden .rn-env carrying the banner layer properties; a plain card renders none", () => {
  for (const environment of ["stable", "acidic"] as const) {
    const root = renderedRoot(environment);
    const frames = root.querySelectorAll(".rn-env");
    expect(frames.length).toBe(1);
    const frame = frames[0] as HTMLElement;
    expect(frame.getAttribute("aria-hidden")).toBe("true");

    const plate = getComputedStyle(document.documentElement)
      .getPropertyValue(`--ak-env-${environment}`)
      .trim();
    const layers = envBannerLayers(environment, plate);
    expect(frame.style.getPropertyValue("--rn-env-glyph")).toBe(
      layers.top.glyph.uri,
    );
    expect(frame.style.getPropertyValue("--rn-env-top-left")).toBe(
      layers.top.leftCap.uri,
    );
    expect(frame.style.getPropertyValue("--rn-env-top-right")).toBe(
      layers.top.rightCap.uri,
    );
    expect(frame.style.getPropertyValue("--rn-env-bottom-left")).toBe(
      layers.bottom.leftCap.uri,
    );
    expect(frame.style.getPropertyValue("--rn-env-bottom-right")).toBe(
      layers.bottom.rightCap.uri,
    );
    // The plate colour is the sixth property; the CSSOM drops an empty
    // value, so under jsdom exactly the five layer URIs are declared inline
    // and the browser run carries all six.
    expect(frame.style.length).toBe(5);
  }
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

describe("environment frame CSS contract", () => {
  test("pins .rn-env to the frame rectangle, out of layout and interaction", () => {
    expect(cssValue(".rn-env", "position")).toBe("absolute");
    expect(cssValue(".rn-env", "pointer-events")).toBe("none");
    // 8px gap every side: top 8 + 28 (two-row plate), bottom 8 + 14
    // (single-row plate), so the frame reaches 36 above and 22 below.
    expect(cssPx(".rn-env", "inset", 0)).toBe(-36);
    expect(cssPx(".rn-env", "inset", 1)).toBe(-8);
    expect(cssPx(".rn-env", "inset", 2)).toBe(-22);
    // The sides stay open: no border on the frame element.
    expect(cssBlock(".rn-env")).not.toMatch(/border/);
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

  test("paints the plates as seven ordered ::after background layers", () => {
    const SOLID = "linear-gradient(var(--rn-env-plate), var(--rn-env-plate))";
    // Layer order is paint order: the glyph rides on top, each plate reads
    // left cap, stretched solid, right cap, bottom plate last.
    expect(cssValue(".rn-env::after", "background-image")).toBe(
      [
        "var(--rn-env-glyph)",
        "var(--rn-env-top-left)",
        SOLID,
        "var(--rn-env-top-right)",
        "var(--rn-env-bottom-left)",
        SOLID,
        "var(--rn-env-bottom-right)",
      ].join(", "),
    );
    // Cap width 72 * plateHeight / (18 * rows) -- 56px at both plate
    // heights; the glyph is 29/36 of the top plate's height. Each solid is
    // 2px wider than the span between the cap boxes (2 * 56 - 2 = 110) so
    // it peeks 1px into the caps' transparent chevron gaps instead of
    // underfilling the seam.
    expect(cssValue(".rn-env::after", "background-size")).toBe(
      [
        "auto calc(28px * 29 / 36)",
        "calc(72px * 28 / 36) 28px",
        "calc(100% - 110px) 28px",
        "calc(72px * 28 / 36) 28px",
        "calc(72px * 14 / 18) 14px",
        "calc(100% - 110px) 14px",
        "calc(72px * 14 / 18) 14px",
      ].join(", "),
    );
    // Glyph 3.5/36 from the top of the plate, centred; the plates anchor to
    // the frame rect's top and bottom edges.
    expect(cssValue(".rn-env::after", "background-position")).toBe(
      "center calc(28px * 3.5 / 36), left top, center top, right top, left bottom, center bottom, right bottom",
    );
    expect(cssValue(".rn-env::after", "background-repeat")).toBe("no-repeat");
    // No side lines: the pseudo carries no border either.
    expect(cssBlock(".rn-env::after")).not.toMatch(/border/);
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

  test("zoom bands never gate the frame and their recipe border rules are unchanged", () => {
    const zoomRules = [
      ...rulesWithSelectorContaining("zoom-low"),
      ...rulesWithSelectorContaining("zoom-mid"),
    ];
    expect(zoomRules.length).toBeGreaterThan(0);
    for (const rule of zoomRules) {
      expect(rule).not.toMatch(/rn-env|data-environment/);
    }
    // The frame draws at every zoom band: no rule anywhere hides it.
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
