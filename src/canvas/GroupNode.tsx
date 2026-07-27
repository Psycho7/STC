import type { NodeProps, Node } from "@xyflow/react";
import { useI18n } from "../data/i18n-context";

// The render pipeline emits container group nodes with { containerKind,
// containerId, memberCount, titleItems } and no label (see
// fromElkRenderLayout). Older call sites may still pass a plain { label }.
// Accept all and caption from whichever is present.
type GroupNodeData = {
  label?: string;
  containerKind?: string;
  containerId?: string;
  memberCount?: number;
  titleItems?: string[];
};
type GroupNodeType = Node<GroupNodeData, "group">;

// Caption for a group box: an explicit label wins; otherwise name the loop by
// the items its members make, so two loops of the same size read differently.
// A member count alone is the fallback when no item resolves. Fall back to the
// containerId (stripping the mechanical "loop:" prefix) when neither is present,
// and return "" when nothing identifying exists so the caption renders empty
// rather than "undefined".
export function groupCaption(
  data: GroupNodeData,
  displayName: (id: string) => string = (id) => id,
): string {
  if (data.label !== undefined && data.label !== "") return data.label;
  const items = data.titleItems;
  if (items !== undefined && items.length > 0) {
    return `LOOP · ${items.map(displayName).join(" · ")}`;
  }
  if (data.memberCount !== undefined) return `LOOP · ${data.memberCount}`;
  const id = data.containerId;
  if (id === undefined || id === "") return "";
  return id.replace(/^loop:/, "");
}

export default function GroupNode({ data }: NodeProps<GroupNodeType>) {
  const i18n = useI18n();
  // Item names resolve here rather than at layout time, so switching locale
  // repaints the caption without a relayout.
  const caption = groupCaption(data, (id) => i18n.displayName(id));
  return (
    <div className="rf-group-box">
      {/* The caption ellipsizes; the title keeps the full list hoverable. */}
      <div className="rf-group-caption" title={caption}>
        {caption}
      </div>
    </div>
  );
}
