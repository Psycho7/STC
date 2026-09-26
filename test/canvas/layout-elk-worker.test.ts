import { afterEach, describe, expect, it, vi } from "vitest";
import Fraction from "fraction.js";
import ELK from "elkjs/lib/elk.bundled.js";

import {
  ELK_WORKER_BOOT_BOUND_MS,
  type LayoutInput,
} from "../../src/canvas/layout";
import { mkRecipe } from "./busRouting.testkit";

// In a browser layout.ts hands the graph to ELK in a Web Worker. Node has no
// Worker, so this suite stubs one: FakeWorker speaks the elk-api message
// protocol and answers a layout by running the bundled ELK on the posted graph,
// which is what the real worker script does. Layouts can be held so a test can
// start a second one while the first is still running.

type Msg = { id: number; cmd: string; graph?: unknown; layoutOptions?: object };

class FakeWorker {
  static instances: FakeWorker[] = [];
  static hold = false;
  onmessage: ((answer: { data: unknown }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessageerror: ((event: Event) => void) | null = null;
  terminated = false;
  held: Msg[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = String(url);
    FakeWorker.instances.push(this);
  }

  postMessage(msg: Msg): void {
    if (msg.cmd !== "layout") {
      this.reply(msg.id, true);
      return;
    }
    if (FakeWorker.hold) {
      this.held.push(msg);
      return;
    }
    void this.run(msg);
  }

  async run(msg: Msg): Promise<void> {
    const laid = await new ELK().layout(msg.graph as never, {
      layoutOptions: msg.layoutOptions as never,
    });
    this.reply(msg.id, laid);
  }

  release(): void {
    for (const msg of this.held.splice(0)) void this.run(msg);
  }

  terminate(): void {
    this.terminated = true;
  }

  private reply(id: number, data: unknown): void {
    if (this.terminated) return;
    this.onmessage?.({ data: { id, data } });
  }
}

function input(): LayoutInput {
  const recipeA = mkRecipe("r:a", [], ["x"]);
  const recipeB = mkRecipe("r:b", ["x"], []);
  return {
    plan: {
      units: ["a", "b"].map((k) => ({
        id: `u:${k}`,
        kind: "recipe" as const,
        recipeId: `r:${k}`,
        count: 1,
        multiplicity: { num: "1", denom: "1" },
      })),
      edges: [
        {
          fromUnit: "u:a",
          toUnit: "u:b",
          item: "x",
          rate: new Fraction(1),
          transportKind: "belt",
        },
      ],
      containers: [],
    },
    recipeById: new Map([
      ["r:a", recipeA],
      ["r:b", recipeB],
    ]),
    itemById: new Map(),
  };
}

// A fresh layout module, loaded under whatever globals the test stubbed.
async function freshLayout() {
  vi.resetModules();
  return import("../../src/canvas/layout");
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const positions = (r: { nodes: { id: string; position: object }[] }) =>
  r.nodes.map((n) => [n.id, n.position]);

// A worker that never answers anything: its script hangs while loading.
class SilentWorker extends FakeWorker {
  override postMessage(msg: Msg): void {
    this.held.push(msg);
  }
}

// A worker whose script fails, reported through the given event handler.
function failingWorker(handler: "onerror" | "onmessageerror") {
  return class extends SilentWorker {
    constructor(url: string) {
      super(url);
      setTimeout(() => this[handler]?.(new Event("error")), 0);
    }
  };
}

const heldLayout = (w: FakeWorker | undefined) =>
  w?.held.some((m) => m.cmd === "layout") ?? false;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
  FakeWorker.hold = false;
});

describe("ELK in a Web Worker", () => {
  it("lays out in-process when there is no Worker", async () => {
    expect(typeof Worker).toBe("undefined");
    const { layoutRenderPlan } = await freshLayout();
    const result = await layoutRenderPlan(input());
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["u:a", "u:b"]);
  });

  it("with a Worker, lays out in the ELK worker script, same result as in-process", async () => {
    const inProcess = await (await freshLayout()).layoutRenderPlan(input());

    vi.stubGlobal("Worker", FakeWorker);
    const { layoutRenderPlan } = await freshLayout();
    const inWorker = await layoutRenderPlan(input());

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.url).toMatch(/elk-worker\.min\.js/);
    expect(positions(inWorker)).toEqual(positions(inProcess));
  });

