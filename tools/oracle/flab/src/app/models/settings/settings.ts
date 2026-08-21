import { MaximizeType } from '../enum/maximize-type';
import { CostSettings } from './cost-settings';

// VENDOR PATCH: upstream `Settings extends SettingsState` (from ~/store/settings.service,
// a 1035 LOC Angular store) which drags the whole store graph through tsc. Severed to the
// minimal resolved field shape the simplex solver actually reads.
export interface Settings {
  excludedItemIds: Set<string>;
  maximizeType: MaximizeType;
  requireMachinesOutput: boolean;
  costs: CostSettings;
}
