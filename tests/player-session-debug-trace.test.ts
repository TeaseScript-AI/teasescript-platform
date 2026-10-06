import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import { createServer } from "vite";

import type { RuntimeDebugContext } from "../src/index.js";
import type * as Adapter from "../player/runtime-adapter.js";
import type { PlayerRuntimeSession } from "../player/runtime-adapter.js";
import type { DebugRecorder } from "../player/debug-recorder.js";

/*
 * The Player host runs Debug's value trace (DEBUGGER.md "Player Debug") while Debug is on: Start traces a new session
 * from its first statement, Continue of a restored session begins a new epoch, and off drops the trace and its history.
 */

interface TraceHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly debugTrace: Readonly<Ref<RuntimeDebugContext | null>>;
  setDebugTracing(on: boolean): void;
  prepare(
    create: (recording: {
      readonly recorder: DebugRecorder;
      readonly debugTrace?: RuntimeDebugContext;
    }) => PlayerRuntimeSession,
  ): void;
  prepareRestore(restored: PlayerRuntimeSession): void;
  activate(): void;
  update(session: PlayerRuntimeSession): void;
}
let usePlayerSession: (options: Record<string, never>) => TraceHost;
// The adapter from the same module graph as the host, whose trace and recorder it must recognize.
let adapter: Pick<
  typeof Adapter,
  | "createPlayerRuntimeSession"
  | "createPlayerRuntimeRestorePoint"
  | "restorePlayerRuntimeSession"
  | "submitPlayerRuntimeComposer"
>;

before(async () => {
  // Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
  const server = await createServer({
    configFile: false,
    logLevel: "warn",
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    optimizeDeps: { noDiscovery: true },
  });
  try {
    const module: Record<string, unknown> = await server.ssrLoadModule(
      "/player/vue/src/usePlayerSession.ts",
    );
    assert.equal(typeof module.usePlayerSession, "function");
    // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
    usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
    const loaded: Record<string, unknown> = await server.ssrLoadModule(
      "/player/runtime-adapter.ts",
    );
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

function traceOf(host: TraceHost): RuntimeDebugContext | null {
  return host.debugTrace.value;
}

function createHost(context: TestContext): TraceHost {
  // Event targets are the only browser surface these scripts use; no media elements are created.
  for (const name of ["document", "window"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: new EventTarget() });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = effectScope();
  const host = scope.run(() => usePlayerSession({}));
  assert.ok(host);
  context.after(() => scope.stop());
  return host;
}

const SOURCE = [
  'let mood = "calm"',
  'let answer = askText "Ready?"',
  'say "${mood} ${answer}"',
  "exit",
].join("\n");

test("Start traces from the first statement, off drops the trace, and on again attaches", (context) => {
  const host = createHost(context);
  host.setDebugTracing(true);
  const trace = host.debugTrace.value;
  assert.ok(trace);
  host.prepare((recording) => adapter.createPlayerRuntimeSession(SOURCE, { ...recording }));
  host.activate();
  assert.equal(host.session.value?.debugTrace, trace);
  assert.deepEqual([trace.status().origin, trace.status().epoch], ["start", 1]);
  assert.notEqual(trace.variableRecord(host.session.value!.snapshot.frames[0]!.id, "mood"), null);

  host.setDebugTracing(false);
  assert.equal(host.debugTrace.value, null);
  assert.equal(host.session.value?.debugTrace, null);

  host.setDebugTracing(true);
  // Read through a call: the assertion above narrowed the property itself to null.
  const again = traceOf(host);
  assert.ok(again && again !== trace);
  host.update(adapter.submitPlayerRuntimeComposer(host.session.value!, "yes")!.session);
  assert.equal(again.status().origin, "attach");
  assert.equal(trace.status().records > 0, true, "the dropped trace is no longer written");
  assert.equal(again.outputs().length, 1);
});

test("Continue of a restored session begins a new trace epoch", (context) => {
  const host = createHost(context);
  host.setDebugTracing(true);
  const trace = host.debugTrace.value!;
  host.prepare((recording) => adapter.createPlayerRuntimeSession(SOURCE, { ...recording }));
  host.activate();
  const epoch = trace.status().epoch;
  host.prepareRestore(
    adapter.restorePlayerRuntimeSession(
      adapter.createPlayerRuntimeRestorePoint(host.session.value!),
    ),
  );
  host.activate();
  assert.equal(host.session.value?.debugTrace, trace);
  assert.deepEqual([trace.status().origin, trace.status().epoch], ["restore", epoch + 1]);
  host.update(adapter.submitPlayerRuntimeComposer(host.session.value!, "yes")!.session);
  const [output] = trace.outputs();
  // The restored value's earlier history is not part of the checkpoint.
  const message = trace.record(output!)!;
  const reasons = message.dependencies
    .flatMap((dependency) => trace.record(dependency.id)?.dependencies ?? [])
    .map((dependency) => trace.record(dependency.id)?.detail);
  assert.ok(
    reasons.some((detail) => detail?.kind === "unrecorded" && detail.reason === "restored"),
  );
});
