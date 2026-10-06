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

/** One shown permanent button, in creation order. A busy button stays in place but is inactive until its block ends. */
export interface PlayerPermanentButtonPresentation {
  readonly buttonId: number;
  readonly label: string;
  readonly busy: boolean;
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
  /** Completed choice, button, or form, distinct from a free-text or numeric response. */
  readonly responseKind?: "choice" | "button" | "form";
  readonly presentation?: MessagePresentation;
  /** A message of the later state Debug's rewind can restore, which the inspected state has not reached; shown grey. */
  readonly future?: true;
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
  | {
      /** `ask-date`, `ask-time`, and `ask-datetime` use the browser's date and time controls, which submit ISO text. */
      readonly kind: "ask-text" | "ask-number" | "ask-date" | "ask-time" | "ask-datetime";
      readonly accessibleName: string;
      readonly hint: string;
      /** The default answer that initially fills the composer. */
      readonly prefill?: string;
      /** `askInteger`: only a whole number is an answer. */
      readonly integer?: true;
      /**
       * A date or time answer is typed as ISO text, because the browser's control cannot show the default; a native
       * date control has no year 0000.
       */
      readonly isoText?: true;
    }
  | {
      /** `askForm`: its fields and answers, which change with each edit, are `PlayerFormPresentation`. */
      readonly kind: "form";
      readonly accessibleName: string;
      readonly hint: string;
    }
  | {
      /** `askImage`: the player answers with an image file, through the file picker or by dropping it. */
      readonly kind: "ask-image";
      readonly accessibleName: string;
      readonly hint: string;
      /** Whether an image file may answer. */
      readonly allowFile: boolean;
      /** Whether a photo from the camera may answer. */
      readonly allowCamera: boolean;
      /** The file extensions and image MIME types a file needs; `null` accepts any image. */
      readonly types: readonly string[] | null;
      readonly mime: readonly string[] | null;
    };

/**
 * The controls of a pending form as its answers stand: each field by its ID, the submit button, a status such as
 * `3 of 5 selected`, and the field the composer edits. A toggle is `pressed` while on; a toggle with options and a cycle
 * show their current option as `state`, whose colour wins over the field's; a typed field shows its value as `state`,
 * or `null` without one.
 */
export interface PlayerFormPresentation {
  readonly actionId: number;
  readonly fields: readonly PlayerFormFieldPresentation[];
  readonly submit: { readonly label: string; readonly authoredFill?: string };
  /** The button that cancels the whole form, or `null` when the form must be submitted. */
  readonly cancel: { readonly label: string; readonly authoredFill?: string } | null;
  readonly status: string;
  readonly editor: PlayerFormEditorPresentation | null;
}

export interface PlayerFormFieldPresentation {
  readonly id: string;
  readonly label: string;
  readonly kind: "toggle" | "cycle" | "value";
  readonly pressed: boolean;
  readonly state: string | null;
  /** A typed field the form may be submitted without. */
  readonly optional: boolean;
  /** The typed field the composer edits now. */
  readonly editing: boolean;
  readonly authoredFill?: string;
}

/** The typed field the composer edits, with the text the form holds for it and how the composer takes its answer. */
export interface PlayerFormEditorPresentation {
  readonly fieldId: string;
  readonly label: string;
  readonly hint: string;
  readonly optional: boolean;
  readonly text: string;
  readonly inputMode: "text" | "numeric" | "decimal";
  readonly inputType: "text" | "date" | "time" | "datetime-local";
}
