// The loop caption follows the canvas's one elision rule: a caption too long
// for its band keeps its head and ends with an ellipsis, and the full caption is
// on a hover title the pointer can reach. The band is as wide as the paint
// region it sits on, not one card.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import LoopCaption from "../../src/canvas/LoopCaption";
import { loopCaption } from "../../src/canvas/loopPaint";
import { cssValue } from "../../src/canvas/cssContract.testkit";
import { loadI18n } from "../../src/data/i18n";

afterEach(() => {
  cleanup();
});

const en = loadI18n("en");
// battery5's planter loop, captioned in en.
const FULL = loopCaption(["plant_moss_3", "plant_moss_seed_3"], (id) =>
  en.displayName(id),
);

const ELLIPSIS = "…";

function captionOf(width: number): HTMLElement {
  const { getByTestId } = render(
    <LoopCaption
      band={{ left: 0, right: width, top: 0, bottom: 22 }}
      text={FULL}
    />,
  );
  return getByTestId("loop-caption");
}

describe("the loop caption in en", () => {
  it("keeps the head and ends with an ellipsis when the band is too narrow", () => {
    const el = captionOf(160);
    const shown = el.textContent!;
    expect(shown.endsWith(ELLIPSIS)).toBe(true);
    const head = shown.slice(0, -1);
    expect(head.length).toBeGreaterThanOrEqual("LOOP".length);
    expect(FULL.toUpperCase().startsWith(head)).toBe(true);
  });

  it("carries the full caption on its hover title", () => {
    expect(captionOf(160).title).toBe(FULL);
  });

  it("draws the whole caption when the band fits it", () => {
    const el = captionOf(4000);
    expect(el.textContent).toBe(FULL.toUpperCase());
  });

  it("is a block the pointer reaches, so the ellipsis applies and the title shows", () => {
    // text-overflow never reaches the anonymous text of a flex box, and a
    // caption the pointer passes through never shows its title.
    expect(cssValue(".loop-caption", "display")).toBe("block");
    expect(cssValue(".loop-caption", "pointer-events")).toBe("auto");
  });
});
