import type { CapturedMediaRepository } from "../media/captured-media.js";
import type { KeptRoomStore, KeptSessionStore } from "./kept-sessions.js";
import type { ScriptStorageProvider } from "./script-storage.js";

/*
 * The ownership of one persistence operation of the Player's session host (`vue/src/session/usePlayerSession.ts`): a keep, the
 * kept session's restore for Continue, a session import (L5h.1), a saved-data import (L5h.2). The host makes one when an
 * operation begins; `current` is the one rule that says whether the operation still owns its room, store, plan tenure
 * and preparation, and once it is false it stays false (`retireIfStale`).
 *
 * The operation reaches its stores only through the ownership's handles, also inside the helpers it calls, such as
 * the captured-media wrapper of the saved values. A handle admits each call of a store method only while the operation
 * is current, checked when the call is made; a refused call never reaches the store and ends the operation
 * (`StaleOperation`). An admitted call runs to its end as the store makes it, also after the operation went stale. Every
 * page effect is applied synchronously through `commit`.
 */

export interface PersistenceOwnership {
  /** Whether the operation still owns the room, store, plan tenure and preparation it began in. */
  current(): boolean;
  /** Ends the operation without effect (`StaleOperation`) once it no longer owns them. */
  check(): void;
  /**
   * Ends the operation for good if, and only if, it no longer owns them; a current one stays current. The host calls it
   * where it retires operations, so a state that changes back cannot make a stale operation current again.
   */
  retireIfStale(): void;
  /**
   * Checks once, before a synchronous `apply`, then runs it; no rollback. A stale operation ends like `check`, and
   * `apply` does not run. `apply` must not await: what it did after its first await would escape the check. Its type
   * refuses a result that is or may be a thenable (a union with one included), and a thenable also throws at run time.
   */
  commit<T>(
    apply: () => T & ([Extract<T, PromiseLike<unknown>>] extends [never] ? unknown : never),
  ): T;
  /** Makes `call` while the operation owns them, such as a request to the host; else ends it like `check`. */
  admit<T>(call: () => T): T;
  /** The saved values of `provider`, each call admitted. */
  values(provider: ScriptStorageProvider): ScriptStorageProvider;
  /** The photos of `repository`, each call admitted. */
  photos(repository: CapturedMediaRepository): CapturedMediaRepository;
  /** The kept sessions of `store`, with their photos, each call admitted. */
  kept(store: KeptSessionStore): KeptSessionStore;
  /** The debug rooms of `store`, with their sessions, saved values and photos, each call admitted. */
  rooms(store: KeptRoomStore): KeptRoomStore;
}

/** A stale persistence operation's end: whoever ran it catches it and does nothing more. */
export class StaleOperation extends Error {
  override readonly name = "StaleOperation";
  constructor() {
    super("The operation's room, plan or preparation moved on.");
  }
}

/** The ownership whose rule is `owns`, until it first fails. */
export function persistenceOwnership(owns: () => boolean): PersistenceOwnership {
  let revoked = false;
  const current = () => {
    if (!revoked && !owns()) revoked = true;
    return !revoked;
  };
  const check = () => {
    if (!current()) throw new StaleOperation();
  };
  const admit = <T>(call: () => T): T => {
    check();
    return call();
  };
  const values = (provider: ScriptStorageProvider): ScriptStorageProvider => ({
    scope: provider.scope,
    load: () => admit(() => provider.load()),
    write: (key, value) => admit(() => provider.write(key, value)),
    replace: (entries) => admit(() => provider.replace(entries)),
    clear: () => admit(() => provider.clear()),
  });
  const photos = (repository: CapturedMediaRepository): CapturedMediaRepository => ({
    get: (namespace, reference) => admit(() => repository.get(namespace, reference)),
    add: (record) => admit(() => repository.add(record)),
    delete: (namespace, reference) => admit(() => repository.delete(namespace, reference)),
    listReferences: (namespace) => admit(() => repository.listReferences(namespace)),
  });
  const kept = (store: KeptSessionStore): KeptSessionStore => ({
    session: (scope) => admit(() => store.session(scope)),
    publish: (scope, session) => admit(() => store.publish(scope, session)),
    discard: (scope) => admit(() => store.discard(scope)),
    media: photos(store.media),
  });
  return {
    current,
    check,
    retireIfStale: () => void current(),
    commit(apply) {
      check();
      const applied = apply();
      if (thenable(applied))
        throw new TypeError("A persistence operation's commit takes a synchronous apply.");
      return applied;
    },
    admit,
    values,
    photos,
    kept,
    rooms: (store) => ({
      ...kept(store),
      read: (scope) => admit(() => store.read(scope)),
      create: (scope, entries, records) => admit(() => store.create(scope, entries, records)),
      values: (scope) => values(admit(() => store.values(scope))),
      discardSession: (scope) => admit(() => store.discardSession(scope)),
    }),
  };
}

const thenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";
