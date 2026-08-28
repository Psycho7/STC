// The trunk-ownership default, pinned in one place. isTrunkOwner is the shared
// reader four sites adopted (BusEdge's aggregate chip, Canvas's hover-group
// lighting, and both of contentBounds' aggregate frames), so the "absent means
// owner" rule that keeps un-annotated fixtures drawing their aggregate lives
// here rather than being restated at each call. Two chipSeating sites stay on a
// strict `busChipOwner === true` on purpose; that divergence is documented at
// those sites and is deliberately NOT unified.

import { describe, it, expect } from "vitest";

import { isTrunkOwner } from "../../src/canvas/busRouting";

describe("canvas/isTrunkOwner", () => {
  it("treats absent data as owner", () => {
    expect(isTrunkOwner(undefined)).toBe(true);
  });

  it("treats an absent busChipOwner as owner", () => {
    expect(isTrunkOwner({ trunkKey: "iron|src" })).toBe(true);
  });

  it("treats an explicit false as non-owner", () => {
    expect(isTrunkOwner({ trunkKey: "iron|src", busChipOwner: false })).toBe(
      false,
    );
  });

  it("treats an explicit true as owner", () => {
    expect(isTrunkOwner({ trunkKey: "iron|src", busChipOwner: true })).toBe(
      true,
    );
  });
});
