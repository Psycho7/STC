import { ControlButton } from "@xyflow/react";

// The Controls "fit view" button, rebuilt so it can run the canvas's own
// content fit. The vendor button calls React Flow's fitView (node cards only)
// before any onFitView callback, so Canvas switches it off with
// showFitView={false} and renders this one in its place. It keeps the vendor
// class, so the vendor and canvas.css button rules still reach it, and the
// vendor icon path.
export default function FitViewButton({
  label,
  onFit,
}: {
  label: string;
  onFit: () => void;
}) {
  return (
    <ControlButton
      className="react-flow__controls-fitview"
      onClick={onFit}
      title={label}
      aria-label={label}
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30">
        <path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" />
      </svg>
    </ControlButton>
  );
}
