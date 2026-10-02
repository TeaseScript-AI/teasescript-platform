import {
  validateScriptStorageEntries,
  type RuntimeScriptStorageEntrySnapshot,
  type SerializableRuntimeValue,
} from "../src/index.js";

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
  /** Removes every value of the scope; resolves once done. */
  clear(): Promise<void>;
}

const ITEM_PREFIX = "player-storage:";
const PAYLOAD_VERSION = 1;

/**
 * A provider backed by browser local storage, one item per key. The item name encodes `[scope, key]` as JSON, which
 * represents every string losslessly; the item holds `{ v: 1, value }`. Unreadable items are skipped. Pass
 * `undefined` when the browser denies storage; every operation then rejects.
 */
export function createLocalScriptStorage(
  storage: Storage | undefined,
  scope: string,
): ScriptStorageProvider {
  const usable = (): Storage => {
    if (!storage) throw new Error("Browser storage is unavailable.");
    return storage;
  };
  const scopeItems = (
    store: Storage,
  ): readonly { readonly name: string; readonly key: string }[] => {
    const items = [];
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      const parsed = name === null ? null : parseItemName(name);
      if (parsed !== null && parsed.scope === scope) items.push({ name: name!, key: parsed.key });
    }
    return items;
  };

  return {
    scope,
    load: async () => {
      const store = usable();
      const entries: RuntimeScriptStorageEntrySnapshot[] = [];
      for (const item of scopeItems(store)) {
        const value = parsePayload(store.getItem(item.name));
        if (value !== undefined) entries.push({ key: item.key, value });
      }
      return entries;
    },
    write: async (key, value) => {
      const store = usable();
      const name = ITEM_PREFIX + JSON.stringify([scope, key]);
      // A quota or denial error rejects, so the runtime keeps the previous value.
      if (value === null) store.removeItem(name);
      else store.setItem(name, JSON.stringify({ v: PAYLOAD_VERSION, value }));
    },
    clear: async () => {
      const store = usable();
      for (const item of scopeItems(store)) store.removeItem(item.name);
    },
  };
}

function parseItemName(name: string): { readonly scope: string; readonly key: string } | null {
  if (!name.startsWith(ITEM_PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(name.slice(ITEM_PREFIX.length));
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
      ? { scope: parsed[0], key: parsed[1] }
      : null;
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
  if (validateScriptStorageEntries([{ key: "", value }], "value") !== null) return undefined;
  // EVIDENCE: validation: validateScriptStorageEntries accepted this value as a storable, non-null entry value.
  return value as SerializableRuntimeValue;
}
