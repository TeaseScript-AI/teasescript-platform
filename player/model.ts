import type { MessagePresentation } from "../src/message-presentation.js";
import type { MessageMarkup } from "../src/message-markup.js";

export type PlayerTimerKind = "visible" | "mystery" | "hidden";

/** One presented timer. Hidden timers are never presented, so they have no entry. */
export interface PlayerTimerPresentation {
  /** Stable presentation key; it is never displayed. */
  readonly id: string;
  readonly kind: Exclude<PlayerTimerKind, "hidden">;
  readonly name?: string;
  readonly remainingSeconds: number;
  readonly totalSeconds: number;
}

export interface PlayerSpeakerPresentation {
  readonly name: string;
  readonly accent: string;
  /** Letter glyph shown when no authored avatar image is available or it fails to load. */
  readonly avatar: string;
  /** Authored, package-relative speaker `avatar` reference; the Player resolves it through its host. */
  readonly avatarImage?: string;
  readonly fontFamily: string;
  readonly identityId?: string;
}

export interface PlayerMessagePresentation {
  readonly kind: "message";
  readonly id: string;
  readonly speakerId: string;
  readonly text: string;
  /** Present only for authored runtime output; player-authored entries remain plain text. */
  readonly content?: MessageMarkup;
  /** Completed choice/button, distinct from a free-text or numeric response. */
  readonly responseKind?: "choice" | "button";
  readonly presentation?: MessagePresentation;
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
