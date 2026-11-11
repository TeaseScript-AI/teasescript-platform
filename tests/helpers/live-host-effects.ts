import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import type {
  CapturedMediaRepository,
  CapturedMediaStore,
  CapturedMediaUrls,
} from "../../player/media/captured-media.js";
import type { LockServices } from "../../player/encryption/content-lock.js";
import {
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  type KeptRoomStore,
  type KeptSessionStore,
} from "../../player/persistence/kept-sessions.js";
import type { MediaDeviceElement } from "../../player/media/media-device.js";
import type { ScriptStorageProvider } from "../../player/persistence/script-storage.js";
import type {
  RuntimeScriptStorageEntrySnapshot,
  SerializableRuntimeValue,
} from "../../src/index.js";
import { DEFAULT_TEMPORAL_CONTEXT } from "../../src/temporal.js";

/*
 * The live host's effect witness (#1919, the effect-witness design approved for PR #1942, with orchestrator 2's scope
 * cut). The host services the replay harness's composable is given, or makes with a default, are recorded: storage,
 * kept sessions and rooms, their repositories, the captured-media store, media elements, object URLs, `document` and
 * `window` listeners and dispatches, and lock fetches. A sample holds each service's state by value and the count of
 * each of its mutating calls, counted before the call validates or awaits anything, so a call that changes nothing, or
 * changes something and undoes it, still shows; an element property set counts only when it changes the value. Every
 * method is classified; a service whose methods differ from its classification fails, so a new method is classified
 * before it counts. Outside the claim (docs/TESTING.md "Replay through the bridge"): listener identity, which is only
 * counted; property writes on `document` and `window`; the bridge client's lifecycle registrations; and the capture
 * host's device internals, of which only probes are counted.
 */

/** How a member of a host service is classified. */
export type MemberKind = "mutating" | "read-only" | "data";

const SCRIPT_STORAGE = {
  scope: "data",
  load: "read-only",
  write: "mutating",
  replace: "mutating",
  clear: "mutating",
} as const satisfies Record<keyof ScriptStorageProvider, MemberKind>;

const KEPT_SESSIONS = {
  session: "read-only",
  publish: "mutating",
  media: "data",
  discard: "mutating",
} as const satisfies Record<keyof KeptSessionStore, MemberKind>;

/** The kept-session store the live host records: the memory default, which also has a room's `discardSession`. */
const MEMORY_KEPT_SESSIONS = {
  ...KEPT_SESSIONS,
  discardSession: "mutating",
} as const satisfies Record<keyof KeptSessionStore | "discardSession", MemberKind>;

const KEPT_ROOMS = {
  ...KEPT_SESSIONS,
  read: "read-only",
  create: "mutating",
  values: "read-only",
  discardSession: "mutating",
} as const satisfies Record<keyof KeptRoomStore, MemberKind>;

const REPOSITORY = {
  get: "read-only",
  add: "mutating",
  delete: "mutating",
  listReferences: "read-only",
} as const satisfies Record<keyof CapturedMediaRepository, MemberKind>;

/** The session's captured-media store, which the composable makes itself, its own repository being `null`. */
const CAPTURE_STORE = {
  add: "mutating",
  useRepository: "mutating",
  disableDurable: "mutating",
  discard: "mutating",
  holds: "read-only",
  knows: "read-only",
  knownReferences: "read-only",
  promote: "mutating",
  sessionRecords: "read-only",
  restoreSessionMedia: "mutating",
  read: "read-only",
  readDurable: "read-only",
  resolve: "read-only",
  sweep: "mutating",
  size: "read-only",
  close: "mutating",
} as const satisfies Record<keyof CapturedMediaStore, MemberKind>;

const URLS = { create: "mutating", revoke: "mutating" } as const satisfies Record<
  keyof CapturedMediaUrls,
  MemberKind
>;

const LOCKS = {
  tlock: "read-only",
  age: "read-only",
  fetch: "mutating",
  nowMs: "read-only",
} as const satisfies Record<keyof LockServices, MemberKind>;

const MEDIA_ELEMENT = {
  src: "mutating",
  preload: "mutating",
  volume: "mutating",
  currentTime: "mutating",
  duration: "read-only",
  paused: "read-only",
  ended: "read-only",
  play: "mutating",
  pause: "mutating",
  load: "mutating",
  removeAttribute: "mutating",
  addEventListener: "mutating",
  removeEventListener: "mutating",
} as const satisfies Record<keyof MediaDeviceElement, MemberKind>;

