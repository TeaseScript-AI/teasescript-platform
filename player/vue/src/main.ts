import { createApp, h } from "vue";
import { openEngineWorker } from "../../engine-bridge/browser-client.js";
import { openIndexedDbMediaRepository } from "../../media/indexeddb-media-repository.js";
import {
  memoryKeptRoomStore,
  memoryKeptSessionStore,
  openIndexedDbKeptRoomStore,
  openIndexedDbKeptSessionStore,
} from "../../persistence/kept-sessions.js";
import { browserSavedData } from "../../persistence/saved-data.js";
import { createLocalScriptStorage } from "../../persistence/script-storage.js";
import { demoSource, demoStorageScope, resolveDemoAsset } from "./demoHost";
import { prepareHostedScript, type ScriptHost } from "./hostedScript";
import { developmentPackageHost } from "./packageHost";
import PlayerApp from "./shell/PlayerApp.vue";
import { browserStorage } from "./shell/usePlayerPreference";
import { usePlayerSession } from "./session/usePlayerSession";
import "./style.css";

// Fixtures and labs live in a separate chunk: always on the development server, and in a build
// only after the explicit `?dev` opt-in. The default build plays the repository demo through the runtime,
// or with `?package=<id>` a package of the playground server's development package root; the development preview
// plays that package too, with its development tools.
// The engine's module Worker, started first so that its fetch and start overlap the page's IndexedDB opens: the one
// backend of this page, given to whichever page it shows. A Worker that cannot start rejects it before the page is
// built; the page shows that failure once it is, so the rejection is observed here and not reported as unhandled.
const bridge = openEngineWorker();
bridge.catch(() => {});
const query = new URLSearchParams(window.location.search);
const developmentPreview = import.meta.env.DEV || query.has("dev");
const packageId = query.get("package");
const host: ScriptHost =
  packageId === null
    ? {
        storageScope: demoStorageScope,
        resolveAsset: resolveDemoAsset,
        load: async () => ({ project: demoSource }),
      }
    : developmentPackageHost(packageId);
// Durable captured and chosen media; when IndexedDB is unavailable, it stays session media.
const capturedMediaRepository = await openIndexedDbMediaRepository().catch(() => null);
// Kept sessions and debug rooms outlive a reload and a closed browser; without IndexedDB they last as long as the page.
const keptSessions = await openIndexedDbKeptSessionStore().catch(() => memoryKeptSessionStore());
const debugRooms = await openIndexedDbKeptRoomStore().catch(() => memoryKeptRoomStore());
const app = developmentPreview
  ? createApp((await import("./development/DevelopmentPreview.vue")).default, {
      bridge,
      capturedMediaRepository,
      keptSessions,
      debugRooms,
      packageHost: packageId === null ? null : host,
    })
  : // The session host lives in a component scope, so unmounting stops its media, clock and listeners.
    createApp({
      setup: () => {
        const player = usePlayerSession({
          bridge,
          // After a lost connection, the player's click opens a fresh engine Worker, which the Player ends; this page
          // keeps the first one.
          nextConnection: openEngineWorker,
          resolveAsset: host.resolveAsset,
          scriptStorage: createLocalScriptStorage(browserStorage(), host.storageScope),
          // An image the script saves a reference to stays in this browser for later runs.
          capturedMedia: { repository: capturedMediaRepository },
          // Export and import of saved data cover every script this browser has played.
          savedData: browserSavedData(browserStorage(), capturedMediaRepository, keptSessions),
          keptSessions,
          debugRooms,
          // `room=debug` opens the script's debug room (DEBUGGER.md "Debug room"), any other URL its own.
          room: query.get("room") === "debug" ? "debug" : "normal",
          // The script's storage scope identifies it; development packages and the demo have no release version.
          debugPackage: { id: host.storageScope, version: null },
        });
        const { failure, identity } = prepareHostedScript(player, host);
        return () =>
          h(PlayerApp, {
            player,
            failure: failure.value,
            title: identity.value.title ?? "",
            author: identity.value.author ?? "",
            packageName: host.name ?? "",
          });
      },
    });
app.mount("#app");
