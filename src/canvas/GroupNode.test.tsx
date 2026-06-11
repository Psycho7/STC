// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import type { ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import GroupNode, { groupCaption } from "./GroupNode";

afterEach(cleanup);

test("groupCaption prefers an explicit label", () => {
  expect(groupCaption({ label: "My Group", containerId: "loop:scc-1" })).toBe(
    "My Group",
  );
});

test("groupCaption derives a caption from containerId, stripping loop: prefix", () => {
  expect(groupCaption({ containerId: "loop:scc-1" })).toBe("scc-1");
});

test("groupCaption leaves a non-loop containerId intact", () => {
  expect(groupCaption({ containerId: "scc-1" })).toBe("scc-1");
});

test("groupCaption returns empty when neither label nor containerId is present", () => {
  expect(groupCaption({})).toBe("");
});

// The render pipeline supplies { containerKind, containerId } and no label;
// the box must still caption (regression: it rendered captionless).
test("GroupNode renders a caption for pipeline container data", () => {
  const props = {
    data: { containerKind: "loop-box", containerId: "loop:scc-1" },
  } as unknown as ComponentProps<typeof GroupNode>;
  const { container } = render(<GroupNode {...props} />);
  expect(container.textContent).toContain("scc-1");
});
