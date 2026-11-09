import { ref, type Ref } from "vue";
import type { RandomIntent } from "../../../engine-bridge/player-ops.js";
import type {
  DrawResolution,
  RandomTriedView,
  ResolveDrawResult,
} from "../../../engine-bridge/ops/random.js";
import type { RandomNext } from "../../../debug/random-decisions.js";
import {
  bridgeOf,
  endsQuietly,
  refusalCode,
  type PlayerBridge,
  type SessionSection,
} from "../../../runtime/player-bridge.js";
import type { PlayerSession } from "../../../runtime/runtime-view.js";
import type { SectionWork, useRuntimeSceneClock } from "./useRuntimeSceneClock";
import type { Origin, useActivationRun } from "./activation/useActivationRun.js";
import { adopt } from "./activation/work/adopt.js";
import { resolveDrawFor } from "./activation/work/draw.js";
import { sessionTarget } from "./activation/work/target.js";

/*
 * Debug's random control as the host holds it for this Player, moved from `usePlayerSession` unchanged: the intents it
 * sends, the adoption of a session, and the resolution of the draw a session is paused at.
 */

/** What the random control needs from the Player's session composable. */
interface RandomControlHost {
  /** The engine's host now, or `null` before it is ready. */
  readonly bridgeNow: () => PlayerBridge | null;
  readonly claim: symbol;
  readonly isDisposed: () => boolean;
  readonly activationRun: ReturnType<typeof useActivationRun>;
  /** The activation error-stop sink, for an origin's failure. */
  readonly reportActivationError: (origin: Origin, error: unknown) => void;
  /** The page's error reporter, for a page-wide setting's failure. */
  readonly reportPageError: (error: unknown) => void;
  /** The scene clock, read when used. */
  readonly clock: () => ReturnType<typeof useRuntimeSceneClock>;
  readonly session: Readonly<Ref<PlayerSession | null>>;
  readonly inspecting: Readonly<Ref<boolean>>;
  readonly ownedSection: <T>(
    current: PlayerSession | null,
    work: SectionWork,
    body: (
      section: SessionSection,
      owned: () => boolean,
      observed: PlayerSession | null,
    ) => Promise<T>,
  ) => Promise<T | null>;
  readonly publishOwned: (next: PlayerSession) => PlayerSession | null;
}

