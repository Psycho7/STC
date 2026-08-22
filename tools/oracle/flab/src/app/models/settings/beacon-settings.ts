// VENDOR PATCH: dropped areBeaconSettingsEqual (used the trimmed-out
// areArraysEqual helper and is never called by the solver). Kept the type only.
import { Rational } from '../rational';
import { ModuleSettings } from './module-settings';

export interface BeaconSettings {
  count?: Rational;
  id?: string;
  modules?: ModuleSettings[];
  total?: Rational;
}
