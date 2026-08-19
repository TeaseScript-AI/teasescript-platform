export type MediaFit = "contain" | "cover";
export type PlayerToolId = "visuals" | "scene" | "layout-debug";

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

export interface PlayerActionPresentation {
  readonly id: string;
  readonly label: string;
}

export interface PlayerPresentation {
  readonly package: PlayerPackagePresentation;
  readonly media: PlayerMediaPresentation;
  readonly timer: PlayerTimerPresentation;
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
  readonly messages: readonly PlayerMessagePresentation[];
  readonly actions: readonly PlayerActionPresentation[];
}

export interface PlayerVisualPreferences {
  readonly accentColor: string;
  readonly ambient: boolean;
  readonly vignette: boolean;
}

export type LeftPanelMode = "auto" | "open" | "closed";
export type RightPanelMode = "auto" | "docked" | "overlay";
