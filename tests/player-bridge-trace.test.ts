import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject } from "../player/runtime/compile-project.js";
import {
  playerDebugImageOrigin,
  playerDebugLiveValue,
  playerDebugMessageOrigin,
  playerDebugTraceRows,
  playerDebugVariables,
  type PlayerDebugLiveValue,
  type PlayerDebugTraceRow,
} from "../player/debug/debug-variables.js";
import type { DebugView, DebugViewRequest } from "../player/debug/debug-view.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { heldTrace } from "../player/engine-bridge/in-process.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import type { PrepareResult } from "../player/engine-bridge/player-ops.js";
import { PlayerBridge } from "../player/runtime/player-bridge.js";
import {
  playerRuntimeDebugVariables,
  playerRuntimeSnapshot,
  type PlayerRuntimeSession,
} from "../player/runtime/runtime-adapter.js";
import {
  activePlayerRuntimeInteraction,
  playerRuntimeForeground,
  type PlayerSession,
} from "../player/runtime/runtime-view.js";
import type { RuntimeDebugContext } from "../src/runtime/debug/debug-trace.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../src/temporal.js";
import { hatch, inProcessBridge } from "./helpers/in-process-bridge.js";

/*
 * L5i.3: Debug's value trace is the host connection's state (`debugTracing`), the script's Debug mode an op
 * (`setDebugMode`), and Debug's trace views are made in the host (`debugView`). A trace changes nothing a session
 * shows; a view is what the Player's Variables and Now views made before, from the host's own session and trace.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const START = { wallClockMs: 0, temporalContext: DEFAULT_TEMPORAL_CONTEXT };

/** Variables in a function and at the top level, a draw, an answer, messages, a wait and a choice. */
const SCRIPT = [
  'let mood = "calm"',
  "let n = randomInteger(1..=6)",
  "function greet(name: string) {",
  '    let line = "${mood} ${name} ${n}"',
  "    say line, instant",
  "}",
  'let answer = askText "Ready?"',
  "greet(answer)",
  "wait 1 s",
  'let pick = askChoice "A", "B"',
  'say "picked ${pick}", instant',
  'showButton "End"',
  "exit",
].join("\n");

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

async function worker(): Promise<PlayerBridge> {
  return new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));
}

/** Both backends, the Worker's ended after `body`. */
async function onBoth(body: (bridge: PlayerBridge, name: string) => Promise<void>) {
  await body(await inProcessBridge(), "in-process");
  const remote = await worker();
  try {
    await body(remote, "worker");
  } finally {
    remote.client.terminate();
  }
}

const refusedAs = (code: string) => (error: unknown) =>
  error instanceof BridgeRequestError && error.code === code;

/** What every part of a view asks: recent chat, the newest message selected, all variables, and the Stage image. */
const everything = (epoch: number, sequence: number | null): DebugViewRequest => ({
  messages: { limit: 20, openNewest: true },
  selected: sequence === null ? null : { sequence, epoch },
  variables: { filter: "", pages: {} },
  image: true,
  trees: {},
});

/** The tape: each step's op on the presented action, then what the session shows and a view of it. */
async function playTape(
  bridge: PlayerBridge,
  traced: boolean,
  check?: (session: PlayerSession, view: DebugView | null) => void,
) {
  if (traced) await bridge.client.request("debugTracing", { on: true, intent: 1 });
  let session = await bridge.start(await prepared(bridge), START, false);
  const steps: unknown[] = [];
  const record = async (op: string) => {
    let view: DebugView | null = null;
    if (traced) {
      const first = await bridge.read(session, "debugView", { request: everything(0, null) });
      view = await bridge.read(session, "debugView", {
        request: everything(first.status!.epoch, newestSay(session)),
      });
      check?.(session, view);
    }
    steps.push({
      op,
      revision: session.revision,
      state: session.state,
      events: [...session.events],
      view,
    });
  };
  await record("start");
  const send = async (op: string, args: Record<string, unknown>) => {
    await bridge.request(session, op, args);
    session = bridge.latest(session)!;
    await record(op);
  };
  const actionId = () => activePlayerRuntimeInteraction(session.state)!.actionId;
  await send("submitComposer", { actionId: actionId(), text: "yes", input: "enter" });
  await send("observeTime", { atMs: 1_500, media: [] });
  const foreground = playerRuntimeForeground(session);
  assert.ok(foreground?.kind === "choose");
  await send("selectChoice", {
    actionId: actionId(),
    optionId: foreground.options[1]!.id,
    input: "button",
  });
  await send("setDebugMode", { on: true });
  return { steps, session };
}

