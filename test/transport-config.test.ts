import { describe, it, expect } from "vitest";
import type { Item, RecipePack, Transport } from "@aef/schema";
import {
  loadTransportConfig,
  type TransportConfig,
} from "../src/data/transport-config";

// Synthetic fixtures mirror test/transport-config-guard.test.ts so this test
// stays decoupled from the committed transport-config.json tuning numbers.
function mkConfig(carrierKinds: string[]): TransportConfig {
  const carriers: TransportConfig["carriers"] = {};
  for (const k of carrierKinds) {
    carriers[k] = { transportId: k, itemsPerSecondPerLane: 1 };
  }
  return {
    schemaVersion: "0.2",
    source: "test",
    lanesPerBlueprintGroup: 4,
    interGroupGapTiles: 2,
    carriers,
  };
}

function mkPack(transportKinds: string[], itemKinds: string[] = []): RecipePack {
  const transports: Transport[] = transportKinds.map((k) => ({
    id: k,
    kind: k,
    name: k,
    icon: k,
    speed: 1,
  }));
  const items: Item[] = itemKinds.map((k, idx) => ({
    id: `item_${idx}`,
    name: `item_${idx}`,
    category: "test",
    icon: "x",
    row: 0,
    raw: false,
    transportKind: k,
  }));
  return {
    schemaVersion: "0.2",
    source: {
      name: "test",
      sourceRepo: "",
      sourceCommit: "0",
      gameVersion: "x",
      extractedAt: "",
    },
    categories: [],
    locations: [],
    items,
    machines: [],
    transports,
    recipes: [],
  } as unknown as RecipePack;
}

describe("loadTransportConfig", () => {
  it("returns the config unchanged on the happy path", () => {
    const cfg = mkConfig(["belt", "pipe"]);
    const pack = mkPack(["belt", "pipe"], ["belt", "pipe"]);
    expect(loadTransportConfig(cfg, pack)).toEqual(cfg);
  });
});
