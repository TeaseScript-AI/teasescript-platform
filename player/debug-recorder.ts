import type {
  CapturedMediaAdmission,
  InstructionPlan,
  InterpreterEvent,
  RuntimeSession,
  RuntimeSnapshot,
  RuntimeStatus,
} from "../src/index.js";
import { captureExternalData } from "../src/external-data-capture.js";
import {
  debugExportJson,
  rebuildRecordedSession,
  type DebugAdmissionQuery,
  type DebugOperation,
  type DebugOperationKind,
} from "./debug-export.js";
import type { PlayerRuntimeEngine } from "./runtime-adapter.js";

/** What a recorder holds for a debug export: the anchor and every engine call made since, in order. */
export interface DebugRecording {
  readonly plan: InstructionPlan;
  readonly anchorSnapshot: RuntimeSnapshot;
  readonly operations: readonly DebugOperation[];
  /**
   * The state the recorded calls reach: the session's state, or, once the recording froze, the state at its last call,
   * although the session may have observed more time since. After a call that threw, it is the state before that call,
   * rebuilt from the anchor and the calls before it.
   */
  readonly endSnapshot: RuntimeSnapshot;
  /** Whether every call since the anchor is recorded; otherwise `reason` says why not. */
  readonly complete: boolean;
  readonly reason: string | null;
}

/** An engine call's result as the recorder reads it. */
interface CallResult {
  readonly events: readonly InterpreterEvent[];
  readonly outcome?: { readonly kind: string };
  /** The session status after the call. */
  readonly status: RuntimeStatus;
}

/** A recording that froze: the log then, and the state at its last call, `null` until it is rebuilt after a throw. */
interface FrozenRecording {
  readonly anchor: RuntimeSnapshot;
  readonly operations: readonly DebugOperation[];
  end: RuntimeSnapshot | null;
}

/** How much of a session the recorder keeps; diagnostic retention, not a limit on scripts. */
export interface DebugRecorderLimits {
  readonly operations: number;
  /** Characters of recorded arguments as JSON. */
  readonly argumentBytes: number;
}

const DEFAULT_LIMITS: DebugRecorderLimits = { operations: 4096, argumentBytes: 2 * 1024 * 1024 };

/**
 * Records the engine calls of one Player's sessions so a debug export can replay them: an anchor snapshot and every
 * elementary call since, with copies of the plain arguments the Player passed, the media store's answers, and each
 * result. It observes only; a call runs exactly as it would without it, and a problem of the recorder itself only marks
 * its recording incomplete. A session that starts or is restored begins a new recording. When the recording would
 * outgrow its limits, it starts again from the state before the next call of the Player, never dropping a call in
 * between. A call that ends the session in failure, or that throws, freezes the recording, so later calls cannot evict
 * its evidence.
 *
 * The session's state stays in its engine-owned runner: the recorder exports it only where it needs a snapshot (a new
 * anchor, the end of a frozen recording, or `recording()`). Its calls also rebuild the state of the session's latest
 * publication, which is how the Player recovers after a call threw; for that, it keeps logging calls after the
 * recording froze, and after a call it could not record, it starts that log again at the Player's next call.
 */
export class DebugRecorder {
  readonly #limits: DebugRecorderLimits;
  #plan: InstructionPlan | null = null;
  /** The engine whose calls the log keeps; calls of any other engine are neither logged nor rebuilt. */
  #owner: PlayerRuntimeEngine | null = null;
  /** The log: an anchor and the calls since, which reach the session's state unless `#broken`. */
  #anchor: RuntimeSnapshot | null = null;
  #operations: DebugOperation[] = [];
  #argumentBytes = 0;
  /** Whether a call since the anchor could not be logged; the Player's next call then starts the log again. */
  #broken = false;
  /** Exports the session's current state. */
  #current: (() => RuntimeSnapshot) | null = null;
  /**
   * The latest publication of the session: its revision, and how many logged calls reach its state, or `null` when the
   * log does not reach it.
   */
  #published: { readonly revision: number; readonly operations: number | null } | null = null;
  /** The recording once it froze; until then, the recording is the log. */
  #frozen: FrozenRecording | null = null;
  #problem: string | null = null;

