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

export function useActivationRun() {
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
