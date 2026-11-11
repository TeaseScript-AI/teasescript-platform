// The Player development preview that `tools/player-preview-checks.mjs` starts when it is given no URL: Vite's server for
// this checkout on 127.0.0.1, on the first free port from 5173 up (Vite's own search), with the dependency cache folder
// given as the argument. It prints `READY <url>` once it listens.
//
// It exits as soon as its standard input ends. The parent holds that input as a pipe, so the preview ends with the
// parent however the parent ends, a SIGKILL included. Vite's command line does not: it never reads an input that is not
// a terminal, so it never sees the end (#2391). The handler comes first, so an end during startup ends it too.
import { fileURLToPath } from "node:url";

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

const cacheDir = process.argv[2];
if (!cacheDir) throw new Error("Pass the dependency cache folder.");
const { createServer } = await import("vite");
const server = await createServer({
  configFile: fileURLToPath(new URL("../player/vue/vite.config.ts", import.meta.url)),
  cacheDir,
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
});
await server.listen();
console.log(`READY ${server.resolvedUrls?.local[0]}`);
