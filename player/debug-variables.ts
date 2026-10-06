import {
  RUNTIME_DEBUG_TRACE_LIMITS,
  runtimeDebugPreview,
  type RuntimeDebugContext,
  type RuntimeDebugRecord,
  type RuntimeScopeFrameSnapshot,
  type RuntimeSnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { instructionSourcePath, type InstructionPlan } from "../src/plan/model.js";
import { quotedText } from "../src/runtime/value-text.js";
import { playerRuntimeTranscriptMessage, type PlayerRuntimeSession } from "./runtime-adapter.js";

/**
 * Player Debug's Variables view (DEBUGGER.md "Player Debug"): live variables grouped by where they live, and the trace's
 * records as rows of a derivation tree. Everything here is derived on demand from the session and its value trace
 * (`docs/RUNTIME.md#debug-trace`); nothing is stored or recomputed from source.
 */

/** One live variable with its value now and the trace record of its current version, if any. */
export interface PlayerDebugVariable {
  readonly name: string;
  /** The scope ID the trace keys it by, or `"global"`. */
  readonly scope: number | "global";
  readonly value: string;
  readonly truncated: boolean;
  /** The trace record of the current version, or `null` when the trace has none. */
  readonly record: number | null;
}

/** Variables that live together: the globals, a file's top level, a function or block call, or kept for blocks. */
export interface PlayerDebugVariableGroup {
  readonly key: string;
  readonly label: string;
  readonly variables: readonly PlayerDebugVariable[];
}

/**
 * The session's live variables by group: globals first, then each file activation and each function or block call in
 * stack order, then variables kept only because a block shares them. `filter` keeps names that contain it, ignoring case.
 */
export function playerDebugVariables(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  trace: RuntimeDebugContext | null,
  filter = "",
): readonly PlayerDebugVariableGroup[] {
  const wanted = filter.trim().toLowerCase();
  const groups = new Map<string, { label: string; variables: PlayerDebugVariable[] }>();
  const add = (
    key: string,
    label: string,
    scope: number | "global",
    name: string,
    value: SerializableRuntimeValue,
  ) => {
    if (wanted !== "" && !name.toLowerCase().includes(wanted)) return;
    let group = groups.get(key);
    if (group === undefined) {
      group = { label, variables: [] };
      groups.set(key, group);
    }
    const preview = livePreview(snapshot, value);
    group.variables.push(
      Object.freeze({
        name,
        scope,
        value: preview.text,
        truncated: preview.truncated,
        record: trace?.variableRecord(scope, name) ?? null,
      }),
    );
  };
  for (const binding of snapshot.globals)
    add("globals", "Globals", "global", binding.name, binding.value);

  const filePath = (file: number) => plan.files[file]?.path ?? "?";
  const calls = snapshot.callFrames;
  let root: RuntimeScopeFrameSnapshot | null = null;
  for (let index = 0, call = -1; index < snapshot.frames.length; index += 1) {
    const frame = snapshot.frames[index]!;
    while (call + 1 < calls.length && calls[call + 1]!.scopeBaseDepth <= index) call += 1;
    if (frame.file !== null) root = frame;
    const owner = call < 0 ? null : calls[call]!;
    let key: string;
    let label: string;
    if (owner?.kind === "function") {
      const definition = plan.functions[owner.functionId - 1];
      const where =
        definition === undefined
          ? ""
          : ` in ${instructionSourcePath(plan, definition.entryInstruction)}`;
      key = `call:${owner.id}`;
      label =
        definition?.handler === "timer"
          ? `Timer block${where}`
          : definition?.handler === "media"
            ? `Media cue block${where}`
            : definition?.handler === "button"
              ? `Button block${where}`
              : `${owner.functionName}()${where}`;
    } else {
      key = `root:${root?.id ?? frame.id}`;
      label = root === null || root.file === null ? "Top level" : filePath(root.file);
    }
    for (const binding of frame.bindings) add(key, label, frame.id, binding.name, binding.value);
  }
  for (const frame of snapshot.retainedScopes) {
    const label =
      frame.file === null
        ? "Kept for timer, media, and button blocks"
        : `${filePath(frame.file)} (left, kept for blocks)`;
    for (const binding of frame.bindings)
      add(`kept:${frame.id}`, label, frame.id, binding.name, binding.value);
  }
  return Object.freeze(
    [...groups].map(([key, group]) =>
      Object.freeze({ key, label: group.label, variables: Object.freeze(group.variables) }),
    ),
  );
}

/** A value as the trace previews it; a message handle also shows the text its message has now. */
function livePreview(
  snapshot: RuntimeSnapshot,
  value: SerializableRuntimeValue,
): { readonly text: string; readonly truncated: boolean } {
  const preview = runtimeDebugPreview(value);
  if (typeof value !== "object" || value === null || value.kind !== "messageHandle") return preview;
  const text = snapshot.liveMessages.find(
    (message) => message.messageId === value.messageId,
  )?.sourceText;
  if (text === undefined) return preview;
  const limit = RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters;
  return {
    text: `<message ${value.messageId} ${quotedText(text.slice(0, limit))}>`,
    truncated: text.length > limit,
  };
}

/**
 * The Variables view's recent chat: the newest `limit` messages the trace recorded, newest first, each as the record of
 * the content it shows now, so that a changed message is explained by its latest change while the trace keeps that.
 */
export function playerDebugRecentChat(
  trace: RuntimeDebugContext,
  session: PlayerRuntimeSession,
  limit: number,
): readonly number[] {
  return trace.outputs(limit).map((id) => {
    const detail = trace.record(id)?.detail;
    const message =
      detail?.kind === "output"
        ? playerRuntimeTranscriptMessage(session, `runtime-event-${detail.eventSequence}`)
        : null;
    const latest =
      message?.contentSequence === undefined ? null : trace.outputRecord(message.contentSequence);
    return latest ?? id;
  });
}

/** A row of the derivation tree: a record, a dropped record, a record shown above, or a summary of hidden causes. */
export type PlayerDebugTraceRow =
  | {
      readonly kind: "record";
      readonly key: string;
      readonly depth: number;
      readonly id: number;
      readonly text: PlayerDebugRecordText;
      /** Whether the record has causes to show, and whether they are shown. */
      readonly expandable: boolean;
      readonly expanded: boolean;
    }
  | { readonly kind: "expired"; readonly key: string; readonly depth: number; readonly id: number }
  /** A record already shown above in the same tree; `target` is the key of its row. */
  | {
      readonly kind: "reference";
      readonly key: string;
      readonly depth: number;
      readonly id: number;
      readonly target: string;
      readonly text: PlayerDebugRecordText;
    }
  /** Causes the trace counted but did not keep. */
  | {
      readonly kind: "omitted";
      readonly key: string;
      readonly depth: number;
      readonly count: number;
    }
  /** Further causes of row `parent` beyond the pages shown. */
  | {
      readonly kind: "more";
      readonly key: string;
      readonly depth: number;
      readonly parent: string;
      readonly remaining: number;
    };

/** Records that can pass a value on unchanged. */
const CARRIERS: ReadonlySet<RuntimeDebugRecord["kind"]> = new Set([
  "declaration",
  "assignment",
  "argument",
  "parameter",
  "return",
  "temporary",
]);

/** Children shown per page under one row. */
export const PLAYER_DEBUG_TRACE_PAGE = 20;

export interface PlayerDebugTraceView {
  /**
   * Whether a row is expanded: the player's choice, else the default for its depth and kind. `carried` is whether the
   * record only passes on the value of the row above: a variable, argument, parameter, or return value with the same
   * value, such as the parameter and the argument that brought a message into a function.
   */
  readonly expanded: (
    key: string,
    record: RuntimeDebugRecord,
    depth: number,
    carried: boolean,
  ) => boolean;
  /** How many pages of a row's causes are shown; one by default. */
  readonly pages: (key: string) => number;
}

/**
 * The visible rows of the trees under `roots`, depth first, built iteratively. Only expanded rows contribute children;
 * a record that appears again in the same tree is a reference to its first row, not a second copy of its causes.
 */
export function playerDebugTraceRows(
  trace: RuntimeDebugContext,
  roots: readonly number[],
  view: PlayerDebugTraceView,
  live: PlayerDebugLiveValue | null = null,
): readonly PlayerDebugTraceRow[] {
  const rows: PlayerDebugTraceRow[] = [];
  const shown = new Map<number, string>();
  // Records to visit, and summary rows already made, popped in order.
  const pending: (
    | { id: number; key: string; depth: number; shownAs?: string | null; carried?: boolean }
    | PlayerDebugTraceRow
  )[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1)
    pending.push({ id: roots[index]!, key: `${roots[index]}`, depth: 0 });
  while (pending.length > 0) {
    const next = pending.pop()!;
    if ("kind" in next) {
      rows.push(next);
      continue;
    }
    const { id, key, depth, shownAs = null, carried = false } = next;
    const record = trace.record(id);
    if (record === null) {
      rows.push({ kind: "expired", key, depth, id });
      continue;
    }
    const text = playerDebugRecordText(trace, record, live, shownAs);
    const first = shown.get(id);
    if (first !== undefined) {
      rows.push({ kind: "reference", key, depth, id, target: first, text });
      continue;
    }
    shown.set(id, key);
    // Data causes first, then the branch decision the record happened under.
    const causes =
      record.control === null ? record.dependencies : [...record.dependencies, record.control];
    const expandable = causes.length > 0 || record.omittedDependencies > 0;
    const expanded = expandable && view.expanded(key, record, depth, carried);
    rows.push({ kind: "record", key, depth, id, text, expandable, expanded });
    if (!expanded) continue;
    const limit = PLAYER_DEBUG_TRACE_PAGE * Math.max(1, view.pages(key));
    const visible = causes.slice(0, limit);
    // Pushed in reverse, so that they pop in order: the causes, then what is not shown.
    if (record.omittedDependencies > 0 && visible.length === causes.length)
      pending.push({
        kind: "omitted",
        key: `${key}#omitted`,
        depth: depth + 1,
        count: record.omittedDependencies,
      });
    if (visible.length < causes.length)
      pending.push({
        kind: "more",
        key: `${key}#more`,
        depth: depth + 1,
        parent: key,
        remaining: causes.length - visible.length,
      });
    for (let index = visible.length - 1; index >= 0; index -= 1) {
      const cause = visible[index]!.id;
      // A placeholder that shows one value adds no explanation of its own: the value takes its place.
      const placeholder = trace.record(cause);
      const single =
        placeholder?.kind === "interpolation" &&
        placeholder.dependencies.length === 1 &&
        placeholder.omittedDependencies === 0
          ? placeholder.dependencies[0]!.id
          : null;
      pending.push(
        single === null
          ? {
              id: cause,
              key: `${key}/${cause}`,
              depth: depth + 1,
              carried:
                placeholder !== null &&
                CARRIERS.has(placeholder.kind) &&
                placeholder.preview === record.preview,
            }
          : { id: single, key: `${key}/${cause}`, depth: depth + 1, shownAs: placeholder!.preview },
      );
    }
  }
  return Object.freeze(rows);
}

/** The value a live variable has now, for comparison with an earlier recorded version. */
export type PlayerDebugLiveValue = (scope: number | "global", name: string) => string | null;

/** The live value of a variable in `snapshot`, previewed as the trace previews it; `null` once it no longer exists. */
export function playerDebugLiveValue(snapshot: RuntimeSnapshot): PlayerDebugLiveValue {
  return (scope, name) => {
    const bindings =
      scope === "global"
        ? snapshot.globals
        : (
            snapshot.frames.find((frame) => frame.id === scope) ??
            snapshot.retainedScopes.find((frame) => frame.id === scope)
          )?.bindings;
    const binding = bindings?.find((candidate) => candidate.name === name);
    return binding === undefined ? null : runtimeDebugPreview(binding.value).text;
  };
}

/** How a record reads in the Variables view. */
export interface PlayerDebugRecordText {
  /** What happened: `let spanks`, `randomInteger(10..=30)`, `answer`, … */
  readonly title: string;
  /** The value then, in code-like notation, or `null`. */
  readonly value: string | null;
  readonly truncated: boolean;
  /** A further fact, such as the draw number or why an origin is unknown, or `null`. */
  readonly note: string | null;
  /** `path:line` of the statement, or `null`. */
  readonly location: string | null;
  /** For an earlier version of a variable that has changed since, its value now; otherwise `null`. */
  readonly now: string | null;
  /** An unknown origin, shown as an honest leaf. */
  readonly unknown: boolean;
  /** The text a message showed for this value, when it differs from the value's own notation; otherwise `null`. */
  readonly shownAs: string | null;
}

const RANDOM_TITLES = {
  random: () => "random()",
  chance: () => "chance()",
  randomInteger: (range: string) => `randomInteger(${range})`,
  collectionRandom: (_range: string, choices: string) => `random pick of ${choices}`,
  randomWeighted: (_range: string, choices: string) => `weighted pick of ${choices}`,
  interpolation: (_range: string, choices: string) => `random pick of ${choices} for \${...}`,
  shuffle: (_range: string, choices: string) => `shuffle of ${choices}`,
  tagQuery: (_range: string, choices: string) => `tagged pick of ${choices}`,
  glob: (_range: string, choices: string) => `file pick of ${choices}`,
  timerRepeat: (range: string) => `repeat round from ${range} s`,
  duration: (range: string) => `random duration from ${range}`,
} as const;

const UNKNOWN_NOTES = {
  external: "Not recorded: supplied by the host",
  beforeDebug: "Not recorded before Debug",
  restored: "Restored value: earlier history unavailable",
  unavailable: "Before tracing or no longer retained",
} as const;

export function playerDebugRecordText(
  trace: RuntimeDebugContext,
  record: RuntimeDebugRecord,
  live: PlayerDebugLiveValue | null = null,
  shownAs: string | null = null,
): PlayerDebugRecordText {
  const target = record.target ?? "value";
  const detail = record.detail;
  let title: string;
  let note: string | null = null;
  switch (record.kind) {
    case "output":
      title = "Message";
      break;
    case "interpolation":
      title = "Shown as";
      break;
    case "declaration":
      title = record.variable?.scope === "global" ? `global ${target}` : `let ${target}`;
      break;
    case "assignment":
      title = `${target} =`;
      break;
    case "mutation":
      title = `${target} changed`;
      break;
    case "argument":
    case "parameter":
    case "return": {
      const call = detail?.kind === "call" ? detail : null;
      const name = call === null ? "function" : `${call.functionName}()`;
      title =
        record.kind === "argument"
          ? `argument ${target} of ${name}`
          : record.kind === "parameter"
            ? `parameter ${target} of ${name}`
            : `return from ${name}`;
      if (call?.defaulted) note = "Default value";
      break;
    }
    case "loopSource":
      title = `for ${target} in`;
      break;
    case "loopValue":
      title = `${target} (this round)`;
      break;
    case "temporary":
      title = "Intermediate value";
      break;
    case "input":
      title = detail?.kind === "input" && detail.actionKind === "capture" ? "Photo" : "Answer";
      if (detail?.kind === "input" && detail.outcome === "timedOut") note = "Timed out";
      break;
    case "load":
      title = `load ${JSON.stringify(detail?.kind === "load" ? detail.key : target)}`;
      if (detail?.kind === "load" && !detail.found)
        note = detail.defaultEvaluated ? "Not saved: default value" : "Not saved";
      else if (record.dependencies.length === 0) note = "Saved before this session";
      break;
    case "storage": {
      const key = JSON.stringify(detail?.kind === "storage" ? detail.key : target);
      title =
        detail?.kind === "storage" && detail.edited
          ? `Storage edit of ${key}`
          : detail?.kind === "storage" && detail.deleted
            ? `delete ${key}`
            : `save ${key}`;
      break;
    }
    case "random": {
      if (detail?.kind !== "random") {
        title = "random draw";
        break;
      }
      const range =
        detail.range === null
          ? ""
          : `${detail.range.start}${detail.range.inclusive ? "..=" : ".."}${detail.range.end}`;
      title = RANDOM_TITLES[detail.operation](range, String(detail.choices ?? ""));
      note =
        detail.draws === 1
          ? `draw #${detail.firstDraw}`
          : `draws #${detail.firstDraw}–#${detail.firstDraw + detail.draws - 1}`;
      if (detail.stateBefore === null) note += " · host random source";
      break;
    }
    case "image":
      title = record.preview === "null" ? "hideImage" : "showImage";
      break;
    case "decision":
      title = "Branch condition";
      break;
    case "unrecorded":
      title = target;
      note = detail?.kind === "unrecorded" ? UNKNOWN_NOTES[detail.reason] : null;
      break;
  }
  const variable = record.variable;
  const now =
    variable === null ||
    live === null ||
    trace.variableRecord(variable.scope, variable.name) === record.id
      ? null
      : live(variable.scope, variable.name);
  return Object.freeze({
    title,
    value: record.preview,
    truncated: record.previewTruncated,
    note,
    location: record.location === null ? null : `${record.location.path}:${record.location.line}`,
    now,
    unknown: record.kind === "unrecorded",
    // A number 15 shown as the text "15" is the same thing; a list shown as one of its elements is not.
    shownAs:
      shownAs === null || shownAs === record.preview || shownAs === JSON.stringify(record.preview)
        ? null
        : shownAs,
  });
}

/** Why a chat message has no record to explain, or its output record. */
export type PlayerDebugMessageOrigin =
  | { readonly kind: "record"; readonly id: number }
  | { readonly kind: "unavailable"; readonly reason: string };

const BEFORE_EPOCH = {
  start: "Shown before recording began",
  restore: "Shown before Continue: a saved point keeps no history",
  attach: "Shown before Debug was turned on",
} as const;

/**
 * The output record of the `say` event with this sequence, found by the event's identity and never by its text, or why
 * the trace has none: the message came before the current recording began, its record was dropped, or recording stopped.
 */
export function playerDebugMessageOrigin(
  trace: RuntimeDebugContext,
  eventSequence: number,
): PlayerDebugMessageOrigin {
  const id = trace.outputRecord(eventSequence);
  if (id !== null) return Object.freeze({ kind: "record", id });
  const status = trace.status();
  const reason = !status.recording
    ? "Recording stopped"
    : status.firstEventSequence === null || eventSequence < status.firstEventSequence
      ? BEFORE_EPOCH[status.origin]
      : status.truncated
        ? "Expired: older history was dropped"
        : "Not recorded";
  return Object.freeze({ kind: "unavailable", reason });
}
