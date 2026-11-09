import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import { NO_MARKS } from "../../player/debug/debug-history-marks.js";
import { heldRuns, introduceNow } from "../../player/engine-bridge/in-process.js";
import { connectBridge, openBridge, type ClientPort } from "../../player/engine-bridge/client.js";
import {
  closeConnection,
  playerBridgeOps,
  playerOpsContext,
} from "../../player/engine-bridge/player-ops.js";
import { decodeMessage } from "../../player/engine-bridge/transport.js";
import {
  startBridgeHost,
  type HostPort,
  type HostSessions,
} from "../../player/engine-bridge/worker-host.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import { activePlayerRuntimeInteraction } from "../../player/runtime/runtime-view.js";
import {
  formObligations,
  malformedArguments,
  VALID_VALUES,
  type ArgumentForm,
} from "../helpers/bridge/argument-forms.js";
import { coverageGaps, product } from "../helpers/family-coverage.js";
import { inProcessBridge } from "../helpers/in-process-bridge.js";
import { preparedPlan } from "../helpers/prepared-plan.js";
import { asMalformed, untypedClient } from "../helpers/bridge/untyped.js";

/*
 * The recording and debug-export ops' surfaces (L5h.3b, `ops/recording.ts`): each op's argument forms, refused when
 * malformed and admitted with every declared valid witness of each class; the halt's stop arguments likewise; and each
 * op's outcomes, the same in-process and over a Worker.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
const PLAN = compilePlayerProject('say "Hello", instant\nlet name = askText "Name?"\nexit').plan!;

const worker = async () =>
  new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));

/** Runs `body` on the in-process backend and on a Node Worker; terminates the Worker after. */
async function onBoth<T>(body: (bridge: PlayerBridge) => Promise<T>): Promise<[T, T]> {
  const inProcess = await body(await inProcessBridge());
  const remote = await worker();
  try {
    return [inProcess, await body(remote)];
  } finally {
    remote.client.terminate();
  }
}

type Answer = { readonly answer: unknown } | { readonly name: string; readonly message: string };

/** What a row compares of a result: plain data. */
type Answered = string | number | boolean | object | null;
/** `value` as plain data; anything else as its text. */
function answered(value: unknown): Answered {
  if (value === null || typeof value === "object") return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  return String(value);
}

/** The answer of `request`, its result projected by `project`, or its refusal. */
async function answerOf(
  request: Promise<{ readonly result: unknown }>,
  project: (result: unknown) => Answered = answered,
): Promise<Answer> {
  try {
    return { answer: project((await request).result) };
  } catch (error) {
    assert.ok(error instanceof Error);
    return { name: error.name, message: error.message };
  }
}

const MALFORMED = (op: string): Answer => ({
  name: "BridgeRefusal",
  message: `Malformed arguments for '${op}'.`,
});

/** Each op's argument forms. */
const ARGUMENTS = {
  retireRun: [{ required: { run: "integer" } }],
  commitIncident: [
    { required: { error: "string", run: "integer", stop: "integer", retires: "nullableInteger" } },
  ],
  captureRecording: [{ required: { session: "string" } }],
  captureExport: [{ required: { session: "nullableString", recording: "selector" } }],
  exportPrepare: [{ required: { ticket: "string", replay: "boolean" } }],
  releaseRecording: [{ required: { ticket: "string" } }],
} as const satisfies Record<string, readonly ArgumentForm[]>;
type RecordingOp = keyof typeof ARGUMENTS;
// EVIDENCE: invariant: the keys of `ARGUMENTS`, declared literally above.
const OPS = Object.keys(ARGUMENTS) as RecordingOp[];

/** A Player error stop's halt arguments. */
const HALT: readonly ArgumentForm[] = [
  { required: { error: "string", run: "integer", stop: "integer", retires: "nullableInteger" } },
];

