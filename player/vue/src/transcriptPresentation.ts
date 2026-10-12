import type { PlayerSpeakerPresentation, PlayerTranscriptEntryPresentation } from "../../model.js";
import { authoredColorToOklch, blackOrWhiteInk } from "../../theme/color.js";
import { readabilityFor } from "./messageContrast";

export interface TranscriptPalette {
  readonly surface: string;
  readonly canvas: string;
  readonly link: string;
}

function authoredOn(entry: PlayerTranscriptEntryPresentation) {
  return entry.kind === "message" ? (entry.presentation ?? null) : null;
}

function presentationOf(entry: PlayerTranscriptEntryPresentation | undefined) {
  if (entry === undefined || entry.kind !== "message") return null;
  return authoredOn(entry)?.kind === "prose" ? "prose" : "bubble";
}

/** Whether `entry` is a message that `remove()` took out of the conversation, which shows nothing (#836). */
export function isRemovedEntry(entry: PlayerTranscriptEntryPresentation | undefined): boolean {
  return entry?.kind === "message" && entry.removed === true;
}

/**
 * Whether the message at `index` groups with its nearest shown neighbour towards `other`: removed messages between
 * them show nothing, so the messages around them adjoin.
 */
export function adjoins(
  entries: readonly PlayerTranscriptEntryPresentation[],
  index: number,
  other: number,
) {
  const entry = entries[index];
  const step = other < index ? -1 : 1;
  while (isRemovedEntry(entries[other])) other += step;
  const neighbour = entries[other];
  if (entry?.kind !== "message" || neighbour?.kind !== "message") return false;
  return (
    neighbour.speakerId === entry.speakerId && presentationOf(neighbour) === presentationOf(entry)
  );
}

export function nameOf(
  speakers: Readonly<Record<string, PlayerSpeakerPresentation>>,
  entry: PlayerTranscriptEntryPresentation,
) {
  return entry.kind === "message" ? (speakers[entry.speakerId]?.name ?? "").trim() : "";
}

export function resolveAppearance(
  entry: PlayerTranscriptEntryPresentation,
  palette: TranscriptPalette,
  enhancedContrast = false,
) {
  const authored = authoredOn(entry);
  const authoredText = authored?.color ?? null;
  const authoredBackground = authored?.background ?? null;
  const panelInk =
    authoredBackground === null
      ? null
      : (authoredText ?? blackOrWhiteInk(authoredColorToOklch(authoredBackground)));
  const backdrop =
    authoredBackground ?? (authored?.kind === "prose" ? palette.canvas : palette.surface);
  const readability =
    authoredBackground === null && authoredText !== null
      ? readabilityFor(authoredText, backdrop, enhancedContrast)
      : null;
  return {
    panel: authoredBackground,
    authoredInk: authoredText,
    cover: readability?.cover ?? null,
    placement:
      authored?.kind !== "prose"
        ? null
        : { position: authored.position ?? "center", text: authored.align ?? "center" },
    ink: readability?.ink ?? authoredText ?? panelInk,
    backdrop,
    link: panelInk ?? palette.link,
    typeface: authored?.font == null ? null : `${authored.font}, var(--transcript-typeface)`,
  };
}
