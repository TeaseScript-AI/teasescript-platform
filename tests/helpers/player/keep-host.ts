/*
 * The keep tests' shared host (`player-session-keep`, `-producers`, `-ownership`): the composable over an in-process
 * engine and a browser's saved data, and the plan writes it records and fails.
 */

import assert from "node:assert/strict";
import { after, before, type TestContext } from "node:test";
import { effectScope, type Ref } from "vue";
import {
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
  type KeptSessionUpdate,
} from "../../../player/persistence/kept-sessions.js";
import type {
  PlayerRuntimeSession,
  PlayerRuntimeSessionOptions,
} from "../../../player/runtime/runtime-adapter.js";
import { compilePlayerProject } from "../../../player/runtime/compile-project.js";
import { preparedPlan } from "../prepared-plan.js";
import type { Intent } from "./player-input.js";
import type { CapturedMediaLocks } from "../../../player/media/captured-media-persistence.js";
import type { SavedDataHost } from "../../../player/persistence/saved-data.js";
import type { StorageBundle } from "../../../player/persistence/storage-transfer.js";
import type { PlayerBridge } from "../../../player/runtime/player-bridge.js";
import type { ScriptStorageProvider } from "../../../player/persistence/script-storage.js";
import type { InstructionPlan } from "../../../src/index.js";
import { FakeMediaRepository } from "./fake-media-repository.js";
import type { SessionRead } from "./transfer-read.js";
import type { SessionTransfer } from "../../../player/persistence/session-transfer.js";
import { loadPlayerModule } from "../player-modules.js";
import { loadHostFacade } from "./host-sessions.js";
import { inProcessBackend } from "./worker-topology.js";

// What Start leaves out of its own frame (#1707): the plan's JSON for a new session's first save is written in a task
// before Start, and the zone the browser names is captured early. Start and Continue still record the zone and clock
// as they are at the click, and the stored bytes and saves stay as they were.

export interface KeepHost {
  readonly session: Readonly<Ref<PlayerRuntimeSession | null>>;
  readonly activation: Readonly<Ref<"start" | "continue" | null>>;
  loadScriptStorage(): Promise<void>;
  scriptStorageOptions(): PlayerRuntimeSessionOptions;
  prepareScript(
    plan: string,
    create: { readonly plan: string; readonly options: () => PlayerRuntimeSessionOptions },
  ): Promise<void>;
  activate(): Promise<void>;
  toStartPage(): Promise<void>;
  temporalCapture(): PlayerRuntimeSessionOptions;
  readonly bridge: Promise<PlayerBridge>;
  exportSession(): Promise<{ readonly transfer: SessionTransfer }>;
  setDebugMode(enabled: boolean): void;
  readonly rooms: {
    readonly current: Readonly<Ref<"normal" | "debug">>;
    readonly debugSessionExists: Readonly<Ref<boolean>>;
    readonly debugHasData: Readonly<Ref<boolean>>;
  };
  readTransfer(input: {
    readonly bytes: Uint8Array<ArrayBuffer>;
  }): Promise<{ readonly kind: string }>;
  reviewSessionImport(transfer: SessionRead): Promise<ImportReview>;
  discardSessionReview(transfer: SessionRead): void;
  importSession(review: ImportReview): Promise<void>;
  readonly savedDataRevision: Readonly<Ref<number>>;
  readonly notices: Readonly<Ref<readonly { readonly key: string }[]>>;
  readonly canImportSavedData: Readonly<Ref<boolean>>;
  readonly images: {
    store(
      file: File,
      filters: { types: readonly string[] | null; mime: readonly string[] | null },
    ): Promise<{ readonly reference: string } | { readonly message: string }>;
  };
  readonly imageCapture: { choose(reference: string): boolean; answer(input: "button"): Intent };
  readonly inputSection: unknown;
  readSavedData(): Promise<readonly { readonly key: string }[]>;
  reviewSavedDataImport(bundle: StorageBundle): Promise<SavedDataReview>;
  importSavedData(review: SavedDataReview, chosen: ReadonlySet<string>): Promise<void>;
}
/** A saved-data import's review, as this file passes it to the import. */
interface SavedDataReview {
  readonly scripts: readonly { readonly scope: string }[];
}
/** An import's review, as this file passes it to the import. */
interface ImportReview {
  readonly snapshotJson: string;
}
let usePlayerSession: (options: {
  bridge?: Promise<PlayerBridge>;
  scriptStorage: ScriptStorageProvider;
  capturedMedia?: { repository: FakeMediaRepository };
  keptSessions: KeptSessionStore;
  debugRooms?: KeptRoomStore;
  room?: "debug";
  savedData?: SavedDataHost;
  decodeImage: (data: Blob) => Promise<{ width: number; height: number }>;
}) => KeepHost;
export let browserSavedData: (
  storage: Storage,
  repository: FakeMediaRepository,
  keptSessions: undefined,
  locks: CapturedMediaLocks,
) => SavedDataHost;

