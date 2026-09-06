import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/player-vue/",
  build: {
    // Preserve progressive scroll-control selectors until the bundler recognizes them.
    cssMinify: false,
    emptyOutDir: true,
    outDir: fileURLToPath(new URL("../../dist/player-vue", import.meta.url)),
    sourcemap: true,
  },
  plugins: [tailwindcss(), vue()],
  publicDir: false,
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
