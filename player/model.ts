export type MediaFit = "contain" | "cover";
export type PlayerMediaTransitionFixture = "direct" | "fade" | "crossfade";
export type PlayerToolId = "visuals" | "scene" | "layout-debug";
export type PlayerTimerKind = "visible" | "mystery" | "hidden";
export type PlayerForegroundFixtureKind = "none" | "show-button" | "choose" | "ask-text" | "ask-number";
export type PlayerPacingFixture = "off" | "skippable" | "unskippable";
export type PlayerControlAvailability = "enabled" | "disabled";

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
  readonly id: string;
  readonly speakerId: string;
  readonly text: string;
}

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
  | {
      readonly kind: "ask-text";
      readonly accessibleName: string;
      readonly hint: string;
    }
  | {
      readonly kind: "ask-number";
      readonly accessibleName: string;
      readonly hint: string;
    };

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
  readonly messages: readonly PlayerMessagePresentation[];
  readonly foreground: PlayerForegroundPresentation;
  readonly rightControls: readonly PlayerRightControlPresentation[];
}

export interface PlayerVisualPreferences {
  readonly accentColor: string;
  readonly ambient: boolean;
  readonly vignette: boolean;
}

export type LeftPanelMode = "auto" | "open" | "closed";
export type RightPanelMode = "auto" | "docked" | "overlay";
