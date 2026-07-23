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
  readonly speaker: OutputSpeaker | null;
  readonly text: string;
  readonly span: SourceSpan;
}

export interface ExitEvent {
  readonly kind: "exit";
  readonly span: SourceSpan;
}

export type InterpreterEvent = SayEvent | ExitEvent;
