import {
  instructionSourcePath,
  type InstructionPlan,
  type PlanSourceLocation,
} from "../plan/model.js";
import { sourceSpanToPlanLocation } from "../plan/source-location.js";
import type { SourceSpan } from "../source.js";
import { GLOBAL_SCOPE_ID } from "./prepared-references.js";
import type { SerializableRuntimeRange, SerializableRuntimeValue } from "./serializable-values.js";
import type { RuntimeSnapshot } from "./state.js";
import { isCameraView, isMediaHandle, isTimerHandle } from "./value-predicates.js";
import { valueNotationPrefix } from "./value-text.js";

/**
 * Bounds of one trace's retained history: the oldest records are dropped first once either the record count or the
 * accounted bytes would be exceeded. Previews and dependency lists are cut while they are captured. These are tuning
 * values of the debugger, not language limits.
 */
export const RUNTIME_DEBUG_TRACE_LIMITS = Object.freeze({
  maxRecords: 8192,
  maxAccountedBytes: 8 * 1024 * 1024,
  maxPreviewCharacters: 1024,
  maxDependencies: 32,
});

/** What a trace record observed. */
export type RuntimeDebugRecordKind =
  /** `let`, a global, or a speaker got its first value. */
  | "declaration"
  /** `=`, `+=`, or `-=`, also of a property, an index, or a dict key, which gives the whole variable a new version. */
  | "assignment"
  /** A collection method changed a list, set, or dict in place. */
  | "mutation"
  /** A function call's argument, evaluated in the caller. */
  | "argument"
  /** A parameter got its argument or its default. */
  | "parameter"
  /** A `for` loop read its source; each round's variable comes from it. */
  | "loopSource"
  | "loopValue"
  /** A function returned a value to its caller. */
  | "return"
  /** An intermediate value the compiled code keeps between statements, such as a prepared message text. */
  | "temporary"
  /** The accepted answer of a question, choice, button, or photo request, or a button's timeout. */
  | "input"
  | "load"
  /** A `save` or `delete` that changed the session's storage view. */
  | "storage"
  /** A draw from the session random generator. */
  | "random"
  /** The text one `${...}` placeholder added to a string. */
  | "interpolation"
  /** A `say` message, with the event sequence it was emitted with. */
  | "output"
  /** `showImage` or `hideImage` set the Stage image. */
  | "image"
  /** A value whose origin the trace did not record; see its detail for why. */
  | "unrecorded";

export type RuntimeDebugRandomOperation =
  | "random"
  | "chance"
  | "randomInteger"
  | "collectionRandom"
  | "interpolation"
  | "shuffle"
  | "tagQuery"
  | "glob"
  | "timerRepeat"
  | "duration";

/**
 * Why a value has no recorded origin: `external` is supplied by the host, such as a configured global; `beforeDebug`
 * was set before this trace started; `restored` came with a restored checkpoint; `unavailable` may have been recorded
 * once, but older history has been dropped.
 */
export type RuntimeDebugUnrecordedReason = "external" | "beforeDebug" | "restored" | "unavailable";

export type RuntimeDebugRecordDetail =
  | {
      readonly kind: "random";
      readonly operation: RuntimeDebugRandomOperation;
      /** How many values the draw selected among, or `null` for `random()` and `chance`. */
      readonly choices: number | null;
      readonly range: {
        readonly start: number;
        readonly end: number;
        readonly inclusive: boolean;
      } | null;
      /** The number of the first draw since the trace began, counting from 1, and how many draws were made. */
      readonly firstDraw: number;
      readonly draws: number;
      /** The generator state before and after; `null` for a random source the host injected. */
      readonly stateBefore: number | null;
      readonly stateAfter: number | null;
    }
  | {
      readonly kind: "input";
      readonly actionId: number;
      readonly actionKind: "interaction" | "capture";
      readonly interactionKind: string | null;
      readonly outcome: "completed" | "timedOut";
    }
  | {
      readonly kind: "load";
      readonly key: string;
      /** Whether the key was stored; when it was not, `defaultEvaluated` tells whether a default ran. */
      readonly found: boolean;
      readonly defaultEvaluated: boolean;
    }
  | {
      readonly kind: "storage";
      readonly key: string;
      readonly deleted: boolean;
      /** Set by a debugging tool's edit (`applyExternalStorageEdit`) rather than by the script. */
      readonly edited: boolean;
    }
  | { readonly kind: "output"; readonly eventSequence: number }
  | {
      readonly kind: "call";
      readonly functionName: string;
      readonly parameter: string | null;
      /** A parameter that got its default value. */
      readonly defaulted: boolean;
    }
  | { readonly kind: "unrecorded"; readonly reason: RuntimeDebugUnrecordedReason };

/** A one-based source location in a package file. */
export interface RuntimeDebugLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** A cause of a record. A dependency that is no longer retained shows as expired: its history has been dropped. */
export interface RuntimeDebugDependency {
  readonly id: number;
  readonly retained: boolean;
}

