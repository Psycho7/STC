// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LocaleProvider, useLocale } from "./i18n-context";

afterEach(cleanup);

// A tiny consumer that flips the locale so we can assert document.lang tracks
// the change, not just the initial mount.
function Switcher() {
  const { setLocale } = useLocale();
  return (
    <button onClick={() => setLocale("ja")} data-testid="to-ja">
      ja
    </button>
  );
}

test("document lang matches the initial locale", () => {
  render(
    <LocaleProvider locale="zh">
      <div />
    </LocaleProvider>,
  );
  expect(document.documentElement.lang).toBe("zh");
});

test("document lang follows a locale change", () => {
  render(
    <LocaleProvider locale="en">
      <Switcher />
    </LocaleProvider>,
  );
  expect(document.documentElement.lang).toBe("en");
  fireEvent.click(screen.getByTestId("to-ja"));
  expect(document.documentElement.lang).toBe("ja");
});
