import { computed, ref, shallowRef, type Ref } from "vue";
import type { DebugRecording } from "../../../../debug/debug-recorder.js";
import { playerTemporalContext, type PlayerSession } from "../../../../runtime/runtime-view.js";
import { bridgeOf, endsQuietly, type PlayerBridge } from "../../../../runtime/player-bridge.js";
import type { RandomIntent, TracingIntent } from "../../../../engine-bridge/player-ops.js";
import type { StartRandom } from "../../../../engine-bridge/ops/session.js";
import type { TemporalContext } from "../../../../../src/index.js";
import type { Problem } from "../../start-and-end/ProblemCard.vue";
import type { PlayerSessionOptions, PlayerSessionStart } from "../usePlayerSession.js";
import type { useKeptSession } from "../persistence/useKeptSession.js";
import {
  useActivationRun,
  type Origin,
  type ReplyHandlers,
  type RunOrigin,
} from "./useActivationRun.js";
import { continueRestored } from "./work/continue.js";
import { recoveryKind, type Recovery, type ShownStatus } from "./recoveryKind.js";
import { stopAt, stopLateStart, type StopPage } from "./work/stop.js";
import {
  commitIncident,
  isSessionTarget,
  sessionOf,
  sessionTarget,
  stoppedSession,
  stopTarget,
  type SessionTarget,
} from "./work/target.js";

/** The session a begin gave, as the scheduler installs it: a Continue's target unwrapped, a Start's session as it is. */
const sessionOfBegun = (begun: PlayerSession | SessionTarget): PlayerSession =>
  isSessionTarget(begun) ? sessionOf(begun) : begun;

/*
 * The activation under way, moved from `usePlayerSession` unchanged: its preparation as Start or Continue, the click
 * that begins it, its begin and completion in its run (`useActivationRun`), and its error stop.
 */

/** What Start and Continue record of the player's click: the zone and presentation, and the wall clock. */
export type TemporalCapture = { temporalContext: TemporalContext; wallClockMs: number };

type Activation = {
  readonly kind: "start" | "continue";
  /**
   * Begins the session; a Start or Continue over the bridge resolves once its first publication is applied. A Start
   * gives the bridge's session, or its promise, unchanged; a Continue gives its work's target.
   */
  readonly begin: (
    origin: RunOrigin,
  ) => PlayerSession | SessionTarget | Promise<PlayerSession | SessionTarget>;
  /** The restored session Continue goes on with. */
  readonly restored?: PlayerSession;
  /** Why Start shows instead of Continue: the kept session is of a format this Player no longer reads. */
  readonly outdated?: Problem;
  /**
   * Whether its session is the chat the Player showed before (`showSession`'s `sameChat`): only the Continue that
   * recovers from a lost connection.
   */
  readonly sameChat?: true;
};