/** The event sequence of the session's newest `say`, as Explain values selects a message, or `null` before one. */
function newestSay(session: PlayerSession): number | null {
  return session.events.findLast((event) => event.kind === "say")?.sequence ?? null;
}

/**
 * The oracle: what the Variables and Now views made before L5i.3, on the host's own session and trace, with the base
 * components' expansion rule (`DebugTraceRows.vue`: a choice, else the default for depth and kind).
 */
function before(held: PlayerRuntimeSession, trace: RuntimeDebugContext, request: DebugViewRequest) {
  const source = playerRuntimeDebugVariables(held);
  const live: PlayerDebugLiveValue = playerDebugLiveValue(source.variables);
  const rows = (roots: readonly number[], defaultOpen: number | null | undefined) =>
    playerDebugTraceRows(
      trace,
      roots,
      {
        expanded: (_key, record, depth, carried) =>
          depth === 0 ? record.id === defaultOpen : record.kind === "interpolation" || carried,
        pages: () => 1,
      },
      live,
    );
  const recent = trace.recentMessages(request.messages!.limit);
  const origin =
    request.selected === null ? null : playerDebugMessageOrigin(trace, request.selected.sequence);
  const image = playerDebugImageOrigin(trace);
  return {
    status: trace.status(),
    messages: { count: recent.length, rows: rows(recent, recent[0] ?? null) },
    selected:
      origin === null
        ? null
        : { origin, rows: origin.kind === "record" ? rows([origin.id], origin.id) : null },
    variables: playerDebugVariables(held.plan, source, trace, "").map((group) => ({
      key: group.key,
      label: group.label,
      total: group.variables.length,
      variables: group.variables
        .slice(0, 20)
        .map((variable) => ({
          ...variable,
          rows: variable.record === null ? null : rows([variable.record], undefined),
        })),
    })),
    image: {
      origin: image,
      location: image.kind === "record" ? (trace.record(image.id)?.location ?? null) : null,
    },
  };
}

test("a traced session shows what an untraced one shows, on both backends", async () => {
  await onBoth(async (bridge, name) => {
    const untraced = await playTape(bridge, false);
    const other = name === "worker" ? await worker() : await inProcessBridge();
    try {
      const traced = await playTape(other, true);
      const strip = (steps: unknown[]) =>
        steps.map((step) => {
          // EVIDENCE: fixture: `playTape` records each step as an object.
          return { ...(step as Record<string, unknown>), view: null };
        });
      assert.deepEqual(strip(traced.steps), strip(untraced.steps), name);
      if (name === "in-process")
        assert.deepEqual(
          hatch(traced.session, (held) => playerRuntimeSnapshot(held)),
          hatch(untraced.session, (held) => playerRuntimeSnapshot(held)),
        );
    } finally {
      if (name === "worker") other.client.terminate();
    }
  });
});

