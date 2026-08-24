// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { RecipePack } from "@aef/schema";
import { pack as realPack } from "../data/load";
import { TargetsPanel } from "./TargetsPanel";
import { LocaleProvider } from "../data/i18n-context";
import type { Target } from "../data/targets";

afterEach(cleanup);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const PACK = {
  items: [
    { id: "widget", icon: "widget" },
    { id: "gadget", icon: "gadget" },
    { id: "sprocket", icon: "sprocket" },
  ],
  recipes: [
    {
      id: "r_widget",
      category: "craft",
      in: [],
      out: [{ item: "widget", qty: 1 }],
      time: 1,
      producers: [],
      cost: 1,
    },
    {
      id: "r_gadget",
      category: "craft",
      in: [],
      out: [{ item: "gadget", qty: 1 }],
      time: 1,
      producers: [],
      cost: 1,
    },
    {
      id: "r_sprocket",
      category: "craft",
      in: [],
      out: [{ item: "sprocket", qty: 1 }],
      time: 1,
      producers: [],
      cost: 1,
    },
  ],
} as unknown as RecipePack;

function targets3(): Target[] {
  return [
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } }, // 120/min
    { itemId: "gadget", ratePerSec: { num: "1", denom: "2" } }, // 30/min
    { itemId: "sprocket", ratePerSec: { num: "1", denom: "4" } }, // 15/min
  ];
}

function rateInputs(): HTMLInputElement[] {
  return screen
    .getAllByRole("textbox")
    .filter((el) => el instanceof HTMLInputElement) as HTMLInputElement[];
}

// The item picker is a portal-rendered popup; tiles carry data-item-id.
function pickerTile(itemId: string): HTMLButtonElement | null {
  return document.querySelector(`[data-item-id="${itemId}"]`);
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
  let latest: Target[] = [
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ];
  const emissions: Target[][] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            const next = update(latest);
            if (next === latest) return;
            emissions.push(next);
            latest = next;
            setT(next);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.blur(input);
  expect(emissions.length).toBe(1);
  // 99/min = 33/20 per sec.
  expect(latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "33", denom: "20" } },
  ]);
});

test("Enter commits the parsed value", () => {
  let latest: Target[] = [
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            latest = update(latest);
            setT(latest);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "45" } });
  fireEvent.keyDown(input, { key: "Enter" });
  // 45/min = 3/4 per sec.
  expect(latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "3", denom: "4" } },
  ]);
});

