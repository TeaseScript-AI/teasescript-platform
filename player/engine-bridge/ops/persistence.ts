import type { InstructionPlan } from "../../../src/index.js";
import type { InterpreterEvent } from "../../../src/playback.js";
import { serializeValidatedRuntimeJson } from "../../../src/runtime/snapshot/checkpoint-json.js";
import {
  createPlayerRuntimeRestorePoint,
  playerRuntimeSnapshotJson,
  restorePlayerRuntimeSessionAt,
} from "../../runtime/runtime-adapter.js";
import { exactly, isEventLog, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOps, HostSessions } from "../worker-host.js";
import { isHistoryMarks, parseHistoryMarks } from "../../debug/debug-history-marks.js";
import { HeldSession, introduction } from "./session.js";

/*
 * The ops of family L5h (the L5 series), keeping and exporting a session: what the Player stores of a session, read in
 * the host, and a kept session restored there. They read and change no session state.
 *
 * The reads name their session in their arguments and work on no session of the envelope, so the stop fence, which
 * refuses a halted session's own ops, lets them read the state a Player error stop left: the stop line, which is what
 * the main side shows. The main side sends them after the session's earlier requests (`BridgeClient.request`'s
 * `after`), so a read follows what was posted before it.
 *
 * A plan's canonical JSON, which a new session's first save stores and a Continue compares, is written here, in a task
 * of its own once the Player asks, so that neither Start nor the Player's thread writes it (#1707). Only the page's
 * lease decides how long it is held (`plan-json-lease.ts`): `preparePlanText` alone keeps a plan's JSON, and
 * `releasePlanText` alone lets go of it. Every other op reads it, or writes it for itself and keeps nothing.
 */

/** The canonical JSON of one held plan: written, or waiting for its task. */
export interface PlanTextSlot {
  json: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** What a capture of a held session gives the Player: the publication it read, and its state as JSON. */
export type KeepCapture =
  | {
      readonly kind: "captured";
      readonly revision: number;
      /** How many of the session's events the capture covers: the store's events up to here go with it. */
      readonly eventsThrough: number;
      readonly snapshotJson: string;
      /** The plan's canonical JSON, when the capture was asked for it. */
      readonly planJson: string | null;
    }
  /** A state this browser cannot write, such as one with a list too long to save; the plan's JSON still comes back. */
  | { readonly kind: "unkeepable"; readonly planJson: string | null }
  /** The host no longer holds the session; the plan's JSON comes back if the host had written it. */
  | { readonly kind: "gone"; readonly planJson: string | null };

/** What a capture of a held session's checkpoint gives the Player. */
export interface CheckpointCapture {
  readonly revision: number;
  readonly eventsThrough: number;
  readonly checkpointJson: string;
}

/** A kept session's restore: introduced as a new session, or why it does not go on with the held plan. */
export type KeptRestore =
  { readonly kind: "restored" } | { readonly kind: "otherPlan" } | { readonly kind: "ended" };

const isSessionId = (value: unknown): value is string => typeof value === "string";

/** A read of a session the host no longer holds, such as one released meanwhile: there is nothing to read. */
class SessionGoneError extends Error {
  override readonly name = "SessionGoneError";
}

/** The session the host holds under `id`, for a read that names it. */
export function heldSession(sessions: HostSessions, id: string): HeldSession {
  const held = sessions.get(id);
  if (!(held instanceof HeldSession)) throw new SessionGoneError("The host holds no such session.");
  return held;
}

/** The plan the connection holds under `token`. */
function heldPlan(context: PlayerOpsContext, token: string): InstructionPlan {
  const plan = context.plans.get(token);
  if (plan === undefined) throw new Error(`No plan '${token}' is held.`);
  return plan;
}

/** `slot`'s JSON, written now unless written; its waiting task, if any, then has nothing left to do. */
function materialize(context: PlayerOpsContext, slot: PlanTextSlot, token: string): string {
  if (slot.json !== null) return slot.json;
  if (slot.timer !== null) clearTimeout(slot.timer);
  slot.timer = null;
  slot.json = serializeValidatedRuntimeJson(heldPlan(context, token));
  return slot.json;
}

/**
 * The held plan's canonical JSON, for a reader: the slot's, written now if its task has not run (once, for the slot),
 * or, with no slot, written for this reader alone and kept nowhere. A reader never creates or removes a slot.
 */
export function readPlanText(context: PlayerOpsContext, token: string): string {
  const slot = context.planTexts.get(token);
  if (slot === undefined) return serializeValidatedRuntimeJson(heldPlan(context, token));
  return materialize(context, slot, token);
}

export function persistenceOps(context: PlayerOpsContext): BridgeOps {
  return { ...planTextOps(context), ...keptStateOps(context) };
}

/** The plan's canonical JSON: written in a task of its own, let go, and read. */
function planTextOps(context: PlayerOpsContext): BridgeOps {
  const slots = context.planTexts;
  const planOf = (token: string) => heldPlan(context, token);
  const planText = (token: string): string => readPlanText(context, token);
  // A slot's waiting task stops as the slot leaves (`PlayerOpsContext.planTexts`).
  const dropPlanText = (token: string) => slots.delete(token);
  return {
    // Writes the plan's canonical JSON in a task of its own, unless it is written or waiting.
    preparePlanText: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["plan"]) && typeof args.plan === "string",
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { plan } = args as { readonly plan: string };
        planOf(plan);
        if (slots.has(plan)) return { result: null };
        const slot: PlanTextSlot = { json: null, timer: null };
        // Kept first, so that a slot its delivery undoes stops its task with it.
        slots.set(plan, slot);
        slot.timer = setTimeout(() => {
          slot.timer = null;
          // A slot released or replaced meanwhile is no longer the plan's.
          if (slots.get(plan) !== slot) return;
          try {
            materialize(context, slot, plan);
          } catch {
            // The reader that needs it writes it then, and fails as it would have.
          }
        }, 0);
        return { result: null };
      },
    },
    // Lets go of the plan's JSON, written or waiting, as a page that closes does: nothing needs it.
    releasePlanText: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["plan"]) && typeof args.plan === "string",
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { plan } = args as { readonly plan: string };
        dropPlanText(plan);
        return { result: null };
      },
    },
    // The plan's canonical JSON, read: what an import's save stores. It keeps nothing the page did not reserve.
    planText: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["plan"]) && typeof args.plan === "string",
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { plan } = args as { readonly plan: string };
        return { result: planText(plan) };
      },
    },
  };
}

