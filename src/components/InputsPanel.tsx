import { useEffect, useMemo, useState } from "react";
import Fraction from "fraction.js";
import type { RecipePack } from "@aef/schema";
import {
  decodeItemOverrideKey,
  encodeItemOverrideKey,
  type ItemOverride,
  type ItemOverrideKey,
  type ProducerUnavailableCause,
} from "../data/plan";
import { catalystItemIds } from "../data/recipe-category";
import { packIndex } from "../data/pack-index";
import { useI18n } from "../data/i18n-context";
import type { CatalystAccount } from "../solver/catalyst";
import { rationalFromString, type RationalString } from "../data/targets";
import {
  formatFractionPerMin,
  formatRatePerMin,
  parsePerMinToRatePerSec,
  ratePerSecToPerMin,
} from "../data/rate-format";
import {
  iconIdForItem,
  iconPosition,
  iconSheetUrl,
} from "../canvas/iconSprite";
import { Sprite } from "../canvas/RecipeNode";
import { ItemPickerPopup } from "./ItemPickerPopup";
import { RatePromptPopup } from "./RatePromptPopup";
import { usePickerFlow } from "./usePickerFlow";
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

type Props = {
  itemOverrides: ItemOverride[];
  // Changes are emitted as functional updaters applied by the owner against
  // its authoritative list, never as snapshots of the prop: a commit built from
  // a stale prop can otherwise drop a concurrent edit or resurrect a removed
  // row. An updater that finds nothing to change must return its input unchanged
  // (same reference) so the owner can skip a no-op commit.
  onChange: (update: (current: ItemOverride[]) => ItemOverride[]) => void;
  pack: RecipePack;
  // Unavailable items, each mapped to the cause behind it, as derived by
  // unavailableItems(pack, settings) in the owner. The picker dims these tiles
  // and the hint names the cause. Optional with an empty default so callers
  // that model no availability render every tile enabled.
  unavailableItems?: ReadonlyMap<string, ProducerUnavailableCause> | undefined;
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
  // not be raw). With no explicit override declared, these surface in the
  // Assumed unlimited block so the "unlimited by default" assumption is
  // visible. The block's per-row "set cap" button promotes a row into a real
  // override. General side only: the catalyst pool has no auto-row.
  assumedRawItemIds?: ReadonlyArray<string>;
};

// Number of input ITEMS the panel actually shows: an item with an explicit
// override, an auto-row, or both counts once, so a split item does not read as
// two against the `N / pack.items.length` denominator. The supply counters
// (stats strip, section head) route through this so none of them can report 0
// while auto-rows are on screen.
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

// The items the Assumed unlimited block lists: every boundary-supply item
// WITHOUT an explicit GENERAL override, shown regardless of how many overrides
// exist. Capping one item does not hide the realized demand of the remaining
// inputs, and a catalyst override does not retire the item's general row. The
// owner decides what belongs in the set; a catalyst item is in it because the
// plan draws it, not because it is raw.
export function assumedInputRows(
  itemOverrides: ReadonlyArray<{
    itemId: string;
    role?: "catalyst" | undefined;
  }>,
  assumedRawItemIds: ReadonlyArray<string> | undefined,
): string[] {
  const general = new Set(
    itemOverrides.filter((o) => o.role === undefined).map((o) => o.itemId),
  );
  return (assumedRawItemIds ?? []).filter((id) => !general.has(id));
}

// The Assumed unlimited block's own count. displayedInputCount stays the
// scalar the stats strip and the section head read, so it cannot carry this
// second number as well.
export function assumedInputCount(
  itemOverrides: ReadonlyArray<{
    itemId: string;
    role?: "catalyst" | undefined;
  }>,
  assumedRawItemIds: ReadonlyArray<string> | undefined,
): number {
  return assumedInputRows(itemOverrides, assumedRawItemIds).length;
}

// Default for the optional unavailableItems prop: nothing is unavailable.
const NO_UNAVAILABLE: ReadonlyMap<string, ProducerUnavailableCause> = new Map();

