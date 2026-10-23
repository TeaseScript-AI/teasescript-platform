import { readdirSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isPackageId } from "../playground/package-folder.js";
import { createPlaygroundServer } from "../playground/server.js";
import { playgroundCertificate, playgroundCertificateNames } from "../playground/tls.js";
import { playerProfileFromInput } from "../src/runtime/host-data/player-profile.js";
import { validateScriptStorageEntries } from "../src/runtime/host-data/script-storage.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint.js";
import { isPlainRecord } from "../src/runtime/values/plain-data.js";
import { hostPage } from "./host-page.js";
import { TestServerStore, type MediaTable, type RevisionKind } from "./store.js";

// The temporary test server (README.md): the built Player, a stand-in for the website, and the provisional API of
// online mode (`player/online-data.ts`), all on one origin, with a latency on every request and switches for faults.

export interface TestServerOptions {
  /** The SQLite file, or `:memory:`. */
  readonly data: string;
  /** The one account, which `Online` signs in to. */
  readonly account: string;
  /** A folder of development packages, each a subfolder, offered as the playground offers them. */
  readonly packages?: string;
  /** The latency every request waits, in milliseconds: the normal one, the slow one, and the jitter of each. */
  readonly latency?: {
    readonly normalMs: number;
    readonly slowMs: number;
    readonly jitterMs: number;
  };
  readonly projectRoot?: string;
  /** Takes one line per `/api/` request: method, path, status, time, and bytes received. */
  readonly log?: (line: string) => void;
}

