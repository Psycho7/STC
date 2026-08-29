import { useI18n } from "../data/i18n-context";

type Props = {
  enabled: boolean;
  onToggle: () => void;
};

// Topbar chip-button that switches bus-lane routing on and off. The state
// lives in AppInner (it feeds layoutRenderPlan), so this is a controlled
// control like the panels, not a context reader like LocaleSwitcher.
export function BusLanesToggle({ enabled, onToggle }: Props) {
  const i18n = useI18n();
  return (
    <button
      type="button"
      data-testid="bus-lanes-toggle"
      className={"stat-chip bus-lanes-toggle" + (enabled ? " on" : "")}
      aria-pressed={enabled}
      onClick={onToggle}
    >
      {i18n.t("app.busLanes.label")}
    </button>
  );
}
