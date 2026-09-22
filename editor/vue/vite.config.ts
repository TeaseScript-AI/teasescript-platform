import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/editor/",
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  preview: { allowedHosts: ["agents.home.arpa"] },
  publicDir: false,
  build: {
    outDir: fileURLToPath(new URL("../../dist/editor", import.meta.url)),
    sourcemap: process.env.BUILD_SOURCEMAPS !== "0",
    emptyOutDir: true,
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