test("every recording op refuses each malformed argument its forms oblige, and admits every declared valid witness", async () => {
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const answers: Record<string, Answer> = {};
    for (const op of OPS) {
      for (const { id, args } of malformedArguments(ARGUMENTS[op]))
        answers[`${op} ${id}`] = await answerOf(untypedClient(bridge.client).request(op, args));
      // Each valid value of each field, the other fields at their first: never refused as malformed.
      const [form] = ARGUMENTS[op];
      for (const [field, kind] of Object.entries(form.required))
        for (const [index, value] of VALID_VALUES[kind].entries()) {
          const args = Object.fromEntries(
            Object.entries(form.required).map(([name, of]) => [
              name,
              name === field ? value : VALID_VALUES[of][0],
            ]),
          );
          const answer = await answerOf(untypedClient(bridge.client).request(op, args));
          answers[`${op} ${field} valid ${index + 1}`] = {
            answer:
              JSON.stringify(answer) === JSON.stringify(MALFORMED(op)) ? "malformed" : "admitted",
          };
        }
    }
    return answers;
  });
  assert.deepEqual(remote, inProcess);
  for (const op of OPS) {
    const malformed = Object.keys(inProcess)
      .filter((key) => key.startsWith(`${op} `) && !key.includes(" valid "))
      .map((key) => key.slice(op.length + 1));
    assert.deepEqual(malformed, formObligations(ARGUMENTS[op]), `${op}'s malformed forms`);
    for (const id of malformed)
      assert.deepEqual(inProcess[`${op} ${id}`], MALFORMED(op), `${op} ${id}`);
    for (const [key, answer] of Object.entries(inProcess))
      if (key.startsWith(`${op} `) && key.includes(" valid "))
        assert.deepEqual(answer, { answer: "admitted" }, key);
  }
});

test("a halt refuses malformed stop arguments, and a valid stop or none halts", async () => {
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const plan = await preparedPlan(Promise.resolve(bridge), PLAN);
    const answers: Record<string, Answer> = {};
    for (const { id, args } of malformedArguments(HALT).filter(({ id }) => id !== "null")) {
      const session = await bridge.start(plan, { wallClockMs: 0 }, false);
      // Malformed on purpose: the host refuses them.
      answers[id] = await answerOf(bridge.client.signal("halt", asMalformed(args), session.id));
    }
    const stopped = await bridge.start(plan, { wallClockMs: 0 }, false);
    answers["valid"] = await answerOf(
      bridge.client.signal(
        "halt",
        { error: "TypeError", run: 1, stop: 1, retires: null },
        stopped.id,
      ),
      (result) =>
        typeof result === "object" && result !== null
          ? Object.keys(result).sort()
          : answered(result),
    );
    const plain = await bridge.start(plan, { wallClockMs: 0 }, false);
    answers["none"] = await answerOf(bridge.client.signal("halt", null, plain.id), (result) =>
      typeof result === "object" && result !== null ? Object.keys(result).sort() : answered(result),
    );
    return answers;
  });
  assert.deepEqual(remote, inProcess);
  // A halt without arguments is a plain stop (`none` below), so `null` is no malformed form of the halt.
  const malformed = Object.keys(inProcess).filter((key) => key !== "valid" && key !== "none");
  assert.deepEqual(
    malformed,
    formObligations(HALT).filter((id) => id !== "null"),
  );
  for (const id of malformed) assert.deepEqual(inProcess[id], MALFORMED("halt"), id);
  // A Player error stop's acknowledgement carries its diagnostic identity and incident; a plain one only the call view.
  assert.deepEqual(inProcess["valid"], {
    answer: ["callView", "diagnostic", "incident", "instructions", "revision"],
  });
  assert.deepEqual(inProcess["none"], { answer: ["callView", "instructions", "revision"] });
});

