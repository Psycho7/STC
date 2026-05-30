import "@testing-library/jest-dom/vitest";

// React Flow only renders edges once it knows source/target node dimensions.
// In a browser, that comes from a ResizeObserver. jsdom has no real layout, so
// we fire a non-zero ResizeObserverEntry on observe(); without this, all nodes
// stay at 0x0 and the edge layer renders empty.
//
// The callback must be deferred via queueMicrotask: React Flow's node-observer
// hook calls observe() inside a child useEffect, while `state.domNode` (which
// `updateNodeInternals` requires) is set by ZoomPane's parent useEffect. React
// runs child effects first, so a synchronous observe-callback hits an empty
// domNode and the dimensions update is silently dropped. Microtask deferral
// lets the parent effect run and populate domNode before the callback fires.
class ResizeObserverMock {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element): void {
    const entry = {
      target,
      contentRect: {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 150,
        bottom: 80,
        width: 150,
        height: 80,
      } as DOMRectReadOnly,
      borderBoxSize: [
        { inlineSize: 150, blockSize: 80 },
      ] as ReadonlyArray<ResizeObserverSize>,
      contentBoxSize: [
        { inlineSize: 150, blockSize: 80 },
      ] as ReadonlyArray<ResizeObserverSize>,
      devicePixelContentBoxSize: [
        { inlineSize: 150, blockSize: 80 },
      ] as ReadonlyArray<ResizeObserverSize>,
    } as ResizeObserverEntry;
    queueMicrotask(() =>
      this.callback([entry], this as unknown as ResizeObserver),
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

class DOMMatrixReadOnlyMock {
  m11 = 1;
  m22 = 1;
  constructor(transform?: string) {
    if (typeof transform === "string") {
      const match = transform.match(/scale\(([\d.]+)\)/);
      if (match && match[1]) {
        const scale = parseFloat(match[1]);
        this.m11 = scale;
        this.m22 = scale;
      }
    }
  }
}

(
  globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }
).ResizeObserver = ResizeObserverMock;
(
  globalThis as unknown as { DOMMatrixReadOnly: typeof DOMMatrixReadOnlyMock }
).DOMMatrixReadOnly = DOMMatrixReadOnlyMock;

// jsdom returns an all-zero DOMRect by default, which makes React Flow skip
// rendering edges (the pane viewport is treated as zero-size). Stub a non-zero
// rect so React Flow's edge renderer mounts edges in tests.
Element.prototype.getBoundingClientRect = function (): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1024,
    bottom: 768,
    width: 1024,
    height: 768,
    toJSON() {
      return this;
    },
  } as DOMRect;
};

// React Flow measures node sizes via `element.offsetWidth` / `offsetHeight`
// inside its ResizeObserver callback (see @xyflow/system getDimensions). jsdom
// always returns 0 for these without real layout, so React Flow records every
// node as 0x0 and refuses to render edges (nodeHasDimensions === false).
// Stub non-zero values so edges mount.
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get() {
    return 150;
  },
});
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get() {
    return 80;
  },
});
