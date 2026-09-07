// @vitest-environment jsdom
//
// Ego-network highlight: hovering a node or edge keeps its neighbourhood at full
// opacity and marks everything else with the `dimmed` class. The class mapping
// is pure render-side (no layout), so these tests drive the Canvas component and
// assert the `dimmed` class lands on the right React Flow node / edge wrappers.
//
// Edges only mount once React Flow has measured the endpoint nodes; that
// measurement never fires when ResizeObserver is stubbed out, so this suite
// leaves the real (absent) ResizeObserver in place and waits for edge wrappers.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  configure,
  render,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { Node, Edge } from "@xyflow/react";
import Fraction from "fraction.js";
import Canvas, { focusEdges } from "../../src/canvas/Canvas";
import { HOVER_INTENT_MS } from "../../src/canvas/dimensions";
import {
  ItemPackProvider,
  type ItemPackContextValue,
} from "../../src/canvas/itemPackContext";
import { LocaleProvider } from "../../src/data/i18n-context";

const PACK = {
  itemById: new Map(),
  overrides: [],
  machineById: new Map(),
} as unknown as ItemPackContextValue;

// Every hover wait below sits behind a 150 ms real-timer intent delay on top of
// a full React Flow mount, and the one-second default runs out when the machine
// is busy with other suites. Raise the budget once for the file rather than
// annotating each waitFor; a real failure still fails, only later.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
});

const NODES: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, data: { label: "a" } },
  { id: "b", position: { x: 300, y: 0 }, data: { label: "b" } },
  { id: "c", position: { x: 300, y: 200 }, data: { label: "c" } },
  { id: "d", position: { x: 600, y: 0 }, data: { label: "d" } },
];

function busData(trunkKey: string): Record<string, unknown> {
  return {
    item: "Iron",
    rate: new Fraction(1, 1),
    laneY: 100,
    trunkKey,
  } as unknown as Record<string, unknown>;
}

const EDGES: Edge[] = [
  // Two bus edges fan out of "a" on the same trunk.
  { id: "e1", type: "bus", source: "a", target: "b", data: busData("Iron|a") },
  { id: "e2", type: "bus", source: "a", target: "c", data: busData("Iron|a") },
  // An unrelated item edge into "c" from "d" on no trunk, so the dim tests
  // exercise every chip kind (rate / bus drop-rise).
  {
    id: "e3",
    type: "item",
    source: "d",
    target: "c",
    data: {
      item: "Copper",
      rate: new Fraction(1, 1),
    } as unknown as Record<string, unknown>,
  },
];

// Every chip testId in the fixture, grouped by which edge owns it. Chips render
// through EdgeLabelRenderer (a portal outside the edge wrapper), so the
// wrapper's `dimmed` class cannot fade them; each chip must carry its own.
const BUS_CHIP_IDS = [
  "bus-edge-label-e1-drop",
  "bus-edge-label-e1-rise",
  "bus-edge-label-e2-drop",
  "bus-edge-label-e2-rise",
];
const ITEM_CHIP_IDS = ["item-edge-label-e3"];
const ALL_CHIP_IDS = [...BUS_CHIP_IDS, ...ITEM_CHIP_IDS];

// Chips mount a beat after the edges, once React Flow has placed the labels.
// Wait for every chip in the fixture before reading dim classes.
async function waitForChips(container: HTMLElement): Promise<void> {
  await waitFor(() => {
    for (const id of ALL_CHIP_IDS) {
      expect(
        container.querySelector(`[data-testid="${id}"]`),
      ).not.toBeNull();
    }
  });
}

function chipDimmed(container: HTMLElement, id: string): boolean {
  const el = container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  expect(el).not.toBeNull();
  return el!.classList.contains("dimmed");
}

function renderCanvas() {
  return render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={NODES} edges={EDGES} />
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${id}"]`,
  );
  expect(el).not.toBeNull();
  return el!;
}

async function edgeEl(container: HTMLElement, id: string): Promise<HTMLElement> {
  let el: HTMLElement | null = null;
  await waitFor(() => {
    el = container.querySelector<HTMLElement>(
      `.react-flow__edge[data-id="${id}"]`,
    );
    expect(el).not.toBeNull();
  });
  return el!;
}

