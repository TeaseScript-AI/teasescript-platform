import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLAYGROUND_EXAMPLES } from "./examples.js";
import {
  isPackageId,
  PACKAGE_IMAGE_EXTENSIONS,
  PACKAGE_MEDIA_EXTENSIONS,
  PackageFolder,
  PackageRoot,
} from "./package-folder.js";
import {
  compileWorkspaceSource,
  executeWorkspaceSource,
  type WorkspaceResult,
} from "./workspace/controller.js";
import { playgroundCertificate, playgroundCertificateNames } from "./tls.js";

export interface PlaygroundServerOptions {
  readonly projectRoot?: string;
  /**
   * A development package folder (#572): its images with their XMP tags, its audio and video files, and its `.tease`
   * files are offered at `/dev-package/catalog.json`, and its images, audio, and video at `/dev-package/files/<path>`.
   * Without it, both routes are absent.
   */
  readonly packageRoot?: string;
  /**
   * A folder of development packages (#570), each a direct subfolder, offered as `packageRoot` is at
   * `/dev-package/<id>/catalog.json` and `/dev-package/<id>/files/<path>`, where `<id>` is the subfolder's name. It
   * cannot be combined with `packageRoot`.
   */
  readonly packagesRoot?: string;
}

export interface StartPlaygroundServerOptions extends PlaygroundServerOptions {
  readonly host?: string;
  readonly port?: number;
  /**
   * Serve HTTPS with a self-signed development certificate (`--https`), so that a browser on another machine of the
   * local network has the secure context the Player's camera needs.
   */
  readonly https?: boolean;
}

export function createPlaygroundServer(options: PlaygroundServerOptions = {}): Server {
  return createServer(playgroundRequestListener(options));
}

function playgroundRequestListener(options: PlaygroundServerOptions): RequestListener {
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot());
  const playgroundRoot = resolve(projectRoot, "playground");
  const distRoot = resolve(projectRoot, "dist");
  const examplesRoot = resolve(projectRoot, "examples");
  if (options.packageRoot !== undefined && options.packagesRoot !== undefined) {
    throw new TypeError("A playground serves either one package folder or a root of packages.");
  }
  const packageFolder =
    options.packageRoot === undefined ? null : new PackageFolder(resolve(options.packageRoot));
  const packageRoot =
    options.packagesRoot === undefined ? null : new PackageRoot(resolve(options.packagesRoot));
  const workspace: AutomationWorkspace = {
    source: "",
    sourceRevision: 0,
    lastCompileResult: null,
    lastRunResult: null,
    resultRevision: null,
  };

  return (request, response) => {
    void serveRequest(
      request,
      { projectRoot, playgroundRoot, distRoot, examplesRoot, packageFolder, packageRoot },
      workspace,
      response,
    ).catch(() => {
      if (!response.headersSent)
        sendJson(response, 500, { error: { code: "internalError", message: "Server error." } });
      else response.destroy();
    });
  };
}

export async function startPlaygroundServer(
  options: StartPlaygroundServerOptions = {},
): Promise<Server | HttpsServer> {
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? environmentPort(process.env.PORT) ?? 4173;
  if (host.length === 0) throw new TypeError("HOST must not be empty.");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("PORT must be an integer from 1 through 65535.");
  }
  const packageRoot = nonEmpty(options.packageRoot ?? process.env.PLAYGROUND_PACKAGE);
  const packagesRoot = nonEmpty(options.packagesRoot ?? process.env.PLAYGROUND_PACKAGES);
  if (packageRoot !== undefined && packagesRoot !== undefined) {
    throw new TypeError("Set PLAYGROUND_PACKAGE or PLAYGROUND_PACKAGES, not both.");
  }
  const listener = playgroundRequestListener({
    ...options,
    ...(packageRoot === undefined ? {} : { packageRoot }),
    ...(packagesRoot === undefined ? {} : { packagesRoot }),
  });
  const https = options.https ?? process.argv.includes("--https");
  const server = https
    ? createHttpsServer(
        await playgroundCertificate(
          resolve(options.projectRoot ?? defaultProjectRoot()),
          playgroundCertificateNames(host, process.env.PLAYGROUND_TLS_NAMES),
        ),
        listener,
      )
    : createServer(listener);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const printableHost = host.includes(":") ? `[${host}]` : host;
  process.stdout.write(
    `TeaseScript playground: ${https ? "https" : "http"}://${printableHost}:${port}/\n`,
  );
  if (https)
    process.stdout.write(
      "Self-signed certificate: the browser warns once; accept it to continue (development only).\n",
    );
  if (packageRoot !== undefined) {
    process.stdout.write(`Development package: ${resolve(packageRoot)}\n`);
  }
  if (packagesRoot !== undefined) {
    process.stdout.write(
      `Development packages: ${resolve(packagesRoot)} (open one with ?package=<folder name>)\n`,
    );
  }
  return server;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

