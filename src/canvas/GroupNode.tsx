import type { NodeProps, Node } from "@xyflow/react";

type GroupNodeData = { label: string };
type GroupNodeType = Node<GroupNodeData, "group">;

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
        {data.label}
      </div>
    </div>
  );
}