describe("canvas/focus-dim", () => {
  it("dims a non-adjacent node but not an adjacent one on node hover", async () => {
    const { container } = renderCanvas();
    // Hover node "a": adjacent to b and c (edges e1, e2); "d" is not adjacent.
    // The hover registers after a short intent delay, so wait for the dim.
    fireEvent.mouseEnter(nodeEl(container, "a"));
    await waitFor(() => {
      expect(nodeEl(container, "d").classList.contains("dimmed")).toBe(true);
    });
    expect(nodeEl(container, "b").classList.contains("dimmed")).toBe(false);
    expect(nodeEl(container, "a").classList.contains("dimmed")).toBe(false);
  });

  it("keeps a same-trunk sibling edge undimmed on bus-edge hover", async () => {
    const { container } = renderCanvas();
    // Wait for the last edge to mount, then re-query e1 fresh: earlier waitFor
    // rounds can replace edge DOM as React Flow re-measures, detaching a stale
    // reference so events fired on it would no-op.
    await edgeEl(container, "e3");
    const e1 = container.querySelector<HTMLElement>(
      '.react-flow__edge[data-id="e1"]',
    )!;
    // Hover bus edge e1: the whole "Iron|a" trunk (e1 + e2) stays lit; the
    // unrelated item edge e3 dims. The hover re-renders edges, so settle the DOM
    // with waitFor before reading classes.
    fireEvent.mouseEnter(e1);
    await waitFor(() => {
      const e3 = container.querySelector<HTMLElement>(
        '.react-flow__edge[data-id="e3"]',
      );
      expect(e3).not.toBeNull();
      expect(e3!.classList.contains("dimmed")).toBe(true);
    });
    expect(
      container
        .querySelector<HTMLElement>('.react-flow__edge[data-id="e2"]')!
        .classList.contains("dimmed"),
    ).toBe(false);
  });

  it("lights only its two endpoints on a plain item-edge hover", async () => {
    const { container } = renderCanvas();
    // e3 is a plain (non-bus) item edge d -> c on no trunk. Hovering it lights
    // exactly its endpoints d and c; the unrelated nodes a and b and the whole
    // Iron|a trunk (e1, e2) dim. No trunk expansion applies to a plain edge.
    const e3 = await edgeEl(container, "e3");
    fireEvent.mouseEnter(e3);
    await waitFor(() => {
      expect(nodeEl(container, "a").classList.contains("dimmed")).toBe(true);
    });
    expect(nodeEl(container, "b").classList.contains("dimmed")).toBe(true);
    expect(nodeEl(container, "c").classList.contains("dimmed")).toBe(false);
    expect(nodeEl(container, "d").classList.contains("dimmed")).toBe(false);
    expect(await edgeDimmed(container, "e1")).toBe(true);
    expect(await edgeDimmed(container, "e2")).toBe(true);
    expect(await edgeDimmed(container, "e3")).toBe(false);
  });

  it("clears all dimmed classes on mouse leave", async () => {
    const { container } = renderCanvas();
    fireEvent.mouseEnter(nodeEl(container, "a"));
    await waitFor(() => {
      expect(nodeEl(container, "d").classList.contains("dimmed")).toBe(true);
    });
    fireEvent.mouseLeave(nodeEl(container, "a"));
    expect(container.querySelectorAll(".dimmed")).toHaveLength(0);
  });

  it("dims the rate chips of an unrelated edge on node hover", async () => {
    const { container } = renderCanvas();
    await waitForChips(container);
    // Hover node "a": e1/e2 (adjacent) light, e3 (into c from d) dims. e3's rate
    // chip must dim with it; e1/e2's bus chips stay lit.
    fireEvent.mouseEnter(nodeEl(container, "a"));
    await waitFor(() => {
      for (const id of ITEM_CHIP_IDS) {
        expect(chipDimmed(container, id)).toBe(true);
      }
    });
    for (const id of BUS_CHIP_IDS) {
      expect(chipDimmed(container, id)).toBe(false);
    }
  });

  it("dims the bus drop/rise chips of an unrelated trunk on node hover", async () => {
    const { container } = renderCanvas();
    await waitForChips(container);
    // Hover node "d": only e3 (d -> c) lights; the "Iron|a" trunk (e1, e2) dims.
    // Every bus chip must dim; e3's rate chip stays lit.
    fireEvent.mouseEnter(nodeEl(container, "d"));
    await waitFor(() => {
      for (const id of BUS_CHIP_IDS) {
        expect(chipDimmed(container, id)).toBe(true);
      }
    });
    for (const id of ITEM_CHIP_IDS) {
      expect(chipDimmed(container, id)).toBe(false);
    }
  });

  it("carries no dimmed chip class while idle", async () => {
    const { container } = renderCanvas();
    await waitForChips(container);
    for (const id of ALL_CHIP_IDS) {
      expect(chipDimmed(container, id)).toBe(false);
    }
  });

  it("clears all dimmed classes on pane click", async () => {
    const { container } = renderCanvas();
    fireEvent.mouseEnter(nodeEl(container, "a"));
    await waitFor(() => {
      expect(nodeEl(container, "d").classList.contains("dimmed")).toBe(true);
    });
    const pane = container.querySelector<HTMLElement>(".react-flow__pane");
    expect(pane).not.toBeNull();
    fireEvent.click(pane!);
    expect(container.querySelectorAll(".dimmed")).toHaveLength(0);
  });
});

