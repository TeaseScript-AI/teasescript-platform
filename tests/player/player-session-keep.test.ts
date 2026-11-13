import assert from "node:assert/strict";
import test from "node:test";
import type { KeptSessionUpdate } from "../../player/persistence/kept-sessions.js";
import {
  playerRuntimeSnapshot as rawPlayerRuntimeSnapshot,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import type { InstructionPlan } from "../../src/index.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint.js";
import { onHost } from "../helpers/player/host-sessions.js";
import {
  stubBrowser,
  browser,
  planWrites,
  held,
  page,
  tasks,
  until,
  ASKS,
  ENDS,
  prepareAgain,
} from "../helpers/player/keep-host.js";

// The adapter's functions, also on the sessions the composables' host holds (`helpers/player/host-sessions.ts`).
const playerRuntimeSnapshot = onHost(rawPlayerRuntimeSnapshot);
// The plan's JSON as the engine writes it, taken before `planWrites` counts.
const planJson = (plan: InstructionPlan) => serializeValidatedRuntimeJson(plan);

/** Each kept event as the engine writes it, which a store keeping text stores. */
function assertEventsJson(update: KeptSessionUpdate) {
  assert.deepEqual(update.eventsJson, update.events.map(serializeValidatedRuntimeJson));
}

test("the first save stores the plan's JSON written before Start, and the events as the engine writes them", async (context) => {
  const shown = stubBrowser(context);
  const expected = planJson(ASKS);
  const writes = planWrites(context, ASKS);
  const at = browser();
  const { host } = await page(context, at, ASKS);
  await tasks();
  assert.equal(writes(), 1, "prepared before Start");
  await host.activate();
  await until(() => at.published.length > 0, "the session was not kept");
  assert.equal(writes(), 1, "Start wrote the plan again");
  const [first] = at.published;
  assert.equal(first!.planJson, expected);
  assert.equal(first!.eventsFrom, 0);
  assertEventsJson(first!);
  // A later save keeps the stored plan.
  const count = at.published.length;
  shown.hide();
  await until(() => at.published.length > count, "the session was not kept again");
  assert.equal(at.published.at(-1)!.planJson, null);
  assertEventsJson(at.published.at(-1)!);
  assert.equal(writes(), 1);
});

test("a Start before the preparation ran writes the plan's JSON itself, once, with the same bytes", async (context) => {
  stubBrowser(context);
  const expected = planJson(ASKS);
  const writes = planWrites(context, ASKS);
  const at = browser();
  const { host } = await page(context, at, ASKS);
  // No task has run since the Start control was offered.
  await host.activate();
  await until(() => at.published.length > 0, "the session was not kept");
  assert.equal(at.published[0]!.planJson, expected);
  await tasks();
  assert.equal(writes(), 1);
});

test("a save the store refused is kept again with the same plan JSON, written only once", async (context) => {
  const shown = stubBrowser(context);
  const writes = planWrites(context, ASKS);
  const at = browser();
  at.state.failing = 1;
  const { host } = await page(context, at, ASKS);
  await tasks();
  await host.activate();
  await until(() => at.published.length > 0, "the session was not kept");
  await tasks();
  shown.hide();
  await until(() => at.published.length > 1, "the session was not kept again");
  const [refused, retried] = at.published;
  assert.ok(refused!.planJson !== null);
  assert.equal(retried!.planJson, refused!.planJson);
  assert.equal(retried!.eventsFrom, 0);
  assertEventsJson(retried!);
  assert.equal(writes(), 1);
  // Kept now: the next save keeps the stored plan.
  shown.hide();
  await until(() => at.published.length > 2, "the session was not kept a third time");
  assert.equal(at.published[2]!.planJson, null);
});

test("a session that ended starts anew with the plan JSON its restore read, and a closed page prepares nothing", async (context) => {
  stubBrowser(context);
  const expected = planJson(ENDS);
  const writes = planWrites(context, ENDS);
  const at = browser();
  const { host } = await page(context, at, ENDS);
  await tasks();
  await host.activate();
  assert.equal(host.session.value?.state.status, "halted");
  await host.toStartPage();
  assert.equal(host.activation.value, "start");
  // The prepared JSON, which the restore's comparison read; the next Start's first save writes none.
  assert.equal(writes(), 1);
  await host.activate();
  await until(
    () => at.published.filter((update) => update.planJson !== null).length > 1,
    "the new session was not kept",
  );
  await tasks();
  assert.equal(writes(), 1);
  for (const update of at.published.filter((update) => update.planJson !== null))
    assert.equal(update.planJson, expected);

  const closing = browser();
  const { scope } = await page(context, closing, ENDS);
  scope.stop();
  await tasks();
  assert.equal(writes(), 1);
});

test("Start and Continue record the zone and clock at the click, not those prepared before it", async (context) => {
  stubBrowser(context);
  const zone = process.env["TZ"];
  context.after(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });
  const recorded = (session: PlayerRuntimeSession | null) => {
    const capture = playerRuntimeSnapshot(session!).temporalCaptures.at(-1)!;
    return { zone: capture.context.zone.name, epochMs: capture.epochMs };
  };
  const at = browser();
  process.env["TZ"] = "Europe/Amsterdam";
  const { host } = await page(context, at, ASKS);
  await tasks();
  process.env["TZ"] = "Asia/Tokyo";
  const started = Date.now();
  await host.activate();
  const start = recorded(host.session.value);
  assert.equal(start.zone, "Asia/Tokyo");
  assert.ok(start.epochMs! >= started && start.epochMs! <= Date.now());
  await until(() => at.published.length > 0, "the session was not kept");

  // A reload continues the kept session.
  process.env["TZ"] = "Europe/Amsterdam";
  const reloaded = (await page(context, at, ASKS)).host;
  assert.equal(reloaded.activation.value, "continue");
  await tasks();
  process.env["TZ"] = "America/Sao_Paulo";
  // The host's first reply of the Continue (`beginRecording`) is held; meanwhile the zone and the clock change. The
  // Continue records them as they were at the click (#1886).
  const bridge = await reloaded.bridge;
  const request = bridge.client.request.bind(bridge.client);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const sent = request(...args);
    return args[0] === "beginRecording" ? sent.then(async (reply) => (await held, reply)) : sent;
  });
  const resumed = Date.now();
  const continuing = reloaded.activate();
  const clicked = Date.now();
  process.env["TZ"] = "Asia/Kolkata";
  context.mock.method(Date, "now", () => clicked + 20_000);
  release();
  await continuing;
  const go = recorded(reloaded.session.value);
  assert.equal(go.zone, "America/Sao_Paulo");
  assert.ok(go.epochMs! >= resumed && go.epochMs! <= clicked, "the clock of the click");
});

