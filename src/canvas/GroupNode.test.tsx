// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import GroupNode, { groupCaption } from "./GroupNode";

afterEach(cleanup);

test("groupCaption prefers an explicit label", () => {
  expect(
    groupCaption({ label: "My Group", containerId: "loop:scc-1", memberCount: 3 }),
  ).toBe("My Group");
});

test("groupCaption renders a human LOOP caption from the member count", () => {
  expect(groupCaption({ containerId: "loop:scc-1", memberCount: 3 })).toBe(
    "LOOP · 3",
  );
});

test("groupCaption falls back to the containerId when no member count is present", () => {
  expect(groupCaption({ containerId: "loop:scc-1" })).toBe("scc-1");
});

test("groupCaption returns empty when nothing identifying is present", () => {
  expect(groupCaption({})).toBe("");
});

// The render pipeline supplies { containerKind, containerId, memberCount } and
// no label; the box must caption with the human LOOP label, not the raw id.
test("GroupNode renders a human caption for pipeline container data", () => {
  const props = {
    data: {
      containerKind: "loop-box",
      containerId: "loop:scc-1",
      memberCount: 4,
    },
  } as unknown as ComponentProps<typeof GroupNode>;
  const { container } = render(<GroupNode {...props} />);
  expect(container.textContent).toContain("LOOP · 4");
});

// Theming is CSS-driven: the caption carries a class rather than inline
// light-theme styles.
test("GroupNode caption carries a class and no inline color", () => {
  const props = {
    data: { containerKind: "loop-box", containerId: "loop:scc-1", memberCount: 2 },
  } as unknown as ComponentProps<typeof GroupNode>;
  const { container } = render(<GroupNode {...props} />);
  const caption = container.querySelector(".rf-group-caption");
  expect(caption).not.toBeNull();
  expect((caption as HTMLElement).style.color).toBe("");
});
