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
import type { ScriptUpdateFeedback, ScriptUpdateTarget } from "./devtools/playerDevelopment.js";

export interface PlayerCoreState {
  readonly composerFeedback: string;
  readonly composerValue: string;
  readonly fixtureTranscriptEntries: readonly PlayerTranscriptEntryPresentation[];
  readonly nextActivitySequence: number;
  readonly nextToolColumnNumber: number;
  readonly rightControls: readonly PlayerRightControlPresentation[];
  readonly scriptUpdateControlId: string | null;
  readonly scriptUpdateFeedback: ScriptUpdateFeedback | null;
  readonly scriptUpdateNotice: string;
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
  | {
      readonly type: "simulate-script-update";
      readonly feedback: ScriptUpdateFeedback;
      readonly target: ScriptUpdateTarget;
    }
  | { readonly type: "clear-script-update-feedback" }
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
    scriptUpdateControlId: null,
    scriptUpdateFeedback: null,
    scriptUpdateNotice: "",
    toolColumns: addToolColumn([], "tool-column-1", toolOrder),
    toolOrder,
  };
}

export function replaceRuntimeTranscriptEntries(
  fixtureEntries: readonly PlayerTranscriptEntryPresentation[],
  runtimeEntries: readonly PlayerTranscriptEntryPresentation[],
): readonly PlayerTranscriptEntryPresentation[] {
  return [...fixtureEntries, ...runtimeEntries];
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
    case "clear-script-update-feedback":
      return {
        ...state,
        scriptUpdateControlId: null,
        scriptUpdateFeedback: null,
        scriptUpdateNotice: "",
      };
    case "simulate-script-update":
      return simulateScriptUpdate(state, action.target, action.feedback);
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

function simulateScriptUpdate(
  state: PlayerCoreState,
  target: ScriptUpdateTarget,
  feedback: ScriptUpdateFeedback,
): PlayerCoreState {
  const control = state.rightControls.find((candidate) => candidate.kind === target);
  if (control === undefined || (control.kind !== "toggle" && control.kind !== "select"))
    return state;

  const nextControl =
    control.kind === "toggle"
      ? { ...control, value: !control.value }
      : {
          ...control,
          value:
            control.options[
              (control.options.findIndex(([value]) => value === control.value) + 1) %
                control.options.length
            ]?.[0] ?? control.value,
        };
  const displayValue =
    nextControl.kind === "toggle"
      ? nextControl.value
        ? "on"
        : "off"
      : (nextControl.options.find(([value]) => value === nextControl.value)?.[1] ??
        nextControl.value);
  const notice = `Script changed ${control.label} to ${displayValue}.`;
  return appendSessionEvent(
    {
      ...state,
      rightControls: state.rightControls.map((candidate) =>
        candidate.id === control.id ? nextControl : candidate,
      ),
      scriptUpdateControlId: control.id,
      scriptUpdateFeedback: feedback,
      scriptUpdateNotice: notice,
    },
    notice,
  );
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
    speakerId: "user",
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
