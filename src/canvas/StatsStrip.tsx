import type { Plan } from "../data/plan";
import { useI18n } from "../data/i18n-context";

type StatsStripProps = {
  plan: Plan;
};

export default function StatsStrip({ plan }: StatsStripProps) {
  const i18n = useI18n();
  const targetCount = plan.targets.length;
  const supplyCount = plan.itemOverrides?.length ?? 0;

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