export function InputsPanel({
  itemOverrides,
  onChange,
  pack,
  unavailableItems = NO_UNAVAILABLE,
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
  // The picker popup (per row, or Add's) and the amount prompt (R5) an add
  // pick opens, keyed by row key. The carried override already names the
  // resolved pool, so the prompt can badge the catalyst case. The picker's
  // catalogue is the whole pack.
  const flow = usePickerFlow<
    { kind: "row"; key: RowKey } | { kind: "add" },
    { override: ItemOverride }
  >(pack, pack.items, unavailableItems);
  const { pickerFor, prompt, closePicker, focusOnMount } = flow;
  // The row's item name plus, when present, the message under its rate field.
  // The name element stays a description even though the label now carries the
  // item too: it is the on-screen name the row's message hangs off.
  function rateDescribedBy(key: RowKey, hasMessage: boolean): string {
    const ids = [`i-name-${key.itemId}${rowIdSuffix(key)}`];
    if (hasMessage) ids.push(`i-rate-err-${key.itemId}${rowIdSuffix(key)}`);
    return ids.join(" ");
  }

  // The pool a row addresses, as its controls name it: an item can hold a row
  // in both pools, so the item name alone does not identify a row.
  function poolName(key: RowKey): string {
    return i18n.t(
      key.role === "catalyst" ? "inputs.pool.catalyst" : "inputs.pool.general",
    );
  }

  // Accessible name for a row's rate field or its remove button.
  function rowLabel(
    key: RowKey,
    k: "inputs.rate.forItem" | "inputs.remove.forItem",
  ) {
    return i18n.t(k, {
      name: i18n.displayName(key.itemId),
      pool: poolName(key),
    });
  }

  // The add prompt confirmed an amount (R5). The row commits exactly as a
  // direct pick used to: an empty field commits the bare override (uncapped),
  // a number caps it, and the pool the pick resolved carries over. The
  // pending-focus token hands focus to the new row's rate input - it is the
  // only edit that makes the new row do anything.
  function confirmPromptRate(rate: RationalString | undefined) {
    const added = prompt?.override;
    if (added === undefined) return;
    flow.armFocus(encodeItemOverrideKey(added), "rate");
    onChange((current) =>
      current.some((o) => isRow(o, added))
        ? current
        : [
            ...current,
            rate === undefined ? added : { ...added, ratePerSec: rate },
          ],
    );
    flow.closePrompt();
  }

  // Raised by a gesture that would land a second row on a row key that already
  // exists: a picker swap (defence in depth - the popup disables those tiles)
  // or a checkbox conversion, which has no tile to disable and is the live
  // path here.
  const [duplicateError, setDuplicateError] = useState<{
    rowKey: string;
    itemId: string;
  } | null>(null);
  // The rate edit/commit/revert protocol for the override rows, which are the
  // only rows with a rate field: an Assumed row has none until its "set cap"
  // button promotes it. Empty text is a valid commit here (uncapped), and the
  // committed string is kept as the display value.
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
        // Clearing the cap on an AUTO-ROW ITEM drops the whole override, which
        // is what sends the row back to the Assumed unlimited block the button
        // promoted it out of. Raw items are in scope too: leaving a field-less
        // override behind would strand the row in Supplies with no cap, which
        // is exactly the state the block promises it never holds.
        // Scoped to the auto-row set on purpose: an item outside it has no row
        // to fall back to, so dropping the override would turn a free import
        // into a forced internal build. Scoped to the general side too: a
        // catalyst row has no auto-row to fall back to and stays a row.
        if (
          parsed === undefined &&
          key.role === undefined &&
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
  // Prune pending texts for rows that left the override list by any route:
  // handleRemove clears its own row, but a promoted override can also vanish
  // when the list changes under the panel, and a surviving committed text
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
  // The Assumed block's promotion in flight: the item whose row has opened a
  // rate field, the text in it, and whether the last commit attempt failed to
  // parse. It is UI state on purpose. A bare override appended on the click
  // would read as unlimited boundary supply for a non-raw item - 0 per second
  // becomes Infinity - and the owner would re-solve and rewrite the hash
  // before any number was typed. So the row keeps its assumed-unlimited supply
  // and only a committed rate turns it into an override.
  const [pendingCap, setPendingCap] = useState<{
    itemId: string;
    text: string;
    invalid: boolean;
  } | null>(null);
  // The auto-row whose promotion a blur threw away, if any. The field is gone
  // by then, so the row itself has to say so; reopening it retires the notice.
  const [revertedCap, setRevertedCap] = useState<string | null>(null);

  // Opens the field and arms the focus token the row's input consumes on
  // mount: an empty field the user has to fill is the whole point of making
  // promotion explicit.
  function handleSetCap(itemId: string) {
    flow.armFocus(encodeItemOverrideKey({ itemId }), "rate");
    setRevertedCap(null);
    setPendingCap({ itemId, text: "", invalid: false });
  }

  // Enter (revert=false) or blur (revert=true) on the pending field. A parsed
  // rate appends the capped override in one update; empty text cancels,
  // because the only override this path could otherwise append is the bare,
  // uncapped one it exists to avoid. Bad text keeps the field open with the
  // invalid cue on Enter and cancels on blur, as an override row's field does.
  function commitPendingCap(itemId: string, text: string, revert: boolean) {
    if (text.trim() === "") {
      setPendingCap(null);
      return;
    }
    const parsed = parsePerMinToRatePerSec(text);
    if (parsed === undefined) {
      // Same one-line policy as an override row's blur-revert (useRateEdit's
      // `reverted` flag): the discarded text is reported where the field was,
      // so a silent cancel never reads as the panel eating the number.
      setRevertedCap(revert ? itemId : null);
      setPendingCap(revert ? null : { itemId, text, invalid: true });
      return;
    }
    const rowKey = encodeItemOverrideKey({ itemId });
    // The commit unmounts this field and mounts the new Supplies row's one;
    // hand focus over, but only on Enter, since a blur commit means the user
    // has already moved on.
    if (!revert) flow.armFocus(rowKey, "rate");
    // The new row derives its field from the committed rational, which would
    // re-serialize a typed "1/3" as 0.3333333333333333; hand the text over as
    // the row's own committed value instead.
    rowEdit.seedCommittedText(rowKey, text);
    setPendingCap(null);
    onChange((current) =>
      current.some((o) => isRow(o, { itemId }))
        ? current
        : [...current, { itemId, ratePerSec: parsed }],
    );
  }

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
    return formatFractionPerMin(base.add(part));
  }

  // What the catalyst pool is asked to hold: the whole cycled charge less
  // whatever the general pool covered. A plan that cycles none of the item has
  // no account entry and the row reads a definite zero.
  function catalystRateText(itemId: string): string {
    const entry = catalystAccount?.get(itemId);
    if (entry === undefined) return "0";
    return formatFractionPerMin(entry.need.sub(entry.fromGeneral));
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

  const autoRows = assumedInputRows(itemOverrides, assumedRawItemIds);
  const showEmptyState = itemOverrides.length === 0 && autoRows.length === 0;
  // Every row key already exists, so the picker would open on an all-dimmed
  // grid. Unreachable on the shipped pack, but a hand-crafted plan can carry a
  // row per item per pool. Derived from the last completed render (autoRows
  // comes from realized demand), so it lags an in-flight solve; that is
  // harmless for a guard.
  const shownCount = displayedInputCount(itemOverrides, assumedRawItemIds);
  const addExhausted = pack.items.every((it) => fullyListed(it.id));
  // Supplies holds every declared override, capped or not; Assumed unlimited
  // holds the rows the plan earned by drawing the item. Each head is gated on
  // its OWN rows, so a panel whose every drawn item is overridden shows the
  // Supplies head alone rather than an "Assumed unlimited · 0 rows" head over
  // nothing. With neither block's rows present, the empty-state line stands in
  // for both.
  const suppliesBlock =
    itemOverrides.length === 0 ? null : (
      <>
        <div className="block-head" data-testid="inputs-block-supplies">
          <span>{i18n.t("inputs.block.supplies")}</span>
          <span className="n">
            {i18n.t("inputs.block.rows", {
              count: String(itemOverrides.length),
            })}
          </span>
        </div>
        <div className="block-sub">{i18n.t("inputs.block.supplies.sub")}</div>
      </>
    );
  const assumedBlock =
    autoRows.length === 0 ? null : (
      <>
        <div className="block-head assumed" data-testid="inputs-block-assumed">
          <span>{i18n.t("inputs.block.assumed")}</span>
          <span className="n">
            {i18n.t("inputs.block.rows", {
              count: String(
                assumedInputCount(itemOverrides, assumedRawItemIds),
              ),
            })}
          </span>
        </div>
        <div className="block-sub">{i18n.t("inputs.block.assumed.sub")}</div>
      </>
    );

  return (
    <>
      {/* Sibling of the targets head inside the one scroll body, not a child
          of this section: a head nested in its own section unsticks the moment
          that section scrolls past, and both counts have to stay on screen at
          every scroll offset. */}
      <div
        className="side-section-head side-section-head-inputs"
        data-testid="inputs-head"
      >
        <span className="num">SUP · 02</span>
        <span className="label">INPUT SUPPLY</span>
        <span className="count">
          <span className="v">{shownCount}</span>
          {" / "}
          {pack.items.length}
        </span>
      </div>
      <div className="boundary-section" data-testid="inputs-section">
        <div className="side-section-sub">
          {"// boundary import budget · raw + cross-domain"}
        </div>
        {showEmptyState ? (
          <div className="b-empty">{i18n.t("inputs.empty")}</div>
        ) : null}
        {suppliesBlock}
        <div className="supplies-body" data-testid="inputs-supplies-body">
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
              key.role === "catalyst"
                ? undefined
                : catalystPartText(row.itemId);
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
                <span
                  className={"slot" + (iconPos === undefined ? " empty" : "")}
                >
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
                      onClick={(e) =>
                        flow.openPicker(e.currentTarget, { kind: "row", key })
                      }
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
                    // The item and its pool go in the accessible NAME: a rail
                    // of fields all announcing "Rate" leaves a screen-reader
                    // user unable to tell which row, let alone which pool,
                    // they are capping.
                    aria-label={rowLabel(key, "inputs.rate.forItem")}
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
                  ) : rate.reverted ? (
                    // A status, not an error: the field holds a valid rate
                    // again, so it carries no aria-invalid and no id - it
                    // describes nothing, role="status" announces it.
                    <span
                      className="b-rate-err"
                      role="status"
                      data-testid="rate-reverted"
                    >
                      {i18n.t("rate.reverted")}
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
                  aria-label={rowLabel(key, "inputs.remove.forItem")}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
        {assumedBlock}
        <div className="assumed-body" data-testid="inputs-assumed-body">
          {autoRows.map((itemId) => {
            const key: RowKey = { itemId };
            const item = itemById.get(itemId);
            const isAlsoTarget = targetItemIds?.has(itemId) === true;
            const iconPos = iconPosition(iconIdForItem(itemId));
            const realizedPerMin = generalRateText(itemId);
            const partText = catalystPartText(itemId);
            const pending =
              pendingCap?.itemId === itemId ? pendingCap : undefined;
            // Same rule as an override row: a field the user has to fix owns
            // the message slot, so the two never claim the one id at once.
            const shortage =
              pending?.invalid === true ? undefined : shortageText(key);
            return (
              <div
                key={`auto:${itemId}`}
                className="b-row"
                data-testid="input-auto-row"
                data-item-id={itemId}
                data-pending-cap={pending === undefined ? undefined : "true"}
                data-is-raw={item?.raw === true ? "true" : "false"}
                data-is-also-target={isAlsoTarget ? "true" : "false"}
              >
                <span
                  className={"slot" + (iconPos === undefined ? " empty" : "")}
                >
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
                  {/* The pool checkbox is the one live control in this block.
                    "Read-only" here means "no rate field": an item's catalyst
                    pool membership is orthogonal to whether it is capped, and
                    dropping the box would strand catalyst items with no way to
                    reach their pool. */}
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
                  {pending === undefined ? (
                    <span className="inf" aria-hidden="true">
                      ∞
                    </span>
                  ) : (
                    <input
                      type="text"
                      inputMode="decimal"
                      data-testid="input-pending-cap"
                      ref={(el) =>
                        focusOnMount(el, encodeItemOverrideKey(key), "rate")
                      }
                      aria-label={rowLabel(key, "inputs.rate.forItem")}
                      aria-describedby={rateDescribedBy(
                        key,
                        pending.invalid || shortage !== undefined,
                      )}
                      placeholder={i18n.t("inputs.rate.placeholder")}
                      value={pending.text}
                      aria-invalid={pending.invalid ? true : undefined}
                      className={pending.invalid ? "invalid" : undefined}
                      onChange={(e) =>
                        setPendingCap({
                          itemId,
                          text: e.target.value,
                          invalid: false,
                        })
                      }
                      onBlur={() =>
                        commitPendingCap(itemId, pending.text, true)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          commitPendingCap(itemId, pending.text, false);
                        } else if (e.key === "Escape") {
                          // Abandoning the field unmounts the element focus is
                          // on, and the button that replaces it does not exist
                          // yet, so hand focus over with the row's token
                          // rather than dropping it on the body.
                          flow.armFocus(encodeItemOverrideKey(key), "setCap");
                          setPendingCap(null);
                        }
                      }}
                    />
                  )}
                  <span className="unit">{i18n.t("inputs.rate.unit")}</span>
                  {pending === undefined ? (
                    <button
                      type="button"
                      className="set-cap"
                      data-testid="input-set-cap"
                      ref={(el) =>
                        focusOnMount(el, encodeItemOverrideKey(key), "setCap")
                      }
                      // The item goes in the accessible NAME: a rail of buttons all
                      // announcing "Set cap" tells a screen-reader user nothing
                      // about which row they are about to promote.
                      aria-label={i18n.t("inputs.setCap.label", {
                        name: i18n.displayName(itemId),
                      })}
                      onClick={() => handleSetCap(itemId)}
                    >
                      {i18n.t("inputs.setCap")}
                    </button>
                  ) : null}
                  {pending?.invalid === true ? (
                    <span
                      className="b-rate-err"
                      id={`i-rate-err-${itemId}`}
                      data-testid="rate-invalid"
                    >
                      {i18n.t("rate.invalid")}
                    </span>
                  ) : revertedCap === itemId ? (
                    <span
                      className="b-rate-err"
                      role="status"
                      data-testid="rate-reverted"
                    >
                      {i18n.t("rate.reverted")}
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
        </div>
        <button
          className="b-add"
          onClick={(e) => {
            if (addExhausted) return;
            flow.openPicker(e.currentTarget, { kind: "add" });
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
            onCancel={flow.cancelPrompt}
          />
        ) : null}
      </div>
    </>
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
        // row it came from as well. To cap such an item, press "set cap" on its
        // Assumed unlimited row, which promotes it to a real override.
        for (const id of assumedRawItemIds ?? []) disabledIds.add(id);
      }
    }
    // Off-cohort event items (#144's T6) dim on top of the listed ones, so the
    // listed count has to be read before they go in.
    const listedCount = disabledIds.size;
    for (const id of unavailableItems.keys()) disabledIds.add(id);
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
      ...(flow.unavailableHint !== undefined ? [flow.unavailableHint] : []),
    ];
    return (
      <ItemPickerPopup
        items={pack.items}
        disabledIds={disabledIds}
        selectedId={row?.itemId}
        tierByItemId={flow.tierByItemId}
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
            // commits.
            flow.openPrompt({ override: added });
            return;
          }
          // Re-picking the row's own (still-enabled, highlighted) item is a
          // confirm, not a swap; without this guard the dup check would match
          // the row against itself and raise a false duplicate alert.
          if (newId !== row.itemId) {
            // The swap unmounts this row (rows are keyed by row key), so
            // closePicker's refocus lands on a button the next commit
            // removes. Hand focus to the swapped row's trigger instead.
            flow.armFocus(
              encodeItemOverrideKey({ itemId: newId, role: row.role }),
              "trigger",
            );
            handleItemChange({ itemId: row.itemId, role: row.role }, newId);
          }
          closePicker();
        }}
        onClose={closePicker}
      />
    );
  }
}
