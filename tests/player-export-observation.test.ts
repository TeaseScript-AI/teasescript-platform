import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../player/compile-project.js";
import { connectBridge } from "../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { ExportCaptureReply } from "../player/engine-bridge/session-protocol.js";
import {
  advanceExportObservation,
  ExportObservation,
  type Observation,
  type ObservedSession,
} from "../player/engine-bridge/recording/export-observation.js";
import { PlayerBridge } from "../player/player-bridge.js";
import { coverageGaps, product, type Coordinates } from "./helpers/family-coverage.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";
import { preparedPlan } from "./helpers/prepared-plan.js";

/*
 * L5h.3b's export observation family (`recording/export-observation.ts`, `captureExport`), through the host's ops,
 * in-process and over a Worker. The domain: a storage edit before the stop or none × a Player error stop (none, once,
 * twice) × its order against the capture at the same revision × the recording selected (the session's current one, an
 * explicit ticket, no session) × the transport. Each case checks, apart: the capture's identity, its marks, its
 * incident, its recording choice, and that its ticket is let go of. R2-3's row (an edit, then a stop) expects the mark.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const PLAN = compilePlayerProject(
  'let name = askText "Name?"\nsay "Hi ${name}", instant\nexit',
).plan!;

const AXES = {
  edit: ["none", "edited"],
  stop: ["none", "once", "twice"],
  order: ["captureFirst", "stopFirst"],
  recording: ["current", "ticket", "noSession"],
  transport: ["inProcess", "worker"],
} as const;
type Axis = keyof typeof AXES;
type Value<A extends Axis> = (typeof AXES)[A][number];

/** Infeasible: without a stop, there is no order against it. */
const feasible = (c: Coordinates) => !(c.stop === "none" && c.order === "stopFirst");

async function bridgeOn(transport: Value<"transport">): Promise<PlayerBridge> {
  if (transport === "inProcess") return inProcessBridge();
  return new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
}

interface Observed {
  readonly identity: unknown;
  readonly edited: boolean;
  readonly incident: unknown;
  readonly recording: "held" | "none";
  readonly released: boolean;
}

async function runCase(c: { readonly [A in Axis]: Value<A> }): Promise<Observed> {
  const bridge = await bridgeOn(c.transport);
  try {
    await bridge.beginRun(1, null);
    const plan = await preparedPlan(Promise.resolve(bridge), PLAN);
    const session = await bridge.start(plan, { wallClockMs: 0 }, true);
    if (c.edit === "edited")
      await bridge.request(session, "applyStorageEdit", { key: "edited", value: 1 });
    const recorded = await bridge.read(session, "captureRecording");
    assert.equal(recorded.kind, "captured");
    const recording =
      c.recording === "ticket" && recorded.kind === "captured"
        ? { ticket: recorded.ticket }
        : "current";
    const stops = c.stop === "none" ? [] : c.stop === "once" ? [1] : [1, 2];
    const stop = async () => {
      for (const at of stops)
        await bridge.client.signal("halt", { error: "TypeError", run: 1, stop: at }, session.id);
    };
    const capture = async () => {
      const reply = await bridge.client.request("captureExport", {
        session: c.recording === "noSession" ? null : session.id,
        recording,
      });
      // EVIDENCE: validation: `captureExport` replies from the same build with `ExportCaptureReply`.
      return reply.result as ExportCaptureReply;
    };
    let captured: ExportCaptureReply;
    if (c.order === "captureFirst") {
      captured = await capture();
      await stop();
    } else {
      await stop();
      captured = await capture();
    }
    assert.equal(captured.kind, "captured");
    if (captured.kind !== "captured") throw new Error("not captured");
    await bridge.releaseRecording(captured.ticket);
    const released = await bridge.client
      .request("exportPrepare", { ticket: captured.ticket, replay: false })
      .then(
        () => false,
        () => true,
      );
    return {
      identity: captured.identity,
      edited: captured.marks?.editedWhileDebugging != null,
      incident:
        captured.incident === null
          ? null
          : { errorName: captured.incident.errorName, stop: captured.incident.stop },
      recording: captured.recording === null ? "none" : "held",
      released,
    };
  } finally {
    bridge.client.terminate();
  }
}

