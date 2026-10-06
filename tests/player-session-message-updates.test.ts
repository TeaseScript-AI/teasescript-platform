import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, nextTick, type Ref } from "vue";
import { createServer } from "vite";

import type * as Adapter from "../player/runtime-adapter.js";
import type { PlayerRuntimeSession } from "../player/runtime-adapter.js";
import { MESSAGE_TEXT_FUNCTIONS, messageSayPlan } from "./helpers/message-says.js";

/*
 * The Player speaks messages changed in place from a status region (PLAYER-UI.md "Message presentation and provenance"):
 * only changes that live play publishes, never the history of a restored or newly started session.
 */

interface MessageHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  prepare(create: () => PlayerRuntimeSession): void;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: Record<string, never>) => MessageHost;
let useMessageUpdateAnnouncements: (host: MessageHost) => Readonly<Ref<string>>;
let adapter: Pick<
  typeof Adapter,
  | "createPlayerRuntimeSession"
  | "createPlayerRuntimeRestorePoint"
  | "restorePlayerRuntimeSession"
  | "submitPlayerRuntimeComposer"
>;

before(async () => {
  // Load the real Vue composables through the existing build tool: their browser-source imports use Vite resolution.
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const host: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerSession.ts",
    );
    const announcements: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/useMessageUpdateAnnouncements.ts",
    );
    const loaded: Record<string, unknown> = await server.ssrLoadModule(
      "/player/runtime-adapter.ts",
    );
    assert.equal(typeof host.usePlayerSession, "function");
    assert.equal(typeof announcements.useMessageUpdateAnnouncements, "function");
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
    usePlayerSession = host.usePlayerSession as typeof usePlayerSession;
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable.
    useMessageUpdateAnnouncements =
      announcements.useMessageUpdateAnnouncements as typeof useMessageUpdateAnnouncements;
    for (const name of [
      "createPlayerRuntimeSession",
      "createPlayerRuntimeRestorePoint",
      "restorePlayerRuntimeSession",
      "submitPlayerRuntimeComposer",
    ])
      assert.equal(typeof loaded[name], "function");
    adapter = {
      // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
      createPlayerRuntimeSession:
        loaded.createPlayerRuntimeSession as typeof Adapter.createPlayerRuntimeSession,
      // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
      createPlayerRuntimeRestorePoint:
        loaded.createPlayerRuntimeRestorePoint as typeof Adapter.createPlayerRuntimeRestorePoint,
      // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
      restorePlayerRuntimeSession:
        loaded.restorePlayerRuntimeSession as typeof Adapter.restorePlayerRuntimeSession,
      // EVIDENCE: validation: Vite loaded the real adapter source, and each export is callable.
      submitPlayerRuntimeComposer:
        loaded.submitPlayerRuntimeComposer as typeof Adapter.submitPlayerRuntimeComposer,
    };
  } finally {
    await server.close();
  }
});

function createHost(context: TestContext) {
  // Event targets are the only browser surface these scripts use; no media elements are created.
  for (const name of ["document", "window"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const scope = effectScope();
  const created = scope.run(() => {
    const host = usePlayerSession({});
    return { host, spoken: useMessageUpdateAnnouncements(host) };
  });
  assert.ok(created);
  context.after(() => scope.stop());
  return created;
}

async function settle(context: TestContext, ms: number) {
  context.mock.timers.tick(ms);
  await nextTick();
}

const plan = messageSayPlan(
  [
    MESSAGE_TEXT_FUNCTIONS,
    'let line = timer(duration: 1 ms, async: true, label: "Waiting")',
    'let answer = askText "Go?"',
    'setText(line, "Ready ${answer}")',
    'let more = askText "More?"',
    'setText(line, "Done")',
    "exit",
  ].join("\n"),
);

test("a change that live play publishes is spoken, and a restored or new session speaks none of its history", async (context) => {
  const { host, spoken } = createHost(context);
  host.prepare(() => adapter.createPlayerRuntimeSession(plan));
  await host.activate();
  await settle(context, 0);
  // The message itself is no change.
  assert.equal(spoken.value, "");

  host.update(adapter.submitPlayerRuntimeComposer(host.session.value!, "now")!.session);
  await settle(context, 0);
  assert.equal(spoken.value, "Narrator: Ready now");

  // Continue of a restored state begins again from the messages as they are.
  const restorePoint = adapter.createPlayerRuntimeRestorePoint(host.session.value!);
  host.prepareRestore(adapter.restorePlayerRuntimeSession(restorePoint));
  await host.activate();
  await settle(context, 10_000);
  assert.equal(spoken.value, "");

  // A change made before a new generation is never spoken after it.
  host.update(adapter.submitPlayerRuntimeComposer(host.session.value!, "yes")!.session);
  host.prepare(() => adapter.createPlayerRuntimeSession(plan));
  await host.activate();
  await settle(context, 10_000);
  assert.equal(spoken.value, "");
});
