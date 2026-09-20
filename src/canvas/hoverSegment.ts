import { createContext, useContext } from "react";

// Which SEGMENT of an edge the pointer stands on, reported by the edge
// components to the canvas that owns the hover state.
//
// React Flow gives the canvas one hover per EDGE (onEdgeMouseEnter on the
// <ReactFlow> element), and an edge's whole polyline is one hit target, so the
// wrapper alone cannot say whether the pointer is on the stretch a trunk shares
// or on the member's own branch leg. Pointer arithmetic cannot answer it either:
// the enter React synthesizes carries no usable coordinates in jsdom, and
// screenToFlowPosition is a viewport read the hover path has no business doing
// per pointer frame. So the split is in the DOM instead -- one transparent
// interaction path per shared stretch (see sharedStretches) -- and this context
// is the narrow seam it reports through. `enter` names the trunk the pointer is
// on; `leave` says the pointer is still on the edge but no longer on that
// stretch, which is branch mode. The edge's own enter/leave keep working
// unchanged: this only refines WHICH part of it is under the pointer.
export type SegmentHover = {
  enter(edgeId: string, group: string): void;
  leave(edgeId: string): void;
};

// A canvas-less render (an edge component mounted directly by a test) reports
// into the void rather than requiring every caller to wrap a provider.
const INERT: SegmentHover = {
  enter: () => {},
  leave: () => {},
};

export const SegmentHoverContext = createContext<SegmentHover>(INERT);

export function useSegmentHover(): SegmentHover {
  return useContext(SegmentHoverContext);
}
