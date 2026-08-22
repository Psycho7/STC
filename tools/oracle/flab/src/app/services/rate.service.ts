import { Recipe } from '~/models/data/recipe';
import { Dataset } from '~/models/dataset';
import { rational } from '~/models/rational';
import { Step } from '~/models/step';

export class RateService {
  adjustPowerPollution(step: Step, recipe: Recipe, data: Dataset): void {
    if (step.machines?.nonzero() && !recipe.part) {
      if (recipe.drain?.nonzero() || recipe.consumption?.nonzero()) {
        // Reset power
        step.power = rational.zero;

        // Calculate drain
        if (recipe.drain?.nonzero()) {
          let machines = step.machines.ceil();
          if (data.flags.has('inactiveDrain')) {
            // In DSP drain is not cumulative; only add for inactive machines
            machines = machines.sub(step.machines);
          }

          step.power = step.power.add(machines.mul(recipe.drain));
        }
        // Calculate consumption
        if (recipe.consumption?.nonzero())
          step.power = step.power.add(step.machines.mul(recipe.consumption));
      }

      // Calculate pollution
      if (recipe.pollution?.nonzero())
        step.pollution = step.machines.mul(recipe.pollution);
    }
  }
}
