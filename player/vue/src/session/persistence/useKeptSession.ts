import { watch, type Ref } from "vue";
import { useEventListener } from "@vueuse/core";
import {
  insertOrAcceptExisting,
  type CapturedMediaStore,
  type StoredCapturedMedia,
} from "../../../../captured-media.js";
import {
  capturedMediaReferencesIn,
  keptSession,
  memoryKeptSessionStore,
  type KeptSessionStore,
} from "../../../../kept-sessions.js";
import { activePlayerRuntimeInteraction, type PlayerSession } from "../../../../runtime-view.js";
import { bridgeOf, endsQuietly, type PlayerBridge } from "../../../../player-bridge.js";
import { BridgeRequestError } from "../../../../engine-bridge/client.js";
import type { KeepCapture } from "../../../../engine-bridge/ops/persistence.js";
import {
  StaleOperation,
  persistenceOwnership as ownershipOf,
  type PersistenceOwnership,
} from "../../../../persistence-ownership.js";
import {
  EMPTY_PLAN_JSON_LEASE,
  settle,
  type PlanJsonEvent,
  type PlanJsonLease,
} from "../../../../plan-json-lease.js";
import { playerNoticeKeys, playerNotices, type PlayerNotices } from "../../../../notices.js";
import {
  serializeValidatedRuntimeJson,
  type CheckpointErrorInfo,
} from "../../../../../src/runtime/snapshot/checkpoint-json.js";
import { INSTRUCTION_PLAN_VERSION } from "../../../../../src/plan/model.js";
import { RUNTIME_SNAPSHOT_VERSION } from "../../../../../src/runtime/snapshot/snapshot-format.js";
import type { InterpreterEvent } from "../../../../../src/index.js";
import type {
  DebugRewoundWhileDebugging,
  DebugEditedWhileDebugging,
} from "../../../../debug-export.js";
import type { Problem } from "../../ProblemCard.vue";
import type { PlayerSessionOptions, PlayerSessionStart } from "../../usePlayerSession.js";
import type { useRuntimeSceneClock } from "../../useRuntimeSceneClock";
import type { useStorageRoute } from "./useStorageRoute.js";

/*
 * The script's kept session, which a reload or a later visit continues, moved from `usePlayerSession` unchanged: the
 * persistence operations' ownership and the plan JSON's lease, the keep, the kept session's restore for Continue, and
 * the preparations that show Start or Continue.
 */

/** What the kept session needs from the Player's session composable. */
interface KeptSessionHost {
  readonly options: PlayerSessionOptions;
  /** The engine's host now, or `null` before it is ready. */
  readonly bridgeNow: () => PlayerBridge | null;
  readonly bridgeReady: Promise<PlayerBridge>;
  readonly isDisposed: () => boolean;
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly capturedMedia: CapturedMediaStore;
  readonly notices: PlayerNotices;
  readonly route: ReturnType<typeof useStorageRoute>;
  readonly room: Readonly<Ref<"normal" | "debug">>;
  readonly debugRoom: Ref<{ readonly session: boolean } | null>;
  readonly debugEdits: Readonly<Ref<DebugEditedWhileDebugging | null>>;
  readonly inspecting: Readonly<Ref<boolean>>;
  readonly rewound: Readonly<Ref<DebugRewoundWhileDebugging | null>>;
  readonly activation: Readonly<Ref<unknown>>;
  readonly endSession: () => void;
  readonly prepareStart: (create: PlayerSessionStart, outdated?: Problem) => void;
  readonly prepareRestore: (given: PlayerSession) => void;
  /** The latest Start, made after this owner. */
  readonly lastStart: () => Readonly<Ref<PlayerSessionStart | null>>;
  /** Remembers the Start a preparation of the script offers, and the source text of its files. */
  readonly remember: (create: PlayerSessionStart, sources?: ReadonlyMap<string, string>) => void;
  /** The scene clock, made after this owner. */
  readonly clock: () => ReturnType<typeof useRuntimeSceneClock>;
  /** A failed store call's fallback, unless the call was refused as stale (`useSavedValues`). */
  readonly rejectedUnlessStale: <T>(fallback: T) => (error: unknown) => T;
}

