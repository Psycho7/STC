import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import App from "../../src/App";
import { buildRenderPlan } from "../../src/pipeline/driver";
import { solvePlanWithIntermediates } from "../../src/solver";
import { pack } from "../../src/data/load";
import {
  defaultTransportConfig,
  loadTransportConfig,
} from "../../src/data/transport-config";
import { defaultTargets } from "../../src/data/targets";
import { RENDER_UNIT_KINDS } from "../../src/pipeline/types";

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
});

describe("integration: App boots end-to-end via the new pipeline", () => {
  it("renders at least one React Flow node without console errors", async () => {
    const consoleErrors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args);
    };
    try {
      const result = render(<App />);
      await waitFor(() => {
        expect(result.queryByText("正在加载布局...")).toBeNull();
      });
      const nodes = result.container.querySelectorAll(
        ".react-flow__node[data-id]",
      );
      expect(nodes.length).toBeGreaterThan(0);
      expect(consoleErrors).toEqual([]);
    } finally {
      console.error = originalError;
    }
  });
});

describe("integration: render plan emits only MVP unit kinds", () => {
  it("contains no fold-era or other legacy unit kinds", () => {
    const full = solvePlanWithIntermediates(
      defaultTargets(),
      pack,
      loadTransportConfig(defaultTransportConfig, pack),
    );
    const { plan } = buildRenderPlan({
      logical: full.logical,
      replicas: full.replicas,
      multipliers: full.multipliers,
      idealCount: full.idealCount,
      classByReplicaId: full.classByReplicaId,
      classToQuotient: full.classToQuotient,
      condensation: full.condensation,
      torn: full.torn,
      recipeById: full.recipeById,
      rates: full.rates,
      itemById: new Map(pack.items.map((i) => [i.id, i])),
      machineById: new Map(pack.machines.map((m) => [m.id, m])),
      itemOverrides: [],
      targets: defaultTargets(),
      pack,
    });
    const allowed = new Set<string>(RENDER_UNIT_KINDS);
    for (const u of plan.units) {
      expect(allowed.has(u.kind)).toBe(true);
    }
  });
});
