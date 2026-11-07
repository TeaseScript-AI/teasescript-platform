import type { InterpreterEvent } from "../../../src/playback.js";
import { serializeValidatedRuntimeJson } from "../../../src/runtime/snapshot/checkpoint-json.js";
import {
  createPlayerRuntimeRestorePoint,
  playerRuntimeSnapshotJson,
  restorePlayerRuntimeSessionAt,
} from "../../runtime-adapter.js";
import { everyItem, exactly, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOps, HostSessions } from "../worker-host.js";
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
 * of its own once the Player asks, so that neither Start nor the Player's thread writes it (#1707). It is held per plan
 * token until a save takes it or a matching Continue no longer needs it.
 */

/** The canonical JSON of one held plan: written, or waiting for its task. */
export interface PlanTextSlot {
  json: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** What a capture of a held session gives the Player: the publication it read, and its state as JSON. */
export interface KeepCapture {
  readonly revision: number;
  /** How many of the session's events the capture covers: the store's events up to here go with it. */
  readonly eventsThrough: number;
  readonly snapshotJson: string;
  /** The plan's canonical JSON, when the capture was asked for it. */
  readonly planJson: string | null;
}

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

export function persistenceOps(context: PlayerOpsContext): BridgeOps {
  const slots = context.planTexts;
  const planOf = (token: string) => {
    const plan = context.plans.get(token);
    if (plan === undefined) throw new Error(`No plan '${token}' is held.`);
    return plan;
  };
  /** The held plan's canonical JSON, written now unless its task did; it stays held. */
  const planText = (token: string): string => {
    const slot = slots.get(token);
    if (slot?.json != null) return slot.json;
    const json = serializeValidatedRuntimeJson(planOf(token));
    if (slot?.timer != null) clearTimeout(slot.timer);
    slots.set(token, { json, timer: null });
    return json;
  };
  const dropPlanText = (token: string) => {
    const slot = slots.get(token);
    if (slot?.timer != null) clearTimeout(slot.timer);
    slots.delete(token);
  };
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
        slot.timer = setTimeout(() => {
          slot.timer = null;
          try {
            slot.json = serializeValidatedRuntimeJson(planOf(plan));
          } catch {
            // The save or comparison that needs it writes it then, and fails as it would have.
          }
        }, 0);
        slots.set(plan, slot);
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
    // The plan's canonical JSON, which stays held: what an import's save stores.
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
    // The session's state as JSON, from the trusted export, and with `withPlan` its plan's JSON, which the save then
    // holds: the host lets go of it.
    captureKeep: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) &&
        exactly(args, ["session", "withPlan"]) &&
        isSessionId(args.session) &&
        typeof args.withPlan === "boolean",
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted these arguments before run.
        const { session, withPlan } = args as {
          readonly session: string;
          readonly withPlan: boolean;
        };
        const held = heldSession(sessions, session);
        const current = held.current;
        const snapshotJson = playerRuntimeSnapshotJson(current);
        let planJson: string | null = null;
        if (withPlan) {
          planJson = planText(held.planToken);
          dropPlanText(held.planToken);
        }
        const result: KeepCapture = {
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
        const current = held.current;
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
        exactly(args, ["plan", "planJson", "snapshotJson", "events"]) &&
        typeof args.plan === "string" &&
        typeof args.planJson === "string" &&
        typeof args.snapshotJson === "string" &&
        everyItem(args.events, isRecord),
      run: (args, sessions) => {
        // EVIDENCE: validation: checkArguments accepted the shape; the engine validates the kept state and events.
        const { plan, planJson, snapshotJson, events } = args as {
          readonly plan: string;
          readonly planJson: string;
          readonly snapshotJson: string;
          readonly events: readonly InterpreterEvent[];
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
        // The session goes on, so a first save will not need the plan's JSON.
        dropPlanText(plan);
        const held = new HeldSession(restored, plan, context);
        const id = sessions.add(held);
        const view = introduction(held, context, false);
        const result: KeptRestore = { kind: "restored" };
        return { result, session: id, eventsThrough: view.eventsThrough, view };
      },
    },
  };
}
