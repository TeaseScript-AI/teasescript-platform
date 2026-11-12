/*
 * L5i.5: how one observation of the scene clock lives and ends: overlapping and queued observations, refusals and
 * their retries, retirement, replacement and disposal, and the deadlines and barriers of the clock's own and explicit
 * observations. What session work waits for the clock is `player-clock-work.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { effectScope, shallowRef, type ShallowRef } from "vue";

import type { SessionRequestOptions } from "../../player/runtime/player-bridge.js";
import type { PlayerSession } from "../../player/runtime/runtime-view.js";
import { loadPlayerModule } from "../helpers/player-modules.js";
import type { ClockTicket } from "../../player/runtime/clock-ticket.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import { untypedBridge, untypedClient } from "../helpers/bridge/untyped.js";
import {
  observeOnHost,
  refusal,
  settle,
  mount,
  asShown,
  mountClock,
} from "../helpers/player/clock-host.js";

// R1: the clock observes inside a section of the shown session, so its basis is read at its own turn.
function atMsOf(post: { readonly args: unknown }): number {
  // EVIDENCE: fixture: an `observeTime` post's arguments, as the clock sends them.
  const args = post.args as { readonly atMs: number };
  return args.atMs;
}

test("two overlapping observations both succeed, and the later's time is what the session observed", async (context) => {
  const player = await mount(context, false);
  const from = player.posts.length;
  const [first, second] = await Promise.all([player.host.observe(), player.host.observe()]);
  assert.notEqual(first, null);
  assert.notEqual(second, null);
  const observations = player.posts.slice(from).filter((post) => post.op === "observeTime");
  assert.equal(observations.length, 2, "both are posted, neither refused");
  assert.equal(
    player.host.session.value?.state.observedSessionTimeMs,
    Math.max(...observations.map(atMsOf)),
  );
});

test("an observation behind an earlier section that published succeeds, at its own time", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const shown = player.host.session.value!;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  // EVIDENCE: fixture: the shown session is a publication of this bridge.
  const earlier = bridge.section(asShown(shown), clockTicket(), async (section) => {
    await opened;
    // A publication that moves the revision, not the time.
    await section.send("setDebugMode", { on: true });
  });
  const observing = player.host.observe();
  open();
  await earlier;
  const observed = await observing;
  assert.notEqual(observed, null, "not refused for the basis the earlier section moved");
  const last = player.posts.filter((post) => post.op === "observeTime").at(-1)!;
  assert.equal(player.host.session.value?.state.observedSessionTimeMs, atMsOf(last));
});

test("an observation refused twice returns null without publishing and retains its future deadline", async (context) => {
  const player = await mount(context, false);
  const shown = player.host.session.value;
  player.gate.refuse("observeTime", 2, "basis");
  const armed = player.timeouts.armed;
  const from = player.attempts.length;
  assert.equal(await player.host.observe(), null);
  await settle();
  assert.equal(
    player.attempts.slice(from).filter((op) => op === "observeTime").length,
    2,
    "one retry",
  );
  assert.equal(player.host.session.value, shown, "nothing published");
  assert.equal(player.timeouts.armed, armed + 1, "release retains the future deadline");
});

test("a refusal of another kind is not retried", async (context) => {
  const player = await mount(context, false);
  player.gate.refuse("observeTime", 1, "session");
  const from = player.attempts.length;
  await assert.rejects(player.host.observe());
  assert.equal(player.attempts.slice(from).filter((op) => op === "observeTime").length, 1);
});

// R4: an observation's completion publishes and schedules nothing once it is retired.
test("a rejection after disposal arms no timer", async (context) => {
  const player = await mount(context, false);
  player.gate.hold("observeTime");
  // A page-hide opportunity: fire and forget, its failure handled by the clock.
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  player.scope.stop();
  const armed = player.timeouts.armed;
  // An error the clock handles by going on from the latest session: disposed, it schedules nothing.
  player.gate.release(new Error("The reply failed."));
  await settle();
  assert.equal(player.timeouts.armed, armed);
});

test("a newer publication of the session during an observation is what the observation returns", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  player.gate.hold("observeTime");
  const observing = player.host.observe();
  await settle();
  // Meanwhile the host publishes the session again, past the session's queue (the facade), after the observation ran.
  const shown = player.host.session.value!;
  observeOnHost(shown, shown.state.observedSessionTimeMs + 50_000, []);
  player.gate.release();
  const observed = await observing;
  await settle();
  assert.equal(observed, player.host.session.value, "the newest shown");
  // EVIDENCE: fixture: as above.
  assert.equal(observed?.revision, bridge.latest(asShown(shown))?.revision);
});

test("an unmount or a replacement with an observation in flight publishes nothing", async (context) => {
  for (const interference of ["unmount", "replacement"] as const) {
    await context.test(interference, async (inner) => {
      const player = await mount(inner, false);
      player.gate.hold("observeTime");
      const observing = player.host.observe();
      await settle();
      if (interference === "unmount") player.scope.stop();
      else {
        await player.start(false);
      }
      const shown = player.host.session.value;
      player.gate.release();
      assert.equal(await observing, null);
      await settle();
      assert.equal(player.host.session.value, shown);
    });
  }
});

// The barrier: a retired observation still sends at its turn, so the work queued behind it follows an observation.
test("a later observation does not take the hidden page's observation from the keep queued behind it", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const shown = player.host.session.value!;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  // EVIDENCE: fixture: the shown session is a publication of this bridge.
  const earlier = bridge.section(asShown(shown), clockTicket(), () => opened);
  const from = player.posts.length;
  player.hide();
  // The keep's capture is queued behind the hidden page's observation; then another observation retires that one.
  await settle();
  const later = player.host.observe();
  open();
  await earlier;
  await later;
  await settle(40);
  const ops = player.posts
    .slice(from)
    .map((post) => post.op)
    .filter((op) => op === "observeTime" || op === "captureKeep");
  assert.deepEqual(ops, ["observeTime", "captureKeep", "observeTime"]);
  const kept = player.posts.slice(from).find((post) => post.op === "captureKeep")!;
  assert.ok(
    (kept.atMs ?? 0) > shown.state.observedSessionTimeMs,
    "the keep captures the visible time",
  );
});

test("a retired observation's reply publishes nothing, while the next one's waits", async (context) => {
  const player = await mount(context, false);
  player.gate.hold("observeTime", 2);
  const first = player.host.observe();
  await settle();
  const second = player.host.observe();
  await settle();
  const shown = player.host.session.value!;
  player.gate.releaseFirst();
  await first;
  await settle();
  assert.equal(player.host.session.value, shown, "the retired one publishes nothing");
  // A healthy reply still reaches the store: stored, not shown, and its successor owns what shows next (P's provenance).
  const bridge = await player.host.bridge;
  assert.ok(
    bridge.latest(asShown(shown))!.revision > shown.revision,
    "the retired one's reply is stored",
  );
  player.gate.release();
  assert.notEqual(await second, null);
  assert.notEqual(player.host.session.value, shown, "the live one publishes");
});

test("an old observation's rejection after a replacement arms no timer", async (context) => {
  const player = await mount(context, false);
  player.gate.hold("observeTime");
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  await player.start(false);
  await settle();
  const armed = player.timeouts.armed;
  player.gate.release(new Error("The reply failed."));
  await settle();
  assert.equal(player.timeouts.armed, armed);
});

test("every completion effect of an observation goes through its one lifetime decision", () => {
  const path = new URL("../../../player/vue/src/session/useRuntimeSceneClock.ts", import.meta.url);
  const text = readFileSync(path, "utf8");
  const file = ts.createSourceFile("clock.ts", text, ts.ScriptTarget.Latest, true);
  let observing: ts.FunctionDeclaration | undefined;
  const generations: string[] = [];
  file.forEachChild(function visit(node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "observing") observing = node;
    if (ts.isPropertyAccessExpression(node) && node.getText(file) === "observation.generation") {
      let at: ts.Node | undefined = node;
      while (at !== undefined && !(ts.isFunctionDeclaration(at) && at.name !== undefined))
        at = at.parent;
      generations.push(
        at !== undefined && ts.isFunctionDeclaration(at) ? (at.name?.text ?? "") : "(none)",
      );
    }
    node.forEachChild(visit);
  });
  assert.ok(observing?.body, "the clock has its observation");
  assert.deepEqual(generations, ["whileLive"], "only the decision reads an observation's lifetime");
  // An admit-list: every call `observing` makes outside `whileLive`'s effect argument is one named here as having no
  // completion effect; any other call, a new helper included, fails until it is classified.
  const effectFree = new Set([
    "cancel",
    "owned",
    "sceneTimeMs",
    "mediaReports",
    "bridgeOf",
    "bridgeOf(shown).section",
    // The section's ticket: a type, with no state behind it.
    "mintClockTicket",
    "section.send",
    // The time and media read at the observation's turn.
    "now",
    "refusalCode",
    "endsQuietly",
    "whileLive",
  ]);
  const decided: string[] = [];
  const undecided: string[] = [];
  observing.body.forEachChild(function visit(node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(file);
      let inside = false;
      for (
        let at: ts.Node | undefined = node.parent;
        at !== undefined && at !== observing;
        at = at.parent
      )
        if (
          (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
          ts.isCallExpression(at.parent) &&
          at.parent.expression.getText(file) === "whileLive" &&
          at.parent.arguments[1] === at
        )
          inside = true;
      // The admitted observation's release re-derives the wake, owned by its token (`requested === admitted`), not by its
      // lifetime: publication and recovery stay under `whileLive`.
      let release = false;
      for (
        let at: ts.Node | undefined = node;
        at !== undefined && at !== observing;
        at = at.parent
      ) {
        if (ts.isTryStatement(at) && at.finallyBlock?.getText(file).includes(node.getText(file))) {
          release = true;
          assert.match(at.finallyBlock.getText(file), /if \(requested === admitted\)/);
        }
      }
      if (release)
        assert.ok(["scheduleWakeUp", "basisOf"].includes(callee), `${callee} in the release`);
      else (inside ? decided : undecided).push(callee);
    }
    node.forEachChild(visit);
  });
  assert.deepEqual(
    undecided.filter((callee) => !effectFree.has(callee)),
    [],
    "a call outside the decision that is not classified as effect-free",
  );
  // The effects are decided; a helper inside the decision is decided with them.
  for (const effect of ["publishLater", "recover"])
    assert.ok(decided.includes(effect), `${effect} is decided`);
});

test("a deadline that passes while an explicit observation waits is observed after that observation's reply fails", async (context) => {
  const player = await mount(context, false, 'wait 10 ms\nshowButton "Done"\nexit');
  player.gate.hold("observeTime");
  const observed = player.host.observe().catch(() => null);
  await settle();
  const from = player.posts.length;
  // An actual outstanding runtime deadline fires while the observation's reply waits.
  player.elapse(20);
  context.mock.timers.tick(20);
  await settle();
  player.gate.release(new Error("The reply failed."));
  await observed;
  await settle(60);
  player.elapse(1000);
  context.mock.timers.tick(1000);
  await settle(60);
  assert.ok(
    player.posts.slice(from).some((p) => p.op === "observeTime" || p.op === "beginCatchUp"),
    "the consumed opportunity is recovered after failure",
  );
});

test("a failed observation that no caller awaits leaves its passed deadline observed", async (context) => {
  const player = await mount(context, false);
  player.gate.hold("observeTime");
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  context.mock.timers.tick(20);
  await settle();
  const armed = player.timeouts.armed;
  player.gate.release(new Error("The reply failed."));
  await settle();
  assert.ok(player.timeouts.armed > armed, "live recovery arms a wake-up");
});

test("an older observation's completion does not release the admission of a newer one that waits", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const raw = untypedBridge(bridge);
  const request = raw.request.bind(raw);
  let begins = 0;
  context.mock.method(
    raw,
    "request",
    (session: PlayerSession, op: string, args: unknown, options?: SessionRequestOptions) => {
      if (op === "beginCatchUp") begins++;
      return request(session, op, args, options);
    },
  );
  player.gate.hold("observeTime", 2);
  const first = player.host.observe();
  await settle();
  const second = player.host.observe();
  const from = player.posts.length;
  player.gate.releaseFirst();
  await first;
  await settle();
  player.late(1000);
  await settle();
  assert.equal(begins, 0, "successor still blocks opportunity admission before its queue turn");
  player.gate.release();
  await second;
  player.late(1000);
  await settle(60);
  assert.ok(
    player.posts.slice(from).some((p) => p.op === "beginCatchUp"),
    "settled token releases opportunity",
  );
});

test("an observation whose section is refused before its body releases its admission", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const original = bridge.section.bind(bridge);
  let reject = true;
  context.mock.method(bridge, "section", (...args: Parameters<typeof original>) => {
    if (reject) {
      reject = false;
      throw new Error("pre-body ownership rejection");
    }
    return original(...args);
  });
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  const from = player.posts.length;
  player.late(1000);
  await settle(60);
  assert.ok(
    player.posts.slice(from).some((p) => p.op === "beginCatchUp"),
    "rejected token does not block later work",
  );
});

test("a deadline passed during a retired observation is observed after its successor fails", async (context) => {
  const player = await mount(context, false, 'wait 10 ms\nshowButton "Done"\nexit');
  player.gate.hold("observeTime", 2);
  window.dispatchEvent(new Event("pagehide"));
  await settle();
  const successor = player.host.observe().catch(() => null);
  player.gate.releaseFirst();
  await settle();
  player.elapse(20);
  context.mock.timers.tick(20);
  await settle();
  player.gate.release(new Error("successor failed"));
  await successor;
  await settle();
  player.elapse(1000);
  context.mock.timers.tick(1000);
  await settle(60);
  assert.equal(
    player.host.session.value?.state.foregroundAction?.kind,
    "interaction",
    "deadline progresses after retired observation and failed successor",
  );
});

test("an explicit observation's publication schedules the deadline that passed during it, without media", async (context) => {
  const player = await mount(context, false, 'wait 10 ms\nshowButton "Done"\nexit');
  player.gate.hold("observeTime");
  const observed = player.host.observe();
  await settle();
  player.elapse(20);
  context.mock.timers.tick(20);
  await settle();
  player.gate.release();
  await observed;
  await settle();
  context.mock.timers.tick(1);
  await settle(60);
  assert.equal(player.host.session.value?.state.foregroundAction?.kind, "interaction");
});

test("an observation reads time and media progress at its turn, and again for its basis retry", async (context) => {
  const player = await mount(context, false);
  const bridge = await player.host.bridge;
  const shown = player.host.session.value!;
  await bridge.request(asShown(shown), "reportMediaLoad", {
    mediaId: 1,
    report: { kind: "loaded", durationMs: 1000 },
  });
  const module = await loadPlayerModule("player/vue/src/session/useRuntimeSceneClock.ts");
  // EVIDENCE: validation: Vite loaded the real source module; this is the composable's own signature, its first two inputs.
  const useClock = module.useRuntimeSceneClock as (
    session: ShallowRef<unknown>,
    reports: () => readonly unknown[],
  ) => { observe(): Promise<PlayerSession | null> };
  let progress = 100;
  const scope = effectScope();
  context.after(() => scope.stop());
  const clock = scope.run(() =>
    useClock(shallowRef(bridge.latest(asShown(shown))), () => [
      { mediaId: 1, segment: 1, progressMs: progress },
    ]),
  )!;
  const section = untypedClient(bridge.client).section.bind(bridge.client);
  const argumentsSent: { atMs: number; media: { progressMs: number }[] }[] = [];
  context.mock.method(
    untypedClient(bridge.client),
    "section",
    (session: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
      section(session, ticket, (send) =>
        body((op, args, basis, onReply) => {
          if (op === "observeTime") {
            // EVIDENCE: fixture: `observeTime`'s arguments, as the clock sends them.
            argumentsSent.push(args as { atMs: number; media: { progressMs: number }[] });
            if (argumentsSent.length === 1) {
              progress = 400;
              player.elapse(100);
              return Promise.reject(refusal("basis"));
            }
          }
          return send(op, args, basis, onReply);
        }),
      ),
  );
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  const earlier = bridge.section(asShown(shown), clockTicket(), () => wait);
  const observed = clock.observe();
  progress = 200;
  player.elapse(200);
  open();
  await earlier;
  assert.notEqual(await observed, null);
  assert.equal(argumentsSent.length, 2);
  assert.deepEqual(
    argumentsSent.map((a) => a.media[0]!.progressMs),
    [200, 400],
  );
  assert.ok(
    argumentsSent[1]!.atMs >= argumentsSent[0]!.atMs + 100,
    "retry resamples monotonic time",
  );
});

test("an observation of a replaced session schedules nothing for the session that replaced it", async (context) => {
  const player = await mountClock(context, false);
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => (open = resolve));
  const earlier = player.bridge.section(asShown(player.initial), clockTicket(), () => waiting);
  const observed = player.clock.observe();
  player.clock.catchUp();
  const next = await player.bridge.start(player.shown.value!.planToken, {}, false);
  player.shown.value = next;
  await settle();
  const armed = player.timeouts.armed;
  open();
  await earlier;
  await observed;
  await settle();
  assert.equal(
    player.timeouts.armed,
    armed,
    "an old observation cannot schedule for the replacement",
  );
  await player.advance(20);
  assert.equal(player.shown.value?.state.foregroundAction?.kind, "interaction");
});

test("an older observation's release does not schedule again for a newer one", async (context) => {
  const player = await mountClock(context, false);
  player.gate.hold("observeTime", 2);
  const old = player.clock.observe();
  await settle();
  const latest = player.clock.observe().catch(() => null);
  await player.advance(20);
  const armed = player.timeouts.armed;
  player.gate.releaseFirst();
  await old;
  await settle();
  assert.equal(player.timeouts.armed, armed, "old release cannot serve the successor's wish");
  player.gate.release(new Error("failed successor"));
  await latest;
  await settle();
  assert.equal(player.timeouts.armed, armed + 1, "installed release arms once");
  await player.advance(2);
  assert.equal(player.shown.value?.state.foregroundAction?.kind, "interaction");
});

test("a joined barrier with no deadline left sends nothing more", async (context) => {
  const player = await mount(context, false, 'showButton "Done"\nexit');
  const bridge = await player.host.bridge;
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => (open = resolve));
  const earlier = bridge.section(asShown(player.host.session.value!), clockTicket(), () => waiting);
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pagehide"));
  open();
  await earlier;
  await settle();
  const observed = player.attempts.filter((op) => op === "observeTime").length;
  const armed = player.timeouts.armed;
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(player.attempts.filter((op) => op === "observeTime").length, observed);
  assert.equal(player.timeouts.armed, armed, "and arms nothing");
});

for (const delayMs of [undefined, 0])
  test(`two barriers in one task behind a holder that spans scene time share one observation: ${delayMs === undefined ? "microtask" : "0 ms"} replies`, async (context) => {
    const player = await mount(context, false, 'wait 100 ms\nshowButton "Done"\nexit', delayMs);
    const bridge = await player.host.bridge;
    let open!: () => void;
    const waiting = new Promise<void>((resolve) => (open = resolve));
    const earlier = bridge.section(
      asShown(player.host.session.value!),
      clockTicket(),
      () => waiting,
    );
    const before = player.posts.filter((post) => post.op === "observeTime").length;
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    player.elapse(200);
    // No transport delay: the trusted queue holder, rather than a late reply, spans scene time.
    open();
    await earlier;
    for (let n = 0; n < 10; n++) {
      if (delayMs === 0) context.mock.timers.tick(1);
      await settle();
    }
    assert.equal(
      player.posts.filter((post) => post.op === "observeTime").length - before,
      1,
      "the second barrier joins the first, still waiting for its turn",
    );
    assert.equal(
      player.host.session.value?.state.foregroundAction?.kind,
      "interaction",
      "that one observation, read at its turn, covers the wait",
    );
  });

test("a failure before the clock's own observation reaches the host does not park its deadline", async (context) => {
  const player = await mountClock(context, true);
  const clone = globalThis.structuredClone;
  let failed = 0;
  context.mock.method(
    globalThis,
    "structuredClone",
    (value: unknown, options?: StructuredSerializeOptions) => {
      const observeTime =
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "request" &&
        "op" in value &&
        value.op === "observeTime";
      if (observeTime && failed === 0) {
        failed += 1;
        throw new Error("The request could not cross.");
      }
      return clone(value, options);
    },
  );
  await player.advance(400);
  assert.equal(failed, 1);
  assert.equal(player.shown.value?.state.foregroundAction?.kind, "interaction");
});

test("with no deadline left, a release schedules nothing", async (context) => {
  const player = await mountClock(context, false);
  player.gate.hold("observeTime");
  const observed = player.clock.observe();
  await settle();
  await player.advance(20);
  player.gate.release();
  await observed;
  await settle();
  await player.advance(2);
  assert.equal(player.shown.value?.state.foregroundAction?.kind, "interaction");
  const armed = player.timeouts.armed;
  await player.clock.observe();
  await settle();
  assert.equal(
    player.timeouts.armed,
    armed,
    "a consumed wish is not retained for another admission",
  );
});

for (const refusals of [2, 4])
  test(`a passed deadline after ${refusals} basis refusals on the real host: observed, or parked until a publication`, async (context) => {
    const player = await mountClock(context, false);
    let open!: () => void;
    const waiting = new Promise<void>((resolve) => (open = resolve));
    const earlier = player.bridge.section(asShown(player.initial), clockTicket(), () => waiting);
    const client = untypedClient(player.bridge.client);
    const section = client.section.bind(client);
    let left = refusals;
    let rejected = 0;
    context.mock.method(
      client,
      "section",
      (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
        section(id, ticket, (send) =>
          body(async (op, args, basis, onReply) => {
            const refuse = op === "observeTime" && left > 0;
            if (refuse) left--;
            try {
              return await send(op, args, refuse ? (basis ?? 0) + 1000 : basis, onReply);
            } catch (error) {
              if (refuse) rejected++;
              throw error;
            }
          }),
        ),
    );
    const observed = player.clock.observe();
    await player.advance(20); // the real deadline is consumed while this token waits
    open();
    await earlier;
    await observed;
    await settle();
    await player.advance(1000);
    assert.equal(rejected, refusals, "every refusal traversed the real host");
    const reached = player.shown.value?.state.foregroundAction?.kind;
    if (refusals === 2) {
      assert.equal(
        reached,
        "interaction",
        "the clock's own observation after the refused one reaches the deadline",
      );
      return;
    }
    // The clock's own observation was refused twice on a basis no publication changed: it waits for one (#2263).
    assert.notEqual(reached, "interaction", "parked on the unchanged basis");
    const sent = player.posts.filter((post) => post.op === "observeTime").length;
    player.clock.catchUp();
    await player.advance(100);
    assert.equal(
      player.posts.filter((post) => post.op === "observeTime").length,
      sent,
      "nothing more is sent",
    );
    await player.clock.observe();
    await player.advance(100);
    assert.equal(
      player.shown.value?.state.foregroundAction?.kind,
      "interaction",
      "a publication lifts it",
    );
  });

test("a basis refused on every attempt bounds the clock's own observations", async (context) => {
  const player = await mountClock(context, false);
  const client = untypedClient(player.bridge.client);
  const section = client.section.bind(client);
  let rejected = 0;
  context.mock.method(
    client,
    "section",
    (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
      section(id, ticket, (send) =>
        body(async (op, args, basis, onReply) => {
          try {
            return await send(
              op,
              args,
              op === "observeTime" ? (basis ?? 0) + 1000 : basis,
              onReply,
            );
          } catch (error) {
            rejected++;
            throw error;
          }
        }),
      ),
  );
  await player.advance(30);
  const at30 = rejected;
  await player.advance(100);
  assert.equal(rejected, at30, "with no new publication, the automatic refusal chain terminates");
});

test("a session the host halted gets no more of the clock's own observations", async (context) => {
  const player = await mountClock(context, false);
  await player.bridge.halt(asShown(player.initial));
  assert.equal(await player.clock.observe(), null);
  const attempts = player.attempts.length,
    armed = player.timeouts.armed;
  await player.advance(100);
  player.clock.catchUp();
  await settle();
  assert.equal(player.attempts.length, attempts);
  assert.equal(player.timeouts.armed, armed);
});

test("an explicit observation's publication lifts the wait on an unchanged basis", async (context) => {
  const player = await mountClock(
    context,
    false,
    'wait 10 ms\nwait 100 ms\nshowButton "Done"\nexit',
  );
  let open!: () => void;
  const earlier = player.bridge.section(
    asShown(player.initial),
    clockTicket(),
    () => new Promise<void>((resolve) => (open = resolve)),
  );
  const client = untypedClient(player.bridge.client);
  const section = client.section.bind(client);
  let left = 4,
    rejected = 0;
  context.mock.method(
    client,
    "section",
    (id: string, ticket: ClockTicket, body: Parameters<typeof section>[2]) =>
      section(id, ticket, (send) =>
        body(async (op, args, basis, onReply) => {
          const refusing = op === "observeTime" && left > 0;
          if (refusing) left--;
          try {
            return await send(op, args, refusing ? (basis ?? 0) + 1000 : basis, onReply);
          } catch (error) {
            if (refusing) rejected++;
            throw error;
          }
        }),
      ),
  );
  const observed = player.clock.observe();
  await player.advance(20);
  open();
  await earlier;
  await observed;
  await settle();
  await player.advance(20);
  assert.equal(rejected, 4);
  assert.equal(
    player.shown.value?.state.observedSessionTimeMs,
    0,
    "the automatic chain parked without progress",
  );
  await player.clock.observe();
  assert.ok(
    player.shown.value!.state.observedSessionTimeMs >= 40,
    "an external explicit observation establishes a fresh basis",
  );
  await player.advance(100);
  assert.equal(
    player.shown.value?.state.foregroundAction?.kind,
    "interaction",
    "the later deadline resumes automatically on the new basis",
  );
});

test("after an injected failed delivery parks automatic work, one opportunity reaches the deadline once a publication is stored only", async (context) => {
  const player = await mountClock(context, false);
  player.stopSampling();
  const clone = globalThis.structuredClone;
  let failedReply = 0;
  context.mock.method(
    globalThis,
    "structuredClone",
    (value: unknown, options?: StructuredSerializeOptions) => {
      const observedReply =
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "reply" &&
        "ok" in value &&
        value.ok === true &&
        "result" in value &&
        typeof value.result === "object" &&
        value.result !== null &&
        "kind" in value.result &&
        value.result.kind === "observed";
      if (observedReply && failedReply === 0) {
        failedReply += 1;
        throw new Error("The success reply could not cross.");
      }
      return clone(value, options);
    },
  );
  await assert.rejects(
    player.bridge.request(asShown(player.initial), "observeTime", { atMs: 0, media: [] }),
    /could not cross/,
  );
  await player.advance(100);
  const parked = player.attempts.length;
  await player.advance(50);
  assert.equal(player.attempts.length, parked, "parked: both sends were refused on their basis");
  // A publication applied to the store only: the shown reference stays.
  const shown = player.shown.value!;
  assert.equal(observeOnHost(shown, 0, []).outcome.kind, "observed");
  assert.ok(player.bridge.latest(shown)!.revision > shown.revision);
  assert.equal(player.shown.value, shown);
  player.clock.catchUp();
  await player.advance(100);
  assert.equal(player.shown.value?.state.foregroundAction?.kind, "interaction");
});
