import type {
  CapturedMediaAdmission,
  InstructionPlan,
  InterpreterEvent,
  RuntimeSnapshot,
} from "../src/index.js";
import {
  debugExportJson,
  type DebugAdmissionQuery,
  type DebugOperation,
  type DebugOperationKind,
} from "./debug-export.js";

/** What a recorder holds for a debug export: the anchor and every engine call made since, in order. */
export interface DebugRecording {
  readonly plan: InstructionPlan;
  readonly anchorSnapshot: RuntimeSnapshot;
  readonly operations: readonly DebugOperation[];
  /** Whether every call since the anchor is recorded; otherwise `reason` says why not. */
  readonly complete: boolean;
  readonly reason: string | null;
}

/** An engine call's result as the recorder reads it. */
interface CallResult {
  readonly snapshot: RuntimeSnapshot;
  readonly events: readonly InterpreterEvent[];
  readonly outcome?: { readonly kind: string };
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
 */
export class DebugRecorder {
  readonly #limits: DebugRecorderLimits;
  #plan: InstructionPlan | null = null;
  #anchor: RuntimeSnapshot | null = null;
  #operations: DebugOperation[] = [];
  #argumentBytes = 0;
  #frozen = false;
  #problem: string | null = null;

  constructor(limits: Partial<DebugRecorderLimits> = {}) {
    this.#limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Starts a new recording from `anchor`, the state of a new or restored session before any call. */
  begin(plan: InstructionPlan, anchor: RuntimeSnapshot): void {
    this.#plan = plan;
    this.#anchor = anchor;
    this.#operations = [];
    this.#argumentBytes = 0;
    this.#frozen = false;
    this.#problem = null;
  }

  /** The recording so far, or `null` before any session began. */
  recording(): DebugRecording | null {
    if (this.#plan === null || this.#anchor === null) return null;
    return {
      plan: this.#plan,
      anchorSnapshot: this.#anchor,
      operations: [...this.#operations],
      complete: this.#problem === null,
      reason: this.#problem,
    };
  }

  /**
   * Makes the engine call `invoke` on `input` and records it. `args` are the plain arguments the call passes after the
   * plan and snapshot. `continuation` marks the `run` that follows an accepted call, which is never a new anchor. The
   * call receives `admission` to pass to the engine in place of the Player's own media store, which still answers.
   */
  call<R extends CallResult>(
    kind: DebugOperationKind,
    input: RuntimeSnapshot,
    args: readonly unknown[],
    invoke: (admission: (store: CapturedMediaAdmission) => CapturedMediaAdmission) => R,
    continuation = false,
  ): R {
    const prepared = this.#prepare(input, args, continuation);
    const queries: DebugAdmissionQuery[] = [];
    const admission = (store: CapturedMediaAdmission): CapturedMediaAdmission => ({
      holds(reference, mediaKind) {
        const result = store.holds(reference, mediaKind);
        queries.push({ reference, kind: mediaKind, result });
        return result;
      },
    });
    let result: R;
    try {
      result = invoke(admission);
    } catch (error) {
      if (prepared !== null)
        this.#add(
          kind,
          prepared,
          queries,
          null,
          error instanceof Error ? error.name : "Error",
          input,
        );
      throw error;
    }
    if (prepared !== null) this.#add(kind, prepared, queries, result, null, result.snapshot);
    return result;
  }

  /** The copied arguments to record, or `null` when this call is not recorded. */
  #prepare(
    input: RuntimeSnapshot,
    args: readonly unknown[],
    continuation: boolean,
  ): { readonly args: unknown[]; readonly bytes: number } | null {
    if (this.#frozen || this.#plan === null) return null;
    try {
      // Written without recursion, so a deeply nested argument is recorded like any other.
      const json = debugExportJson(args);
      const bytes = json.length;
      if (bytes > this.#limits.argumentBytes) {
        this.#problem ??= "A recorded call was larger than the recording keeps.";
        this.#frozen = true;
        return null;
      }
      // Starting again is only possible before a call of the Player, whose input is a published session state; a
      // continuation always stays with the call it continues.
      if (
        !continuation &&
        (this.#operations.length + 2 > this.#limits.operations ||
          this.#argumentBytes + bytes > this.#limits.argumentBytes)
      ) {
        this.#anchor = input;
        this.#operations = [];
        this.#argumentBytes = 0;
      }
      this.#argumentBytes += bytes;
      // A copy: the recording must not change when the Player reuses an object it passed.
      const copy: unknown = JSON.parse(json);
      if (!Array.isArray(copy)) throw new TypeError("The arguments are not a list.");
      return { args: copy, bytes };
    } catch {
      this.#problem ??= "The recorder could not copy a call.";
      this.#frozen = true;
      return null;
    }
  }

  #add(
    kind: DebugOperationKind,
    prepared: { readonly args: unknown[] },
    admissionQueries: DebugAdmissionQuery[],
    result: CallResult | null,
    thrown: string | null,
    after: RuntimeSnapshot,
  ): void {
    const events = result?.events ?? [];
    this.#operations.push({
      seq: this.#operations.length + 1,
      kind,
      args: prepared.args,
      admissionQueries,
      outcome: result === null ? null : (result.outcome?.kind ?? "ran"),
      events: { first: events[0]?.sequence ?? null, count: events.length },
      status: after.status,
      thrown,
    });
    if (thrown !== null || after.status === "failed") this.#frozen = true;
  }
}
