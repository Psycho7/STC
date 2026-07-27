import { describe, expect, test } from "vitest";
import { assertZoomAchieved, correctiveFileName, examUrl } from "./capture";

describe("correctiveFileName", () => {
  // The regression: bus chip ids carry their family suffix at the END, so two
  // chips of one long edge id agree over the first 80 characters and used to
  // slug to a single filename. Both PNGs then landed on one path while two
  // records claimed one of each.
  test("keeps two long ids that differ only past the slug cut apart", () => {
    const edgeId = `e:0:u:class:q:0->u:out:${"copper_bottle_".repeat(6)}end`;
    const drop = `bus-edge-label-${edgeId}-drop`;
    const rise = `bus-edge-label-${edgeId}-rise`;
    expect(drop.slice(0, 80)).toBe(rise.slice(0, 80));
    expect(correctiveFileName(3, drop)).not.toBe(correctiveFileName(4, rise));
  });

  test("orders lexicographically with the shot order", () => {
    expect(correctiveFileName(0, "a")).toBe("20-corrective-000-a.png");
    expect(correctiveFileName(12, "a")).toBe("20-corrective-012-a.png");
  });

  test("names an id with no usable characters", () => {
    expect(correctiveFileName(1, "///")).toBe("20-corrective-001-element.png");
  });
});

describe("assertZoomAchieved", () => {
  test("accepts float noise", () => {
    expect(() => assertZoomAchieved("t.png", 0.75, 0.75 + 1e-9)).not.toThrow();
  });

  test("rejects a clamped viewport", () => {
    expect(() => assertZoomAchieved("t.png", 3, 2)).toThrow(
      /commanded zoom 3 but the viewport achieved 2/,
    );
  });
});

describe("examUrl", () => {
  test("puts the query before the fragment", () => {
    expect(examUrl("http://localhost:4174/", "#p=1")).toBe(
      "http://localhost:4174/?exam=1#p=1",
    );
  });
});
