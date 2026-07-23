import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

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
  assert.match(response.body, /TeaseScript Playground/u);
});

test("serves required JavaScript and CSS assets", async () => {
  const [javascript, css] = await Promise.all([
    get("/dist/playground/browser.js"),
    get("/playground.css"),
  ]);

  assert.equal(javascript.status, 200);
  assert.match(javascript.contentType, /^text\/javascript/u);
  assert.match(javascript.body, /compileSource/u);
  assert.equal(css.status, 200);
  assert.match(css.contentType, /^text\/css/u);
  assert.match(css.body, /runtime-summary/u);
});

test("serves every fixed repository playground example", async () => {
  for (const name of ["main", "control-flow", "checkpoint-loop"]) {
    const response = await get(`/examples/playground/${name}.tease`);
    assert.equal(response.status, 200, name);
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
  assert.match(response.body, /unsafe request path/u);
});

test("query and encoded example-path manipulation cannot select a file", async () => {
  assert.equal(
    (await get("/examples/playground/not-allowed.tease?name=main")).status,
    404,
  );
  assert.equal(
    (await get("/examples/playground/%2e%2e/main.tease")).status,
    400,
  );
});

test("rejects symlinks that escape an exposed static root", async (context) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "teasescript-playground-"));
  context.after(async () => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "playground"), { recursive: true });
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
  assert.match(response.body, /unsafe request path/u);
});

interface HttpResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

function get(path: string, requestPort = port): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port: requestPort,
        method: "GET",
        path,
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
    outgoing.end();
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