test("every view equals what the Variables and Now views made before, from the host's session and trace", async () => {
  const bridge = await inProcessBridge();
  let checked = 0;
  let rows = 0;
  let origins = 0;
  await playTape(bridge, true, (session, view) => {
    rows = Math.max(rows, view?.messages?.rows.length ?? 0);
    origins += (view?.variables ?? [])
      .flatMap((group) => group.variables)
      .filter((v) => v.rows !== null).length;
    assert.ok(view !== null && view.traceId !== null);
    const trace = heldTrace(bridge)!;
    const request = everything(view.status!.epoch, newestSay(session));
    const expected = hatch(session, (held) => before(held, trace, request));
    assert.deepEqual(
      {
        status: view.status,
        messages: view.messages,
        selected: view.selected,
        variables: view.variables,
        image: view.image,
      },
      expected,
    );
    assert.equal(view.revision, session.revision);
    checked += 1;
  });
  assert.equal(checked, 5);
  // The views had something to show: messages with their causes, and variables with their origins.
  assert.ok(rows > 1 && origins > 0, `${rows} rows, ${origins} origins`);
});

test("a view opens the rows the player chose and shows more pages, and its copy shares nothing", async () => {
  const bridge = await inProcessBridge();
  const { session } = await playTape(bridge, true);
  const ask = (trees: DebugViewRequest["trees"], openNewest = false) =>
    bridge.read(session, "debugView", {
      request: { ...everything(0, null), messages: { limit: 20, openNewest }, trees },
    });
  const closed = await ask({});
  const root = closed.messages!.rows.find((row) => row.kind === "record" && row.expandable)!;
  assert.ok(root.kind === "record" && !root.expanded);
  const opened = await ask({ recent: { choices: { [root.key]: true }, pages: {} } });
  const openedRoot = opened.messages!.rows.find((row) => row.key === root.key)!;
  assert.ok(openedRoot.kind === "record" && openedRoot.expanded);
  assert.ok(opened.messages!.rows.length > closed.messages!.rows.length);
  // Open by default, then closed by the player's choice.
  const shut = await ask({ recent: { choices: { [root.key]: false }, pages: {} } }, true);
  assert.deepEqual(shut.messages, closed.messages);
  // A view is a copy: changing it changes no later one.
  const kept = structuredClone(opened);
  // EVIDENCE: fixture: the reply is the transport's copy, whose arrays the test may change.
  (opened.messages!.rows as PlayerDebugTraceRow[]).length = 0;
  assert.deepEqual(await ask({ recent: { choices: { [root.key]: true }, pages: {} } }), kept);
});

test("a stopped session is still viewed as its stop froze it, and other requests are refused", async () => {
  await onBoth(async (bridge, name) => {
    await bridge.client.request("debugTracing", { on: true, intent: 1 });
    const session = await bridge.start(await prepared(bridge), START, false);
    const before = await bridge.read(session, "debugView", { request: everything(0, null) });
    await bridge.halt(session);
    const after = await bridge.read(session, "debugView", { request: everything(0, null) });
    assert.deepEqual(after, before, name);
    await assert.rejects(
      bridge.request(session, "setDebugMode", { on: true }),
      refusedAs("halted"),
    );
  });
});

test("tracing off drops the trace, on makes a new one, and Debug mode is the script's to read", async () => {
  await onBoth(async (bridge, name) => {
    const on = (await bridge.client.request("debugTracing", { on: true, intent: 1 })).result;
    assert.deepEqual(on, { traceId: 1 }, name);
    // Asking again changes nothing; an older intent neither.
    assert.deepEqual(
      (await bridge.client.request("debugTracing", { on: true, intent: 2 })).result,
      on,
    );
    assert.deepEqual(
      (await bridge.client.request("debugTracing", { on: false, intent: 1 })).result,
      on,
    );
    let session = await bridge.start(await prepared(bridge), START, false);
    assert.equal(
      (await bridge.read(session, "debugView", { request: everything(0, null) })).traceId,
      1,
    );
    assert.deepEqual(
      (await bridge.client.request("debugTracing", { on: false, intent: 3 })).result,
      { traceId: null },
    );
    assert.equal(
      (await bridge.read(session, "debugView", { request: everything(0, null) })).status,
      null,
    );
    assert.deepEqual(
      (await bridge.client.request("debugTracing", { on: true, intent: 4 })).result,
      { traceId: 2 },
    );
    const set = await bridge.request<{ readonly kind: string }>(session, "setDebugMode", {
      on: true,
    });
    session = bridge.latest(session)!;
    assert.equal(set.kind, "set", name);
    assert.equal(session.state.debugMode, true);
    // The new trace attached at that operation.
    const view = await bridge.read(session, "debugView", { request: everything(0, null) });
    assert.equal(view.status?.origin, "attach", name);
  });
});

