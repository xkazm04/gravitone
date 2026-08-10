// The one import surface for the mocked library. The two halves are split
// files only for size discipline — consumers never know.

import { GENERATED_ASSETS } from "./assetsGenerated";
import { SOURCE_ASSETS } from "./assetsSource";

export const ASSETS = [...SOURCE_ASSETS, ...GENERATED_ASSETS];

export const assetById = new Map(ASSETS.map((a) => [a.id, a]));

export const COLLECTIONS = [...new Set(ASSETS.map((a) => a.collection))].map((name) => ({
  name,
  count: ASSETS.filter((a) => a.collection === name).length,
}));
