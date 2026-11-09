// The gate host: one tree's playground server (its `dist/`, its Player build) over a packages folder, with two changes
// in front of its request handler, so that the measured time is the Player's and not the development host's:
//
// - each package's catalog (`/dev-package/<id>/catalog.json`) is scanned once at start and served from memory: the
//   playground scans the folder again on every request (`playground/server.ts`), which costs Clinic seconds;
// - the Player's hashed assets (`/player/assets/*`) are served gzip-compressed with
//   `Cache-Control: public, max-age=31536000, immutable`, as a static host would, so that a repeat load uses the HTTP
//   cache. Everything else is served as the playground serves it: uncompressed and `no-store`.
//
// `playerApp` serves another Player build (a gate variant) at `/player/` in place of the tree's; `routes` adds static
// folders by URL prefix (the bridge page's build, its inputs); `/gate-blank` is an empty page of the origin, where the
// keep scenario reads the store with no Player running. The report states this policy beside every number
// (`HOST_POLICY`).
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export const HOST_POLICY =
  "gate host: package catalogs scanned once and served from memory; /player/assets/* gzip, immutable for a year; everything else as the playground serves it (uncompressed, no-store)";

const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const typeOf = (path) => TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream";

/** The file under `root` that the URL path `rest` names, or `null` when it leaves `root`. */
function inside(root, rest) {
  const path = normalize(join(root, rest));
  return path === root || path.startsWith(root + sep) ? path : null;
}

/**
 * Starts the gate host for `tree` (a built repository tree) over `packagesRoot`, on `host:port` (0 picks a port).
 * Resolves with `{ origin, port, close }`; `close()` stops it and resolves once its port is free.
 */
export async function startGateHost({
  tree,
  packagesRoot,
  playerApp = null,
  routes = {},
  host = "127.0.0.1",
  port = 0,
}) {
  const root = resolve(tree);
  const { createPlaygroundServer } = await import(
    pathToFileURL(join(root, "dist/playground/server.js")).href
  );
  const { PackageRoot } = await import(
    pathToFileURL(join(root, "dist/playground/package-folder.js")).href
  );
  const packages = new PackageRoot(resolve(packagesRoot));
  const catalogs = new Map();
  for (const entry of await readdir(resolve(packagesRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = await packages.package(entry.name);
    if (folder !== null) catalogs.set(entry.name, Buffer.from(JSON.stringify(await folder.scan())));
  }
  const player = playerApp === null ? resolve(root, "dist/player-app") : resolve(playerApp);
  const assets = join(player, "assets");
  const compressed = new Map();
  const server = createPlaygroundServer({ projectRoot: root, packagesRoot: resolve(packagesRoot) });
  const [playground] = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    void serve(request, response).catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });

  async function serve(request, response) {
    const pathname = decodeURIComponent((request.url ?? "/").split("?", 1)[0]);
    const catalog = /^\/dev-package\/([^/]+)\/catalog\.json$/u.exec(pathname);
    if (catalog !== null && catalogs.has(catalog[1])) {
      response.writeHead(200, { "Content-Type": TYPES[".json"], "Cache-Control": "no-store" });
      response.end(catalogs.get(catalog[1]));
      return;
    }
    if (pathname === "/gate-blank") {
      response.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      response.end("<!doctype html><title>gate</title>");
      return;
    }
    if (playerApp !== null && (pathname === "/player/" || pathname === "/player/index.html")) {
      response.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-store" });
      response.end(await readFile(join(player, "index.html")));
      return;
    }
    if (pathname.startsWith("/player/assets/")) {
      const path = inside(assets, pathname.slice("/player/assets/".length));
      if (path !== null) {
        let body = compressed.get(path);
        if (body === undefined) {
          body = gzipSync(await readFile(path));
          compressed.set(path, body);
        }
        response.writeHead(200, {
          "Content-Type": typeOf(path),
          "Content-Encoding": "gzip",
          "Content-Length": body.length,
          "Cache-Control": "public, max-age=31536000, immutable",
          Vary: "Accept-Encoding",
        });
        response.end(body);
        return;
      }
    }
    for (const [prefix, folder] of Object.entries(routes)) {
      if (!pathname.startsWith(prefix)) continue;
      const rest = pathname.slice(prefix.length) || "index.html";
      const path = inside(resolve(folder), rest);
      const information = path === null ? null : await stat(path).catch(() => null);
      if (information === null || !information.isFile()) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": typeOf(path), "Cache-Control": "no-store" });
      createReadStream(path).pipe(response);
      return;
    }
    playground(request, response);
  }

  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, done);
  });
  const address = server.address();
  return {
    origin: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`,
    port: address.port,
    packages: [...catalogs.keys()],
    close: () =>
      new Promise((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
