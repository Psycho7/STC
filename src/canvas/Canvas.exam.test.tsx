// @vitest-environment jsdom
//
// The exam camera hook is the only way an external driver can place the camera
// exactly: wheel zoom pins the world point under the cursor, so it cannot
// translate the view to a commanded rect. The hook is gated on a URL query
// param, so the two facts worth pinning are that a plain load carries no global
// at all and that the gated load exposes the exact three-method surface the
// driver calls. React Flow is deliberately NOT mocked here: the point of the
// install test is that the real useReactFlow instance backs the hook.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import type { Recipe } from "@aef/schema";
import Canvas from "./Canvas";
import { ItemPackProvider, type ItemPackContextValue } from "./itemPackContext";
import { LocaleProvider } from "../data/i18n-context";
import { pack } from "../data/load";

const PACK = {
  itemById: new Map(),
  overrides: [],
  machineById: new Map([["mk1", { id: "mk1", icon: "mk1" }]]),
} as unknown as ItemPackContextValue;

const RECIPE = {
  id: "widget_recipe",
  category: "assemble",
  time: 2,
  producers: ["mk1"],
  in: [{ item: "ore", qty: 1 }],
  out: [{ item: "widget", qty: 1 }],
} as unknown as Recipe;

// Two standalone recipes plus a container box, matching the fixture shape the
// hover tests in Canvas.test.tsx use.
const HOVER_NODES: Node[] = [
  {
    id: "u1",
    type: "recipe",
    position: { x: 0, y: 0 },
    data: { recipe: RECIPE, kind: "recipe" },
  },
  {
    id: "u2",
    type: "recipe",
    position: { x: 0, y: 0 },
    data: { recipe: RECIPE, kind: "recipe" },
  },
  {
    id: "g1",
    type: "group",
    position: { x: 0, y: 0 },
    data: {
      containerKind: "loop-box",
      containerId: "loop:scc-1",
      memberCount: 1,
    },
  },
];

// A second plan placed far enough away that its bounds cannot overlap the first
// set's: any rect covering these nodes starts to the right of where the first
// set ends, which is what makes a stale hook detectable.
const MOVED_NODES: Node[] = [
  {
    id: "m1",
    type: "recipe",
    position: { x: 20000, y: 20000 },
    data: { recipe: RECIPE, kind: "recipe" },
  },
];

function canvasTree(nodes: Node[], edges: Edge[]) {
  return (
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={nodes} edges={edges} />
      </ItemPackProvider>
    </LocaleProvider>
  );
}

function renderCanvas(nodes: Node[], edges: Edge[]) {
  return render(canvasTree(nodes, edges));
}

describe("exam camera hook", () => {
  beforeEach(() => {
    delete window.__stcExam;
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
    delete window.__stcExam;
  });

  test("is absent without the exam query param", () => {
    window.history.replaceState(null, "", "/");
    renderCanvas(HOVER_NODES, []);
    expect(window.__stcExam).toBeUndefined();
  });

  test("is installed when exam=1 is present", () => {
    window.history.replaceState(null, "", "/?exam=1");
    renderCanvas(HOVER_NODES, []);
    expect(typeof window.__stcExam?.setViewport).toBe("function");
    expect(typeof window.__stcExam?.fitView).toBe("function");
    expect(typeof window.__stcExam?.contentBounds).toBe("function");
    expect(typeof window.__stcExam?.chipReservations).toBe("function");
  });

  // The provenance pair a capture stamps into its scene document. The pack
  // fingerprint comes from the bundled pack, so its value is pinned; the commit
  // is baked in at build time and reads "unknown" under vitest, so only its
  // presence is.
  test("carries the build and pack fingerprints", () => {
    window.history.replaceState(null, "", "/?exam=1");
    renderCanvas(HOVER_NODES, []);
    expect(typeof window.__stcExam?.commit).toBe("string");
    expect(window.__stcExam?.commit).not.toBe("");
    expect(window.__stcExam?.pack.sourceCommit).toBe(pack.source.sourceCommit);
    expect(window.__stcExam?.pack.gameVersion).toBe(pack.source.gameVersion);
  });

  test("contentBounds returns null for an empty graph", () => {
    window.history.replaceState(null, "", "/?exam=1");
    renderCanvas([], []);
    expect(window.__stcExam?.contentBounds()).toBeNull();
  });

  test("contentBounds returns a finite rect for a populated graph", () => {
    window.history.replaceState(null, "", "/?exam=1");
    renderCanvas(HOVER_NODES, []);
    const b = window.__stcExam!.contentBounds()!;
    expect(Number.isFinite(b.x)).toBe(true);
    expect(b.width).toBeGreaterThan(0);
    expect(b.height).toBeGreaterThan(0);
  });

  // The one binding constraint on the effect: contentBounds closes over the
  // node/edge props, so the hook must be rebuilt on every plan change. Pinning it
  // needs two node sets whose bounds are disjoint, because a rect from the stale
  // closure is otherwise indistinguishable from a fresh one.
  test("contentBounds tracks a plan change", () => {
    window.history.replaceState(null, "", "/?exam=1");
    const { rerender } = renderCanvas(HOVER_NODES, []);
    const before = window.__stcExam!.contentBounds()!;
    rerender(canvasTree(MOVED_NODES, []));
    const after = window.__stcExam!.contentBounds()!;
    expect(after.x).toBeGreaterThan(before.x + before.width);
    expect(after.y).toBeGreaterThan(before.y + before.height);
  });

  test("uninstalls on unmount", () => {
    window.history.replaceState(null, "", "/?exam=1");
    const { unmount } = renderCanvas(HOVER_NODES, []);
    // Assert the installed state first: without it, the post-unmount assertion
    // also passes when the hook was never installed at all.
    expect(typeof window.__stcExam?.setViewport).toBe("function");
    unmount();
    expect(window.__stcExam).toBeUndefined();
  });
});
