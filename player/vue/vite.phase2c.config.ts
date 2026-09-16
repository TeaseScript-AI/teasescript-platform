import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import ts from "typescript-vue";
import { registerTS } from "vue/compiler-sfc";

// Imported shadcn prop types need the classic TypeScript compiler API.
registerTS(() => ts);

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss(), vue()],
  publicDir: false,
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL("../../dist/player-phase2c", import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { input: fileURLToPath(new URL("./phase2c/index.html", import.meta.url)) },
  },
});
