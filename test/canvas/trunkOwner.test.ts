// The trunk-ownership default, pinned in one place. isTrunkOwner is the shared
// reader three sites adopted (BusEdge's aggregate chip, Canvas's chip exemption
// under a branch hover, and contentBounds' aggregate frame), so the "absent
// means owner" rule that keeps un-annotated fixtures drawing their aggregate
// lives here rather than being restated at each call.

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
