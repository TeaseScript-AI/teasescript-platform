import demoSource from "../../../examples/demo/demo.tease?raw";
import { chime, roomTone } from "./generatedAudio";

// The trusted host for the repository demo package in `examples/demo/`: it supplies the source and resolves the
// package-relative references the script uses. Images are package files; the sounds are synthesized on first use.
const images = import.meta.glob<string>("../../../examples/demo/{images,avatars}/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
});
const sounds: Readonly<Record<string, () => string>> = {
  "sounds/command-chime.wav": () => chime(1600, 880),
  "sounds/room-ambience.wav": () => roomTone(4000),
};
const resolved = new Map<string, string | null>();

export { demoSource };

// A stable, opaque script-storage scope for this package. A production host derives it from the script's and the
// player's identities so that players sharing a browser never see each other's saved data.
export const demoStorageScope = "repository-demo";

export function resolveDemoAsset(path: string): string | null {
  let url = resolved.get(path);
  if (url === undefined) {
    url = images[`../../../examples/demo/${path}`] ?? sounds[path]?.() ?? null;
    resolved.set(path, url);
  }
  return url;
}
