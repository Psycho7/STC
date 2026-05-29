import Fraction from "fraction.js";
import type { Item, Recipe, TransportKindId } from "@aef/schema";
import { UnknownCarrierError, type PackedLane, type Replica } from "./types";
import type { TransportConfig } from "../data/transport-config";

// An oversized stream (rate above a single lane's capacity) goes alone on a
// dedicated overflow lane (overflow: true, one stream) instead of throwing
// StreamExceedsLaneCapacityError. Splitting a stream across several parallel
// lanes is not implemented yet.

type Stream = {
  replicaId: string;
  itemId: string;
  itemsPerSec: Fraction;
  groupId: string;
  carrier: TransportKindId;
};

export function ffdPack(
  replicas: Replica[],
  itemById: Map<string, Item>,
  recipeById: Map<string, Recipe>,
  tConfig: TransportConfig,
): PackedLane[] {
  const streams: Stream[] = [];
  for (const r of replicas) {
    const recipe = recipeById.get(r.recipeId);
    if (!recipe) continue;
    for (const o of recipe.out) {
      const itemsPerSec = r.executionRate.mul(new Fraction(o.qty));
      if (itemsPerSec.equals(0)) continue;
      const item = itemById.get(o.item);
      if (!item) {
        // A recipe output points at an item that isn't in itemById, which
        // means the pack lost referential integrity. Fail fast and name the
        // offending pair so the pack-load path is easy to debug, the same way
        // expandMultipliers throws on a missing item in
        // src/pipeline/expand/materialize.ts.
        throw new Error(
          `ffdPack: recipe ${r.recipeId} output item ${o.item} missing from itemById (pack referential integrity)`,
        );
      }
      const carrier: TransportKindId = item.transportKind;
      streams.push({
        replicaId: r.id,
        itemId: o.item,
        itemsPerSec,
        groupId: r.blueprintGroupId,
        carrier,
      });
    }
  }

  // Group the streams by (groupId, carrier).
  const buckets = new Map<string, Stream[]>();
  for (const s of streams) {
    const key = `${s.groupId}|${s.carrier}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(s);
  }

  const result: PackedLane[] = [];

  // Sort the bucket keys so the output order is deterministic.
  const sortedKeys = [...buckets.keys()].sort();
  for (const key of sortedKeys) {
    const bucket = buckets.get(key)!;
    const carrier = bucket[0]!.carrier;
    const groupId = bucket[0]!.groupId;
    const carrierCfg = tConfig.carriers[carrier];
    if (!carrierCfg) {
      throw new UnknownCarrierError(bucket[0]!.itemId, carrier);
    }
    const laneCap = new Fraction(carrierCfg.itemsPerSecondPerLane);

    // First-fit decreasing: sort by rate descending, breaking ties
    // lexicographically by (replicaId, itemId) so the result stays stable.
    const sorted = [...bucket].sort((a, b) => {
      const cmp = b.itemsPerSec.compare(a.itemsPerSec);
      if (cmp !== 0) return cmp;
      if (a.replicaId !== b.replicaId)
        return a.replicaId < b.replicaId ? -1 : 1;
      return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
    });

    type Lane = { streams: Stream[]; used: Fraction; overflow: boolean };
    const lanes: Lane[] = [];

    function tryPlace(s: Stream, overflowOnly: boolean): boolean {
      for (const lane of lanes) {
        if (overflowOnly && !lane.overflow) continue;
        if (!overflowOnly && lane.overflow) continue;
        const remaining = laneCap.sub(lane.used);
        if (remaining.compare(s.itemsPerSec) >= 0) {
          lane.streams.push(s);
          lane.used = lane.used.add(s.itemsPerSec);
          return true;
        }
      }
      return false;
    }

    for (const s of sorted) {
      // An oversized stream goes alone on its own overflow lane.
      if (s.itemsPerSec.compare(laneCap) > 0) {
        lanes.push({ streams: [s], used: s.itemsPerSec, overflow: true });
        continue;
      }
      if (tryPlace(s, false)) continue;
      // No room in the existing regular lanes, so open a new one if the group
      // is still under its lane budget.
      const nonOverflowLaneCount = lanes.filter((l) => !l.overflow).length;
      if (nonOverflowLaneCount < tConfig.lanesPerBlueprintGroup) {
        lanes.push({ streams: [s], used: s.itemsPerSec, overflow: false });
        continue;
      }
      // Out of regular lanes: try to squeeze it onto an existing overflow lane,
      // otherwise open a fresh overflow lane.
      if (tryPlace(s, true)) continue;
      lanes.push({ streams: [s], used: s.itemsPerSec, overflow: true });
    }

    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i]!;
      result.push({
        groupId,
        carrier,
        laneIndex: i,
        overflow: lane.overflow,
        streams: lane.streams.map((s) => ({
          replicaId: s.replicaId,
          itemId: s.itemId,
          itemsPerSec: s.itemsPerSec,
        })),
      });
    }
  }

  return result;
}
