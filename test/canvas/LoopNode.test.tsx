import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import Fraction from "fraction.js";
import type { ReactElement } from "react";
import LoopNode, {
  type LoopNodeData,
  type LoopNodeType,
} from "../../src/canvas/LoopNode";
import { loopBoxDimensions } from "../../src/canvas/dimensions";
import { LocaleProvider } from "../../src/data/i18n-context";

// `Handle` reads from the React Flow zustand store; without a Provider in the
// tree it throws. Wrap each render so the unit-test exercises only LoopNode.
function renderInProvider(ui: ReactElement) {
  return render(
    <LocaleProvider locale="en">
      <ReactFlowProvider>{ui}</ReactFlowProvider>
    </LocaleProvider>,
  );
}

afterEach(() => {
  cleanup();
});

// Build a NodeProps-shaped object from just the fields the component reads.
// ReactFlow's NodeProps is a broad interface (id, type, dragging, zIndex, ...),
// but LoopNode only consumes `data`. Casting through `unknown` keeps the test
// strict at the use-site without spreading bogus defaults across every field.
function buildProps(data: LoopNodeData): NodeProps<LoopNodeType> {
  return {
    id: "loop:test",
    type: "loop",
    data,
    dragging: false,
    zIndex: 0,
    selectable: false,
    deletable: false,
    selected: false,
    draggable: false,
    isConnectable: false,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  } as unknown as NodeProps<LoopNodeType>;
}

const TWO_RECIPE_FIXTURE: LoopNodeData = {
  sccId: "scc:acid-loop",
  netIO: [
    { item: "water", direction: "in", rate: new Fraction(12) },
    { item: "sulfuric_acid", direction: "out", rate: new Fraction(15, 2) },
  ],
  interior: { width: 200, height: 150 },
  tearArc: { fromY: 30, toY: 110 },
};

describe("LoopNode", () => {
  it("uses the scc-box markup family with a header label", () => {
    const { container } = renderInProvider(
      <LoopNode {...buildProps(TWO_RECIPE_FIXTURE)} />,
    );
    const box = container.querySelector('[data-testid="loop-node"]');
    expect(box).not.toBeNull();
    expect(box?.classList.contains("scc-box")).toBe(true);
    const label = box?.querySelector(".header .label");
    expect(label?.textContent).toBe(TWO_RECIPE_FIXTURE.sccId);
    const seq = box?.querySelector(".header .seq");
    expect(seq?.textContent).toBe(TWO_RECIPE_FIXTURE.sccId);
  });

  it("renders one .net-port.in chip with rate per net-IO inbound", () => {
    const { container } = renderInProvider(
      <LoopNode {...buildProps(TWO_RECIPE_FIXTURE)} />,
    );
    const inPorts = container.querySelectorAll(".net-port.in");
    expect(inPorts.length).toBe(1);
    const waterChip = inPorts[0];
    expect(waterChip?.textContent).toContain("water");
    // 12/s * 60 = 720/min
    expect(waterChip?.textContent).toContain("720");
  });

  it("renders one .net-port.out chip with rate per net-IO outbound", () => {
    const { container } = renderInProvider(
      <LoopNode {...buildProps(TWO_RECIPE_FIXTURE)} />,
    );
    const outPorts = container.querySelectorAll(".net-port.out");
    expect(outPorts.length).toBe(1);
    const acidChip = outPorts[0];
    expect(acidChip?.textContent).toContain("sulfuric_acid");
    // 7.5/s * 60 = 450/min
    expect(acidChip?.textContent).toContain("450");
  });

  it("renders the tear-arc as a visible <path> element", () => {
    const { container } = renderInProvider(
      <LoopNode {...buildProps(TWO_RECIPE_FIXTURE)} />,
    );
    const arc = container.querySelector('[data-testid="tear-arc"]');
    expect(arc).not.toBeNull();
    expect(arc?.tagName.toLowerCase()).toBe("path");
    // A real curve, not an empty `d` attribute.
    expect(arc?.getAttribute("d") ?? "").toMatch(/M\s+\d/);
  });

  it("renders an scc-return tear chip when tearArc data is present", () => {
    const { container } = renderInProvider(
      <LoopNode {...buildProps(TWO_RECIPE_FIXTURE)} />,
    );
    const tearChip = container.querySelector(".scc-return .tear-chip");
    expect(tearChip).not.toBeNull();
    expect(tearChip?.querySelector(".row1")?.textContent).toBe("TEAR");
  });

  it("outer box dimensions match loopBoxDimensions(interior)", () => {
    const { container } = renderInProvider(
      <LoopNode {...buildProps(TWO_RECIPE_FIXTURE)} />,
    );
    const box = container.querySelector(
      '[data-testid="loop-node"]',
    ) as HTMLElement | null;
    expect(box).not.toBeNull();
    const expected = loopBoxDimensions(TWO_RECIPE_FIXTURE.interior);
    expect(box?.style.width).toBe(`${expected.width}px`);
    expect(box?.style.height).toBe(`${expected.height}px`);
  });
});