test("the recording ops' outcomes answer as written, in-process and in a Worker", async () => {
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const plan = await preparedPlan(Promise.resolve(bridge), PLAN);
    const outcomes: Record<string, unknown> = {};
    const kind = (result: unknown) =>
      answered(
        typeof result === "object" && result !== null && "kind" in result ? result.kind : result,
      );
    // The first Start begins run 1.
    const recorded = await bridge.start(plan, { wallClockMs: 0 }, true, undefined, {
      run: 1,
      retires: null,
    });
    // A second session, started without the recorder, whose engine the recorder does not record.
    const unrecorded = await bridge.start(plan, { wallClockMs: 0 }, false);
    const captured = await bridge.read(recorded, "captureRecording");
    outcomes["captureRecording recorded"] = {
      ...captured,
      ticket: "ticket" in captured ? typeof captured.ticket : "absent",
    };
    outcomes["captureRecording unrecorded"] = await bridge.read(unrecorded, "captureRecording");
    const ticket = captured.kind === "captured" ? captured.ticket : "";
    const exported = (session: string | null, recording: unknown) =>
      answerOf(
        untypedClient(bridge.client).request("captureExport", { session, recording }),
        (result) => {
          // EVIDENCE: fixture: `captureExport` replies with `ExportCaptureReply`, read here only in these fields.
          const reply = result as {
            kind: string;
            ticket?: string;
            recording?: unknown;
            identity?: unknown;
          };
          return {
            kind: reply.kind,
            recording:
              reply.recording === undefined ? "absent" : reply.recording === null ? "none" : "held",
            identity: reply.identity ?? null,
          };
        },
      );
    outcomes["captureExport current"] = await exported(recorded.id, "current");
    outcomes["captureExport ticket"] = await exported(recorded.id, { ticket });
    outcomes["captureExport another session's recording"] = await exported(unrecorded.id, {
      ticket,
    });
    outcomes["captureExport stale current"] = await exported(unrecorded.id, "current");
    outcomes["captureExport no session"] = await exported(null, "current");
    outcomes["captureExport unknown ticket"] = await exported(recorded.id, { ticket: "r0" });
    const exportTicket = await bridge.client.request("captureExport", {
      session: recorded.id,
      recording: "current",
    });
    // EVIDENCE: fixture: a capture of a held session with its current recording is `captured`, with its ticket.
    const held = (exportTicket.result as { ticket: string }).ticket;
    outcomes["captureExport an export ticket as recording"] = await exported(recorded.id, {
      ticket: held,
    });
    const prepared = (replay: boolean, of: string) =>
      answerOf(bridge.client.request("exportPrepare", { ticket: of, replay }), (result) => {
        // EVIDENCE: fixture: `exportPrepare` replies with `PreparedExport`, read here only in these fields.
        const parts = result as {
          contentHash: unknown;
          checkpointRole: unknown;
          omissions: unknown;
        };
        return {
          hashed: typeof parts.contentHash === "string",
          role: parts.checkpointRole,
          omissions: parts.omissions,
        };
      });
    outcomes["exportPrepare replay"] = await prepared(true, held);
    outcomes["exportPrepare no replay"] = await prepared(false, held);
    outcomes["exportPrepare a recording ticket"] = await prepared(true, ticket);
    outcomes["releaseRecording held"] = await answerOf(
      bridge.client.request("releaseRecording", { ticket: held }),
    );
    outcomes["exportPrepare released"] = await prepared(true, held);
    outcomes["releaseRecording unknown"] = await answerOf(
      bridge.client.request("releaseRecording", { ticket: "r0" }),
    );
    outcomes["commitIncident"] = await answerOf(
      bridge.client.request("commitIncident", {
        error: "TypeError",
        run: 1,
        stop: 7,
        retires: null,
      }),
    );
    outcomes["commitIncident again"] = await answerOf(
      bridge.client.request("commitIncident", {
        error: "RangeError",
        run: 1,
        stop: 8,
        retires: null,
      }),
      kind,
    );
    outcomes["commitIncident unbegun run"] = await answerOf(
      bridge.client.request("commitIncident", {
        error: "TypeError",
        run: 9,
        stop: 1,
        retires: null,
      }),
    );
    await bridge.retireRun(1);
    outcomes["commitIncident retired run"] = await answerOf(
      bridge.client.request("commitIncident", {
        error: "TypeError",
        run: 1,
        stop: 9,
        retires: null,
      }),
    );
    // The refusal changed nothing of the live run: its first incident stays.
    outcomes["commitIncident live run after the refusal"] = await answerOf(
      bridge.client.request("commitIncident", {
        error: "RangeError",
        run: 9,
        stop: 2,
        retires: null,
      }),
    );
    return outcomes;
  });
  assert.deepEqual(remote, inProcess);
  const identity = (session: string) => ({
    run: 1,
    session,
    revision: 1,
    eventsThrough: 3,
    stop: null,
  });
  const NO_RECORDING = { name: "Error", message: "No recording is held under this ticket." };
  const NO_EXPORT = { name: "Error", message: "No export is held under this ticket." };
  const incident = { errorName: "TypeError", run: 1, stop: 7, revision: null, eventsThrough: null };
  assert.deepEqual(inProcess, {
    "captureRecording recorded": {
      kind: "captured",
      ticket: "string",
      end: "live",
      complete: true,
    },
    "captureRecording unrecorded": { kind: "stale" },
    "captureExport current": {
      answer: { kind: "captured", recording: "held", identity: identity("s1") },
    },
    "captureExport ticket": {
      answer: { kind: "captured", recording: "held", identity: identity("s1") },
    },
    // An explicit ticket may name another lineage's recording.
    "captureExport another session's recording": {
      answer: { kind: "captured", recording: "held", identity: identity("s2") },
    },
    "captureExport stale current": {
      answer: { kind: "refused", recording: "absent", identity: null },
    },
    "captureExport no session": {
      answer: {
        kind: "captured",
        recording: "none",
        identity: { run: 1, session: null, revision: null, eventsThrough: null, stop: null },
      },
    },
    "captureExport unknown ticket": NO_RECORDING,
    "captureExport an export ticket as recording": NO_RECORDING,
    "exportPrepare replay": { answer: { hashed: true, role: "current", omissions: [] } },
    "exportPrepare no replay": { answer: { hashed: true, role: null, omissions: [] } },
    "exportPrepare a recording ticket": NO_EXPORT,
    "releaseRecording held": { answer: null },
    "exportPrepare released": NO_EXPORT,
    "releaseRecording unknown": { answer: null },
    commitIncident: { answer: incident },
    // The first committed incident stays the run's.
    "commitIncident again": { answer: incident },
    // A run the host has not begun, as one whose Start failed in its host, begins with its incident.
    "commitIncident unbegun run": {
      answer: { errorName: "TypeError", run: 9, stop: 1, revision: null, eventsThrough: null },
    },
    // Run 9 began after run 1, which ended then: its incident is refused, before any effect, and never begins it anew.
    "commitIncident retired run": {
      name: "RetiredRunError",
      message: "Diagnostic run 1 has ended.",
    },
    "commitIncident live run after the refusal": {
      answer: { errorName: "TypeError", run: 9, stop: 1, revision: null, eventsThrough: null },
    },
  });
});

