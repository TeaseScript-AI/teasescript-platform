import { chime } from "./generatedAudio";
import { stageFixtures } from "./stageFixtures";

// Development host resolution for the preview's opening scenario. The product Player receives this
// resolution from its trusted host; unknown references stay unavailable.
const assets: Readonly<Record<string, string>> = {
  "images/coast.svg": stageFixtures.Landscape.src,
  "images/dusk.svg": stageFixtures.Dusk.src,
  "sounds/chime.wav": chime(1200, 660),
};

export function resolveDevelopmentAsset(path: string): string | null {
  return assets[path] ?? null;
}