/** A detached, JSON-safe view of one trace record. */
export interface RuntimeDebugRecord {
  readonly id: number;
  readonly epoch: number;
  readonly kind: RuntimeDebugRecordKind;
  /** The variable, function, or storage key the record is about, or `null`. */
  readonly target: string | null;
  readonly location: RuntimeDebugLocation | null;
  readonly sceneTimeMs: number;
  /** The value then, in `say` notation, cut to the preview limit; `null` when the record holds no value. */
  readonly preview: string | null;
  readonly previewTruncated: boolean;
  readonly dependencies: readonly RuntimeDebugDependency[];
  /** Further causes beyond the dependency limit, which were not kept. */
  readonly omittedDependencies: number;
  readonly detail: RuntimeDebugRecordDetail | null;
  /** The variable whose version the record is, for `variableRecord`: a scope ID or `"global"`, and its name. */
  readonly variable: { readonly scope: number | "global"; readonly name: string } | null;
}

/** How the current epoch began: from Start, from a restored checkpoint, or by attaching to a running session. */
export type RuntimeDebugTraceOrigin = "start" | "restore" | "attach";

export interface RuntimeDebugTraceStatus {
  readonly epoch: number;
  readonly origin: RuntimeDebugTraceOrigin;
  /** `false` after a recording failure, until the next `reset`. */
  readonly recording: boolean;
  readonly failure: string | null;
  readonly records: number;
  /** The oldest and newest retained record IDs, or `null` without records; IDs in between are consecutive. */
  readonly firstRecord: number | null;
  readonly lastRecord: number | null;
  readonly accountedBytes: number;
  /** Whether older records of this epoch have been dropped. */
  readonly truncated: boolean;
  /** Random draws recorded in this epoch. */
  readonly draws: number;
  /**
   * The generator state when the epoch began: the session's seed after Start, otherwise the restored or current state.
   * `null` before the first operation.
   */
  readonly rngAnchorState: number | null;
  /**
   * The sequence the first event of this epoch has or will have: earlier messages were shown before the epoch began.
   * `null` before the first operation.
   */
  readonly firstEventSequence: number | null;
}

export interface RuntimeDebugTraceOptions {
  readonly maxRecords?: number;
  readonly maxAccountedBytes?: number;
}

/** A source span as the runtime carries it: plan provenance, or a rich span copied from it. */
type TraceSpan = PlanSourceLocation | SourceSpan;

const STORE = Symbol("runtimeDebugTraceStore");

/**
 * An opt-in record of why runtime values have the values they have: a host-owned sidecar that runtime operations
 * receive through their optional `debugTrace` option. It observes values the operation computes anyway; it never
 * evaluates, draws random numbers, or reads storage itself, and it is not part of snapshots, events, or checkpoints.
 * See `docs/RUNTIME.md#debug-trace`.
 */
export class RuntimeDebugContext {
  /** @internal */
  public readonly [STORE]: TraceStore;

  public constructor(options: RuntimeDebugTraceOptions = {}) {
    this[STORE] = new TraceStore(
      positiveLimit(options.maxRecords, RUNTIME_DEBUG_TRACE_LIMITS.maxRecords),
      positiveLimit(options.maxAccountedBytes, RUNTIME_DEBUG_TRACE_LIMITS.maxAccountedBytes),
    );
  }

  /**
   * Begins a new epoch, dropping every record: `start` before a session starts, `restore` before a restored session
   * runs. The next operation anchors the epoch at its snapshot.
   */
  public reset(origin: "start" | "restore"): void {
    this[STORE].reset(origin);
  }

  public status(): RuntimeDebugTraceStatus {
    return this[STORE].status();
  }

  /** A retained record of the current epoch, or `null`. */
  public record(id: number): RuntimeDebugRecord | null {
    return this[STORE].view(id);
  }

  /** The output record of the `say` event with this sequence in the current epoch, or `null`. */
  public outputRecord(eventSequence: number): number | null {
    return this[STORE].outputRecord(eventSequence);
  }

  /** The newest retained output records, newest first. */
  public outputs(limit = 20): readonly number[] {
    return this[STORE].newest("output", limit);
  }

  /** The record of a variable's current version: a scope ID from the snapshot, or `"global"`. */
  public variableRecord(scope: number | "global", name: string): number | null {
    return this[STORE].current(bindingKey(scope === "global" ? GLOBAL_SCOPE_ID : scope, name));
  }

  /** The record of the current version of a stored key in the session's storage view, if this epoch wrote it. */
  public storageRecord(key: string): number | null {
    return this[STORE].current(storageKeyOf(key));
  }

  /** The record of the `showImage` or `hideImage` that set the current Stage image. */
  public stageImageRecord(): number | null {
    return this[STORE].stageImage();
  }
}

/** The trace an operation records into, or `null` when it has none or recording stopped. */
export function openDebugTrace(
  context: RuntimeDebugContext | undefined,
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): TraceStore | null {
  if (context === undefined) return null;
  // A context of another copy of this module is not this trace; the operation runs untraced rather than failing.
  const store: unknown = context[STORE];
  return store instanceof TraceStore && store.open(plan, snapshot) ? store : null;
}

/** Ends an operation: its result snapshot is the one the next operation continues from. */
export function closeDebugTrace(
  trace: TraceStore | null,
  result: { readonly snapshot: RuntimeSnapshot },
): void {
  trace?.close(result.snapshot);
}

/** Causes collected while values are evaluated, deduplicated and capped. */
export interface DebugDependencies {
  ids: number[];
  omitted: number;
}

export function emptyDependencies(): DebugDependencies {
  return { ids: [], omitted: 0 };
}

