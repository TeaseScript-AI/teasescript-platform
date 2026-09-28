// Early assignments span the palette; neighboring hues use different lightness levels.
// Each pair keeps its hue across themes.
export const speakerAvatarPalette = [
  {
    light: { background: "#99cc7c", color: "#0c2100" },
    dark: { background: "#2b6200", color: "#d2efc4" },
  },
  {
    light: { background: "#d2a5f4", color: "#241031" },
    dark: { background: "#6a368b", color: "#f2d9ff" },
  },
  {
    light: { background: "#ffc9ac", color: "#320e00" },
    dark: { background: "#5f1400", color: "#ffd8c1" },
  },
  {
    light: { background: "#8de9ff", color: "#002030" },
    dark: { background: "#003a52", color: "#b6efff" },
  },
  {
    light: { background: "#fe9aa2", color: "#330a11" },
    dark: { background: "#8f2639", color: "#ffd4d7" },
  },
  {
    light: { background: "#e6df7e", color: "#201b00" },
    dark: { background: "#3a3400", color: "#eae8b6" },
  },
  {
    light: { background: "#40d2d2", color: "#002223" },
    dark: { background: "#006263", color: "#b2f3f2" },
  },
  {
    light: { background: "#ccd8ff", color: "#131638" },
    dark: { background: "#232378", color: "#d8e2ff" },
  },
  {
    light: { background: "#e7af5c", color: "#2b1400" },
    dark: { background: "#764700", color: "#ffdfb5" },
  },
  {
    light: { background: "#ffc1e4", color: "#2f0b1f" },
    dark: { background: "#61003d", color: "#ffd4eb" },
  },
  {
    light: { background: "#87f4c7", color: "#002313" },
    dark: { background: "#004027", color: "#bdf3da" },
  },
  {
    light: { background: "#7dc0ff", color: "#001b37" },
    dark: { background: "#00539b", color: "#c6e9ff" },
  },
] as const;

export function leastUsedAvatarColor(messageCounts: readonly number[]): number {
  let selected = 0;
  for (let index = 1; index < speakerAvatarPalette.length; index += 1) {
    if (messageCounts[index]! < messageCounts[selected]!) selected = index;
  }
  return selected;
}

export function recordSpeakerAvatarMessage(
  assignments: Map<string, number>,
  messageCounts: number[],
  identity: string,
  hasBubble: boolean,
): void {
  let colorIndex = assignments.get(identity);
  if (colorIndex === undefined && hasBubble) {
    colorIndex = leastUsedAvatarColor(messageCounts);
    assignments.set(identity, colorIndex);
  }
  if (colorIndex !== undefined) messageCounts[colorIndex]! += 1;
}

export function speakerAvatarColors(index: number) {
  return speakerAvatarPalette[Math.max(index, 0) % speakerAvatarPalette.length]!;
}