interface StaticRoots {
  readonly projectRoot: string;
  readonly playgroundRoot: string;
  readonly distRoot: string;
  readonly examplesRoot: string;
  readonly packageFolder: PackageFolder | null;
  readonly packageRoot: PackageRoot | null;
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
  const packagePath = developmentPackagePath(pathname, roots);
  if (packagePath?.route === "catalog.json") {
    const folder =
      packagePath.kind === "folder"
        ? packagePath.folder
        : await packagePath.root.package(packagePath.id);
    if (folder === null) sendText(response, 404, "Not found.\n", method === "HEAD");
    else sendJson(response, 200, await folder.scan());
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
    // The package file route serves exactly what the catalog lists, which leaves out links.
    if (
      target.linksAllowed === false &&
      canonicalPath !== resolve(canonicalRoot, relative(target.root, target.path))
    ) {
      sendText(response, 404, "Not found.\n", method === "HEAD");
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

async function serveWorkspaceApi(
  request: IncomingMessage,
  pathname: string,
  workspace: AutomationWorkspace,
  response: ServerResponse,
): Promise<void> {
  if (!isLoopback(request.socket.remoteAddress)) {
    sendJson(response, 403, {
      error: {
        code: "loopbackOnly",
        message: "Workspace automation is available only to loopback clients.",
      },
    });
    return;
  }
  const method = request.method ?? "GET";
  if (pathname === "/api/workspace" && method === "GET") {
    sendJson(response, 200, workspaceView(workspace));
    return;
  }
  if (pathname === "/api/workspace/result" && method === "GET") {
    const result = workspace.lastRunResult ?? workspace.lastCompileResult;
    sendJson(response, 200, {
      sourceRevision: workspace.sourceRevision,
      resultRevision: workspace.resultRevision,
      stale: workspace.resultRevision !== workspace.sourceRevision,
      result,
    });
    return;
  }
  if (pathname === "/api/workspace/source" && method === "PUT") {
    if (!isUtf8Text(request.headers["content-type"])) {
      sendJson(response, 415, {
        error: {
          code: "unsupportedContentType",
          message: "Source uploads require Content-Type: text/plain; charset=utf-8.",
        },
      });
      return;
    }
    const body = await readUtf8Body(request);
    if (!body.ok) {
      sendJson(response, body.status, { error: body.error });
      return;
    }
    workspace.source = body.text;
    workspace.sourceRevision += 1;
    workspace.lastCompileResult = null;
    workspace.lastRunResult = null;
    workspace.resultRevision = null;
    sendJson(response, 200, workspaceView(workspace));
    return;
  }
  if (
    (pathname === "/api/workspace/compile" || pathname === "/api/workspace/run") &&
    method === "POST"
  ) {
    if (await hasUnexpectedBody(request)) {
      sendJson(response, 400, {
        error: {
          code: "unexpectedBody",
          message: "This operation does not accept a request body.",
        },
      });
      return;
    }
    const result = pathname.endsWith("/compile")
      ? compileWorkspaceSource(workspace.source)
      : executeWorkspaceSource(workspace.source);
    workspace.lastCompileResult = pathname.endsWith("/compile")
      ? result
      : workspace.lastCompileResult;
    workspace.lastRunResult = pathname.endsWith("/run") ? result : workspace.lastRunResult;
    workspace.resultRevision = workspace.sourceRevision;
    sendJson(response, 200, {
      sourceRevision: workspace.sourceRevision,
      resultRevision: workspace.resultRevision,
      stale: false,
      result,
    });
    return;
  }
  sendJson(response, 405, {
    error: { code: "methodNotAllowed", message: "Unsupported workspace route or method." },
  });
}

function workspaceView(workspace: AutomationWorkspace) {
  return {
    source: workspace.source,
    sourceRevision: workspace.sourceRevision,
    resultRevision: workspace.resultRevision,
    stale: workspace.resultRevision !== workspace.sourceRevision,
    result: workspace.lastRunResult ?? workspace.lastCompileResult,
  };
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isUtf8Text(value: string | string[] | undefined): boolean {
  if (typeof value !== "string") return false;
  return /^text\/plain(?:\s*;\s*charset=utf-8)?\s*$/iu.test(value);
}

async function readUtf8Body(
  request: IncomingMessage,
): Promise<
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: { readonly code: string; readonly message: string };
    }
> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    };
  } catch {
    return {
      ok: false,
      status: 400,
      error: { code: "malformedUtf8", message: "Source must be valid UTF-8 text." },
    };
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
  /** Whether the path may pass through a link, as long as it stays inside the root. */
  readonly linksAllowed?: false;
}

function resolveTarget(pathname: string, roots: StaticRoots): StaticTarget | null {
  if (pathname === "/vendor/color.js") {
    const root = resolve(roots.projectRoot, "node_modules/colorjs.io/dist");
    return { root, path: resolve(root, "color.js") };
  }
  if (pathname === "/") {
    return { root: roots.playgroundRoot, path: resolve(roots.playgroundRoot, "index.html") };
  }
  if (pathname === "/playground.css") {
    return { root: roots.playgroundRoot, path: resolve(roots.playgroundRoot, "playground.css") };
  }
  if (pathname === "/player" || pathname === "/player/") {
    const playerBuildRoot = resolve(roots.distRoot, "player-app");
    return { root: playerBuildRoot, path: resolve(playerBuildRoot, "index.html") };
  }
  if (pathname.startsWith("/player/")) {
    const relativePath = pathname.slice("/player/".length);
    const playerBuildRoot = resolve(roots.distRoot, "player-app");
    return resolveInside(playerBuildRoot, relativePath);
  }
  if (pathname === "/editor" || pathname === "/editor/") {
    const editorBuildRoot = resolve(roots.distRoot, "editor");
    return { root: editorBuildRoot, path: resolve(editorBuildRoot, "index.html") };
  }
  if (pathname.startsWith("/editor/")) {
    return resolveInside(resolve(roots.distRoot, "editor"), pathname.slice("/editor/".length));
  }
  if (pathname.startsWith("/dist/")) {
    return resolveInside(roots.distRoot, pathname.slice("/dist/".length));
  }
  const packagePath = developmentPackagePath(pathname, roots);
  if (packagePath !== null) {
    if (!packagePath.route.startsWith("files/")) return null;
    const relativePath = packagePath.route.slice("files/".length);
    if (
      !servedExtension(extname(relativePath).toLowerCase()) ||
      relativePath.split("/").some((segment) => segment.startsWith("."))
    )
      return null;
    // A package of a root is served from the root, so a link as its folder is refused like any other link.
    const target =
      packagePath.kind === "folder"
        ? resolveInside(packagePath.folder.root, relativePath)
        : resolveInside(packagePath.root.root, `${packagePath.id}/${relativePath}`);
    return target === null ? null : { ...target, linksAllowed: false };
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

/**
 * The package and the rest of a `/dev-package/` path: the single package folder, or the package of a root named by
 * the first segment. `null` when the path names no package the server could offer.
 */
function developmentPackagePath(
  pathname: string,
  roots: StaticRoots,
):
  | { readonly kind: "folder"; readonly folder: PackageFolder; readonly route: string }
  | {
      readonly kind: "root";
      readonly root: PackageRoot;
      readonly id: string;
      readonly route: string;
    }
  | null {
  if (!pathname.startsWith("/dev-package/")) return null;
  const rest = pathname.slice("/dev-package/".length);
  if (roots.packageFolder !== null)
    return { kind: "folder", folder: roots.packageFolder, route: rest };
  if (roots.packageRoot === null) return null;
  const separator = rest.indexOf("/");
  const id = rest.slice(0, separator);
  return separator > 0 && isPackageId(id)
    ? { kind: "root", root: roots.packageRoot, id, route: rest.slice(separator + 1) }
    : null;
}

/** Whether a package file of this lowercase extension is served: an image, audio, or video file. */
function servedExtension(extension: string): boolean {
  return PACKAGE_IMAGE_EXTENSIONS.has(extension) || PACKAGE_MEDIA_EXTENSIONS.has(extension);
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
  switch (extname(path).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".svg":
      return "image/svg+xml";
    case ".ttf":
      return "font/ttf";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".tease":
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
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
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await startPlaygroundServer();
}