/** The switches the stand-in page and `/test-server/state` change while the server runs. */
export interface TestServerState {
  slow: boolean;
  down: boolean;
  failNextWrite: boolean;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_LATENCY = { normalMs: 40, slowMs: 800, jitterMs: 15 };

/** The test server's request listener, its switches, and its store, which `close` closes. */
export function testServer(options: TestServerOptions): {
  readonly listener: RequestListener;
  readonly state: TestServerState;
  close(): void;
} {
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot());
  const store = new TestServerStore(options.data);
  const account = store.account(options.account, JSON.stringify(defaultProfile(options.account)));
  const latency = options.latency ?? DEFAULT_LATENCY;
  const state: TestServerState = { slow: false, down: false, failNextWrite: false };
  // The playground serves the built Player and the packages, unchanged.
  const playground = createPlaygroundServer({
    projectRoot,
    ...(options.packages === undefined ? {} : { packagesRoot: options.packages }),
  });
  const listener: RequestListener = (request, response) => {
    const started = performance.now();
    const base = state.slow ? latency.slowMs : latency.normalMs;
    const wait = Math.max(0, base + (Math.random() * 2 - 1) * latency.jitterMs);
    setTimeout(() => {
      void serve(request, response).catch((error: unknown) => {
        const tooLarge = error instanceof BodyTooLargeError;
        // A browser that leaves the page aborts its requests.
        if (!tooLarge && !request.destroyed) console.error(error);
        if (!response.headersSent)
          sendJson(response, tooLarge ? 413 : 500, {
            error: tooLarge ? error.message : "Server error.",
          });
        else response.destroy();
      });
    }, wait);
    response.on("finish", () => {
      if (request.url?.startsWith("/api/"))
        options.log?.(
          `${request.method} ${request.url.split("?", 1)[0]} ${response.statusCode} ${Math.round(performance.now() - started)} ms ${request.headers["content-length"] ?? 0} B in`,
        );
    });
  };

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "/").split("?", 1)[0] ?? "/";
    const method = request.method ?? "GET";
    if (path === "/" && method === "GET") {
      sendHtml(
        response,
        hostPage({
          account: account.name,
          token: account.token,
          packages: packageIds(options.packages),
          latency,
          state,
          profile: store.profile(account.name),
          conflicts: store.conflicts(account.name),
        }),
      );
      return;
    }
    if (path === "/test-server/state") return serveState(request, response);
    if (path.startsWith("/api/")) return serveApi(request, response, path.slice("/api/".length));
    if (path.startsWith("/player/") || path === "/player" || path.startsWith("/dev-package/")) {
      playground.emit("request", request, response);
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  }

  async function serveState(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "POST") {
      const body = await readJson(request);
      if (body === null) return sendJson(response, 400, { error: "Send a JSON object." });
      for (const name of ["slow", "down", "failNextWrite"] as const)
        if (typeof body[name] === "boolean") state[name] = body[name];
      if (body.profile !== undefined) {
        try {
          playerProfileFromInput(body.profile);
        } catch (error) {
          return sendJson(response, 400, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        store.setProfile(account.name, JSON.stringify(body.profile));
      }
    } else if (request.method !== "GET")
      return sendJson(response, 405, { error: "Use GET or POST." });
    sendJson(response, 200, { ...state, profile: JSON.parse(store.profile(account.name)) });
  }

  async function serveApi(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const method = request.method ?? "GET";
    if (state.down) return sendJson(response, 503, { error: "The test server is down." });
    const token = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
    const user = token === undefined ? null : store.accountOf(token);
    if (user === null) return sendJson(response, 401, { error: "Unknown token." });
    const segments: string[] = [];
    for (const segment of path.split("/")) {
      const text = segmentText(segment);
      if (text === null) return sendJson(response, 400, { error: "Malformed path segment." });
      segments.push(text);
    }
    const [first, scope, part, reference, ...rest] = segments;

    if (path === "account" && method === "GET")
      return sendJsonText(
        response,
        200,
        `{"account":${JSON.stringify(user)},"profile":${store.profile(user)}}`,
      );
    if (path === "scripts" && method === "GET")
      return sendJson(response, 200, {
        scripts: store
          .scripts(user)
          .map(({ scope, name }) => ({
            scope: JSON.parse(scope),
            name: name === null ? null : JSON.parse(name),
          })),
      });
    // `scripts/<scope>/…`, where every segment but `scripts` itself is a JSON string.
    if (path.split("/")[0] !== "scripts" || first === undefined || scope === undefined)
      return sendJson(response, 404, { error: "Not found." });
    const scopeKey = JSON.stringify(scope);

    if (part === "name" && reference === undefined && method === "PUT") {
      const body = await readJson(request);
      if (typeof body?.name !== "string")
        return sendJson(response, 400, { error: "Send { name }." });
      store.setName(user, scopeKey, JSON.stringify(body.name));
      return sendEmpty(response);
    }
    // The switch fails the next write of saved values or their photos, not of a script's name or a kept session.
    const failsOnPurpose = () => {
      if (!state.failNextWrite) return false;
      state.failNextWrite = false;
      sendJson(response, 503, { error: "This write failed on purpose." });
      return true;
    };
    // A change names the revision its Player last saw; another one means another writer came in between.
    const base = request.headers["x-base-revision"];
    const conflicting = (kind: RevisionKind) => {
      if (typeof base !== "string" || base === String(store.revision(user, scopeKey, kind)))
        return false;
      store.conflict(user, scopeKey, kind);
      options.log?.(
        `Two writers: ${kind === "session" ? "kept session" : "saved values"} of ${scope}`,
      );
      return true;
    };
    if (part === "storage" && reference === undefined) {
      if (method === "GET")
        return sendJsonText(
          response,
          200,
          `{"entries":[${store
            .entries(user, scopeKey)
            .map(({ key, value }) => `{"key":${key},"value":${value}}`)
            .join(",")}]}`,
          revisionHeader(store.revision(user, scopeKey, "storage")),
        );
      if (failsOnPurpose()) return;
      // Each change compares the revision and changes the data with no wait in between, after its body is read, so no
      // other request comes between them. A value is written even if another was written meanwhile, so the last one
      // stays.
      if (method === "DELETE") {
        conflicting("storage");
        return sendEmpty(response, 204, revisionHeader(store.replace(user, scopeKey, [])));
      }
      const body = await readJson(request);
      if (method === "PATCH") {
        if (body === null || typeof body.key !== "string" || !("value" in body))
          return sendJson(response, 400, { error: "Send { key, value }." });
        if (body.value !== null) {
          const problem = validateScriptStorageEntries(
            [{ key: body.key, value: body.value }],
            "entry",
          );
          if (problem !== null) return sendJson(response, 400, { error: problem });
        }
        conflicting("storage");
        const revision = store.write(
          user,
          scopeKey,
          JSON.stringify(body.key),
          body.value === null ? null : serializeValidatedRuntimeJson(body.value),
        );
        return sendEmpty(response, 204, revisionHeader(revision));
      }
      if (method === "PUT") {
        const entries = body?.entries;
        const problem = validateScriptStorageEntries(entries, "entries");
        if (problem !== null) return sendJson(response, 400, { error: problem });
        // EVIDENCE: validation: validateScriptStorageEntries accepted `entries` as script storage entries.
        const accepted = entries as readonly { readonly key: string; readonly value: unknown }[];
        conflicting("storage");
        const revision = store.replace(
          user,
          scopeKey,
          accepted.map(({ key, value }) => ({
            key: JSON.stringify(key),
            value: serializeValidatedRuntimeJson(value),
          })),
        );
        return sendEmpty(response, 204, revisionHeader(revision));
      }
    }
    if (part === "session" && reference === undefined) {
      // `HEAD` tells a Player whether another kept the session meanwhile; Node leaves out its body.
      if (method === "GET" || method === "HEAD") {
        const session = store.session(user, scopeKey);
        if (session === null)
          return sendJsonText(
            response,
            404,
            JSON.stringify({ error: "No session is kept." }),
            revisionHeader(store.revision(user, scopeKey, "session")),
          );
        return sendJsonText(
          response,
          200,
          `{"planJson":${JSON.stringify(session.plan)},"snapshotJson":${JSON.stringify(session.snapshot)},` +
            `"events":[${session.events.join(",")}],"marks":${session.marks}}`,
          revisionHeader(store.revision(user, scopeKey, "session")),
        );
      }
      // Two devices must not mix their events: the session kept first stays, also against a Player that would replace
      // it with a new one. A discard that names no revision, such as an import's, always goes ahead.
      const refused = () =>
        sendJson(response, 409, { error: "Another Player kept this session meanwhile." });
      if (method === "DELETE") {
        if (conflicting("session")) return refused();
        return sendEmpty(response, 204, revisionHeader(store.discardSession(user, scopeKey)));
      }
      if (method === "PUT") {
        const body = await readJson(request);
        const { planJson, snapshotJson, eventsFrom, events, marks } = body ?? {};
        if (
          !(planJson === null || typeof planJson === "string") ||
          typeof snapshotJson !== "string" ||
          typeof eventsFrom !== "number" ||
          !Number.isSafeInteger(eventsFrom) ||
          eventsFrom < 0 ||
          !Array.isArray(events) ||
          !isPlainRecord(marks)
        )
          return sendJson(response, 400, {
            error: "Send { planJson, snapshotJson, eventsFrom, events, marks }.",
          });
        const kept = {
          plan: planJson,
          snapshot: snapshotJson,
          marks: serializeValidatedRuntimeJson(marks),
          eventsFrom,
          events: events.map((event) => serializeValidatedRuntimeJson(event)),
        };
        if (conflicting("session")) return refused();
        const result = store.publishSession(user, scopeKey, kept);
        if (typeof result !== "number")
          return sendJson(response, 400, {
            error: result === "gap" ? "The events leave a gap." : "No plan is kept or sent.",
          });
        return sendEmpty(response, 204, revisionHeader(result));
      }
    }
    if ((part === "media" || part === "session-media") && rest.length === 0) {
      const table: MediaTable = part === "media" ? "media" : "session_media";
      if (reference === undefined) {
        if (method === "GET")
          return sendJson(response, 200, {
            references: store.references(user, scopeKey, table).map((stored) => JSON.parse(stored)),
          });
        return sendJson(response, 404, { error: "Not found." });
      }
      const referenceKey = JSON.stringify(reference);
      if (method === "GET") {
        const media = store.media(user, scopeKey, referenceKey, table);
        if (media === null) return sendJson(response, 404, { error: "Not found." });
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": media.data.byteLength,
          "Cache-Control": "no-store",
          "X-Media-Record": media.fields,
        });
        response.end(media.data);
        return;
      }
      if (table === "media" && failsOnPurpose()) return;
      if (method === "DELETE") {
        store.deleteMedia(user, scopeKey, referenceKey, table);
        return sendEmpty(response);
      }
      if (method === "PUT") {
        const fields = request.headers["x-media-record"];
        let parsed: unknown;
        try {
          parsed = typeof fields === "string" ? JSON.parse(fields) : undefined;
        } catch {
          parsed = undefined;
        }
        const data = await readBody(request);
        if (typeof fields !== "string" || !isPlainRecord(parsed) || parsed.size !== data.byteLength)
          return sendJson(response, 400, { error: "Send the media's fields matching its bytes." });
        if (!store.addMedia(user, scopeKey, referenceKey, { fields, data }, table))
          return sendJson(response, 409, { error: "The reference is stored already." });
        return sendEmpty(response, 201);
      }
    }
    sendJson(response, 404, { error: "Not found." });
  }

  return { listener, state, close: () => store.close() };
}

