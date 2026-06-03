import { describe, it, expect } from "vitest";
import type { Item, RecipePack, Transport } from "@aef/schema";
import {
  loadTransportConfig,
  type TransportConfig,
} from "../src/data/transport-config";
import { UnknownCarrierError } from "../src/solver/types";

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

function mkPack(
  transportKinds: string[],
  itemKinds: string[] = [],
): RecipePack {
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

describe("loadTransportConfig superset guard (B7)", () => {
  it("pack {belt, pipe} + config {belt, pipe} loads cleanly", () => {
    const cfg = mkConfig(["belt", "pipe"]);
    const pack = mkPack(["belt", "pipe"]);
    expect(() => loadTransportConfig(cfg, pack)).not.toThrow();
  });

  it("pack {belt, pipe, conveyor} + config {belt, pipe} throws UnknownCarrierError naming 'conveyor' with itemId null", () => {
    const cfg = mkConfig(["belt", "pipe"]);
    const pack = mkPack(["belt", "pipe", "conveyor"]);
    let caught: unknown = null;
    try {
      loadTransportConfig(cfg, pack);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownCarrierError);
    const err = caught as UnknownCarrierError;
    expect(err.kind).toBe("conveyor");
    expect(err.itemId).toBe(null);
    expect(err.message).toBe("unknown carrier kind 'conveyor'");
  });

  it("pack {belt} + config {belt, pipe} (superset on config side) loads cleanly", () => {
    const cfg = mkConfig(["belt", "pipe"]);
    const pack = mkPack(["belt"]);
    expect(() => loadTransportConfig(cfg, pack)).not.toThrow();
  });

  it("pack with empty transports loads cleanly against any config", () => {
    const cfg = mkConfig(["belt", "pipe"]);
    const pack = mkPack([]);
    expect(() => loadTransportConfig(cfg, pack)).not.toThrow();
  });

  it("throws UnknownCarrierError naming the item when an Item.transportKind has no carrier entry", () => {
    const cfg = mkConfig(["belt", "pipe"]);
    // pack transports list is a superset of carriers (OK), but an item
    // references a kind missing from carriers -- which is what FFD actually
    // reads at runtime.
    const pack = mkPack(["belt", "pipe"], ["belt", "phantom"]);
    let caught: unknown = null;
    try {
      loadTransportConfig(cfg, pack);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownCarrierError);
    const err = caught as UnknownCarrierError;
    expect(err.kind).toBe("phantom");
    expect(err.itemId).toBe("item_1");
  });

  it("strict-mode: calling loadTransportConfig without pack arg is a TypeScript error", () => {
    const cfg = mkConfig(["belt", "pipe"]);
    // @ts-expect-error -- pack argument is required; this pins the signature.
    expect(() => loadTransportConfig(cfg)).toThrow();
  });
});
