// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { pack as realPack } from "../data/load";
import { TargetsPanel } from "./TargetsPanel";
import { makePack } from "../solver/closed-form-fixtures";
import { LocaleProvider } from "../data/i18n-context";
import { loadI18n } from "../data/i18n";
import { unavailableItems } from "../data/availability";
import type { Target } from "../data/targets";
import type { ProducerUnavailableCause } from "../data/plan";
import {
  controlledOwner,
  pickerTile,
  promptInput,
  rateInputs,
} from "./panel.testkit";

afterEach(cleanup);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const PACK = makePack(
  [
    {
      id: "r_widget",
      category: "craft",
      time: 1,
      in: {},
      out: { widget: 1 },
      cost: 1,
    },
    {
      id: "r_gadget",
      category: "craft",
      time: 1,
      in: {},
      out: { gadget: 1 },
      cost: 1,
    },
    {
      id: "r_sprocket",
      category: "craft",
      time: 1,
      in: {},
      out: { sprocket: 1 },
      cost: 1,
    },
  ],
  [{ id: "widget" }, { id: "gadget" }, { id: "sprocket" }],
);

function targets3(): Target[] {
  return [
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } }, // 120/min
    { itemId: "gadget", ratePerSec: { num: "1", denom: "2" } }, // 30/min
    { itemId: "sprocket", ratePerSec: { num: "1", denom: "4" } }, // 15/min
  ];
}

function pickTile(itemId: string) {
  fireEvent.click(pickerTile(itemId)!);
}

// Typing alone must never commit: the whole point of moving off the debounce is
// that no half-typed magnitude reaches the solver.
test("typing a rate does not commit, even after time passes", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.change(input, { target: { value: "0." } });
  fireEvent.change(input, { target: { value: "0.5" } });
  act(() => vi.advanceTimersByTime(1000));
  expect(onChange).not.toHaveBeenCalled();
  expect(input.value).toBe("0.5");
});

test("blur commits the parsed value exactly once", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.blur(input);
  expect(owner.emissions.length).toBe(1);
  // 99/min = 33/20 per sec.
  expect(owner.latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "33", denom: "20" } },
  ]);
});

test("Enter commits the parsed value", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "45" } });
  fireEvent.keyDown(input, { key: "Enter" });
  // 45/min = 3/4 per sec.
  expect(owner.latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "3", denom: "4" } },
  ]);
});

// The committed text is kept verbatim on Enter: a valid "1/3" is not
// re-serialized into a 16-digit float, and an invalid in-progress "1/" survives
// an Enter (with the invalid cue) so the user can keep typing.
test("Enter keeps invalid text with an invalid cue; a valid rational commits and keeps its text", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "1/" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("1/");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(owner.emissions.length).toBe(0);
  fireEvent.change(input, { target: { value: "1/3" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(owner.emissions.length).toBe(1);
  // 1/3 per min = 1/180 per sec.
  expect(owner.latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "1", denom: "180" } },
  ]);
  // Field keeps "1/3", not "0.3333333333333333".
  expect(input.value).toBe("1/3");
  // The valid commit cleared the invalid cue.
  expect(input.getAttribute("aria-invalid")).toBeNull();
});

// A commit attempt on unparseable text surfaces a visible, localized invalid
// state instead of silently keeping the old value with no cue.
test("Enter on unparseable text sets aria-invalid and shows an inline message", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "12,5" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(
    screen.getByTestId("rate-invalid").textContent!.length,
  ).toBeGreaterThan(0);
  expect(onChange).not.toHaveBeenCalled();
});

// Blur on an unparseable entry drops the bad text and restores the last-good
// value, so the field never sticks on rejected input.
test("blur on unparseable text reverts the field to the last-good value", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  expect(input.value).toBe("120");
  fireEvent.change(input, { target: { value: "12,5" } });
  fireEvent.blur(input);
  expect(input.value).toBe("120");
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  // The revert is reported, not silent: a discarded edit with no cue reads as
  // the panel swallowing the number. It is a status, not an error - the field
  // holds a valid rate again.
  const status = screen.getByTestId("rate-reverted");
  expect(status.getAttribute("role")).toBe("status");
  expect(status.className).toContain("b-rate-err");
  expect(status.textContent).toBe(loadI18n("en").t("rate.reverted"));
  // Nothing describes it, and the now-valid field is not marked invalid.
  expect(input.getAttribute("aria-describedby")).toBeNull();
  expect(status.id).toBe("");
  // Short-lived: the next keystroke retires it.
  fireEvent.change(input, { target: { value: "60" } });
  expect(screen.queryByTestId("rate-reverted")).toBeNull();
});

