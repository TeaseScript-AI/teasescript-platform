// The four modes the type core's oracles compare a program in, and how a test runs in one.
import { withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import { withoutSharing } from "../../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../../src/type-inference/core/solver.js";

/** One of the four modes an analysis is compared in: the consumers' and the worklist's order, and the sharing. */
export interface Mode {
  readonly reversed: boolean;
  readonly unshared: boolean;
}

/** The four modes: source order and reversed, each with the sharing on and off. */
export const MODES: readonly Mode[] = [false, true].flatMap((reversed) =>
  [false, true].map((unshared) => ({ reversed, unshared })),
);

/** `run` in the consumers' and the solver's worklist's reversed order, or as it is. */
export function inOrder<T>(reversed: boolean, run: () => T): T {
  return reversed
    ? withConsumerOrder(
        (list) => [...list].reverse(),
        () => withSolverSeam({ reverseWorklist: true }, run),
      )
    : run();
}

/** `run` in `mode`. */
export function inMode<T>(mode: Mode, run: () => T): T {
  const ordered = (): T => inOrder(mode.reversed, run);
  return mode.unshared ? withoutSharing(ordered) : ordered();
}