export function useKeptSession({
  options,
  bridgeNow,
  bridgeReady,
  isDisposed,
  session,
  capturedMedia,
  notices,
  route,
  room,
  debugRoom,
  debugEdits,
  inspecting,
  rewound,
  activation,
  endSession,
  prepareStart,
  prepareRestore,
  lastStart,
  remember,
  clock,
  rejectedUnlessStale,
}: KeptSessionHost) {
  // The kept-session preparation under way (`prepareScript`, `prepareKept`). A later preparation, and every transition
  // that replaces what it would show, retires it: Start, Continue, a session's end (`supersede`), an import of the shown
  // script, a room change, unmount. Only the current one shows its Continue or Start and puts its photos back.
  let preparation = 0;
  // The persistence operations under way (`persistenceOwnership`), each revoked for good where it retires.
  const pendingOwnerships = new Set<PersistenceOwnership>();
  /** Ends every persistence operation the page's change of room, store, plan tenure, preparation or life retired. */
  function retireStaleOperations() {
    for (const ownership of pendingOwnerships) ownership.retireIfStale();
  }
  /** A new preparation, which retires the ones before it. */
  function nextPreparation(): number {
    preparation += 1;
    retireStaleOperations();
    return preparation;
  }
  watch(room, retireStaleOperations, { flush: "sync" });
  // The script's kept session, which a reload or a later visit continues (PLAYER-UI "Session start and user
  // activation"); only a script with storage keeps one, under its storage scope. The debug room keeps its own.
  let keptSessions: KeptSessionStore;
  let keptScope: string | null;
  const keptStore = (): KeptSessionStore =>
    room.value === "debug" ? route.debugRoomsNow() : keptSessions;
  // The host's token of the script's plan, which a kept session runs.
  let scriptPlan: string | null = null;
  // What is kept of the shown session, so that keeping it again adds only the events after it: whether the plan is kept,
  // and how many events, the last of which is `last`. A new session starts with none.
  let kept: {
    readonly plan: boolean;
    readonly count: number;
    readonly last: InterpreterEvent | null;
  } = { plan: false, count: 0, last: null };
  let keeping: Promise<void> | null = null;
  let keepAgain = false;
  // How long the host holds the JSON of the script's plan, which a new session's first save stores and a Continue
  // compares: for the current plan while this page is open; the host writes it in a task of its own before Start
  // (#1707), and every reader borrows it (`plan-json-lease.ts`). Only `settlePlanJson` changes it.
  let planJsonLease: PlanJsonLease;
  // Each different plan the page prepares begins a tenure: what an operation of an earlier one finds no longer goes on.
  let planTenure = 0;
  /**
   * One persistence operation's ownership (keep, the kept session's restore, an import): the room, store, plan tenure
   * and, where it has one, the preparation it began in. `current` is the one rule for every such operation: once the page
   * closes, switches room or store, prepares another plan, or (with a preparation) a newer preparation begins, the
   * operation is stale for good. A stale operation issues nothing more: it reaches its stores and the host only through
   * the ownership's handles, which admit no call once it is stale, and applies every page effect synchronously through
   * `commit`.
   */
  function persistenceOwnership(owner: number | null = null): PersistenceOwnership {
    const inRoom = room.value;
    const store = keptStore();
    const tenure = planTenure;
    const ownership = ownershipOf(
      () =>
        !isDisposed() &&
        room.value === inRoom &&
        keptStore() === store &&
        planTenure === tenure &&
        (owner === null || owner === preparation),
    );
    pendingOwnerships.add(ownership);
    return ownership;
  }
  /**
   * Runs `operation` of `ownership`, which ends without effect where its ownership went stale; resolves to whether it ran
   * to its end.
   */
  async function owned(
    ownership: PersistenceOwnership,
    operation: () => Promise<void>,
  ): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch (error) {
      if (!(error instanceof StaleOperation)) throw error;
      return false;
    } finally {
      pendingOwnerships.delete(ownership);
    }
  }
  /** Settles `event` in the lease and posts the host messages it implies, on the connection the page has. */
  function settlePlanJson(event: PlanJsonEvent): void {
    const settled = settle(planJsonLease, event);
    if (settled.lease.current !== planJsonLease.current) planTenure += 1;
    planJsonLease = settled.lease;
    retireStaleOperations();
    for (const message of settled.messages) {
      const op = message.kind === "write" ? "preparePlanText" : "releasePlanText";
      void bridgeNow()
        ?.client.request(op, { plan: message.plan })
        .catch(() => {});
    }
  }
  /**
   * Keeps the shown session, where a reload continues it, together with the photos only it uses. One write runs at a
   * time; a request meanwhile keeps the session as it is once that is done. A state Debug's rewind shows for inspection
   * is never kept: the session it left is.
   */
  function keepSessionLater() {
    if (keeping !== null) {
      keepAgain = true;
      return;
    }
    keeping = (async () => {
      // The caller finishes first, such as a Continue that shows the session it keeps.
      await Promise.resolve();
      try {
        do {
          keepAgain = false;
          await keepOnce();
        } while (keepAgain && !isDisposed());
      } finally {
        // In the same step as the last check, so a request after it starts a new write instead of being lost.
        keeping = null;
      }
    })();
  }
  async function keepOnce() {
    const current = session.value;
    // Only a script a host prepared with `prepareScript` keeps its session.
    if (keptScope === null || scriptPlan === null || current === null || isDisposed()) return;
    if (inspecting.value || activation.value !== null) return;
    // The session is kept in the room and store it plays in now, of the plan tenure now.
    const ctx = persistenceOwnership();
    await owned(ctx, () => keepIn(ctx, current, keptScope!));
  }
  async function keepIn(ctx: PersistenceOwnership, current: PlayerSession, scope: string) {
    // The session's events: its store's, which a capture's events end in.
    const events = current.events;
    const from =
      kept.count <= events.length && (kept.count === 0 || events[kept.count - 1] === kept.last)
        ? kept.count
        : 0;
    const withPlan = !(kept.plan && from > 0);
    const inDebugRoom = room.value === "debug";
    const store = ctx.kept(keptStore());
    // The state the host holds now, after the session's earlier requests, and for a first save the plan's JSON, which
    // the host holds for the page (`plan-json-lease.ts`); later operations change the session.
    let capture: KeepCapture;
    try {
      capture = await ctx.admit(() =>
        bridgeOf(current).read(current, "captureKeep", {
          plan: withPlan ? current.planToken : null,
        }),
      );
    } catch (error) {
      // A request the Worker's loss ended keeps the point kept before.
      if (endsQuietly(error)) return;
      ctx.check();
      await forgetKeptSession(current, ctx);
      return;
    }
    ctx.check();
    // The host no longer holds the session: the point kept before stays.
    if (capture.kind === "gone") return;
    if (capture.kind === "unkeepable") {
      // A state this browser cannot write, such as one holding a list too long to save, cannot be kept, and the point kept
      // before must not stand in for it: a reload would go on from an earlier state as if it were this one.
      await forgetKeptSession(current, ctx);
      return;
    }
    const { snapshotJson, planJson } = capture;
    const count = capture.eventsThrough;
    if (count > events.length || (withPlan && planJson === null)) return;
    const added = events.slice(from, count);
    const last = events[count - 1] ?? null;
    const marks = { editedWhileDebugging: debugEdits.value, rewoundWhileDebugging: rewound.value };
    // Written once, for the photos they show and for the store.
    const eventsJson = added.map(serializeValidatedRuntimeJson);
    const references = capturedMediaReferencesIn(snapshotJson, eventsJson);
    // The room's saved data are in use once storage reached it.
    await route.storageRouteNow();
    ctx.check();
    try {
      // A new session replaces the one kept before.
      if (from === 0) {
        await discardKeptSession(ctx, inDebugRoom);
        if (inDebugRoom) ctx.commit(() => (debugRoom.value = { session: false }));
      }
      ctx.check();
      // The session is kept only with every photo it uses: one that cannot be stored keeps the session kept before.
      if (inDebugRoom) {
        // The debug room stores the session's photos like its saved ones.
        await capturedMedia.promote(references, ctx);
        ctx.check();
      } else {
        // The photos no save stored go with the session, a photo already kept as it is; a stored one stays stored
        // while the session uses it (`capturedMediaStorage`).
        for (const photo of capturedMedia.sessionRecords(references)) {
          await insertOrAcceptExisting(store.media, photo);
          ctx.check();
        }
      }
      await store.publish(scope, {
        planJson: withPlan ? planJson : null,
        snapshotJson,
        eventsFrom: from,
        events: added,
        eventsJson,
        marks,
      });
    } catch (error) {
      if (error instanceof StaleOperation) throw error;
      // The session kept before stays; a reload continues from there.
      return;
    }
    // A publish already under way finishes in its store; a later operation's bookkeeping is its own.
    ctx.commit(() => {
      kept = { plan: true, count, last };
      if (inDebugRoom) debugRoom.value = { session: true };
      notices.dismiss(playerNoticeKeys.sessionNotKept);
    });
  }
  /**
   * Discards the session kept for a reload when its state `current` cannot be kept, so the next state that can be is kept
   * anew; while the session runs or waits, a notice says that a reload would lose it.
   */
  async function forgetKeptSession(current: PlayerSession, ctx: PersistenceOwnership) {
    const inDebugRoom = room.value === "debug";
    ctx.commit(() => (kept = { plan: false, count: 0, last: null }));
    const discarded = await discardKeptSession(ctx, inDebugRoom).then(
      () => true,
      () => false,
    );
    const live = current.state.status === "running" || current.state.status === "waiting";
    ctx.commit(() => {
      if (discarded && inDebugRoom) debugRoom.value = { session: false };
      if (!live) notices.dismiss(playerNoticeKeys.sessionNotKept);
      else if (!notices.list.some((notice) => notice.key === playerNoticeKeys.sessionNotKept))
        notices.publish(playerNotices.sessionNotKept());
    });
  }
  /**
   * Discards the session the room keeps: the normal room's with the photos only it uses, the debug room's alone, since
   * the room's saved data and photos stay, for the persistence operation `ctx`. The caller shows that the debug room
   * keeps no session.
   */
  function discardKeptSession(ctx: PersistenceOwnership, inDebugRoom: boolean): Promise<void> {
    return inDebugRoom
      ? ctx.rooms(route.debugRoomsNow()).discardSession(keptScope!)
      : ctx.kept(keptSessions).discard(keptScope!);
  }
  /**
   * Asks to keep the shown session as it is now and waits until the keep work under way settles. Keeping is best effort:
   * it settles also when the session is not kept, as when it cannot be written, the store refuses it, or the page
   * moved on; nothing here proves that the session was kept.
   */
  async function settleKeepAttempt(): Promise<void> {
    keepSessionLater();
    while (keeping !== null) await keeping;
  }
  // The session is kept at each interaction it newly presents, a lock's dialog or password field too, also when one
  // asks again after a block, and when it ends, and when the page is hidden.
  let keptPresentation: string | null = null;
  /**
   * Prepares a session of `plan`, which `create` starts: Continue when the script keeps a session that can go on, else
   * Start. Call it instead of `prepare` once the stored values are loaded.
   */
  async function prepareScript(
    plan: string,
    create: PlayerSessionStart,
    sources?: ReadonlyMap<string, string>,
  ): Promise<void> {
    // The host holds the plan, under the token `prepare` gave it.
    // Owned from the call: a later preparation, or a transition that replaces it, while the host gets ready retires it.
    const owner = nextPreparation();
    await bridgeReady;
    if (isDisposed() || owner !== preparation) return;
    // A plan this one replaces needs no JSON any more; this one's is written now, in a task of its own, for the kept
    // session's comparison and a first save to read.
    settlePlanJson({ kind: "replace", plan });
    if (keptScope !== null) settlePlanJson({ kind: "prepare", plan });
    scriptPlan = plan;
    remember(create, sources);
    await prepareKept(owner);
  }
  /**
   * Shows Continue when the script keeps a session that can go on, else Start, with the reason when a Player update
   * changed the format of the kept session. Only while the preparation `owner` is current: the kept session restored,
   * its photos, and its plan's JSON are installed together, or not at all. Resolves to whether it did.
   */
  async function prepareKept(
    owner = nextPreparation(),
    ctx = persistenceOwnership(owner),
  ): Promise<boolean> {
    // The preparation `owner`, in the room and plan tenure it began in, installs what it found; a stale one, nothing.
    return owned(ctx, async () => {
      ctx.check();
      const plan = scriptPlan;
      const found = plan === null ? {} : await restoreKept(plan, ctx);
      if ("session" in found && !ctx.current()) bridgeOf(found.session).release(found.session);
      ctx.check();
      if ("session" in found) {
        ctx.commit(() => {
          for (const [reference, stored] of found.media)
            capturedMedia.restoreSessionMedia(reference, stored);
          kept = {
            plan: true,
            count: found.session.events.length,
            last: found.session.events.at(-1) ?? null,
          };
          prepareRestore(found.session);
        });
        return;
      }
      ctx.commit(() => {
        // Unless the session goes on, a new session's first save stores the plan's JSON, which the comparison read.
        if (plan !== null) settlePlanJson({ kind: "prepare", plan });
        if (lastStart().value !== null) prepareStart(lastStart().value!, found.outdated);
      });
    });
  }
  /**
   * The kept session, restored in the host, when it runs the held plan `plan` and has not ended, with the stored records of
   * the photos only it uses; else, for Start, why the kept session cannot continue when its plan or state is of another
   * revision than this Player's. Nothing of this Player changes yet (`prepareKept`); a session restored but not continued
   * is released in the host.
   */
  async function restoreKept(
    plan: string,
    ctx: PersistenceOwnership,
  ): Promise<
    | {
        readonly session: PlayerSession;
        readonly media: readonly (readonly [string, StoredCapturedMedia | null])[];
      }
    | { readonly outdated?: Problem }
  > {
    if (keptScope === null) return {};
    await route.storageRouteNow();
    ctx.check();
    // The normal room's photos come back as session media; the debug room reads its own like its saved ones.
    const normalRoom = keptStore() === keptSessions;
    const bound = ctx.kept(keptStore());
    const stored = await bound.session(keptScope).catch(rejectedUnlessStale(null));
    ctx.check();
    const found = stored === null ? null : keptSession(stored);
    if (found === null) return {};
    // Not for a session that ended, which only its events can show when its state is of another revision: the engine
    // ends a session with an `exit` or `runtimeFailure` event.
    const explain = !found.events.some(
      (event) => event.kind === "exit" || event.kind === "runtimeFailure",
    );
    let restored: PlayerSession | "otherPlan" | "ended";
    try {
      const host = await bridgeReady;
      ctx.check();
      restored = await ctx.admit(() =>
        host.restoreKept(plan, found.planJson, found.snapshotJson, found.events, found.marks),
      );
    } catch (error) {
      if (error instanceof StaleOperation) throw error;
      ctx.check();
      // The runtime's error says how it refuses a state of another revision.
      const revisions = explain
        ? revisionChange(found.snapshotJson, RUNTIME_SNAPSHOT_VERSION)
        : null;
      if (
        revisions === null ||
        !(error instanceof BridgeRequestError) ||
        error.name !== "CheckpointError" ||
        !isCheckpointErrorInfo(error.info)
      )
        return {};
      const { code, path, message } = error.info;
      return { outdated: { code, path, message: `${message} ${revisions}` } };
    }
    if (typeof restored === "object" && !ctx.current()) {
      // A session a stale preparation restored is released; nothing of it is shown.
      bridgeOf(restored).release(restored);
      throw new StaleOperation();
    }
    ctx.check();
    if (restored === "otherPlan") {
      // After a Player update the same script compiles to a plan of another revision; the plan has no runtime error.
      const revisions = explain ? revisionChange(found.planJson, INSTRUCTION_PLAN_VERSION) : null;
      return revisions === null
        ? {}
        : { outdated: { message: `Unsupported instruction-plan revision. ${revisions}` } };
    }
    if (restored === "ended") return {};
    // A session a stale preparation restored is released; nothing of it is shown.
    const session = restored;
    const owns = () => {
      if (ctx.current()) return;
      bridgeOf(session).release(session);
      throw new StaleOperation();
    };
    const media: (readonly [string, StoredCapturedMedia | null])[] = [];
    if (normalRoom)
      for (const reference of capturedMediaReferencesIn(found.snapshotJson, found.events)) {
        media.push([
          reference,
          await bound.media.get(keptScope, reference).catch(rejectedUnlessStale(null)),
        ]);
        owns();
      }
    owns();
    return { session, media };
  }
  /**
   * Returns to the start page once the session ended by `exit`, which the host does when the player closes the end
   * dialog; the ended session is kept first, so a reload starts anew.
   */
  async function toStartPage(): Promise<void> {
    if (session.value?.state.status !== "halted") return;
    await settleKeepAttempt();
    if (isDisposed() || session.value?.state.status !== "halted") return;
    endSession();
    await prepareKept();
  }

  return {
    retireStaleOperations,
    nextPreparation,
    persistenceOwnership,
    owned,
    settlePlanJson,
    keepSessionLater,
    settleKeepAttempt,
    prepareScript,
    prepareKept,
    toStartPage,
    /** The kept sessions' store of the normal room. */
    keptSessionsNow: () => keptSessions,
    /** The storage scope a session is kept under, or `null` for a script that keeps none. */
    keptScopeNow: () => keptScope,
    /** The host's token of the script's plan, or `null` before a script was prepared. */
    scriptPlanNow: () => scriptPlan,
    /** The keep under way, or `null`. */
    keepingNow: () => keeping,
    /** Forgets what is kept of the shown session: a new session is kept anew. */
    forgetKeptPoint: () => (kept = { plan: false, count: 0, last: null }),
    /** Forgets the interaction the session was last kept at. */
    forgetPresentation() {
      keptPresentation = null;
    },
    /** Ends `ownership`'s registration, once its operation ran. */
    endOwnership(ownership: PersistenceOwnership) {
      pendingOwnerships.delete(ownership);
    },
    /**
     * Makes the kept sessions' stores and the plan JSON's lease, and watches the shown session for keeping, at their
     * place in the composable's setup.
     */
    startKeeping() {
      keptSessions = options.keptSessions ?? memoryKeptSessionStore();
      keptScope = options.scriptStorage?.scope ?? null;
      planJsonLease = EMPTY_PLAN_JSON_LEASE;
      watch(session, (current) => {
        if (current === null || inspecting.value) return;
        const foreground = current.state.foregroundAction;
        const presentation =
          foreground?.kind === "lock" && foreground.phase === "ask"
            ? `lock ${foreground.actionId} ${foreground.resumes}`
            : (activePlayerRuntimeInteraction(current.state)?.actionId.toString() ?? null);
        const ended = current.state.status === "halted" || current.state.status === "failed";
        if ((presentation === null || presentation === keptPresentation) && !ended) return;
        keptPresentation = presentation;
        keepSessionLater();
      });
      useEventListener(
        () => (typeof document === "undefined" ? undefined : document),
        "visibilitychange",
        () => {
          if (document.visibilityState !== "hidden") return;
          // Time passed while the page was visible is observed before the keep's capture, which follows it in the session's
          // queue: the session kept is current.
          clock().before("keepCapture");
          keepSessionLater();
        },
      );
    },
  };
}

/** Whether `info`, an engine error's details from the host, is a `CheckpointError`'s. */
function isCheckpointErrorInfo(info: unknown): info is CheckpointErrorInfo {
  return (
    typeof info === "object" &&
    info !== null &&
    "code" in info &&
    typeof info.code === "string" &&
    "path" in info &&
    typeof info.path === "string" &&
    "message" in info &&
    typeof info.message === "string"
  );
}

/**
 * The saved and supported revisions, as the start page's Technical details say them, when the JSON of a kept plan or
 * state is of another revision than `supported`, this Player's; else `null`.
 */
function revisionChange(json: string, supported: number): string | null {
  let saved: unknown;
  try {
    const parsed: unknown = JSON.parse(json);
    saved =
      typeof parsed === "object" && parsed !== null && "version" in parsed
        ? parsed.version
        : undefined;
  } catch {
    return null;
  }
  return typeof saved !== "number" || saved === supported
    ? null
    : `Saved revision: ${saved}. Supported revision: ${supported}.`;
}
