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
 * Return and Debug-off keep the run.
 */

/** One activation's run: its bridge, its begin as the host receives it, and its failure recording. */
export interface ActivationRun {
  readonly bridge: PlayerBridge;
  readonly begin: RunBegin;
  readonly failure: ReturnType<typeof useFailureRecording>;
}

export function useActivationRun() {
  let live: ActivationRun | null = null;

  /** Retires the live record's failure recording; the record admits nothing from now on. */
  function end(): ActivationRun | null {
    const ended = live;
    live = null;
    ended?.failure.retire();
    return ended;
  }

  return {
    /** The live activation's record, or `null` before the first activation and after disposal. */
    current: (): ActivationRun | null => live,
    /** Whether `origin` still lives: what its completion may do anything for. */
    admits: (origin: ActivationRun): boolean => origin === live,
    /**
     * Begins the next activation's record on `host`, retiring the live one: its run ends with the new run's begin,
     * which names it (`retires`).
     */
    begin(host: PlayerBridge): ActivationRun {
      const previous = end();
      live = {
        bridge: host,
        begin: Object.freeze({ run: host.nextRun(), retires: previous?.begin.run ?? null }),
        failure: useFailureRecording(),
      };
      return live;
    },
    /** Retires the live record at the Player's disposal, before it gives up its bridge: the host ends its run. */
    retire(): void {
      const ended = end();
      if (ended !== null) void ended.bridge.retireRun(ended.begin.run).catch(() => {});
    },
  };
}

/** The stop arguments of a Player error `error` at stop `stop` in `origin`'s run, or `null` outside any run. */
export function stopArguments(
  origin: ActivationRun | null,
  error: string,
  stop: number,
): StopArguments | null {
  return origin === null ? null : { error, stop, ...origin.begin };
}
