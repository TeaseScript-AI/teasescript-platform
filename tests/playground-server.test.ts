import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { PLAYGROUND_EXAMPLES } from "../playground/examples.js";
import { createPlaygroundServer } from "../playground/server.js";

const server = createPlaygroundServer();
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
let port = 0;

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected an IP server address."));
        return;
      }
      port = address.port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

test("serves the root playground page", async () => {
  const response = await get("/");

  assert.equal(response.status, 200);
  assert.match(response.contentType, /^text\/html/u);
  assert.equal(response.body, await projectFile("playground/index.html"));
});

test("serves only the explicit colour module needed by unbundled playground imports", async () => {
  const response = await get("/vendor/color.js");
  assert.equal(response.status, 200);
  assert.match(response.contentType, /^text\/javascript/u);
  assert.equal(response.body, await projectFile("node_modules/colorjs.io/dist/color.js"));
  assert.equal((await get("/vendor/package.json")).status, 404);
  assert.equal((await get("/node_modules/colorjs.io/package.json")).status, 404);
});

test("serves the Player build at its maintained route", async () => {
  const html = await get("/player/");

  assert.equal(html.status, 200);
  assert.match(html.contentType, /^text\/html/u);
  assert.equal(html.body, await projectFile("dist/player-app/index.html"));
  const assetPath = html.body.match(/<script\b[^>]*\bsrc="([^"]+)"/u)?.[1] ?? "";
  assert.ok(assetPath.startsWith("/player/assets/"), assetPath);
  const javascript = await get(assetPath);
  assert.equal(javascript.status, 200);
  assert.match(javascript.contentType, /^text\/javascript/u);
  assert.equal(
    javascript.body,
    await projectFile(`dist/player-app/${assetPath.slice("/player/".length)}`),
  );
});

test("serves required JavaScript and CSS assets", async () => {
  const [javascript, css] = await Promise.all([
    get("/dist/playground/browser.js"),
    get("/playground.css"),
  ]);

  assert.equal(javascript.status, 200);
  assert.match(javascript.contentType, /^text\/javascript/u);
  assert.equal(javascript.body, await projectFile("dist/playground/browser.js"));
  assert.equal(css.status, 200);
  assert.match(css.contentType, /^text\/css/u);
  assert.equal(css.body, await projectFile("playground/playground.css"));
});

test("serves every fixed repository playground example", async () => {
  for (const { file } of Object.values(PLAYGROUND_EXAMPLES)) {
    const response = await get(`/examples/playground/${file}`);
    assert.equal(response.status, 200, file);
    assert.match(response.contentType, /^text\/plain/u);
  }
});

test("returns 404 for missing or unexposed paths", async () => {
  assert.equal((await get("/missing.txt")).status, 404);
  assert.equal((await get("/package.json")).status, 404);
  assert.equal((await get("/examples/playground/not-allowed.tease")).status, 404);
  assert.equal((await get("/examples/other.tease")).status, 404);
});

test("rejects encoded path traversal", async () => {
  const response = await get("/dist/%2e%2e/package.json");

  assert.equal(response.status, 400);
  assert.ok(!response.body.includes(await projectFile("package.json")));
});

test("query and encoded example-path manipulation cannot select a file", async () => {
  assert.equal((await get("/examples/playground/not-allowed.tease?name=main")).status, 404);
  assert.equal((await get("/examples/playground/%2e%2e/main.tease")).status, 400);
});

test("rejects symlinks that escape an exposed static root", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "teasescript-playground-"));
  context.after(async () => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "playground"), { recursive: true });
  await mkdir(join(projectRoot, "player"), { recursive: true });
  await mkdir(join(projectRoot, "dist"), { recursive: true });
  await mkdir(join(projectRoot, "examples", "playground"), { recursive: true });
  await writeFile(join(projectRoot, "secret.txt"), "not public", "utf8");
  await symlink(
    join(projectRoot, "secret.txt"),
    join(projectRoot, "examples", "playground", "main.tease"),
  );

  const isolatedServer = createPlaygroundServer({ projectRoot });
  const isolatedPort = await listen(isolatedServer);
  context.after(async () => close(isolatedServer));
  const response = await get("/examples/playground/main.tease", isolatedPort);

  assert.equal(response.status, 400);
  assert.ok(!response.body.includes("not public"));
});

