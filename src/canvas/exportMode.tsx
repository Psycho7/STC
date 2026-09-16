import { createContext, useContext, type ReactNode } from "react";
import { useStore } from "@xyflow/react";

// True only for the render pass that the PNG capture rasterizes. Every
// zoom-dependent level-of-detail gate reads it and pretends the zoom is 1, so
// the exported image carries full detail no matter where the live camera sits.
// Default false, so an edge rendered outside the provider behaves normally.
const ExportModeContext = createContext(false);

export function ExportModeProvider({
  exporting,
  children,
}: {
  exporting: boolean;
  children: ReactNode;
}) {
  return (
    <ExportModeContext.Provider value={exporting}>
      {children}
    </ExportModeContext.Provider>
  );
}

export function useExportMode(): boolean {
  return useContext(ExportModeContext);
}

// The zoom every level-of-detail gate should read: the live camera zoom, or 1
// while the PNG capture is rasterizing.
export function useEffectiveZoom(): number {
  const liveZoom = useStore((state) => state.transform[2]);
  return useExportMode() ? 1 : liveZoom;
}
