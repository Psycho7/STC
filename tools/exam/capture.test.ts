import { describe, expect, test } from "vitest";
import {
  assertZoomAchieved,
  correctiveFileName,
  examUrl,
  readProvenance,
} from "./capture";

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

  // The achieved zoom is read back out of getComputedStyle, which Chromium
  // serialises to 6 significant digits. Above zoom 1 that quantisation alone
  // exceeds an absolute 1e-6, so a capture that landed exactly on the commanded
  // camera would fail on the read-back if the tolerance did not scale.
  test("accepts a computed-style read-back of a zoom above 1", () => {
    expect(() => assertZoomAchieved("t.png", 1.2345678, 1.23457)).not.toThrow();
  });

  test("rejects a clamped viewport", () => {
    expect(() => assertZoomAchieved("t.png", 3, 2)).toThrow(
      /commanded zoom 3 but the viewport achieved 2/,
    );
  });

  test("still rejects a small clamp above zoom 1", () => {
    expect(() => assertZoomAchieved("t.png", 2, 2.001)).toThrow();
  });
});

describe("examUrl", () => {
  test("puts the query before the fragment", () => {
    expect(examUrl("http://localhost:4174/", "#p=1")).toBe(
      "http://localhost:4174/?exam=1#p=1",
    );
  });
});

describe("readProvenance", () => {
  const PACK = { sourceCommit: "6a006762", gameVersion: "1.4" };

  test("passes a fully stamped build through", () => {
    expect(readProvenance({ commit: "fea16ad", pack: PACK })).toEqual({
      commit: "fea16ad",
      pack: PACK,
    });
  });

  test("keeps a dirty local stamp", () => {
    const got = readProvenance({ commit: "fea16ad-dirty", pack: PACK });
    expect(typeof got === "string" ? got : got.commit).toBe("fea16ad-dirty");
  });

  // A deployment built before the stamp existed still installs the hook, so the
  // capture only learns of it here. It must name the gap rather than write a
  // scene nothing can be attributed to.
  test("reports a build with no commit", () => {
    expect(readProvenance({ pack: PACK })).toBe(
      "window.__stcExam.commit is missing",
    );
    expect(readProvenance({ commit: "", pack: PACK })).toBe(
      "window.__stcExam.commit is missing",
    );
  });

  test("reports a build with no pack fingerprint", () => {
    expect(readProvenance({ commit: "fea16ad" })).toBe(
      "window.__stcExam.pack is missing",
    );
    expect(
      readProvenance({
        commit: "fea16ad",
        pack: { sourceCommit: "6a006762", gameVersion: "" },
      }),
    ).toBe("window.__stcExam.pack is missing");
  });
});