interface TraceRecord {
  readonly id: number;
  readonly kind: RuntimeDebugRecordKind;
  readonly key: string | null;
  readonly target: string | null;
  readonly instruction: number | null;
  readonly span: PlanSourceLocation | null;
  readonly sceneTimeMs: number;
  preview: string | null;
  previewTruncated: boolean;
  readonly dependencies: readonly number[];
  readonly omitted: number;
  readonly detail: RuntimeDebugRecordDetail | null;
  bytes: number;
  /** Further index keys that name this record, dropped with it. */
  aliases: string[] | null;
}

interface Stage {
  readonly nextId: number;
  readonly draws: number;
  readonly pendingOutput: TraceStore["pendingOutput"];
  readonly pendingStorage: TraceStore["pendingStorage"];
  readonly stageImageId: number | null;
  readonly lastRandom: TraceRecord | null;
  readonly versions: Map<string, number | undefined>;
  readonly outputs: number[];
}

/** Bytes counted for a record besides its text, and for a version-index entry besides its key. */
const RECORD_OVERHEAD_BYTES = 160;
const INDEX_OVERHEAD_BYTES = 48;

/**
 * The recorder behind a `RuntimeDebugContext`. Every recording method is guarded: a failure stops recording and is
 * reported in `status()`, and never reaches the script's execution.
 */
export class TraceStore {
  /** Retained records from `#head` on; dropped slots before it are emptied so their data can be released. */
  #records: (TraceRecord | undefined)[] = [];
  #head = 0;
  #nextId = 1;
  #bytes = 0;
  #versions = new Map<string, number>();
  #outputs = new Map<number, number>();
  #stageImageId: number | null = null;
  pendingOutput: { readonly instruction: number; readonly deps: DebugDependencies } | null = null;
  pendingStorage: {
    readonly actionId: number;
    readonly key: string;
    readonly value: SerializableRuntimeValue;
    readonly instruction: number;
    readonly deps: DebugDependencies;
  } | null = null;
  #lastRandom: TraceRecord | null = null;
  #stage: Stage | null = null;

  #epoch = 0;
  #origin: RuntimeDebugTraceOrigin = "attach";
  #pendingOrigin: "start" | "restore" | null = null;
  #truncated = false;
  #draws = 0;
  #rngAnchorState: number | null = null;
  #firstEventSequence: number | null = null;
  #failure: string | null = null;
  #plan: InstructionPlan | null = null;
  #last: WeakRef<RuntimeSnapshot> | null = null;

  /** Where records are attributed now. */
  #instruction: number | null = null;
  #sceneTimeMs = 0;
  /** The collector of the value being evaluated now. */
  acc: DebugDependencies = emptyDependencies();

  public constructor(
    private readonly maxRecords: number,
    private readonly maxBytes: number,
  ) {}

  reset(origin: "start" | "restore"): void {
    this.#clear();
    this.#epoch += 1;
    this.#pendingOrigin = origin;
    this.#last = null;
    this.#failure = null;
  }

