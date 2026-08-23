import type {
  PlayerForegroundPresentation,
  PlayerMessagePresentation,
  PlayerPresentation,
  PlayerRightControlPresentation,
  PlayerSessionEventPresentation,
  PlayerTranscriptEntryPresentation,
} from "../../model.js";
import { matchForegroundChoiceByVisibleText } from "../../presentation.js";

export interface PlayerCoreState {
  readonly composerFeedback: string;
  readonly composerValue: string;
  readonly foreground: PlayerForegroundPresentation | null;
  readonly nextActivitySequence: number;
  readonly rightControls: readonly PlayerRightControlPresentation[];
  readonly transcriptEntries: readonly PlayerTranscriptEntryPresentation[];
}

export type PlayerCoreAction =
  | { readonly type: "activate-foreground"; readonly label: string }
  | { readonly type: "activate-right-action"; readonly controlId: string }
  | { readonly type: "change-right-select"; readonly controlId: string; readonly value: string }
  | { readonly type: "change-right-toggle"; readonly checked: boolean; readonly controlId: string }
  | { readonly type: "set-composer"; readonly value: string }
  | { readonly type: "submit-composer" };

export function createPlayerCoreState(presentation: PlayerPresentation): PlayerCoreState {
  return {
    composerFeedback: "",
    composerValue: "",
    foreground: presentation.foreground,
    nextActivitySequence: 1,
    rightControls: presentation.rightControls,
    transcriptEntries: presentation.messages,
  };
}

export function reducePlayerCoreState(
  state: PlayerCoreState,
  action: PlayerCoreAction,
): PlayerCoreState {
  switch (action.type) {
    case "set-composer":
      return { ...state, composerFeedback: "", composerValue: action.value };
    case "submit-composer":
      return submitComposer(state);
    case "activate-foreground":
      return completeForeground(state, action.label);
    case "activate-right-action":
      return activateRightAction(state, action.controlId);
    case "change-right-toggle":
      return changeRightToggle(state, action.controlId, action.checked);
    case "change-right-select":
      return changeRightSelect(state, action.controlId, action.value);
  }
}

function submitComposer(state: PlayerCoreState): PlayerCoreState {
  const raw = state.composerValue;
  const foreground = state.foreground;
  if (foreground === null) {
    return raw.trim().length === 0
      ? withFeedback(state, "Enter a response before sending.")
      : appendUserMessage(state, raw);
  }

  switch (foreground.kind) {
    case "ask-text":
      return raw.trim().length === 0
        ? withFeedback(state, "Enter a text answer before sending.")
        : completeForeground(state, raw);
    case "ask-number":
      return isAcceptedNumberText(raw)
        ? completeForeground(state, raw.trim())
        : withFeedback(state, "Enter a valid number before sending.");
    case "show-button":
      return raw === foreground.label
        ? completeForeground(state, foreground.label)
        : withFeedback(state, `Type “${foreground.label}” exactly or use the button.`);
    case "choose": {
      const option = matchForegroundChoiceByVisibleText(foreground.options, raw);
      return option === null
        ? withFeedback(state, "Type one visible option exactly or use a rendered choice control.")
        : completeForeground(state, option.label);
    }
  }
}

function completeForeground(state: PlayerCoreState, label: string): PlayerCoreState {
  if (state.foreground === null) return state;
  return appendUserMessage({ ...state, foreground: null }, label);
}

function activateRightAction(state: PlayerCoreState, controlId: string): PlayerCoreState {
  const control = state.rightControls.find(
    (candidate) => candidate.kind === "action" && candidate.id === controlId,
  );
  return control?.kind === "action" ? appendUserMessage(state, control.label) : state;
}

function changeRightToggle(
  state: PlayerCoreState,
  controlId: string,
  checked: boolean,
): PlayerCoreState {
  const current = state.rightControls.find(
    (candidate) => candidate.kind === "toggle" && candidate.id === controlId,
  );
  if (current?.kind !== "toggle") return state;

  const next = {
    ...state,
    rightControls: state.rightControls.map((control) => (
      control.kind === "toggle" && control.id === controlId
        ? { ...control, value: checked }
        : control
    )),
  };
  return current.recordUserHistory
    ? appendSessionEvent(next, `You changed ${current.label} to ${checked ? "on" : "off"}.`)
    : next;
}

function changeRightSelect(
  state: PlayerCoreState,
  controlId: string,
  value: string,
): PlayerCoreState {
  const current = state.rightControls.find(
    (candidate) => candidate.kind === "select" && candidate.id === controlId,
  );
  if (current?.kind !== "select" || !current.options.some(([option]) => option === value)) return state;

  const next = {
    ...state,
    rightControls: state.rightControls.map((control) => (
      control.kind === "select" && control.id === controlId
        ? { ...control, value }
        : control
    )),
  };
  if (!current.recordUserHistory) return next;
  const label = current.options.find(([option]) => option === value)?.[1] ?? value;
  return appendSessionEvent(next, `You changed ${current.label} to ${label}.`);
}

function appendUserMessage(state: PlayerCoreState, text: string): PlayerCoreState {
  const message: PlayerMessagePresentation = {
    kind: "message",
    id: `activity-${state.nextActivitySequence}`,
    speakerId: "user",
    text,
  };
  return appendEntry(state, message);
}

function appendSessionEvent(state: PlayerCoreState, text: string): PlayerCoreState {
  const event: PlayerSessionEventPresentation = {
    kind: "session-event",
    id: `activity-${state.nextActivitySequence}`,
    text,
  };
  return appendEntry(state, event, false);
}

function appendEntry(
  state: PlayerCoreState,
  entry: PlayerTranscriptEntryPresentation,
  clearComposer = true,
): PlayerCoreState {
  return {
    ...state,
    composerFeedback: "",
    composerValue: clearComposer ? "" : state.composerValue,
    nextActivitySequence: state.nextActivitySequence + 1,
    transcriptEntries: [...state.transcriptEntries, entry],
  };
}

function withFeedback(state: PlayerCoreState, composerFeedback: string): PlayerCoreState {
  return { ...state, composerFeedback };
}

function isAcceptedNumberText(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || /[\r\n]/u.test(trimmed)) return false;
  if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(trimmed)) return false;
  return Number.isFinite(Number(trimmed));
}
