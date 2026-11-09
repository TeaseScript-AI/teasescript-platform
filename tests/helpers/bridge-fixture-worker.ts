import { workerData } from "node:worker_threads";
import { isBuildIdentity } from "../../player/engine-bridge/protocol.js";
import { parentHostPort } from "../../player/engine-bridge/node-port.js";
import { CheckpointError } from "../../src/runtime/snapshot/checkpoint.js";
import {
  type BridgeOps,
  type HostSession,
  startBridgeHost,
} from "../../player/engine-bridge/worker-host.js";

/*
 * A bridge host with fixture ops around a counter session, so the bridge's rules (order, sessions, basis, release,
 * errors) are tested before any engine op exists. A counter's revision follows the Player's publication rule: every op
 * publishes a revision; one that changes the count makes earlier revisions stale.
 */
class Counter implements HostSession {
  count = 0;
  revision = 0;
  /** The first revision that shows the current count. */
  current = 0;
  accepts(basis: number | null): boolean {
    return basis !== null && basis >= this.current && basis <= this.revision;
  }
  publish(changed: boolean): void {
    this.revision += 1;
    if (changed) this.current = this.revision;
  }
}

const isCounterArgs = (args: unknown): args is { readonly by: number } =>
  typeof args === "object" &&
  args !== null &&
  Object.keys(args).length === 1 &&
  "by" in args &&
  typeof args.by === "number";

const ops: BridgeOps = {
  start: {
    session: "none",
    checkArguments: (args) => args === null,
    run: (_args, sessions) => ({ result: null, session: sessions.add(new Counter()) }),
  },
  add: {
    session: "existing",
    checkArguments: isCounterArgs,
    run: (args, _sessions, session) => {
      const counter = session?.value;
      if (!(counter instanceof Counter) || !isCounterArgs(args)) throw new Error("No counter.");
      const by = args.by;
      counter.count += by;
      counter.publish(by !== 0);
      return { result: counter.count };
    },
  },
  fail: {
    session: "existing",
    checkArguments: (args) => args === null,
    run: () => {
      const error = new RangeError("The counter cannot do that.");
      Object.assign(error, { code: "TSX001", path: "$.count" });
      throw error;
    },
    ends: () => true,
  },
  slow: {
    session: "none",
    checkArguments: (args) => typeof args === "number",
    run: async (args) => {
      await new Promise((resolve) => setTimeout(resolve, typeof args === "number" ? args : 0));
      return { result: args };
    },
  },
  checkpoint: {
    session: "none",
    checkArguments: (args) => args === null,
    // An engine error that keeps its diagnostic in `info`, as restoring a checkpoint throws it.
    run: () => {
      throw new CheckpointError({
        code: "TSK001",
        message: "Checkpoint snapshot is invalid.",
        path: "$.snapshot",
      });
    },
  },
  exit: {
    session: "none",
    checkArguments: (args) => args === null,
    // The worker ends while the request waits for its reply, as a crashed Worker would.
    run: () => process.exit(1),
  },
  clone: {
    session: "none",
    checkArguments: (args) => args === null,
    // A function cannot cross: the host answers with the DataCloneError instead.
    run: () => ({ result: () => 1 }),
  },
  echo: {
    session: "none",
    checkArguments: (_args): _args is unknown => true,
    // Its arguments come back as its result: a message of any shape both ways (`transport.ts`).
    run: (args) => ({ result: args }),
  },
  deepClone: {
    session: "none",
    checkArguments: (args) => typeof args === "number",
    // A function under `args` levels of lists: a deep result that cannot cross.
    run: (args) => {
      type Chain = { readonly kind: "list"; readonly items: readonly [Chain] } | (() => number);
      let value: Chain = () => 1;
      for (let level = 0; level < (typeof args === "number" ? args : 0); level += 1)
        value = { kind: "list", items: [value] };
      return { result: value };
    },
  },
};

const unknownBuild = { commit: null, dirty: null, mode: null, appVersion: null };
startBridgeHost(
  parentHostPort(),
  ops,
  isBuildIdentity(workerData?.build) ? workerData.build : unknownBuild,
);
