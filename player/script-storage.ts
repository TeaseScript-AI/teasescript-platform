import {
  upgradeStoredScriptValues,
  validateScriptStorageEntries,
  type RuntimeScriptStorageEntrySnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/checkpoint.js";

/**
 * Persistent script storage for TeaseScript `save`, `load`, and `delete` in one storage scope. The host chooses the
 * scope: it must be stable across runs of the same script and distinguish players that share a browser. Values are
 * ordinary TeaseScript values; this boundary never interprets them, so a layer such as durable captured media can wrap
 * a provider. Operations are asynchronous, so a later server-backed provider fits the same boundary.
 */
export interface ScriptStorageProvider {
  readonly scope: string;
  /** A complete, fresh view of the scope; it rejects when storage cannot be used and never reports that as empty. */
  load(): Promise<readonly RuntimeScriptStorageEntrySnapshot[]>;
  /** Resolves once the write is persisted; a `null` value removes the key, like `save null`. Rejects otherwise. */
  write(key: string, value: SerializableRuntimeValue): Promise<void>;
  /**
   * Replaces every value of the scope with `entries` at once: a later `load` returns exactly them, or, when this
   * rejects, the previous values. Rejects with a `TypeError` when `entries` are not valid script storage.
   */
  replace(entries: readonly RuntimeScriptStorageEntrySnapshot[]): Promise<void>;
  /** Removes every value of the scope at once; resolves once done. */
  clear(): Promise<void>;
}

const ITEM_PREFIX = "player-storage:";
const HEAD_PREFIX = "player-storage-head:";
const GENERATION_PREFIX = "player-storage-generation:";
const PAYLOAD_VERSION = 1;
const GENERATION_PATTERN = /^[0-9a-f]{32}$/u;

/**
 * A provider backed by browser local storage, one item per key, holding `{ v: 1, value }`. Until the scope is first
 * replaced or cleared, items use the original layout: the name `player-storage:` plus the JSON array `[scope, key]`,
 * which represents every string losslessly. A replacement stages its values as a new generation, named
 * `player-storage-generation:` plus `[scope, generation, key]`, and then publishes it with one write of the head item
 * `player-storage-head:` plus the JSON scope, holding `{ v: 1, generation }`; from then on only that generation's
 * items are the scope's values, so a failed replacement never shows half of it. Each operation runs synchronously in
 * one task; after publishing, a replacement attempts to remove only the generation it displaced. Other tabs are not
 * coordinated. Unreadable items are skipped; an unreadable head
 * rejects every operation but a replacement, so values of an older generation never reappear. Pass `undefined` when
 * the browser denies storage; every operation then rejects.
 */
export function createLocalScriptStorage(
  storage: Storage | undefined,
  scope: string,
): ScriptStorageProvider {
  const headName = HEAD_PREFIX + JSON.stringify(scope);
  const usable = (): Storage => {
    if (!storage) throw new Error("Browser storage is unavailable.");
    return storage;
  };
  // The published generation, or `null` for the original layout.
  const head = (store: Storage): string | null => {
    const raw = store.getItem(headName);
    if (raw === null) return null;
    const generation = parseHead(raw);
    if (generation === null) throw new Error("The saved script data is unreadable.");
    return generation;
  };
  const itemName = (generation: string | null, key: string): string =>
    generation === null
      ? ITEM_PREFIX + JSON.stringify([scope, key])
      : GENERATION_PREFIX + JSON.stringify([scope, generation, key]);
  // The items of one generation, or of the original layout for `null`.
  const items = (
    store: Storage,
    generation: string | null,
  ): readonly { readonly name: string; readonly key: string }[] => {
    const found = [];
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      const parsed = name === null ? null : parseItemName(name);
      if (parsed !== null && parsed.scope === scope && parsed.generation === generation)
        found.push({ name: name!, key: parsed.key });
    }
    return found;
  };
  const replace = (entries: readonly RuntimeScriptStorageEntrySnapshot[]): void => {
    const failure = validateScriptStorageEntries(entries, "entries");
    if (failure !== null) throw new TypeError(failure);
    const store = usable();
    let displaced: string | null | undefined;
    try {
      displaced = head(store);
    } catch {
      // A replacement repairs an unreadable head; the generation it named is unknown, so nothing is removed.
      displaced = undefined;
    }
    const generation = randomGeneration();
    const staged: string[] = [];
    try {
      for (const { key, value } of entries) {
        const name = itemName(generation, key);
        store.setItem(name, payload(value));
        staged.push(name);
      }
      store.setItem(headName, JSON.stringify({ v: PAYLOAD_VERSION, generation }));
    } catch (error) {
      // Nothing refers to an unpublished generation, so removing it cannot affect any reader.
      for (const name of staged) store.removeItem(name);
      throw error;
    }
    // The values are replaced; failing to reclaim the displaced items only leaves them unused.
    try {
      if (displaced !== undefined)
        for (const item of items(store, displaced)) store.removeItem(item.name);
    } catch {
      // Unused items are never read again.
    }
  };

  return {
    scope,
    load: async () => {
      const store = usable();
      const entries: RuntimeScriptStorageEntrySnapshot[] = [];
      for (const item of items(store, head(store))) {
        const value = parsePayload(store.getItem(item.name));
        if (value !== undefined) entries.push({ key: item.key, value });
      }
      return entries;
    },
    write: async (key, value) => {
      const store = usable();
      const name = itemName(head(store), key);
      // A quota or denial error rejects, so the runtime keeps the previous value.
      if (value === null) store.removeItem(name);
      else store.setItem(name, payload(value));
    },
    replace: async (entries) => replace(entries),
    clear: async () => replace([]),
  };
}

