import type Fraction from "fraction.js";
import type { ItemId, ReplicaId } from "../types";

export type ClassId = string & { readonly __brand: "ClassId" };

export type ReplicaEdge = {
  source: ReplicaId;
  target: ReplicaId;
  item: ItemId;
  rate: Fraction;
};

export type QuotientEdge = {
  sourceClass: ClassId;
  targetClass: ClassId;
  item: ItemId;
  rate: Fraction;
};

export type NeighborTag = {
  item: ItemId;
  classId: ClassId;
};

export function canonicalEncodeNeighbors(
  tags: ReadonlyArray<NeighborTag>,
): string {
  const sorted = [...tags].sort((a, b) => {
    if (a.item !== b.item) return a.item < b.item ? -1 : 1;
    if (a.classId !== b.classId) return a.classId < b.classId ? -1 : 1;
    return 0;
  });
  const FIELD_SEP = "\x1F";
  const RECORD_SEP = "\x1E";
  return sorted.map((t) => t.item + FIELD_SEP + t.classId).join(RECORD_SEP);
}
