// The loop caption on its band of the paint. It follows the canvas's one
// elision rule: a caption too long for the band keeps its longest head that
// fits and ends with an ellipsis, and the full caption rides the hover title.

import { elideName } from "./elide";
import { useFontMetrics, widthFnFor, type MeasuredFont } from "./measureText";
import type { Rect } from "./nodeGeometry";

// The .loop-caption rule in canvas.css: 11px mono, bold, 0.18em tracking,
// 10px of padding on either side.
const LOOP_CAPTION_FONT: MeasuredFont = {
  family: "--font-mono",
  fontSize: 11,
  weight: 700,
  letterSpacingEm: 0.18,
};
const LOOP_CAPTION_PAD_X = 10;

const captionWidth = widthFnFor(LOOP_CAPTION_FONT);

export default function LoopCaption({
  band,
  text,
}: {
  band: Rect;
  text: string;
}) {
  // Re-elide when a late face changes the metrics.
  useFontMetrics();
  const width = band.right - band.left;
  // The band draws the caption uppercase, so it is measured uppercase.
  const shown = elideName(
    text.toUpperCase(),
    width - 2 * LOOP_CAPTION_PAD_X,
    captionWidth,
    "loop-caption",
  );
  return (
    <div
      className="loop-caption"
      data-testid="loop-caption"
      title={text}
      style={{
        transform: `translate(${band.left}px, ${band.top}px)`,
        width,
        height: band.bottom - band.top,
        lineHeight: `${band.bottom - band.top}px`,
      }}
    >
      {shown}
    </div>
  );
}
