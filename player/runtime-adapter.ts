import {
  compileSource,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  observeTime,
  run,
  serializeCheckpoint,
  type ActionCompletionOutcome,
  type InstructionPlan,
  type InteractionAccessibleName,
  type InterpreterEvent,
  type PendingActionOperationResult,
  type RuntimeInteractionActionSnapshot,
  type RuntimeSnapshot,
  type TimeObservationOutcome,
} from "../src/index.js";
import type { RuntimeChatPacingGateActionSnapshot } from "../src/runtime/actions/model.js";
import type {
  PlayerForegroundPresentation,
  PlayerSpeakerPresentation,
  PlayerTranscriptEntryPresentation,
} from "./model.js";

const DEFAULT_SPEAKERS: Readonly<Record<string, PlayerSpeakerPresentation>> = Object.freeze({
  narrator: Object.freeze({
    name: "Narrator",
    accent: "#9a867d",
    avatar: "N",
    fontFamily: "inherit",
  }),
  user: Object.freeze({ name: "You", accent: "#8fa3ab", avatar: "Y", fontFamily: "inherit" }),
});

export interface PlayerRuntimeSession {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
  readonly events: readonly InterpreterEvent[];
  readonly transcriptEntries: readonly PlayerTranscriptEntryPresentation[];
  readonly transcriptRevision: number;
  readonly speakers: Readonly<Record<string, PlayerSpeakerPresentation>>;
}

/** Runtime checkpoint plus an in-memory presentation cache; only checkpointJson is canonical save data. */
export interface PlayerRuntimeRestorePoint {
  readonly checkpointJson: string;
  readonly events: readonly InterpreterEvent[];
}

export interface PlayerRuntimeControlResult<T = ActionCompletionOutcome | TimeObservationOutcome> {
  readonly session: PlayerRuntimeSession;
  readonly outcome: T;
}

export function createPlayerRuntimeSession(source: string): PlayerRuntimeSession {
  const compilation = compileSource(source);
  if (compilation.plan === null) {
    const diagnostic = compilation.diagnostics[0];
    throw new Error(diagnostic?.message ?? "Player source did not compile.");
  }
  const snapshot = createFreshRuntimeSnapshot(compilation.plan);
  const operation = run(compilation.plan, snapshot);
  return appendRuntimeEvents(emptySession(compilation.plan, operation.snapshot), operation.events);
}

export function createPlayerRuntimeRestorePoint(
  session: PlayerRuntimeSession,
): PlayerRuntimeRestorePoint {
  return Object.freeze({
    checkpointJson: serializeCheckpoint(createCheckpoint(session.plan, session.snapshot)),
    events: Object.freeze([...session.events]),
  });
}

export function restorePlayerRuntimeSession(
  restorePoint: PlayerRuntimeRestorePoint,
): PlayerRuntimeSession {
  const checkpoint = deserializeCheckpoint(restorePoint.checkpointJson);
  return appendRuntimeEvents(
    emptySession(checkpoint.plan, checkpoint.snapshot),
    restorePoint.events,
  );
}

export function playerRuntimeForeground(
  session: PlayerRuntimeSession,
): PlayerForegroundPresentation | null {
  const action = activeInteraction(session.snapshot);
  if (action === null) return null;
  const accessibleName = interactionAccessibleName(action.ui.accessibleName);
  switch (action.ui.kind) {
    case "button":
      return Object.freeze({ kind: "show-button", accessibleName, label: action.ui.buttonLabel });
    case "text":
      return Object.freeze({
        kind: "ask-text",
        accessibleName,
        hint: action.ui.hint ?? "Type your response…",
      });
    case "number":
      return Object.freeze({
        kind: "ask-number",
        accessibleName,
        hint: action.ui.hint ?? "Type your response…",
      });
    case "choice":
      return Object.freeze({
        kind: "choose",
        accessibleName,
        options: Object.freeze(
          action.ui.options.map((option, index) =>
            Object.freeze({ id: choiceOptionId(action.actionId, index), label: option.text }),
          ),
        ),
      });
  }
}

export function playerRuntimePacingGate(
  session: PlayerRuntimeSession,
): RuntimeChatPacingGateActionSnapshot | null {
  return activePlayerRuntimePacingGate(session.snapshot);
}

export function activePlayerRuntimeInteraction(
  snapshot: RuntimeSnapshot,
): RuntimeInteractionActionSnapshot | null {
  return snapshot.foregroundAction?.kind === "interaction" ? snapshot.foregroundAction : null;
}

export function activePlayerRuntimePacingGate(
  snapshot: RuntimeSnapshot,
): RuntimeChatPacingGateActionSnapshot | null {
  const foreground = snapshot.foregroundAction;
  if (foreground?.kind === "chatPacingGate") return foreground;
  return snapshot.backgroundActions.find((action) => action.kind === "chatPacingGate") ?? null;
}

export function completePlayerRuntimeAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  payload: Record<string, unknown>,
): PendingActionOperationResult<ActionCompletionOutcome> {
  return completeAction(plan, snapshot, {
    actionId: action.actionId,
    actionKind: action.kind,
    ...(action.kind === "interaction" ? { interactionKind: action.interactionKind } : {}),
    payload,
  });
}

export function submitPlayerRuntimeComposer(
  session: PlayerRuntimeSession,
  submittedText: string,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.snapshot);
  if (
    action === null ||
    (action.interactionKind !== "text" &&
      action.interactionKind !== "number" &&
      action.interactionKind !== "choice")
  ) {
    return null;
  }
  return completePlayerAction(session, action, { kind: "submittedText", submittedText });
}

