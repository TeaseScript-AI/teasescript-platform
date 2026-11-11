import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, type Plugin } from "vite";
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

/**
 * The development server answers `<base>__checkout` with the real path of the repository it serves, so that
 * `tools/player-preview-checks.mjs` can refuse a preview of another checkout.
 */
const servedCheckout: Plugin = {
  name: "served-checkout",
  apply: "serve",
  configureServer(server) {
    const checkout = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
    server.middlewares.use(`${server.config.base}__checkout`, (_request, response) => {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(checkout);
    });
  },
};

// Imported shadcn prop types need the classic TypeScript compiler API.
registerTS(() => ts);

export default defineConfig(({ mode }) => ({
  base: "/player/",
  define: { __PLAYER_BUILD__: JSON.stringify(buildIdentity(mode)) },
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [tailwindcss(), vue(), { ...rekaScrollThumbPatch(), apply: "build" }, servedCheckout],
  // The development server pre-bundles reka-ui, so the patch applies there.
  optimizeDeps: { rolldownOptions: { plugins: [rekaScrollThumbPatch()] } },
  publicDir: false,
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Module Workers, bundled as ES modules: the engine Worker's entry loads its host by `import()`, and its compiler is a
  // chunk of its own that only a source preparation loads, which Vite's default classic-script format cannot split.
  worker: { format: "es" },
  build: {
    outDir: fileURLToPath(new URL("../../dist/player-app", import.meta.url)),
    emptyOutDir: true,
    target: "es2025",
    sourcemap: process.env.BUILD_SOURCEMAPS !== "0",
  },
}));