/** What the activation needs from the Player's session composable. */
interface SessionActivationHost {
  readonly options: PlayerSessionOptions;
  readonly session: Ref<PlayerSession | null>;
  readonly stopped: Readonly<Ref<boolean>>;
  /** The engine's host now, or `null` before it is ready. */
  readonly bridgeNow: () => PlayerBridge | null;
  /** The current connection once it is ready. */
  readonly currentConnection: () => Promise<PlayerBridge>;
  readonly requireBridge: () => PlayerBridge;
  /** The connection's replacement after a loss (`useEngineConnection`). */
  readonly connection: {
    /** The plan token of the source a replacement prepares again, or `null` when none can. */
    replaceablePlan(): string | null;
    /** Opens a fresh connection and prepares the remembered source in it; resolves with both. */
    replace(): Promise<{
      readonly host: PlayerBridge;
      readonly prepared: Promise<{
        readonly result: { readonly kind: string; readonly plan?: string };
      }>;
    }>;
    /** Gives up the fresh connection of a failed recovery, if it is still the current one. */
    giveUp(candidate: PlayerBridge): void;
  };
  /** Whether a state Debug's rewind restored is shown for inspection. */
  readonly inspecting: () => boolean;
  readonly isDisposed: () => boolean;
  /** Shows `next` as the Player's, for `origin`, the activation that began it; `sameChat`: the chat shown before. */
  readonly showSession: (
    next: PlayerSession,
    origin: Origin,
    options: { readonly sameChat: boolean },
  ) => void;
  // The owners made after this one, as the activation reaches them: forwarders and getters.
  readonly camera: { open(capability: boolean): Promise<boolean>; release(): void };
  readonly captures: { reset(): void };
  readonly device: { reset(): void };
  readonly primeAudio: () => void;
  /** Whether the script has saved values, read when used. */
  readonly hasScriptStorage: () => boolean;
  readonly loadScriptStorage: () => Promise<void>;
  readonly clearing: () => Readonly<Ref<boolean>>;
  readonly importing: () => Readonly<Ref<boolean>>;
  readonly keptOwner: () => ReturnType<typeof useKeptSession>;
  readonly settlePlanJson: ReturnType<typeof useKeptSession>["settlePlanJson"];
  readonly nextPreparation: () => number;
  readonly debugModeOn: () => boolean;
  readonly tracingIntent: () => TracingIntent | undefined;
  readonly adoptRandom: (next: PlayerSession, origin: Origin) => void;
  readonly startRandom: () => StartRandom | undefined;
  readonly random: { issuedRandom(): RandomIntent | undefined };
  readonly resolveTemporalContext: () => TemporalContext;
}

