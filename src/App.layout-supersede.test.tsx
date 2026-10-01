// @vitest-environment jsdom
//
// In the browser each new layout terminates the ELK worker still running the
// previous one, so App must never start a layout for a generation that a newer
// one has already superseded. The window is a hash navigation parked on its
// async plan decode: a re-solve started meanwhile (an availability flip) lays
// out first, and the navigation resuming afterwards must give up before its own
// layout, not terminate the newer one's worker and leave a solver banner.
//
// The real layout module runs here against a stub Worker that speaks the
// elk-api protocol and answers with the bundled ELK, holding each layout until
// the test releases it. loadPlan is gated so the navigation parks on demand.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

type Msg = { id: number; cmd: string; graph?: unknown; layoutOptions?: object };

const elkWorker = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static hold = false;
    onmessage: ((answer: { data: unknown }) => void) | null = null;
    terminated = false;
    held: Msg[] = [];

    constructor() {
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
      const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
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
  // Set before any import runs: layout.ts picks its ELK path at module load.
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  return FakeWorker;
});

const loadGate = vi.hoisted(() => ({
  hold: false,
  parked: [] as Array<() => void>,
}));

// The worker script URL only matters to a real Worker.
vi.mock("elkjs/lib/elk-worker.min.js?url", () => ({
  default: "elk-worker.min.js",
}));

vi.mock("./data/plan", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./data/plan")>();
  return {
    ...orig,
    loadPlan: async (...args: Parameters<typeof orig.loadPlan>) => {
      if (loadGate.hold) {
        await new Promise<void>((resolve) => loadGate.parked.push(resolve));
      }
      return orig.loadPlan(...args);
    },
  };
});

// React Flow is irrelevant here; the header status chip and banner are what
// the assertions read.
vi.mock("./canvas/Canvas", () => ({ default: () => null }));

import App from "./App";
import { defaultPlan, encodePlan, validatePlan } from "./data/plan";
import { pack } from "./data/load";
import { EVENT_COHORT_OVERRIDES_STORAGE_KEY } from "./data/storage-keys";
import { flipStoredOverrides } from "./App.testkit";

function statusChip(): string {
  const chip = Array.from(document.querySelectorAll(".stat-chip")).find((c) =>
    /^(READY|SOLVING|ERROR)$/.test(c.textContent ?? ""),
  );
  if (!chip) throw new Error("no status chip rendered");
  return chip.textContent!;
}

const heldLayouts = () =>
  elkWorker.instances.reduce((n, w) => n + w.held.length, 0);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.location.hash = "";
  window.localStorage.setItem("aef.locale", "en");
  window.localStorage.removeItem(EVENT_COHORT_OVERRIDES_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  elkWorker.instances = [];
  elkWorker.hold = false;
  loadGate.hold = false;
  loadGate.parked.length = 0;
  window.location.hash = "";
});

test("a navigation resuming after a newer re-solve's layout started does not supersede it", async () => {
  render(<App />);
  await waitFor(() => expect(statusChip()).toBe("READY"), { timeout: 20000 });

  // Paste plan B; its navigation parks on the plan decode.
  const a = defaultPlan(pack);
  const b = { ...a, targets: a.targets.slice(0, a.targets.length - 1) };
  expect(validatePlan(b, pack)).toBeNull();
  loadGate.hold = true;
  window.location.hash = "#" + (await encodePlan(b));
  await waitFor(() => expect(loadGate.parked).toHaveLength(1));

  // Another tab flips a cohort the committed default plan does not need: the
  // plan stays valid, so it re-solves as a newer generation and its layout
  // starts in the worker.
  elkWorker.hold = true;
  flipStoredOverrides('{"v1.5": false}');
  await waitFor(() => expect(heldLayouts()).toBe(1));
  const newer = elkWorker.instances.find((w) => w.held.length === 1)!;

  // The older navigation resumes, then every held layout is let go.
  await act(async () => {
    loadGate.parked.shift()!();
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    elkWorker.hold = false;
    for (const w of elkWorker.instances) w.release();
  });

  await waitFor(() => expect(statusChip()).toBe("READY"), { timeout: 20000 });
  expect(newer.terminated).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
}, 60000);
