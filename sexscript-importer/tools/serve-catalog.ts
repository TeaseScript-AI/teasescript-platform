/**
 * Serves the catalog page and the Player on one HTTPS origin, so that the Player runs in a secure context on another
 * machine. `/` and `/source/...` come from the catalog folder (the page, and the Groovy and `.tease` files as UTF-8
 * plain text); every other GET goes to the playground server that offers the converted packages, which should listen
 * on loopback only. `--http-port` adds a plain-HTTP port that redirects to the HTTPS origin. With `--verified-root`
 * and `--verified-upstream`, a package that has a verified copy in that folder is served by the playground server
 * that offers the verified copies instead, and the package id `latest~<id>` stands for its latest conversion, from the
 * other server. With `--pins <file>`, `/pins.json` keeps the catalog page's pins in that file: GET answers 204 until
 * the first PUT of a JSON array of package ids.
 *
 * Usage: node tools/serve-catalog.ts --catalog <folder> --upstream <http://127.0.0.1:port> --cert <pem> --key <pem>
 *   --port <https-port> [--http-port <port>] [--host <address>] [--verified-root <dir> --verified-upstream <url>]
 *   [--pins <file>]
 */
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { pipeline } from "node:stream";
import { parseArgs } from "node:util";
import { LATEST_PREFIX } from "./catalog.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".groovy": "text/plain; charset=utf-8",
  ".tease": "text/plain; charset=utf-8",
};

const { values } = parseArgs({
  options: {
    catalog: { type: "string" },
    upstream: { type: "string" },
    cert: { type: "string" },
    key: { type: "string" },
    port: { type: "string" },
    "http-port": { type: "string" },
    host: { type: "string", default: "0.0.0.0" },
    "verified-root": { type: "string" },
    "verified-upstream": { type: "string" },
    pins: { type: "string" },
  },
});
if (
  values.catalog === undefined ||
  values.upstream === undefined ||
  values.cert === undefined ||
  values.key === undefined ||
  values.port === undefined
) {
  process.stderr.write(
    "Usage: node tools/serve-catalog.ts --catalog <folder> --upstream <url> --cert <pem> --key <pem> --port <port> [--http-port <port>] [--host <address>] [--verified-root <dir> --verified-upstream <url>] [--pins <file>]\n",
  );
  process.exit(2);
}
const catalogRoot = path.resolve(values.catalog);
const upstream = new URL(values.upstream);
const verifiedRoot =
  values["verified-root"] === undefined ? null : path.resolve(values["verified-root"]);
const verifiedUpstream =
  values["verified-upstream"] === undefined ? null : new URL(values["verified-upstream"]);
const pinsFile = values.pins === undefined ? null : path.resolve(values.pins);
/** Limits of a pin list: it names packages of one catalog. */
const MAX_PINS_BYTES = 64 * 1024;
const MAX_PIN_LENGTH = 300;
/** Numbers the temporary files of pin writes, so that two requests at once never write the same one. */
let pinWrites = 0;
const httpsPort = Number(values.port);
const host = values.host;

const server = createHttpsServer(
  { cert: await readFile(values.cert), key: await readFile(values.key) },
  (request, response) => {
    void handle(request, response).catch(() => response.destroy());
  },
);
server.listen(httpsPort, host, () =>
  process.stdout.write(`Catalog and Player: https://${host}:${httpsPort}/\n`),
);