// Refocusing the field is the other way out of the notice: the user is back on
// the value it talks about.
test("refocusing the reverted field retires the status line", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]}
        onChange={() => {}}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "12,5" } });
  fireEvent.blur(input);
  expect(screen.getByTestId("rate-reverted")).not.toBeNull();
  fireEvent.focus(input);
  expect(screen.queryByTestId("rate-reverted")).toBeNull();
});

// A revert flag must not outlive its row: swapping the row's item away and
// back re-creates the row key, and a stale flag would resurface as a status
// line about an edit the fresh row never saw.
test("a revert status does not resurface after swapping the item away and back", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "12,5" } });
  fireEvent.blur(input);
  expect(screen.getByTestId("rate-reverted")).not.toBeNull();
  // Swap widget -> gadget: the widget key leaves the family.
  fireEvent.click(screen.getByLabelText(/^Item: widget$/));
  pickTile("gadget");
  expect(screen.queryByTestId("rate-reverted")).toBeNull();
  // Swap back: the widget key returns and must not carry the stale flag.
  fireEvent.click(screen.getByLabelText(/^Item: gadget$/));
  pickTile("widget");
  expect(screen.queryByTestId("rate-reverted")).toBeNull();
});

// Enter's invalid cue and the blur revert are different states and must not
// both be on screen: one says "fix this", the other "your text is gone".
test("Enter on unparseable text shows the invalid cue, not the revert status", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]}
        onChange={() => {}}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "12,5" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("rate-invalid")).not.toBeNull();
  expect(screen.queryByTestId("rate-reverted")).toBeNull();
});

// Every row control carries its own item in its accessible name, so a
// screen-reader user can tell the rows apart.
test("each row's rate field and remove button name their target", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel targets={targets3()} onChange={() => {}} pack={PACK} />
    </LocaleProvider>,
  );
  const i18n = loadI18n("en");
  expect(rateInputs().map((el) => el.getAttribute("aria-label"))).toEqual(
    ["widget", "gadget", "sprocket"].map((name) =>
      i18n.t("targets.rate.forItem", { name }),
    ),
  );
  expect(
    screen
      .getAllByTestId("remove-target")
      .map((el) => el.getAttribute("aria-label")),
  ).toEqual(
    ["widget", "gadget", "sprocket"].map((name) =>
      i18n.t("targets.remove.forItem", { name }),
    ),
  );
});

// An emptied target rate is invalid (a target needs a rate); it is not silently
// ignored like the Inputs panel's empty=Unlimited.
test("empty target rate is treated as invalid on Enter", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(onChange).not.toHaveBeenCalled();
});

// A re-blur without a fresh edit does not re-commit: exactly one solve per edit.
test("blurring again without editing does not emit a second commit", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.blur(input);
  fireEvent.blur(input);
  expect(owner.emissions.length).toBe(1);
});

// An in-flight (uncommitted) rate edit follows the row when the user swaps its
// item, then commits to the new id on blur.
test("uncommitted rate edit follows the row across an item swap", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  fireEvent.change(rateInputs()[0]!, { target: { value: "99" } });
  fireEvent.click(screen.getByLabelText(/item/i));
  pickTile("gadget");
  // The typed text is still shown on the swapped row.
  expect(rateInputs()[0]!.value).toBe("99");
  fireEvent.blur(rateInputs()[0]!);
  expect(owner.latest).toEqual([
    { itemId: "gadget", ratePerSec: { num: "33", denom: "20" } },
  ]);
});

