import type {
  PlayerMediaTransitionFixture,
  PlayerTimerKind,
  PlayerTranscriptEntryPresentation,
} from "../../../model.js";

export type BusyControlTarget = "action" | "select" | "toggle";
export type BusyStyle = "corner-dot" | "dots" | "off" | "pulse" | "spinner" | "sweep" | "wash";
export type PlayerThemeFixture = "daylight" | "stage";
export type ScriptUpdateFeedback = "highlight" | "toast" | "toast-highlight";
export type ScriptUpdateTarget = "select" | "toggle";
export type TranscriptEdgeFixture = "cut" | "fade" | "late";

export interface PlayerDevelopmentOptions {
  readonly busyStyle: BusyStyle;
  readonly busyTarget: BusyControlTarget;
  readonly controlsDisabled: boolean;
  readonly historyEntries: readonly PlayerTranscriptEntryPresentation[];
  readonly mediaTransition: PlayerMediaTransitionFixture;
  readonly rightControlsVisible: boolean;
  readonly styleOverrides: Readonly<Record<`--${string}`, string>>;
  readonly theme: PlayerThemeFixture;
  readonly timerCount: number;
  readonly timerKind: PlayerTimerKind;
  readonly transcriptEdge: TranscriptEdgeFixture;
}
