import type {
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "../../../model.js";
import { authoredColorToOklch, blackOrWhiteInk } from "../../../theme/color.js";
import { scrimFor } from "./messageContrast";
import type { ScrimComparison } from "./scrimComparison";

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

export function adjoins(
  entries: readonly PlayerTranscriptEntryPresentation[],
  index: number,
  other: number,
) {
  const entry = entries[index];
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
  scrimComparison?: ScrimComparison,
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
  return {
    panel: authoredBackground,
    cover:
      authoredBackground === null && authoredText !== null
        ? scrimFor(authoredText, backdrop, scrimComparison)
        : null,
    placement:
      authored?.kind !== "prose"
        ? null
        : { position: authored.position ?? "center", text: authored.align ?? "center" },
    ink: authoredText ?? panelInk,
    backdrop,
    link: panelInk ?? palette.link,
    typeface: authored?.font == null ? null : `${authored.font}, var(--transcript-typeface)`,
  };
}