  open(plan: InstructionPlan, snapshot: RuntimeSnapshot): boolean {
    if (this.#failure !== null) return false;
    try {
      const continues =
        this.#pendingOrigin === null && this.#plan === plan && this.#last?.deref() === snapshot;
      if (!continues) {
        // Another plan, a snapshot that is not the last result, or an explicit reset: earlier links cannot be trusted.
        const origin =
          this.#pendingOrigin ??
          (snapshot.status === "ready" && snapshot.nextInstruction === 0 ? "start" : "attach");
        // A reset already began the epoch.
        if (this.#pendingOrigin === null) {
          this.#clear();
          this.#epoch += 1;
        }
        this.#origin = origin;
        this.#pendingOrigin = null;
        this.#plan = plan;
        this.#rngAnchorState = snapshot.rng.state;
        this.#firstEventSequence = snapshot.nextEventSequence;
      }
      this.#sceneTimeMs = snapshot.currentSessionTimeMs;
      this.#instruction = null;
      this.acc = emptyDependencies();
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  close(snapshot: RuntimeSnapshot): void {
    if (this.#failure !== null) return;
    this.#last = new WeakRef(snapshot);
    if (this.#stage !== null) this.#endStage(this.#stage);
  }

  #clear(): void {
    this.#records = [];
    this.#head = 0;
    this.#bytes = 0;
    this.#versions = new Map();
    this.#outputs = new Map();
    this.#stageImageId = null;
    this.pendingOutput = null;
    this.pendingStorage = null;
    this.#lastRandom = null;
    this.#stage = null;
    this.#truncated = false;
    this.#draws = 0;
    this.#rngAnchorState = null;
    this.#firstEventSequence = null;
    this.#plan = null;
    this.acc = emptyDependencies();
  }

  #fail(error: unknown): void {
    this.#failure = error instanceof Error ? error.message : String(error);
    this.#records = [];
    this.#head = 0;
    this.#bytes = 0;
    this.#versions = new Map();
    this.#outputs = new Map();
    this.#stage = null;
  }

  /** Attributes the following records to an instruction at a scene time, with a fresh collector. */
  at(instruction: number | null, sceneTimeMs: number): void {
    this.#instruction = instruction;
    this.#sceneTimeMs = sceneTimeMs;
    this.acc = emptyDependencies();
  }

  /** Collects into a fresh collector and returns the previous one, for `pop`. */
  push(): DebugDependencies {
    const previous = this.acc;
    this.acc = emptyDependencies();
    return previous;
  }

  /** Returns to `previous`, adding what was collected meanwhile to it, and returns what was collected. */
  pop(previous: DebugDependencies): DebugDependencies {
    const inner = this.acc;
    this.acc = previous;
    if (this.#failure === null) addAll(previous, inner, this.#limit());
    return inner;
  }

  /** Makes `deps` the collector of the frame being evaluated after `child` finished, which it adds. */
  focus(deps: DebugDependencies, child: DebugDependencies | null, merge: boolean): void {
    if (child !== null && merge && this.#failure === null) addAll(deps, child, this.#limit());
    this.acc = deps;
  }

  /** Replaces what the current value depends on by one record that already depends on it. */
  replace(id: number | null): void {
    if (id === null) return;
    this.acc.ids.length = 0;
    this.acc.omitted = 0;
    this.acc.ids.push(id);
  }

  readBinding(scopeId: number, name: string, value: SerializableRuntimeValue): void {
    this.#read(bindingKey(scopeId, name), name, value);
  }

  readTemporary(callFrameId: number, temporaryId: number, value: SerializableRuntimeValue): void {
    this.#read(temporaryKey(callFrameId, temporaryId), null, value);
  }

  readStorage(key: string): boolean {
    // A key longer than a preview is never indexed, so it is not looked up either.
    if (this.#failure !== null || key.length > RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters)
      return false;
    const id = this.#versions.get(storageKeyOf(key));
    if (id !== undefined) this.#add(this.acc, id);
    return id !== undefined;
  }

  #read(key: string, target: string | null, value: SerializableRuntimeValue): void {
    if (this.#failure !== null) return;
    try {
      let id = this.#versions.get(key);
      if (id === undefined) id = this.#unrecorded(key, target, value);
      this.#add(this.acc, id);
    } catch (error) {
      this.#fail(error);
    }
  }

  #unrecorded(key: string | null, target: string | null, value: SerializableRuntimeValue): number {
    const reason: RuntimeDebugUnrecordedReason = this.#truncated
      ? "unavailable"
      : this.#origin === "start"
        ? "external"
        : this.#origin === "restore"
          ? "restored"
          : "beforeDebug";
    return this.#append(
      "unrecorded",
      key,
      target,
      value,
      true,
      emptyDependencies(),
      null,
      Object.freeze({ kind: "unrecorded", reason }),
    );
  }

  /** Records a value written to `key` (or to nothing) with the current collector as its causes. */
  write(
    kind: RuntimeDebugRecordKind,
    key: string | null,
    target: string | null,
    value: SerializableRuntimeValue,
    span: TraceSpan | null = null,
    detail: RuntimeDebugRecordDetail | null = null,
    deps: DebugDependencies = this.acc,
  ): number | null {
    if (this.#failure !== null) return null;
    try {
      return this.#append(kind, key, target, value, true, deps, span, detail);
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  writeBinding(
    kind: RuntimeDebugRecordKind,
    scopeId: number,
    name: string,
    value: SerializableRuntimeValue,
    detail: RuntimeDebugRecordDetail | null = null,
    deps: DebugDependencies = this.acc,
  ): number | null {
    return this.write(kind, bindingKey(scopeId, name), name, value, null, detail, deps);
  }

  writeTemporary(
    callFrameId: number,
    temporaryId: number,
    value: SerializableRuntimeValue,
    kind: RuntimeDebugRecordKind = "temporary",
    detail: RuntimeDebugRecordDetail | null = null,
  ): number | null {
    return this.write(kind, temporaryKey(callFrameId, temporaryId), null, value, null, detail);
  }

  /**
   * A temporary that only copies one value: it gets that value's record instead of a record of its own, so a chain of
   * compiled copies does not stand between a value and its cause.
   */
  copyTemporary(callFrameId: number, temporaryId: number, value: SerializableRuntimeValue): void {
    if (this.#failure !== null) return;
    const deps = this.acc;
    if (deps.ids.length !== 1 || deps.omitted !== 0) {
      this.writeTemporary(callFrameId, temporaryId, value);
      return;
    }
    if (!this.alias(temporaryKey(callFrameId, temporaryId), deps.ids[0]!))
      this.writeTemporary(callFrameId, temporaryId, value);
  }

  /** Makes `key` name retained record `id` too; `false` when that record is no longer retained. */
  alias(key: string, id: number | null): boolean {
    if (this.#failure !== null || id === null) return false;
    try {
      const source = this.#find(id);
      if (source === undefined) return false;
      if (this.#versions.get(key) === source.id) return true;
      // The alias is accounted to its record, so it is dropped with it and counts toward the bounds.
      (source.aliases ??= []).push(key);
      const bytes = 16 + key.length * 2;
      source.bytes += bytes;
      this.#bytes += bytes;
      this.#index(key, source.id);
      this.#evict();
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  /**
   * A change of runtime state outside variables, such as a speaker or timer (`base`): one property, the timed
   * properties that a timer or media method changes, or the whole state. The change sets what it covers, so it does not
   * depend on the version it replaces, except for state that `accumulates`, such as the tagged photos.
   */
  writeState(
    kind: "declaration" | "assignment" | "mutation",
    base: string,
    part: StatePart,
    target: string,
    value: SerializableRuntimeValue,
    span: TraceSpan | null = null,
    accumulates = false,
  ): void {
    if (this.#failure !== null) return;
    const key = partKey(base, part);
    if (accumulates) {
      const previous = this.#versions.get(key);
      if (previous !== undefined) this.#add(this.acc, previous);
    }
    this.write(kind, key, target, value, span);
  }

  /**
   * A read of runtime state outside variables, of one `property` or, with `null`, of the state as a whole: the newest
   * recorded change that sets it. With `unknown`, an unrecorded state reads as an unrecorded origin; otherwise it adds
   * nothing, because the value naming the state already explains its creation.
   */
  readState(
    base: string,
    property: string | null,
    target: string | null,
    value: SerializableRuntimeValue,
    unknown: boolean,
  ): void {
    if (this.#failure !== null) return;
    try {
      let id = this.#versions.get(base);
      const newer = (key: string) => {
        const candidate = this.#versions.get(key);
        if (candidate !== undefined && (id === undefined || candidate > id)) id = candidate;
      };
      if (property !== null) newer(partKey(base, { property }));
      if (property === null || TIMED_PROPERTIES.has(property)) newer(partKey(base, "timed"));
      if (id !== undefined) this.#add(this.acc, id);
      else if (unknown) this.#add(this.acc, this.#unrecorded(base, target, value));
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Points `key` at record `id`, undone with a rolled-back stage. */
  #index(key: string, id: number): void {
    const stage = this.#stage;
    if (stage !== null && !stage.versions.has(key)) {
      stage.versions.set(key, this.#versions.get(key));
      this.#bytes += undoBytes(key);
    }
    if (!this.#versions.has(key)) this.#bytes += INDEX_OVERHEAD_BYTES + key.length * 2;
    this.#versions.set(key, id);
  }

  /** An argument of the call with frame `callFrameId`, collected in `deps`. */
  argument(
    callFrameId: number,
    functionName: string,
    parameter: string,
    value: SerializableRuntimeValue,
    deps: DebugDependencies,
  ): void {
    this.write(
      "argument",
      argumentKey(callFrameId, parameter),
      parameter,
      value,
      null,
      Object.freeze({ kind: "call", functionName, parameter, defaulted: false }),
      deps,
    );
  }

  /** A supplied parameter, which depends only on its argument. */
  suppliedParameter(
    callFrameId: number,
    scopeId: number,
    functionName: string,
    parameter: string,
    value: SerializableRuntimeValue,
  ): void {
    if (this.#failure !== null) return;
    const deps = emptyDependencies();
    this.#readKey(deps, argumentKey(callFrameId, parameter), parameter, value);
    this.writeBinding(
      "parameter",
      scopeId,
      parameter,
      value,
      Object.freeze({ kind: "call", functionName, parameter, defaulted: false }),
      deps,
    );
  }

  /** Adds the current version of `key` to `deps`, first recording that it is unknown when it is. */
  #readKey(
    deps: DebugDependencies,
    key: string | null,
    target: string | null,
    value: SerializableRuntimeValue,
  ): void {
    try {
      const id = key === null ? undefined : this.#versions.get(key);
      this.#add(deps, id ?? this.#unrecorded(key, target, value));
    } catch (error) {
      this.#fail(error);
    }
  }

  /** A loop variable of one round, which comes from the loop's source as read when the loop started. */
  loopValue(
    loopKey: string,
    source: SerializableRuntimeValue,
    scopeId: number,
    name: string,
    value: SerializableRuntimeValue,
  ): void {
    if (this.#failure !== null) return;
    const deps = emptyDependencies();
    this.#readKey(deps, loopKey, null, source);
    this.writeBinding("loopValue", scopeId, name, value, null, deps);
  }

  random(
    operation: RuntimeDebugRandomOperation,
    span: TraceSpan | null,
    choices: number | null,
    range: SerializableRuntimeRange | null,
    stateBefore: number | null,
    stateAfter: number | null,
    draws = 1,
  ): void {
    if (this.#failure !== null) return;
    try {
      const firstDraw = this.#draws + 1;
      this.#draws += draws;
      const id = this.#append(
        "random",
        null,
        null,
        null,
        false,
        emptyDependencies(),
        span,
        Object.freeze({
          kind: "random",
          operation,
          choices,
          range:
            range === null
              ? null
              : Object.freeze({ start: range.start, end: range.end, inclusive: range.inclusive }),
          firstDraw,
          draws,
          stateBefore,
          stateAfter,
        }),
      );
      this.#lastRandom = this.#find(id) ?? null;
      this.#add(this.acc, id);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** The value the last draw selected or produced. */
  randomResult(value: SerializableRuntimeValue): void {
    const record = this.#lastRandom;
    if (this.#failure !== null || record === null) return;
    try {
      const preview = previewOf(value);
      const grown = 2 * (preview.text.length - (record.preview?.length ?? 0));
      record.preview = preview.text;
      record.previewTruncated = preview.truncated;
      record.bytes += grown;
      this.#bytes += grown;
      this.#lastRandom = null;
      this.#evict();
    } catch (error) {
      this.#fail(error);
    }
  }

  /** The text one `${...}` placeholder added: its causes were collected in `child`; the string depends on it. */
  interpolation(child: DebugDependencies, text: string, span: TraceSpan): void {
    const id = this.write("interpolation", null, null, text, span, null, child);
    if (id !== null) this.#add(this.acc, id);
  }

  load(
    key: string,
    found: boolean,
    defaultEvaluated: boolean,
    value: SerializableRuntimeValue,
    span: TraceSpan,
  ): void {
    if (this.#failure !== null) return;
    this.replace(
      this.write(
        "load",
        null,
        clip(key),
        value,
        span,
        Object.freeze({ kind: "load", key: clip(key), found, defaultEvaluated }),
      ),
    );
  }

  /** A write to the session's storage view: the script's, or a debugging tool's edit, which has no causes. */
  storage(key: string, value: SerializableRuntimeValue, edited = false): void {
    // A key longer than a preview is not indexed: a later load of it shows no recorded save.
    this.write(
      "storage",
      key.length > RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters ? null : storageKeyOf(key),
      clip(key),
      value,
      null,
      Object.freeze({ kind: "storage", key: clip(key), deleted: value === null, edited }),
      edited ? emptyDependencies() : this.acc,
    );
  }

  /** A persistent write waits for the host; its causes wait with it. */
  awaitStorage(actionId: number, key: string, value: SerializableRuntimeValue): void {
    if (this.#failure !== null || this.#instruction === null) return;
    this.pendingStorage = {
      actionId,
      key,
      value,
      instruction: this.#instruction,
      deps: copyDependencies(this.acc),
    };
  }

  storageSettled(actionId: number, stored: boolean): void {
    const pending = this.pendingStorage;
    if (this.#failure !== null || pending?.actionId !== actionId) return;
    this.pendingStorage = null;
    if (!stored) return;
    this.#instruction = pending.instruction;
    this.acc = pending.deps;
    this.storage(pending.key, pending.value);
  }

  /** A `say` emitted now with event `sequence`; its text's causes are `deps`. */
  output(eventSequence: number, text: string, deps: DebugDependencies): void {
    const id = this.write(
      "output",
      null,
      null,
      text,
      null,
      Object.freeze({ kind: "output", eventSequence }),
      deps,
    );
    // An output larger than the budget is dropped at once and gets no index entry.
    if (id === null || this.#find(id) === undefined) return;
    this.#outputs.set(eventSequence, id);
    this.#stage?.outputs.push(eventSequence);
  }

  /** A `say` whose text waits behind pacing; it is emitted by a later operation. */
  holdOutput(instruction: number, deps: DebugDependencies): void {
    if (this.#failure !== null) return;
    this.pendingOutput = { instruction, deps: copyDependencies(deps) };
  }

  /** Emits held output, or, when the trace did not see it prepared, output whose causes are unavailable. */
  releaseOutput(eventSequence: number, instruction: number, text: string): void {
    if (this.#failure !== null) return;
    const pending = this.pendingOutput;
    this.pendingOutput = null;
    let deps: DebugDependencies;
    if (pending?.instruction === instruction) deps = pending.deps;
    else {
      deps = emptyDependencies();
      this.#readKey(deps, null, null, text);
    }
    this.output(eventSequence, text, deps);
  }

  image(value: SerializableRuntimeValue): void {
    const id = this.write("image", null, "Stage image", value);
    if (id !== null) this.#stageImageId = id;
  }

  /**
   * Starts staging: records until `commit` disappear with `rollback`, as the staged runtime state does. Staged records
   * count toward the bounds like any others.
   */
  stage(): Stage | null {
    if (this.#failure !== null) return null;
    const stage: Stage = {
      nextId: this.#nextId,
      draws: this.#draws,
      pendingOutput: this.pendingOutput,
      pendingStorage: this.pendingStorage,
      stageImageId: this.#stageImageId,
      lastRandom: this.#lastRandom,
      versions: new Map(),
      outputs: [],
    };
    this.#stage = stage;
    return stage;
  }

  commit(stage: Stage | null): void {
    if (stage === null || this.#stage !== stage) return;
    this.#endStage(stage);
    if (this.#failure !== null) return;
    try {
      this.#evict();
    } catch (error) {
      this.#fail(error);
    }
  }

  rollback(stage: Stage | null): void {
    if (stage === null || this.#stage !== stage) return;
    this.#endStage(stage);
    if (this.#failure !== null) return;
    try {
      // Staged records still retained are the newest; older ones the bounds dropped meanwhile stay dropped.
      while (this.#records.length > this.#head && this.#records.at(-1)!.id >= stage.nextId)
        this.#bytes -= this.#records.pop()!.bytes;
      this.#nextId = stage.nextId;
      this.#draws = stage.draws;
      this.pendingOutput = stage.pendingOutput;
      this.pendingStorage = stage.pendingStorage;
      this.#stageImageId =
        stage.stageImageId !== null && this.#find(stage.stageImageId) !== undefined
          ? stage.stageImageId
          : null;
      this.#lastRandom =
        stage.lastRandom !== null && this.#find(stage.lastRandom.id) === stage.lastRandom
          ? stage.lastRandom
          : null;
      for (const [key, id] of stage.versions) {
        const indexed = this.#versions.has(key);
        if (id !== undefined && this.#find(id) !== undefined) {
          if (!indexed) this.#bytes += INDEX_OVERHEAD_BYTES + key.length * 2;
          this.#versions.set(key, id);
        } else if (indexed) {
          this.#versions.delete(key);
          this.#bytes -= INDEX_OVERHEAD_BYTES + key.length * 2;
        }
      }
      for (const sequence of stage.outputs) this.#outputs.delete(sequence);
    } catch (error) {
      this.#fail(error);
    }
  }

  #append(
    kind: RuntimeDebugRecordKind,
    key: string | null,
    target: string | null,
    value: SerializableRuntimeValue,
    hasValue: boolean,
    deps: DebugDependencies,
    span: TraceSpan | null,
    detail: RuntimeDebugRecordDetail | null,
  ): number {
    const preview = hasValue ? previewOf(value) : null;
    const record: TraceRecord = {
      id: this.#nextId,
      kind,
      key,
      target,
      instruction: this.#instruction,
      span: span === null || "sl" in span ? span : sourceSpanToPlanLocation(span),
      sceneTimeMs: this.#sceneTimeMs,
      preview: preview?.text ?? null,
      previewTruncated: preview?.truncated ?? false,
      dependencies: Object.freeze([...deps.ids]),
      omitted: deps.omitted,
      detail,
      bytes: 0,
      aliases: null,
    };
    record.bytes = recordBytes(record);
    this.#nextId += 1;
    this.#records.push(record);
    this.#bytes += record.bytes;
    if (key !== null) this.#index(key, record.id);
    this.#evict();
    return record.id;
  }

  /** Drops the oldest records, with the index entries that still name them, until the trace fits its bounds. */
  #evict(): void {
    while (
      this.#records.length > this.#head &&
      (this.#records.length - this.#head > this.maxRecords || this.#bytes > this.maxBytes)
    ) {
      const record = this.#records[this.#head]!;
      this.#records[this.#head] = undefined;
      this.#head += 1;
      this.#truncated = true;
      this.#bytes -= record.bytes;
      for (const key of record.aliases === null ? [record.key] : [record.key, ...record.aliases]) {
        if (key === null) continue;
        if (this.#versions.get(key) === record.id) {
          this.#versions.delete(key);
          this.#bytes -= INDEX_OVERHEAD_BYTES + key.length * 2;
        }
        this.#forgetUndo(key, record.id);
      }
      if (record.detail?.kind === "output") this.#outputs.delete(record.detail.eventSequence);
      if (this.#stageImageId === record.id) this.#stageImageId = null;
      if (this.#lastRandom === record) this.#lastRandom = null;
    }
    // Compact the queue once its dropped prefix is as long as what it retains.
    if (this.#head > 1024 && this.#head * 2 > this.#records.length) {
      this.#records = this.#records.slice(this.#head);
      this.#head = 0;
    }
  }

  /**
   * Keeps a stage's undo entries bounded by what the trace retains: once `key` is no longer indexed and its earlier
   * version is gone, rollback has nothing to restore or remove for it. A key the stage indexes again records a new
   * entry.
   */
  #forgetUndo(key: string, dropped: number): void {
    const undo = this.#stage?.versions;
    if (undo === undefined || !undo.has(key)) return;
    const previous = undo.get(key);
    const gone =
      previous === undefined || previous === dropped || this.#find(previous) === undefined;
    if (!gone) return;
    if (this.#versions.has(key)) undo.set(key, undefined);
    else {
      undo.delete(key);
      this.#bytes -= undoBytes(key);
    }
  }

  /** Ends a stage: its undo entries stop counting. */
  #endStage(stage: Stage): void {
    this.#stage = null;
    for (const key of stage.versions.keys()) this.#bytes -= undoBytes(key);
  }

  #limit(): number {
    return RUNTIME_DEBUG_TRACE_LIMITS.maxDependencies;
  }

  #add(deps: DebugDependencies, id: number): void {
    addDependency(deps, id, this.#limit());
  }

  #find(id: number): TraceRecord | undefined {
    if (this.#records.length === this.#head) return undefined;
    const first = this.#records[this.#head]!.id;
    // IDs are consecutive in the queue: rollback reuses the IDs it removes. Dropped records before the head are gone.
    if (id < first) return undefined;
    const record = this.#records[this.#head + (id - first)];
    return record?.id === id ? record : undefined;
  }

  current(key: string): number | null {
    return this.#versions.get(key) ?? null;
  }

  outputRecord(eventSequence: number): number | null {
    return this.#outputs.get(eventSequence) ?? null;
  }

  stageImage(): number | null {
    return this.#stageImageId;
  }

  newest(kind: RuntimeDebugRecordKind, limit: number): readonly number[] {
    const ids: number[] = [];
    for (
      let index = this.#records.length - 1;
      index >= this.#head && ids.length < limit;
      index -= 1
    ) {
      const record = this.#records[index]!;
      if (record.kind === kind) ids.push(record.id);
    }
    return Object.freeze(ids);
  }

  view(id: number): RuntimeDebugRecord | null {
    const record = this.#find(id);
    if (record === undefined) return null;
    const plan = this.#plan;
    const span =
      record.span ??
      (record.instruction === null || plan === null
        ? null
        : (plan.instructions[record.instruction]?.span ?? null));
    return Object.freeze({
      id: record.id,
      epoch: this.#epoch,
      kind: record.kind,
      target: record.target,
      location:
        span === null || plan === null || record.instruction === null
          ? null
          : Object.freeze({
              path: instructionSourcePath(plan, record.instruction),
              line: span.sl + 1,
              column: span.sc + 1,
              endLine: span.el + 1,
              endColumn: span.ec + 1,
            }),
      sceneTimeMs: record.sceneTimeMs,
      preview: record.preview,
      previewTruncated: record.previewTruncated,
      dependencies: Object.freeze(
        record.dependencies.map((dependency) =>
          Object.freeze({ id: dependency, retained: this.#find(dependency) !== undefined }),
        ),
      ),
      omittedDependencies: record.omitted,
      detail: record.detail,
      variable: variableOf(record.key),
    });
  }

  status(): RuntimeDebugTraceStatus {
    return Object.freeze({
      epoch: this.#epoch,
      origin: this.#pendingOrigin ?? this.#origin,
      recording: this.#failure === null,
      failure: this.#failure,
      records: this.#records.length - this.#head,
      firstRecord: this.#records[this.#head]?.id ?? null,
      lastRecord: this.#records.at(-1)?.id ?? null,
      accountedBytes: this.#bytes,
      truncated: this.#truncated,
      draws: this.#draws,
      rngAnchorState: this.#rngAnchorState,
      firstEventSequence: this.#firstEventSequence,
    });
  }
}

export function bindingKey(scopeId: number, name: string): string {
  return `b${scopeId}:${name}`;
}

function temporaryKey(callFrameId: number, temporaryId: number): string {
  return `t${callFrameId}:${temporaryId}`;
}

function argumentKey(callFrameId: number, parameter: string): string {
  return `a${callFrameId}:${parameter}`;
}

/**
 * Runtime state that values are read from besides variables: a speaker's properties, a timer, media, or permanent
 * button, the camera view, and the catalog of tagged photos.
 */
export function stateKey(
  kind: "speaker" | "timer" | "media" | "button" | "camera" | "photos",
  id = 0,
): string {
  return `x${kind}:${id}`;
}

/** The part of a state a change sets; see `TraceStore.writeState`. */
export type StatePart = { readonly property: string } | "timed" | "whole";

/** Properties of a timer or media handle that its pause, resume, and stop methods change. */
const TIMED_PROPERTIES: ReadonlySet<string> = new Set([
  "remaining",
  "elapsed",
  "state",
  "position",
]);

function partKey(base: string, part: StatePart): string {
  return part === "whole" ? base : part === "timed" ? `${base}#timed` : `${base}.${part.property}`;
}

export function loopKey(callFrameId: number, loopId: number): string {
  return `l${callFrameId}:${loopId}`;
}

function storageKeyOf(key: string): string {
  return `s${key}`;
}

function addDependency(deps: DebugDependencies, id: number, limit: number): void {
  if (deps.ids.includes(id)) return;
  if (deps.ids.length < limit) deps.ids.push(id);
  else deps.omitted += 1;
}

function addAll(target: DebugDependencies, source: DebugDependencies, limit: number): void {
  for (const id of source.ids) addDependency(target, id, limit);
  target.omitted += source.omitted;
}

/** Bytes counted for a stage's undo entry of `key`, which it keeps while the stage lasts. */
function undoBytes(key: string): number {
  return INDEX_OVERHEAD_BYTES + key.length * 2;
}

/** Text the trace keeps as a label, cut like a preview. */
function clip(text: string): string {
  return text.length > RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters
    ? text.slice(0, RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters)
    : text;
}

function copyDependencies(deps: DebugDependencies): DebugDependencies {
  return { ids: [...deps.ids], omitted: deps.omitted };
}

const PREVIEW_SPAN: PlanSourceLocation = Object.freeze({
  so: 0,
  sl: 0,
  sc: 0,
  eo: 0,
  el: 0,
  ec: 0,
});

/** The variable a binding key names, or `null` for any other key. */
function variableOf(
  key: string | null,
): { readonly scope: number | "global"; readonly name: string } | null {
  if (key === null || !key.startsWith("b")) return null;
  const separator = key.indexOf(":");
  const scope = Number(key.slice(1, separator));
  return Object.freeze({
    scope: scope === GLOBAL_SCOPE_ID ? ("global" as const) : scope,
    name: key.slice(separator + 1),
  });
}

/**
 * A value as the trace previews it: `say` notation cut at `RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters` while it is
 * written, so a debugger can show a live value the same way as a recorded one.
 */
export function runtimeDebugPreview(value: SerializableRuntimeValue): {
  readonly text: string;
  readonly truncated: boolean;
} {
  return previewOf(value);
}

function previewOf(value: SerializableRuntimeValue): { text: string; truncated: boolean } {
  return valueNotationPrefix(
    value,
    PREVIEW_SPAN,
    (handle) =>
      isTimerHandle(handle)
        ? "<timer>"
        : isMediaHandle(handle)
          ? "<media>"
          : isCameraView(handle)
            ? "<camera>"
            : "<permanent button>",
    RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters,
  );
}

function recordBytes(record: TraceRecord): number {
  return (
    RECORD_OVERHEAD_BYTES +
    2 * ((record.preview?.length ?? 0) + (record.target?.length ?? 0) + (record.key?.length ?? 0)) +
    8 * record.dependencies.length
  );
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