test("malformed trace arguments are refused before anything runs", async () => {
  const bridge = await inProcessBridge();
  const session = await bridge.start(await prepared(bridge), START, false);
  for (const args of [
    null,
    {},
    { on: true },
    { on: 1, intent: 1 },
    { on: true, intent: 0 },
    { on: true, intent: 1.5 },
    { on: true, intent: 1, more: 1 },
  ])
    await assert.rejects(bridge.client.request("debugTracing", args), refusedAs("arguments"));
  for (const args of [null, {}, { on: "yes" }])
    await assert.rejects(bridge.request(session, "setDebugMode", args), refusedAs("arguments"));
  const good = everything(0, null);
  for (const request of [
    null,
    { ...good, image: "yes" },
    { ...good, messages: { limit: 0, openNewest: true } },
    { ...good, messages: { limit: 1.5, openNewest: true } },
    { ...good, selected: { sequence: 1 } },
    { ...good, variables: { filter: 3, pages: {} } },
    { ...good, variables: { filter: "", pages: { a: 0 } } },
    { ...good, trees: { recent: { choices: { a: 1 }, pages: {} } } },
    { ...good, trees: { recent: { choices: {}, pages: {}, more: 1 } } },
    { ...good, more: 1 },
  ])
    // Malformed on purpose, so past `read`'s types: the request `read` would post.
    await assert.rejects(
      bridge.client.request("debugView", { request, session: session.id }, { after: session.id }),
      refusedAs("arguments"),
      JSON.stringify(request),
    );
  for (const args of [{ request: good }, { session: 1, request: good }])
    await assert.rejects(bridge.client.request("debugView", args), refusedAs("arguments"));
});

// The view is a read (`PlayerBridge.read`): after a Player error stop it shows the stop line, byte for byte as before
// the stop, which the session's own ops cannot pass.
test("a view after a Player error stop is the stop line's, byte for byte", async () => {
  await onBoth(async (bridge, name) => {
    await bridge.client.request("debugTracing", { on: true, intent: 1 });
    const session = await bridge.start(await prepared(bridge), START, false);
    await bridge.request(session, "observeTime", { atMs: 1_000, media: [] });
    const shown = bridge.latest(session)!;
    const before = JSON.stringify(
      await bridge.read(shown, "debugView", { request: everything(1, null) }),
    );
    await bridge.halt(session);
    const after = JSON.stringify(
      await bridge.read(shown, "debugView", { request: everything(1, null) }),
    );
    assert.equal(after, before, name);
    assert.notEqual(JSON.parse(after).status, null, `${name}: the stop line's trace shows`);
    // The host refuses the session's own op (the client's request: the store's own refusal would hide a host that ran
    // it), and the view stays the stop line's.
    await assert.rejects(
      bridge.client.request(
        "setDebugMode",
        { on: true },
        { session: shown.id, basis: shown.revision },
      ),
      refusedAs("halted"),
      name,
    );
    const later = JSON.stringify(
      await bridge.read(shown, "debugView", { request: everything(1, null) }),
    );
    assert.equal(later, before, `${name}: nothing passed the stop line`);
  });
});

test("the views in a Worker are the ones in-process", async () => {
  const local = await playTape(await inProcessBridge(), true);
  const remote = await worker();
  try {
    assert.deepEqual((await playTape(remote, true)).steps, local.steps);
  } finally {
    remote.client.terminate();
  }
});
