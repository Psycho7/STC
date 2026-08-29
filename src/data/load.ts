import packJson from "@aef/data/recipe-pack.json";
import type { RecipePack } from "@aef/schema";

export const pack: RecipePack = packJson as unknown as RecipePack;
