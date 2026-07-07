import type { Plan } from "../data/plan";
import { useI18n } from "../data/i18n-context";
import { displayedInputCount } from "../components/InputsPanel";

type StatsStripProps = {
  plan: Plan;
  assumedRawItemIds?: ReadonlyArray<string>;
};

export default function StatsStrip({
  plan,
  assumedRawItemIds,
}: StatsStripProps) {
  const i18n = useI18n();
  const targetCount = plan.targets.length;
  const supplyCount = displayedInputCount(
    plan.itemOverrides ?? [],
    assumedRawItemIds,
  );

  return (
    <div className="canvas-strip" data-testid="stats-strip">
      <div className="strip-stat">
        <div className="lbl">{i18n.t("stats.output")}</div>
        <div className="val">
          {targetCount}
          <span className="unit">{i18n.t("stats.output.unit")}</span>
        </div>
      </div>
      <div className="sep" />
      <div className="strip-stat">
        <div className="lbl">{i18n.t("stats.input")}</div>
        <div className="val">
          {supplyCount}
          <span className="unit">{i18n.t("stats.input.unit")}</span>
        </div>
      </div>
    </div>
  );
}
