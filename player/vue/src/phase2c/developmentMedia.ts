import { stageFixtures } from "./stageFixtures";

// Development host resolution for the preview's opening scenario. The product Player receives this
// resolution from its trusted host; unknown references stay unavailable.
const SAMPLE_RATE = 22050;

// A soft generated chime, so the preview needs no binary media in the repository.
function chime(durationMs: number, frequency: number): string {
  const samples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index++) {
    const time = index / SAMPLE_RATE;
    const envelope = Math.exp(-4 * time) * Math.min(1, time * 200);
    const value = Math.sin(2 * Math.PI * frequency * time) * envelope * 0.25;
    view.setInt16(44 + index * 2, Math.round(value * 32767), true);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

const assets: Readonly<Record<string, string>> = {
  "images/coast.svg": stageFixtures.Landscape.src,
  "images/dusk.svg": stageFixtures.Dusk.src,
  "sounds/chime.wav": chime(1200, 660),
};

export function resolveDevelopmentAsset(path: string): string | null {
  return assets[path] ?? null;
}
