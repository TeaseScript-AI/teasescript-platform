import type {
  RuntimeDebugContext,
  RuntimeDebugLocation,
  RuntimeDebugTraceStatus,
} from "../../src/runtime/debug/debug-trace.js";
import {
  debugVariableTree,
  playerDebugImageOrigin,
  playerDebugLiveValue,
  playerDebugMessageOrigin,
  playerDebugTraceRows,
  playerDebugVariables,
  PLAYER_DEBUG_TRACE_PAGE,
  type PlayerDebugLiveValue,
  type PlayerDebugOrigin,
  type PlayerDebugTraceRow,
  type PlayerDebugVariable,
} from "./debug-variables.js";
import { playerRuntimeDebugVariables, type PlayerRuntimeSession } from "../runtime/runtime-adapter.js";

/*
 * Debug's trace views, made in the engine's host (L5i.3): what the Variables view and the Now view's Stage image origin
 * show, from the session, its plan and the connection's value trace, by `debug-variables.ts` as before. The Player keeps
 * the views' state (selection, paging, expansion, filter) and sends it with each request; a view is plain data, bound to
 * the revision, trace and epoch it was made from.
 */

/** A derivation tree's view state: the player's choices of open rows, and how many pages of causes each row shows. */
export interface DebugTreeState {
  readonly choices: Readonly<Record<string, boolean>>;
  readonly pages: Readonly<Record<string, number>>;
}

/** What a view asks for; `null` leaves a part out. Each tree's state is under its key in `trees`. */
export interface DebugViewRequest {
  /** Recent chat, tree `recent`: the newest `limit` messages, the newest open by default while `openNewest`. */
  readonly messages: { readonly limit: number; readonly openNewest: boolean } | null;
  /** The message Explain values selected, tree `selected`: its content's event sequence, while the epoch is `epoch`. */
  readonly selected: { readonly sequence: number; readonly epoch: number } | null;
  /** Every live variable whose name holds `filter`, each group to its page count; tree `variable:<scope>:<name>`. */
  readonly variables: {
    readonly filter: string;
    readonly pages: Readonly<Record<string, number>>;
  } | null;
  /** The record of the statement that set the Stage image, or why there is none. */
  readonly image: boolean;
  readonly trees: Readonly<Record<string, DebugTreeState>>;
}

/** A live variable as the view lists it, with its origin's tree when the trace has its record. */
export interface DebugViewVariable extends PlayerDebugVariable {
  readonly rows: readonly PlayerDebugTraceRow[] | null;
}

/** What a view shows, for the session's publication `revision` and trace `traceId`, or `traceId: null` without Debug. */
export interface DebugView {
  readonly revision: number;
  readonly traceId: number | null;
  readonly status: RuntimeDebugTraceStatus | null;
  readonly messages: {
    readonly count: number;
    readonly rows: readonly PlayerDebugTraceRow[];
  } | null;
  /** `null` also once the trace's epoch is no longer the selection's. */
  readonly selected: {
    readonly origin: PlayerDebugOrigin;
    readonly rows: readonly PlayerDebugTraceRow[] | null;
  } | null;
  readonly variables:
    | readonly {
        readonly key: string;
        readonly label: string;
        /** How many variables the group has; `variables` lists its shown pages. */
        readonly total: number;
        readonly variables: readonly DebugViewVariable[];
      }[]
    | null;
  readonly image: {
    readonly origin: PlayerDebugOrigin;
    readonly location: RuntimeDebugLocation | null;
  } | null;
}

/**
 * The rows of the tree under `roots`, with the view state of `tree`: a row is open as the player chose, else a root
 * while it is `defaultOpen`, and a value's placeholder or a value only passed on, as the Variables view opens them.
 */
function rowsOf(
  trace: RuntimeDebugContext,
  roots: readonly number[],
  tree: DebugTreeState | undefined,
  defaultOpen: number | null,
  live: PlayerDebugLiveValue,
): readonly PlayerDebugTraceRow[] {
  const choices = tree?.choices ?? {};
  const pages = tree?.pages ?? {};
  return playerDebugTraceRows(
    trace,
    roots,
    {
      expanded: (key, record, depth, carried) =>
        (Object.hasOwn(choices, key) ? choices[key] : undefined) ??
        (depth === 0 ? record.id === defaultOpen : record.kind === "interpolation" || carried),
      pages: (key) => (Object.hasOwn(pages, key) ? pages[key]! : 1),
    },
    live,
  );
}

/** The view `request` asks for, of `session` with the connection's trace `trace` (`traceId`). */
export function debugViewOf(
  session: PlayerRuntimeSession,
  trace: RuntimeDebugContext | null,
  traceId: number,
  request: DebugViewRequest,
): DebugView {
  if (trace === null)
    return {
      revision: session.revision,
      traceId: null,
      status: null,
      messages: null,
      selected: null,
      variables: null,
      image: null,
    };
  const source = playerRuntimeDebugVariables(session);
  const live = playerDebugLiveValue(source.variables);
  const status = trace.status();
  let messages: DebugView["messages"] = null;
  if (request.messages !== null) {
    const roots = trace.recentMessages(request.messages.limit);
    const open = request.messages.openNewest ? (roots[0] ?? null) : null;
    messages = {
      count: roots.length,
      rows: rowsOf(trace, roots, request.trees.recent, open, live),
    };
  }
  let selected: DebugView["selected"] = null;
  if (request.selected !== null && request.selected.epoch === status.epoch) {
    const origin = playerDebugMessageOrigin(trace, request.selected.sequence);
    selected = {
      origin,
      rows:
        origin.kind === "record"
          ? rowsOf(trace, [origin.id], request.trees.selected, origin.id, live)
          : null,
    };
  }
  let variables: DebugView["variables"] = null;
  if (request.variables !== null) {
    const { filter, pages } = request.variables;
    variables = playerDebugVariables(session.plan, source, trace, filter).map((group) => {
      const page = Object.hasOwn(pages, group.key) ? pages[group.key]! : 1;
      return {
        key: group.key,
        label: group.label,
        total: group.variables.length,
        variables: group.variables
          .slice(0, PLAYER_DEBUG_TRACE_PAGE * Math.max(1, page))
          .map((variable) => ({
            ...variable,
            rows:
              variable.record === null
                ? null
                : rowsOf(
                    trace,
                    [variable.record],
                    request.trees[debugVariableTree(variable)],
                    null,
                    live,
                  ),
          })),
      };
    });
  }
  let image: DebugView["image"] = null;
  if (request.image) {
    const origin = playerDebugImageOrigin(trace);
    image = {
      origin,
      location: origin.kind === "record" ? (trace.record(origin.id)?.location ?? null) : null,
    };
  }
  return { revision: session.revision, traceId, status, messages, selected, variables, image };
}