test("an item swap hands focus to the swapped row's trigger", () => {
  // The swap unmounts the row (keys are itemIds), so without the pending-focus
  // token the picker's close refocus falls to the body.
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  fireEvent.click(screen.getByLabelText(/item/i));
  pickTile("gadget");
  // Anchored on the trigger's own label: the row's rate field and remove
  // button now name the item too, so a bare /gadget/ matches three controls.
  const trigger = screen.getByLabelText(/^Item: gadget$/);
  expect(document.activeElement).toBe(trigger);
});

// Confirming the add prompt hands focus to the new row's rate input, so the
// user can keep working on the just-added target without leaving the keyboard.
test("a confirmed add hands focus to the new row's rate input", () => {
  const owner = controlledOwner<Target[]>([]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  pickTile("widget");
  const rate = promptInput()!;
  fireEvent.change(rate, { target: { value: "60" } });
  fireEvent.keyDown(rate, { key: "Enter" });
  // 60/min = 1/1 per sec.
  expect(owner.latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "1", denom: "1" } },
  ]);
  expect(document.activeElement).toBe(rateInputs()[0]!);
});

// Removing a row that has an uncommitted edit must never commit that edit.
test("removing a row with an uncommitted edit does not commit it", () => {
  const owner = controlledOwner<Target[]>(targets3());
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  // Type into row 0 but never blur; then remove it.
  fireEvent.change(rateInputs()[0]!, { target: { value: "999" } });
  fireEvent.click(screen.getAllByTestId("remove-target")[0]!);
  expect(owner.latest.map((t) => t.itemId)).toEqual(["gadget", "sprocket"]);
  // Exactly one emission: the removal. The orphaned edit never commits.
  expect(owner.emissions.length).toBe(1);
});

// Replacing the plan (navigation) remounts the panel via a plan-identity key,
// discarding any uncommitted local edit: the field falls back to the newly
// loaded value rather than showing leftover text.
test("uncommitted edit is discarded when the plan changes", () => {
  function PlanSwapOwner() {
    const [epoch, setEpoch] = useState(0);
    const [t, setT] = useState<Target[]>([
      { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
    ]);
    return (
      <LocaleProvider locale="en">
        <button
          data-testid="navigate"
          onClick={() => {
            setT([{ itemId: "widget", ratePerSec: { num: "1", denom: "1" } }]);
            setEpoch((e) => e + 1);
          }}
        />
        <TargetsPanel key={epoch} targets={t} onChange={() => {}} pack={PACK} />
      </LocaleProvider>
    );
  }
  render(<PlanSwapOwner />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "777" } });
  expect(input.value).toBe("777");
  // Navigate: new plan value is 60/min (1/s), and the stale "777" is dropped.
  fireEvent.click(screen.getByTestId("navigate"));
  expect(rateInputs()[0]!.value).toBe("60");
});

// Real-pack picker gate: only producible items appear. The single non-producible
// real item (domain_key_tundra, produced only by an input-supply recipe) must
// never surface as a tile; a normal producible item does.
test("item picker excludes non-producible items in the real pack", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[
          { itemId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={() => {}}
        pack={realPack}
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByLabelText(/item/i));
  expect(pickerTile("domain_key_tundra")).toBeNull();
  expect(pickerTile("iron_powder")).not.toBeNull();
});

// R4: clicking Add opens the item picker directly and does not touch the plan.
test("clicking Add opens the picker and commits nothing", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel targets={[]} onChange={onChange} pack={PACK} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  expect(screen.queryByRole("dialog")).not.toBeNull();
  expect(pickerTile("widget")).not.toBeNull();
  expect(screen.queryAllByTestId("target-row").length).toBe(0);
  expect(onChange).not.toHaveBeenCalled();
});

// R4/R6: a pick opens the amount prompt naming the picked item; nothing
// commits until a positive rate confirms there.
test("a pick opens the prompt showing the item; confirming commits once", () => {
  const owner = controlledOwner<Target[]>([]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  pickTile("widget");
  // The prompt shows the picked item's name and the plan is still untouched.
  expect(screen.getByRole("dialog").textContent).toContain("widget");
  expect(owner.latest).toEqual([]);
  const rate = promptInput()!;
  fireEvent.change(rate, { target: { value: "30" } });
  fireEvent.keyDown(rate, { key: "Enter" });
  // 30/min = 1/2 per sec.
  expect(owner.latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "1", denom: "2" } },
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getAllByTestId("target-row").length).toBe(1);
});

