import packJson from "@aef/data/recipe-pack.json";
import i18nJson from "@aef/data/recipe-pack.i18n.json";
import type { RecipePack, RecipePackI18n } from "@aef/schema";

export const pack: RecipePack = packJson as unknown as RecipePack;
export const i18n: RecipePackI18n = i18nJson as unknown as RecipePackI18n;
