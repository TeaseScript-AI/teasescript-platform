import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";

// Monaco runs its editor services in a web worker. Vite bundles the worker as a chunk of the editor's own build, so
// it starts from the same origin without a CDN (#599).
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

createApp(App).mount("#app");
