/*
 * Start and Continue on the session host's storage: what each Start loads, clears and resolves, and what Continue resumes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { nextTick } from "vue";
import {
  createPlayerRuntimeRestorePoint as rawCreatePlayerRuntimeRestorePoint,
  restorePlayerRuntimeSession,
  type PlayerRuntimeSession,
} from "../../player/runtime/runtime-adapter.js";
import { createPlayerRuntimeSession } from "../../player/runtime/compile-project.js";
import { pendingPlayerRuntimeStorageWrite } from "../../player/runtime/runtime-view.js";
import {
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  serializeCheckpoint,
  type SerializableRuntimeValue,
} from "../../src/index.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";
import { AMSTERDAM, utc } from "../helpers/temporal-fixtures.js";
import { onHost } from "../helpers/player/host-sessions.js";
import {
  playerRuntimeSnapshot,
  acknowledged,
  deferred,
  createHost,
  start,
  memoryStorage,
  said,
} from "../helpers/player/storage-host.js";

const createPlayerRuntimeRestorePoint = onHost(rawCreatePlayerRuntimeRestorePoint);

test("Vue host reloads before each Start and falls back to session-local storage after load rejection", async (context) => {
  let loads = 0;
  let writes = 0;
  const { host } = createHost(context, {
    scope: "test",
    load: async () => {
      loads++;
      if (loads === 2) throw new Error("Read denied");
      return [{ key: "answer", value: loads }];
    },
    write: async () => {
      writes++;
    },
    replace: async () => {},
    clear: async () => {},
  });
  const first = await start(
    host,
    'let answer: integer? = load "answer", default: null\nsay answer, instant\nexit',
  );
  assert.equal(playerRuntimeSnapshot(first).scriptStoragePersistent, true);
  assert.deepEqual(
    first.transcriptEntries.map((entry) => entry.text),
    ["1"],
  );
  assert.equal(host.canClearScriptStorage.value, true);

  const local = await start(
    host,
    'save "local" as "answer"\nlet answer: string? = load "answer", default: null\nsay answer, instant\nexit',
  );
  assert.deepEqual(host.scriptStorageOptions(), {});
  assert.equal(playerRuntimeSnapshot(local).scriptStoragePersistent, false);
  assert.equal(local.state.status, "halted");
  assert.equal(pendingPlayerRuntimeStorageWrite(local.state), null);
  assert.deepEqual(
    local.transcriptEntries.map((entry) => entry.text),
    ["local"],
  );
  assert.equal(host.canClearScriptStorage.value, false);
  assert.equal(writes, 0);
  assert.deepEqual(
    host.notices.value.map(({ key, level }) => [key, level]),
    [["storage-unavailable", "info"]],
  );

  const recovered = await start(
    host,
    'let answer: integer? = load "answer", default: null\nsay answer, instant\nexit',
  );
  assert.equal(loads, 3);
  assert.equal(playerRuntimeSnapshot(recovered).scriptStoragePersistent, true);
  // A successful load withdraws the unavailable-storage notice.
  assert.deepEqual(host.notices.value, []);
  assert.deepEqual(
    recovered.transcriptEntries.map((entry) => entry.text),
    ["3"],
  );
});

test("Vue host clears once, and no Start begins until the clear settles", async (context) => {
  const clearing = deferred();
  let clears = 0;
  let stored = [{ key: "answer", value: "old" }];
  const { host } = createHost(context, {
    scope: "test",
    load: async () => stored,
    write: async () => {},
    replace: async () => {},
    clear: async () => {
      clears++;
      await clearing.promise;
      stored = [];
    },
  });
  await host.loadScriptStorage();
  host.prepare(() =>
    createPlayerRuntimeSession(
      'let answer: string? = load "answer", default: null\nexit',
      host.scriptStorageOptions(),
    ),
  );
  const first = host.clearScriptStorage();
  assert.equal(host.canClearScriptStorage.value, false);
  assert.equal(await host.clearScriptStorage(), false);
  assert.equal(host.activation.value, null);
  // Read through a function: an assertion narrows the reactive value's type for the rest of the test.
  const current = (): PlayerRuntimeSession | null => host.session.value;
  await host.activate();
  assert.equal(current(), null);

  clearing.resolve();
  assert.equal(await first, true);
  assert.equal(clears, 1);
  assert.equal(host.activation.value, "start");
  await host.activate();
  // The session starts from the cleared view, not from the values loaded before the clear.
  assert.deepEqual(playerRuntimeSnapshot(current()!).scriptStorage, []);
});

test("Vue host resolves the player's zone and presentation again at Start and at Continue", async (context) => {
  let account = AMSTERDAM;
  let resolved = 0;
  const { host } = createHost(
    context,
    {
      scope: "test",
      load: async () => [],
      write: async () => {},
      replace: async () => {},
      clear: async () => {},
    },
    () => {
      resolved++;
      return account;
    },
  );
  context.mock.method(Date, "now", () => utc("2026-10-04T16:00:00"));
  await host.loadScriptStorage();
  host.prepare(() =>
    createPlayerRuntimeSession('let day = askChoice [toDate("2026-10-04")]\nsay day\nexit', {
      ...host.scriptStorageOptions(),
      ...host.temporalCapture(),
    }),
  );
  await host.activate();
  const started = host.session.value;
  assert.ok(started);
  assert.equal(
    playerRuntimeSnapshot(started).temporalCaptures[0]?.context.zone.name,
    "Europe/Amsterdam",
  );

  // The account setting changed before the player continued the saved session.
  account = DEFAULT_TEMPORAL_CONTEXT;
  context.mock.method(Date, "now", () => utc("2026-10-05T09:00:00"));
  host.prepareRestore(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(started)));
  await host.activate();
  const continued = playerRuntimeSnapshot(host.session.value!);
  assert.ok(continued);
  assert.equal(resolved, 2);
  assert.deepEqual(
    continued.temporalCaptures.map((capture) => [capture.context.zone.name, capture.epochMs]),
    [
      ["Europe/Amsterdam", utc("2026-10-04T16:00:00")],
      ["UTC", utc("2026-10-05T09:00:00")],
    ],
  );
  // The choice keeps the buttons it was shown with.
  const choice = continued.foregroundAction;
  assert.ok(choice?.kind === "interaction" && choice.ui.kind === "choice");
  assert.deepEqual(
    choice.ui.options.map((option) => option.text),
    ["4-10-2026"],
  );
});

test("Vue host's Continue resumes a restored ready session from the activation alone", async (context) => {
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  });
  const { plan } = compileSource('say "Resumed", instant\nexit');
  assert.ok(plan);
  host.prepareRestore(
    restorePlayerRuntimeSession({
      checkpointJson: serializeCheckpoint(createCheckpoint(plan, createFreshRuntimeSnapshot(plan))),
      events: [],
    }),
  );
  const beforeActivation = host.session.value;
  assert.equal(host.activation.value, "continue");
  assert.equal(beforeActivation, null);

  // No timer, observation, or page lifecycle event is needed after the click: Continue resumes from its replies.
  await host.activate();
  assert.deepEqual(
    host.session.value?.transcriptEntries.map((entry) => entry.text),
    ["Resumed"],
  );
  assert.equal(host.session.value?.state.status, "halted");
});

test("Vue host keeps a recovery notice until its condition resolves", async (context) => {
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  });
  host.publishNotice({
    key: "needs-action",
    level: "warning",
    message: "Act.",
    dismissible: false,
  });
  host.dismissNotice("needs-action");
  assert.deepEqual(
    host.notices.value.map(({ key }) => key),
    ["needs-action"],
  );
  // Its producer withdraws it once the condition resolves.
  host.withdrawNotice("needs-action");
  assert.deepEqual(host.notices.value, []);
});

test("Vue host records every session from Start and from Continue for a debug export", async (context) => {
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  });
  assert.equal(await host.debugRecording(), null, "nothing is recorded before Start");
  await host.loadScriptStorage();
  host.prepare((recording) =>
    createPlayerRuntimeSession('let name = askText "Name"\nexit', recording),
  );
  await host.activate();
  assert.deepEqual(
    (await host.debugRecording())?.operations.map((operation) => operation.kind),
    ["run"],
  );
  const started = host.session.value;
  assert.ok(started);
  host.prepareRestore(restorePlayerRuntimeSession(createPlayerRuntimeRestorePoint(started)));
  await host.activate();
  assert.deepEqual(
    (await host.debugRecording())?.operations.map((operation) => operation.kind),
    ["recordContinueCapture", "run"],
    "a Continue starts a new recording from the restored state",
  );
});

test("Play again starts from the values the previous run saved and deleted", async (context) => {
  const stored = new Map<string, SerializableRuntimeValue>([["gone", "old"]]);
  const { host } = createHost(context, {
    scope: "test",
    load: async () => [...stored].map(([key, value]) => ({ key, value })),
    write: async (key, value) => {
      if (value === null) stored.delete(key);
      else stored.set(key, value);
    },
    replace: async () => {},
    clear: async () => {},
  });
  // Each stored write reports in a later task; play on until the run ends.
  const playOut = async () => {
    for (let step = 0; step < 10 && host.session.value?.state.status !== "halted"; step++) {
      await nextTick();
      context.mock.timers.tick(0);
      await acknowledged();
    }
    assert.equal(host.session.value?.state.status, "halted");
    return host.session.value!.transcriptEntries.at(-1)?.text;
  };
  await start(
    host,
    [
      'let runs = load("runs", default: 0) + 1',
      'let gone = load("gone", default: "none")',
      'save runs as "runs"',
      'delete "gone"',
      'say "${runs} ${gone}", instant',
      "exit",
    ].join("\n"),
  );
  assert.equal(await playOut(), "1 old");
  await host.toStartPage();
  await host.activate();
  assert.equal(await playOut(), "2 none");
  assert.deepEqual([...stored], [["runs", 2]]);
});

test("each Start loads what another tab saved since the page opened or the previous run", async (context) => {
  const storage = memoryStorage({});
  const { host } = createHost(context, storage.provider);
  await host.loadScriptStorage();
  host.prepare(() =>
    createPlayerRuntimeSession(
      'let value = load("value", default: "empty")\nsay "Loaded: ${value}", instant\nexit',
      host.scriptStorageOptions(),
    ),
  );
  // Another tab's save reaches only the provider.
  storage.entries.set("value", "latest");
  await host.activate();
  assert.deepEqual(said(host.session.value), ["Loaded: latest"]);
  await host.toStartPage();
  storage.entries.set("value", "newer");
  await host.activate();
  assert.deepEqual(said(host.session.value), ["Loaded: newer"]);
});
