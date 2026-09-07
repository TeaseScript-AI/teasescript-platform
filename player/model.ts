export type MediaFit = "contain" | "cover";
export type PlayerMediaTransitionFixture = "direct" | "fade" | "crossfade";
export type PlayerToolId = "visuals" | "layout-debug" | "runtime-session";
export type PlayerTimerKind = "visible" | "mystery" | "hidden";

export interface PlayerToolDefinition {
  readonly id: PlayerToolId;
  readonly label: string;
}

export interface PlayerToolColumnState {
  readonly id: string;
  readonly toolId: PlayerToolId | null;
}

export interface PlayerPackagePresentation {
  readonly accentColor: string;
}

export interface PlayerMediaPresentation {
  readonly id: string;
  readonly src: string;
  readonly fit: MediaFit;
  readonly title: string;
  readonly ambientColor: string;
}

export interface PlayerTimerPresentation {
  readonly name?: string;
  readonly remainingSeconds: number;
  readonly totalSeconds: number;
}

export interface PlayerSpeakerPresentation {
  readonly name: string;
  readonly accent: string;
  readonly avatar: string;
  readonly fontFamily: string;
}

export interface PlayerMessagePresentation {
  readonly kind: "message";
  readonly id: string;
  readonly speakerId: string;
  readonly text: string;
}

export interface PlayerSessionEventPresentation {
  readonly kind: "session-event";
  readonly id: string;
  readonly text: string;
}

export type PlayerTranscriptEntryPresentation =
  PlayerMessagePresentation | PlayerSessionEventPresentation;

export interface PlayerForegroundOptionPresentation {
  readonly id: string;
  readonly label: string;
  readonly authoredFill?: string;
}

export type PlayerForegroundPresentation =
  | {
      readonly kind: "show-button";
      readonly accessibleName: string;
      readonly label: string;
      readonly authoredFill?: string;
    }
  | {
      readonly kind: "choose";
      readonly accessibleName: string;
      readonly options: readonly PlayerForegroundOptionPresentation[];
    }
  | { readonly kind: "ask-text"; readonly accessibleName: string; readonly hint: string }
  | { readonly kind: "ask-number"; readonly accessibleName: string; readonly hint: string };

interface PlayerRightControlBase {
  readonly id: string;
  readonly label: string;
  readonly priority?: number;
}

export interface PlayerRightActionPresentation extends PlayerRightControlBase {
  readonly kind: "action";
  readonly authoredFill?: string;
}

export interface PlayerRightTogglePresentation extends PlayerRightControlBase {
  readonly kind: "toggle";
  readonly value: boolean;
  readonly recordUserHistory: boolean;
}

export interface PlayerRightSelectPresentation extends PlayerRightControlBase {
  readonly kind: "select";
  readonly value: string;
  readonly options: readonly (readonly [value: string, label: string])[];
  readonly recordUserHistory: boolean;
}

export interface PlayerRightStatusPresentation extends PlayerRightControlBase {
  readonly kind: "status";
  readonly detail: string;
  readonly progress?: number;
}

export type PlayerRightControlPresentation =
  | PlayerRightActionPresentation
  | PlayerRightTogglePresentation
  | PlayerRightSelectPresentation
  | PlayerRightStatusPresentation;

export interface PlayerPresentation {
  readonly package: PlayerPackagePresentation;
  readonly media: PlayerMediaPresentation;
  readonly timer: PlayerTimerPresentation;
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  readonly rightControls: readonly PlayerRightControlPresentation[];
}

export type LeftPanelMode = "auto" | "open" | "closed";