/**
 * How the live host gives the composable each of its options (`PlayerSessionOptions`, `usePlayerSession.ts`): a
 * recorded service, a pure input, or left absent so the composable's own default (recorded where it has effects) runs.
 * The keys are checked against the interface's syntax tree at run time (`declaredSessionOptions`): the test build's
 * tsconfig excludes `player/vue/`, so it cannot import the Vue Player's types.
 */
const PLAYER_SESSION_OPTIONS = {
  bridge: "transport",
  // No fresh connection: a loss is the error stop, as the replays record it.
  nextConnection: "absent",
  resolveAsset: "pure",
  scriptStorage: "recorded",
  capabilities: "absent",
  lockServices: "recorded",
  capturedMedia: "absent",
  savedData: "absent",
  debugPackage: "absent",
  decodeImage: "pure",
  temporalContext: "pure",
  keptSessions: "recorded",
  debugRooms: "recorded",
  room: "absent",
} as const;

const checkout = fileURLToPath(new URL("../../..", import.meta.url));

/** The options of an option itself, an object literal type such as `capabilities`, each classified as its option is. */
const NESTED_SESSION_OPTIONS = {
  "capabilities.camera": "absent",
  "capturedMedia.repository": "absent",
  "debugPackage.id": "absent",
  "debugPackage.version": "absent",
} as const;

/**
 * The members `PlayerSessionOptions` declares, from the syntax tree of `usePlayerSession.ts` (the TypeScript compiler
 * API): its own and those of every interface it extends, and, for a member whose type is an object literal or another
 * interface of that file, that type's members too, as `option.member`. An interface it extends from another file is a
 * failure: its members could not be classified here.
 */
function declaredSessionOptions(): string[] {
  const file = `${checkout}/player/vue/src/session/usePlayerSession.ts`;
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node)) interfaces.set(node.name.text, node);
  });
  const membersOf = (
    declaration: ts.InterfaceDeclaration | ts.TypeLiteralNode,
    seen: Set<string>,
  ): (ts.PropertySignature | ts.MethodSignature)[] => {
    // A property or a method (`hook?(): void`) is an option; any other member kind fails, never skipped.
    const own = declaration.members.map((member) => {
      if (ts.isPropertySignature(member) || ts.isMethodSignature(member)) return member;
      return assert.fail(
        `${ts.isInterfaceDeclaration(declaration) ? declaration.name.text : "an option's type"} has a ${ts.SyntaxKind[member.kind]} member, which tests/helpers/live-host-effects.ts cannot classify`,
      );
    });
    if (!ts.isInterfaceDeclaration(declaration)) return own;
    const inherited = (declaration.heritageClauses ?? []).flatMap((clause) =>
      clause.types.flatMap((type) => {
        const name = type.expression.getText(source);
        const base = interfaces.get(name);
        assert.ok(
          base !== undefined,
          `${declaration.name.text} extends ${name}, which is not declared in usePlayerSession.ts: classify its members in tests/helpers/live-host-effects.ts`,
        );
        if (seen.has(name)) return [];
        seen.add(name);
        return membersOf(base, seen);
      }),
    );
    return [...inherited, ...own];
  };
  const root = interfaces.get("PlayerSessionOptions");
  assert.ok(root !== undefined, "usePlayerSession.ts declares PlayerSessionOptions");
  const names: string[] = [];
  for (const member of membersOf(root, new Set(["PlayerSessionOptions"]))) {
    const name = member.name.getText(source);
    names.push(name);
    const type = ts.isPropertySignature(member) ? member.type : undefined;
    const nested =
      type !== undefined && ts.isTypeLiteralNode(type)
        ? type
        : type !== undefined && ts.isTypeReferenceNode(type)
          ? interfaces.get(type.typeName.getText(source))
          : undefined;
    if (nested !== undefined)
      for (const inner of membersOf(nested, new Set()))
        names.push(`${name}.${inner.name.getText(source)}`);
  }
  return names;
}

/** Fails unless `actual` names exactly the classified members, so a new member is classified first. */
function assertClassified(
  service: string,
  actual: readonly string[],
  table: Readonly<Record<string, MemberKind | string>>,
): void {
  assert.deepEqual(
    [...new Set(actual)].sort(),
    Object.keys(table).sort(),
    `${service}'s members differ from their classification in tests/helpers/live-host-effects.ts`,
  );
}

