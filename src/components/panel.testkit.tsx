// Shared harness for the TargetsPanel / InputsPanel suites, colocated under
// src/components and borrowed under test/components. Both panels are
// controlled: they never hold their committed list, they hand their owner a
// functional updater. Every behavioural assertion therefore needs a real owner
// that applies the updater and re-renders, which is what controlledOwner is.
// Queries here are locale-neutral (roles and data attributes only), so each
// suite keeps pinning its own locale.

import { useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { screen } from "@testing-library/react";

/** What a panel hands its owner: the next list, derived from the current one. */
export type PanelUpdater<T> = (current: T) => T;

/** Renders the panel under test with the owner's current value and onChange. */
export type PanelView<T> = (
  value: T,
  onChange: (update: PanelUpdater<T>) => void,
) => ReactNode;

export interface ControlledOwner<T> {
  /** The value as the owner last committed it; readable after a gesture. */
  readonly latest: T;
  /**
   * One entry per committed change, in order. An updater that returns its
   * input unchanged is a no-op and is not logged, which is what lets a test
   * assert "exactly one commit per edit".
   */
  readonly emissions: readonly T[];
  /** The element to render: an owner component wrapped around the view. */
  element(view: PanelView<T>): ReactElement;
}

export function controlledOwner<T>(initial: T): ControlledOwner<T> {
  let latest = initial;
  const emissions: T[] = [];

  function Owner({ view }: { view: PanelView<T> }) {
    const [value, setValue] = useState(latest);
    return (
      <>
        {view(value, (update) => {
          const next = update(latest);
          if (next === latest) return;
          emissions.push(next);
          latest = next;
          setValue(next);
        })}
      </>
    );
  }

  return {
    get latest() {
      return latest;
    },
    emissions,
    element(view) {
      return <Owner view={view} />;
    },
  };
}

/** Every rate field in the panel, in document order. */
export function rateInputs(): HTMLInputElement[] {
  return screen
    .getAllByRole("textbox")
    .filter((el) => el instanceof HTMLInputElement) as HTMLInputElement[];
}

// data-item-id appears on picker tiles, on auto-rows and on override rows, and
// the popup portals to document.body alongside the Testing Library container,
// so a bare [data-item-id] query can resolve to a row instead of a tile.
export function pickerTile(itemId: string): HTMLButtonElement | null {
  return document.querySelector(
    `[data-testid="picker-tile"][data-item-id="${itemId}"]`,
  );
}