// Two-mode trunk hover: a trunk of one owner ("own") plus two branch members
// ("br1", "br2"), all on the same trunkKey and leaving source "a". Hovering the
// owner lights the whole group; hovering a branch lights that branch plus the
// owner and dims the sibling branch.
const TWO_MODE_NODES: Node[] = [
  { id: "a", position: { x: 0, y: 0 }, data: { label: "a" } },
  { id: "tb", position: { x: 900, y: 0 }, data: { label: "tb" } },
  { id: "tc1", position: { x: 900, y: 200 }, data: { label: "tc1" } },
  { id: "tc2", position: { x: 900, y: 400 }, data: { label: "tc2" } },
];

function trunkMember(owner: boolean): Record<string, unknown> {
  return {
    item: "Iron",
    rate: new Fraction(1, 1),
    laneY: 100,
    trunkKey: "Iron|a",
    busChipOwner: owner,
    busTotalRate: new Fraction(3, 1),
    busMemberCount: 3,
  } as unknown as Record<string, unknown>;
}

const TWO_MODE_EDGES: Edge[] = [
  { id: "own", type: "bus", source: "a", target: "tb", data: trunkMember(true) },
  { id: "br1", type: "bus", source: "a", target: "tc1", data: trunkMember(false) },
  { id: "br2", type: "bus", source: "a", target: "tc2", data: trunkMember(false) },
];

