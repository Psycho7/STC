// VENDOR PATCH: dropped primeng SelectItem + display-rate/flags imports and
// objectiveUnitOptions (UI only); kept the enum the solver reads.
export enum ObjectiveUnit {
  Items = 0,
  Belts = 1,
  Wagons = 2,
  Machines = 3,
}
