import type {
  CapturedMediaAdmission,
  InstructionPlan,
  InterpreterEvent,
  RandomChoiceReceipt,
  RuntimeSession,
  RuntimeSnapshot,
  RuntimeStatus,
} from "../src/index.js";
import { captureExternalData } from "../src/external-data-capture.js";
import { RandomDecisionError } from "../src/runtime/random-control.js";
import {
  debugExportJson,
  rebuildRecordedSession,
  type DebugAdmissionQuery,
  type DebugAnswerInput,
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
  readonly randomChoices?: readonly RandomChoiceReceipt[];
  /** The ID of the random draw the session stands paused at after the call, or `null`. */
  readonly pausedAt: number | null;
}

/** A recording that froze: the log then, and the state at its last call, `null` until it is rebuilt after a throw. */
interface FrozenRecording {
  readonly anchor: RuntimeSnapshot;
  readonly operations: readonly DebugOperation[];
  end: RuntimeSnapshot | null;
}

/**
 * Where the session stands paused at a random draw as the last call left it, and whether the log's last record is the
 * call that paused there, which resolutions then continue.
 */
interface Paused {
  readonly draw: number | null;
  readonly record: boolean;
}

/** How far the log reaches the latest publication of the session; see `DebugRecorder.published`. */
interface PublishedLog {
  readonly revision: number;
  readonly operations: number | null;
  readonly last: DebugOperation | null;
  readonly paused: Paused;
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
 * its evidence. A host callback that throws during a recorded call, the media store or the random decision, leaves the
 * recording incomplete, because a replay has only the answers it gave.
 *
 * Calls on a copy of the session's runner, on which a late observation catches up, are logged as the session's once
 * it adopts the copy, and dropped with it otherwise.
 *
 * A call that pauses at a random draw stays one record: each resolution that continues it adds its events to it, and a
 * chosen one also its outcome, rather than a record of its own, so many natural resolutions add no record. When the log
 * starts again at a paused state, the next resolution is a call of its own from there.
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
   * The latest publication of the session: its revision; how many logged calls reach its state, or `null` when the log
   * does not reach it; the last of them as it was then, which a resolution may have extended since; and where the
   * session stood paused.
   */
  #published: PublishedLog | null = null;
  #paused: Paused = { draw: null, record: false };
  /** The recording once it froze; until then, the recording is the log. */
  #frozen: FrozenRecording | null = null;
  #problem: string | null = null;
  /** How the player gave the answer the calls being made pass, while `answeredBy` runs them. */
  #input: DebugAnswerInput | null = null;
  /** The log as it was before the calls being made on a copy of the session's runner; see `stage`. */
  #staged: {
    readonly anchor: RuntimeSnapshot | null;
    readonly operations: DebugOperation[];
    readonly count: number;
    readonly argumentBytes: number;
    readonly broken: boolean;
    readonly current: (() => RuntimeSnapshot) | null;
    readonly published: PublishedLog | null;
    readonly paused: Paused;
    readonly frozen: FrozenRecording | null;
    readonly problem: string | null;
  } | null = null;

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
    // A recording may begin at a paused draw, whose call is not in the log.
    this.#paused = { draw: anchor.randomControl?.pending?.draw.drawId ?? null, record: false };
    this.#published = { revision, operations: 0, last: null, paused: this.#paused };
    this.#frozen = null;
    this.#problem = null;
    this.#staged = null;
  }

  /**
   * Logs `owner`'s calls made on a copy of its runner, which `copy` exports, as calls of the session until `commit`
   * keeps them, once the session adopted the copy, or `rollback` drops them with the copy and restores the log as it
   * was. Calls of the session itself are not made meanwhile.
   */
  stage(owner: PlayerRuntimeEngine, copy: () => RuntimeSnapshot): void {
    if (owner !== this.#owner) return;
    this.#staged = {
      anchor: this.#anchor,
      operations: this.#operations,
      count: this.#operations.length,
      argumentBytes: this.#argumentBytes,
      broken: this.#broken,
      current: this.#current,
      published: this.#published,
      paused: this.#paused,
      frozen: this.#frozen,
      problem: this.#problem,
    };
    this.#current = copy;
  }

  /** Keeps the calls logged since `stage`: the session's runner is the copy now, which it exports again as before. */
  commit(owner: PlayerRuntimeEngine): void {
    const staged = this.#staged;
    if (owner !== this.#owner || staged === null) return;
    this.#current = staged.current;
    this.#staged = null;
  }

  /** Drops the calls logged since `stage` and restores the log as it was then. */
  rollback(owner: PlayerRuntimeEngine): void {
    const staged = this.#staged;
    if (owner !== this.#owner || staged === null) return;
    // A restart since then left the earlier log as it was; otherwise the staged calls follow its calls.
    staged.operations.length = staged.count;
    this.#anchor = staged.anchor;
    this.#operations = staged.operations;
    this.#argumentBytes = staged.argumentBytes;
    this.#broken = staged.broken;
    this.#current = staged.current;
    this.#published = staged.published;
    this.#paused = staged.paused;
    this.#frozen = staged.frozen;
    this.#problem = staged.problem;
    this.#staged = null;
  }

  /** Notes that `owner` published `revision` after the calls logged so far. */
  published(owner: PlayerRuntimeEngine, revision: number): void {
    if (owner !== this.#owner) return;
    this.#published = {
      revision,
      operations: this.#broken ? null : this.#operations.length,
      last: this.#operations.at(-1) ?? null,
      paused: this.#paused,
    };
  }

  /** The recording so far, or `null` before any session began. */
  recording(): DebugRecording | null {
    // Calls on a copy the session has not adopted are not the session's yet.
    const log = this.#staged ?? {
      anchor: this.#anchor,
      operations: this.#operations,
      count: this.#operations.length,
      current: this.#current,
      frozen: this.#frozen,
      problem: this.#problem,
    };
    if (this.#plan === null || log.anchor === null || log.current === null) return null;
    const frozen = log.frozen;
    return {
      plan: this.#plan,
      anchorSnapshot: frozen?.anchor ?? log.anchor,
      operations: frozen === null ? log.operations.slice(0, log.count) : [...frozen.operations],
      endSnapshot: frozen === null ? log.current() : this.#frozenEnd(frozen),
      complete: log.problem === null,
      reason: log.problem,
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
    // A resolution after the publication may have extended its last call; the publication reached the call as it was.
    if (published.last !== null) operations[operations.length - 1] = published.last;
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
    this.#paused = published.paused;
    return session;
  }

  /** Runs `answer` and records `input` as how the player gave the answer of each `completeAction` it makes. */
  answeredBy<T>(input: DebugAnswerInput, answer: () => T): T {
    const outer = this.#input;
    this.#input = input;
    try {
      return answer();
    } finally {
      this.#input = outer;
    }
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
    // Another engine's call, such as one of a session the recorder has moved on from, never reaches the recording.
    // Host code that runs during the call, such as a random decision, may begin another session's recording with this
    // recorder, so each write checks the owner again.
    if (owner !== this.#owner) return invoke((store) => store);
    const paused = this.#paused.draw;
    // While the session stands paused at a random draw, the engine refuses every call but its resolution: such a call
    // changes nothing and needs no record, so the log, which it never copies, stays as it was.
    if (paused !== null && kind !== "resumeRandomDraw") {
      const result = invoke((store) => store);
      if (owner === this.#owner && !unchangedWhilePaused(result, paused)) {
        this.#skip("A call changed a session paused at a random draw.", null);
        this.#paused = { draw: result.pausedAt, record: false };
      }
      return result;
    }
    const prepared = this.#prepare(owner, input, args, continuation);
    // A resolution continues the record of the call that paused, unless the log started again before it.
    const continues = kind === "resumeRandomDraw" && this.#paused.record && !this.#broken;
    const queries: DebugAdmissionQuery[] = [];
    const admission = (store: CapturedMediaAdmission): CapturedMediaAdmission => ({
      holds: (reference, mediaKind) => {
        let result: boolean;
        try {
          result = store.holds(reference, mediaKind);
        } catch (error) {
          // The recording keeps only the store's answers, so a store that throws cannot be replayed. A frozen record
          // holds no later call, so it keeps its evidence as it was.
          if (owner === this.#owner && this.#frozen === null)
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
      if (owner !== this.#owner) throw error;
      // The recording keeps only the decisions the host made, so a decision callback that throws cannot be replayed. A
      // frozen record holds no later call, so it keeps its evidence as it was.
      if (error instanceof RandomDecisionError && this.#frozen === null)
        this.#problem ??= "The random decision callback failed during a recorded call.";
      if (prepared !== null)
        this.#add(kind, prepared, queries, null, error instanceof Error ? error.name : "Error");
      throw error;
    }
    if (owner !== this.#owner || (paused !== null && unchangedWhilePaused(result, paused)))
      return result;
    let recorded = false;
    if (prepared !== null) {
      if (continues) this.#continue(result);
      else this.#add(kind, prepared, queries, result, null);
      recorded = true;
    }
    this.#paused = { draw: result.pausedAt, record: recorded && result.pausedAt !== null };
    return result;
  }

  /**
   * Adds a resolution's effect to the paused call it continues: its events, chosen outcomes, and where the call stands
   * now. A refused resolution changed nothing.
   */
  #continue(result: CallResult): void {
    if (result.outcome?.kind !== "resolved") return;
    const paused = this.#operations.pop()!;
    const events = result.events;
    this.#operations.push({
      ...paused,
      events: {
        first: paused.events.first ?? events[0]?.sequence ?? null,
        count: paused.events.count + events.length,
      },
      status: result.status,
      randomChoices: [...paused.randomChoices, ...(result.randomChoices ?? [])],
      pausedAt: result.pausedAt,
    });
    if (result.status === "failed") this.#freezeFailed();
  }

  /** The copied arguments to log, or `null` when this call is not logged. */
  #prepare(
    owner: PlayerRuntimeEngine,
    input: () => RuntimeSnapshot,
    args: readonly unknown[],
    continuation: boolean,
  ): { readonly args: unknown[]; readonly bytes: number } | null {
    // A call that continues one the log could not keep cannot be replayed either.
    if (this.#plan === null || (this.#broken && continuation)) return null;
    try {
      // After a call it could not keep, the log starts again at the Player's next call before anything else, so that
      // the latest publication stays recoverable also when this call cannot be kept either.
      if (this.#broken) this.#restart(input);
      // JSON would turn a value such as NaN into null and replay a different call, and a cycle has no JSON form, so
      // such a call is not recorded; the engine's own validation then still refuses or admits it.
      const exact = captureExternalData(args).ok;
      // Written without recursion, so a deeply nested argument is recorded like any other.
      const json = exact ? debugExportJson(args) : "";
      // Reading an argument, such as a proxy, may run host code.
      if (owner !== this.#owner) return null;
      if (!exact) {
        this.#skip("A call's arguments could not be copied exactly.", input);
        return null;
      }
      const bytes = json.length;
      if (bytes > this.#limits.argumentBytes) {
        this.#skip("A recorded call was larger than the recording keeps.", input);
        return null;
      }
      // The log also starts again before a call of the Player that would outgrow its limits; a continuation always
      // stays with the call it continues.
      if (
        !continuation &&
        (this.#operations.length + 2 > this.#limits.operations ||
          this.#argumentBytes + bytes > this.#limits.argumentBytes)
      )
        this.#restart(input);
      this.#argumentBytes += bytes;
      // A copy: the recording must not change when the Player reuses an object it passed.
      const copy: unknown = JSON.parse(json);
      if (!Array.isArray(copy)) throw new TypeError("The arguments are not a list.");
      return { args: copy, bytes };
    } catch {
      if (owner === this.#owner) this.#skip("The recorder could not copy a call.", null);
      return null;
    }
  }

  /**
   * Starts the log again from `input`, the state a call of the Player starts from, which is the latest publication's.
   */
  #restart(input: () => RuntimeSnapshot): void {
    this.#anchor = input();
    // The call that paused, if any, is now before the anchor.
    this.#paused = { draw: this.#paused.draw, record: false };
    if (this.#published !== null)
      this.#published = {
        revision: this.#published.revision,
        operations: 0,
        last: null,
        paused: this.#paused,
      };
    this.#operations = [];
    this.#argumentBytes = 0;
    this.#broken = false;
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

  /**
   * Freezes, unless frozen, at the state of the session that failed. A state the session cannot export, such as one
   * with a list too long for the host to enumerate, leaves the recording incomplete, ending where it starts.
   */
  #freezeFailed(): void {
    if (this.#frozen !== null) return;
    let end: RuntimeSnapshot;
    try {
      end = this.#current!();
    } catch {
      this.#problem ??= "The state at the error could not be exported.";
      end = this.#anchor!;
    }
    this.#freeze(end);
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
      randomChoices: [...(result?.randomChoices ?? [])],
      pausedAt: result?.pausedAt ?? null,
      input: kind === "completeAction" ? this.#input : null,
    });
    // A failed session still holds its state, so the end is taken now; after a throw it is rebuilt when needed.
    if (thrown !== null) this.#freeze(null);
    else if (status === "failed") this.#freezeFailed();
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

/**
 * Whether a call made while draw `paused` waits changed nothing: the engine refuses every call but the draw's
 * resolution, and a resolution that misses changes nothing either.
 */
function unchangedWhilePaused(result: CallResult, paused: number): boolean {
  return result.events.length === 0 && result.pausedAt === paused;
}