/*
 * Design round r2's host half: retirement is absorbing. A run the Player retired before the host saw any carrier of it
 * begins nowhere: every carrier (a Start's, Continue's handoff, an incident's, a halt's) is refused before any effect,
 * with no session, recorder, binding or halt; a later run's observation then stays its own across replays of the
 * retired run and a late retirement of it. The in-process introduction is the facade's, so in-process only.
 */
test("a run retired before the host saw it begins through no carrier, and a later run's observation stays its own", async () => {
  const RETIRED = { name: "RetiredRunError", message: "Diagnostic run 1 has ended." };
  const ENDED_HALT = {
    name: "BridgeRefusal",
    message: "The halt names a diagnostic run that ended.",
  };
  const run1 = { run: 1, retires: null };
  const stopOf = (run: number, stop: number) => ({ error: "TypeError", run, stop, retires: null });
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const plan = await preparedPlan(Promise.resolve(bridge), PLAN);
    const outcomes: Record<string, unknown> = {};
    // The identity a session's capture reports, and whether the session still runs (no halt took it).
    const observe = async (session: { readonly id: string }) => {
      const reply = await bridge.client.request("captureExport", {
        session: session.id,
        recording: "none",
      });
      // EVIDENCE: fixture: a capture of a held session replies `captured`, with its identity and ticket.
      const captured = reply.result as {
        readonly identity: {
          readonly session: string | null;
          readonly run: number | null;
          readonly stop: number | null;
        };
        readonly incident: unknown;
        readonly ticket: string;
      };
      await bridge.releaseRecording(captured.ticket);
      const runs = await bridge.client
        .request("viewCalls", { on: false }, { session: session.id, basis: null })
        .then(
          () => true,
          () => false,
        );
      const { session: id, run, stop } = captured.identity;
      return { identity: { session: id, run, stop }, incident: captured.incident, runs };
    };
    await bridge.retireRun(1);
    // A session outside any run, which the replays below name.
    const outside = await bridge.start(plan, { wallClockMs: 0 }, false);
    outcomes["start"] = await answerOf(
      bridge.client.request("start", {
        plan,
        options: { wallClockMs: 0 },
        recording: true,
        run: run1,
      }),
    );
    outcomes["beginRecording"] = await answerOf(
      bridge.request(outside, "beginRecording", run1).then((result) => ({ result })),
    );
    outcomes["commitIncident"] = await answerOf(
      bridge.client.request("commitIncident", stopOf(1, 1)),
    );
    outcomes["halt"] = await answerOf(bridge.client.signal("halt", stopOf(1, 2), outside.id));
    outcomes["outside, after"] = await observe(outside);
    // A real later run, then the retired run's replays and a late retirement of it.
    const later = await bridge.start(plan, { wallClockMs: 0 }, true, undefined, {
      run: 2,
      retires: 1,
    });
    const before = await observe(later);
    outcomes["replayed start"] = await answerOf(
      bridge.client.request("start", {
        plan,
        options: { wallClockMs: 0 },
        recording: true,
        run: run1,
      }),
    );
    outcomes["replayed incident"] = await answerOf(
      bridge.client.request("commitIncident", stopOf(1, 3)),
    );
    outcomes["replayed halt"] = await answerOf(
      bridge.client.signal("halt", stopOf(1, 4), later.id),
    );
    await bridge.retireRun(1);
    outcomes["later, unchanged"] = isDeepStrictEqual(await observe(later), before)
      ? before
      : "changed";
    return outcomes;
  });
  assert.deepEqual(remote, inProcess);
  const untouched = {
    identity: { session: "s1", run: null, stop: null },
    incident: null,
    runs: true,
  };
  assert.deepEqual(inProcess, {
    start: RETIRED,
    beginRecording: RETIRED,
    commitIncident: RETIRED,
    halt: ENDED_HALT,
    // Bound to no run, unhalted: the refused carriers changed nothing of it, and the refused Start made no session.
    "outside, after": untouched,
    "replayed start": RETIRED,
    "replayed incident": RETIRED,
    "replayed halt": ENDED_HALT,
    "later, unchanged": {
      identity: { session: "s2", run: 2, stop: null },
      incident: null,
      runs: true,
    },
  });
});

