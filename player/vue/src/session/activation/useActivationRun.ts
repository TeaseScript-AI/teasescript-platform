import type {
  RunBegin,
  StopArguments,
} from "../../../../engine-bridge/recording/export-observation.js";
import type { PlayerBridge } from "../../../../runtime/player-bridge.js";
import { useFailureRecording } from "./useFailureRecording.js";

/*
 * The diagnostic run of each Player activation (L5h.3b, design round r2): the one owner that admits what an
 * activation's completions do. A Start or Continue begins its record before anything of it can fail; its requests,
 * its error stop, its incident and its failure recording take that record, passed explicitly, never the Player's
 * current one. Every completion that would act (a Start's or Continue's reply, a deferred error, a halt's
 * acknowledgement, a failure capture) acts only while its record lives: the next activation and the Player's disposal
 * retire it for good, so nothing of a retired activation halts, commits, captures or shows. An error stop, a rewind, a
 * Return and Debug-off keep the run. Before the first activation the initial record stands in, with no run.
 */

/** One activation's run: its bridge, its begin as the host receives it, and its failure recording. */
export interface RunOrigin {
  readonly kind: "run";
  readonly bridge: PlayerBridge;
  readonly begin: RunBegin;
  readonly failure: ReturnType<typeof useFailureRecording>;
}
/**
 * The Player's record before its first activation: it admits the no-session export and the page's error stop, never an
 * incident or a failure recording (it has no run), and the first begin or the Player's disposal retires it for good.
 */
export interface InitialOrigin {
  readonly kind: "initial";
}
/** What an activation's completion acts for: the initial record or an activation's run. */
export type Origin = InitialOrigin | RunOrigin;

/** A reply's settlement, as a retired origin's cleanup receives it. */
export type Settlement<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
/** What a reply does: on its origin's behalf while it lives, else only its cleanup. Each handler returns nothing. */
export interface ReplyHandlers<T> {
  readonly done: (value: T) => undefined;
  readonly failed: (error: unknown) => undefined;
  /** Cleanup of what the reply brought, for a retired origin: it acts for no activation. */
  readonly retired?: (outcome: Settlement<T>) => undefined;
}

/**
 * The record owner. `report` is the activation error-stop sink a reply's unexpected handler error goes to, for the
 * reply's own origin.
 */
export function useActivationRun({
  report,
}: {
  readonly report: (origin: Origin, error: unknown) => void;
}) {
  // The live record: the initial one until the first begin, then each activation's run; none after disposal.
  let live: Origin | null = { kind: "initial" };
  // What `current()` gives after disposal: a record no completion is admitted for.
  const disposed: InitialOrigin = Object.freeze({ kind: "initial" });

  /** Retires the live record (a run's failure recording with it); it admits nothing from now on. */
  function end(): RunOrigin | null {
    const ended = live;
    live = null;
    if (ended?.kind !== "run") return null;
    ended.failure.retire();
    return ended;
  }

  return {
    /** The live record: the initial one before the first activation, a retired one after disposal. */
    current: (): Origin => live ?? disposed,
    /** Whether `origin` still lives: what its completion may do anything for. */
    admits: (origin: Origin): boolean => origin === live,
    /**
     * Begins the next activation's record on `host`, retiring the live one: a run ends with the new run's begin, which
     * names it (`retires`).
     */
    begin(host: PlayerBridge): RunOrigin {
      const previous = end();
      const next: RunOrigin = {
        kind: "run",
        bridge: host,
        begin: Object.freeze({ run: host.nextRun(), retires: previous?.begin.run ?? null }),
        failure: useFailureRecording(),
      };
      live = next;
      return next;
    },
    /**
     * Settles `pending` for `origin`, in the one reaction attached to it: its `done` or `failed` while `origin` lives,
     * else its `retired` cleanup. A handler's error goes to `origin`'s error stop; a handler returns nothing, never a
     * promise, so no later work hides in it.
     */
    reply<T>(origin: Origin, pending: Promise<T>, handlers: ReplyHandlers<T>): Promise<void> {
      const settle = (outcome: Settlement<T>) => {
        try {
          const returned: unknown =
            live !== origin
              ? handlers.retired?.(outcome)
              : outcome.ok
                ? handlers.done(outcome.value)
                : handlers.failed(outcome.error);
          if (returned !== undefined) throw new TypeError("A reply's handler returns nothing.");
        } catch (error) {
          report(origin, error);
        }
      };
      return pending.then(
        (value) => settle({ ok: true, value }),
        (error: unknown) => settle({ ok: false, error }),
      );
    },
    /**
     * Revokes the live record for good at the loss of its connection: its failure recording goes, and nothing of it
     * acts from now on. The dead connection is asked nothing.
     */
    revoke(): void {
      end();
    },
    /** Retires the live record at the Player's disposal, before it gives up its bridge: the host ends its run. */
    retire(): void {
      const ended = end();
      if (ended !== null) void ended.bridge.retireRun(ended.begin.run).catch(() => {});
    },
  };
}

/** The stop arguments of a Player error `error` at stop `stop` in `origin`'s run, or `null` for the initial record. */
export function stopArguments(origin: Origin, error: string, stop: number): StopArguments | null {
  return origin.kind === "run" ? { error, stop, ...origin.begin } : null;
}
