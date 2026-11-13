import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import type { DebugViewRequest } from "../../player/debug/debug-view.js";
import { connectBridge } from "../../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import type { PrepareResult, TracingIntent } from "../../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { coverageGaps, product, type Coordinates } from "../helpers/family-coverage.js";

/*
 * L5i.3, Sol r2 R2.1: the connection's value trace has one writer, the Player's newest tracing intent. Each change
 * carries its serial, through whichever channel brings it: the connection's queue (`debugTracing`) or Continue's epoch
 * (`restartTrace`). In any delivery order, the trace on the engine's Worker ends as the newest intent says.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };
const SCRIPT = 'let mood = "calm"\nsay "${mood} now", instant\nlet answer = askText "Ready?"\nexit';

// The family's axes, declared once.
const SEQUENCES = {
  on: [true],
  "on-off": [true, false],
  "on-off-on": [true, false, true],
} as const;
const SEQUENCE_NAMES = ["on", "on-off", "on-off-on"] as const;
const CARRIERS = ["queue", "restart"] as const;
const BACKENDS = ["worker"] as const;
type Carrier = (typeof CARRIERS)[number];
type Backend = (typeof BACKENDS)[number];

interface Case {
  readonly backend: Backend;
  readonly sequence: keyof typeof SEQUENCES;
  readonly carriers: readonly Carrier[];
  /** The order the toggles are delivered in, by their index in the sequence. */
  readonly order: readonly number[];
  readonly name: string;
}

function permutations(items: readonly number[]): number[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item) =>
    permutations(items.filter((other) => other !== item)).map((rest) => [item, ...rest]),
  );
}

function tuples(length: number, of: readonly Carrier[]): Carrier[][] {
  if (length === 0) return [[]];
  return tuples(length - 1, of).flatMap((rest) => of.map((carrier) => [...rest, carrier]));
}

/** Every case, each named exactly by its axis values. */
const CASES: readonly Case[] = BACKENDS.flatMap((backend) =>
  SEQUENCE_NAMES.flatMap((sequence) => {
    const length = SEQUENCES[sequence].length;
    return tuples(length, CARRIERS).flatMap((assigned) =>
      permutations([...Array(length).keys()]).map((order) => ({
        backend,
        sequence,
        carriers: assigned,
        order,
        name: `${backend} ${sequence} [${assigned.join(",")}] order ${order.join("")}`,
      })),
    );
  }),
);

/** A case's coordinates: its backend and sequence, each position's carrier, and the position delivered first. */
const coordinates = (each: Case): Coordinates => ({
  backend: each.backend,
  sequence: each.sequence,
  ...Object.fromEntries(each.carriers.map((carrier, position) => [`carrier ${position}`, carrier])),
  first: String(each.order[0]),
});
/** The feasible coordinates, enumerated apart from `CASES`. */
const FEASIBLE = BACKENDS.flatMap((backend) =>
  SEQUENCE_NAMES.flatMap((sequence) => {
    const positions = [...Array(SEQUENCES[sequence].length).keys()];
    return product({
      ...Object.fromEntries(positions.map((position) => [`carrier ${position}`, [...CARRIERS]])),
      first: positions.map(String),
    }).map((tuple) => ({ backend, sequence, ...tuple }));
  }),
);

test("the family covers every feasible pair of its axes", () => {
  const names = new Set(CASES.map((each) => each.name));
  assert.equal(names.size, CASES.length, "names are unique");
  const observed = CASES.map(coordinates);
  assert.deepEqual(coverageGaps(FEASIBLE, observed, { tuples: true }), []);
  assert.equal(CASES.length, 2 + 8 + 48);
  // The check fails a family that lacks a slice of carrier × first delivery.
  const lacking = observed.filter(
    (tuple) => !(tuple["carrier 0"] === "restart" && tuple.first === "0"),
  );
  assert.ok(coverageGaps(FEASIBLE, lacking).some((gap) => gap.startsWith("missing pair")));
});

async function prepared(bridge: PlayerBridge): Promise<string> {
  const plan = compilePlayerProject(SCRIPT).plan;
  assert.ok(plan);
  const reply = await bridge.client.request("prepare", {
    source: { kind: "plan", text: serializeValidatedRuntimeJson(plan) },
  });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

const recent: DebugViewRequest = {
  messages: { limit: 20, openNewest: false },
  selected: null,
  variables: null,
  image: false,
  trees: {},
};

/** Plays one case: delivers each toggle through its carrier in the case's order, then checks the trace. */
async function play(bridge: PlayerBridge, each: Case) {
  const plan = await prepared(bridge);
  // A held session, for `restartTrace`.
  const held = await bridge.start(plan, START, false);
  const intents: TracingIntent[] = SEQUENCES[each.sequence].map((on, index) => ({
    on,
    intent: index + 1,
  }));
  for (const index of each.order) {
    const intent = intents[index]!;
    const carrier = each.carriers[index]!;
    if (carrier === "queue") await bridge.client.request("debugTracing", intent);
    else await bridge.request(held, "restartTrace", { tracing: intent });
  }
  // The trace as the newest intent says.
  const newest = intents.length - 1;
  const view = await bridge.read(held, "debugView", { request: recent });
  assert.equal(
    view.status !== null,
    intents[newest]!.on,
    `${each.name}: the trace is on as asked last`,
  );
}

for (const backend of BACKENDS)
  test(`the trace follows the newest tracing intent in every delivery order (${backend})`, async () => {
    for (const each of CASES.filter((one) => one.backend === backend)) {
      // A connection of its own per case: the serials are per connection.
      const bridge = new PlayerBridge(
        await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD),
      );
      try {
        await play(bridge, each);
      } finally {
        bridge.client.terminate();
      }
    }
  });
