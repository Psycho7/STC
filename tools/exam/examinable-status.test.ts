// Which canvas statuses make a page examinable: the capture and probe CLIs
// wait for the bottom-right annotation to show one of these before they shoot
// or measure. A SHORTFALL plan is a drawn plan - the exam tooling exists to
// look at exactly those - so it is as examinable as a READY one, while
// SOLVING and ERROR have no graph to examine.
import { describe, expect, it } from "vitest";
import { EXAMINABLE_STATUS_PATTERN } from "../../test/e2e/viewport";

describe("EXAMINABLE_STATUS_PATTERN", () => {
  it("accepts both drawn-plan annotations", () => {
    expect("STATUS · READY").toMatch(EXAMINABLE_STATUS_PATTERN);
    expect("STATUS · SHORTFALL").toMatch(EXAMINABLE_STATUS_PATTERN);
  });

  it("rejects the statuses with no drawn graph", () => {
    expect("STATUS · SOLVING").not.toMatch(EXAMINABLE_STATUS_PATTERN);
    expect("STATUS · ERROR").not.toMatch(EXAMINABLE_STATUS_PATTERN);
  });
});
