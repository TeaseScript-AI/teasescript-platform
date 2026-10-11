import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import ts from "typescript-vue";
import { registerTS } from "vue/compiler-sfc";
import { rekaScrollThumbPatch } from "./reka-scroll-thumb-patch.ts";

/** The build's identity for debug exports: the commit and whether it had uncommitted changes, `null` when unknown. */
function buildIdentity(mode: string) {
  const git = (...args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };
  const status = git("status", "--porcelain");
  const manifest: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: status === null ? null : status !== "",
    mode,
    appVersion:
      typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string"
        ? manifest.version
        : null,
  };
}

// Imported shadcn prop types need the classic TypeScript compiler API.
registerTS(() => ts);

export default defineConfig(({ mode }) => ({
  base: "/player/",
  define: { __PLAYER_BUILD__: JSON.stringify(buildIdentity(mode)) },
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss(), vue(), { ...rekaScrollThumbPatch(), apply: "build" }],
  // The development server pre-bundles reka-ui, so the patch applies there.
  optimizeDeps: { rolldownOptions: { plugins: [rekaScrollThumbPatch()] } },
  publicDir: false,
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL("../../dist/player-app", import.meta.url)),
    emptyOutDir: true,
    sourcemap: process.env.BUILD_SOURCEMAPS !== "0",
  },
}));
