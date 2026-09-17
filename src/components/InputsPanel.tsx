import { useEffect, useMemo, useRef, useState } from "react";
import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import {
  decodeItemOverrideKey,
  encodeItemOverrideKey,
  type ItemOverride,
  type ItemOverrideKey,
} from "../data/plan";
import { catalystItemIds } from "../data/recipe-category";
import { packIndex } from "../data/pack-index";
import { useI18n } from "../data/i18n-context";
import type { CatalystAccount } from "../solver/catalyst";
import { rationalFromString, type RationalString } from "../data/targets";
import {
  formatRatePerMin,
  formatRationalPerMin,
  ratePerSecToPerMin,
} from "../data/rate-format";
import {
  iconIdForItem,
  iconPosition,
  iconSheetUrl,
} from "../canvas/iconSprite";
import { Sprite } from "../canvas/RecipeNode";
import { computeItemDepths } from "../data/recipe-depth";
import { ItemPickerPopup } from "./ItemPickerPopup";
import { RatePromptPopup } from "./RatePromptPopup";
import { useRateEdit } from "./useRateEdit";

// An item has two boundary supply pools - the general one and, when some
// recipe cycles it, the catalyst one - and a row addresses exactly one of
// them. Everything the panel keys per row keys on this pair, not on the item;
// the string form (React keys, map keys, focus tokens) is the data layer's.
type RowKey = ItemOverrideKey;

// DOM-id form. The codec's "#" would break every selector that reads these
// ids, so the document uses its own suffix.
const CATALYST_ID_SUFFIX = "-cat";

function rowIdSuffix(key: RowKey): string {
  return key.role === "catalyst" ? CATALYST_ID_SUFFIX : "";
}

function isRow(override: ItemOverride, key: RowKey): boolean {
  return override.itemId === key.itemId && override.role === key.role;
}

const RATE_ZERO = new Fraction(0);

// Row readouts are definite numbers, so they take the rational formatter's
// zero rule ("0") rather than the chip formatter's empty string. Rates here
// are non-negative, so serializing .n/.d is safe.
function perMinText(itemsPerSec: Fraction): string {
  return formatRationalPerMin({
    num: itemsPerSec.n.toString(),
    denom: itemsPerSec.d.toString(),
  });
}

type Props = {
  itemOverrides: ItemOverride[];
  // Changes are emitted as functional updaters applied by the owner against
  // its authoritative list, never as snapshots of the prop: a commit built from
  // a stale prop can otherwise drop a concurrent edit or resurrect a removed
  // row. An updater that finds nothing to change must return its input unchanged
  // (same reference) so the owner can skip a no-op commit.
  onChange: (update: (current: ItemOverride[]) => ItemOverride[]) => void;
  pack: RecipePack;
  // Event items of effectively-off cohorts (#144's T6), itemId -> cohort, as
  // derived by unavailableEventItems(pack, overrides) in the owner. The picker
  // dims these tiles and the hint names the cohort(s). Optional with an empty
  // default so callers that model no cohorts render every tile enabled.
  eventOffItems?: ReadonlyMap<string, string> | undefined;
  targetItemIds?: ReadonlySet<string>;
  // Boundary supply per ROW KEY (encodeItemOverrideKey): the realized demand of the
  // latest render pass, read off the boundary nodes, with the ordinary node
  // under the item id and the catalyst node under the item's catalyst key.
  // When present, a general row shows the same number as the matching canvas
  // ProductNode; rows without an entry leave the rate slot empty. Shown in
  // place of the old "UNCAPPED" chip.
  supplyRateByItem?: ReadonlyMap<string, RationalString>;
  // What the solve billed each cycled catalyst charge to. The catalyst row
  // reads its needed rate from here, the general row the share billed to it,
  // and whichever of the two holds the charge reports what neither pool could
  // cover.
  catalystAccount?: CatalystAccount;
  // Items the current plan draws from the boundary as assumed-infinite supply:
  // raw items it consumes, plus any item it cycles as a catalyst (which need
  // not be raw). With no explicit override declared, these surface as
  // read-only auto-rows so the "unlimited by default" assumption is visible.
  // Typing a cap into an auto-row promotes it to a real override. General side
  // only: the catalyst pool has no auto-row.
  assumedRawItemIds?: ReadonlyArray<string>;
};

