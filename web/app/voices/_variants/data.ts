// Compatibility shim. The Character & Voice data layer now lives in one module,
// `@/app/voices/_data/characters`. This file only re-exports it for consumers
// outside the voices tree (e.g. the profile "My Voices" panel) so their imports
// keep working. New voices code should import from `_data/characters` directly.
export {
  useVoicePreview,
  useCharacters,
  useCharacter,
  hueOf,
  relTime,
  pickAudio,
} from "../_data/characters";
export type { Voice, Character, Slot } from "../_data/characters";