test("workspace automation stores revisions and returns compile and run results", async (context) => {
  const isolatedServer = createPlaygroundServer();
  const isolatedPort = await listen(isolatedServer);
  context.after(async () => close(isolatedServer));
  const view = (response: HttpResult) => {
    // EVIDENCE: integration fixture: every workspace route returns this JSON shape; the test asserts each field it reads.
    return JSON.parse(response.body) as {
      source?: string;
      sourceRevision: number;
      resultRevision: number | null;
      stale: boolean;
      result: { status: string; events: { kind: string; text?: string }[] } | null;
    };
  };
  const call = (method: string, path: string, body?: string) =>
    api(
      method,
      path,
      body,
      body === undefined ? undefined : "text/plain; charset=utf-8",
      isolatedPort,
    );

  const initial = await call("GET", "/api/workspace");
  assert.equal(initial.status, 200);
  const initialRevision = view(initial).sourceRevision;

  const uploaded = await call("PUT", "/api/workspace/source", 'say "automation"');
  assert.equal(uploaded.status, 200);
  const workspace = view(uploaded);
  assert.equal(workspace.source, 'say "automation"');
  assert.equal(workspace.sourceRevision, initialRevision + 1);
  assert.equal(workspace.stale, true);
  const compiled = await call("POST", "/api/workspace/compile");
  assert.equal(compiled.status, 200);
  assert.equal(view(compiled).result?.status, "ready");
  assert.equal(view(compiled).resultRevision, initialRevision + 1);
  const run = await call("POST", "/api/workspace/run");
  assert.equal(run.status, 200);
  const runBody = view(run);
  assert.equal(runBody.result?.status, "halted");
  assert.equal(runBody.result?.events[0]?.text, "automation");
  const result = await call("GET", "/api/workspace/result");
  assert.equal(result.status, 200);
  assert.equal(view(result).stale, false);
  assert.equal(view(result).resultRevision, initialRevision + 1);

  const edited = await call("PUT", "/api/workspace/source", 'say "edited"');
  assert.equal(edited.status, 200);
  assert.equal(view(edited).sourceRevision, initialRevision + 2);
  const staleResult = view(await call("GET", "/api/workspace/result"));
  assert.equal(staleResult.stale, true);
  assert.equal(staleResult.result, null);

  const recompiled = view(await call("POST", "/api/workspace/compile"));
  assert.equal(recompiled.result?.status, "ready");
  assert.equal(recompiled.resultRevision, initialRevision + 2);
  assert.equal(view(await call("GET", "/api/workspace/result")).stale, false);
});

test("workspace automation accepts source beyond the former local byte limit", async () => {
  const source = `${"// padding\n".repeat(10_000)}say "large upload"`;
  const uploaded = await api("PUT", "/api/workspace/source", source, "text/plain; charset=utf-8");

  assert.equal(uploaded.status, 200);
  // EVIDENCE: integration fixture: a successful source upload echoes its stored source.
  assert.equal((JSON.parse(uploaded.body) as { source: string }).source, source);
});

test("workspace automation rejects malformed UTF-8 source", async () => {
  const uploaded = await api(
    "PUT",
    "/api/workspace/source",
    Buffer.from([0xc3, 0x28]),
    "text/plain; charset=utf-8",
  );

  assert.equal(uploaded.status, 400);
  // EVIDENCE: integration fixture: malformed UTF-8 responses carry the asserted structured error code.
  assert.equal(
    (JSON.parse(uploaded.body) as { error: { code: string } }).error.code,
    "malformedUtf8",
  );
});

test("workspace automation rejects unsafe methods, content, and non-empty operation bodies", async () => {
  assert.equal((await api("DELETE", "/api/workspace")).status, 405);
  assert.equal((await api("PUT", "/api/workspace/source", "x")).status, 415);
  assert.equal((await api("PUT", "/api/workspace/source", "x", "application/json")).status, 415);
  assert.equal((await api("POST", "/api/workspace/compile", "{}", "application/json")).status, 400);
  assert.equal((await api("POST", "/api/workspace/run", "{}", "application/json")).status, 400);
  assert.equal((await api("POST", "/api/workspace/run", "{}", undefined, port, true)).status, 400);
});

test("workspace automation rejects clients outside the permitted loopback address", async (context) => {
  const isolatedServer = createPlaygroundServer();
  const isolatedPort = await listenAt(isolatedServer, "0.0.0.0");
  context.after(async () => close(isolatedServer));
  const response = await api(
    "GET",
    "/api/workspace",
    undefined,
    undefined,
    isolatedPort,
    false,
    "127.0.0.2",
  );
  assert.equal(response.status, 403);
});

function projectFile(path: string): Promise<string> {
  return readFile(join(projectRoot, path), "utf8");
}

interface HttpResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

function get(path: string, requestPort = port): Promise<HttpResult> {
  return api("GET", path, undefined, undefined, requestPort);
}

function api(
  method: string,
  path: string,
  body?: string | Buffer,
  contentType?: string,
  requestPort = port,
  omitContentLength = false,
  localAddress?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port: requestPort,
        method,
        path,
        localAddress,
        headers:
          body === undefined
            ? undefined
            : {
                ...(contentType === undefined ? {} : { "Content-Type": contentType }),
                ...(omitContentLength ? {} : { "Content-Length": Buffer.byteLength(body) }),
              },
      },
      (incoming) => {
        incoming.setEncoding("utf8");
        let body = "";
        incoming.on("data", (chunk: string) => {
          body += chunk;
        });
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            contentType: String(incoming.headers["content-type"] ?? ""),
            body,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function listenAt(target: typeof server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, host, () => {
      target.off("error", reject);
      const address = target.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected an IP server address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function listen(target: typeof server): Promise<number> {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", () => {
      target.off("error", reject);
      const address = target.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Expected an IP server address."));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(target: typeof server): Promise<void> {
  return new Promise((resolve, reject) => {
    target.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