  constructor(limits: Partial<DebugRecorderLimits> = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Starts a new recording of `owner`'s calls from `anchor`, the state of its latest publication `revision`; `current`
   * exports the session's state whenever the recording needs it.
   */
  begin(
    plan: InstructionPlan,
    anchor: RuntimeSnapshot,
    current: () => RuntimeSnapshot,
    owner: PlayerRuntimeEngine,
    revision: number,
  ): void {
    this.#plan = plan;
    this.#owner = owner;
    this.#anchor = anchor;
    this.#operations = [];
    this.#argumentBytes = 0;
    this.#broken = false;
    this.#current = current;
    this.#published = { revision, operations: 0 };
    this.#frozen = null;
    this.#problem = null;
  }

  /** Notes that `owner` published `revision` after the calls logged so far. */
  published(owner: PlayerRuntimeEngine, revision: number): void {
    if (owner !== this.#owner) return;
    this.#published = { revision, operations: this.#broken ? null : this.#operations.length };
  }

  /** The recording so far, or `null` before any session began. */
  recording(): DebugRecording | null {
    if (this.#plan === null || this.#anchor === null || this.#current === null) return null;
    const frozen = this.#frozen;
    return {
      plan: this.#plan,
      anchorSnapshot: frozen?.anchor ?? this.#anchor,
      operations: [...(frozen?.operations ?? this.#operations)],
      endSnapshot: frozen === null ? this.#current() : this.#frozenEnd(frozen),
      complete: this.#problem === null,
      reason: this.#problem,
    };
  }

  /**
   * A runner at the state of `owner`'s publication `revision`, rebuilt from the log, which then continues from it;
   * `null` when the log does not reach that publication.
   */
  recover(owner: PlayerRuntimeEngine, revision: number): RuntimeSession | null {
    const published = this.#published;
    if (
      owner !== this.#owner ||
      this.#plan === null ||
      this.#anchor === null ||
      published?.revision !== revision ||
      published.operations === null
    )
      return null;
    const operations = this.#operations.slice(0, published.operations);
    let session: RuntimeSession;
    try {
      session = rebuildRecordedSession(this.#plan, this.#anchor, operations);
    } catch {
      return null;
    }
    // The calls after the publication, among them the one that threw, never reached the rebuilt state. The argument
    // characters they counted stay counted, so the log only starts again a little sooner.
    this.#operations = operations;
    this.#broken = false;
    return session;
  }

  /**
   * Makes `owner`'s engine call `invoke` and records it. `input` exports the state the call starts from, which the
   * recorder reads only to start again; `args` are the plain arguments the call passes after the plan and snapshot.
   * `continuation` marks the `run` that follows an accepted call, which is never a new anchor. The call receives
   * `admission` to pass to the engine in place of the Player's own media store, which still answers.
   */
  call<R extends CallResult>(
    owner: PlayerRuntimeEngine,
    kind: DebugOperationKind,
    input: () => RuntimeSnapshot,
    args: readonly unknown[],
    invoke: (admission: (store: CapturedMediaAdmission) => CapturedMediaAdmission) => R,
    continuation = false,
  ): R {
    const prepared = owner === this.#owner ? this.#prepare(input, args, continuation) : null;
    const queries: DebugAdmissionQuery[] = [];
    const admission = (store: CapturedMediaAdmission): CapturedMediaAdmission => ({
      holds: (reference, mediaKind) => {
        let result: boolean;
        try {
          result = store.holds(reference, mediaKind);
        } catch (error) {
          // The recording keeps only the store's answers, so a store that throws cannot be replayed.
          this.#problem ??= "The media store failed during a recorded call.";
          throw error;
        }
        queries.push({ reference, kind: mediaKind, result });
        return result;
      },
    });
    let result: R;
    try {
      result = invoke(admission);
    } catch (error) {
      if (prepared !== null)
        this.#add(kind, prepared, queries, null, error instanceof Error ? error.name : "Error");
      throw error;
    }
    if (prepared !== null) this.#add(kind, prepared, queries, result, null);
    return result;
  }

  /** The copied arguments to log, or `null` when this call is not logged. */
  #prepare(
    input: () => RuntimeSnapshot,
    args: readonly unknown[],
    continuation: boolean,
  ): { readonly args: unknown[]; readonly bytes: number } | null {
    // A call that continues one the log could not keep cannot be replayed either.
    if (this.#plan === null || (this.#broken && continuation)) return null;
    try {
      // JSON would turn a value such as NaN into null and replay a different call, and a cycle has no JSON form, so
      // such a call is not recorded; the engine's own validation then still refuses or admits it.
      if (!captureExternalData(args).ok) {
        this.#skip("A call's arguments could not be copied exactly.", input);
        return null;
      }
      // Written without recursion, so a deeply nested argument is recorded like any other.
      const json = debugExportJson(args);
      const bytes = json.length;
      if (bytes > this.#limits.argumentBytes) {
        this.#skip("A recorded call was larger than the recording keeps.", input);
        return null;
      }
      // The log starts again only before a call of the Player, after a call it could not keep or when it would outgrow
      // its limits; a continuation always stays with the call it continues. A call of the Player starts from the state
      // of the latest publication, so the new anchor is that publication's state.
      if (
        this.#broken ||
        (!continuation &&
          (this.#operations.length + 2 > this.#limits.operations ||
            this.#argumentBytes + bytes > this.#limits.argumentBytes))
      ) {
        this.#anchor = input();
        if (this.#published !== null)
          this.#published = { revision: this.#published.revision, operations: 0 };
        this.#operations = [];
        this.#argumentBytes = 0;
        this.#broken = false;
      }
      this.#argumentBytes += bytes;
      // A copy: the recording must not change when the Player reuses an object it passed.
      const copy: unknown = JSON.parse(json);
      if (!Array.isArray(copy)) throw new TypeError("The arguments are not a list.");
      return { args: copy, bytes };
    } catch {
      this.#skip("The recorder could not copy a call.", null);
      return null;
    }
  }

  /**
   * Leaves a call out of the log. A recording that has not frozen yet freezes, incomplete, at the state before the call,
   * which `input` exports, or which is rebuilt when it is `null`; a frozen one keeps its evidence as it was.
   */
  #skip(problem: string, input: (() => RuntimeSnapshot) | null): void {
    this.#broken = true;
    if (this.#frozen !== null) return;
    this.#problem ??= problem;
    this.#freeze(input === null ? null : input());
  }

  #freeze(end: RuntimeSnapshot | null): void {
    this.#frozen ??= { anchor: this.#anchor!, operations: [...this.#operations], end };
  }

  #add(
    kind: DebugOperationKind,
    prepared: { readonly args: unknown[] },
    admissionQueries: DebugAdmissionQuery[],
    result: CallResult | null,
    thrown: string | null,
  ): void {
    const events = result?.events ?? [];
    const status = result?.status ?? this.#operations.at(-1)?.status ?? this.#anchor!.status;
    this.#operations.push({
      seq: this.#operations.length + 1,
      kind,
      args: prepared.args,
      admissionQueries,
      outcome: result === null ? null : (result.outcome?.kind ?? "ran"),
      events: { first: events[0]?.sequence ?? null, count: events.length },
      status,
      thrown,
    });
    // A failed session still holds its state, so the end is taken now; after a throw it is rebuilt when needed.
    if (thrown !== null) this.#freeze(null);
    else if (status === "failed" && this.#frozen === null) this.#freeze(this.#current!());
  }

  /** The state at the call that froze the recording; after a throw, rebuilt from the calls before it. */
  #frozenEnd(frozen: FrozenRecording): RuntimeSnapshot {
    if (frozen.end !== null) return frozen.end;
    const before = frozen.operations.filter((operation) => operation.thrown === null);
    try {
      frozen.end = rebuildRecordedSession(this.#plan!, frozen.anchor, before).exportSnapshot();
    } catch {
      this.#problem ??= "The state before the error could not be rebuilt from the recorded calls.";
      frozen.end = frozen.anchor;
    }
    return frozen.end;
  }
}
