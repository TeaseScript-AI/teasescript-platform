import { createApp, h } from "vue";
import { ONLINE_TOKEN_ITEM, playerDataContext } from "../../player-data.js";
import { demoSource, demoStorageScope, resolveDemoAsset } from "./demoHost";
import { prepareHostedScript, type ScriptHost } from "./hostedScript";
import { developmentPackageHost } from "./packageHost";
import PlayerApp from "./PlayerApp.vue";
import { openPlayerStores } from "./playerStores";
import type { ScriptFailure } from "./ScriptProblems.vue";
import { usePlayerSession } from "./usePlayerSession";
import "./style.css";

// Fixtures and labs live in a separate chunk: always on the development server, and in a build
// only after the explicit `?dev` opt-in. The default build plays the repository demo through the runtime,
// or with `?package=<id>` a package of the playground server's development package root; the development preview
// plays that package too, with its development tools.
const query = new URLSearchParams(window.location.search);
const developmentPreview = import.meta.env.DEV || query.has("dev");
const packageId = query.get("package");
const scriptHost: ScriptHost =
  packageId === null
    ? {
        storageScope: demoStorageScope,
        resolveAsset: resolveDemoAsset,
        load: async () => ({ project: demoSource, problems: [] }),
      }
    : developmentPackageHost(packageId);
// Every store of the player's data, in the data mode the host chose (`player-data.ts`). When they cannot be opened,
// the Player shows why instead of Start and keeps no data, rather than mixing one mode's data into the other's.
const { stores, dataFailure } = await Promise.resolve()
  .then(() => openPlayerStores(playerDataContext(new URL(window.location.href), onlineToken())))
  .then(
    (stores) => ({ stores, dataFailure: null }),
    (error: unknown) => ({
      stores: null,
      dataFailure: {
        title: "The Player cannot open its data",
        problems: [{ message: error instanceof Error ? error.message : String(error) }],
      } satisfies ScriptFailure,
    }),
  );
// Online, the account's player profile replaces the one a package gives.
const host: ScriptHost =
  stores?.playerProfile === undefined
    ? scriptHost
    : { ...scriptHost, playerProfile: stores.playerProfile };
const app =
  stores === null
    ? createApp({
        setup: () => {
          const player = usePlayerSession();
          return () => h(PlayerApp, { player, failure: dataFailure });
        },
      })
    : developmentPreview
      ? createApp((await import("./DevelopmentPreview.vue")).default, {
          stores,
          packageHost: packageId === null ? null : host,
        })
      : // The session host lives in a component scope, so unmounting stops its media, clock and listeners.
        createApp({
          setup: () => {
            const player = usePlayerSession({
              resolveAsset: host.resolveAsset,
              // Saved values, photos that a saved value references, the kept session, and the debug room; export and
              // import of saved data cover every script the player has played.
              ...stores.storage(host.storageScope),
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
                storagePersistent: stores.persistent?.value,
              });
          },
        });
app.mount("#app");

/** The token the host left for online mode, or `null`; a host frame that denies session storage leaves none. */
function onlineToken(): string | null {
  try {
    return window.sessionStorage.getItem(ONLINE_TOKEN_ITEM);
  } catch {
    return null;
  }
}