export function useRandomControl({
  bridgeNow,
  claim,
  isDisposed,
  activationRun,
  reportActivationError,
  reportPageError,
  clock,
  session,
  inspecting,
  ownedSection,
  publishOwned,
}: RandomControlHost) {
  // Debug's random control (DEBUGGER.md "Random draws"), as the host holds it for this Player (`randomOwner`, from its claim
  // of the bridge): which sites go on by themselves while Choose outcomes is on, or `null` while it is off. As tracing,
  // a change before the host is reachable waits as the Player's (`pendingRandom`), and only its latest goes, while the
  // Player lives; every intent carries the serial of the newest reset of the history it asked for (`resetAt`).
  // A private bridge is this Player's from the start: a Start may begin before the readiness callback ran.
  let randomOwner: number | null = bridgeNow()?.claim(claim) ?? null;
  let desiredRandom: { readonly sites: readonly (readonly [string, RandomNext])[] } | null = null;
  let resetRequested = false;
  let pendingRandom = false;
  let lastRandom: RandomIntent | undefined;
  // The host's history's revision, from its latest reply: what `randomTried` reads again for.
  const randomRevision = ref(0);
  /**
   * Sends the pending random intent, while this Player lives, after the earlier requests of `ahead` (the shown session),
   * so that session's next op runs with it. It gives no session this Player's control: only `adoptRandom` does.
   */
  function flushRandom(host: PlayerBridge, ahead: PlayerSession | null) {
    if (!pendingRandom || isDisposed() || randomOwner === null) return;
    pendingRandom = false;
    const intent = host.nextRandomIntent();
    lastRandom = Object.freeze({
      owner: randomOwner,
      control: desiredRandom,
      resetAt: resetRequested ? intent : (lastRandom?.resetAt ?? 0),
      intent,
    });
    resetRequested = false;
    // A page-wide setting: it lives as long as the Player, whichever activation runs.
    host.client
      .request("randomControl", { intent: lastRandom }, ahead === null ? {} : { after: ahead.id })
      .then(
        (reply) => {
          if (!isDisposed()) adoptRevision(reply);
        },
        (error: unknown) => {
          if (!endsQuietly(error) && !isDisposed()) reportPageError(error);
        },
      );
  }
  /** Takes the history's revision from a random op's reply. */
  function adoptRevision(reply: { readonly result: unknown }) {
    // EVIDENCE: validation: the random ops reply from the same build with the history's revision.
    const { revision } = reply.result as { readonly revision: number };
    randomRevision.value = revision;
  }
  /**
   * Adopts `next`: gives it this Player's random control from its next op on. Only the invariant's points call it:
   * `showSession` without inspection, input adopting an inspected state, Continue after its kept draw went on. A Start's
   * session is already its Player's from the `start` that made it.
   */
  function adoptRandom(next: PlayerSession, origin: Origin) {
    if (lastRandom === undefined || isDisposed()) return;
    // The adoption acts for the activation that shows `next`, and only while that lives: once it retired, its reply
    // writes nothing and its failure stops nothing (`work/adopt.ts`).
    void adopt(sessionTarget(next, origin, activationRun), lastRandom, origin, {
      admits: (each) => activationRun.admits(each),
      settle: (each, outcome, handlers) => activationRun.settle(each, outcome, handlers),
      adopted: (reply) => {
        if (!isDisposed()) adoptRevision(reply);
      },
      quiet: (error) => endsQuietly(error) || isDisposed(),
      report: (each, error) => reportActivationError(each, error),
    });
  }
  /** What a Start carries: this Player, whose session it is, and its newest random intent. */
  const startRandom = () =>
    randomOwner === null
      ? undefined
      : { owner: randomOwner, ...(lastRandom === undefined ? {} : { intent: lastRandom }) };
  /**
   * Gives this Player's sessions Debug's random control from their next op on: the sites set to go on by themselves,
   * or `null` for none. Without one, a draw the session is paused at goes on naturally.
   */
  function setRandomControl(
    control: { readonly sites: readonly (readonly [string, RandomNext])[] } | null,
  ) {
    if (isDisposed()) return;
    // A catch-up under way finishes first, as one observation, with the draws it started with. The change follows the
    // shown session's queue whether or not that observation succeeds.
    clock().before("randomControl");
    const current = session.value;
    // Off while nothing is on and no reset is asked: the host has nothing to change.
    const changed = control !== null || desiredRandom !== null || resetRequested;
    desiredRandom = control;
    if (changed) pendingRandom = true;
    if (bridgeNow() !== null) flushRandom(bridgeNow()!, current);
    if (control === null && current?.state.randomDraw != null)
      void resolveRandomDraw(current.state.randomDraw.drawId, "natural");
  }
  /** Ends Debug's random control and forgets what each site took, as when the Debug features end. */
  function forgetRandomHistory() {
    // A history needs forgetting only once the host may hold one.
    if (lastRandom !== undefined || pendingRandom) resetRequested = true;
    setRandomControl(null);
  }
  // A session that runs again while paused at a draw nobody decides any more, such as a restored state adopted after
  // Debug's control ended, goes on naturally.
  function settleUncontrolledDraw(origin: Origin) {
    const draw = session.value?.state.randomDraw;
    if (desiredRandom === null && draw != null)
      void resolveDraw(draw.drawId, "natural", false, origin);
  }
  /**
   * Resolves the random draw the session is paused at, naturally, with a chosen outcome, or with its site's least-tried
   * one, in the host; with `record`, the outcome goes into the site's history. The session's clock goes on from the
   * time it paused at. `null` when the session is not paused at that draw or no longer owns the UI. It acts for the
   * activation that shows the session, live at this call: once that retired, its reply writes nothing and its failure
   * stops nothing.
   */
  function resolveRandomDraw(
    drawId: number,
    outcome: DrawResolution,
    record = false,
  ): Promise<ResolveDrawResult["outcome"] | null> {
    return resolveDraw(drawId, outcome, record, activationRun.current());
  }
  /** `resolveRandomDraw` for `origin`, which its caller captured at its synchronous entry. */
  function resolveDraw(
    drawId: number,
    outcome: DrawResolution,
    record: boolean,
    origin: Origin,
  ): Promise<ResolveDrawResult["outcome"] | null> {
    if (inspecting.value) return Promise.resolve(null);
    // Which reset the record belongs to, as it was asked: one asked for since enters nothing.
    const recorded = record ? { resetAt: lastRandom?.resetAt ?? 0 } : null;
    // In one section of the shown session (`work/draw.ts`): its facade admits the origin as the body begins, which sends
    // in the same turn; after the send, the work admits it again before the revision and the publication.
    return resolveDrawFor(drawId, outcome, recorded, origin, {
      admits: (each) => activationRun.admits(each),
      section: (body) =>
        ownedSection(session.value, "inputAnswer", async (section, owned, current) => {
          if (!activationRun.admits(origin)) return null;
          return body({
            drawId: current?.state.randomDraw?.drawId ?? null,
            send: (resolution) => section.send("resolveDraw", resolution),
            owned,
            publish: () => publishOwned(section.session) !== null,
          });
        }),
      inspecting: () => inspecting.value,
      disposed: isDisposed,
      revision: (revision) => (randomRevision.value = revision),
      rebase: () => clock().rebase(),
      quiet: (error) => endsQuietly(error) || refusalCode(error) !== null || isDisposed(),
      report: (each, error) => reportActivationError(each, error),
    });
  }
  /** What `site` took, for the picker, from the host's history of the shown session's Player; `null` without one. */
  function randomTried(site: string): Promise<RandomTriedView> {
    const shown = session.value;
    if (shown === null) return Promise.resolve(null);
    return bridgeOf(shown)
      .read(shown, "randomTried", { site })
      .catch(() => null);
  }

  return {
    flushRandom,
    adoptRandom,
    startRandom,
    setRandomControl,
    forgetRandomHistory,
    settleUncontrolledDraw,
    resolveRandomDraw,
    randomTried,
    randomRevision,
    /** Takes the Player's random ownership from its claim of a bridge that became ready. */
    claimed(owner: number) {
      randomOwner = owner;
    },
    /** Drops the random intent waiting to be sent: the host is unreachable or lost. */
    dropPending() {
      pendingRandom = false;
    },
    /** This Player's newest random intent sent, or `undefined` before any. */
    issuedRandom: () => lastRandom,
    /** Whether Debug's random control is off for every site. */
    randomControlOff: () => desiredRandom === null,
    /** Ends this Player's random control with its history, at the Player's disposal, on `bridge`. */
    dispose(bridge: PlayerBridge | null) {
      pendingRandom = false;
      if (
        lastRandom !== undefined &&
        bridge !== null &&
        (lastRandom.control !== null || lastRandom.resetAt !== lastRandom.intent)
      ) {
        const intent = bridge.nextRandomIntent();
        const shown = session.value;
        bridge.client
          .request(
            "randomControl",
            { intent: { owner: lastRandom.owner, control: null, resetAt: intent, intent } },
            shown === null ? {} : { after: shown.id },
          )
          .catch(() => {});
      }
      lastRandom = undefined;
    },
  };
}
