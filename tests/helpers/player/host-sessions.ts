import type { Hatched } from "../../../player/engine-bridge/in-process.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import type { PlayerRuntimeSession } from "../../../player/runtime/runtime-adapter.js";
import type { PlayerSession } from "../../../player/runtime/runtime-view.js";
import type { RuntimeDebugContext } from "../../../src/runtime/debug/debug-trace.js";
import { NO_MARKS, type HistoryMarks } from "../../../player/debug/debug-history-marks.js";
import { loadPlayerModule } from "../player-modules.js";

/*
 * The UI tests drive the sessions a composable's host shows with the adapter's functions, as a family not yet converted
 * does in the Player through the transition facade (`player/engine-bridge/in-process.ts`). `onHost` gives an adapter
 * function that runs such a session's call in its host, through the facade of the bundle the composables run in.
 */

/** What an adapter function returns: a session, an outcome, a snapshot, its JSON, or nothing. */
type AdapterResult = object | string | number | boolean | null | undefined | void;

type Hatch = (
  session: PlayerSession,
  op: (held: PlayerRuntimeSession) => AdapterResult,
) => AdapterResult;

/**
 * An adapter function `op` that also takes a session a composable's host holds (`PlayerSession`): given an adapter
 * session, it returns what `op` does; given the host's, the same with the host's session in place of the adapter's
 * (`Hatched`), as the facade returns it.
 */
export interface OnHost<A extends unknown[], R extends AdapterResult> {
  (session: PlayerRuntimeSession, ...rest: A): R;
  (session: PlayerSession, ...rest: A): Hatched<R>;
  (session: PlayerRuntimeSession | PlayerSession, ...rest: A): R | Hatched<R>;
}

let hatch: Hatch | null = null;
let heldTrace: ((bridge: PlayerBridge) => RuntimeDebugContext | null) | null = null;
let introduceNow:
  | ((bridge: PlayerBridge, make: () => PlayerRuntimeSession, marks: HistoryMarks) => PlayerSession)
  | null = null;

/** Loads the facade of the bundle the composables run in; call it in `before`, before any `onHost` call runs. */
export async function loadHostFacade(): Promise<void> {
  const facade = await loadPlayerModule("player/engine-bridge/in-process.ts");
  if (typeof facade.hatch !== "function") throw new Error("The bundle has no facade.");
  // EVIDENCE: validation: checked as a function above; it is the bundle facade's `hatch`.
  hatch = facade.hatch as Hatch;
  if (typeof facade.heldTrace !== "function") throw new Error("The bundle's facade has no trace.");
  // EVIDENCE: validation: checked as a function above; it is the bundle facade's `heldTrace`.
  heldTrace = facade.heldTrace as typeof heldTrace;
  if (typeof facade.introduceNow !== "function")
    throw new Error("The bundle's facade has no introduction.");
  // EVIDENCE: validation: checked as a function above; it is the bundle facade's `introduceNow`.
  introduceNow = facade.introduceNow as typeof introduceNow;
}

/**
 * `session`, an adapter session a test restored or made, as a session the composable's in-process host on `bridge` now
 * holds, with `marks` (none by default), before the test passes it to `prepareRestore`.
 */
export function hostIntroduced(
  bridge: PlayerBridge,
  session: PlayerRuntimeSession,
  marks: HistoryMarks = NO_MARKS,
): PlayerSession {
  if (introduceNow === null) throw new Error("Call loadHostFacade first.");
  return introduceNow(bridge, () => session, marks);
}

/** The value trace a composable's in-process host holds on `bridge` (L5i.3), or `null` while Debug does not run. */
export function hostTrace(bridge: PlayerBridge): RuntimeDebugContext | null {
  if (heldTrace === null) throw new Error("Call loadHostFacade first.");
  return heldTrace(bridge);
}

/** Whether `value` is a session a composable's host holds (a `PlayerSession`), not an adapter session. */
function isHostSession(value: unknown): value is PlayerSession {
  return typeof value === "object" && value !== null && "planToken" in value && "lineage" in value;
}

/** `op`, which also takes a session a composable's host holds: its call then runs on the host's session (`OnHost`). */
export function onHost<A extends unknown[], R extends AdapterResult>(
  op: (session: PlayerRuntimeSession, ...rest: A) => R,
): OnHost<A, R> {
  const call = (session: PlayerRuntimeSession | PlayerSession, ...rest: A): R | Hatched<R> => {
    if (!isHostSession(session)) return op(session, ...rest);
    if (hatch === null) throw new Error("Call loadHostFacade() in before().");
    // EVIDENCE: validation: the facade returns `op`'s result with the host's session in place of the adapter's.
    return hatch(session, (held) => op(held, ...rest)) as Hatched<R>;
  };
  // EVIDENCE: validation: `call` returns `op`'s result for an adapter session and the facade's for the host's.
  return call as OnHost<A, R>;
}

/** `module`'s functions that take a session first, as `onHost` gives them; anything else as it is. */
export type OnHostAll<M> = {
  readonly [K in keyof M]: M[K] extends (session: PlayerRuntimeSession, ...rest: infer A) => infer R
    ? R extends AdapterResult
      ? OnHost<A, R>
      : M[K]
    : M[K];
};

/** `module` with each of its functions as `onHost` gives it; its classes and other values stay as they are. */
export function onHostAll<M extends Record<string, unknown>>(module: M): OnHostAll<M> {
  const wrapped = Object.fromEntries(
    Object.entries(module).map(([name, value]) => {
      if (typeof value !== "function" || /^[A-Z]/u.test(name)) return [name, value];
      // EVIDENCE: validation: an adapter function, whose first parameter is a session when it takes one.
      const op = value as (session: PlayerRuntimeSession, ...rest: unknown[]) => AdapterResult;
      return [name, onHost(op)];
    }),
  );
  // EVIDENCE: validation: the same keys as `module`, each function wrapped as `onHost` types it.
  return wrapped as OnHostAll<M>;
}
