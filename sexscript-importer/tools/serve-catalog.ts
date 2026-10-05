/**
 * Serves the catalog page and the Player on one HTTPS origin, so that the Player runs in a secure context on another
 * machine. `/` and `/source/...` come from the catalog folder (the page, and the Groovy and `.tease` files as UTF-8
 * plain text); every other GET goes to the playground server that offers the converted packages, which should listen
 * on loopback only. `--http-port` adds a plain-HTTP port that redirects to the HTTPS origin.
 *
 * Usage: node tools/serve-catalog.ts --catalog <folder> --upstream <http://127.0.0.1:port> --cert <pem> --key <pem>
 *   --port <https-port> [--http-port <port>] [--host <address>]
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { parseArgs } from "node:util";

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
    "Usage: node tools/serve-catalog.ts --catalog <folder> --upstream <url> --cert <pem> --key <pem> --port <port> [--http-port <port>] [--host <address>]\n",
  );
  process.exit(2);
}
const catalogRoot = path.resolve(values.catalog);
const upstream = new URL(values.upstream);
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
  if (request.method !== "GET" && request.method !== "HEAD") return send(response, 405);
  const rawPath = (request.url ?? "/").split("?", 1)[0]!;
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
  const proxied = httpRequest(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: upstream.host },
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
  const file = path.join(catalogRoot, ...segments);
  const information = await stat(file).catch(() => null);
  if (information?.isFile() !== true) return send(response, 404);
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": information.size,
    "Cache-Control": "no-cache",
  });
  if (request.method === "HEAD") response.end();
  else
    createReadStream(file)
      .on("error", () => response.destroy())
      .pipe(response);
}

function send(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(`${status}\n`);
}
