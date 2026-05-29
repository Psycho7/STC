import type { Plan } from "../data/plan";

type StatsStripProps = {
  plan: Plan;
};

export default function StatsStrip({ plan }: StatsStripProps) {
  const targetCount = plan.targets.length;
  const supplyCount = plan.itemOverrides?.length ?? 0;

  return (
    <div className="canvas-strip" data-testid="stats-strip">
      <div className="strip-stat">
        <div className="lbl">输出</div>
        <div className="val">
          {targetCount}
          <span className="unit">target</span>
        </div>
      </div>
      <div className="sep" />
      <div className="strip-stat">
        <div className="lbl">输入</div>
        <div className="val">
          {supplyCount}
          <span className="unit">supply</span>
        </div>
      </div>
    </div>
  );
}