// The committed text is kept verbatim on Enter: a valid "1/3" is not
// re-serialized into a 16-digit float, and an invalid in-progress "1/" survives
// an Enter (with the invalid cue) so the user can keep typing.
test("Enter keeps invalid text with an invalid cue; a valid rational commits and keeps its text", () => {
  let latest: Target[] = [
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ];
  const emissions: Target[][] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            const next = update(latest);
            if (next === latest) return;
            emissions.push(next);
            latest = next;
            setT(next);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "1/" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("1/");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(emissions.length).toBe(0);
  fireEvent.change(input, { target: { value: "1/3" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(emissions.length).toBe(1);
  // 1/3 per min = 1/180 per sec.
  expect(latest).toEqual([
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
  let latest: Target[] = [
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ];
  const emissions: Target[][] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            const next = update(latest);
            if (next === latest) return;
            emissions.push(next);
            latest = next;
            setT(next);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  const input = rateInputs()[0]!;
  fireEvent.change(input, { target: { value: "99" } });
  fireEvent.blur(input);
  fireEvent.blur(input);
  expect(emissions.length).toBe(1);
});

// An in-flight (uncommitted) rate edit follows the row when the user swaps its
// item, then commits to the new id on blur.
test("uncommitted rate edit follows the row across an item swap", () => {
  let latest: Target[] = [
    { itemId: "widget", ratePerSec: { num: "2", denom: "1" } },
  ];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            latest = update(latest);
            setT(latest);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  fireEvent.change(rateInputs()[0]!, { target: { value: "99" } });
  fireEvent.click(screen.getByLabelText(/item/i));
  pickTile("gadget");
  // The typed text is still shown on the swapped row.
  expect(rateInputs()[0]!.value).toBe("99");
  fireEvent.blur(rateInputs()[0]!);
  expect(latest).toEqual([
    { itemId: "gadget", ratePerSec: { num: "33", denom: "20" } },
  ]);
});

// Removing a row that has an uncommitted edit must never commit that edit.
test("removing a row with an uncommitted edit does not commit it", () => {
  let latest: Target[] = targets3();
  const emissions: Target[][] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            const next = update(latest);
            if (next === latest) return;
            emissions.push(next);
            latest = next;
            setT(next);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  // Type into row 0 but never blur; then remove it.
  fireEvent.change(rateInputs()[0]!, { target: { value: "999" } });
  fireEvent.click(screen.getAllByTestId("remove-target")[0]!);
  expect(latest.map((t) => t.itemId)).toEqual(["gadget", "sprocket"]);
  // Exactly one emission: the removal. The orphaned edit never commits.
  expect(emissions.length).toBe(1);
});

// Replacing the plan (navigation) remounts the panel via a plan-identity key,
// discarding any uncommitted local edit: the field falls back to the newly
// loaded value rather than showing leftover text.
test("uncommitted edit is discarded when the plan changes", () => {
  function Parent() {
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
  render(<Parent />);
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

// D4: clicking Add creates a local draft row and does not touch the plan.
test("clicking Add creates a draft row without committing", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel targets={[]} onChange={onChange} pack={PACK} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  expect(screen.getAllByTestId("target-draft-row").length).toBe(1);
  expect(screen.queryAllByTestId("target-row").length).toBe(0);
  expect(onChange).not.toHaveBeenCalled();
  // The draft item trigger shows the "choose an item" placeholder.
  const draftRow = screen.getByTestId("target-draft-row");
  const trigger = within(draftRow).getByLabelText(/item/i);
  expect(trigger.textContent).toBe("Choose an item...");
});

// D4: a draft commits exactly once, when it has both an item and a nonzero
// rate, and the draft row is then replaced by a committed target row.
test("a draft commits once an item and a nonzero rate are set", () => {
  let latest: Target[] = [];
  function Parent() {
    const [t, setT] = useState(latest);
    return (
      <LocaleProvider locale="en">
        <TargetsPanel
          targets={t}
          onChange={(update) => {
            latest = update(latest);
            setT(latest);
          }}
          pack={PACK}
        />
      </LocaleProvider>
    );
  }
  render(<Parent />);
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  fireEvent.click(
    within(screen.getByTestId("target-draft-row")).getByLabelText(/item/i),
  );
  pickTile("widget");
  // An item alone does not commit.
  expect(latest.length).toBe(0);
  const rate = within(screen.getByTestId("target-draft-row")).getByLabelText(
    /rate/i,
  );
  fireEvent.change(rate, { target: { value: "60" } });
  fireEvent.blur(rate);
  // 60/min = 1/1 per sec.
  expect(latest).toEqual([
    { itemId: "widget", ratePerSec: { num: "1", denom: "1" } },
  ]);
  expect(screen.queryAllByTestId("target-draft-row").length).toBe(0);
  expect(screen.getAllByTestId("target-row").length).toBe(1);
});

// A draft with an item but a zero rate contributes nothing, so it must not
// commit or churn a re-solve.
test("a draft with an item but a zero rate does not commit", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel targets={[]} onChange={onChange} pack={PACK} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  fireEvent.click(
    within(screen.getByTestId("target-draft-row")).getByLabelText(/item/i),
  );
  pickTile("widget");
  const rate = within(screen.getByTestId("target-draft-row")).getByLabelText(
    /rate/i,
  );
  fireEvent.change(rate, { target: { value: "0" } });
  fireEvent.blur(rate);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getAllByTestId("target-draft-row").length).toBe(1);
});

// Removing a draft is a purely local action: the plan is never touched.
test("removing a draft never touches the plan", () => {
  const onChange = vi.fn();
  render(
    <LocaleProvider locale="en">
      <TargetsPanel targets={[]} onChange={onChange} pack={PACK} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  fireEvent.click(screen.getByTestId("remove-draft"));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryAllByTestId("target-draft-row").length).toBe(0);
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
// row they were about to open the picker for. Each trigger names its own item;
// an empty draft keeps the call to action, since it has no item to name.
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
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  const draftRow = screen.getByTestId("target-draft-row");
  expect(within(draftRow).getByLabelText("Choose an item...").tagName).toBe(
    "BUTTON",
  );
});