test("an in-process introduction of a retired run makes nothing", async () => {
  const bridge = await inProcessBridge();
  await bridge.retireRun(1);
  let made = 0;
  assert.throws(
    () =>
      introduceNow(
        bridge,
        () => {
          made += 1;
          return createPlayerRuntimeSession('say "Hello", instant\nexit');
        },
        NO_MARKS,
        undefined,
        undefined,
        { run: 1, retires: null },
      ),
    { name: "RetiredRunError" },
  );
  assert.equal(made, 0, "the factory never ran");
  assert.deepEqual(heldRuns(bridge), []);
});

/*
 * Recording provenance over the host's begin routes (§21.4 family 2): a Start that records, and the `beginRecording` op
 * (Continue's) on a session started without the recorder × when the capture comes × the transport. The recorder's end
 * kinds are its own family (`player-debug-recorder.test.ts`); the routes a test cannot reach through these ops (L5i.6's
 * history restores, `introduceNow`, raw restores) converge on the same begin, which `player-recording-routes.test.ts`
 * censuses.
 */
const ROUTES = ["start", "beginRecording"] as const;
const TIMINGS = ["same", "afterAnotherStart", "afterRelease", "noRecorder", "afterStop"] as const;

test("a recording capture answers for the session whose engine began the recording, by route and timing", async () => {
  const cases = product({ route: [...ROUTES], timing: [...TIMINGS] });
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const answers: Record<string, unknown> = {};
    for (const { route, timing } of cases) {
      const plan = await preparedPlan(Promise.resolve(bridge), PLAN);
      // A connection's recorder records one engine at a time; each case begins it anew, or leaves it detached.
      const begun =
        timing === "noRecorder"
          ? null
          : route === "start"
            ? await bridge.start(plan, { wallClockMs: 0 }, true)
            : await bridge.start(plan, { wallClockMs: 0 }, false);
      if (begun !== null && route === "beginRecording")
        await bridge.request(begun, "beginRecording", null);
      const target = begun ?? (await bridge.start(plan, { wallClockMs: 0 }, false));
      if (timing === "afterAnotherStart") await bridge.start(plan, { wallClockMs: 0 }, true);
      if (timing === "afterStop")
        await bridge.client.signal(
          "halt",
          { error: "TypeError", run: 1, stop: 1, retires: null },
          target.id,
        );
      if (timing === "afterRelease")
        await bridge.client.request("release", null, { session: target.id });
      answers[`${route} ${timing}`] = await bridge.read(target, "captureRecording").then(
        (reply) => (reply.kind === "captured" ? `captured ${reply.end}` : reply.kind),
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      );
      // The teardown between cases detaches the recorder: an unrecorded session's capture is then stale.
      await bridge.client.request("teardown", null);
    }
    return answers;
  });
  assert.deepEqual(remote, inProcess);
  const expected = Object.fromEntries(
    cases.map(({ route, timing }) => [
      `${route} ${timing}`,
      timing === "afterAnotherStart"
        ? "stale"
        : timing === "afterRelease"
          ? "SessionGoneError"
          : timing === "noRecorder"
            ? "stale"
            : "captured live",
    ]),
  );
  assert.deepEqual(inProcess, expected);
  assert.deepEqual(
    coverageGaps(
      cases,
      Object.keys(inProcess).map((key) => {
        const [route, timing] = key.split(" ");
        return { route: route!, timing: timing! };
      }),
      { tuples: true },
    ),
    [],
  );
});

