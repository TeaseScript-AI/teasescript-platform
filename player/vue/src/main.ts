import { createApp, h } from "vue";
import { createPlayerRuntimeSession } from "../../runtime-adapter.js";
import { createLocalScriptStorage } from "../../script-storage.js";
import { demoSource, demoStorageScope, resolveDemoAsset } from "./demoHost";
import PlayerApp from "./PlayerApp.vue";
import { browserStorage } from "./usePlayerPreference";
import { usePlayerSession } from "./usePlayerSession";
import "./style.css";

// Fixtures and labs live in a separate chunk: always on the development server, and in a build
// only after the explicit `?dev` opt-in. The default build plays the repository demo through the runtime.
const developmentPreview =
  import.meta.env.DEV || new URLSearchParams(window.location.search).has("dev");
const app = developmentPreview
  ? createApp((await import("./DevelopmentPreview.vue")).default)
  : // The session host lives in a component scope, so unmounting stops its media, clock and listeners.
    createApp({
      setup: () => {
        const player = usePlayerSession({
          resolveAsset: resolveDemoAsset,
          scriptStorage: createLocalScriptStorage(browserStorage(), demoStorageScope),
        });
        // Stored values are read before Start, so Start runs within the player's activation.
        void player.loadScriptStorage().then(() =>
          player.prepare(() =>
            createPlayerRuntimeSession(demoSource, {
              ...player.scriptStorageOptions(),
              // Captured at Start: the session keeps this zone, presentation, and clock until a Continue.
              ...player.temporalCapture(),
            }),
          ),
        );
        return () => h(PlayerApp, { player });
      },
    });
app.mount("#app");
