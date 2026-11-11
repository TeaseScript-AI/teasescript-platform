import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import { FileStoreService } from "../../../media/stored-files.js";
import { LockService, type LockDialog } from "../../../encryption/lock-service.js";
import {
  CaptureService,
  type PlayerDiagnostic,
  type SessionCamera,
} from "../../../media/session-camera.js";
import type { CapturedMediaStore } from "../../../media/captured-media.js";
import type { PlayerSession } from "../../../runtime/runtime-view.js";
import type { ServiceSection } from "../../../runtime/player-bridge.js";
import type { PlayerSessionOptions } from "./usePlayerSession.js";

/*
 * The services that answer a script's requests in service sections, moved from `usePlayerSession` unchanged: photo
 * capture, the file stores, and the locks with their dialog, with the preload of the lock code.
 */

/** What the session services need from the Player's session composable. */
interface SessionServicesHost {
  readonly camera: SessionCamera<MediaStreamTrack>;
  readonly capturedMedia: CapturedMediaStore;
  readonly reportDiagnostic: (diagnostic: PlayerDiagnostic) => void;
  readonly servicedSession: Readonly<Ref<PlayerSession | null>>;
  readonly generation: Readonly<Ref<number>>;
  readonly serviceSection: <T>(
    body: (section: ServiceSection, observed: PlayerSession | null) => Promise<T>,
  ) => Promise<T | null>;
  readonly options: PlayerSessionOptions;
}

export function usePlayerSessionServices({
  camera,
  capturedMedia,
  reportDiagnostic,
  servicedSession,
  generation,
  serviceSection,
  options,
}: SessionServicesHost) {
  const captures = new CaptureService(() => camera.answer(), {
    session: () => servicedSession.value,
    generation: () => generation.value,
    section: serviceSection,
    capturedMedia,
    diagnostic: reportDiagnostic,
    later: (task) => setTimeout(task, 0),
  });
  const serviceCapture = () => captures.request();
  // A new generation also retires an answer the services hold, while the serviced session stays `null` (#1882).
  watch([servicedSession, generation], () => void serviceCapture());
  // Stores and reads the files of `fileFromBase64`, `fileToBase64`, `toJson`, and `fromJson` as session media.
  const fileStores = new FileStoreService({
    session: () => servicedSession.value,
    generation: () => generation.value,
    section: serviceSection,
    media: capturedMedia,
    diagnostic: reportDiagnostic,
    later: (task) => setTimeout(task, 0),
  });
  watch([servicedSession, generation], () => fileStores.request());
  // Locks and opens text and stored files for encryptText, encryptFile, decryptText, and decryptFile, and presents
  // their dialogs; what the player types in them stays in the service's memory.
  const lockDialog = shallowRef<{ readonly dialog: LockDialog; readonly busy: boolean } | null>(
    null,
  );
  const locks = new LockService({
    session: () => servicedSession.value,
    generation: () => generation.value,
    section: serviceSection,
    media: capturedMedia,
    diagnostic: reportDiagnostic,
    dialog: (dialog, busy) => (lockDialog.value = dialog === null ? null : { dialog, busy }),
    later: (task) => setTimeout(task, 0),
    after: (delayMs, task) => {
      const timer = setTimeout(task, delayMs);
      return () => clearTimeout(timer);
    },
    subtle: globalThis.crypto?.subtle,
    ...(options.lockServices === undefined ? {} : { crypto: options.lockServices }),
  });
  watch([servicedSession, generation], () => locks.request());
  // A script that locks or opens loads the lock code while the Player is online, so locking works offline later; one
  // that locks also loads the public keys' code. The plan's host says which (`planMetadata`). A reply loads only while
  // its connection and token are still the serviced ones and the scope lives; a refused or lost one loads nothing. The
  // service loads the code itself where a step needs it, so a lock asked before the reply only waits for that import.
  let disposed = false;
  onScopeDispose(() => (disposed = true));
  watch(
    [
      () => servicedSession.value?.connection ?? null,
      () => servicedSession.value?.planToken ?? null,
    ],
    ([connection, plan]) => {
      if (connection === null || plan === null) return;
      connection.client.request("planMetadata", { plan }).then(
        (reply) => {
          const needs = reply.result;
          const now = servicedSession.value;
          if (disposed || now?.connection !== connection || now.planToken !== plan) return;
          if (needs?.locks !== true) return;
          void import("../../../encryption/content-lock.js").catch(() => {});
          void (
            options.lockServices?.tlock ?? (() => import("../../../encryption/time-lock.js"))
          )().catch(() => {});
          if (needs.encrypts)
            void (
              options.lockServices?.age ?? (() => import("../../../encryption/age.js"))
            )().catch(() => {});
        },
        // A Worker that is lost or ended loads nothing.
        () => {},
      );
    },
  );
  return { captures, fileStores, lockDialog, locks };
}