/** The services' mutating calls so far, by service and method; a call counts as it is made. */
type Calls = Record<string, Record<string, number>>;

/** A sample of the live host's effects: each recorded service's mutating calls counted, and its state by value. */
export interface EffectSample {
  readonly calls: Calls;
  readonly state: Sampled;
}

/** A sampled value: plain data, compared by value. */
export type Sampled =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly Sampled[]
  | { readonly [key: string]: Sampled };

/** The digest of `blob`'s bytes, its type and size: a captured medium compared by value. */
async function blobValue(blob: Blob): Promise<Sampled> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    type: blob.type,
    size: blob.size,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** `value` with every `Blob` in it replaced by `blobValue`: plain data, compared by value. */
async function plain(value: unknown): Promise<Sampled> {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;
  if (value instanceof Blob) return blobValue(value);
  if (Array.isArray(value)) return Promise.all(value.map(plain));
  if (typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [key, await plain(item)] as const),
    );
    return Object.fromEntries(entries);
  }
  return String(value);
}

/** A fake medium element's state, by value. */
interface ElementState {
  readonly [key: string]: Sampled;
}

/** The options the live host gives the composable (`PLAYER_SESSION_OPTIONS`'s given ones). */
export interface LiveHostOptions<B> {
  readonly bridge: Promise<B>;
  readonly resolveAsset: (path: string) => string | null;
  readonly scriptStorage: ScriptStorageProvider;
  readonly lockServices: LockServices;
  readonly decodeImage: () => Promise<{ readonly width: number; readonly height: number }>;
  readonly temporalContext: () => typeof DEFAULT_TEMPORAL_CONTEXT;
  readonly keptSessions: KeptSessionStore;
  readonly debugRooms: KeptRoomStore;
}

/** A fake medium element, as `MediaDeviceElement` describes the browser's: its state, and its calls counted. */
export interface FakeMedium extends EventTarget {
  src: string;
}

/**
 * The recorder of one live host's services. Make it before the composable; give the composable `options()`; install
 * `install()` around it and `uninstall()` after; `sample()` reads every service's state through its own methods, which
 * count nothing.
 */
export class LiveHostEffects {
  readonly #calls: Calls = {};
  /** The storage provider's entries, by key, as the composable last wrote them. */
  readonly #storage = new Map<string, SerializableRuntimeValue>();
  readonly #kept = memoryKeptSessionStore();
  readonly #rooms = memoryKeptRoomStore();
  /** Every scope and media reference a service was asked about, so their state is read back by value. */
  readonly #scopes = new Set<string>(["replay", "player"]);
  readonly #references = new Set<string>();
  readonly #elements: (FakeMedium & { readonly state: ElementState })[] = [];
  readonly #urls = new Map<string, Blob>();
  readonly #listeners = new Map<string, Map<string, number>>();
  readonly #stores = new Set<CapturedMediaStore>();
  #captureProbes = 0;
  #restore: (() => void)[] = [];
  readonly #lockFetches: string[] = [];

  /** Counts one mutating call of `service`'s `method`, as it is made. */
  count(service: string, method: string): void {
    const methods = (this.#calls[service] ??= {});
    methods[method] = (methods[method] ?? 0) + 1;
  }

  /** `target`'s members wrapped by `table`: each mutating call counted before it runs; the others pass through. */
  #recorded<T extends object>(
    service: string,
    target: T,
    table: Readonly<Record<string, MemberKind>>,
  ): T {
    assertClassified(service, Object.keys(target), table);
    const wrapped: Record<string, unknown> = {};
    for (const [key, kind] of Object.entries(table)) {
      // EVIDENCE: validation: `assertClassified` checked that `target` has exactly the classified members.
      const member = (target as Record<string, unknown>)[key];
      if (kind === "mutating" && typeof member === "function")
        wrapped[key] = (...args: unknown[]) => {
          this.count(service, key);
          for (const arg of args) if (typeof arg === "string") this.#scopes.add(arg);
          return member.apply(target, args);
        };
      else if (typeof member === "function")
        wrapped[key] = (...args: unknown[]) => member.apply(target, args);
      else wrapped[key] = member;
    }
    // EVIDENCE: validation: `wrapped` has every member of `target`, each of the same type.
    return wrapped as T;
  }