export function activatePlayerRuntimeButton(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.snapshot);
  if (action?.interactionKind !== "button") return null;
  return completePlayerAction(session, action, { kind: "activate" });
}

export function selectPlayerRuntimeChoice(
  session: PlayerRuntimeSession,
  optionId: string,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = activeInteraction(session.snapshot);
  if (action?.interactionKind !== "choice" || action.ui.kind !== "choice") return null;
  const optionIndex = action.ui.options.findIndex(
    (_option, index) => choiceOptionId(action.actionId, index) === optionId,
  );
  const option = action.ui.options[optionIndex];
  if (option === undefined) return null;
  const payload =
    option.label === null
      ? { kind: "selectedText", selectedText: option.text }
      : { kind: "selectedLabel", selectedLabel: option.label };
  return completePlayerAction(session, action, payload);
}

export function skipPlayerRuntimePacing(
  session: PlayerRuntimeSession,
): PlayerRuntimeControlResult<ActionCompletionOutcome> | null {
  const action = playerRuntimePacingGate(session);
  if (action === null) return null;
  return completePlayerAction(session, action, { kind: "skip" });
}

export function observePlayerRuntimeTime(
  session: PlayerRuntimeSession,
  currentSessionTimeMs: number,
): PlayerRuntimeControlResult<TimeObservationOutcome> {
  const operation = observeTime(session.plan, session.snapshot, currentSessionTimeMs);
  const observed = appendRuntimeEvents(
    { ...session, snapshot: operation.snapshot },
    operation.events,
  );
  return Object.freeze({
    session:
      operation.outcome.kind === "observed" && operation.outcome.completion !== null
        ? continuePlayerRuntime(observed)
        : observed,
    outcome: operation.outcome,
  });
}

function completePlayerAction(
  session: PlayerRuntimeSession,
  action: RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  payload: Record<string, unknown>,
): PlayerRuntimeControlResult<ActionCompletionOutcome> {
  const operation = completePlayerRuntimeAction(session.plan, session.snapshot, action, payload);
  const completed = appendRuntimeEvents(
    { ...session, snapshot: operation.snapshot },
    operation.events,
  );
  return Object.freeze({
    session: operation.outcome.kind === "completed" ? continuePlayerRuntime(completed) : completed,
    outcome: operation.outcome,
  });
}

function continuePlayerRuntime(session: PlayerRuntimeSession): PlayerRuntimeSession {
  const operation = run(session.plan, session.snapshot);
  return appendRuntimeEvents({ ...session, snapshot: operation.snapshot }, operation.events);
}

function emptySession(plan: InstructionPlan, snapshot: RuntimeSnapshot): PlayerRuntimeSession {
  return Object.freeze({
    plan,
    snapshot,
    events: [],
    transcriptEntries: [],
    transcriptRevision: 0,
    speakers: { ...DEFAULT_SPEAKERS },
  });
}

function appendRuntimeEvents(
  session: PlayerRuntimeSession,
  events: readonly InterpreterEvent[],
): PlayerRuntimeSession {
  if (events.length === 0) return Object.freeze(session);
  // EVIDENCE: emptySession creates an unfrozen adapter-owned speaker accumulator for every session.
  const speakers = session.speakers as Record<string, PlayerSpeakerPresentation>;
  // EVIDENCE: emptySession creates an unfrozen adapter-owned event accumulator for every session.
  const retainedEvents = session.events as InterpreterEvent[];
  // EVIDENCE: emptySession creates an unfrozen adapter-owned transcript accumulator for every session.
  const transcriptEntries = session.transcriptEntries as PlayerTranscriptEntryPresentation[];
  for (const event of events) retainedEvents.push(event);
  for (const event of events) {
    if (event.kind === "say") {
      const speakerId = event.speaker === null ? "narrator" : `runtime-speaker-${event.sequence}`;
      if (event.speaker !== null) speakers[speakerId] = speakerPresentation(event.speaker);
      transcriptEntries.push(
        Object.freeze({
          kind: "message",
          id: `runtime-event-${event.sequence}`,
          speakerId,
          text: event.text,
          content: event.content,
        }),
      );
    } else if (event.kind === "playerTranscript") {
      transcriptEntries.push(
        Object.freeze({
          kind: "message",
          id: `runtime-event-${event.sequence}`,
          speakerId: "user",
          text: event.text,
        }),
      );
    }
  }
  return Object.freeze({
    ...session,
    events: retainedEvents,
    transcriptEntries,
    transcriptRevision: session.transcriptRevision + 1,
    speakers,
  });
}

function activeInteraction(snapshot: RuntimeSnapshot): RuntimeInteractionActionSnapshot | null {
  return activePlayerRuntimeInteraction(snapshot);
}

function choiceOptionId(actionId: number, optionIndex: number): string {
  return `runtime-choice-${actionId}-${optionIndex}`;
}

function interactionAccessibleName(value: InteractionAccessibleName): string {
  if (value.kind === "text") return value.text;
  return {
    answer: "Answer",
    number: "Number",
    chooseOption: "Choose an option",
    continue: "Continue",
  }[value.key];
}

function speakerPresentation(speaker: {
  readonly displayName: string;
  readonly color: string | null;
  readonly font: string | null;
  readonly avatar: string | null;
}): PlayerSpeakerPresentation {
  return Object.freeze({
    name: speaker.displayName,
    accent: speaker.color ?? "#9a867d",
    avatar: speaker.avatar ?? (speaker.displayName.trim().charAt(0).toUpperCase() || "?"),
    fontFamily: speaker.font ?? "inherit",
  });
}
