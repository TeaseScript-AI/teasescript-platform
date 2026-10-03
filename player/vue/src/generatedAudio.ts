// Small synthesized WAV sources, so the demo and the development preview need no binary media in the repository.
const SAMPLE_RATE = 22050;

function wav(durationMs: number, sample: (time: number) => number): string {
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
    const value = Math.max(-1, Math.min(1, sample(index / SAMPLE_RATE)));
    view.setInt16(44 + index * 2, Math.round(value * 32767), true);
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Silence, for example to let a browser allow later playback on an element from a user activation. */
export function silence(durationMs: number): string {
  return wav(durationMs, () => 0);
}

/** A soft decaying chime. */
export function chime(durationMs: number, frequency: number): string {
  return wav(durationMs, (time) => {
    const envelope = Math.exp(-4 * time) * Math.min(1, time * 200);
    return Math.sin(2 * Math.PI * frequency * time) * envelope * 0.25;
  });
}

/**
 * A low room tone with a soft metronome tick every second. It loops seamlessly: every partial, the slow swell, and
 * the tick complete whole cycles in `durationMs`, which must be whole seconds.
 */
export function roomTone(durationMs: number): string {
  const seconds = durationMs / 1000;
  const cycles = (frequency: number) => Math.round(frequency * seconds) / seconds;
  const low = cycles(55);
  const hum = cycles(110);
  const swell = cycles(0.25);
  return wav(durationMs, (time) => {
    const level = 0.7 + 0.3 * Math.sin(2 * Math.PI * swell * time);
    const tone = Math.sin(2 * Math.PI * low * time) + 0.4 * Math.sin(2 * Math.PI * hum * time);
    const sinceTick = time % 1;
    const tick = Math.sin(2 * Math.PI * 1800 * sinceTick) * Math.exp(-sinceTick * 90);
    return tone * level * 0.1 + tick * 0.12;
  });
}
