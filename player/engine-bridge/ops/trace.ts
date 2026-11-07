import { debugViewOf, type DebugTreeState, type DebugViewRequest } from "../../debug-view.js";
import { setPlayerRuntimeDebugMode } from "../../runtime-adapter.js";
import { RuntimeDebugContext } from "../../../src/runtime/debug/debug-trace.js";
import { exactly, isRecord } from "../argument-checks.js";
import type { PlayerOpsContext } from "../player-ops.js";
import type { BridgeOps } from "../worker-host.js";
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

export function traceOps(context: PlayerOpsContext): BridgeOps {
  return {
    // Turns the connection's value trace on, as a new trace with no history, or off, dropping it with its history. A
    // session takes it at its next operation; the reply names the trace now (`traceId`), `null` without one.
    debugTracing: {
      session: "none",
      checkArguments: (args) =>
        isRecord(args) && exactly(args, ["on"]) && typeof args.on === "boolean",
      run: (args) => {
        // EVIDENCE: validation: checkArguments accepted `on` as a boolean.
        const { on } = args as { readonly on: boolean };
        if (on !== (context.trace !== null)) {
          context.trace = on ? new RuntimeDebugContext() : null;
          if (on) context.traceId += 1;
        }
        return { result: { traceId: context.trace === null ? null : context.traceId } };
      },
    },
    // A new epoch of the connection's trace (`"restore"`), at a session whose recording began anew: Continue asks for it
    // once it owns the UI, so a Continue a Start replaced or a stop interrupted leaves the trace as it was.
    restartTrace: sessionOp(
      (args) => args === null,
      () => {
        context.trace?.reset("restore");
        return { result: null, view: null };
      },
      false,
    ),
    // What the script's `debugMode` reads from now on, as `setPlayerRuntimeDebugMode`.
    setDebugMode: sessionOp(
      (args) => isRecord(args) && exactly(args, ["on"]) && typeof args.on === "boolean",
      (held, args) => {
        // EVIDENCE: validation: checkArguments accepted `on` as a boolean.
        const { on } = args as { readonly on: boolean };
        const result = setPlayerRuntimeDebugMode(held.current, on);
        return publishing(held, result.session, result.outcome);
      },
      false,
    ),
    // A trace view of the session's latest publication, with the connection's trace. It changes and publishes nothing,
    // so a session the Player stopped is still shown in Debug as the stop froze it.
    debugView: {
      ...sessionOp(
        (args) => isRecord(args) && exactly(args, ["request"]) && isViewRequest(args.request),
        (held, args) => {
          // EVIDENCE: validation: checkArguments accepted `request` as a view request.
          const { request } = args as { readonly request: DebugViewRequest };
          return {
            result: debugViewOf(held.current, context.trace, context.traceId, request),
            view: null,
          };
        },
        false,
      ),
      afterStop: true,
    },
  };
}
