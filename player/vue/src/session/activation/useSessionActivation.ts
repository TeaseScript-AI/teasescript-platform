import { ref, shallowRef, type Ref } from "vue";
import { NO_MARKS, type HistoryMarks } from "../../../../debug-history-marks.js";
import type { DebugRecording } from "../../../../debug-recorder.js";
import { heldRecording, introduceNow } from "../../../../engine-bridge/in-process.js";
import type { PlayerRuntimeSession } from "../../../../runtime-adapter.js";
import { playerTemporalContext, type PlayerSession } from "../../../../runtime-view.js";
import { bridgeOf, endsQuietly, type PlayerBridge } from "../../../../player-bridge.js";
import type { RandomIntent, TracingIntent } from "../../../../engine-bridge/player-ops.js";
import type { StartRandom } from "../../../../engine-bridge/ops/session.js";
import type { TemporalContext } from "../../../../../src/index.js";
import type { Problem } from "../../ProblemCard.vue";
import type { PlayerSessionOptions, PlayerSessionStart } from "../../usePlayerSession.js";
import type { useKeptSession } from "../persistence/useKeptSession.js";
import { stopArguments, useActivationRun, type ActivationRun } from "./useActivationRun.js";

/*
 * The activation under way, moved from `usePlayerSession` unchanged: its preparation as Start or Continue, the click
 * that begins it, its begin and completion in its run (`useActivationRun`), and its error stop.
 */

/** What Start and Continue record of the player's click: the zone and presentation, and the wall clock. */
type TemporalCapture = { temporalContext: TemporalContext; wallClockMs: number };

type Activation = {
  readonly kind: "start" | "continue";
  /** Begins the session; a Start or Continue over the bridge resolves once its first publication is applied. */
  readonly begin: (origin: ActivationRun) => PlayerSession | Promise<PlayerSession>;
  /** The restored session Continue goes on with. */
  readonly restored?: PlayerSession;
  /** Why Start shows instead of Continue: the kept session is of a format this Player no longer reads. */
  readonly outdated?: Problem;
};

/** What the activation needs from the Player's session composable. */
interface SessionActivationHost {
  readonly options: PlayerSessionOptions;
  readonly session: Ref<PlayerSession | null>;
  readonly stopped: Readonly<Ref<boolean>>;
  /** The engine's host now, or `null` before it is ready. */
  readonly bridgeNow: () => PlayerBridge | null;
  readonly bridgeReady: Promise<PlayerBridge>;
  readonly requireBridge: () => PlayerBridge;
  readonly isDisposed: () => boolean;
  readonly showSession: (next: PlayerSession) => void;
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
  readonly adoptRandom: (next: PlayerSession, origin?: ActivationRun | null) => void;
  readonly startRandom: () => StartRandom | undefined;
  readonly random: { issuedRandom(): RandomIntent | undefined };
  readonly resolveTemporalContext: () => TemporalContext;
}