/** The text a path segment holds, the JSON string the Player sent percent-encoded; `null` when it holds none. */
function segmentText(segment: string): string | null {
  try {
    const text: unknown = JSON.parse(decodeURIComponent(segment));
    return typeof text === "string" ? text : null;
  } catch {
    // `scripts`, `storage`, `media`, `session`, `session-media`, and `name` are plain words.
    return /^[a-z-]+$/u.test(segment) ? segment : null;
  }
}

/** The ids of the packages folder's packages, in alphabetical order. */
function packageIds(folder: string | undefined): string[] {
  if (folder === undefined) return [];
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isPackageId(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "en", { sensitivity: "base" }));
  } catch {
    return [];
  }
}

/** The person fields a new account starts with: its name, which the stand-in page can change. */
function defaultProfile(account: string) {
  const name = account.charAt(0).toUpperCase() + account.slice(1);
  return { firstName: name, displayName: name };
}

class BodyTooLargeError extends Error {
  override readonly name = "BodyTooLargeError";
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  // EVIDENCE: invariant: a request without `setEncoding` yields its body as Buffer chunks.
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES)
      throw new BodyTooLargeError(`A request body may hold at most ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** The JSON object the request's body holds, its fields not yet checked, or `null` for any other body. */
async function readJson(
  request: IncomingMessage,
): Promise<Readonly<Record<string, unknown>> | null> {
  const text = new TextDecoder().decode(await readBody(request));
  try {
    const body: unknown = JSON.parse(text);
    return isPlainRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendJsonText(response, status, JSON.stringify(body));
}

function sendJsonText(
  response: ServerResponse,
  status: number,
  text: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  response.end(text);
}

function sendEmpty(
  response: ServerResponse,
  status = 204,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { ...headers, "Cache-Control": "no-store" });
  response.end();
}

const revisionHeader = (revision: number) => ({ "X-Revision": String(revision) });

function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  response.end(html);
}

function defaultProjectRoot(): string {
  return resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

function environmentNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/u.test(value)) throw new RangeError(`${name} must be a whole number.`);
  return Number(value);
}

/** Starts the server from the environment; see README.md. */
async function start(): Promise<Server> {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = environmentNumber("PORT", 4181);
  const https = process.argv.includes("--https");
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  const { listener } = testServer({
    data: process.env.TEST_SERVER_DATA ?? join(stateHome, "teasescript-test-server", "data.sqlite"),
    account: process.env.TEST_SERVER_ACCOUNT ?? "peter",
    // The folder of the server-check package unless another is given.
    packages: resolve(
      process.env.TEST_SERVER_PACKAGES || join(defaultProjectRoot(), "test-server", "packages"),
    ),
    log: (line) => console.log(line),
    latency: {
      normalMs: environmentNumber("TEST_SERVER_LATENCY_MS", DEFAULT_LATENCY.normalMs),
      slowMs: environmentNumber("TEST_SERVER_SLOW_MS", DEFAULT_LATENCY.slowMs),
      jitterMs: environmentNumber("TEST_SERVER_JITTER_MS", DEFAULT_LATENCY.jitterMs),
    },
  });
  const server = https
    ? createHttpsServer(
        await playgroundCertificate(
          defaultProjectRoot(),
          playgroundCertificateNames(host, process.env.PLAYGROUND_TLS_NAMES),
        ),
        listener,
      )
    : createServer(listener);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });
  process.stdout.write(
    `TeaseScript test server (temporary, development only): ${https ? "https" : "http"}://${host}:${port}/\n`,
  );
  return server;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href)
  await start();
