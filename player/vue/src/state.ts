import type {
  PlayerMessagePresentation,
  PlayerPresentation,
  PlayerRightControlPresentation,
  PlayerSessionEventPresentation,
  PlayerToolColumnState,
  PlayerToolId,
  PlayerTranscriptEntryPresentation,
} from "../../model.js";
import { addToolColumn, closeToolColumn, selectToolColumn } from "../../tool-columns.js";

export interface PlayerCoreState {
  readonly composerFeedback: string;
  readonly composerValue: string;
  readonly fixtureTranscriptEntries: readonly PlayerTranscriptEntryPresentation[];
  readonly nextActivitySequence: number;
  readonly nextToolColumnNumber: number;
  readonly rightControls: readonly PlayerRightControlPresentation[];
  readonly toolColumns: readonly PlayerToolColumnState[];
  readonly toolOrder: readonly PlayerToolId[];
}

export type PlayerCoreAction =
  | { readonly type: "add-tool-column" }
  | { readonly type: "activate-right-action"; readonly controlId: string }
  | { readonly type: "change-right-select"; readonly controlId: string; readonly value: string }
  | { readonly type: "change-right-toggle"; readonly checked: boolean; readonly controlId: string }
  | { readonly type: "close-tool-column"; readonly id: string }
  | { readonly type: "select-tool-column"; readonly id: string; readonly toolId: PlayerToolId }
  | { readonly type: "set-composer"; readonly value: string }
  | { readonly type: "set-composer-feedback"; readonly message: string }
  | { readonly type: "submit-fixture-composer" };

export function createPlayerCoreState(
  presentation: PlayerPresentation,
  toolOrder: readonly PlayerToolId[] = [],
): PlayerCoreState {
  return {
    composerFeedback: "",
    composerValue: "",
    fixtureTranscriptEntries: [],
    nextActivitySequence: 1,
    nextToolColumnNumber: 2,
    rightControls: presentation.rightControls,
    toolColumns: addToolColumn([], "tool-column-1", toolOrder),
    toolOrder,
  };
}

export function reducePlayerCoreState(
  state: PlayerCoreState,
  action: PlayerCoreAction,
): PlayerCoreState {
  switch (action.type) {
    case "add-tool-column": {
      const id = `tool-column-${state.nextToolColumnNumber}`;
      return {
        ...state,
        nextToolColumnNumber: state.nextToolColumnNumber + 1,
        toolColumns: addToolColumn(state.toolColumns, id, state.toolOrder),
      };
    }
    case "set-composer":
      return { ...state, composerFeedback: "", composerValue: action.value };
    case "set-composer-feedback":
      return { ...state, composerFeedback: action.message };
    case "submit-fixture-composer":
      return state.composerValue.trim().length === 0
        ? { ...state, composerFeedback: "Enter a response before sending." }
        : appendUserMessage(state, state.composerValue);
    case "activate-right-action":
      return activateRightAction(state, action.controlId);
    case "change-right-toggle":
      return changeRightToggle(state, action.controlId, action.checked);
    case "change-right-select":
      return changeRightSelect(state, action.controlId, action.value);
    case "select-tool-column":
      return {
        ...state,
        toolColumns: selectToolColumn(state.toolColumns, action.id, action.toolId),
      };
    case "close-tool-column":
      return state.toolColumns.length === 1
        ? state
        : { ...state, toolColumns: closeToolColumn(state.toolColumns, action.id) };
  }
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
    rightControls: state.rightControls.map((control) =>
      control.kind === "toggle" && control.id === controlId
        ? { ...control, value: checked }
        : control,
    ),
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
  if (current?.kind !== "select" || !current.options.some(([option]) => option === value))
    return state;

  const next = {
    ...state,
    rightControls: state.rightControls.map((control) =>
      control.kind === "select" && control.id === controlId ? { ...control, value } : control,
    ),
  };
  if (!current.recordUserHistory) return next;
  const label = current.options.find(([option]) => option === value)?.[1] ?? value;
  return appendSessionEvent(next, `You changed ${current.label} to ${label}.`);
}

function activateRightAction(state: PlayerCoreState, controlId: string): PlayerCoreState {
  const control = state.rightControls.find(
    (candidate) => candidate.kind === "action" && candidate.id === controlId,
  );
  return control?.kind === "action" ? appendUserMessage(state, control.label) : state;
}

function appendUserMessage(state: PlayerCoreState, text: string): PlayerCoreState {
  const message: PlayerMessagePresentation = {
    kind: "message",
    id: `fixture-activity-${state.nextActivitySequence}`,
    speakerId: "fixture-user",
    text,
  };
  return appendFixtureEntry(state, message, true);
}

function appendSessionEvent(state: PlayerCoreState, text: string): PlayerCoreState {
  const event: PlayerSessionEventPresentation = {
    kind: "session-event",
    id: `fixture-activity-${state.nextActivitySequence}`,
    text,
  };
  return appendFixtureEntry(state, event, false);
}

function appendFixtureEntry(
  state: PlayerCoreState,
  entry: PlayerTranscriptEntryPresentation,
  clearComposer: boolean,
): PlayerCoreState {
  return {
    ...state,
    composerFeedback: "",
    composerValue: clearComposer ? "" : state.composerValue,
    fixtureTranscriptEntries: [...state.fixtureTranscriptEntries, entry],
    nextActivitySequence: state.nextActivitySequence + 1,
  };
}
