/*
 * The session storage tests' shared host (`player-session-storage`, `player-storage-startup`, `player-storage-debug-edits`):
 * the real composable on a session host whose storage a test holds, and the stores and reads the families share.
 */

import assert from "node:assert/strict";
import { before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import {
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
  playerRuntimeSnapshot as rawPlayerRuntimeSnapshot,
} from "../../../player/runtime/runtime-adapter.js";
import type { ScriptStorageProvider } from "../../../player/persistence/script-storage.js";
import type { InterpreterEvent, SerializableRuntimeValue } from "../../../src/index.js";
import type { TemporalContext } from "../../../src/temporal.js";
import { loadPlayerModule } from "../player-modules.js";
import { loadHostFacade, onHost } from "./host-sessions.js";
import { sourceStart, type PlanStart } from "../prepared-plan.js";
import type { PlayerSession } from "../../../player/runtime/runtime-view.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";

export const playerRuntimeSnapshot = onHost(rawPlayerRuntimeSnapshot);

// Load the real Vue composable through the existing build tool: its browser-source imports use Vite resolution.
interface StorageHost {
  readonly bridge: Promise<PlayerBridge>;
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly canClearScriptStorage: Readonly<Ref<boolean>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string; readonly level: string }[]>>;
  clearScriptStorage(): Promise<boolean>;
  observe(): Promise<PlayerRuntimeSession | null>;
  publishNotice(notice: {
    readonly key: string;
    readonly level: "info" | "warning" | "error";
    readonly message: string;
    readonly dismissible?: boolean;
  }): void;
  dismissNotice(key: string): void;
  withdrawNotice(key: string): void;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepare(create: PlanStart): void;
  toStartPage(): Promise<void>;
  debugRecording(): Promise<{ readonly operations: readonly { readonly kind: string }[] } | null>;
  prepareRestore(restored: PlayerSession): void;
  activate(): Promise<void>;
  update(session: PlayerRuntimeSession): void;
  temporalCapture(): { temporalContext: TemporalContext; wallClockMs: number };
  editSavedData(edit: {
    key: string;
    value: SerializableRuntimeValue;
    expected: SerializableRuntimeValue | undefined;
  }): Promise<
    | { kind: "saved"; live: boolean }
    | { kind: "busy" }
    | { kind: "overtaken" }
    | { kind: "changed" }
    | { kind: "failed"; message: string }
  >;
  readonly debugEdits: Readonly<Ref<{ firstEditSceneTimeMs: number; editCount: number } | null>>;
  debugExportCandidate(
    details: () => Record<string, never>,
    wanted: AbortSignal,
  ): Promise<{
    readonly editedWhileDebugging: { firstEditSceneTimeMs: number; editCount: number } | null;
  }>;
}
let usePlayerSession: (options: {
  scriptStorage: ScriptStorageProvider;
  temporalContext?: () => TemporalContext;
}) => StorageHost;

before(async () => {
  await loadHostFacade();
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
});

/** The microtasks in which a storage write's acknowledgement reaches the host and its publication applies. */
export async function acknowledged() {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

export function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function createHost(
  context: TestContext,
  provider: ScriptStorageProvider,
  temporalContext?: () => TemporalContext,
) {
  // Event targets are the only browser surface these storage-only scripts use, besides the audio elements a Start
  // primes while it reads the stored values.
  const values = {
    document: new EventTarget(),
    window: new EventTarget(),
    Audio: class {
      src = "";
      play = async () => {};
      pause() {}
      load() {}
      removeAttribute() {}
    },
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      scriptStorage: provider,
      ...(temporalContext === undefined ? {} : { temporalContext }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  return { host, scope };
}

export async function start(host: StorageHost, source: string) {
  host.prepare(await sourceStart(host.bridge, source, () => host.scriptStorageOptions()));
  await host.activate();
  assert.ok(host.session.value);
  return host.session.value;
}

/** Script storage in memory, as the browser provider keeps it; `writing` may hold or fail a write. */
export function memoryStorage(
  initial: Record<string, SerializableRuntimeValue>,
  writing: (key: string, value: SerializableRuntimeValue) => Promise<void> = async () => {},
  loading: () => Promise<void> = async () => {},
) {
  const entries = new Map(Object.entries(initial));
  const writes: [string, SerializableRuntimeValue][] = [];
  const provider: ScriptStorageProvider = {
    scope: "test",
    load: async () => {
      await loading();
      return [...entries].map(([key, value]) => ({ key, value }));
    },
    write: async (key, value) => {
      writes.push([key, value]);
      await writing(key, value);
      if (value === null) entries.delete(key);
      else entries.set(key, value);
    },
    replace: async () => {},
    clear: async () => entries.clear(),
  };
  return { provider, entries, writes };
}

export function said(session: PlayerRuntimeSession | null): string[] {
  return (session?.events ?? []).flatMap((event: InterpreterEvent) =>
    event.kind === "say" ? [event.text] : [],
  );
}
