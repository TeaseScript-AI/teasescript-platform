// Opposite hues come first; later assignments fill the gaps. Each pair keeps its hue across themes.
export const speakerAvatarPalette = [
  {
    light: { background: "#bcf1c6", color: "#004209" },
    dark: { background: "#004e0f", color: "#8fe1a1" },
  },
  {
    light: { background: "#ffcffb", color: "#560553" },
    dark: { background: "#62155f", color: "#f7aef0" },
  },
  {
    light: { background: "#ffd5ac", color: "#542300" },
    dark: { background: "#632b00", color: "#ffb777" },
  },
  {
    light: { background: "#b6e9ff", color: "#003760" },
    dark: { background: "#004270", color: "#82d4ff" },
  },
  {
    light: { background: "#ffcddf", color: "#640030" },
    dark: { background: "#71073a", color: "#ffa9c7" },
  },
  {
    light: { background: "#f6e0a4", color: "#433000" },
    dark: { background: "#503900", color: "#e9c769" },
  },
  {
    light: { background: "#a5f3e3", color: "#003f34" },
    dark: { background: "#004b3f", color: "#61e4cd" },
  },
  {
    light: { background: "#d0e0ff", color: "#1a2678" },
    dark: { background: "#233285", color: "#b1c8ff" },
  },
  {
    light: { background: "#ffd1c6", color: "#690000" },
    dark: { background: "#760a03", color: "#ffaf9f" },
  },
  {
    light: { background: "#daeaae", color: "#2d3900" },
    dark: { background: "#374400", color: "#c0d67a" },
  },
  {
    light: { background: "#a1f0ff", color: "#003c48" },
    dark: { background: "#004855", color: "#58e0f6" },
  },
  {
    light: { background: "#e9d7ff", color: "#40166d" },
    dark: { background: "#4a237a", color: "#d6b9ff" },
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