function renderTwoMode() {
  return render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={TWO_MODE_NODES} edges={TWO_MODE_EDGES} />
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

async function edgeDimmed(
  container: HTMLElement,
  id: string,
): Promise<boolean> {
  const el = await edgeEl(container, id);
  return el.classList.contains("dimmed");
}

describe("canvas/focus-dim two-mode trunk hover", () => {
  it("branch hover lights the branch and owner but dims the sibling branch", async () => {
    const { container } = renderTwoMode();
    const br1 = await edgeEl(container, "br1");
    fireEvent.mouseEnter(br1);
    // The sibling branch br2 dims; the hovered branch and the trunk owner stay
    // lit.
    await waitFor(async () => {
      expect(await edgeDimmed(container, "br2")).toBe(true);
    });
    expect(await edgeDimmed(container, "br1")).toBe(false);
    expect(await edgeDimmed(container, "own")).toBe(false);
  });

  it("owner (trunk) hover lights the whole group", async () => {
    const { container } = renderTwoMode();
    const own = await edgeEl(container, "own");
    fireEvent.mouseEnter(own);
    // Give the hover intent time to settle (the theme root gains hover-active),
    // then assert nothing in the trunk dimmed.
    await waitFor(() => {
      expect(
        container.querySelector(".ak-canvas-theme.hover-active"),
      ).not.toBeNull();
    });
    expect(await edgeDimmed(container, "own")).toBe(false);
    expect(await edgeDimmed(container, "br1")).toBe(false);
    expect(await edgeDimmed(container, "br2")).toBe(false);
  });

  it("branch hover dims the sibling branch chip but not the owner's", async () => {
    // This trunk is multi-member, so it draws no aggregate drop chip; the
    // owner's own rise chip stands in as the lit-side chip.
    const { container } = renderTwoMode();
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="bus-edge-label-own-rise"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="bus-edge-label-br2-rise"]'),
      ).not.toBeNull();
    });
    const br1 = await edgeEl(container, "br1");
    fireEvent.mouseEnter(br1);
    // br2's rise chip dims with its edge; the owner's chip stays lit (the owner
    // is in the focus set).
    await waitFor(() => {
      expect(chipDimmed(container, "bus-edge-label-br2-rise")).toBe(true);
    });
    expect(chipDimmed(container, "bus-edge-label-own-rise")).toBe(false);
  });

  it("branch hover dims the sibling junction dot but not the owner's", async () => {
    const { container } = renderTwoMode();
    await waitFor(() => {
      expect(
        container.querySelector('[data-testid="bus-junction-own"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="bus-junction-br2"]'),
      ).not.toBeNull();
    });
    const br1 = await edgeEl(container, "br1");
    fireEvent.mouseEnter(br1);
    await waitFor(() => {
      expect(chipDimmed(container, "bus-junction-br2")).toBe(true);
    });
    expect(chipDimmed(container, "bus-junction-own")).toBe(false);
    expect(chipDimmed(container, "bus-junction-br1")).toBe(false);
  });
});

describe("canvas/focus-dim focusEdges", () => {
  // Canvas owns its ReactFlowProvider and takes no viewport prop, so a jsdom
  // render cannot drive the store zoom below the label gate. Assert the wiring
  // on the exported pure mapper instead.
  it("stamps focused on lit edges and dims the rest", () => {
    const out = focusEdges(EDGES, { edgeIds: new Set(["e3"]) });
    const byId = new Map(out.map((e) => [e.id, e]));
    const lit = byId.get("e3")!;
    expect((lit.data as { focused?: boolean }).focused).toBe(true);
    expect((lit.data as { dimmed?: boolean }).dimmed).toBeUndefined();
    expect(lit.className ?? "").not.toContain("dimmed");
    for (const id of ["e1", "e2"]) {
      const dim = byId.get(id)!;
      expect((dim.data as { dimmed?: boolean }).dimmed).toBe(true);
      expect((dim.data as { focused?: boolean }).focused).toBeUndefined();
      expect(dim.className ?? "").toContain("dimmed");
    }
  });

  it("returns the input array untouched when idle", () => {
    expect(focusEdges(EDGES, null)).toBe(EDGES);
  });
});

// Chip hover binding. A rate chip is drawn through EdgeLabelRenderer, which is
// a DOM portal: the chip's DOM box lives outside its edge's <g>, so nothing in
// the DOM tree connects the two. React Flow attaches the edge hover handlers as
// JSX props on that <g>, and React synthesizes mouseenter / mouseleave by
// walking the FIBER tree, whose parent chain crosses a portal. A chip therefore
// fires its own edge's onMouseEnter with that edge's id, for free, and no chip
// side handler exists to do it. The binding is incidental to the render shape,
// so the tests below pin it: hoisting chips into a top-level layer would sever
// the fiber chain and silently drop the behaviour.

// Two item edges between the same pair of cards. Their strokes are collinear,
// so in a browser each chip box sits on top of the other edge's line -- the
// coincident column case. Hit-testing cannot tell the two apart; fiber-tree
// ancestry can.
const BRAID_NODES: Node[] = [
  { id: "xa", position: { x: 0, y: 0 }, data: { label: "xa" } },
  { id: "xb", position: { x: 400, y: 0 }, data: { label: "xb" } },
];

function braidData(item: string): Record<string, unknown> {
  return {
    item,
    rate: new Fraction(1, 1),
  } as unknown as Record<string, unknown>;
}

const BRAID_EDGES: Edge[] = [
  { id: "x1", type: "item", source: "xa", target: "xb", data: braidData("Iron") },
  { id: "x2", type: "item", source: "xa", target: "xb", data: braidData("Copper") },
];

