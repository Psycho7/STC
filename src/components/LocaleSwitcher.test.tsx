// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocaleProvider } from "../data/i18n-context";
import { LocaleSwitcher } from "./LocaleSwitcher";

afterEach(cleanup);

test("offers only the locales the web UI ships", () => {
  render(
    <LocaleProvider locale="zh">
      <LocaleSwitcher />
    </LocaleProvider>,
  );
  const options = Array.from(
    screen.getByTestId("locale-switcher").querySelectorAll("option"),
  );
  expect(options.map((o) => o.value)).toEqual(["zh", "en"]);
  expect(options.map((o) => o.textContent)).toEqual(["中文", "English"]);
});