// R6: empty, zero and unparseable all show the rate.invalid cue inline and
// keep the dialog open; nothing commits until a positive rate is entered.
test("the prompt refuses empty, zero and unparseable rates with the cue", () => {
  const owner = controlledOwner<Target[]>([]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  pickTile("widget");
  const rate = promptInput()!;
  // Empty refuses.
  fireEvent.keyDown(rate, { key: "Enter" });
  expect(owner.latest).toEqual([]);
  expect(rate.getAttribute("aria-invalid")).toBe("true");
  expect(
    screen.getByTestId("rate-prompt-invalid").textContent!.length,
  ).toBeGreaterThan(0);
  // Zero refuses too (typing clears the cue first).
  fireEvent.change(rate, { target: { value: "0" } });
  expect(rate.getAttribute("aria-invalid")).toBeNull();
  fireEvent.keyDown(rate, { key: "Enter" });
  expect(owner.latest).toEqual([]);
  expect(rate.getAttribute("aria-invalid")).toBe("true");
  // Unparseable refuses the same way.
  fireEvent.change(rate, { target: { value: "abc" } });
  expect(rate.getAttribute("aria-invalid")).toBeNull();
  fireEvent.keyDown(rate, { key: "Enter" });
  expect(owner.latest).toEqual([]);
  expect(rate.getAttribute("aria-invalid")).toBe("true");
  // The dialog never closed and nothing ever reached the plan.
  expect(screen.queryByRole("dialog")).not.toBeNull();
  expect(owner.emissions.length).toBe(0);
});

// A target needs a positive rate: a row refuses 0 the way the prompt does, so
// no orphan 0/min card can reach the plan.
test("a target row refuses 0 with the zero message", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(owner.emissions.length).toBe(0);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByTestId("rate-invalid").textContent).toBe(
    "Enter a rate above 0",
  );
});

test("a target row shows distinct messages for non-numeric and negative text", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "abc" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("rate-invalid").textContent).toBe(
    "Enter a number, e.g. 30 or 1/3",
  );
  fireEvent.change(input, { target: { value: "-5" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("rate-invalid").textContent).toBe(
    "A rate cannot be negative",
  );
  expect(owner.emissions.length).toBe(0);
});

test("a target row commits padded text as the trimmed rate", () => {
  const owner = controlledOwner<Target[]>([
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: " 45 " } });
  fireEvent.keyDown(input, { key: "Enter" });
  // 45/min = 3/4 per sec.
  expect(owner.latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "3", denom: "4" } },
  ]);
});

// R7: Escape at the prompt cancels the whole add - nothing committed, and
// focus returns to the Add button that opened the picker.
test("Escape at the prompt commits nothing and refocuses the Add button", () => {
  const owner = controlledOwner<Target[]>([]);
  render(
    owner.element((targets, onChange) => (
      <LocaleProvider locale="en">
        <TargetsPanel targets={targets} onChange={onChange} pack={PACK} />
      </LocaleProvider>
    )),
  );
  const add = screen.getByRole("button", { name: "Add target" });
  fireEvent.click(add);
  pickTile("widget");
  expect(screen.queryByRole("dialog")).not.toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(owner.latest).toEqual([]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(add);
});

// An item another row already uses is offered as a disabled tile in the popup,
// so a duplicate can't be picked and no change commits.
test("an item used by another row is disabled in the picker and does not commit", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[
          { itemId: "widget", ratePerSec: { num: "1", denom: "1" } },
          { itemId: "gadget", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const triggers = screen.getAllByLabelText(/item/i);
  fireEvent.click(triggers[1]!);
  const widgetTile = pickerTile("widget")!;
  expect(widgetTile.disabled).toBe(true);
  fireEvent.click(widgetTile);
  expect(onChange).not.toHaveBeenCalled();
});

// The row's own item stays enabled and highlighted in the picker, so clicking
// it is a confirm: the popup closes with no commit and, unlike a real duplicate,
// no duplicate alert fires (the dup check would otherwise match the row itself).
test("re-picking a row's own item closes without commit or duplicate alert", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "1", denom: "1" } }]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByLabelText(/item/i));
  const ownTile = pickerTile("widget")!;
  expect(ownTile.disabled).toBe(false);
  fireEvent.click(ownTile);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

