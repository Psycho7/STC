import type { NodeProps, Node } from "@xyflow/react";

// The render pipeline emits container group nodes with { containerKind,
// containerId } and no label (see fromElkRenderLayout). Older call sites may
// still pass a plain { label }. Accept both and caption from whichever is
// present.
type GroupNodeData = {
  label?: string;
  containerKind?: string;
  containerId?: string;
};
type GroupNodeType = Node<GroupNodeData, "group">;

// Caption for a group box: an explicit label wins; otherwise derive a readable
// caption from the containerId, stripping the mechanical "loop:" prefix the
// clustering policy attaches to loop-box ids. Returns "" when neither is present
// so the caption span renders empty rather than "undefined".
export function groupCaption(data: GroupNodeData): string {
  if (data.label !== undefined && data.label !== "") return data.label;
  const id = data.containerId;
  if (id === undefined || id === "") return "";
  return id.replace(/^loop:/, "");
}

export default function GroupNode({ data }: NodeProps<GroupNodeType>) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        border: "1px dashed #888",
        background: "rgba(0, 0, 0, 0.02)",
        borderRadius: 6,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 4,
          left: 8,
          fontSize: 11,
          color: "#666",
          letterSpacing: 0.5,
          textTransform: "uppercase",
        }}
      >
        {groupCaption(data)}
      </div>
    </div>
  );
}
