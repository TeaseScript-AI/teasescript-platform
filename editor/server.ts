import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORT = 4174;

export interface EditorServerOptions {
  readonly rootDirectory?: string;
  readonly port?: number;
  readonly host?: string;
}

export function createEditorServer(options: EditorServerOptions = {}): Server {
  const root = resolve(options.rootDirectory ?? process.cwd());
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const file = routeFile(root, url.pathname);
      if (file === null) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }
      const content = await readFile(file);
      response.statusCode = 200;
      response.setHeader("Content-Type", contentType(file));
      response.setHeader("Cache-Control", "no-store");
      response.end(content);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      response.statusCode = code === "ENOENT" ? 404 : 500;
      response.end(code === "ENOENT" ? "Not found" : "Editor server error");
    }
  });
}

export async function startEditorServer(options: EditorServerOptions = {}): Promise<Server> {
  const server = createEditorServer(options);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? resolvePort(process.env.TEASESCRIPT_EDITOR_PORT);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return server;
}

function routeFile(root: string, pathname: string): string | null {
  if (pathname === "/" || pathname === "/editor" || pathname === "/editor/") {
    return resolveInside(root, "editor/index.html");
  }
  if (pathname === "/editor/styles.css") return resolveInside(root, "editor/styles.css");
  if (pathname.startsWith("/dist/")) return resolveInside(root, pathname.slice(1));
  if (pathname.startsWith("/monaco/vs/")) {
    return resolveInside(root, `node_modules/monaco-editor/min/vs/${pathname.slice("/monaco/vs/".length)}`);
  }
  return null;
}

function resolveInside(root: string, path: string): string | null {
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return resolved;
  return null;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css": return "text/css; charset=utf-8";
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".ttf": return "font/ttf";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function resolvePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("TEASESCRIPT_EDITOR_PORT must be an integer from 1 through 65535.");
  }
  return port;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startEditorServer();
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : DEFAULT_PORT;
  process.stdout.write(`TeaseScript editor POC: http://127.0.0.1:${port}/editor/\n`);
}