// The draft picker already dropped itself when its draft vanished; the row
// picker did not, so a row removed by another commit while its popup was open
// left the popup highlighting a tile for a row that no longer exists (and a
// pick there armed a focus token for a commit that can never apply).
test("the row picker closes when its row vanishes from the plan", () => {
  const ui = (targets: Target[]) => (
    <LocaleProvider locale="en">
      <TargetsPanel targets={targets} onChange={vi.fn()} pack={PACK} />
    </LocaleProvider>
  );
  const { rerender } = render(
    ui([{ itemId: "widget", ratePerSec: { num: "1", denom: "1" } }]),
  );
  fireEvent.click(screen.getByLabelText(/item/i));
  expect(screen.queryByRole("dialog")).not.toBeNull();
  rerender(ui([{ itemId: "gadget", ratePerSec: { num: "1", denom: "1" } }]));
  expect(screen.queryByRole("dialog")).toBeNull();
});

// UX-20: the unit-convention subtitle is the only on-screen statement of the
// items-per-minute unit, so it must localize. Under zh it renders the localized
// line, not the English fallback.
test("unit-convention subtitle localizes under zh", () => {
  const { container } = render(
    <LocaleProvider locale="zh">
      <TargetsPanel targets={[]} onChange={vi.fn()} pack={PACK} />
    </LocaleProvider>,
  );
  const sub = container.querySelector(".side-section-sub")?.textContent ?? "";
  expect(sub).toContain("件 / 分钟");
  expect(sub).not.toMatch(/items per minute/);
});

// The empty-target placeholder was a zh-else-English ternary; it now routes
// through the i18n table so ja/ru get their own copy too. Assert the zh string.
test("empty-target placeholder localizes under zh", () => {
  const { container } = render(
    <LocaleProvider locale="zh">
      <TargetsPanel targets={[]} onChange={vi.fn()} pack={PACK} />
    </LocaleProvider>,
  );
  expect(container.querySelector(".b-empty")?.textContent).toBe(
    "未声明任何目标产物 — 点击下方按钮添加",
  );
});

// aria-label overrides a button's content, so a bare "item" made every row's
// trigger announce identically and a screen-reader user could not tell which
// row they were about to open the picker for. Each trigger names its own item.
test("each item trigger is named by its own item", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={targets3().slice(0, 2)}
        onChange={vi.fn()}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  expect(
    screen
      .getAllByLabelText(/^Item:/)
      .map((el) => el.getAttribute("aria-label")),
  ).toEqual(["Item: widget", "Item: gadget"]);
});

// Upstream renames some item icons to opaque hashes, so a row cannot assume the
// item id is also the icon id; it has to resolve the sprite through the pack.
test("a target whose icon id is not its item id still draws its sprite", () => {
  const itemId = "iron_bottle-liquid_plant_grass_1";
  const item = realPack.items.find((i) => i.id === itemId);
  // Premise guard: the assertion below only bites while the shipped pack keeps
  // this icon id apart from its item id.
  expect(item?.icon).toBeDefined();
  expect(item!.icon).not.toBe(itemId);
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId, ratePerSec: { num: "1", denom: "1" } }]}
        onChange={() => {}}
        pack={realPack}
      />
    </LocaleProvider>,
  );
  const slot = screen.getByTestId("target-row").querySelector(".slot");
  expect(slot).not.toBeNull();
  expect(slot!.classList.contains("empty")).toBe(false);
  expect(slot!.querySelector(".ico")).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Off-cohort event items in the picker (#144's T6).

// The shipped pack's v1.5 cohort forced off through the real helper - the same
// map App derives from its stored overrides, so what these tests dim is what a
// flipped settings switch dims.
const V15_OFF = unavailableItems(realPack, {
  eventOverrides: { "v1.5": false },
});

function pickerHintText(): string | null {
  return (
    document.querySelector('[data-testid="picker-hint"]')?.textContent ?? null
  );
}

// Open the add-target picker under the given locale: one click on Add target
// opens the picker directly (R4). unavailableItems undefined models a caller with
// no cohort model at all (the prop's default).
function openAddPicker(
  locale: "en" | "zh",
  unavailableItems?: ReadonlyMap<string, ProducerUnavailableCause>,
) {
  render(
    <LocaleProvider locale={locale}>
      <TargetsPanel
        targets={[]}
        onChange={() => {}}
        pack={realPack}
        unavailableItems={unavailableItems}
      />
    </LocaleProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: locale === "zh" ? "添加目标" : "Add target",
    }),
  );
}

