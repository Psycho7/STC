// VENDOR PATCH: dropped primeng SelectItem and beacon/module-settings imports
// (those settings files use the trimmed helpers and are never read by the
// solver). The option/module/beacon fields are kept as `unknown[]` placeholders
// so the Step/Objective type shape is preserved without dragging the deps.
import { Rational } from '../rational';

export interface RecipeState {
  machineId?: string;
  fuelId?: string;
  modules?: unknown[];
  beacons?: unknown[];
  overclock?: Rational;
  cost?: Rational;
  productivity?: Rational;
}

export interface RecipeSettings extends RecipeState {
  defaultMachineId?: string;
  defaultFuelId?: string;
  machineOptions?: unknown[];
  fuelOptions?: unknown[];
  moduleOptions?: unknown[];
  defaultOverclock?: Rational;
}