if (values["http-port"] !== undefined) {
  const httpPort = Number(values["http-port"]);
  createHttpServer((request, response) => {
    let hostname: string;
    try {
      hostname = new URL(`http://${request.headers.host ?? "localhost"}`).hostname;
    } catch {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(302, { Location: `https://${hostname}:${httpsPort}${request.url ?? "/"}` });
    response.end();
  }).listen(httpPort, host, () =>
    process.stdout.write(`Redirecting http://${host}:${httpPort}/ to HTTPS\n`),
  );
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = request.url ?? "/";
  const rawPath = url.split("?", 1)[0]!;
  if (rawPath === "/pins.json" && pinsFile !== null) return pins(pinsFile, request, response);
  if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405);
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return send(response, 400);
  }
  if (pathname === "/" || pathname === "/index.html" || pathname.startsWith("/source/"))
    return serveFile(pathname === "/" ? "/index.html" : pathname, request, response);
  // The playground's workspace automation trusts loopback clients, which every proxied request would be.
  if (pathname.startsWith("/api/")) return send(response, 404);
  // A package's files and catalog come from its verified copy when it has one; `latest~<id>`, from its conversion.
  // The whole path decoded above, so its first segment decodes too.
  const packageSegment = /^\/dev-package\/([^/]+)\//u.exec(rawPath);
  const requestedId = packageSegment === null ? null : decodeURIComponent(packageSegment[1]!);
  const latest = requestedId?.startsWith(LATEST_PREFIX) === true;
  const packageId = latest ? requestedId!.slice(LATEST_PREFIX.length) : requestedId;
  const forwarded =
    latest && packageId !== null
      ? `/dev-package/${encodeURIComponent(packageId)}/${url.slice(packageSegment![0].length)}`
      : url;
  const verified =
    !latest &&
    packageId !== null &&
    !packageId.startsWith(".") &&
    !/[/\\\0]/u.test(packageId) &&
    verifiedRoot !== null &&
    verifiedUpstream !== null &&
    (await stat(path.join(verifiedRoot, packageId)).then(
      (information) => information.isDirectory(),
      () => false,
    ));
  const target = verified ? verifiedUpstream! : upstream;
  const proxied = httpRequest(
    {
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: forwarded,
      headers: { ...request.headers, host: target.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  proxied.on("error", () => send(response, 502));
  proxied.end();
}

async function serveFile(
  pathname: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const segments = pathname.split("/").slice(1);
  const type = CONTENT_TYPES[path.extname(pathname).toLowerCase()];
  // Only the listed file types below the catalog folder; no hidden names, `..`, or other path tricks.
  if (
    type === undefined ||
    /[\\\0]/u.test(pathname) ||
    segments.some((segment) => segment === "" || segment.startsWith("."))
  )
    return send(response, 404);
  // One open file for its size and contents: the catalog folder may be a symlink that a regeneration repoints.
  const file = await open(path.join(catalogRoot, ...segments)).catch(() => null);
  if (file === null) return send(response, 404);
  const information = await file.stat().catch(() => null);
  if (information?.isFile() !== true) {
    await file.close();
    return send(response, 404);
  }
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": information.size,
    "Cache-Control": "no-cache",
  });
  if (request.method === "HEAD") {
    await file.close();
    response.end();
  } else pipeline(file.createReadStream(), response, () => {});
}

/**
 * `/pins.json`: GET answers the stored JSON array of package ids, or 204 before the first PUT; PUT replaces it with the
 * request's array, written to a temporary file and renamed so that a crash never leaves half a list.
 */
async function pins(
  file: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method === "GET" || request.method === "HEAD") {
    const stored = await readFile(file).catch(() => null);
    if (stored === null) return send(response, 204);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": stored.length,
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : stored);
    return;
  }
  // A PUT is never a simple cross-origin request, so another site's page cannot send one without CORS approval.
  if (request.method !== "PUT") return send(response, 405);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    // EVIDENCE: an IncomingMessage without an encoding set yields Buffer chunks.
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_PINS_BYTES) return send(response, 413);
    chunks.push(buffer);
  }
  let list: unknown;
  try {
    list = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return send(response, 400);
  }
  if (
    !Array.isArray(list) ||
    !list.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_PIN_LENGTH)
  )
    return send(response, 400);
  const temporary = `${file}.${process.pid}.${(pinWrites += 1)}.tmp`;
  await writeFile(temporary, `${JSON.stringify([...new Set(list)])}\n`);
  await rename(temporary, file);
  return send(response, 204);
}

function send(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(`${status}\n`);
}