// The cohort token the hint must carry is the same raw string the validation
// error interpolates - that parity is the acceptance, so derive it from the map
// rather than re-typing "v1.5" everywhere.
const firstCause = V15_OFF.values().next().value!;
const COHORT = firstCause.kind === "event" ? firstCause.cohort : "";

test("off-cohort event items render as disabled tiles with the cohort hint (add-target picker)", () => {
  openAddPicker("en", V15_OFF);
  // Every v1.5 item's tile is disabled...
  for (const id of V15_OFF.keys()) {
    expect(pickerTile(id)).not.toBeNull();
    expect(pickerTile(id)!.disabled).toBe(true);
  }
  expect(pickerTile("activity_xiranite_lung")!.disabled).toBe(true);
  // ...while an on-cohort producible item stays pickable.
  expect(pickerTile("iron_powder")!.disabled).toBe(false);
  // The hint is exactly the localized table entry, naming the raw cohort.
  const hint = pickerHintText();
  expect(hint).toBe(loadI18n("en").t("picker.event.off", { cohorts: COHORT }));
  // Parity with the validation message: both carry the same cohort token.
  const validation = loadI18n("en").t("app.error.producer-unavailable.event", {
    itemId: "activity_xiranite_lung",
    cohort: COHORT,
  });
  expect(validation).toContain(COHORT);
  expect(hint).toContain(COHORT);
});

test("the cohort hint localizes under zh with the same token parity", () => {
  openAddPicker("zh", V15_OFF);
  expect(pickerTile("activity_xiranite_lung")!.disabled).toBe(true);
  const hint = pickerHintText();
  expect(hint).toBe(loadI18n("zh").t("picker.event.off", { cohorts: COHORT }));
  expect(hint).not.toBe(
    loadI18n("en").t("picker.event.off", { cohorts: COHORT }),
  );
  const validation = loadI18n("zh").t("app.error.producer-unavailable.event", {
    itemId: "activity_xiranite_lung",
    cohort: COHORT,
  });
  expect(validation).toContain(COHORT);
  expect(hint).toContain(COHORT);
});

// Without the map the panel has no cohort model: every tile is enabled and the
// popup renders no hint line at all (the prop defaults empty).
test("without unavailableItems every event tile stays enabled and no hint renders", () => {
  openAddPicker("en");
  expect(pickerTile("activity_xiranite_lung")!.disabled).toBe(false);
  expect(document.querySelector('[data-testid="picker-hint"]')).toBeNull();
});

// The area's item-level fallout (#124): an item every one of whose producers
// sits outside the selected settlement is dimmed just like an off-cohort one,
// and its hint names the area setting rather than a cohort.
const TUNDRA_ONLY = unavailableItems(realPack, {
  eventOverrides: {},
  area: "tundra",
});

test("items whose producers are all outside the area are dimmed with the area hint", () => {
  openAddPicker("en", TUNDRA_ONLY);
  // liquid_copper is made only in jinlong; iron_powder is made everywhere.
  expect(pickerTile("liquid_copper")!.disabled).toBe(true);
  expect(pickerTile("iron_powder")!.disabled).toBe(false);
  expect(pickerHintText()).toBe(loadI18n("en").t("picker.area.off"));
});

// The row-swap call site unions the same keys, so editing an existing target's
// item dims the off-cohort tiles there too (the row's own item stays enabled
// and highlighted, as before).
test("the row-swap picker also disables off-cohort event items", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[
          { itemId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={() => {}}
        pack={realPack}
        unavailableItems={V15_OFF}
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByLabelText(/^Item:/));
  expect(pickerTile("activity_xiranite_lung")!.disabled).toBe(true);
  expect(pickerTile("copper_bottle")!.disabled).toBe(false);
  expect(pickerHintText()).toContain("v1.5");
});

