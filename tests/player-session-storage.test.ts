import assert from "node:assert/strict";
import test from "node:test";
import { nextTick } from "vue";
import type { PlayerRuntimeSession } from "../player/runtime/runtime-adapter.js";
import {
  pendingPlayerRuntimeStorageWrite,
  playerRuntimePacingGate,
} from "../player/runtime/runtime-view.js";
import {
  playerRuntimeSnapshot,
  acknowledged,
  deferred,
  createHost,
  start,
} from "./helpers/storage-host.js";

test("Vue host writes each pending action once and continues only in a later task", async (context) => {
  const writes: { key: string; value: unknown }[] = [];
  const persistence = deferred();
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: (key, value) => {
      writes.push({ key, value });
      return persistence.promise;
    },
    replace: async () => {},
    clear: async () => {},
  });
  const pending = await start(host, 'save 1 as "first"\nsave 2 as "second"\nexit');
  assert.ok(pendingPlayerRuntimeStorageWrite(pending.state));
  host.update({ ...pending });
  host.update({ ...pending });
  assert.deepEqual(writes, [{ key: "first", value: 1 }]);

  persistence.resolve();
  await nextTick();
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, []);
  assert.equal(host.session.value?.state.status, "waiting");
  assert.deepEqual(writes, [{ key: "first", value: 1 }]);

  context.mock.timers.tick(0);

  await acknowledged();
  assert.deepEqual(writes, [
    { key: "first", value: 1 },
    { key: "second", value: 2 },
  ]);
  const second = host.session.value;
  assert.ok(second);
  assert.deepEqual(playerRuntimeSnapshot(second).scriptStorage, [{ key: "first", value: 1 }]);
  host.update({ ...second });
  await nextTick();
  assert.equal(writes.length, 2);
  assert.equal(host.session.value?.state.status, "waiting");
  context.mock.timers.tick(0);
  await acknowledged();
  assert.equal(host.session.value?.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, [
    { key: "first", value: 1 },
    { key: "second", value: 2 },
  ]);
});

test("Vue host deduplicates by generation and ignores a replaced session's write report", async (context) => {
  const reports = [deferred(), deferred()];
  const writes: { key: string; value: unknown }[] = [];
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: (key, value) => {
      const report = reports[writes.length];
      assert.ok(report);
      writes.push({ key, value });
      return report.promise;
    },
    replace: async () => {},
    clear: async () => {},
  });
  const original = await start(host, 'save 1 as "answer"\nexit');
  const restarted = await start(host, 'save 2 as "answer"\nexit');
  assert.equal(
    pendingPlayerRuntimeStorageWrite(original.state)?.actionId,
    pendingPlayerRuntimeStorageWrite(restarted.state)?.actionId,
  );
  host.update({ ...restarted });
  assert.deepEqual(writes, [
    { key: "answer", value: 1 },
    { key: "answer", value: 2 },
  ]);

  reports[0]!.resolve();
  await nextTick();
  context.mock.timers.tick(0);
  await acknowledged();
  assert.deepEqual(host.session.value, restarted);
  reports[1]!.resolve();
  await nextTick();
  context.mock.timers.tick(0);
  await acknowledged();
  assert.equal(host.session.value?.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, [
    { key: "answer", value: 2 },
  ]);
});

test("Vue host reports rejected writes in a later task and preserves the previous value", async (context) => {
  const persistence = deferred();
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [{ key: "answer", value: "previous" }],
    write: () => persistence.promise,
    replace: async () => {},
    clear: async () => {},
  });
  const pending = await start(
    host,
    'save "new" as "answer"\nlet answer: string? = load "answer", default: null\nsay answer, instant\nexit',
  );
  persistence.reject(new Error("Write denied"));
  await nextTick();
  assert.deepEqual(host.session.value, pending);
  context.mock.timers.tick(0);
  await acknowledged();
  assert.equal(host.session.value?.state.status, "halted");
  assert.deepEqual(playerRuntimeSnapshot(host.session.value!).scriptStorage, [
    { key: "answer", value: "previous" },
  ]);
  assert.deepEqual(
    host.session.value?.transcriptEntries.map((entry) => entry.text),
    ["previous"],
  );
  assert.ok(
    host.session.value?.events.some(
      (event) => event.kind === "developerWarning" && event.code === "TSW014",
    ),
  );
  // The player learns through the notice channel that the progress was not kept.
  assert.deepEqual(
    host.notices.value.map(({ key, level }) => [key, level]),
    [["storage-write-failed", "warning"]],
  );
});

