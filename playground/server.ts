import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLAYGROUND_EXAMPLES } from "./examples.js";
import { compileWorkspaceSource, executeWorkspaceSource, type WorkspaceResult } from "./workspace/controller.js";

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
  const workspace: AutomationWorkspace = { source: "", sourceRevision: 0, lastCompileResult: null, lastRunResult: null, resultRevision: null };

  return createServer((request, response) => {
    void serveRequest(request, { projectRoot, playgroundRoot, distRoot, examplesRoot }, workspace, response).catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: { code: "internalError", message: "Server error." } });
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

interface AutomationWorkspace {
  source: string;
  sourceRevision: number;
  lastCompileResult: WorkspaceResult | null;
  lastRunResult: WorkspaceResult | null;
  resultRevision: number | null;
}

async function serveRequest(
  request: IncomingMessage,
  roots: StaticRoots,
  workspace: AutomationWorkspace,
  response: ServerResponse,
): Promise<void> {
  const method = request.method ?? "GET";
  const requestUrl = request.url ?? "/";
  const rawPath = requestUrl.split("?", 1)[0] ?? "/";
  if (rawPath.startsWith("/api/workspace")) {
    await serveWorkspaceApi(request, rawPath, workspace, response);
    return;
  }
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

async function serveWorkspaceApi(request: IncomingMessage, pathname: string, workspace: AutomationWorkspace, response: ServerResponse): Promise<void> {
  if (!isLoopback(request.socket.remoteAddress)) {
    sendJson(response, 403, { error: { code: "loopbackOnly", message: "Workspace automation is available only to loopback clients." } });
    return;
  }
  const method = request.method ?? "GET";
  if (pathname === "/api/workspace" && method === "GET") {
    sendJson(response, 200, workspaceView(workspace));
    return;
  }
  if (pathname === "/api/workspace/result" && method === "GET") {
    const result = workspace.lastRunResult ?? workspace.lastCompileResult;
    sendJson(response, 200, { sourceRevision: workspace.sourceRevision, resultRevision: workspace.resultRevision, stale: workspace.resultRevision !== workspace.sourceRevision, result });
    return;
  }
  if (pathname === "/api/workspace/source" && method === "PUT") {
    if (!isUtf8Text(request.headers["content-type"])) {
      sendJson(response, 415, { error: { code: "unsupportedContentType", message: "Source uploads require Content-Type: text/plain; charset=utf-8." } });
      return;
    }
    const body = await readUtf8Body(request);
    if (!body.ok) { sendJson(response, body.status, { error: body.error }); return; }
    workspace.source = body.text;
    workspace.sourceRevision += 1;
    workspace.lastCompileResult = null;
    workspace.lastRunResult = null;
    workspace.resultRevision = null;
    sendJson(response, 200, workspaceView(workspace));
    return;
  }
  if ((pathname === "/api/workspace/compile" || pathname === "/api/workspace/run") && method === "POST") {
    if (await hasUnexpectedBody(request)) {
      sendJson(response, 400, { error: { code: "unexpectedBody", message: "This operation does not accept a request body." } }); return;
    }
    const result = pathname.endsWith("/compile") ? compileWorkspaceSource(workspace.source) : executeWorkspaceSource(workspace.source);
    workspace.lastCompileResult = pathname.endsWith("/compile") ? result : workspace.lastCompileResult;
    workspace.lastRunResult = pathname.endsWith("/run") ? result : workspace.lastRunResult;
    workspace.resultRevision = workspace.sourceRevision;
    sendJson(response, 200, { sourceRevision: workspace.sourceRevision, resultRevision: workspace.resultRevision, stale: false, result });
    return;
  }
  sendJson(response, 405, { error: { code: "methodNotAllowed", message: "Unsupported workspace route or method." } });
}

function workspaceView(workspace: AutomationWorkspace): object {
  return { source: workspace.source, sourceRevision: workspace.sourceRevision, resultRevision: workspace.resultRevision, stale: workspace.resultRevision !== workspace.sourceRevision, result: workspace.lastRunResult ?? workspace.lastCompileResult };
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isUtf8Text(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  return /^text\/plain(?:\s*;\s*charset=utf-8)?\s*$/iu.test(value);
}

async function readUtf8Body(request: IncomingMessage): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly status: number; readonly error: { readonly code: string; readonly message: string } }> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, status: 400, error: { code: "malformedUtf8", message: "Source must be valid UTF-8 text." } };
  }
}

async function hasUnexpectedBody(request: IncomingMessage): Promise<boolean> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/u.test(length) || Number(length) !== 0)) {
    request.resume();
    return true;
  }
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length !== 0) {
      request.resume();
      return true;
    }
  }
  return false;
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
    const relativePath = pathname.slice("/examples/".length);
    const allowed = Object.values(PLAYGROUND_EXAMPLES).some(
      (example) => relativePath === `playground/${example.file}`,
    );
    return allowed ? resolveInside(roots.examplesRoot, relativePath) : null;
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(text));
  response.setHeader("Cache-Control", "no-store");
  response.end(text);
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