// Every page captures the zone `TZ` names into one module cache, so the file starts from a known zone, which no test
// below treats as one not seen before.
const inheritedZone = process.env["TZ"];
process.env["TZ"] = "UTC";
after(() => {
  if (inheritedZone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = inheritedZone;
});

before(async () => {
  await loadHostFacade();
  const facade: Record<string, unknown> = await loadPlayerModule(
    "tests/helpers/bridge/in-process.ts",
  );
  assert.equal(typeof facade.heldPlan, "function");
  // EVIDENCE: validation: the bundle facade's `heldPlan`, checked as a function above.
  heldPlan = facade.heldPlan as typeof heldPlan;
  const module: Record<string, unknown> = await loadPlayerModule(
    "player/vue/src/session/usePlayerSession.ts",
  );
  assert.equal(typeof module.usePlayerSession, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  usePlayerSession = module.usePlayerSession as typeof usePlayerSession;
  const savedData: Record<string, unknown> = await loadPlayerModule(
    "player/persistence/saved-data.ts",
  );
  assert.equal(typeof savedData.browserSavedData, "function");
  // EVIDENCE: validation: Vite loaded the real source module and the export is callable; this is its tested host API.
  browserSavedData = savedData.browserSavedData as typeof browserSavedData;
});

/** The browser surface the Player host touches without a camera; `hide()` hides the page, which keeps the session. */
export function stubBrowser(context: TestContext) {
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const values = {
    document,
    window: new EventTarget(),
    navigator: {},
    Audio: class extends EventTarget {
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
  return {
    hide() {
      document.visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      document.visibilityState = "visible";
    },
  };
}

export const SCOPE = "development-package:keep";

/** One browser's kept sessions, recording every publication of a session, of which the first `failing` are refused. */
export function browser() {
  const provider: ScriptStorageProvider = {
    scope: SCOPE,
    load: async () => [],
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
  const inner = memoryKeptSessionStore();
  const published: KeptSessionUpdate[] = [];
  const state = { failing: 0 };
  const kept: KeptSessionStore = {
    ...inner,
    async publish(scope, update) {
      published.push(update);
      if (state.failing > 0) {
        state.failing -= 1;
        throw new DOMException("The storage is full.", "QuotaExceededError");
      }
      return inner.publish(scope, update);
    },
  };
  return { provider, repository: new FakeMediaRepository(), kept, published, state };
}

/**
 * Counts how often each of `plans` is written as JSON (the engine's writer gives a plan to `JSON.stringify`): the
 * result gives the count of a plan, by default the first.
 */
export function planWrites(context: TestContext, ...plans: InstructionPlan[]) {
  const stringify = JSON.stringify;
  const counts = new Map<unknown, number>();
  JSON.stringify = new Proxy(stringify, {
    apply(target, _self, args) {
      const value: unknown = args[0];
      if (
        faults.nextSnapshot &&
        typeof value === "object" &&
        value !== null &&
        "format" in value &&
        value.format === "teasescript-runtime-snapshot"
      ) {
        faults.nextSnapshot = false;
        throw new RangeError("Invalid string length");
      }
      // The host holds its own plan, prepared from this plan's text: its writes count as this plan's.
      const plan = heldAs.get(args[0]) ?? args[0];
      if (faults.planWrite !== null && plan === faults.planWrite && heldAs.has(args[0])) {
        faults.planWrite = null;
        throw new RangeError("Invalid string length");
      }
      if (heldAs.has(args[0])) graphWrites.set(args[0], (graphWrites.get(args[0]) ?? 0) + 1);
      if (plans.includes(plan)) counts.set(plan, (counts.get(plan) ?? 0) + 1);
      return target(args[0], args[1], args[2]);
    },
  });
  context.after(() => (JSON.stringify = stringify));
  return (plan: InstructionPlan | undefined = plans[0]) => counts.get(plan) ?? 0;
}

/** The plans the hosts hold, each as the test's plan it was prepared from (`planWrites`). */
const heldAs = new Map<unknown, InstructionPlan>();
/** The faults `planWrites`'s writer injects, set by the tests; the writer clears each once it fires. */
export const faults: {
  /** Whether the writer fails the next snapshot, as a state too long to save does (`TSK004`). */
  nextSnapshot: boolean;
  /** The plan whose next write in a host the writer fails, as one too large for the browser does. */
  planWrite: InstructionPlan | null;
} = { nextSnapshot: false, planWrite: null };
/** How often each host's own plan was written while `planWrites` counted. */
const graphWrites = new Map<unknown, number>();
/** How often `host`'s host wrote its plan of `plan` while `planWrites` counted. */
export async function writesOn(host: KeepHost, plan: InstructionPlan): Promise<number> {
  return graphWrites.get(heldPlan(await host.bridge, await held(host, plan))) ?? 0;
}
/** Each page's host token of a test plan: preparing a plan again on a page reuses it, as the plan is the same. */
const tokens = new WeakMap<KeepHost, Map<InstructionPlan, string>>();
let heldPlan: (bridge: PlayerBridge, token: string) => object;

/** The token under which `host`'s bridge holds `plan`, prepared there from the plan's text the first time. */
export async function held(host: KeepHost, plan: InstructionPlan): Promise<string> {
  const known = tokens.get(host) ?? new Map<InstructionPlan, string>();
  tokens.set(host, known);
  const token = known.get(plan) ?? (await preparedPlan(host.bridge, plan));
  known.set(plan, token);
  heldAs.set(heldPlan(await host.bridge, token), plan);
  return token;
}

/** `plan`'s Start on `host`, as a host prepares it: the held plan, with the page's storage and the click's capture. */
export async function prepareOn(host: KeepHost, plan: InstructionPlan) {
  const token = await held(host, plan);
  await host.prepareScript(token, {
    plan: token,
    options: () => ({ ...host.scriptStorageOptions(), ...host.temporalCapture() }),
  });
}

/** A page of the Player in `at` that prepares `plan`'s Start, or Continue for the session `at` keeps. */
export async function page(
  context: TestContext,
  at: ReturnType<typeof browser>,
  plan: InstructionPlan,
  delayMs?: number,
) {
  const opened = await mount(context, at, delayMs);
  await prepareOn(opened.host, plan);
  return opened;
}

/** A page of the Player in `at` with its saved values loaded, before it prepares a plan. */
export async function mount(
  context: TestContext,
  at: ReturnType<typeof browser> & {
    readonly rooms?: KeptRoomStore;
    readonly savedData?: SavedDataHost;
  },
  delayMs?: number,
  room?: "debug",
) {
  const scope = effectScope();
  const host = scope.run(() =>
    usePlayerSession({
      bridge: inProcessBackend(delayMs === undefined ? {} : { delayMs }),
      scriptStorage: at.provider,
      // A browser whose saved values keep no captured media gives the page no media store.
      ...("route" in at.state && at.state.route === "plain"
        ? {}
        : { capturedMedia: { repository: at.repository } }),
      keptSessions: at.kept,
      ...(at.rooms === undefined ? {} : { debugRooms: at.rooms }),
      ...(at.savedData === undefined ? {} : { savedData: at.savedData }),
      ...(room === undefined ? {} : { room }),
      decodeImage: async () => ({ width: 2, height: 2 }),
    }),
  );
  assert.ok(host);
  context.after(() => scope.stop());
  await host.loadScriptStorage();
  return { host, scope };
}

/** Lets the tasks queued so far run, such as what an activation prepares. */
export const tasks = () => new Promise((resolve) => setTimeout(resolve, 5));

export async function until(condition: () => boolean, message: string) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await tasks();
  }
}

export const ASKS = compilePlayerProject(
  'let a = askText(hint: "One")\nsay "Got ${a}.", instant\nexit',
).plan!;
export const ENDS = compilePlayerProject('say "Hi.", instant\nexit').plan!;

/** Prepares `plan`'s Start again on `host`'s page, as a host does for another script or the same one. */
export async function prepareAgain(host: KeepHost, plan: InstructionPlan) {
  await prepareOn(host, plan);
}

/*
 * The plan JSON's lifetime through the real composable and its in-process host: the family of
 * `helpers/player/plan-json-family.ts`, each producer driven on its real path, its reply held while the page's plan retires
 * (or does not). At the end, the host holds the plan's JSON while it is the live page's current plan and lets go of it
 * otherwise, and it was written at most once while the page held the plan.
 */
export const ASKS_OTHER = compilePlayerProject(
  'let b = askText(hint: "Other")\nsay "Got ${b}.", instant\nexit',
).plan!;
