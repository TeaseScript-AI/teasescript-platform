import { computed, ref, shallowRef, watch, type Ref } from "vue";
import { useIntervalFn } from "@vueuse/core";
import {
  isCapturedMediaReference,
  type CapturedMediaStore,
} from "../../../media/captured-media.js";
import {
  checkImageFile,
  type ImageDecoder,
  type ImageFileFilters,
} from "../../../media/image-file.js";
import {
  MediaDevice,
  MediaLoadQueue,
  type MediaDeviceElement,
} from "../../../media/media-device.js";
import {
  playerRuntimeMedia,
  playerRuntimeMediaOrigin,
  type PlayerSession,
} from "../../../runtime/runtime-view.js";
import {
  playerNoticeKeys,
  playerNotices,
  type PlayerNotice,
  type PlayerNotices,
} from "../../../presentation/notices.js";
import { bridgeOf, endsQuietly, type SessionSection } from "../../../runtime/player-bridge.js";
import type { Origin } from "./activation/useActivationRun.js";
import { BridgeRequestError } from "../../../engine-bridge/client.js";
import type { MediaReportOutcome } from "../../../../src/index.js";
import { silence } from "../generatedAudio";
import type { SectionWork, useRuntimeSceneClock } from "./useRuntimeSceneClock";

/*
 * The shown session's media on browser elements, moved from `usePlayerSession` unchanged: the audio device and its load
 * reports, the notices of media the Player cannot use, the Stage's image, and the image files a player chooses.
 */

const PRIMED_AUDIO_ELEMENTS = 2;
const SILENCE = silence(50);

// Media progress is sampled this often while media loads or plays; cues fire at this resolution.
const MEDIA_SAMPLE_MS = 100;

/** What the session's media need from the Player's session composable. */
interface SessionMediaHost {
  readonly session: Ref<PlayerSession | null>;
  readonly generation: Readonly<Ref<number>>;
  readonly held: Readonly<Ref<boolean>>;
  readonly stopped: Readonly<Ref<boolean>>;
  readonly notices: PlayerNotices;
  readonly capturedMedia: CapturedMediaStore;
  readonly resolvePackageAsset: (path: string) => string | null;
  readonly resolveAsset: (path: string) => string | null;
  readonly isDisposed: () => boolean;
  /** The activation live now, which a load report's failure stops. */
  readonly currentOrigin: () => Origin;
  /** The activation error-stop sink. */
  readonly reportActivationError: (origin: Origin, error: unknown) => void;
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
  /** The scene clock, read when used. */
  readonly clock: () => ReturnType<typeof useRuntimeSceneClock>;
  /** The decoder of chosen image files, read when used. */
  readonly decodeImage: () => ImageDecoder;
}

