// The chip box mirrored from canvas.css. chipMetrics estimates a chip's width
// from constants that restate the .flow-chip rule the browser actually applies,
// and the module cannot see the stylesheet. Only the vertical half of that rule
// was pinned before (portZoneDepth pins max-width, the vertical padding and the
// border); the horizontal chrome -- sprite width, flex gap, horizontal padding
// -- was prose, so a CSS edit could widen every rendered chip past the box the
// seat reserved for it and only the Playwright width-bound spec would notice.

import { describe, it, expect } from "vitest";

import {
  CHIP_BORDER_PX,
  CHIP_GAP_PX,
  CHIP_ICON_PX,
  CHIP_PAD_X_PX,
} from "../../src/canvas/chipMetrics";
import { CHIP_BOX_HEIGHT } from "../../src/canvas/dimensions";
import { cssPx } from "../../src/canvas/cssContract.testkit";

describe("the chip's horizontal chrome matches the stylesheet it mirrors", () => {
  it("charges the .ico-16 sprite width for the item icon", () => {
    expect(cssPx(".ico-16", "width")).toBe(CHIP_ICON_PX);
  });

  it("charges the .flow-chip flex gap between sprite and text", () => {
    expect(cssPx(".flow-chip", "gap")).toBe(CHIP_GAP_PX);
  });

  it("charges the horizontal half of the .flow-chip padding shorthand", () => {
    // padding: 3px 7px -- index 0 is the vertical pad portZoneDepth pins, so
    // the horizontal one is index 1. Reading index 0 here would silently
    // under-charge every chip by 8px.
    expect(cssPx(".flow-chip", "padding", 1)).toBe(CHIP_PAD_X_PX);
  });

  it("charges the .flow-chip border on each side", () => {
    expect(cssPx(".flow-chip", "border")).toBe(CHIP_BORDER_PX);
  });
});

describe("a collapsed chip's box is the same square the seat reserves for it", () => {
  it("adds up to CHIP_BOX_HEIGHT from the icon-only padding and the border", () => {
    // .flow-chip.icon-only drops the digits and tightens the padding, so the
    // drawn box is the sprite plus that padding and the inherited border on
    // each side. chipSeatHalfW reserves CHIP_BOX_HEIGHT on both axes for such a
    // chip and calls it exact, not an estimate -- this is what makes it exact.
    const sprite = cssPx(".ico-16", "width");
    const padIconOnly = cssPx(".flow-chip.icon-only", "padding");
    const border = cssPx(".flow-chip", "border");

    expect(sprite + 2 * padIconOnly + 2 * border).toBe(CHIP_BOX_HEIGHT);
  });
});
