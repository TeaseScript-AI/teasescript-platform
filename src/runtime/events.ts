import type { MessagePresentation } from "../message-presentation.js";
import type { SourceSpan } from "../source.js";
import type { MessageMarkup } from "../message-markup.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimePendingActionSnapshot,
  RuntimeTimerSettlementSnapshot,
  RuntimeMediaSettlementSnapshot,
  RuntimePermanentButtonSettlementSnapshot,
} from "./actions/model.js";

export interface OutputSpeaker {
  readonly identifier: string;
  readonly displayName: string;
  readonly color: string | null;
  readonly font: string | null;
  readonly avatar: string | null;
}

export interface SayEvent {
  readonly presentation: MessagePresentation;
  readonly kind: "say";
  readonly sequence: number;
  readonly speaker: OutputSpeaker | null;
  readonly content: MessageMarkup;
  readonly text: string;
  readonly span: SourceSpan;
}

/**
 * A `.text` write gave a shown message new text: the message of the `say` event `messageId` now shows `content`, in
 * place, with its speaker and presentation unchanged.
 */
export interface MessageUpdatedEvent {
  readonly kind: "messageUpdated";
  readonly sequence: number;
  readonly messageId: number;
  readonly content: MessageMarkup;
  readonly text: string;
  readonly span: SourceSpan;
}

export interface ExitEvent {
  readonly kind: "exit";
  readonly sequence: number;
  readonly span: SourceSpan;
}

export interface ActionRequestedEvent {
  readonly kind: "actionRequested";
  readonly sequence: number;
  readonly action: RuntimePendingActionSnapshot;
  readonly span: SourceSpan;
}

export interface ActionCompletedEvent {
  readonly kind: "actionCompleted";
  readonly sequence: number;
  readonly settlement:
    | RuntimeActionSettlementSnapshot
    | RuntimeTimerSettlementSnapshot
    | RuntimeMediaSettlementSnapshot
    | RuntimePermanentButtonSettlementSnapshot;
  readonly span: SourceSpan;
}

/** Canonical player-authored Standard-chat transcript output. */
export interface PlayerTranscriptEvent {
  readonly kind: "playerTranscript";
  readonly sequence: number;
  readonly target: "standardChat";
  readonly requestingSpeakerId: number | null;
  readonly text: string;
  readonly span: SourceSpan;
}

/** A click on a permanent button, whose block then runs; it adds no transcript text of its own. */
export interface PermanentButtonPressedEvent {
  readonly kind: "permanentButtonPressed";
  readonly sequence: number;
  readonly buttonId: number;
  readonly text: string;
  readonly span: SourceSpan;
}

export interface DeveloperWarningEvent {
  readonly kind: "developerWarning";
  readonly sequence: number;
  readonly severity: "warning";
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export interface RuntimeFailureEvent {
  readonly kind: "runtimeFailure";
  readonly sequence: number;
  readonly code: string;
  readonly message: string;
  /** The project file whose source {@link span} is in. */
  readonly path: string;
  readonly span: SourceSpan;
}

/**
 * A debugging tool changed one key of the session's script-storage view (`applyExternalStorageEdit`); host-authored,
 * so it has no source location. The edited value is in the recorded input, not here.
 */
export interface ScriptStorageEditedEvent {
  readonly kind: "scriptStorageEdited";
  readonly sequence: number;
  readonly key: string;
  readonly operation: "set" | "delete";
  readonly currentSessionTimeMs: number;
  readonly observedSessionTimeMs: number;
}

export type InterpreterEvent =
  | SayEvent
  | MessageUpdatedEvent
  | ExitEvent
  | ActionRequestedEvent
  | ActionCompletedEvent
  | PlayerTranscriptEvent
  | PermanentButtonPressedEvent
  | DeveloperWarningEvent
  | RuntimeFailureEvent
  | ScriptStorageEditedEvent;
