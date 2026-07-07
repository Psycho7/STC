import type { NodeProps, Node } from "@xyflow/react";

// The render pipeline emits container group nodes with { containerKind,
// containerId, memberCount } and no label (see fromElkRenderLayout). Older call
// sites may still pass a plain { label }. Accept all and caption from whichever
// is present.
type GroupNodeData = {
  label?: string;
  containerKind?: string;
  containerId?: string;
  memberCount?: number;
};
type GroupNodeType = Node<GroupNodeData, "group">;

// Caption for a group box: an explicit label wins; otherwise show a human loop
// caption of the form "LOOP - N" from the member count. Fall back to the
// containerId (stripping the mechanical "loop:" prefix) when neither is present,
// and return "" when nothing identifying exists so the caption renders empty
// rather than "undefined".
export function groupCaption(data: GroupNodeData): string {
  if (data.label !== undefined && data.label !== "") return data.label;
  if (data.memberCount !== undefined) return `LOOP · ${data.memberCount}`;
  const id = data.containerId;
  if (id === undefined || id === "") return "";
  return id.replace(/^loop:/, "");
}

export default function GroupNode({ data }: NodeProps<GroupNodeType>) {
  return (
    <div className="rf-group-box">
      <div className="rf-group-caption">{groupCaption(data)}</div>
    </div>
  );
}
