import { createApp, h } from "vue";
import { openIndexedDbMediaRepository } from "../../indexeddb-media-repository.js";
import { browserSavedData } from "../../saved-data.js";
import { createLocalScriptStorage } from "../../script-storage.js";
import { demoSource, demoStorageScope, resolveDemoAsset } from "./demoHost";
import { prepareHostedScript, type ScriptHost } from "./hostedScript";
import { developmentPackageHost } from "./packageHost";
import PlayerApp from "./PlayerApp.vue";
import { browserStorage } from "./usePlayerPreference";
import { usePlayerSession } from "./usePlayerSession";
import "./style.css";

// Fixtures and labs live in a separate chunk: always on the development server, and in a build
// only after the explicit `?dev` opt-in. The default build plays the repository demo through the runtime,
// or with `?package=<id>` a package of the playground server's development package root; the development preview
// plays that package too, with its development tools.
const query = new URLSearchParams(window.location.search);
const developmentPreview = import.meta.env.DEV || query.has("dev");
const packageId = query.get("package");
const host: ScriptHost =
  packageId === null
    ? {
        storageScope: demoStorageScope,
        resolveAsset: resolveDemoAsset,
        load: async () => ({ project: demoSource, problems: [] }),
      }
    : developmentPackageHost(packageId);
// Durable captured and chosen media; when IndexedDB is unavailable, it stays session media.
const capturedMediaRepository = await openIndexedDbMediaRepository().catch(() => null);
const app = developmentPreview
  ? createApp((await import("./DevelopmentPreview.vue")).default, {
      capturedMediaRepository,
      packageHost: packageId === null ? null : host,
    })
  : // The session host lives in a component scope, so unmounting stops its media, clock and listeners.
    createApp({
      setup: () => {
        const player = usePlayerSession({
          resolveAsset: host.resolveAsset,
          scriptStorage: createLocalScriptStorage(browserStorage(), host.storageScope),
          // An image the script saves a reference to stays in this browser for later runs.
          capturedMedia: { repository: capturedMediaRepository },
          // Export and import of saved data cover every script this browser has played.
          savedData: browserSavedData(browserStorage(), capturedMediaRepository),
        });
        const failure = prepareHostedScript(player, host);
        return () => h(PlayerApp, { player, failure: failure.value });
      },
    });
app.mount("#app");
