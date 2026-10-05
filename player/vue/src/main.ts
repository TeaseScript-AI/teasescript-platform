import { createApp, h, shallowRef } from "vue";
import { openIndexedDbMediaRepository } from "../../indexeddb-media-repository.js";
import { compilePlayerProject, createPlayerRuntimeSession } from "../../runtime-adapter.js";
import { createLocalScriptStorage } from "../../script-storage.js";
import { demoSource, demoStorageScope, resolveDemoAsset } from "./demoHost";
import { developmentPackageHost } from "./packageHost";
import PlayerApp from "./PlayerApp.vue";
import type { ScriptFailure } from "./ScriptProblems.vue";
import { browserStorage } from "./usePlayerPreference";
import { usePlayerSession } from "./usePlayerSession";
import "./style.css";

// Fixtures and labs live in a separate chunk: always on the development server, and in a build
// only after the explicit `?dev` opt-in. The default build plays the repository demo through the runtime,
// or with `?package=<id>` a package of the playground server's development package root.
const query = new URLSearchParams(window.location.search);
const developmentPreview = import.meta.env.DEV || query.has("dev");
const packageId = query.get("package");
const host =
  packageId === null
    ? {
        storageScope: demoStorageScope,
        resolveAsset: resolveDemoAsset,
        load: async () => ({ project: demoSource, problems: [] }),
      }
    : developmentPackageHost(packageId);
const app = developmentPreview
  ? createApp((await import("./DevelopmentPreview.vue")).default, {
      // Durable captured media; when IndexedDB is unavailable, captures stay session media.
      capturedMediaRepository: await openIndexedDbMediaRepository().catch(() => null),
    })
  : // The session host lives in a component scope, so unmounting stops its media, clock and listeners.
    createApp({
      setup: () => {
        const player = usePlayerSession({
          resolveAsset: host.resolveAsset,
          scriptStorage: createLocalScriptStorage(browserStorage(), host.storageScope),
        });
        const failure = shallowRef<ScriptFailure | null>(null);
        // The script compiles, without running, before Start: one that does not compile shows its diagnostics.
        // Stored values are read before Start too, so Start runs within the player's activation.
        void Promise.all([host.load(), player.loadScriptStorage()]).then(
          ([{ project, problems }]) => {
            const compilation = compilePlayerProject(project);
            const plan = compilation.plan;
            if (plan === null) {
              failure.value = {
                title: "This script cannot start",
                problems: [...compilation.diagnostics, ...problems],
              };
              return;
            }
            player.prepare(() =>
              createPlayerRuntimeSession(plan, {
                ...player.scriptStorageOptions(),
                // Captured at Start: the session keeps this zone, presentation, and clock until a Continue.
                ...player.temporalCapture(),
              }),
            );
          },
          (error: unknown) => {
            failure.value = {
              title: "This package cannot be opened",
              problems: [{ message: error instanceof Error ? error.message : String(error) }],
            };
          },
        );
        return () => h(PlayerApp, { player, failure: failure.value });
      },
    });
app.mount("#app");