const BRAID_CHIP_IDS = ["item-edge-label-x1", "item-edge-label-x2"];

function renderBraid() {
  return render(
    <LocaleProvider locale="en">
      <ItemPackProvider value={PACK}>
        <Canvas nodes={BRAID_NODES} edges={BRAID_EDGES} />
      </ItemPackProvider>
    </LocaleProvider>,
  );
}

function chipEl(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(el).not.toBeNull();
  return el!;
}

// Synchronous twin of `edgeDimmed`, for the fake-timer test where a waitFor
// would never resolve.
function edgeDimmedNow(container: HTMLElement, id: string): boolean {
  const el = container.querySelector<HTMLElement>(
    `.react-flow__edge[data-id="${id}"]`,
  );
  expect(el).not.toBeNull();
  return el!.classList.contains("dimmed");
}

function hoverActive(container: HTMLElement): boolean {
  return container.querySelector(".ak-canvas-theme.hover-active") !== null;
}

async function waitForChipIds(
  container: HTMLElement,
  ids: string[],
): Promise<void> {
  await waitFor(() => {
    for (const id of ids) {
      expect(container.querySelector(`[data-testid="${id}"]`)).not.toBeNull();
    }
  });
}

// The whole lit / dimmed picture of a fixture: every node, edge and chip with
// its `dimmed` state, sorted so two different hovers can be compared for
// equality rather than spot-checked.
function focusSnapshot(container: HTMLElement): string[] {
  const out: string[] = [];
  container
    .querySelectorAll<HTMLElement>(".react-flow__node[data-id]")
    .forEach((el) => {
      out.push(`node:${el.dataset.id}:${el.classList.contains("dimmed")}`);
    });
  container
    .querySelectorAll<HTMLElement>(".react-flow__edge[data-id]")
    .forEach((el) => {
      out.push(`edge:${el.dataset.id}:${el.classList.contains("dimmed")}`);
    });
  container
    .querySelectorAll<HTMLElement>(
      '[data-testid^="item-edge-label-"], [data-testid^="bus-edge-label-"]',
    )
    .forEach((el) => {
      out.push(`chip:${el.dataset.testid}:${el.classList.contains("dimmed")}`);
    });
  return out.sort();
}

// Mount a fixture, settle one hover, and return its focus snapshot. Unmounts
// before returning so two snapshots can be taken back to back without two
// canvases fighting over the document.
async function snapshotAfterHover(opts: {
  mount: () => HTMLElement;
  chips: string[];
  target: (container: HTMLElement) => Promise<HTMLElement> | HTMLElement;
  dimWitness: string;
}): Promise<string[]> {
  const container = opts.mount();
  await waitForChipIds(container, opts.chips);
  fireEvent.mouseEnter(await opts.target(container));
  await waitFor(() => {
    expect(edgeDimmedNow(container, opts.dimWitness)).toBe(true);
  });
  const snap = focusSnapshot(container);
  cleanup();
  return snap;
}

