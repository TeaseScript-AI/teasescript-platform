import {
  debugViewOf,
  type DebugTreeState,
  type DebugView,
  type DebugViewRequest,
} from "../../debug/debug-view.js";
import { setPlayerRuntimeDebugMode } from "../../runtime/runtime-adapter.js";
import { exactly, isRecord } from "../argument-checks.js";
import { type PlayerOpsContext } from "../player-ops.js";
import { alignTrace, isTracingIntent, type TracingIntent } from "../connection-state.js";
import type { BridgeOp, BridgeOps } from "../worker-host.js";
import { heldSession } from "./persistence.js";
import { publishing, sessionOp } from "./session.js";

/*
 * L5i.3's ops: Debug's value trace as the connection's state (`debugTracing`), the script's Debug mode (`setDebugMode`),
 * and Debug's trace views made in the host (`debugView`, `debug-view.ts`). None reads a basis: the trace and the mode
 * follow the session at its latest publication, and a view names the revision it was made from.
 */

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const isRecordOf = (value: unknown, item: (entry: unknown) => boolean): boolean =>
  isRecord(value) && Object.values(value).every(item);
const isTreeState = (value: unknown): value is DebugTreeState =>
  isRecord(value) &&
  exactly(value, ["choices", "pages"]) &&
  isRecordOf(value.choices, (choice) => typeof choice === "boolean") &&
  isRecordOf(value.pages, isCount);

/** The shape of a view request; what it names that the trace no longer has shows as such. */
function isViewRequest(value: unknown): value is DebugViewRequest {
  if (!isRecord(value) || !exactly(value, ["messages", "selected", "variables", "image", "trees"]))
    return false;
  const { messages, selected, variables, image, trees } = value;
  return (
    (messages === null ||
      (isRecord(messages) &&
        exactly(messages, ["limit", "openNewest"]) &&
        isCount(messages.limit) &&
        typeof messages.openNewest === "boolean")) &&
    (selected === null ||
      (isRecord(selected) &&
        exactly(selected, ["sequence", "epoch"]) &&
        Number.isSafeInteger(selected.sequence) &&
        Number.isSafeInteger(selected.epoch))) &&
    (variables === null ||
      (isRecord(variables) &&
        exactly(variables, ["filter", "pages"]) &&
        typeof variables.filter === "string" &&
        isRecordOf(variables.pages, isCount))) &&
    typeof image === "boolean" &&
    isRecordOf(trees, isTreeState)
  );
}

export function traceOps(context: PlayerOpsContext) {
  return {
    // The Player's tracing intent, posted when the Player makes it: on, as a new trace with no history, or off, dropping
    // it with its history, unless a newer intent arrived first (`alignTrace`). A session takes the trace at its next
    // operation; the reply names the trace now (`traceId`), `null` without one.
    debugTracing: {
      session: "none",
      checkArguments: isTracingIntent,
      run: (args) => {
        const intent = args;
        return { result: { traceId: alignTrace(context, intent) } };
      },
    } satisfies BridgeOp<TracingIntent, { readonly traceId: number | null }, "none">,
    // A new epoch of the connection's trace (`"restore"`), at a session whose recording began anew: Continue asks for it
    // once it owns the UI, so a Continue a Start replaced or a stop interrupted leaves the trace as it was. It carries
    // the Player's intent (`tracing`), which the trace follows first (`alignTrace`); one older than the newest applied
    // came before a newer change and resets nothing, so it cannot clear a trace that change began.
    restartTrace: sessionOp(
      (args): args is { readonly tracing: TracingIntent } =>
        isRecord(args) && exactly(args, ["tracing"]) && isTracingIntent(args.tracing),
      (_held, args) => {
        const { tracing } = args;
        alignTrace(context, tracing);
        if (tracing.intent === context.traceIntent) context.trace?.reset("restore");
        return { result: null, view: null };
      },
      false,
    ),
    // What the script's `debugMode` reads from now on, as `setPlayerRuntimeDebugMode`.
    setDebugMode: sessionOp(
      (args): args is { readonly on: boolean } =>
        isRecord(args) && exactly(args, ["on"]) && typeof args.on === "boolean",
      (held, args) => {
        const { on } = args;
        const result = setPlayerRuntimeDebugMode(held.sessionForOperation(), on);
        return publishing(held, result.session, result.outcome);
      },
      false,
    ),
    // A trace view of the session's latest publication, with the connection's trace: a read (`ops/persistence.ts`),
    // which names its session and changes and publishes nothing, so a session the Player stopped is still shown in
    // Debug as the stop froze it.
    debugView: {
      session: "none",
      checkArguments: (
        args,
      ): args is { readonly session: string; readonly request: DebugViewRequest } =>
        isRecord(args) &&
        exactly(args, ["session", "request"]) &&
        typeof args.session === "string" &&
        isViewRequest(args.request),
      run: (args, sessions) => {
        const { session, request } = args;
        const held = heldSession(sessions, session);
        return {
          result: debugViewOf(held.sessionForOperation(), context.trace, context.traceId, request),
        };
      },
    } satisfies BridgeOp<
      { readonly session: string; readonly request: DebugViewRequest },
      DebugView,
      "none"
    >,
  } satisfies BridgeOps;
}