  /** A recorded captured-media repository, as a kept store's `media`. */
  #repository(service: string, repository: CapturedMediaRepository): CapturedMediaRepository {
    const recorded = this.#recorded(service, repository, REPOSITORY);
    const add = recorded.add;
    return {
      ...recorded,
      add: (record) => {
        // Counted first, by the recorded `add`; only then is its input read, which may throw.
        const added = add(record);
        try {
          this.#references.add(String(record.reference));
        } catch {
          // The call is counted; a record whose reference cannot be read is the repository's own failure.
        }
        return added;
      },
    };
  }

  /** The script storage provider the composable writes its saved values through, holding them by value. */
  readonly scriptStorage: ScriptStorageProvider = this.#recorded(
    "scriptStorage",
    {
      scope: "replay",
      load: async () =>
        [...this.#storage].map(([key, value]) => ({ key, value: structuredClone(value) })),
      write: async (key: string, value: SerializableRuntimeValue) => {
        this.#storage.set(key, structuredClone(value));
      },
      replace: async (entries: readonly RuntimeScriptStorageEntrySnapshot[]) => {
        this.#storage.clear();
        for (const { key, value } of entries) this.#storage.set(key, structuredClone(value));
      },
      clear: async () => {
        this.#storage.clear();
      },
    },
    SCRIPT_STORAGE,
  );

  /** The kept-session store, the composable's memory default, recorded. */
  readonly keptSessions: KeptSessionStore = {
    ...this.#recorded("keptSessions", this.#kept, MEMORY_KEPT_SESSIONS),
    media: this.#repository("keptSessions.media", this.#kept.media),
  };

  /** The debug-room store, the composable's memory default, recorded; a room's values are a recorded provider too. */
  readonly debugRooms: KeptRoomStore = (() => {
    const recorded = this.#recorded("debugRooms", this.#rooms, KEPT_ROOMS);
    return {
      ...recorded,
      media: this.#repository("debugRooms.media", this.#rooms.media),
      values: (scope: string) => {
        this.#scopes.add(scope);
        return this.#recorded(
          `debugRooms.values(${scope})`,
          this.#rooms.values(scope),
          SCRIPT_STORAGE,
        );
      },
    };
  })();

  /** Lock services that reach no network: `fetch` is a mutating call that is counted and refused. */
  readonly lockServices: LockServices = this.#recorded(
    "lockServices",
    {
      tlock: () => import("../../player/encryption/time-lock.js"),
      age: () => import("../../player/encryption/age.js"),
      fetch: async (...args: Parameters<typeof fetch>) => {
        this.#lockFetches.push(String(args[0]));
        throw new TypeError("The live host reaches no network.");
      },
      nowMs: () => 0,
    },
    LOCKS,
  );

  /** The composable's options: every recorded service and pure input, and nothing else (`PLAYER_SESSION_OPTIONS`). */
  options<B>(bridge: Promise<B>): LiveHostOptions<B> {
    assertClassified("PlayerSessionOptions", declaredSessionOptions(), {
      ...PLAYER_SESSION_OPTIONS,
      ...NESTED_SESSION_OPTIONS,
    });
    const given: LiveHostOptions<B> = {
      bridge,
      resolveAsset: (path: string) => `https://fixture/${path}`,
      scriptStorage: this.scriptStorage,
      lockServices: this.lockServices,
      decodeImage: async () => ({ width: 1, height: 1 }),
      temporalContext: () => DEFAULT_TEMPORAL_CONTEXT,
      keptSessions: this.keptSessions,
      debugRooms: this.debugRooms,
    };
    assert.deepEqual(
      Object.keys(given).sort(),
      Object.entries(PLAYER_SESSION_OPTIONS)
        .filter(([, given]) => given !== "absent")
        .map(([key]) => key)
        .sort(),
      "the live host gives exactly the options it classifies as given",
    );
    return given;
  }

  /** A fake `Audio` class whose elements keep `MediaDeviceElement`'s state, every mutating member counted. */
  audio(): new () => FakeMedium {
    const count = (member: string) => this.count("Audio", member);
    const elements = this.#elements;
    return class FakeAudio extends EventTarget {
      #state = {
        src: "",
        preload: "",
        volume: 1,
        currentTime: 0,
        duration: 9,
        paused: true,
        ended: false,
        loaded: false,
      };
      #listeners = new Map<string, number>();
      constructor() {
        super();
        count("construct");
        // EVIDENCE: validation: the element is this fake, with every member `MediaDeviceElement` declares.
        elements.push(this);
      }
      get src() {
        return this.#state.src;
      }
      set src(value: string) {
        // A set counts only when it changes the value: a no-op set is no effect, and the state shows any real change.
        if (value !== this.#state.src) count("src");
        this.#state.src = value;
      }
      get preload() {
        return this.#state.preload;
      }
      set preload(value: string) {
        // A set counts only when it changes the value: a no-op set is no effect, and the state shows any real change.
        if (value !== this.#state.preload) count("preload");
        this.#state.preload = value;
      }
      get volume() {
        return this.#state.volume;
      }
      set volume(value: number) {
        // A set counts only when it changes the value: a no-op set is no effect, and the state shows any real change.
        if (value !== this.#state.volume) count("volume");
        this.#state.volume = value;
      }
      get currentTime() {
        return this.#state.currentTime;
      }
      set currentTime(value: number) {
        // A set counts only when it changes the value: a no-op set is no effect, and the state shows any real change.
        if (value !== this.#state.currentTime) count("currentTime");
        this.#state.currentTime = value;
      }
      get duration() {
        return this.#state.duration;
      }
      get paused() {
        return this.#state.paused;
      }
      get ended() {
        return this.#state.ended;
      }
      play = async () => {
        count("play");
        // A play leaves the medium playing, as a real element does.
        this.#state.paused = false;
      };
      pause() {
        count("pause");
        this.#state.paused = true;
      }
      load() {
        count("load");
      }
      removeAttribute(name: string) {
        count("removeAttribute");
        if (name === "src") this.#state.src = "";
      }
      override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean,
      ) {
        count("addEventListener");
        this.#listeners.set(type, (this.#listeners.get(type) ?? 0) + 1);
        super.addEventListener(type, listener, options);
      }
      override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean,
      ) {
        count("removeEventListener");
        this.#listeners.set(type, (this.#listeners.get(type) ?? 0) - 1);
        super.removeEventListener(type, listener, options);
      }
      override dispatchEvent(event: Event): boolean {
        count("dispatchEvent");
        if (event.type === "loadedmetadata") this.#state.loaded = true;
        return super.dispatchEvent(event);
      }
      /** The element's state, by value. */
      get state() {
        return { ...this.#state, listeners: Object.fromEntries(this.#listeners) };
      }
      static {
        assertClassified(
          "MediaDeviceElement",
          [
            ...Object.getOwnPropertyNames(FakeAudio.prototype).filter(
              (name) => name !== "constructor" && name !== "state",
            ),
            "play",
          ],
          { ...MEDIA_ELEMENT, dispatchEvent: "mutating" },
        );
      }
    };
  }

  /** An `EventTarget` standing in for `document` or `window`, its listeners and dispatches counted. */
  eventTarget<T extends object>(name: string, extra: T): EventTarget & T {
    const count = (member: string) => this.count(name, member);
    const listeners = new Map<string, number>();
    this.#listeners.set(name, listeners);
    class Recorded extends EventTarget {
      override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: AddEventListenerOptions | boolean,
      ) {
        count("addEventListener");
        listeners.set(type, (listeners.get(type) ?? 0) + 1);
        super.addEventListener(type, listener, options);
      }
      override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: EventListenerOptions | boolean,
      ) {
        count("removeEventListener");
        listeners.set(type, (listeners.get(type) ?? 0) - 1);
        super.removeEventListener(type, listener, options);
      }
      override dispatchEvent(event: Event): boolean {
        count("dispatchEvent");
        return super.dispatchEvent(event);
      }
    }
    return Object.assign(new Recorded(), extra);
  }

  /**
   * Records what the composable makes itself: the captured-media store (its class's methods, from the Player bundle),
   * the object URLs it creates and revokes, and every probe of the browser's capture devices, which this host does not
   * have. `uninstall()` restores them.
   */
  install(captureStore: { prototype: CapturedMediaStore }): void {
    const prototype = captureStore.prototype;
    assertClassified(
      "CapturedMediaStore",
      Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor"),
      CAPTURE_STORE,
    );
    const stores = this.#stores;
    const references = this.#references;
    const count = (member: string) => this.count("CapturedMediaStore", member);
    for (const [name, kind] of Object.entries(CAPTURE_STORE)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name)!;
      if (typeof descriptor.value !== "function") continue;
      const method: unknown = descriptor.value;
      if (typeof method !== "function") continue;
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value: function (this: CapturedMediaStore, ...args: unknown[]) {
          stores.add(this);
          if (kind === "mutating") count(name);
          for (const arg of args) if (typeof arg === "string") references.add(arg);
          const result: unknown = method.apply(this, args);
          if (
            name === "add" &&
            result !== null &&
            typeof result === "object" &&
            "reference" in result
          )
            references.add(String(result.reference));
          return result;
        },
      });
      this.#restore.push(() => Object.defineProperty(prototype, name, descriptor));
    }
    const { createObjectURL, revokeObjectURL } = URL;
    const urls = this.#urls;
    URL.createObjectURL = (data: Blob | MediaSource) => {
      this.count("URL", "create");
      const url = `blob:live-host/${urls.size + 1}`;
      if (data instanceof Blob) urls.set(url, data);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      this.count("URL", "revoke");
      urls.delete(url);
    };
    assertClassified("CapturedMediaUrls", ["create", "revoke"], URLS);
    this.#restore.push(() => {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    });
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const real: object = globalThis.navigator ?? {};
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: new Proxy(real, {
        has: (target, key) => {
          if (key === "mediaDevices") this.#captureProbes++;
          return Reflect.has(target, key);
        },
        get: (target, key) => {
          if (key === "mediaDevices") this.#captureProbes++;
          // EVIDENCE: validation: `navigator` is an object; a missing member reads as `undefined`, as on the real one.
          return (target as Record<PropertyKey, unknown>)[key];
        },
      }),
    });
    this.#restore.push(() => {
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      else Reflect.deleteProperty(globalThis, "navigator");
    });
  }

  uninstall(): void {
    for (const restore of this.#restore.splice(0).reverse()) restore();
  }

  /** Every service's state, by value, read through its own methods, which count nothing, with every call counted so far. */
  async sample(): Promise<EffectSample> {
    const scopes = [...this.#scopes].sort();
    const references = [...this.#references].sort();
    const kept = await Promise.all(
      scopes.map(async (scope) => [scope, await plain(await this.#kept.session(scope))]),
    );
    const rooms = await Promise.all(
      scopes.map(async (scope) => {
        const room = await this.#rooms.read(scope).catch(() => null);
        return [
          scope,
          room === null
            ? null
            : {
                room,
                session: await plain(await this.#rooms.session(scope)),
                values: await this.#rooms.values(scope).load(),
              },
        ];
      }),
    );
    const media = async (repository: CapturedMediaRepository) =>
      Promise.all(
        scopes.map(async (scope) => [
          scope,
          await Promise.all(
            (await repository.listReferences(scope)).map(async (reference) => [
              reference,
              await plain(await repository.get(scope, reference)),
            ]),
          ),
        ]),
      );
    const stores = await Promise.all(
      [...this.#stores].map(async (store) => ({
        size: store.size,
        known: references.filter((reference) => store.knows(reference)),
        records: await plain(store.sessionRecords(references)),
      })),
    );
    return {
      calls: structuredClone(this.#calls),
      state: await plain({
        storage: [...this.#storage].sort(([a], [b]) => (a < b ? -1 : 1)),
        kept,
        keptMedia: await media(this.#kept.media),
        rooms,
        roomMedia: await media(this.#rooms.media),
        captureStores: stores,
        elements: this.#elements.map((element) => element.state),
        urls: await Promise.all(
          [...this.#urls].map(async ([url, blob]) => [url, await blobValue(blob)]),
        ),
        eventTargets: Object.fromEntries(
          [...this.#listeners].map(([name, listeners]) => [name, Object.fromEntries(listeners)]),
        ),
        lockFetches: [...this.#lockFetches],
        captureProbes: this.#captureProbes,
        absent: Object.entries(PLAYER_SESSION_OPTIONS)
          .filter(([, given]) => given === "absent")
          .map(([key]) => key),
      }),
    };
  }

  /** The elements the composable made, in order. */
  get elements(): readonly FakeMedium[] {
    return this.#elements;
  }
}