export function useSessionActivation({
  options,
  session,
  stopped,
  bridgeNow,
  currentConnection,
  requireBridge,
  connection,
  inspecting,
  isDisposed,
  showSession,
  camera,
  captures,
  device,
  primeAudio,
  hasScriptStorage,
  loadScriptStorage,
  clearing,
  importing,
  keptOwner,
  settlePlanJson,
  nextPreparation,
  debugModeOn,
  tracingIntent,
  adoptRandom,
  startRandom,
  random,
  resolveTemporalContext,
}: SessionActivationHost) {
  // Each activation's diagnostic run, the one owner of what its completions may do; with its recording up to a Player
  // error, captured in the host as the stop is sent and kept until the next Start, while Debug's rewind may begin the
  // recorder anew at a restored state.
  const activationRun = useActivationRun({
    report: (origin, error) => reportActivationError(origin, error),
  });
  /**
   * The recording the host holds, for tests (`readRecording`): a Player error's, while its captured ticket is held, else
   * the recorder's current one, chosen now and read when the host dispatches the read. Not a debug export's selection
   * (the failure recording's `selection()`), which waits for a pending capture and selects none where it settled
   * unavailable.
   */
  const heldDebugRecording = async (): Promise<DebugRecording | null> => {
    const live = activationRun.current();
    const failed = live.kind === "run" ? live.failure.ticket() : null;
    if (failed !== null) return failed.bridge.readRecording(failed.ticket);
    return (await bridgeNow()?.readRecording(null)) ?? null;
  };
  // The error name of an exception of the Player itself, such as one at Start; it stays until the next Start. Such an
  // exception stops the session where it stands (see `stopped`).
  const hostError = ref<string | null>(null);
  // From a Player error stop until the host acknowledged it (a round trip with a Worker): input stops, nothing renders.
  // It belongs to the stop `haltingStop` names: only that stop ends it, and a later activation retires it.
  const halting = ref(false);
  let haltingStop = 0;
  function haltUntil(stop: number) {
    haltingStop = stop;
    halting.value = true;
  }
  function endHalting(stop: number) {
    if (stop === haltingStop) halting.value = false;
  }
  /**
   * The Player error stop. What shows is what the host ran before the stop, and nothing after it: the stop ends the
   * activation under way, so no Start or Continue completes on its own; the host refuses what the stopped session has
   * not run, and its store applies the replies to what it ran until the host acknowledges the stop. The stopped session
   * is the shown one, else the one still beginning: a Continue's restored session at once, a Start's once its reply
   * names it. Its last publication then shows, and the stop renders after it; input stops at once (`stopped`). The error
   * is `origin`'s: a deferred completion passes the activation it began in, and one of a retired activation does
   * nothing (`useActivationRun`). It is the activation's one error-stop sink; the page's own reporter is
   * `reportPageError`.
   */
  function reportActivationError(origin: Origin, error: unknown) {
    if (!activationRun.admits(origin)) return;
    console.error("[player] host error", error);
    const restoring = continuing;
    const starting = sessionBeginning;
    // A stop still waiting for the same Start keeps its error: the first error is the one the stop shows and commits.
    const waiting =
      lateStop !== null && lateStop.starting === starting && lateStop.stop === activationToken
        ? lateStop
        : null;
    const name = waiting?.name ?? (error instanceof Error ? error.name : "Error");
    continuing = null;
    activationToken += 1;
    beginning.value = false;
    const stop = activationToken;
    const shown = session.value ?? restoring;
    // A Continue still beginning beside a shown session runs nothing more either: plain-halted, resource-bound cleanup.
    if (restoring !== null && restoring !== shown) void bridgeOf(restoring).halt(restoring);
    if (shown !== null) {
      stopAt(stopTarget(shown, origin, activationRun), name, stop, origin, stopPage);
      return;
    }
    // Without a session to stop, the run's incident is committed by itself.
    if (starting === null) {
      hostError.value = name;
      commitIncident(origin, name, stop, activationRun);
      return;
    }
    // The late Start's session has one cleanup owner: the stop that waits for it last.
    lateStop = { starting, stop, name };
    stopLateStart(starting, name, stop, origin, {
      ...stopPage,
      target: (begun) => stopTarget(sessionOfBegun(begun), origin, activationRun),
      claimedLater: () =>
        lateStop !== null &&
        lateStop.starting === starting &&
        lateStop.stop !== stop &&
        lateStop.stop === activationToken,
      haltObsolete: (begun) => {
        const late = sessionOfBegun(begun);
        void bridgeOf(late).halt(late);
      },
      incident: () => {
        hostError.value ??= name;
        commitIncident(origin, name, stop, activationRun);
      },
    });
  }
  /** The page operations of the error stop's work, each admitted where it acts (`work/stop.ts`). */
  const stopPage: StopPage = {
    admits: (origin) => activationRun.admits(origin),
    isCurrent: (stop) => stop === activationToken,
    haltUntil,
    endHalting,
    commit: (target, name) => {
      const { final } = stoppedSession(target);
      if (final !== null) session.value = final;
      hostError.value ??= name;
    },
  };
  /**
   * The loss of the engine's connection, in its own turn: the Player's error stop at once, with what the host last
   * published, and no halt asked of the dead connection, nor waited for. The activation under way and every stop still
   * committing go (their tokens), and the record is revoked: no completion of anything begun before acts afterwards.
   */
  function lose(error: unknown) {
    const name = error instanceof Error ? error.name : "Error";
    console.error("[player] host error", error);
    // Already stopped by a loss: the stop's cleanup ran then, so a camera open now is the recovery click's.
    const wasLost = lost.value;
    recoveryBegin = null;
    // What the player can recover, decided before the activation's state is cleared (`recoveryKind`).
    const shown = session.value;
    const recovery = recoveryKind({
      disposed: isDisposed(),
      replaceable: replaceable(),
      // EVIDENCE: invariant: a shown session's status is one of the runtime's statuses `ShownStatus` names.
      shown: shown === null ? null : (shown.state.status as ShownStatus),
      inspecting: inspecting(),
      clicking: beginning.value ? clickKind : null,
      prepared: activation.value?.kind ?? null,
    });
    activationToken += 1;
    continuing = null;
    beginning.value = false;
    const target = session.value;
    if (target !== null) {
      const final = bridgeOf(target).latest(target);
      if (final !== null) session.value = final;
    }
    halting.value = false;
    activationRun.revoke();
    lateStop = null;
    if (recovery === null) {
      hostError.value ??= name;
      return;
    }
    lost.value = true;
    if (wasLost) camera.release();
    recoveryShown.value = recovery;
    offer.value = null;
    if (recovery.kind === "start" || recovery.kind === "continue") offer.value = recovery.kind;
    else if (recovery.kind === "kept") {
      // The offer waits for one read of the store, after the keep work under way settled.
      const asked = recovery;
      void keptOwner()
        .keptPointFound()
        .then((found) => {
          if (recoveryShown.value === asked && !isDisposed())
            offer.value = found ? "continue" : "start";
        });
    }
  }
  /**
   * The engine's connection was lost and a fresh one can replace it, from the player's click only: the session stopped as
   * at a Player error, and the next Start or Continue first replaces the connection.
   */
  const lost = ref(false);
  /** The activation token of a recovery's begin until its session shows, or `null`. */
  let recoveryBegin: number | null = null;
  /** What the loss left the player to recover (`recoveryKind`), until a click replaced the connection. */
  const recoveryShown = shallowRef<Recovery | null>(null);
  /** What the stop offers once decided: Continue from the last kept point, or Start again; `null` while it reads. */
  const offer = ref<"start" | "continue" | null>(null);
  /** Whether the script a replacement prepares again is the one the latest Start runs. */
  const replaceable = () => {
    const plan = connection.replaceablePlan();
    return plan !== null && lastStart.value?.plan === plan;
  };
  /**
   * The recovery the page presents: its offer, over the stopped session (`line`) or on the start page (`page`); `null`
   * when nothing is offered, as before the store was read, while its click is under way, after an end, or on a start
   * page that stays as it was.
   */
  const recoveryOffer = computed(() => {
    const recovery = recoveryShown.value;
    const kind = offer.value;
    if (recovery === null || kind === null || beginning.value) return null;
    if (recovery.kind === "kept") return { offer: kind, where: "line" as const };
    if (recovery.kind !== "ended" && recovery.shown) return { offer: kind, where: "page" as const };
    return null;
  });
  // The kind of the Start or Continue the player's click under way began, while `beginning` holds.
  let clickKind: "start" | "continue" = "start";
  /**
   * The page's error reporter: an exception of the Player at a page owner's own event (its interface, the hosted
   * script, Debug's rewind, the page-wide trace and random settings), reported for the activation live at that event.
   * Activation work never takes it: it reports to its own origin (`reportActivationError`).
   */
  function reportPageError(error: unknown) {
    reportActivationError(activationRun.current(), error);
  }
  const activation = shallowRef<Activation | null>(null);
  let activationToken = 0;
  // A Continue under way in the host, whose session no other activation may let run on; see `supersede`.
  let continuing: PlayerSession | null = null;
  // The Start or Continue still beginning over the bridge. A later activation begins only once it settled, so the
  // obsolete one's requests are posted before the replacement's. The outcome does not rest on that order:
  // `supersede` halts an obsolete Continue on receipt, and the host refuses its later requests (#2365).
  let begunInFlight: Promise<void> | null = null;
  // The session that Start or Continue is beginning, once the host names it; an error stop stops at it.
  let sessionBeginning: Promise<PlayerSession | SessionTarget> | null = null;
  /** The last error stop that waits for a Start still beginning (`stopLateStart`), with its stop token and error. */
  let lateStop: {
    readonly starting: Promise<PlayerSession | SessionTarget>;
    readonly stop: number;
    readonly name: string;
  } | null = null;
  /**
   * A new activation, preparation or end replaces the one under way: a Continue still beginning is halted in the host,
   * so its queued requests, such as starting the recording of an obsolete session, are refused without effect.
   */
  function supersede() {
    activationToken++;
    nextPreparation();
    // A pending error stop is retired with the activation it stopped; the replacement's input runs.
    halting.value = false;
    const obsolete = continuing;
    continuing = null;
    if (obsolete !== null) void bridgeOf(obsolete).halt(obsolete);
  }
  // The latest Start, which the start page offers again where no kept session goes on, as after the end dialog or an
  // import that replaced the saved data, and which the debug room's restarts run.
  const lastStart = shallowRef<PlayerSessionStart | null>(null);
  // The source text of each file of the script Start runs, by path, when its host supplied it.
  let scriptSources: ReadonlyMap<string, string> = new Map();
  // A Start waiting for its read of the stored values or for the camera, or a Continue waiting for the camera, already
  // owns its view of the stored values, although its session is not published yet; a restored one may still write them.
  const beginning = ref(false);
  /**
   * Readies the page for a rewind step's commit or a reinstatement, which begins the host's recording anew: after a
   * Player error, the recording up to the error is kept for the debug export first. Its callers await what it returns.
   */
  function beforeRewindRestart(): void | Promise<void> {
    // The recording up to a Player error is captured before the host begins the recorder anew.
    const live = activationRun.current();
    return live.kind === "run" ? live.failure.beforeRestart() : undefined;
  }
  /**
   * Shows the explicit Start control for a new session; `create` runs only on activation, so no statement executes
   * on page load and the click is the user activation later audible playback relies on. `sources`, the text of the
   * script's files by path, lets the error dialog show a failing line; a later `prepare` without them keeps them.
   */
  function prepare(create: PlayerSessionStart, sources?: ReadonlyMap<string, string>) {
    lastStart.value = create;
    if (sources !== undefined) scriptSources = sources;
    prepareStart(create);
  }
  /** Shows Start for `create`, with `outdated`, why the kept session cannot continue, on the start page. */
  function prepareStart(create: PlayerSessionStart, outdated?: Problem) {
    supersede();
    beginning.value = false;
    // A new session needs its own camera; a superseded acquisition never stays open.
    camera.release();
    activation.value = startRecipe(create, outdated);
    prepareActivation("start");
  }
  /** The Start of `create`, with `outdated`, why the kept session cannot continue, for the start page. */
  function startRecipe(create: PlayerSessionStart, outdated?: Problem): Activation {
    return {
      kind: "start",
      begin: (origin) => startedSession(create, { debugMode: debugModeOn() }, origin),
      ...(outdated === undefined ? {} : { outdated }),
    };
  }
  /**
   * Prepares in a task of its own what the activation would otherwise compute within the click (#1707): the zone the
   * browser's settings name, which Start and Continue still capture anew, and a Start's plan JSON for its first save.
   */
  function prepareActivation(kind: Activation["kind"]) {
    if (
      kind === "start" &&
      keptOwner().keptScopeNow() !== null &&
      keptOwner().scriptPlanNow() !== null
    )
      settlePlanJson({ kind: "prepare", plan: keptOwner().scriptPlanNow()! });
    if (options.temporalContext !== undefined) return;
    const token = activationToken;
    setTimeout(() => {
      if (isDisposed() || token !== activationToken) return;
      try {
        playerTemporalContext();
      } catch {
        // Start and Continue capture it themselves and report what fails.
      }
    }, 0);
  }
  /**
   * What Start and Continue record about the player now: the zone and presentation, then the wall clock, sampled last so
   * that resolving the zone does not age it.
   */
  function temporalCapture(): TemporalCapture {
    if (clicked !== null) {
      if ("error" in clicked) throw clicked.error;
      return clicked.capture;
    }
    return sampleTemporalCapture();
  }
  function sampleTemporalCapture(): TemporalCapture {
    const temporalContext = resolveTemporalContext();
    return { temporalContext, wallClockMs: Date.now() };
  }
  /** `temporalCapture()`'s result, sampled once, or what sampling threw. */
  type ClickSample = { readonly capture: TemporalCapture } | { readonly error: unknown };
  function sampleClick(): ClickSample {
    try {
      return { capture: sampleTemporalCapture() };
    } catch (error) {
      return { error };
    }
  }
  /**
   * The capture of the activation's click while its `begin` runs (#1886): Start's options and Continue's `begin` record
   * it through `temporalCapture()`, whatever the activation waited for since the click.
   */
  let clicked: ClickSample | null = null;
  /**
   * Shows the explicit Continue control for a restored session; its execution, time and media resume only then.
   * Continue records the wall clock and the player's zone and presentation as they are now.
   */
  function prepareRestore(restored: PlayerSession) {
    supersede();
    beginning.value = false;
    camera.release();
    activation.value = continueRecipe(restored);
    prepareActivation("continue");
  }
  /** The Continue of `restored`. */
  function continueRecipe(restored: PlayerSession): Activation {
    return {
      kind: "continue",
      begin: (origin) => {
        continuing = restored;
        // Only the activation that began it goes on after each reply: a replaced one touches no trace or recorder.
        const owner = activationToken;
        return continueRestored(sessionTarget(restored, origin, activationRun), origin, {
          randomIssued: () => random.issuedRandom() !== undefined,
          owned: () => {
            if (isDisposed() || owner !== activationToken || !activationRun.admits(origin))
              throw new Error("A replaced Continue goes no further.");
          },
          capture: () => temporalCapture(),
          tracing: () => tracingIntent(),
          debugModeOn: () => debugModeOn(),
          adopt: (target, run) => adoptRandom(sessionOf(target), run),
          quiet: (error) => endsQuietly(error) || isDisposed() || stopped.value,
          report: (run, error) => reportActivationError(run, error),
        });
      },
      restored,
    };
  }
  /**
   * Runs the prepared Start or Continue; call it from the activating click. With the camera capability it first opens
   * the session camera, so any browser permission request happens here, before ordinary script execution. A camera
   * failure never prevents the session from starting. Start then reads the stored values again, which another tab may
   * have changed since they were read; Continue goes on with its session's own view of them. After the engine's
   * connection was lost, the click is the player's choice of what the stop offers, and the connection is replaced first
   * (`recover`).
   */
  async function activate() {
    const pending = activation.value;
    const kind = pending?.kind ?? (lost.value ? (recoveryOffer.value?.offer ?? null) : null);
    if (kind === null || clearing().value || importing().value) return;
    activation.value = null;
    // The activation it replaces, such as a Continue still beginning, goes.
    supersede();
    const token = activationToken;
    clickKind = kind;
    const withCamera = options.capabilities?.camera === true;
    const reading = kind === "start" && hasScriptStorage();
    // Everything the browser allows only within the player's click runs here, before any await or request: the
    // session may show only after the host replied (a Start of a held plan, a Continue), or after the camera answered.
    // Retire the previous session first: its elements return to the pool before priming, so the new session never
    // receives an element the browser still blocks, and it cannot project media while it waits. `beginning` keeps the
    // screen on from the click (`useScreenWakeLock`).
    session.value = null;
    device.reset();
    primeAudio();
    beginning.value = true;
    // What it records of the click (#1886) is sampled now, before anything it waits for; with the camera, as at the fork,
    // once the camera answered, and still before the stored values are read or another activation is waited for.
    let sample = withCamera ? null : sampleClick();
    if (!withCamera && !reading) {
      // `takePhoto()` is unconfigured (settled before `open` returns): nothing waits but the host's replies.
      void camera.open(false);
      captures.reset();
      try {
        if (begunInFlight !== null) {
          await begunInFlight;
          if (isDisposed() || token !== activationToken) return;
        }
        await beginClicked(pending, kind, token, sample ?? sampleClick());
      } finally {
        if (token === activationToken) beginning.value = false;
      }
      return;
    }
    let opened = false;
    let failed = true;
    try {
      opened = await camera.open(withCamera);
      if (opened && !isDisposed() && token === activationToken) sample ??= sampleClick();
      if (opened && reading && !isDisposed() && token === activationToken)
        await loadScriptStorage();
      failed = false;
    } finally {
      // It stays set for a Start that goes on, so the lock asked for in the click is kept; a superseding prepare already
      // reset it for its own activation.
      if (token === activationToken && (failed || !opened || isDisposed())) beginning.value = false;
    }
    // Replaced, re-prepared, or unmounted while it waited: an obsolete session never starts.
    if (!opened || isDisposed() || token !== activationToken) return;
    captures.reset();
    try {
      if (begunInFlight !== null) {
        await begunInFlight;
        if (isDisposed() || token !== activationToken) return;
      }
      await beginClicked(pending, kind, token, sample ?? sampleClick());
    } finally {
      if (token === activationToken) beginning.value = false;
    }
  }
  /** Begins what the click chose: the prepared activation, or after a loss, the recovery of `kind`. */
  function beginClicked(
    pending: Activation | null,
    kind: "start" | "continue",
    token: number,
    sample: ClickSample,
  ): Promise<void> | void {
    if (lost.value) return recover(kind, token, sample);
    if (pending !== null) return startFrom(pending, sample);
  }
  /**
   * The click's recovery after a loss (PLAYER-UI "Session end and failure"): once the keep work under way settled, a
   * fresh connection replaces the lost one and prepares the script again, and the click begins `kind` there with its own
   * sample, without preparing the start page, so the click keeps its token, its camera and its wake lock. A Continue
   * first restores the kept session in the fresh host; one it refuses shows the start page with Start, and nothing
   * begins. A failure before the begin offers the same choice again; a loss meanwhile is a new stop.
   */
  async function recover(kind: "start" | "continue", token: number, sample: ClickSample) {
    const owns = () => !isDisposed() && token === activationToken;
    // The fresh connection this click took: the Player's once its session shows or the start page offers Start.
    let candidate: PlayerBridge | null = null;
    try {
      await keptOwner().settleKeepWork();
      if (!owns()) return;
      const replacement = await connection.replace();
      candidate = replacement.host;
      const prepared = await replacement.prepared;
      if (!owns()) return;
      const plan = prepared.result.kind === "prepared" ? prepared.result.plan : undefined;
      if (plan === undefined || lastStart.value === null)
        throw new Error("The script was not prepared again.");
      keptOwner().rebindScript(plan);
      const create: PlayerSessionStart = { ...lastStart.value, plan };
      lastStart.value = create;
      let recipe: Activation;
      if (kind === "continue") {
        const found = await keptOwner().restoreForRecovery();
        if (!owns()) {
          if (found !== null && "session" in found) bridgeOf(found.session).release(found.session);
          return;
        }
        if (found === null || !("session" in found)) {
          endRecovery();
          prepareStart(create, found?.outdated);
          return;
        }
        // The session the loss stopped goes on: its chat is the one shown before.
        recipe = { ...continueRecipe(found.session), sameChat: true };
      } else recipe = startRecipe(create);
      endRecovery();
      // Until its session shows, a begin the fresh host refuses offers the same choice again (`startFrom`).
      recoveryBegin = activationToken;
      await startFrom(recipe, sample);
    } catch (error) {
      if (!owns()) return;
      console.error("[player] host error", error);
      // The click cleared the session: the choice shows again on the start page.
      recoveryShown.value = { kind, shown: true };
      offer.value = kind;
    } finally {
      // Every way out that leaves the Player lost (a failure, a refused begin, another loss) gives up what the click
      // acquired: its fresh connection, and while it still owns the click, its camera, which no stop releases while the
      // Player stays stopped. An unmount gives the connection up at the disposal, which a held reply never reaches.
      if (lost.value) {
        if (candidate !== null) connection.giveUp(candidate);
        if (owns()) camera.release();
      }
    }
  }
  /** A begin's failure: the error stop, or, for a recovery's begin, the same offer again, as after a loss. */
  function beginFailed(token: number, origin: Origin, error: unknown) {
    if (recoveryBegin === token) lose(error);
    else reportActivationError(origin, error);
  }
  /** The connection was replaced: the stop and its offer end. */
  function endRecovery() {
    lost.value = false;
    recoveryShown.value = null;
    offer.value = null;
  }
  /**
   * The session `create` starts over the bridge (`start`): its held plan, with the options it reads now, the click's
   * capture among them. It runs with the host's value trace, and carries its Player's random ownership, as only a Start
   * does; a restore takes it at its adoption.
   */
  function startedSession(
    create: PlayerSessionStart,
    recording: { readonly debugMode: boolean },
    origin: RunOrigin,
  ): Promise<PlayerSession> {
    const startOptions = { ...create.options(), debugMode: recording.debugMode };
    return requireBridge().start(create.plan, startOptions, true, startRandom(), origin.begin);
  }
  /**
   * Starts the prepared session; an exception of the Player while it begins is reported, with what was recorded. A
   * session the host starts at once shows within the activating click; one that begins over the bridge shows once its
   * first publication arrives, unless it was replaced, re-prepared, or unmounted meanwhile.
   */
  function startFrom(pending: Activation, sample: ClickSample): Promise<void> | void {
    const token = activationToken;
    // The engine's host is ready at once in-process; an injected one may answer `ready` later, which this waits for.
    if (bridgeNow() === null)
      return currentConnection().then(() => {
        if (!isDisposed() && token === activationToken) return startFrom(pending, sample);
      });
    hostError.value = null;
    // The activation's run begins before anything of it can fail, retiring the one before it.
    const origin = activationRun.begin(bridgeNow()!);
    let begun: PlayerSession | SessionTarget | Promise<PlayerSession | SessionTarget>;
    // `begin` records the click's capture: it reads it before its first await, a Start in its options.
    clicked = sample;
    try {
      begun = pending.begin(origin);
    } catch (error) {
      beginFailed(token, origin, error);
      return;
    } finally {
      clicked = null;
    }
    if (!(begun instanceof Promise)) return started(pending, sessionOfBegun(begun), origin);
    sessionBeginning = begun;
    // Its terminal reaction, the begin's own: the session goes on only for its live activation, while that is still the
    // one begun; an obsolete activation's failure stops nothing, and the session that replaced it goes on.
    const handlers: ReplyHandlers<PlayerSession | SessionTarget> = {
      done: (next) => {
        if (!isDisposed() && token === activationToken)
          started(pending, sessionOfBegun(next), origin);
        return undefined;
      },
      failed: (error) => {
        if (!isDisposed() && token === activationToken) beginFailed(token, origin, error);
        return undefined;
      },
    };
    const settled = begun.then(
      (next) => activationRun.settle(origin, { ok: true, value: next }, handlers),
      (error: unknown) => activationRun.settle(origin, { ok: false, error }, handlers),
    );
    begunInFlight = settled;
    void settled.finally(() => {
      if (begunInFlight === settled) begunInFlight = null;
      if (sessionBeginning === begun) sessionBeginning = null;
    });
    return settled;
  }
  function started(pending: Activation, next: PlayerSession, origin: RunOrigin) {
    recoveryBegin = null;
    if (continuing?.id === next.id) continuing = null;
    showSession(next, origin, { sameChat: pending.sameChat === true });
    // A new session replaces the one kept before.
    if (pending.kind === "start") {
      keptOwner().forgetKeptPoint();
      keptOwner().forgetPresentation();
    }
  }

  return {
    activationRun,
    heldDebugRecording,
    hostError,
    lost,
    recoveryOffer,
    halting,
    reportActivationError,
    reportPageError,
    lose,
    activation,
    beginning,
    lastStart,
    supersede,
    prepare,
    prepareStart,
    prepareRestore,
    activate,
    temporalCapture,
    beforeRewindRestart,
    /** Remembers the Start a preparation of the script offers, and the source text of its files. */
    remember(create: PlayerSessionStart, sources?: ReadonlyMap<string, string>) {
      lastStart.value = create;
      if (sources !== undefined) scriptSources = sources;
    },
    /** The source text of a file of the script, or `null` when its host did not supply it. */
    scriptSource: (path: string): string | null => scriptSources.get(path) ?? null,
  };
}