  it("a newer layout terminates the worker running the stale one and rejects it", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { layoutRenderPlan } = await freshLayout();
    FakeWorker.hold = true;

    const stale = layoutRenderPlan(input());
    await until(() => FakeWorker.instances[0]?.held.length === 1);
    const first = FakeWorker.instances[0]!;
    expect(first.held).toHaveLength(1);

    const fresh = layoutRenderPlan(input());
    await expect(stale).rejects.toThrow(/superseded/);
    expect(first.terminated).toBe(true);

    await until(() => FakeWorker.instances[1]?.held.length === 1);
    expect(FakeWorker.instances).toHaveLength(2);
    const second = FakeWorker.instances[1]!;
    second.release();
    const result = await fresh;
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["u:a", "u:b"]);
  });

  it.each(["onerror", "onmessageerror"] as const)(
    "a worker %s event falls back to in-process ELK for this and later layouts",
    async (handler) => {
      vi.stubGlobal("Worker", failingWorker(handler));
      const { layoutRenderPlan } = await freshLayout();

      const first = await layoutRenderPlan(input());
      expect(first.nodes.map((n) => n.id).sort()).toEqual(["u:a", "u:b"]);
      expect(FakeWorker.instances).toHaveLength(1);
      expect(FakeWorker.instances[0]!.terminated).toBe(true);

      const second = await layoutRenderPlan(input());
      expect(positions(second)).toEqual(positions(first));
      expect(FakeWorker.instances).toHaveLength(1);
    },
  );

  it("a worker that does not answer within the bound falls back to in-process ELK", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("Worker", SilentWorker);
    const { layoutRenderPlan } = await freshLayout();

    const pending = layoutRenderPlan(input());
    await until(() => heldLayout(FakeWorker.instances[0]));
    const silent = FakeWorker.instances[0]!;
    vi.advanceTimersByTime(ELK_WORKER_BOOT_BOUND_MS);

    const first = await pending;
    expect(first.nodes.map((n) => n.id).sort()).toEqual(["u:a", "u:b"]);
    expect(silent.terminated).toBe(true);

    await layoutRenderPlan(input());
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("the bound covers only the worker's first answer, never a slow layout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("Worker", FakeWorker);
    const { layoutRenderPlan } = await freshLayout();
    FakeWorker.hold = true;

    const pending = layoutRenderPlan(input());
    await until(() => FakeWorker.instances[0]?.held.length === 1);
    vi.advanceTimersByTime(2 * ELK_WORKER_BOOT_BOUND_MS);
    FakeWorker.instances[0]!.release();

    await pending;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminated).toBe(false);
  });

  it("a worker recreated after a supersede is not taken for a failed one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("Worker", SilentWorker);
    const { layoutRenderPlan } = await freshLayout();

    // The first worker is superseded before it ever answers, so its boot
    // bound must not fire once it is gone.
    const stale = layoutRenderPlan(input());
    await until(() => heldLayout(FakeWorker.instances[0]));
    vi.stubGlobal("Worker", FakeWorker);
    const fresh = layoutRenderPlan(input());
    await expect(stale).rejects.toThrow(/superseded/);
    await fresh;
    expect(FakeWorker.instances).toHaveLength(2);

    // A later layout comes in a later task, as an edit does in the app.
    await new Promise((r) => setTimeout(r, 0));
    vi.advanceTimersByTime(2 * ELK_WORKER_BOOT_BOUND_MS);
    FakeWorker.hold = true;
    const later = layoutRenderPlan(input());
    await until(() => heldLayout(FakeWorker.instances[1]));
    expect(heldLayout(FakeWorker.instances[1])).toBe(true);
    FakeWorker.instances[1]!.release();
    await later;
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]!.terminated).toBe(false);
  });

  it("a worker script URL that fails to load falls back to in-process ELK", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    vi.doMock("elkjs/lib/elk-worker.min.js?url", () => {
      throw new Error("chunk failed to load");
    });
    try {
      const { layoutRenderPlan } = await freshLayout();

      const first = await layoutRenderPlan(input());
      expect(first.nodes.map((n) => n.id).sort()).toEqual(["u:a", "u:b"]);
      const second = await layoutRenderPlan(input());
      expect(positions(second)).toEqual(positions(first));
      expect(FakeWorker.instances).toHaveLength(0);
    } finally {
      vi.doUnmock("elkjs/lib/elk-worker.min.js?url");
    }
  });

  it("an error the worker reports for a layout reaches the caller, with no fallback", async () => {
    const elkError = new Error("ELK could not lay out the graph");
    class RejectingWorker extends FakeWorker {
      override async run(msg: Msg): Promise<void> {
        this.onmessage?.({ data: { id: msg.id, error: elkError } });
      }
    }
    vi.stubGlobal("Worker", RejectingWorker);
    const { layoutRenderPlan } = await freshLayout();

    await expect(layoutRenderPlan(input())).rejects.toBe(elkError);
    await expect(layoutRenderPlan(input())).rejects.toBe(elkError);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminated).toBe(false);
  });
});
