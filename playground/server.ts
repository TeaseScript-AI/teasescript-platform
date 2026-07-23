import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PlaygroundServerOptions {
  readonly projectRoot?: string;
}

export interface StartPlaygroundServerOptions extends PlaygroundServerOptions {
  readonly host?: string;
  readonly port?: number;
}

export function createPlaygroundServer(
  options: PlaygroundServerOptions = {},
): Server {
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot());
  const playgroundRoot = resolve(projectRoot, "playground");
  const distRoot = resolve(projectRoot, "dist");
  const examplesRoot = resolve(projectRoot, "examples");

  return createServer((request, response) => {
    void serveRequest(
      request.method ?? "GET",
      request.url ?? "/",
      { projectRoot, playgroundRoot, distRoot, examplesRoot },
      response,
    ).catch(() => {
      if (!response.headersSent) sendText(response, 500, "Server error.\n", false);
      else response.destroy();
    });
  });
}

export async function startPlaygroundServer(
  options: StartPlaygroundServerOptions = {},
): Promise<Server> {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? environmentPort(process.env.PORT) ?? 4173;
  if (host.length === 0) throw new TypeError("HOST must not be empty.");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("PORT must be an integer from 1 through 65535.");
  }
  const server = createPlaygroundServer(options);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const printableHost = host.includes(":") ? `[${host}]` : host;
  process.stdout.write(`TeaseScript playground: http://${printableHost}:${port}/\n`);
  return server;
}

interface StaticRoots {
  readonly projectRoot: string;
  readonly playgroundRoot: string;
  readonly distRoot: string;
  readonly examplesRoot: string;
}

async function serveRequest(
  method: string,
  requestUrl: string,
  roots: StaticRoots,
  response: import("node:http").ServerResponse,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    sendText(response, 405, "Method not allowed.\n", method === "HEAD");
    return;
  }

  let pathname: string;
  try {
    const rawPath = requestUrl.split("?", 1)[0] ?? "/";
    pathname = decodeURIComponent(rawPath);
  } catch {
    sendText(response, 400, "Malformed request path.\n", method === "HEAD");
    return;
  }
  if (unsafePath(pathname)) {
    sendText(response, 400, "Rejected unsafe request path.\n", method === "HEAD");
    return;
  }

  const target = resolveTarget(pathname, roots);
  if (target === null) {
    sendText(response, 404, "Not found.\n", method === "HEAD");
    return;
  }
  try {
    const [canonicalRoot, canonicalPath] = await Promise.all([
      realpath(target.root),
      realpath(target.path),
    ]);
    if (!isInside(canonicalRoot, canonicalPath)) {
      sendText(response, 400, "Rejected unsafe request path.\n", method === "HEAD");
      return;
    }
    const information = await stat(canonicalPath);
    if (!information.isFile()) {
      sendText(response, 404, "Not found.\n", method === "HEAD");
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType(target.path));
    response.setHeader("Content-Length", information.size);
    response.setHeader("Cache-Control", "no-store");
    if (method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(canonicalPath);
    stream.on("error", () => {
      if (!response.headersSent) sendText(response, 500, "Unable to read file.\n", false);
      else response.destroy();
    });
    stream.pipe(response);
  } catch (error) {
    const code = isNodeError(error) ? error.code : "";
    sendText(
      response,
      code === "ENOENT" || code === "ENOTDIR" ? 404 : 500,
      code === "ENOENT" || code === "ENOTDIR" ? "Not found.\n" : "Server error.\n",
      method === "HEAD",
    );
  }
}

interface StaticTarget {
  readonly root: string;
  readonly path: string;
}

function resolveTarget(pathname: string, roots: StaticRoots): StaticTarget | null {
  if (pathname === "/") {
    return { root: roots.playgroundRoot, path: resolve(roots.playgroundRoot, "index.html") };
  }
  if (pathname === "/playground.css") {
    return { root: roots.playgroundRoot, path: resolve(roots.playgroundRoot, "playground.css") };
  }
  if (pathname.startsWith("/dist/")) {
    return resolveInside(roots.distRoot, pathname.slice("/dist/".length));
  }
  if (pathname.startsWith("/examples/")) {
    return resolveInside(roots.examplesRoot, pathname.slice("/examples/".length));
  }
  return null;
}

function resolveInside(root: string, relativePath: string): StaticTarget | null {
  if (relativePath.length === 0) return null;
  const target = resolve(root, relativePath);
  return isInside(root, target) ? { root, path: target } : null;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function unsafePath(pathname: string): boolean {
  return (
    pathname.includes("\\") ||
    pathname.includes("\0") ||
    pathname.split("/").some((segment) => segment === ".." || segment === ".")
  );
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json":
    case ".map": return "application/json; charset=utf-8";
    case ".tease":
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function sendText(
  response: import("node:http").ServerResponse,
  status: number,
  body: string,
  headOnly: boolean,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(headOnly ? undefined : body);
}

function environmentPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/u.test(value)) throw new RangeError("PORT must be a decimal integer.");
  return Number(value);
}

function defaultProjectRoot(): string {
  return resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(resolve(invokedPath)).href
) {
  await startPlaygroundServer();
}
