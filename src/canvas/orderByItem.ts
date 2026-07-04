// Reorder rows carrying an `item` field to match an ELK-resolved item-id
// order. Each returned entry keeps its own payload (a recipe row keeps its
// Stoich so the per-row rate text pairs with the right qty; a loop net-IO port
// keeps its rate). Falls back to the declared order when `order` is missing or
// empty. Defensive against an order that omits or duplicates an item:
// unmatched declared rows are appended so no row is ever dropped.
export function orderByItem<T extends { item: string }>(
  rows: ReadonlyArray<T>,
  order: readonly string[] | undefined,
): T[] {
  if (order === undefined || order.length === 0) return [...rows];
  const byItem = new Map(rows.map((r) => [r.item, r]));
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of order) {
    const r = byItem.get(item);
    if (r !== undefined && !seen.has(item)) {
      out.push(r);
      seen.add(item);
    }
  }
  for (const r of rows) {
    if (!seen.has(r.item)) out.push(r);
  }
  return out;
}