/** The stored item of a value, written without recursion so that any value a script can save is stored. */
function payload(value: SerializableRuntimeValue): string {
  return serializeValidatedRuntimeJson({ v: PAYLOAD_VERSION, value });
}

/**
 * The scopes whose items browser local storage holds, in name order: every script this browser keeps saved data for,
 * though some may hold no values now. Rejects when the browser denies storage.
 */
export function listLocalScriptStorageScopes(storage: Storage | undefined): readonly string[] {
  if (!storage) throw new Error("Browser storage is unavailable.");
  const scopes = new Set<string>();
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index);
    if (name === null) continue;
    const item = parseItemName(name);
    if (item !== null) scopes.add(item.scope);
    else if (name.startsWith(HEAD_PREFIX)) {
      try {
        const scope: unknown = JSON.parse(name.slice(HEAD_PREFIX.length));
        if (typeof scope === "string" && name === HEAD_PREFIX + JSON.stringify(scope))
          scopes.add(scope);
      } catch {
        // Not an item of this provider.
      }
    }
  }
  return [...scopes].sort();
}

function randomGeneration(): string {
  // `crypto.randomUUID()` exists only in secure contexts; `crypto.getRandomValues()` exists everywhere.
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The generation a head item names, or `null` when it is unreadable. */
function parseHead(raw: string): string | null {
  let head: unknown;
  try {
    head = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof head !== "object" ||
    head === null ||
    Array.isArray(head) ||
    Object.keys(head).length !== 2 ||
    !Object.hasOwn(head, "v") ||
    !Object.hasOwn(head, "generation")
  )
    return null;
  // EVIDENCE: validation: the guard above proved a plain object with exactly own v and generation fields.
  const { v, generation } = head as { v: unknown; generation: unknown };
  return v === PAYLOAD_VERSION &&
    typeof generation === "string" &&
    GENERATION_PATTERN.test(generation)
    ? generation
    : null;
}

function parseItemName(
  name: string,
): { readonly scope: string; readonly generation: string | null; readonly key: string } | null {
  const generational = name.startsWith(GENERATION_PREFIX);
  if (!generational && !name.startsWith(ITEM_PREFIX)) return null;
  const prefix = generational ? GENERATION_PREFIX : ITEM_PREFIX;
  try {
    const parsed: unknown = JSON.parse(name.slice(prefix.length));
    // Only the exact name this provider writes counts; an alias such as one with extra spaces is ignored, so it can
    // neither duplicate a key nor survive the key's removal.
    if (
      !Array.isArray(parsed) ||
      parsed.length !== (generational ? 3 : 2) ||
      !parsed.every((part) => typeof part === "string") ||
      name !== prefix + JSON.stringify(parsed)
    )
      return null;
    // EVIDENCE: validation: the guard above proved an array of two or three strings.
    const parts = parsed as string[];
    return generational
      ? { scope: parts[0]!, generation: parts[1]!, key: parts[2]! }
      : { scope: parts[0]!, generation: null, key: parts[1]! };
  } catch {
    return null;
  }
}

/** The stored value, or `undefined` for an unreadable or foreign item, including a stored `null`. */
function parsePayload(raw: string | null): SerializableRuntimeValue | undefined {
  if (raw === null) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 2 ||
    !Object.hasOwn(payload, "v") ||
    !Object.hasOwn(payload, "value")
  ) {
    return undefined;
  }
  // EVIDENCE: validation: the guard above proved a plain object with exactly own v and value fields.
  const { v, value } = payload as { v: unknown; value: unknown };
  if (v !== PAYLOAD_VERSION) return undefined;
  upgradeStoredScriptValues(value);
  if (validateScriptStorageEntries([{ key: "", value }], "value") !== null) return undefined;
  // EVIDENCE: validation: validateScriptStorageEntries accepted this value as a storable, non-null entry value.
  return value as SerializableRuntimeValue;
}