for (const settleBeforeDisposal of [false, true]) {
  test(`Vue host never continues after disposal ${settleBeforeDisposal ? "with a report already queued" : "while a write is unresolved"}`, async (context) => {
    const persistence = deferred();
    let writes = 0;
    const { host, scope } = createHost(context, {
      scope: "test",
      load: async () => [],
      write: () => {
        writes++;
        return persistence.promise;
      },
      replace: async () => {},
      clear: async () => {},
    });
    const pending = await start(host, 'save 1 as "answer"\nsave 2 as "next"\nexit');
    if (settleBeforeDisposal) {
      persistence.resolve();
      await nextTick();
    }
    scope.stop();
    if (!settleBeforeDisposal) persistence.resolve();
    await nextTick();
    context.mock.timers.tick(0);
    await acknowledged();
    assert.deepEqual(host.session.value, pending);
    assert.equal(writes, 1);
  });
}

test("Vue host schedules no clock wake-ups while a pending write holds scene time", async (context) => {
  const persistence = deferred();
  let now = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => now;
  context.after(() => (performance.now = realNow));
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: () => persistence.promise,
    replace: async () => {},
    clear: async () => {},
  });
  await start(
    host,
    'timer async 10 ms { say "one", instant }\ntimer async 20 ms { say "two", instant }\nsave 1 as "k"\nwait 100 ms\nexit',
  );
  now = 100;
  await host.observe();
  // Catch-up holds at the first block's due time behind the write; an overdue deadline must not spin the clock.
  assert.equal(host.session.value?.state.currentSessionTimeMs, 10);
  const held = host.session.value;
  // The clock reschedules from a pre-flush watcher, so each step lets Vue run it before timers advance.
  for (let tick = 0; tick < 25; tick++) {
    await nextTick();
    context.mock.timers.tick(0);
    await acknowledged();
  }
  assert.equal(host.session.value, held);

  persistence.resolve();
  await nextTick();
  context.mock.timers.tick(0);
  await acknowledged();
  // After the acknowledgement both blocks run at their due times and the clock schedules the wait again.
  assert.deepEqual(
    host.session.value?.transcriptEntries.map((entry) => entry.text),
    ["one", "two"],
  );
});

for (const [name, source, expected] of [
  // Without a queued block, an elapsed background pacing gate settles while the write waits.
  [
    "an elapsed pacing gate settles",
    'say "before", 1 s\nsave 1 as "k"\nsay "after", instant\nexit',
    ["before", "after"],
  ],
  // A due block waits for the write, then runs at its time before the script continues and ends.
  [
    "a due block runs before the script continues",
    'timer async 10 ms { say "due", instant }\nsave 1 as "k"\nsay "main", instant\nexit',
    ["due", "main"],
  ],
] as const) {
  test(`Vue host still observes deadlines while a slow write waits: ${name}`, async (context) => {
    let now = 0;
    context.mock.method(performance, "now", () => now);
    const persistence = deferred();
    const { host } = createHost(context, {
      scope: "test",
      load: async () => [],
      write: () => persistence.promise,
      replace: async () => {},
      clear: async () => {},
    });
    await start(host, source);
    await nextTick();
    now = 2_000;
    context.mock.timers.tick(2_000);
    // The deadline's catch-up goes over the bridge (begin, step, adopt), each reply a few microtasks later.
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    if (source.startsWith("say")) {
      const waiting: PlayerRuntimeSession | null = host.session.value;
      assert.equal(playerRuntimePacingGate(waiting!), null);
    }
    persistence.resolve();
    await nextTick();
    context.mock.timers.tick(0);
    await acknowledged();
    assert.deepEqual(
      host.session.value?.transcriptEntries.map((entry) => entry.text),
      expected,
    );
  });
}

test("Vue host scopes the write-failure notice to the run it happened in", async (context) => {
  const pendingWrites: ReturnType<typeof deferred>[] = [];
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: () => {
      const write = deferred();
      pendingWrites.push(write);
      return write.promise;
    },
    replace: async () => {},
    clear: async () => {},
  });
  // A rejection reported after its session was replaced says nothing about the current run.
  await start(host, 'save 1 as "k"\nexit');
  await start(host, 'save 2 as "k"\nexit');
  pendingWrites[0]!.reject(new Error("Write denied"));
  pendingWrites[1]!.resolve();
  await nextTick();
  context.mock.timers.tick(0);
  await acknowledged();
  assert.deepEqual(host.notices.value, []);

  // A failure in the current run is reported, and a new Start withdraws it.
  await start(host, 'save 3 as "k"\nexit');
  pendingWrites[2]!.reject(new Error("Write denied"));
  await nextTick();
  context.mock.timers.tick(0);
  await acknowledged();
  assert.deepEqual(
    host.notices.value.map(({ key }) => key),
    ["storage-write-failed"],
  );
  await start(host, "exit");
  assert.deepEqual(host.notices.value, []);
});
