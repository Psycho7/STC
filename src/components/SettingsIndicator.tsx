import type { RecipePack } from "@aef/schema";
import {
  eventCohortsOf,
  latestArea,
  type EventCohortOverrides,
} from "../data/availability";
import { useI18n } from "../data/i18n-context";
import { joinList } from "../data/i18n-join";

type Props = {
  pack: RecipePack;
  area: string;
  packCohort: string;
  overrides: EventCohortOverrides;
};

// A compact header note that the plan is being built under non-default
// settings, so a shared link that draws differently here has a visible cause.
// Display only: the settings never ride the plan wire. Renders nothing while
// the area is the latest settlement and every cohort follows its default rule
// (on iff it is the pack's own cohort).
export function SettingsIndicator({
  pack,
  area,
  packCohort,
  overrides,
}: Props) {
  const i18n = useI18n();
  const parts: string[] = [];
  if (area !== latestArea(pack)) parts.push(i18n.displayName(area));

  // Walk the pack's cohorts, not the stored keys: a stale stored cohort the
  // pack no longer carries changes nothing, so it must not show.
  for (const cohort of eventCohortsOf(pack)) {
    const override = overrides[cohort];
    if (override === undefined || override === (cohort === packCohort)) {
      continue;
    }
    parts.push(
      i18n.t(override ? "app.settings.event.on" : "app.settings.event.off", {
        cohort,
      }),
    );
  }

  if (parts.length === 0) return null;
  return (
    <span className="stat-chip" data-testid="settings-indicator">
      {joinList(i18n.locale, parts)}
    </span>
  );
}