// A blur revert names why the text was refused: calling a 0 or a -5 "not a
// number" sends the user looking for a typo that is not there.
test("a blur revert of 0, a negative or an over-bound rate names that reason", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]}
        onChange={() => {}}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  const seen: string[] = [];
  for (const text of ["0", "-5", "2000000"]) {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.blur(input);
    expect(input.value).toBe("120");
    seen.push(screen.getByTestId("rate-reverted").textContent!);
  }
  expect(seen).toEqual([
    "Enter a rate above 0; the edit was discarded",
    "A rate cannot be negative; the edit was discarded",
    "A rate cannot exceed 1,000,000/min; the edit was discarded",
  ]);
  expect(seen).not.toContain(loadI18n("en").t("rate.reverted"));
});

test("Enter on an over-bound rate shows the too-large message", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]}
        onChange={onChange}
        pack={PACK}
      />
    </LocaleProvider>,
  );
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "1000000.1" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("rate-invalid").textContent).toBe(
    "A rate cannot exceed 1,000,000/min",
  );
  expect(onChange).not.toHaveBeenCalled();
  // The bound itself commits.
  fireEvent.change(input, { target: { value: "1e6" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onChange).toHaveBeenCalledTimes(1);
  const update = onChange.mock.calls[0]![0] as (t: Target[]) => Target[];
  expect(
    update([{ itemId: "widget", ratePerSec: { num: "2", denom: "1" } }]),
  ).toEqual([{ itemId: "widget", ratePerSec: { num: "50000", denom: "3" } }]);
});

// A tile dimmed because it is already a target gets its own hint sentence,
// joined with the availability sentences by " · " the way InputsPanel joins
// its listed sentence.
function openAddPickerWith(
  targets: Target[],
  unavailable?: ReadonlyMap<string, ProducerUnavailableCause>,
) {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={targets}
        onChange={() => {}}
        pack={realPack}
        unavailableItems={unavailable}
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
}

const IRON_TARGET: Target = {
  itemId: "iron_powder",
  ratePerSec: { num: "1", denom: "1" },
};

test("the add picker hint names an item already a target", () => {
  openAddPickerWith([IRON_TARGET]);
  expect(pickerTile("iron_powder")!.disabled).toBe(true);
  expect(pickerHintText()).toBe(loadI18n("en").t("targets.picker.listed"));
});

test("the already-a-target sentence joins the area sentence with ' · '", () => {
  openAddPickerWith([IRON_TARGET], TUNDRA_ONLY);
  const en = loadI18n("en");
  expect(pickerHintText()).toBe(
    [en.t("targets.picker.listed"), en.t("picker.area.off")].join(" · "),
  );
});

test("the row-swap picker omits the target sentence when no other target is dimmed", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[IRON_TARGET]}
        onChange={() => {}}
        pack={realPack}
        unavailableItems={TUNDRA_ONLY}
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByLabelText(/^Item:/));
  // The row's own item stays enabled, so only the area sentence applies.
  expect(pickerTile("iron_powder")!.disabled).toBe(false);
  expect(pickerHintText()).toBe(loadI18n("en").t("picker.area.off"));
});

test("the row-swap picker names another target that is dimmed", () => {
  render(
    <LocaleProvider locale="en">
      <TargetsPanel
        targets={[
          IRON_TARGET,
          { itemId: "copper_bottle", ratePerSec: { num: "1", denom: "1" } },
        ]}
        onChange={() => {}}
        pack={realPack}
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getAllByLabelText(/^Item:/)[0]!);
  expect(pickerTile("copper_bottle")!.disabled).toBe(true);
  expect(pickerHintText()).toBe(loadI18n("en").t("targets.picker.listed"));
});

test("the already-a-target sentence localizes under zh", () => {
  render(
    <LocaleProvider locale="zh">
      <TargetsPanel
        targets={[IRON_TARGET]}
        onChange={() => {}}
        pack={realPack}
      />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "添加目标" }));
  const zh = loadI18n("zh").t("targets.picker.listed");
  expect(pickerHintText()).toBe(zh);
  expect(zh).not.toBe(loadI18n("en").t("targets.picker.listed"));
});
