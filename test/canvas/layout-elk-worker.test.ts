import { afterEach, describe, expect, it, vi } from "vitest";
import Fraction from "fraction.js";
import ELK from "elkjs/lib/elk.bundled.js";

import type { LayoutInput } from "../../src/canvas/layout";
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

afterEach(() => {
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
});