// Number of input ITEMS the panel actually shows: an item with an explicit
// override, an auto-row, or both counts once, so a split item does not read as
// two against the `N / pack.items.length` denominator. The supply counters
// (stats strip, side tab, section head) route through this so none of them can
// report 0 while auto-rows are on screen.
export function displayedInputCount(
  itemOverrides: ReadonlyArray<{
    itemId: string;
    role?: "catalyst" | undefined;
  }>,
  assumedRawItemIds: ReadonlyArray<string> | undefined,
): number {
  const ids = new Set(itemOverrides.map((o) => o.itemId));
  for (const id of assumedRawItemIds ?? []) ids.add(id);
  return ids.size;
}

// A focus target armed by a pick and consumed by the row that renders on the
// very next commit. The kind matters: both consumers live on the same row and
// React attaches refs in tree order, so the trigger inside .info completes
// before the rate input inside .b-rate. A bare row key would let the trigger
// ref swallow every token and the add path's rate focus would never fire.
type PendingFocus = { rowKey: string; kind: "rate" | "trigger" };

// Default for the optional eventOffItems prop: nothing is off-cohort.
const NO_EVENT_OFF: ReadonlyMap<string, string> = new Map();

export function InputsPanel({
  itemOverrides,
  onChange,
  pack,
  eventOffItems = NO_EVENT_OFF,
  targetItemIds,
  supplyRateByItem,
  catalystAccount,
  assumedRawItemIds,
}: Props) {
  const i18n = useI18n();
  const { itemById } = packIndex(pack);
  // The items that HAVE a catalyst pool: only these can carry a catalyst row,
  // so only these show the checkbox and fill a catalyst row's picker.
  const catalystIds = useMemo(() => catalystItemIds(pack.recipes), [pack]);
  // Availability depth per item id, used by the picker popup to group tiles.
  // computeItemDepths seeds every pack item; ones no recipe can reach land in
  // the unranked bucket, which on the shipped pack is empty.
  const tierByItemId = useMemo(() => computeItemDepths(pack), [pack]);
  // The off-cohort event sentence of the picker hint (#144's T6): the raw
  // cohort tokens ("v1.2 · v1.5"), the same ones the producer-unavailable
  // validation error interpolates. Gated on at least one of the items being in
  // the catalogue (pack.items here), so a hand-built map naming items the grid
  // never shows explains nothing.
  const eventOffHint = useMemo(() => {
    if (eventOffItems.size === 0) return undefined;
    if (!pack.items.some((it) => eventOffItems.has(it.id))) return undefined;
    const cohorts = [...new Set(eventOffItems.values())].sort().join(" · ");
    return i18n.t("picker.event.off", { cohorts });
  }, [eventOffItems, pack, i18n]);
  // Which row the picker popup is open for, plus the trigger button that
  // opened it so focus can return there on close.
  const [pickerFor, setPickerFor] = useState<
    { kind: "row"; key: RowKey } | { kind: "add" } | null
  >(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The override whose amount prompt (R5) is open. Picking in the add picker
  // closes it and opens this, so only one popup is ever mounted. The carried
  // override already names the resolved pool, so the prompt can badge the
  // catalyst case.
  const [prompt, setPrompt] = useState<{ override: ItemOverride } | null>(null);
  // Armed by a pick, consumed by the matching row's callback ref on the next
  // commit. A stale token (the commit was rejected, or the panel is rendered
  // with an onChange that never feeds the prop back) is simply overwritten by
  // the next pick.
  const pendingFocus = useRef<PendingFocus | null>(null);
  // The token lives for exactly one commit. focusOnMount is an inline arrow, so
  // React re-attaches it on every render, not only on mount: an unconsumed
  // token would otherwise sit armed indefinitely and fire on some later,
  // unrelated commit that happens to render a row with the same key, yanking
  // focus out of whatever the user was doing. Ref callbacks run before
  // effects within a commit, so a token the matching row consumed is already
  // null here; one whose commit never applied is dropped.
  useEffect(() => {
    pendingFocus.current = null;
  });
  function focusOnMount(
    el: HTMLElement | null,
    rowKey: string,
    kind: PendingFocus["kind"],
  ) {
    const want = pendingFocus.current;
    if (!el || !want || want.rowKey !== rowKey || want.kind !== kind) return;
    pendingFocus.current = null;
    el.focus();
  }
  // The row's item name plus, when present, the message under its rate field.
  // The name is a description rather than a label so the accessible NAME stays
  // the generic rate label every existing query resolves by.
  function rateDescribedBy(key: RowKey, hasMessage: boolean): string {
    const ids = [`i-name-${key.itemId}${rowIdSuffix(key)}`];
    if (hasMessage) ids.push(`i-rate-err-${key.itemId}${rowIdSuffix(key)}`);
    return ids.join(" ");
  }
  function closePicker() {
    setPickerFor(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    // The trigger may have been removed (a committed swap unmounts its row),
    // so guard the focus.
    if (btn && document.contains(btn)) btn.focus();
  }

  // The add prompt confirmed an amount (R5). The row commits exactly as a
  // direct pick used to: an empty field commits the bare override (uncapped),
  // a number caps it, and the pool the pick resolved carries over. The
  // pending-focus token hands focus to the new row's rate input - it is the
  // only edit that makes the new row do anything.
  function confirmPromptRate(rate: RationalString | undefined) {
    const added = prompt?.override;
    if (added === undefined) return;
    pendingFocus.current = {
      rowKey: encodeItemOverrideKey(added),
      kind: "rate",
    };
    onChange((current) =>
      current.some((o) => isRow(o, added))
        ? current
        : [
            ...current,
            rate === undefined ? added : { ...added, ratePerSec: rate },
          ],
    );
    triggerRef.current = null;
    setPrompt(null);
  }

  // R7: cancelling the prompt cancels the whole add - nothing committed, and
  // focus returns to the Add button that started it.
  function cancelPrompt() {
    setPrompt(null);
    const btn = triggerRef.current;
    triggerRef.current = null;
    if (btn && document.contains(btn)) btn.focus();
  }

  // Raised by a gesture that would land a second row on a row key that already
  // exists: a picker swap (defence in depth - the popup disables those tiles)
  // or a checkbox conversion, which has no tile to disable and is the live
  // path here.
  const [duplicateError, setDuplicateError] = useState<{
    rowKey: string;
    itemId: string;
  } | null>(null);
  // The rate edit/commit/revert protocol for the explicit override rows. Empty
  // text is a valid commit here (uncapped), and the committed string is kept as
  // the display value.
  // This instance and autoEdit below carry SEPARATE invalid sets, which is
  // equivalent to the one shared set only because no row key is ever an
  // override row and an auto-row at once. Per side: the autoRows filter below
  // ("every assumed-raw item WITHOUT a general override") enforces it on the
  // general side, and the catalyst side has no auto-rows at all, so a catalyst
  // key only ever reaches rowEdit. A catalyst override and a general auto-row
  // for the SAME ITEM coexist by design; their keys differ in role, so the two
  // sets still cannot disagree about one row.
  // The split also means an invalid flag does NOT follow a row across a family
  // change (auto row promoted to override, or override reverting to auto): the
  // stale cue the shared set used to carry over is dropped now.
  // The auto-row membership test the clear-cap rule below reads. Kept as a set
  // because the commit path is a lookup, not a walk.
  const autoRowIds = useMemo(
    () => new Set(assumedRawItemIds ?? []),
    [assumedRawItemIds],
  );
  const rowEdit = useRateEdit({
    emptyMeans: "uncap",
    keepTextAfterCommit: true,
    commit: (rowKey, parsed) => {
      const key = decodeItemOverrideKey(rowKey);
      onChange((current) => {
        const idx = current.findIndex((o) => isRow(o, key));
        // Row removed since the edit: no-op (same reference).
        if (idx < 0) return current;
        // Clearing the cap on a NON-RAW AUTO-ROW drops the whole override. A
        // field-less override means "import this item freely across the
        // boundary", which for a raw item is what it already was, but for a
        // non-raw one would silently make its balanced uses free too. Dropping
        // it returns the item to the auto-row the plan's draw already earns it.
        // Scoped to the auto-row set on purpose: a non-raw item outside it has
        // no row to fall back to, so dropping the override would turn a free
        // import into a forced internal build. Scoped to the general side too:
        // a catalyst row has no auto-row to fall back to and stays a row.
        if (
          parsed === undefined &&
          key.role === undefined &&
          itemById.get(key.itemId)?.raw !== true &&
          autoRowIds.has(key.itemId)
        ) {
          return current.filter((o) => !isRow(o, key));
        }
        const next = current.slice();
        // Spread the existing override so a rate edit never drops its other
        // fields (a hand-authored hash can carry plan: true).
        const row = { ...next[idx]! };
        if (parsed === undefined) {
          // Uncapped: drop ratePerSec from the override.
          delete row.ratePerSec;
        } else {
          row.ratePerSec = parsed;
        }
        next[idx] = row;
        return next;
      });
    },
  });
  // Prune pending / seeded texts for rows that left the override list by any
  // route: handleRemove clears its own row, but a promoted override can also
  // vanish when the list changes under the panel, and a surviving seeded text
  // would resurface if the row returns.
  const overrideKeys = useMemo(
    () => new Set(itemOverrides.map((o) => encodeItemOverrideKey(o))),
    [itemOverrides],
  );
  useEffect(() => {
    rowEdit.pruneEditsTo(overrideKeys);
    // rowEdit is rebuilt every render; the prune depends only on the live keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideKeys]);
  // The same protocol for the auto-rows. A valid non-empty rate promotes the
  // auto-row into an explicit override; an empty one is a no-op, since
  // "Unlimited" is the auto state. The text only needs to survive until commit
  // (the promoted row displays the seeded copy), so it is dropped afterwards
  // and a later auto-row rebirth comes back as Unlimited, not a stale cap.
  // Auto-rows are general-side only, so this instance is keyed by item id,
  // which is the general row key.
  const autoEdit = useRateEdit({
    emptyMeans: "uncap",
    keepTextAfterCommit: false,
    commit: (itemId, parsed, text) => {
      // Guard against re-adding the same row in case the commit races with
      // a prop update that already inserted the override.
      if (parsed !== undefined) {
        onChange((current) =>
          current.some((o) => isRow(o, { itemId }))
            ? current
            : [...current, { itemId, ratePerSec: parsed }],
        );
      }
      // Carry the committed text over to the override rows so the promoted row
      // shows what the user typed instead of the re-serialized Fraction.
      if (text.trim() !== "") rowEdit.seedCommittedText(itemId, text);
    },
  });

  function hasRow(key: RowKey): boolean {
    return overrideKeys.has(encodeItemOverrideKey(key));
  }
  // The general side counts as listed when an auto-row is showing it: that row
  // is where a cap for the item is typed, so the picker sends the user there.
  function generalListed(itemId: string): boolean {
    return hasRow({ itemId }) || autoRowIds.has(itemId);
  }
  // An item with no catalyst pool has nothing to list on that side.
  function catalystListed(itemId: string): boolean {
    return !catalystIds.has(itemId) || hasRow({ itemId, role: "catalyst" });
  }
  function fullyListed(itemId: string): boolean {
    return generalListed(itemId) && catalystListed(itemId);
  }

  function handleItemChange(key: RowKey, newItemId: string) {
    const target: RowKey = { itemId: newItemId, role: key.role };
    if (hasRow(target)) {
      setDuplicateError({
        rowKey: encodeItemOverrideKey(key),
        itemId: newItemId,
      });
      return;
    }
    setDuplicateError(null);
    rowEdit.carryPendingEdit(
      encodeItemOverrideKey(key),
      encodeItemOverrideKey(target),
    );
    onChange((current) => {
      const idx = current.findIndex((o) => isRow(o, key));
      if (idx < 0) return current;
      if (current.some((o) => isRow(o, target))) return current;
      const next = current.slice();
      const row = next[idx]!;
      // Keep any rate (and every other override field, e.g. plan) when the
      // user swaps the item; only itemId changes.
      next[idx] = { ...row, itemId: newItemId };
      return next;
    });
  }

  // The checkbox moves a row between the two pools. A conversion is an
  // identity change like an item swap, so it discards the row's uncommitted
  // rate edit; the cap carries over, and the wire-only plan flag is dropped
  // because a catalyst row can never hold one.
  function handleRoleChange(key: RowKey, toCatalyst: boolean) {
    const target: RowKey = {
      itemId: key.itemId,
      role: toCatalyst ? "catalyst" : undefined,
    };
    if (hasRow(target)) {
      setDuplicateError({
        rowKey: encodeItemOverrideKey(key),
        itemId: key.itemId,
      });
      return;
    }
    setDuplicateError(null);
    if (!hasRow(key)) {
      // An auto-row: its box is always unchecked, so this is the general
      // auto-row converting into a catalyst override. The general side keeps
      // whatever number it has and re-appears as an auto-row of its own.
      autoEdit.clearPendingEdit(key.itemId);
      onChange((current) =>
        current.some((o) => isRow(o, target))
          ? current
          : [...current, { itemId: key.itemId, role: "catalyst" }],
      );
      return;
    }
    rowEdit.clearPendingEdit(encodeItemOverrideKey(key));
    onChange((current) => {
      const idx = current.findIndex((o) => isRow(o, key));
      if (idx < 0) return current;
      if (current.some((o) => isRow(o, target))) return current;
      const next = current.slice();
      const converted = { ...next[idx]! };
      delete converted.role;
      // Wire-only and general-side only: the loader rejects a catalyst row
      // that carries it, so a conversion cannot take it along.
      delete converted.plan;
      if (toCatalyst) converted.role = "catalyst";
      next[idx] = converted;
      return next;
    });
  }

  function handleRemove(key: RowKey) {
    setDuplicateError(null);
    rowEdit.clearPendingEdit(encodeItemOverrideKey(key));
    onChange((current) => {
      const next = current.filter((o) => !isRow(o, key));
      return next.length === current.length ? current : next;
    });
  }

  // The general row's readout is its own ordinary draw plus the share of the
  // cycled charge the general pool was billed for. Undefined means there is
  // nothing to show yet (no solve, or an item this plan does not import).
  function generalRateText(itemId: string): string | undefined {
    const ordinary = supplyRateByItem?.get(encodeItemOverrideKey({ itemId }));
    const fromGeneral = catalystAccount?.get(itemId)?.fromGeneral;
    const part = fromGeneral ?? RATE_ZERO;
    if (ordinary === undefined && part.valueOf() === 0) return undefined;
    const base =
      ordinary === undefined ? RATE_ZERO : rationalFromString(ordinary);
    return perMinText(base.add(part));
  }

  // What the catalyst pool is asked to hold: the whole cycled charge less
  // whatever the general pool covered. A plan that cycles none of the item has
  // no account entry and the row reads a definite zero.
  function catalystRateText(itemId: string): string {
    const entry = catalystAccount?.get(itemId);
    if (entry === undefined) return "0";
    return perMinText(entry.need.sub(entry.fromGeneral));
  }

  function catalystPartText(itemId: string): string | undefined {
    const fromGeneral = catalystAccount?.get(itemId)?.fromGeneral;
    if (fromGeneral === undefined || fromGeneral.valueOf() === 0) {
      return undefined;
    }
    return i18n.t("inputs.catalyst.part", {
      rate: formatRatePerMin(fromGeneral),
    });
  }

  // What neither pool could hold, reported on the row that was asked to hold
  // the charge: the catalyst row when the item has one, else the general row.
  function shortageText(key: RowKey): string | undefined {
    const entry = catalystAccount?.get(key.itemId);
    if (entry === undefined || entry.unmet.valueOf() === 0) return undefined;
    const onCatalystRow = hasRow({ itemId: key.itemId, role: "catalyst" });
    if (onCatalystRow !== (key.role === "catalyst")) return undefined;
    return i18n.t("product.catalyst.short", {
      rate: formatRatePerMin(entry.unmet),
    });
  }

  // The checkbox that moves a row between the pools. Only an item some recipe
  // cycles has a catalyst pool to move into.
  function renderRoleToggle(key: RowKey) {
    if (!catalystIds.has(key.itemId)) return null;
    return (
      <label className="b-role">
        <input
          type="checkbox"
          data-testid="input-catalyst-toggle"
          checked={key.role === "catalyst"}
          onChange={(e) => handleRoleChange(key, e.target.checked)}
          aria-label={i18n.t("inputs.catalyst.role")}
        />
        <span>{i18n.t("inputs.catalyst.role")}</span>
      </label>
    );
  }

  // Auto-rows are every boundary-supply item WITHOUT an explicit GENERAL
  // override, shown regardless of how many overrides exist. Capping one item no
  // longer hides the realized demand of the remaining inputs, and a catalyst
  // override does not retire the item's general row. The owner decides what
  // belongs in the set; a catalyst item is in it because the plan draws it, not
  // because it is raw.
  const autoRows = (assumedRawItemIds ?? []).filter(
    (id) => !hasRow({ itemId: id }),
  );
  const showEmptyState = itemOverrides.length === 0 && autoRows.length === 0;
  // Every row key already exists, so the picker would open on an all-dimmed
  // grid. Unreachable on the shipped pack, but a hand-crafted plan can carry a
  // row per item per pool. Derived from the last completed render (autoRows
  // comes from realized demand), so it lags an in-flight solve; that is
  // harmless for a guard.
  const shownCount = displayedInputCount(itemOverrides, assumedRawItemIds);
  const addExhausted = pack.items.every((it) => fullyListed(it.id));

  return (
    <div className="boundary-section" data-testid="inputs-section">
      <div className="side-section-head">
        <span className="num">SUP · 02</span>
        <span className="label">INPUT SUPPLY</span>
        <span className="count">
          <span className="v">{shownCount}</span>
          {" / "}
          {pack.items.length}
        </span>
      </div>
      <div className="side-section-sub">
        {"// boundary import budget · raw + cross-domain"}
      </div>
      {showEmptyState ? (
        <div className="b-empty">{i18n.t("inputs.empty")}</div>
      ) : null}
      {autoRows.map((itemId) => {
        const key: RowKey = { itemId };
        const item = itemById.get(itemId);
        const isAlsoTarget = targetItemIds?.has(itemId) === true;
        const iconPos = iconPosition(iconIdForItem(itemId));
        const rate = autoEdit.field(itemId, "");
        const realizedPerMin = generalRateText(itemId);
        const partText = catalystPartText(itemId);
        const shortage = rate.invalid ? undefined : shortageText(key);
        return (
          <div
            key={`auto:${itemId}`}
            className="b-row"
            data-testid="input-auto-row"
            data-item-id={itemId}
            data-is-raw={item?.raw === true ? "true" : "false"}
            data-is-also-target={isAlsoTarget ? "true" : "false"}
          >
            <span className={"slot" + (iconPos === undefined ? " empty" : "")}>
              <Sprite iconId={iconIdForItem(itemId)} size={40} />
            </span>
            <div className="info">
              <span
                className="b-name"
                id={`i-name-${itemId}`}
                title={i18n.displayName(itemId)}
                data-testid="input-auto-name"
              >
                {i18n.displayName(itemId)}
              </span>
              {realizedPerMin !== undefined ? (
                <div className="b-needed" data-testid="input-realized-rate">
                  {i18n.t("inputs.needed", { rate: realizedPerMin })}
                </div>
              ) : null}
              {isAlsoTarget || partText !== undefined ? (
                <div className="b-tags">
                  {isAlsoTarget ? <span className="dual">DUAL</span> : null}
                  {partText !== undefined ? (
                    <>
                      {isAlsoTarget ? <span className="sep">·</span> : null}
                      <span
                        className="catalyst"
                        data-testid="input-catalyst-part"
                      >
                        {partText}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
              {renderRoleToggle(key)}
              <div className="item-id">
                {itemId}
                <span className="mid">ITEM</span>
              </div>
              {duplicateError?.rowKey === itemId && (
                <span role="alert">{i18n.t("inputs.duplicate")}</span>
              )}
            </div>
            <div className="b-rate">
              <input
                type="text"
                inputMode="decimal"
                aria-label={i18n.t("inputs.rate.label")}
                aria-describedby={rateDescribedBy(
                  key,
                  rate.invalid || shortage !== undefined,
                )}
                placeholder={i18n.t("inputs.unlimited")}
                {...rate.inputProps}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
              {rate.invalid ? (
                <span
                  className="b-rate-err"
                  id={`i-rate-err-${itemId}`}
                  data-testid="rate-invalid"
                >
                  {i18n.t("rate.invalid")}
                </span>
              ) : null}
              {shortage !== undefined ? (
                <span
                  className="b-rate-err"
                  id={`i-rate-err-${itemId}`}
                  data-testid="rate-catalyst-short"
                >
                  {shortage}
                </span>
              ) : null}
            </div>
          </div>
        );
      })}
      {itemOverrides.map((row) => {
        const key: RowKey = { itemId: row.itemId, role: row.role };
        const rowKey = encodeItemOverrideKey(key);
        const domId = `${row.itemId}${rowIdSuffix(key)}`;
        const item = itemById.get(row.itemId);
        const isRaw = item?.raw === true;
        const isAlsoTarget = targetItemIds?.has(row.itemId) === true;
        const iconPos = iconPosition(iconIdForItem(row.itemId));
        const uncapped = row.ratePerSec === undefined;
        const rate = rowEdit.field(
          rowKey,
          row.ratePerSec ? ratePerSecToPerMin(row.ratePerSec) : "",
        );
        // The needed rate for this row's own pool. The catalyst row always has
        // one (a definite zero when the plan cycles none of the item); the
        // general row shows nothing until a solve gives it something.
        const realizedPerMin =
          key.role === "catalyst"
            ? catalystRateText(row.itemId)
            : generalRateText(row.itemId);
        const partText =
          key.role === "catalyst" ? undefined : catalystPartText(row.itemId);
        const shortage = rate.invalid ? undefined : shortageText(key);
        const showsChip = !uncapped && realizedPerMin !== undefined;
        return (
          <div
            key={rowKey}
            className="b-row"
            data-testid="input-row"
            data-item-id={row.itemId}
            data-role={key.role}
            data-is-raw={isRaw ? "true" : "false"}
            data-is-also-target={isAlsoTarget ? "true" : "false"}
          >
            <span className={"slot" + (iconPos === undefined ? " empty" : "")}>
              <Sprite iconId={iconIdForItem(row.itemId)} size={40} />
            </span>
            <div className="info">
              <span className="b-pick">
                <button
                  type="button"
                  className="b-pick-trigger"
                  ref={(el) => focusOnMount(el, rowKey, "trigger")}
                  // The name goes in the accessible NAME, not just the visible
                  // text: aria-label overrides the button's content, so a bare
                  // "Item" would make every row's trigger announce identically
                  // and a screen-reader user could not tell which row they were
                  // about to open the picker for. The <select> this replaced
                  // announced its item as the control's value.
                  aria-label={i18n.t("item.selected", {
                    name: i18n.displayName(row.itemId),
                  })}
                  aria-haspopup="dialog"
                  // title shows the full localised item name on hover, for
                  // when the trigger truncates long names at narrow widths.
                  title={i18n.displayName(row.itemId)}
                  onClick={(e) => {
                    triggerRef.current = e.currentTarget;
                    setPickerFor({ kind: "row", key });
                  }}
                >
                  <span id={`i-name-${domId}`}>
                    {i18n.displayName(row.itemId)}
                  </span>
                </button>
              </span>
              {uncapped && realizedPerMin !== undefined ? (
                <div className="b-needed" data-testid="input-realized-rate">
                  {i18n.t("inputs.needed", { rate: realizedPerMin })}
                </div>
              ) : null}
              {(isAlsoTarget ||
                showsChip ||
                key.role === "catalyst" ||
                partText !== undefined) && (
                <div className="b-tags">
                  {key.role === "catalyst" ? (
                    <span
                      className="catalyst"
                      data-testid="input-catalyst-badge"
                    >
                      {i18n.t("inputs.catalyst.badge")}
                    </span>
                  ) : null}
                  {isAlsoTarget ? <span className="dual">DUAL</span> : null}
                  {partText !== undefined ? (
                    <span
                      className="catalyst"
                      data-testid="input-catalyst-part"
                    >
                      {partText}
                    </span>
                  ) : null}
                  {showsChip ? (
                    <span
                      className="realized"
                      data-testid="input-realized-rate"
                    >
                      {realizedPerMin}
                      {i18n.t("inputs.rate.unit")}
                    </span>
                  ) : null}
                </div>
              )}
              {renderRoleToggle(key)}
              <div className="item-id">
                {row.itemId}
                <span className="mid">ITEM</span>
              </div>
              {duplicateError?.rowKey === rowKey && (
                <span role="alert">{i18n.t("inputs.duplicate")}</span>
              )}
            </div>
            <div className="b-rate">
              <input
                type="text"
                inputMode="decimal"
                ref={(el) => focusOnMount(el, rowKey, "rate")}
                aria-label={i18n.t("inputs.rate.label")}
                aria-describedby={rateDescribedBy(
                  key,
                  rate.invalid || shortage !== undefined,
                )}
                placeholder={
                  uncapped
                    ? i18n.t("inputs.unlimited")
                    : i18n.t("inputs.rate.placeholder")
                }
                {...rate.inputProps}
              />
              <span className="unit">{i18n.t("inputs.rate.unit")}</span>
              {rate.invalid ? (
                <span
                  className="b-rate-err"
                  id={`i-rate-err-${domId}`}
                  data-testid="rate-invalid"
                >
                  {i18n.t("rate.invalid")}
                </span>
              ) : null}
              {shortage !== undefined ? (
                <span
                  className="b-rate-err"
                  id={`i-rate-err-${domId}`}
                  data-testid="rate-catalyst-short"
                >
                  {shortage}
                </span>
              ) : null}
            </div>
            <button
              className="b-remove"
              data-testid="remove-input"
              onClick={() => handleRemove(key)}
              aria-label={i18n.t("inputs.remove.label")}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        className="b-add"
        onClick={(e) => {
          if (addExhausted) return;
          triggerRef.current = e.currentTarget;
          setPickerFor({ kind: "add" });
        }}
        // aria-disabled, not disabled: a disabled button is not focusable, so
        // keyboard and screen-reader users would never reach the title that
        // explains why it does nothing.
        aria-disabled={addExhausted ? true : undefined}
        title={addExhausted ? i18n.t("inputs.add.exhausted") : undefined}
      >
        {i18n.t("inputs.add")}
      </button>
      {pickerFor !== null ? renderPicker() : null}
      {prompt !== null ? (
        <RatePromptPopup
          item={{
            id: prompt.override.itemId,
            name: i18n.displayName(prompt.override.itemId),
          }}
          badge={
            prompt.override.role === "catalyst"
              ? i18n.t("inputs.catalyst.badge")
              : undefined
          }
          emptyMeans="uncap"
          note={i18n.t("ratePrompt.noLimit")}
          iconSheetUrl={iconSheetUrl}
          onConfirm={confirmPromptRate}
          onCancel={cancelPrompt}
        />
      ) : null}
    </div>
  );

  function renderPicker() {
    if (pickerFor === null) return null;
    // The row may have gone (removed, or swapped by another commit) while the
    // popup was open. Rendering on regardless would highlight a tile for a row
    // that no longer exists and let a pick arm a focus token for a commit that
    // can never apply.
    const openFor = pickerFor.kind === "row" ? pickerFor.key : undefined;
    const row =
      openFor === undefined
        ? undefined
        : itemOverrides.find((o) => isRow(o, openFor));
    if (openFor !== undefined && row === undefined) return null;
    const disabledIds = new Set<string>();
    if (openFor === undefined) {
      // Add: an item is spent only once every pool it has is listed, so a
      // catalyst item whose general side is on screen is still pickable for
      // its catalyst row.
      for (const it of pack.items) {
        if (fullyListed(it.id)) disabledIds.add(it.id);
      }
    } else {
      // A swap stays inside the row's own pool, so only sibling rows of the
      // SAME role claim an item here.
      for (const o of itemOverrides) {
        if (o.role === openFor.role && o.itemId !== openFor.itemId) {
          disabledIds.add(o.itemId);
        }
      }
      if (openFor.role === "catalyst") {
        // A catalyst row addresses a catalyst pool, and only an item some
        // recipe cycles has one.
        for (const it of pack.items) {
          if (!catalystIds.has(it.id)) disabledIds.add(it.id);
        }
      } else if (row?.ratePerSec === undefined) {
        // Auto-row items are dimmed unless this row carries a cap: there
        // handleItemChange moves the cap onto the new item, which is a live
        // capability, and blocking it would force a delete-and-retype. A row
        // with no cap to carry would only append a bare override, which for a
        // raw item leaves effectiveSupply at Infinity either way: a full
        // re-solve and hash rewrite that changes nothing, and it destroys the
        // row it came from as well. To cap a raw item, type into its auto-row,
        // whose commit promotes it to a real override.
        for (const id of assumedRawItemIds ?? []) disabledIds.add(id);
      }
    }
    // Off-cohort event items (#144's T6) dim on top of the listed ones, so the
    // listed count has to be read before they go in.
    const listedCount = disabledIds.size;
    for (const id of eventOffItems.keys()) disabledIds.add(id);
    // Accurate for every reason a tile is dimmed here, one sentence per cause:
    // a sibling row already claims the item's pool, it has an auto-row this
    // popup cannot usefully take over, or (on a catalyst row) it has no
    // catalyst pool at all - for all three the advice is to edit the row that
    // has it - and/or it belongs to an off-cohort event. A single cause renders
    // its sentence alone; both together join with the panel's " · " separator,
    // since the popup renders exactly one hint line. Before the first solve
    // lands there are no auto-rows and no overrides, so with every cohort on
    // nothing is dimmed and the hint would explain an absence.
    const hintSentences = [
      ...(listedCount > 0 ? [i18n.t("inputs.picker.listed")] : []),
      ...(eventOffHint !== undefined ? [eventOffHint] : []),
    ];
    return (
      <ItemPickerPopup
        items={pack.items}
        disabledIds={disabledIds}
        selectedId={row?.itemId}
        tierByItemId={tierByItemId}
        disabledHint={
          hintSentences.length > 0 ? hintSentences.join(" · ") : undefined
        }
        onPick={(newId) => {
          if (row === undefined) {
            // The general side is where a new row goes; when it is already
            // listed, the tile was left enabled because the catalyst side is
            // the one still free.
            const added: ItemOverride = generalListed(newId)
              ? { itemId: newId, role: "catalyst" }
              : { itemId: newId };
            // R5: the amount prompt asks for the rate before anything
            // commits. The picker closes without refocusing - the prompt's
            // input takes focus when it mounts - and the trigger stays
            // stashed for the prompt's cancel path, so only one popup is
            // ever mounted.
            setPickerFor(null);
            setPrompt({ override: added });
            return;
          }
          // Re-picking the row's own (still-enabled, highlighted) item is a
          // confirm, not a swap; without this guard the dup check would match
          // the row against itself and raise a false duplicate alert.
          if (newId !== row.itemId) {
            // The swap unmounts this row (rows are keyed by row key), so
            // closePicker's refocus lands on a button the next commit
            // removes. Hand focus to the swapped row's trigger instead.
            pendingFocus.current = {
              rowKey: encodeItemOverrideKey({ itemId: newId, role: row.role }),
              kind: "trigger",
            };
            handleItemChange({ itemId: row.itemId, role: row.role }, newId);
          }
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
}