export function useSessionActivation({
  options,
  session,
  stopped,
  bridgeNow,
  bridgeReady,
  requireBridge,
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
  const activationRun = useActivationRun();
  /**
   * The recording the host holds for diagnostics and tests: a Player error's, while its captured ticket is held, else
   * the recorder's current one. Not a debug export's selection (the failure recording's `selection()`), which waits for
   * a pending capture and selects none where it settled unavailable.
   */
  const heldDebugRecording = (): DebugRecording | null => {
    const failed = activationRun.current()?.failure.ticket() ?? null;
    if (failed !== null) return heldRecording(failed.bridge, failed.ticket);
    return bridgeNow() === null ? null : heldRecording(bridgeNow()!);
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
   * is `origin`'s, the live activation's by default: a deferred completion passes the activation it began in, and one
   * of a retired activation does nothing (`useActivationRun`).
   */
  function reportHostError(error: unknown, origin: ActivationRun | null = activationRun.current()) {
    if (origin !== null && !activationRun.admits(origin)) return;
    const name = error instanceof Error ? error.name : "Error";
    console.error("[player] host error", error);
    const restoring = continuing;
    const starting = sessionBeginning;
    continuing = null;
    activationToken += 1;
    beginning.value = false;
    const stop = activationToken;
    const target = session.value ?? restoring;
    // A Continue still beginning beside a shown session runs nothing more either.
    if (restoring !== null && restoring !== target) void bridgeOf(restoring).halt(restoring);
    if (target !== null) return stopAt(target, name, stop, origin);
    // Without a session to stop, the run's incident is committed by itself.
    const incident = () => {
      const args = stopArguments(origin, name, stop);
      if (origin !== null && args !== null && activationRun.admits(origin))
        void origin.bridge.commitIncident(args).catch(() => {});
    };
    if (starting === null) {
      hostError.value = name;
      incident();
      return;
    }
    haltUntil(stop);
    void starting.then(
      (started) => {
        // A retired activation's late session is only stopped, with no incident and no capture.
        if (origin !== null && !activationRun.admits(origin)) {
          endHalting(stop);
          return void bridgeOf(started).halt(started);
        }
        stopAt(started, name, stop, origin);
      },
      () => {
        endHalting(stop);
        if (stop !== activationToken || (origin !== null && !activationRun.admits(origin))) return;
        hostError.value ??= name;
        incident();
      },
    );
  }
  /**
   * Stops at `target` in `origin`'s run: once its store froze at the host's acknowledgement, its last publication is the
   * shown session, which the recording and export hold, and the stop renders. A later activation or unmount supersedes
   * it; a retired `origin` stops nothing.
   */
  function stopAt(target: PlayerSession, name: string, stop: number, origin: ActivationRun | null) {
    if (origin !== null && !activationRun.admits(origin)) return endHalting(stop);
    const host = bridgeOf(target);
    const acknowledged = host.halt(target, stopArguments(origin, name, stop));
    origin?.failure.stopped(target);
    const commit = () => {
      const live = origin === null ? !isDisposed() : activationRun.admits(origin);
      if (!live || stop !== activationToken) return endHalting(stop);
      // The final publication shows, then the stop; the halt holds the session stopped until then, so nothing reacting
      // to that publication (the stop's call view, also of an unchanged state) sees it running for a moment.
      const final = host.latest(target);
      if (final !== null) session.value = final;
      hostError.value ??= name;
      endHalting(stop);
    };
    if (host.frozen(target)) return commit();
    haltUntil(stop);
    void acknowledged.then(commit);
  }
  const activation = shallowRef<Activation | null>(null);
  let activationToken = 0;
  // A Continue under way in the host, whose session no other activation may let run on; see `supersede`.
  let continuing: PlayerSession | null = null;
  // The Start or Continue still beginning over the bridge. A later activation begins only once it settled, so the
  // obsolete one's requests run in the host before the replacement's, which claims the recorder and trace last.
  let begunInFlight: Promise<void> | null = null;
  // The session that Start or Continue is beginning, once the host names it; an error stop stops at it.
  let sessionBeginning: Promise<PlayerSession> | null = null;
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
    return activationRun.current()?.failure.beforeRestart();
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
    activation.value = {
      kind: "start",
      begin: (origin) => startedSession(create, { debugMode: debugModeOn() }, origin),
      ...(outdated === undefined ? {} : { outdated }),
    };
    prepareActivation("start");
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
   * The capture of the activation's click while its `begin` runs (#1886): Start's factories and options and Continue's
   * `begin` record it through `temporalCapture()`, whatever the activation waited for since the click.
   */
  let clicked: ClickSample | null = null;
  /**
   * Shows the explicit Continue control for a restored session; its execution, time and media resume only then.
   * Continue records the wall clock and the player's zone and presentation as they are now.
   */
  function prepareRestore(given: PlayerRuntimeSession, marks?: HistoryMarks): void;
  function prepareRestore(given: PlayerSession): void;
  function prepareRestore(given: PlayerSession | PlayerRuntimeSession, marks?: HistoryMarks) {
    // A session restored outside the host, such as one an embedding host restored, is registered there first, with
    // the marks it was given (none for an outside restore); a session the host holds keeps the host's.
    const restored =
      "lineage" in given ? given : introduceNow(requireBridge(), () => given, marks ?? NO_MARKS);
    supersede();
    beginning.value = false;
    camera.release();
    activation.value = {
      kind: "continue",
      begin: async (origin) => {
        const host = bridgeOf(restored);
        continuing = restored;
        // A restored session runs without Debug's random control until its kept draw went on naturally, as before: one
        // a Start or an adoption gave this Player's control first gives it up (`adoptRandom` below takes it again).
        if (random.issuedRandom() !== undefined)
          void host.client
            .request("releaseRandom", { session: restored.id }, { after: restored.id })
            .catch(() => {});
        // Only the activation that began it goes on after each reply: a replaced one touches no trace or recorder.
        const owner = activationToken;
        const owned = () => {
          if (isDisposed() || owner !== activationToken || !activationRun.admits(origin))
            throw new Error("A replaced Continue goes no further.");
        };
        // Continue records the zone, presentation and clock of the click (#1886), before any reply or wait. A capture
        // that throws fails the Continue where it failed before: after its recording began, so the failure's recording
        // is the restored session's, not the previous one's.
        let taken: ClickSample;
        try {
          taken = { capture: temporalCapture() };
        } catch (error) {
          taken = { error };
        }
        // The recording of a restored session starts from the state it continues, and so does a new epoch of the
        // host's value trace, once the Continue owns the UI. The epoch's request is not awaited: the host runs it
        // before what follows (a draw's resume, Debug mode, Continue).
        await host.request(restored, "beginRecording", origin.begin);
        owned();
        const tracing = tracingIntent();
        if (tracing?.on)
          void host.request(restored, "restartTrace", { tracing }).catch((error: unknown) => {
            if (!endsQuietly(error) && !isDisposed() && !stopped.value)
              reportHostError(error, origin);
          });
        let continued: PlayerSession = host.latest(restored) ?? restored;
        // A session kept while paused at a random draw goes on with its natural outcome first: until then, the engine
        // takes no other input.
        // It runs without Debug's random control until then, as before, and adopts it after (`adoptRandom` below).
        const draw = continued.state.randomDraw;
        if (draw !== null) {
          await host.request(continued, "resolveDraw", {
            drawId: draw.drawId,
            outcome: "natural",
            record: null,
          });
          owned();
          continued = host.latest(continued) ?? continued;
        }
        // The script reads whether Debug is on now.
        if (continued.state.debugMode !== debugModeOn()) {
          await host.request(continued, "setDebugMode", { on: debugModeOn() });
          owned();
          continued = host.latest(continued) ?? continued;
        }
        adoptRandom(continued, origin);
        if (!("capture" in taken)) throw taken.error;
        await host.request(continued, "continue", { capture: taken.capture });
        owned();
        return host.latest(continued) ?? continued;
      },
      restored,
    };
    prepareActivation("continue");
  }
  /**
   * Runs the prepared Start or Continue; call it from the activating click. With the camera capability it first opens
   * the session camera, so any browser permission request happens here, before ordinary script execution. A camera
   * failure never prevents the session from starting. Start then reads the stored values again, which another tab may
   * have changed since they were read; Continue goes on with its session's own view of them.
   */
  async function activate() {
    const pending = activation.value;
    if (!pending || clearing().value || importing().value) return;
    activation.value = null;
    // The activation it replaces, such as a Continue still beginning, goes.
    supersede();
    const token = activationToken;
    const withCamera = options.capabilities?.camera === true;
    const reading = pending.kind === "start" && hasScriptStorage();
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
        await startFrom(pending, sample ?? sampleClick());
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
      await startFrom(pending, sample ?? sampleClick());
    } finally {
      if (token === activationToken) beginning.value = false;
    }
  }
  /**
   * The session `create` makes: a held plan over the bridge (`start`), a transitional factory in the host before its
   * first run (`introduceNow`). Either runs with the host's value trace, and carries its Player's random ownership, as
   * only a Start does; a restore takes it at its adoption.
   */
  function startedSession(
    create: PlayerSessionStart,
    recording: { readonly debugMode: boolean },
    origin: ActivationRun,
  ): PlayerSession | Promise<PlayerSession> {
    const random = startRandom();
    const host = requireBridge();
    // A factory, as the Start's options, records the click's capture through `temporalCapture()`, which `begin` binds.
    if (typeof create === "function")
      return introduceNow(
        host,
        (made) =>
          create({
            ...recording,
            recorder: made.recorder,
            ...(made.debugTrace === null ? {} : { debugTrace: made.debugTrace }),
            ...(made.randomControl === null ? {} : { randomControl: made.randomControl }),
          }),
        NO_MARKS,
        tracingIntent(),
        random,
        origin.begin,
      );
    const startOptions = { ...create.options(), debugMode: recording.debugMode };
    return host.start(create.plan, startOptions, true, random, origin.begin);
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
      return bridgeReady.then(() => {
        if (!isDisposed() && token === activationToken) return startFrom(pending, sample);
      });
    hostError.value = null;
    // The activation's run begins before anything of it can fail, retiring the one before it.
    const origin = activationRun.begin(bridgeNow()!);
    let begun: PlayerSession | Promise<PlayerSession>;
    // `begin` records the click's capture: it reads it before its first await, a Start in its factory or options.
    clicked = sample;
    try {
      begun = pending.begin(origin);
    } catch (error) {
      reportHostError(error, origin);
      return;
    } finally {
      clicked = null;
    }
    if (!(begun instanceof Promise)) return started(pending, begun);
    sessionBeginning = begun;
    const settled = begun.then(
      (next) => {
        if (!isDisposed() && token === activationToken && activationRun.admits(origin))
          started(pending, next);
      },
      (error: unknown) => {
        // An obsolete activation's failure stops nothing: the session that replaced it goes on.
        if (!isDisposed() && token === activationToken && activationRun.admits(origin))
          reportHostError(error, origin);
      },
    );
    begunInFlight = settled;
    void settled.finally(() => {
      if (begunInFlight === settled) begunInFlight = null;
      if (sessionBeginning === begun) sessionBeginning = null;
    });
    return settled;
  }
  function started(pending: Activation, next: PlayerSession) {
    if (continuing?.id === next.id) continuing = null;
    showSession(next);
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
    halting,
    reportHostError,
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
