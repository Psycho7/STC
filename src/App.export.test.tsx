// @vitest-environment jsdom
//
// The header's PNG export button. Canvas owns the capture, so App's half is
// exactly three things: when the button is offered, that a click reaches the
// canvas handle, and that the returned blob leaves as a download. Canvas is
// stubbed down to that handle and the layout is mocked away; neither is part of
// the behaviour here.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("./canvas/layout", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./canvas/layout")>();
  return {
    ...orig,
    layoutRenderPlan: vi.fn(async () => ({ nodes: [], edges: [], gaps: [] })),
  };
});

const exportPngSpy = vi.hoisted(() =>
  vi.fn(async () => new Blob(["png"], { type: "image/png" })),
);

vi.mock("./canvas/Canvas", async () => {
  const { useImperativeHandle } = await import("react");
  const CanvasStub = (props: {
    ref?: React.Ref<{ exportPng(): Promise<Blob> }>;
  }) => {
    useImperativeHandle(props.ref ?? null, () => ({ exportPng: exportPngSpy }));
    return null;
  };
  return { default: CanvasStub };
});

import App from "./App";
import { layoutRenderPlan } from "./canvas/layout";
import { defaultPlan, encodePlan } from "./data/plan";
import { pack } from "./data/load";

// One laid-out node is all App reads: the button is offered only over a plan
// with something to capture.
const ONE_NODE = {
  nodes: [
    {
      id: "u1",
      type: "recipe",
      position: { x: 0, y: 0 },
      data: { kind: "recipe" },
    },
  ],
  edges: [],
  gaps: [],
} as unknown as Awaited<ReturnType<typeof layoutRenderPlan>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function encodedDefaultHash(): Promise<string> {
  return "#" + (await encodePlan(defaultPlan(pack)));
}

let objectUrls: Blob[];
let anchorClicks: HTMLAnchorElement[];
let revoked: string[];

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  exportPngSpy.mockClear();
  vi.mocked(layoutRenderPlan).mockImplementation(async () => ONE_NODE);
  objectUrls = [];
  anchorClicks = [];
  revoked = [];
  // jsdom has no object-URL store and no navigation, so the download is
  // observed through these two seams.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      objectUrls.push(blob);
      return `blob:stc/${objectUrls.length}`;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
    },
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchorClicks.push(this);
  });
  window.location.hash = "";
  window.localStorage.setItem("aef.locale", "en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

async function renderReadyApp(): Promise<HTMLButtonElement> {
  window.location.hash = await encodedDefaultHash();
  render(<App />);
  await screen.findAllByTestId("target-row");
  await waitFor(() => {
    expect(screen.getByTestId("header-strip").textContent).toContain("READY");
  });
  return screen.getByTestId("export-png") as HTMLButtonElement;
}

test("the export button sits between the locale switcher and the settings gear", async () => {
  const button = await renderReadyApp();
  const actions = button.closest(".actions")!;
  const order = [...actions.children];
  expect(order.indexOf(button)).toBe(order.length - 2);
  expect(order[order.length - 1]).toBe(screen.getByTestId("settings-open"));
  expect(button.getAttribute("aria-label")).toBe("Export PNG");
  expect(button.getAttribute("title")).toBe("Export PNG");
});

test("the export button is enabled once a plan with nodes is on the canvas", async () => {
  const button = await renderReadyApp();
  expect(button.disabled).toBe(false);
});

test("the export button is disabled while the canvas has no nodes", async () => {
  vi.mocked(layoutRenderPlan).mockImplementation(async () => ({
    nodes: [],
    edges: [],
    gaps: [],
    baseEdges: [],
  }));
  const button = await renderReadyApp();
  expect(button.disabled).toBe(true);
});

test("the export button is disabled while a solve is in flight", async () => {
  const button = await renderReadyApp();
  expect(button.disabled).toBe(false);

  // Hold the next layout so the SOLVING window stays open long enough to
  // assert against.
  const gate = deferred<typeof ONE_NODE>();
  vi.mocked(layoutRenderPlan).mockImplementationOnce(() => gate.promise);
  const crystal = {
    ...defaultPlan(pack),
    targets: [{ itemId: "crystal_enr", ratePerSec: { num: "1", denom: "1" } }],
  };
  window.location.hash = "#" + (await encodePlan(crystal));
  window.dispatchEvent(new HashChangeEvent("hashchange"));

  await waitFor(() => {
    expect(screen.getByTestId("export-png")).toBeDisabled();
  });
  await act(async () => {
    gate.resolve(ONE_NODE);
  });
  await waitFor(() => {
    expect(screen.getByTestId("export-png")).toBeEnabled();
  });
});

test("the export button is disabled while a capture is in flight", async () => {
  const gate = deferred<Blob>();
  exportPngSpy.mockImplementationOnce(() => gate.promise);
  const button = await renderReadyApp();

  await userEvent.click(button);
  await waitFor(() => {
    expect(screen.getByTestId("export-png")).toBeDisabled();
  });

  await act(async () => {
    gate.resolve(new Blob(["png"], { type: "image/png" }));
  });
  await waitFor(() => {
    expect(screen.getByTestId("export-png")).toBeEnabled();
  });
});

test("a click captures the canvas and downloads the PNG", async () => {
  const button = await renderReadyApp();
  await userEvent.click(button);

  await waitFor(() => {
    expect(anchorClicks).toHaveLength(1);
  });
  expect(exportPngSpy).toHaveBeenCalledTimes(1);
  expect(objectUrls).toHaveLength(1);
  expect(objectUrls[0]!.type).toBe("image/png");
  const anchor = anchorClicks[0]!;
  expect(anchor.download).toMatch(/^stc-.+-\d{4}-\d{2}-\d{2}\.png$/);
  expect(anchor.download).toContain("copper_bottle");
  expect(revoked).toHaveLength(1);
});

test("a refused capture leaves the button usable again", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  exportPngSpy.mockRejectedValueOnce(new Error("canvas refused"));
  const button = await renderReadyApp();

  await userEvent.click(button);
  await waitFor(() => {
    expect(consoleError).toHaveBeenCalled();
  });
  expect(anchorClicks).toHaveLength(0);
  await waitFor(() => {
    expect(screen.getByTestId("export-png")).toBeEnabled();
  });
});