/** Holds `at`'s next publication until `release()`; `entered` gives its update once it is issued. */
function holdNext(at: ReturnType<typeof browser>) {
  let issue: (update: KeptSessionUpdate) => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<KeptSessionUpdate>((resolve) => (issue = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const publish = at.kept.publish;
  let held = false;
  at.kept.publish = async (scope, update) => {
    if (!held) {
      held = true;
      issue(update);
      await released;
    }
    return publish(scope, update);
  };
  return { entered, release };
}

test("a save still being stored leaves the plan JSON prepared for the next Start, of the same plan or another", async (context) => {
  stubBrowser(context);
  const [ends, asks] = [planJson(ENDS), planJson(ASKS)];
  const writes = planWrites(context, ENDS, ASKS);
  for (const next of [ENDS, ASKS]) {
    const at = browser();
    const pending = holdNext(at);
    const { host } = await page(context, at, ENDS);
    await tasks();
    await host.activate();
    const first = await pending.entered;
    await prepareAgain(host, next);
    assert.equal(host.activation.value, "start");
    await tasks();
    pending.release();
    await until(() => at.published.length > 0, "the first session was not kept");
    await host.activate();
    await until(() => at.published.length > 1, "the next session was not kept");
    assert.equal(first.planJson, ends);
    assert.equal(at.published.at(-1)!.planJson, next === ENDS ? ends : asks);
  }
  // One write each for ENDS's two pages and ASKS's, all before a Start.
  assert.deepEqual([writes(ENDS), writes(ASKS)], [2, 1]);
});

test("keep requests during a write become one more save, which appends the events after it", async (context) => {
  const shown = stubBrowser(context);
  const at = browser();
  const pending = holdNext(at);
  const { host } = await page(context, at, ASKS);
  await tasks();
  await host.activate();
  await pending.entered;
  shown.hide();
  shown.hide();
  pending.release();
  await until(() => at.published.length > 1, "the requests were not kept");
  await tasks();
  assert.equal(at.published.length, 2);
  const [first, second] = at.published;
  assert.equal(second!.eventsFrom, first!.events.length);
  assert.equal(second!.planJson, null);
  assertEventsJson(second!);
});

test("Start and Continue capture a zone not seen before ahead of the click, and the click reuses it", async (context) => {
  stubBrowser(context);
  const zone = process.env["TZ"];
  context.after(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });
  // A zone's rules are captured with a `longOffset` formatter, once per zone and page.
  const captured: string[] = [];
  const RealFormat = Intl.DateTimeFormat;
  const note = (options: Intl.DateTimeFormatOptions | undefined) => {
    if (options?.timeZoneName === "longOffset") captured.push(String(options.timeZone));
  };
  Intl.DateTimeFormat = new Proxy(RealFormat, {
    construct(target, args) {
      note(args[1]);
      return new target(args[0], args[1]);
    },
    apply(target, _self, args) {
      note(args[1]);
      return target(args[0], args[1]);
    },
  });
  context.after(() => (Intl.DateTimeFormat = RealFormat));
  const at = browser();
  process.env["TZ"] = "Pacific/Marquesas";
  const { host } = await page(context, at, ASKS);
  assert.deepEqual(captured, [], "not within the preparation itself");
  await tasks();
  assert.deepEqual(captured, ["Pacific/Marquesas"]);
  await host.activate();
  await until(() => at.published.length > 0, "the session was not kept");
  assert.deepEqual(captured, ["Pacific/Marquesas"], "Start captured the zone again");

  process.env["TZ"] = "Pacific/Chatham";
  const reloaded = (await page(context, at, ASKS)).host;
  assert.equal(reloaded.activation.value, "continue");
  await tasks();
  assert.deepEqual(captured, ["Pacific/Marquesas", "Pacific/Chatham"]);
  await reloaded.activate();
  assert.deepEqual(
    captured,
    ["Pacific/Marquesas", "Pacific/Chatham"],
    "Continue captured it again",
  );
});

test("a Start prepared while the first save's capture is out takes that save's plan JSON", async (context) => {
  stubBrowser(context);
  const expected = planJson(ASKS);
  const writes = planWrites(context, ASKS);
  const at = browser();
  // Replies take 50 ms, so the capture's reply, with the plan's JSON, is out while the next Start is prepared.
  const { host } = await page(context, at, ASKS, 50);
  await until(() => writes() === 1, "the plan's JSON was not prepared");
  const bridge = await host.bridge;
  let captured!: () => void;
  const capturing = new Promise<void>((resolve) => (captured = resolve));
  const request = bridge.client.request.bind(bridge.client);
  context.mock.method(bridge.client, "request", (...args: Parameters<typeof request>) => {
    const sent = request(...args);
    if (args[0] === "captureKeep") captured();
    return sent;
  });
  await host.activate();
  await capturing;
  await prepareAgain(host, ASKS);
  await until(() => at.published.length > 0, "the first session was not kept");
  await host.activate();
  await until(
    () => at.published.filter((update) => update.planJson !== null).length > 1,
    "the next session was not kept",
  );
  for (const update of at.published.filter((update) => update.planJson !== null))
    assert.equal(update.planJson, expected);
  assert.equal(writes(), 1, "the next Start took the first save's JSON");
});

test("a plan another preparation replaced, and the page's last one when it closes, let go of their JSON", async (context) => {
  stubBrowser(context);
  const writes = planWrites(context, ASKS, ENDS);
  const at = browser();
  const { host, scope } = await page(context, at, ASKS);
  await tasks();
  await prepareAgain(host, ENDS);
  await tasks();
  assert.deepEqual([writes(ASKS), writes(ENDS)], [1, 1]);
  const bridge = await host.bridge;
  const [asks, ends] = [await held(host, ASKS), await held(host, ENDS)];
  scope.stop();
  await tasks();
  // Each JSON is written anew when asked for: the host let go of both.
  await bridge.client.request("planText", { plan: asks });
  await bridge.client.request("planText", { plan: ends });
  assert.deepEqual([writes(ASKS), writes(ENDS)], [2, 2]);
});