export function useSessionMedia({
  session,
  generation,
  held,
  stopped,
  notices,
  capturedMedia,
  resolvePackageAsset,
  resolveAsset,
  isDisposed,
  currentOrigin,
  reportActivationError,
  ownedSection,
  publishOwned,
  clock,
  decodeImage,
}: SessionMediaHost) {
  // A media file the script refers to but the Player cannot use is reported once per session and path, so a loop that
  // shows it again does not repeat the notice. Captured media is no package file and is never reported.
  let reportedMedia = new Set<string>();
  function reportUnusableMedia(path: string, notice: PlayerNotice) {
    if (isCapturedMediaReference(path) || reportedMedia.has(path)) return;
    reportedMedia.add(path);
    notices.publish(notice);
  }
  /** Reports media the Player could not load (`load`) or could not go on playing after it loaded (`playback`). */
  function reportFailedMedia(mediaId: number, phase: "load" | "playback") {
    const shown = session.value;
    if (shown === null) return;
    // As a call through the facade did: the session's replies still in transit apply first, so a medium an observation
    // already ended has no origin. With the Worker nothing arrives early, and the latest applied publication answers.
    const host = bridgeOf(shown);
    host.deliverInTransit?.(shown.id);
    const origin = playerRuntimeMediaOrigin(host.latest(shown) ?? shown, mediaId);
    if (!origin) return;
    const missing = resolvePackageAsset(origin.source) === null;
    // The Player cannot play video yet, so a video file that exists is not the script's problem.
    if (origin.media === "video" && !missing) return;
    reportUnusableMedia(
      origin.source,
      playerNotices.unusableMedia(
        origin.media,
        origin.source,
        missing ? "missing" : phase === "playback" ? "unplayable" : "failed",
        origin.location,
      ),
    );
  }

  const pendingLoadCount = ref(0);
  /**
   * Delivers queued load reports to the shown session, in one of its sections, after an observation when new reports
   * arrived. A report waits while the session is inspected or a draw waits, and while the runtime cannot take it yet
   * (`executionPending`). Only an accepted report shows: a refusal changed nothing, and showing it would retry at once.
   */
  const loads = new MediaLoadQueue(
    async (reports, observe, acknowledge) => {
      const current = session.value;
      // Its failure stops the activation live as it is sent, and none that began since (Q1 B).
      const origin = currentOrigin();
      // Without a session, nothing takes them.
      if (current === null) return reports.forEach(([mediaId]) => acknowledge(mediaId));
      try {
        const work = observe ? "mediaLoadObserved" : "mediaLoad";
        await ownedSection(current, work, async (section, owned, observed) => {
          if (observed === null) return;
          for (const [mediaId, report] of reports) {
            if (held.value || !owned()) return;
            const outcome = await section.send<MediaReportOutcome>("reportMediaLoad", {
              mediaId,
              report,
            });
            if (outcome.kind === "executionPending") continue;
            if (outcome.kind === "accepted") publishOwned(section.session);
            acknowledge(mediaId);
          }
        });
      } catch (error) {
        // Refusals changed nothing. A basis another op since replaced (the observation's) leaves the rest for the retry
        // its publication makes; a stopped session, or a lost Worker, takes nothing more, and the stop clears the queue. Any other error is
        // the Player's error stop, as a report's throw through the facade was, unless the session no longer owns the UI.
        if (endsQuietly(error) || (error instanceof BridgeRequestError && error.code === "basis"))
          return;
        if (!isDisposed() && !stopped.value && session.value?.lineage === current.lineage)
          reportActivationError(origin, error);
      }
    },
    () => (pendingLoadCount.value = loads.size),
  );
  // Audio elements reused across media. Browsers such as Safari allow playback per element only from a user
  // activation; an element that played during the activating click keeps that permission when its source changes.
  const audioElements: MediaDeviceElement[] = [];
  const device = new MediaDevice({
    createElement: () => audioElements.pop() ?? new Audio(),
    releaseElement: (element) => audioElements.push(element),
    resolveSource: resolveAsset,
    reportLoad: (mediaId, report, phase) => {
      if (report.kind === "failed") reportFailedMedia(mediaId, phase);
      loads.add(mediaId, report);
      pendingLoadCount.value = loads.size;
    },
    requestObservation: () => clock().before("audioEnded"),
    blockedChanged: (blocked) =>
      blocked
        ? notices.publish(playerNotices.audioBlocked(() => device.retryBlocked()))
        : notices.dismiss(playerNoticeKeys.audioBlocked),
  });
  const stageImage = computed(() =>
    session.value === null ? null : playerRuntimeMedia(session.value.state).stage.image,
  );
  // The Stage source the browser could not load, as the Stage reports it while it shows that source, or `null`. The
  // Stage keeps that image hidden while its source stays, also into a new session, which then gets no new browser error.
  const failedStageSource = shallowRef<string | null>(null);
  // The Stage source the browser has loaded and decoded, as the Stage reports it, or `null`; for Debug's Now view.
  const loadedStageSource = shallowRef<string | null>(null);
  // A speaker's avatar image that is no package file is reported as a Stage image is; the glyph shows instead. The
  // session adds its messages and speakers in place, so each published session's new messages are read, and a speaker
  // is checked when a message first shows it.
  let readEntries: PlayerSession["transcriptEntries"] | null = null;
  let readCount = 0;
  const checkedSpeakers = new Set<string>();
  /**
   * Checks an image file the player chose for the pending `askImage` and stores it as session media, like a photo.
   * Resolves to its reference, or to why the file is not accepted.
   */
  async function storeImageFile(
    file: File,
    filters: ImageFileFilters,
  ): Promise<{ readonly reference: string } | { readonly message: string }> {
    const checked = await checkImageFile(file, filters, decodeImage());
    if (!checked.ok) return { message: checked.message };
    // An unmounted Player keeps no media.
    if (isDisposed()) return { message: "This interaction is no longer available." };
    const stored = capturedMedia.add("image", checked.data, {
      width: checked.width,
      height: checked.height,
    });
    return { reference: stored.reference };
  }

  /**
   * Plays silence on spare audio elements within the activating click, so script audio may still play when the
   * session starts later, for example after a camera permission prompt. Two cover the common overlap of a
   * background loop and a cue; more elements fall back to the refused-playback retry.
   */
  function primeAudio() {
    while (audioElements.length < PRIMED_AUDIO_ELEMENTS) audioElements.push(new Audio());
    for (const element of audioElements) {
      element.src = SILENCE;
      void element.play().catch(() => {});
    }
  }

  return {
    pendingLoadCount,
    loads,
    audioElements,
    device,
    stageImage,
    failedStageSource,
    loadedStageSource,
    reportUnusableMedia,
    storeImageFile,
    primeAudio,
    /** A new session's media: what was reported of the session before is reported anew. */
    newSession() {
      reportedMedia = new Set();
    },
    /**
     * Watches the shown session's media: avatars and the Stage image for notices, the device's projection of the media,
     * and their sampling while media is active; at the place of the composable's setup they had.
     */
    watchMedia() {
      watch(session, (current) => {
        const entries = current?.transcriptEntries ?? null;
        if (entries !== readEntries) {
          readEntries = entries;
          readCount = 0;
          checkedSpeakers.clear();
        }
        if (current === null || entries === null) return;
        for (; readCount < entries.length; readCount++) {
          const entry = entries[readCount]!;
          if (entry.kind !== "message" || checkedSpeakers.has(entry.speakerId)) continue;
          checkedSpeakers.add(entry.speakerId);
          const image = current.speakers[entry.speakerId]?.avatarImage;
          if (image !== undefined && resolvePackageAsset(image) === null)
            reportUnusableMedia(image, playerNotices.unusableMedia("image", image, "missing"));
        }
      });
      // A Stage image that is no package file, or one the Stage shows as failed when a session starts.
      watch([generation, stageImage], ([, image]) => {
        if (image === null) return;
        if (resolvePackageAsset(image) === null)
          reportUnusableMedia(image, playerNotices.unusableMedia("image", image, "missing"));
        else if (
          failedStageSource.value !== null &&
          resolveAsset(image) === failedStageSource.value
        )
          reportUnusableMedia(image, playerNotices.unusableMedia("image", image, "failed"));
      });

      watch(
        [session, held],
        ([current, paused]) => {
          // A stopped session keeps no media.
          const media = current && !stopped.value ? playerRuntimeMedia(current.state).media : [];
          // An inspected state, and a draw that waits, show their media where they were, without playing them.
          device.reconcile(
            paused
              ? media.map((projection) => ({ ...projection, state: "paused" as const }))
              : media,
          );
          loads.retry();
          pendingLoadCount.value = loads.size;
        },
        { immediate: true },
      );
      // Media cues depend on measured progress, not on a deadline, so observe regularly while media is active.
      const sampling = useIntervalFn(clock().catchUp, MEDIA_SAMPLE_MS, { immediate: false });
      // Pending load reports also keep observing, so the engine runs until it can accept them.
      watch(
        () => session.value !== null && (device.active || pendingLoadCount.value > 0),
        (active) => (active ? sampling.resume() : sampling.pause()),
        { immediate: true },
      );
    },
  };
}