/** What each case must give, from its coordinates alone. */
function expected(c: { readonly [A in Axis]: Value<A> }): Observed {
  const withSession = c.recording !== "noSession";
  const stoppedBefore = c.stop !== "none" && c.order === "stopFirst";
  // The start delivers its say and question; an applied edit adds its event.
  const events = c.edit === "edited" ? 3 : 2;
  return {
    identity: withSession
      ? {
          run: 1,
          session: "s1",
          revision: c.edit === "edited" ? 2 : 1,
          eventsThrough: events,
          // The first stop froze the session; the second changes nothing.
          stop: stoppedBefore ? 1 : null,
        }
      : { run: 1, session: null, revision: null, eventsThrough: null, stop: null },
    // The mark of an applied edit, which the stop keeps (R2-3); no session, no marks.
    edited: withSession && c.edit === "edited",
    // The run's first committed incident, once the stop committed before the capture; with no session too.
    incident: stoppedBefore ? { errorName: "TypeError", stop: 1 } : null,
    recording: withSession ? "held" : "none",
    released: true,
  };
}

test("a debug export's capture observes the identity, marks, incident and recording its schedule decides", async () => {
  const cases = product({ ...AXES }).filter(feasible);
  const observed: Coordinates[] = [];
  for (const coordinates of cases) {
    // EVIDENCE: invariant: `product` gives the declared axes' values.
    const c = coordinates as { readonly [A in Axis]: Value<A> };
    assert.deepEqual(await runCase(c), expected(c), JSON.stringify(c));
    observed.push(coordinates);
  }
  assert.deepEqual(
    coverageGaps(product({ ...AXES }).filter(feasible), observed, { tuples: true }),
    [],
  );
});

test("the observation's deciding function holds a stop pending until its commit, keeps the first incident, and forgets a retired run", () => {
  const owner = new ExportObservation();
  const session: { run: number | null; observation: unknown } = { run: null, observation: null };
  const stop = (at: number, error = "TypeError") => ({ error, run: 1, stop: at });
  // EVIDENCE: fixture: an observed session is its run and latest observation, which this literal has.
  const observed = session as ObservedSession;
  const steps: [string, unknown][] = [];
  const step = (name: string, observation: Observation) =>
    steps.push([name, advanceExportObservation(owner, observation)]);
  step("capture before any run", { kind: "capture", run: 1 });
  step("begin", { kind: "beginRun", run: 1, retires: null });
  step("bind", { kind: "bindSession", session: observed, run: owner.current });
  step("publish", { kind: "publication", session: observed, revision: 3, eventsThrough: 5 });
  step("capture, no stop", { kind: "capture", run: 1 });
  step("stop requested", { kind: "stopRequested", stop: stop(1) });
  step("capture while pending", { kind: "capture", run: 1 });
  step("stop committed", {
    kind: "stopCommitted",
    stop: stop(1),
    session: { run: 1, revision: 3, eventsThrough: 5 },
  });
  step("second stop committed", {
    kind: "stopCommitted",
    stop: stop(2, "RangeError"),
    session: { run: 1, revision: 4, eventsThrough: 6 },
  });
  step("capture after", { kind: "capture", run: 1 });
  step("capture of no run", { kind: "capture", run: null });
  step("next run retires it", { kind: "beginRun", run: 2, retires: 1 });
  step("capture of the retired run", { kind: "capture", run: 1 });
  step("retire", { kind: "retire", run: 2 });
  const incident = { errorName: "TypeError", run: 1, stop: 1, revision: 3, eventsThrough: 5 };
  assert.deepEqual(steps, [
    ["capture before any run", { kind: "incident", incident: null }],
    ["begin", { kind: "recorded" }],
    ["bind", { kind: "recorded" }],
    ["publish", { kind: "recorded" }],
    ["capture, no stop", { kind: "incident", incident: null }],
    ["stop requested", { kind: "recorded" }],
    ["capture while pending", { kind: "pending" }],
    ["stop committed", { kind: "incident", incident }],
    ["second stop committed", { kind: "incident", incident }],
    ["capture after", { kind: "incident", incident }],
    ["capture of no run", { kind: "incident", incident: null }],
    ["next run retires it", { kind: "recorded" }],
    ["capture of the retired run", { kind: "incident", incident: null }],
    ["retire", { kind: "recorded" }],
  ]);
  assert.deepEqual(session, { run: 1, observation: { run: 1, revision: 3, eventsThrough: 5 } });
  assert.equal(owner.current, null);
});
