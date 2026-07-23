import type { SourceSpan } from "../source.js";

export interface OutputSpeaker {
  readonly identifier: string;
  readonly displayName: string;
  readonly color: string | null;
  readonly font: string | null;
  readonly avatar: string | null;
}

export interface SayEvent {
  readonly kind: "say";
  readonly sequence: number;
  readonly speaker: OutputSpeaker | null;
  readonly text: string;
  readonly span: SourceSpan;
}

export interface ExitEvent {
  readonly kind: "exit";
  readonly sequence: number;
  readonly span: SourceSpan;
}

export interface CompleteEvent {
  readonly kind: "complete";
  readonly sequence: number;
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
  readonly span: SourceSpan;
}

export type InterpreterEvent =
  | SayEvent
  | ExitEvent
  | CompleteEvent
  | DeveloperWarningEvent
  | RuntimeFailureEvent;
