// The camera handle the render-quality exam drives, declared once.
//
// The app installs it on `window` under `?exam=1` and the exam CLIs reach it
// through the page, not through a module import, so nothing ties the two sides
// together at compile time except this file. It was previously hand-copied into
// the app component and into each CLI, which is three chances for a contract to
// drift silently: a driver that types a method the page stopped installing gets
// no error until the run.
//
// A leaf on purpose. It declares types and nothing else, so a CLI can name the
// contract without loading the canvas module graph.
export type ExamHook = {
  setViewport(v: { x: number; y: number; zoom: number }): void;
  fitView(): void;
  contentBounds(): {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  chipReservations(): Array<{
    testId: string;
    body: string;
    unit: boolean;
    reservedPx: number;
  }>;
  // The inter-layer gap reserves of the laid-out plan, in absolute graph x: the
  // chip zone beside each side's ports and the trunk-column zone between them.
  // A trunk chip is placed inside one of these, and no DOM reading can rebuild
  // them, so the browser-side geometry audit gets them from here. Structural
  // shape rather than layerModel's GapRecord: this file is a leaf on purpose
  // (see above) and must not pull the canvas module graph in behind it.
  gapZones(): Array<{
    index: number;
    left: number;
    right: number;
    sourceZone: { left: number; right: number };
    columnZone: { left: number; right: number };
    targetZone: { left: number; right: number };
  }>;
  // Provenance of the build being driven, so a capture is stamped with what it
  // actually photographed. The exam defaults to a deployed preview, and deploy
  // lag would otherwise make an older build indistinguishable from the tip once
  // the images are on disk. Values, not getters: neither can change while the
  // page is loaded.
  //
  // Required here because every build that installs the hook installs these too.
  // A deployment old enough to omit them is still possible, which is why the
  // capture validates the pair at runtime instead of trusting this type.
  commit: string;
  pack: { sourceCommit: string; gameVersion: string };
};

declare global {
  interface Window {
    __stcExam?: ExamHook;
  }
}
