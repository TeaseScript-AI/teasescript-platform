import { createApp } from "vue";
import PlayerApp from "./PlayerApp.vue";
import { usePlayerSession } from "./usePlayerSession";
import "./style.css";

// Fixtures and labs live in a separate chunk: always on the development server, and in a build
// only after the explicit `?dev` opt-in. The default build shows only runtime-owned content.
const developmentPreview =
  import.meta.env.DEV || new URLSearchParams(window.location.search).has("dev");
const app = developmentPreview
  ? createApp((await import("./DevelopmentPreview.vue")).default)
  : createApp(PlayerApp, { player: usePlayerSession() });
app.mount("#app");
