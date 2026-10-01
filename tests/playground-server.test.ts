import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import {
  exampleUrl,
  isPlaygroundExampleName,
  PLAYGROUND_EXAMPLES,
} from "../playground/examples.js";
import { createPlaygroundServer } from "../playground/server.js";

const server = createPlaygroundServer();
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
  assert.equal(response.body, await readFile("playground/index.html", "utf8"));
});

test("serves only the explicit colour module needed by unbundled playground imports", async () => {
  const response = await get("/vendor/color.js");
  assert.equal(response.status, 200);
  assert.match(response.contentType, /^text\/javascript/u);
  assert.equal(response.body, await readFile("node_modules/colorjs.io/dist/color.js", "utf8"));
  assert.equal((await get("/vendor/package.json")).status, 404);
  assert.equal((await get("/node_modules/colorjs.io/package.json")).status, 404);
});

test("serves the Vue Player at its maintained route and keeps its build separate", async () => {
  const html = await get("/player/");

  assert.equal(html.status, 200);
  assert.match(html.contentType, /^text\/html/u);
  assert.equal(html.body, await readFile("dist/player-app/index.html", "utf8"));
  const assetPath = html.body.match(/<script\b[^>]*\ssrc="([^"]+)"/u)?.[1];
  assert.ok(assetPath !== undefined && assetPath.startsWith("/player/assets/"), assetPath);
  const javascript = await get(assetPath);
  assert.equal(javascript.status, 200);
  assert.match(javascript.contentType, /^text\/javascript/u);
  assert.equal(
    javascript.body,
    await readFile(`dist/player-app/${assetPath.slice("/player/".length)}`, "utf8"),
  );
  assert.equal((await get("/player-vue/")).status, 404);
});

test("Player demo media endpoint discovers supported image files from the demo-media folder", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "teasescript-player-media-"));
  context.after(async () => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "playground"), { recursive: true });
  await mkdir(join(projectRoot, "player", "demo-media"), { recursive: true });
  await mkdir(join(projectRoot, "dist"), { recursive: true });
  await mkdir(join(projectRoot, "examples", "playground"), { recursive: true });
  await writeFile(join(projectRoot, "player", "demo-media", "school-days-38.jpg"), "image");
  await writeFile(join(projectRoot, "player", "demo-media", "ignore.txt"), "not image");

  const isolatedServer = createPlaygroundServer({ projectRoot });
  const isolatedPort = await listen(isolatedServer);
  context.after(async () => close(isolatedServer));

  const selected = await get("/player/demo-media/random", isolatedPort);
  assert.equal(selected.status, 200);
  assert.match(selected.contentType, /^application\/json/u);
  assert.deepEqual(JSON.parse(selected.body), {
    id: "school-days-38",
    src: "/player/demo-media/school-days-38.jpg",
    title: "School Days 38",
  });

  const image = await get("/player/demo-media/school-days-38.jpg", isolatedPort);
  assert.equal(image.status, 200);
  assert.equal(image.contentType, "image/jpeg");
});

test("serves required JavaScript and CSS assets", async () => {
  const [javascript, css] = await Promise.all([
    get("/dist/playground/browser.js"),
    get("/playground.css"),
  ]);

  assert.equal(javascript.status, 200);
  assert.match(javascript.contentType, /^text\/javascript/u);
  assert.equal(javascript.body, await readFile("dist/playground/browser.js", "utf8"));
  assert.equal(css.status, 200);
  assert.match(css.contentType, /^text\/css/u);
  assert.equal(css.body, await readFile("playground/playground.css", "utf8"));
});

test("serves every fixed repository playground example", async () => {
  const names = Object.keys(PLAYGROUND_EXAMPLES).filter(isPlaygroundExampleName);
  assert.ok(names.length > 0);
  for (const name of names) {
    const response = await get(exampleUrl(name));
    assert.equal(response.status, 200, name);
    assert.match(response.contentType, /^text\/plain/u);
    assert.equal(
      response.body,
      await readFile(`examples/playground/${PLAYGROUND_EXAMPLES[name].file}`, "utf8"),
      name,
    );
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
  assert.ok(!response.body.includes('"devDependencies"'));
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
  await writeFile(join(projectRoot, "secret.txt"), "protected-secret-bytes", "utf8");
  await symlink(
    join(projectRoot, "secret.txt"),
    join(projectRoot, "examples", "playground", "main.tease"),
  );

  const isolatedServer = createPlaygroundServer({ projectRoot });
  const isolatedPort = await listen(isolatedServer);
  context.after(async () => close(isolatedServer));
  const response = await get("/examples/playground/main.tease", isolatedPort);

  assert.equal(response.status, 400);
  assert.ok(!response.body.includes("protected-secret-bytes"));
});

test("workspace automation stores revisions and returns compile and run results", async (context) => {
  const isolatedServer = createPlaygroundServer();
  const isolatedPort = await listen(isolatedServer);
  context.after(async () => close(isolatedServer));
  const call = async (method: string, path: string, source?: string) => {
    const response = await api(
      method,
      path,
      source,
      source === undefined ? undefined : "text/plain; charset=utf-8",
      isolatedPort,
    );
    assert.equal(response.status, 200, `${method} ${path}`);
    // EVIDENCE: integration fixture: successful workspace routes return this documented revision/result shape.
    return JSON.parse(response.body) as WorkspaceResponse;
  };
  const initial = (await call("GET", "/api/workspace")).sourceRevision;

  const uploaded = await call("PUT", "/api/workspace/source", 'say "automation"');
  assert.equal(uploaded.source, 'say "automation"');
  assert.equal(uploaded.sourceRevision, initial + 1);
  assert.equal(uploaded.stale, true);
  assert.equal(uploaded.result, null);
  const compiled = await call("POST", "/api/workspace/compile");
  assert.equal(compiled.result?.status, "ready");
  assert.equal(compiled.resultRevision, initial + 1);
  assert.equal(compiled.stale, false);
  const run = await call("POST", "/api/workspace/run");
  assert.equal(run.result?.status, "halted");
  assert.deepEqual(sayTexts(run), ["automation"]);
  const result = await call("GET", "/api/workspace/result");
  assert.equal(result.stale, false);
  assert.deepEqual(sayTexts(result), ["automation"]);

  const replaced = await call("PUT", "/api/workspace/source", 'say "replacement"');
  assert.equal(replaced.sourceRevision, initial + 2);
  assert.equal(replaced.stale, true);
  assert.equal(replaced.result, null);
  const staleResult = await call("GET", "/api/workspace/result");
  assert.equal(staleResult.stale, true);
  assert.equal(staleResult.result, null);
  const rerun = await call("POST", "/api/workspace/run");
  assert.equal(rerun.resultRevision, initial + 2);
  assert.equal(rerun.stale, false);
  assert.deepEqual(sayTexts(rerun), ["replacement"]);
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

interface WorkspaceResponse {
  readonly source?: string;
  readonly sourceRevision: number;
  readonly resultRevision: number | null;
  readonly stale: boolean;
  readonly result: {
    readonly status: string;
    readonly events: readonly { readonly kind: string; readonly text?: string }[];
  } | null;
}

function sayTexts(response: WorkspaceResponse): readonly (string | undefined)[] {
  return (response.result?.events ?? [])
    .filter((event) => event.kind === "say")
    .map((event) => event.text);
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
