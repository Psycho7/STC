import { describe, expect, it } from "vitest";
import { itemOfPort, parsePort, portId } from "./port-ids";

describe("port id codec", () => {
  it("builds side-prefixed ids", () => {
    expect(portId("in", "iron_ore")).toBe("in:iron_ore");
    expect(portId("cat", "gas_xiranite")).toBe("cat:gas_xiranite");
    expect(portId("out", "iron_powder")).toBe("out:iron_powder");
  });

  it("round-trips every side", () => {
    for (const side of ["in", "cat", "out"] as const) {
      expect(parsePort(portId(side, "x"))).toEqual({ side, item: "x" });
      expect(itemOfPort(portId(side, "x"))).toBe("x");
    }
  });

  it("returns bare and unknown ids unchanged", () => {
    expect(parsePort("iron_ore")).toBeUndefined();
    expect(parsePort("np-in:x")).toBeUndefined();
    expect(itemOfPort("iron_ore")).toBe("iron_ore");
    expect(itemOfPort("np-in:x")).toBe("np-in:x");
  });

  it("strips only the sides a caller accepts", () => {
    expect(itemOfPort("out:x", ["out"])).toBe("x");
    expect(itemOfPort("in:x", ["out"])).toBe("in:x");
    expect(itemOfPort("cat:x", ["in", "cat"])).toBe("x");
    expect(itemOfPort("out:x", ["in", "cat"])).toBe("out:x");
  });
});