describe("canvas/focus-dim chip hover binding", () => {
  it("chip hover gives the same sets as hovering the same edge's stroke", async () => {
    // Mechanism: the chip's fiber parent chain crosses the EdgeLabelRenderer
    // portal back into the edge wrapper, so React's synthesized mouseenter
    // reaches the edge's own handler with its own id.
    const strokeSnap = await snapshotAfterHover({
      mount: () => renderCanvas().container,
      chips: ALL_CHIP_IDS,
      target: (c) => edgeEl(c, "e3"),
      dimWitness: "e1",
    });
    const chipSnap = await snapshotAfterHover({
      mount: () => renderCanvas().container,
      chips: ALL_CHIP_IDS,
      target: (c) => chipEl(c, "item-edge-label-e3"),
      dimWitness: "e1",
    });
    expect(chipSnap).toEqual(strokeSnap);
    // Not a vacuous pass: the hover really lit e3 and dimmed the Iron trunk.
    expect(chipSnap).toContain("edge:e3:false");
    expect(chipSnap).toContain("edge:e1:true");
    expect(chipSnap).toContain("edge:e2:true");
  });

  it("lights only its own edge when a foreign stroke crosses the chip box", async () => {
    // Mechanism: the enter is resolved by fiber ancestry, not by which pixels
    // sit under the pointer, so a collinear neighbour through the chip box
    // cannot claim the hover.
    const { container } = renderBraid();
    await waitForChipIds(container, BRAID_CHIP_IDS);
    fireEvent.mouseEnter(chipEl(container, "item-edge-label-x1"));
    await waitFor(() => {
      expect(edgeDimmedNow(container, "x2")).toBe(true);
    });
    expect(edgeDimmedNow(container, "x1")).toBe(false);
    expect(chipDimmed(container, "item-edge-label-x1")).toBe(false);
  });

  it("bus drop chip hover lights the whole trunk, like its stroke", async () => {
    // Mechanism: BusEdge renders its chips from inside its own edge component,
    // so a drop chip's portal fiber chain lands on the member edge it belongs
    // to and the existing two-mode trunk focus does the rest.
    const strokeSnap = await snapshotAfterHover({
      mount: () => renderCanvas().container,
      chips: ALL_CHIP_IDS,
      target: (c) => edgeEl(c, "e1"),
      dimWitness: "e3",
    });
    const chipSnap = await snapshotAfterHover({
      mount: () => renderCanvas().container,
      chips: ALL_CHIP_IDS,
      target: (c) => chipEl(c, "bus-edge-label-e1-drop"),
      dimWitness: "e3",
    });
    expect(chipSnap).toEqual(strokeSnap);
    // Whole trunk lit, unrelated item edge dimmed.
    expect(chipSnap).toContain("edge:e1:false");
    expect(chipSnap).toContain("edge:e2:false");
    expect(chipSnap).toContain("edge:e3:true");
  });

  it("member rise chip hover lights branch plus owner, like its stroke", async () => {
    // Mechanism: same portal fiber chain, on the member edge that owns the rise
    // chip, so branch mode of the trunk focus applies unchanged.
    const strokeSnap = await snapshotAfterHover({
      mount: () => renderTwoMode().container,
      chips: ["bus-edge-label-own-rise", "bus-edge-label-br1-rise"],
      target: (c) => edgeEl(c, "br1"),
      dimWitness: "br2",
    });
    const chipSnap = await snapshotAfterHover({
      mount: () => renderTwoMode().container,
      chips: ["bus-edge-label-own-rise", "bus-edge-label-br1-rise"],
      target: (c) => chipEl(c, "bus-edge-label-br1-rise"),
      dimWitness: "br2",
    });
    expect(chipSnap).toEqual(strokeSnap);
    expect(chipSnap).toContain("edge:br1:false");
    expect(chipSnap).toContain("edge:own:false");
    expect(chipSnap).toContain("edge:br2:true");
  });

  it("stroke to own chip fires no edge leave and never empties the focus", async () => {
    // Mechanism: stroke and chip share a fiber ancestor at or below the edge
    // <g>, so React's enter/leave walks stop before the edge's handlers. No
    // leave fires, and since clearHover is synchronous a leave would show up as
    // an empty focus set on the very next line.
    const { container } = renderCanvas();
    await waitForChipIds(container, ITEM_CHIP_IDS);
    const e3 = await edgeEl(container, "e3");
    const path = e3.querySelector("path")!;
    const chip = chipEl(container, "item-edge-label-e3");
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(path);
      act(() => {
        vi.advanceTimersByTime(HOVER_INTENT_MS - 1);
      });
      expect(hoverActive(container)).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(hoverActive(container)).toBe(true);
      expect(edgeDimmedNow(container, "e3")).toBe(false);

      // The mouseout a real browser fires moving stroke -> own chip. React
      // derives both halves of the transition from it.
      fireEvent.mouseOut(path, { relatedTarget: chip });
      expect(hoverActive(container)).toBe(true);
      expect(edgeDimmedNow(container, "e3")).toBe(false);
      act(() => {
        vi.advanceTimersByTime(HOVER_INTENT_MS * 2);
      });
      expect(hoverActive(container)).toBe(true);
      expect(edgeDimmedNow(container, "e3")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