/** A session's kept state: its keep and checkpoint captured, and a kept session restored. */
function keptStateOps(context: PlayerOpsContext): BridgeOps {
  const slots = context.planTexts;
  const planOf = (token: string) => heldPlan(context, token);
  const planText = (token: string): string => readPlanText(context, token);
  return {
    // The session's state as JSON, from the trusted export, and with `plan` that plan's JSON, read.
    captureKeep: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["session", "plan"]) &&
        isSessionId(args.session) &&
        (args.plan === null || typeof args.plan === "string"),
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { session, plan } = args as {
          readonly session: string;
          readonly plan: string | null;
        };
        // A capture asked for the plan's JSON reads it; the slot stays the page's (`plan-json-lease.ts`).
        const held = sessions.get(session);
        if (!(held instanceof HeldSession)) {
          const written = plan === null ? null : (slots.get(plan)?.json ?? null);
          const result: KeepCapture = { kind: "gone", planJson: written };
          return { result };
        }
        const planJson = plan === null ? null : planText(plan);
        const current = held.sessionForOperation();
        let snapshotJson: string;
        try {
          snapshotJson = playerRuntimeSnapshotJson(current);
        } catch {
          const result: KeepCapture = { kind: "unkeepable", planJson };
          return { result };
        }
        const result: KeepCapture = {
          kind: "captured",
          revision: current.revision,
          eventsThrough: held.delivered,
          snapshotJson,
          planJson,
        };
        return { result };
      },
    },
    // The session's checkpoint, as an export of the session carries it.
    captureCheckpoint: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["session"]) && isSessionId(args.session),
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const held = heldSession(sessions, (args as { readonly session: string }).session);
        const current = held.sessionForOperation();
        const result: CheckpointCapture = {
          revision: current.revision,
          eventsThrough: held.delivered,
          checkpointJson: createPlayerRuntimeRestorePoint(current).checkpointJson,
        };
        return { result };
      },
    },
    // A kept session, restored against the held plan `plan` when the plan JSON it was kept with is that plan's; nothing
    // runs. A state the engine refuses is the reply's error, with its class, code and details. An ended one is not
    // introduced.
    restoreKept: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["plan", "planJson", "snapshotJson", "events", "marks"]) &&
        typeof args.plan === "string" &&
        typeof args.planJson === "string" &&
        typeof args.snapshotJson === "string" &&
        isEventLog(args.events) &&
        isHistoryMarks(args.marks),
      run: (args, sessions) => {
        // The engine validates the kept state as it restores it.
        // EVIDENCE: validation: checkArguments accepted the shape and each event (`isEventLog`).
        const { plan, planJson, snapshotJson, events, marks } = args as {
          readonly plan: string;
          readonly planJson: string;
          readonly snapshotJson: string;
          readonly events: readonly InterpreterEvent[];
          readonly marks: unknown;
        };
        if (planText(plan) !== planJson) {
          const result: KeptRestore = { kind: "otherPlan" };
          return { result };
        }
        const restored = restorePlayerRuntimeSessionAt(planOf(plan), snapshotJson, events);
        if (restored.state.status === "halted" || restored.state.status === "failed") {
          const result: KeptRestore = { kind: "ended" };
          return { result };
        }
        // The kept session's marks, as it was kept: validated above, read again into frozen data.
        const held = new HeldSession(restored, plan, context, parseHistoryMarks(marks));
        const id = sessions.add(held);
        const view = introduction(held, context, false);
        const result: KeptRestore = { kind: "restored" };
        return { result, session: id, eventsThrough: view.eventsThrough, view };
      },
    },
  };
}
