import type { PlayerBridge } from "../../player/player-bridge.js";
import type { PlayerRuntimeSession } from "../../player/runtime-adapter.js";
import type { RuntimeDebugContext } from "../../src/runtime/debug/debug-trace.js";
import { loadPlayerModule } from "./player-modules.js";

/*
 * The UI tests drive the sessions a composable's host shows with the adapter's functions, as a family not yet converted
 * does in the Player through the transition facade (`player/engine-bridge/in-process.ts`). `onHost` gives an adapter
 * function that runs such a session's call in its host, through the facade of the bundle the composables run in.
 */

/** What an adapter function returns: a session, an outcome, a snapshot, its JSON, or nothing. */
type AdapterResult = object | string | number | boolean | null | undefined | void;

/** A session a composable's host holds, as these tests see it: they type the host's sessions as the adapter's. */
type HostSession = PlayerRuntimeSession;

type Hatch = (
  session: HostSession,
  op: (held: PlayerRuntimeSession) => AdapterResult,
) => AdapterResult;

let hatch: Hatch | null = null;
let heldTrace: ((bridge: PlayerBridge) => RuntimeDebugContext | null) | null = null;

/** Loads the facade of the bundle the composables run in; call it in `before`, before any `onHost` call runs. */
export async function loadHostFacade(): Promise<void> {
  const facade = await loadPlayerModule("player/engine-bridge/in-process.ts");
  if (typeof facade.hatch !== "function") throw new Error("The bundle has no facade.");
  // EVIDENCE: validation: checked as a function above; it is the bundle facade's `hatch`.
  hatch = facade.hatch as Hatch;
  if (typeof facade.heldTrace !== "function") throw new Error("The bundle's facade has no trace.");
  // EVIDENCE: validation: checked as a function above; it is the bundle facade's `heldTrace`.
  heldTrace = facade.heldTrace as typeof heldTrace;
}

/** The value trace a composable's in-process host holds on `bridge` (L5i.3), or `null` while Debug does not run. */
export function hostTrace(bridge: PlayerBridge): RuntimeDebugContext | null {
  if (heldTrace === null) throw new Error("Call loadHostFacade first.");
  return heldTrace(bridge);
}

/** Whether `value` is a session a composable's host holds (a `PlayerSession`), not an adapter session. */
function isHostSession(value: unknown): boolean {
  return typeof value === "object" && value !== null && "planToken" in value && "lineage" in value;
}

/**
 * `op`, which also takes a session a composable's host holds: its call then runs on the host's session, and its result
 * has the host's session in place of the adapter's, as the facade returns it.
 */
export function onHost<A extends unknown[], R extends AdapterResult>(
  op: (session: PlayerRuntimeSession, ...rest: A) => R,
): (session: PlayerRuntimeSession, ...rest: A) => R {
  return (session, ...rest) => {
    if (!isHostSession(session)) return op(session, ...rest);
    if (hatch === null) throw new Error("Call loadHostFacade() in before().");
    // EVIDENCE: validation: the facade returns `op`'s result with the host's session in place of the adapter's.
    return hatch(session, (held) => op(held, ...rest)) as R;
  };
}

/** `module` with each of its functions as `onHost` gives it; its classes and other values stay as they are. */
export function onHostAll<M extends Record<string, unknown>>(module: M): M {
  const wrapped = Object.fromEntries(
    Object.entries(module).map(([name, value]) => {
      if (typeof value !== "function" || /^[A-Z]/u.test(name)) return [name, value];
      // EVIDENCE: validation: an adapter function, whose first parameter is a session when it takes one.
      const op = value as (session: PlayerRuntimeSession, ...rest: unknown[]) => AdapterResult;
      return [name, onHost(op)];
    }),
  );
  // EVIDENCE: validation: the same keys as `module`, each function wrapped with its own signature.
  return wrapped as M;
}