/** A connection of production parts whose port fails the next success post of one op, as `player-history-ops`' does. */
function failingConnection() {
  const context = playerOpsContext();
  const opOf = new Map<number, string>();
  let failing: string | null = null;
  let toHost: ((data: unknown) => void) | null = null;
  let toClient: ((data: unknown) => void) | null = null;
  const hostPort: HostPort = {
    post: (message) => {
      const data = decodeMessage(structuredClone(message));
      // EVIDENCE: fixture: this port carries only the messages the host posts, each with these fields where it has them.
      const reply = data as { kind?: string; id?: number; ok?: boolean };
      if (reply.kind === "reply" && reply.ok === true && opOf.get(reply.id!) === failing) {
        failing = null;
        throw new Error("injected: the success post fails");
      }
      queueMicrotask(() => toClient?.(data));
    },
    listen: (listener) => void (toHost = listener),
  };
  let sessions: HostSessions | null = null;
  const clientPort: ClientPort = {
    post: (message) => {
      // EVIDENCE: fixture: this port carries only the client's requests, each with its ID and op.
      const request = decodeMessage(structuredClone(message)) as { id: number; op: string };
      opOf.set(request.id, request.op);
      toHost?.(request);
    },
    listen: (listener) => void (toClient = listener),
    onFailure: () => {},
    terminate: () => closeConnection(context, sessions!),
  };
  const { client } = openBridge(clientPort, BUILD);
  sessions = startBridgeHost(hostPort, playerBridgeOps(context), BUILD, context.delivery);
  return {
    bridge: new PlayerBridge(client),
    context,
    failPost: (op: string) => void (failing = op),
  };
}

test("an answer whose reply failed to post leaves the host ahead: an export of that session is refused by identity, holding nothing", async () => {
  const link = failingConnection();
  const { bridge, context } = link;
  const plan = await preparedPlan(
    Promise.resolve(bridge),
    compilePlayerProject('let first = askText "First?"\nlet second = askText "Second?"\nexit')
      .plan!,
  );
  const session = await bridge.start(plan, { wallClockMs: 0 }, true, undefined, {
    run: 1,
    retires: null,
  });
  const exportOf = () =>
    bridge.captureExport(session, "current", (reply, view) => ({
      kind: reply.kind,
      reason: reply.kind === "refused" ? reply.reason : null,
      revision: view?.revision ?? null,
    }));
  link.failPost("submitComposer");
  const answerOf = (text: string) => {
    const shown = bridge.latest(session)!;
    const actionId = activePlayerRuntimeInteraction(shown.state)?.actionId;
    assert.ok(actionId !== undefined, "a question is asked");
    return bridge.request(session, "submitComposer", { actionId, text, input: null });
  };
  await assert.rejects(answerOf("one"), /injected: the success post fails/u);
  // The engine ran the answer; the page never received its publication.
  const refused = await exportOf();
  assert.deepEqual(refused, { kind: "refused", reason: "identity", revision: 1 });
  // A later request runs after the release the refusal sent.
  await bridge.client.request("releaseRecording", { ticket: "r0" });
  assert.equal(context.recordings.size, 0, "the refused capture holds nothing");
  // The page stays at the question it was shown: its answer to it is stale in the host, which publishes nothing it
  // could apply, so the export stays refused, never of a state the page did not show.
  assert.deepEqual(await answerOf("two"), { kind: "staleAction", actionId: 1 });
  assert.deepEqual(await exportOf(), { kind: "refused", reason: "identity", revision: 1 });
});
