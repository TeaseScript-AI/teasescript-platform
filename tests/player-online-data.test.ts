import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  onlineMediaRepository,
  onlineSavedScripts,
  onlineScriptStorage,
  readOnlineAccount,
} from "../player/online-data.js";
import { PlayerDataContextError, playerDataContext } from "../player/player-data.js";

const server = { server: "https://player.test/api/", token: "token-1" };
const reference = "captured-media:00000000-0000-4000-8000-000000000000:1";

/** Answers every request with `reply` and records what was sent. */
function serve(t: TestContext, reply: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    return reply(request);
  });
  return requests;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the host chooses the data mode, and online mode takes only its own origin with a token", () => {
  const context = (address: string, token: string | null = "abc") =>
    playerDataContext(new URL(address), token);
  assert.deepEqual(context("https://player.test/player/?package=house"), { mode: "standalone" });
  assert.deepEqual(context("https://player.test/player/?data=standalone"), { mode: "standalone" });
  assert.deepEqual(context("https://player.test/player/?data=online&server=/api"), {
    mode: "online",
    server: "https://player.test/api/",
    token: "abc",
  });
  for (const address of [
    "https://player.test/player/?data=local",
    "https://player.test/player/?data=online",
    "https://player.test/player/?data=online&server=https://other.test/api/",
    "https://player.test/player/?data=online&server=//other.test/api/",
  ])
    assert.throws(() => context(address), PlayerDataContextError, address);
  assert.throws(
    () => context("https://player.test/player/?data=online&server=/api/&token=abc", null),
    PlayerDataContextError,
  );
});

test("every request carries the token as a bearer token and a write waits for the server", async (t) => {
  const requests = serve(t, () => new Response(null, { status: 204 }));
  const storage = onlineScriptStorage(server, "development-package:house");
  await storage.write("visits", { kind: "list", items: [1, "two"] });
  await storage.write("", null);
  // A scope is one segment that never reads as `..`.
  await onlineScriptStorage(server, "..").clear();
  assert.deepEqual(
    requests.map((request) => [request.method, request.url]),
    [
      ["PATCH", "https://player.test/api/scripts/%22development-package%3Ahouse%22/storage"],
      ["PATCH", "https://player.test/api/scripts/%22development-package%3Ahouse%22/storage"],
      ["DELETE", "https://player.test/api/scripts/%22..%22/storage"],
    ],
  );
  for (const request of requests)
    assert.equal(request.headers.get("Authorization"), "Bearer token-1");
  assert.deepEqual(await requests[0]!.json(), {
    key: "visits",
    value: { kind: "list", items: [1, "two"] },
  });
  assert.deepEqual(await requests[1]!.json(), { key: "", value: null });
});

test("a failed or refused write rejects, so the session keeps the previous value", async (t) => {
  let status = 503;
  serve(t, () => new Response(null, { status }));
  const storage = onlineScriptStorage(server, "repository-demo");
  await assert.rejects(storage.write("visits", 2), /HTTP 503/u);
  status = 401;
  await assert.rejects(storage.write("visits", 2), /did not accept the token/u);
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(storage.write("visits", 2), /did not answer/u);
});

test("the server's saved values, scripts, and media references are checked before use", async (t) => {
  let reply = json({});
  serve(t, () => reply);
  const storage = onlineScriptStorage(server, "repository-demo");
  reply = json({ entries: [{ key: "visits", value: 2 }] });
  assert.deepEqual(await storage.load(), [{ key: "visits", value: 2 }]);
  for (const invalid of [
    [],
    { entries: [{ key: "visits", value: null }] },
    {
      entries: [
        { key: "visits", value: 1 },
        { key: "visits", value: 2 },
      ],
    },
    { entries: [{ key: 5, value: 1 }] },
  ]) {
    reply = json(invalid);
    await assert.rejects(storage.load(), /not valid/u, JSON.stringify(invalid));
  }
  reply = json({ scripts: [{ scope: "repository-demo", name: null }] });
  assert.deepEqual(await onlineSavedScripts(server).scripts(), [
    { scope: "repository-demo", name: null },
  ]);
  reply = json({ scripts: [{ scope: 3, name: null }] });
  await assert.rejects(onlineSavedScripts(server).scripts(), /not valid/u);
  reply = json({ references: [reference, 7] });
  await assert.rejects(
    onlineMediaRepository(server).listReferences("repository-demo"),
    /not valid/u,
  );
});

test("the account's profile is checked as the runtime's player profile", async (t) => {
  let reply = json({});
  serve(t, () => reply);
  reply = json({ account: "peter", profile: { firstName: "Peter", petNames: ["pet"] } });
  const account = await readOnlineAccount(server);
  assert.deepEqual(account, {
    account: "peter",
    profile: { firstName: "Peter", petNames: ["pet"] },
  });
  assert.equal(Object.isFrozen(account.profile), true);
  reply = json({ account: "peter", profile: { firstName: "Peter", toys: ["gag"] } });
  await assert.rejects(readOnlineAccount(server), /player profile is not valid/u);
  reply = json({ profile: {} });
  await assert.rejects(readOnlineAccount(server), /not valid/u);
});

test("stored media goes up as bytes and comes back as a record the media store accepts", async (t) => {
  const stored = new Map<string, { bytes: ArrayBuffer; fields: string }>();
  const requests = serve(t, async (request) => {
    const key = new URL(request.url).pathname;
    if (request.method === "PUT") {
      if (stored.has(key)) return new Response(null, { status: 409 });
      stored.set(key, {
        bytes: await request.arrayBuffer(),
        fields: request.headers.get("X-Media-Record")!,
      });
      return new Response(null, { status: 201 });
    }
    const record = stored.get(key);
    if (record === undefined) return new Response(null, { status: 404 });
    return new Response(record.bytes, { headers: { "X-Media-Record": record.fields } });
  });
  const repository = onlineMediaRepository(server);
  const data = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const record = {
    namespace: "repository-demo",
    reference,
    kind: "image" as const,
    mimeType: "image/png",
    size: 3,
    width: 2,
    height: 1,
    data,
  };
  assert.equal(await repository.get("repository-demo", reference), null);
  await repository.add(record);
  await assert.rejects(repository.add(record), /HTTP 409/u);
  assert.equal(requests[1]!.headers.get("Content-Type"), "application/octet-stream");
  const media = new CapturedMediaStore(
    repository,
    { create: () => "blob:media", revoke: () => {} },
    "repository-demo",
  );
  const read = await media.read(reference);
  assert.deepEqual(read && { ...read, data: [...new Uint8Array(await read.data.arrayBuffer())] }, {
    ...record,
    data: [1, 2, 3],
  });
  // A reply whose fields do not match its bytes is no record.
  stored.set(new URL(requests[1]!.url).pathname, {
    bytes: new Uint8Array([1]).buffer,
    fields: JSON.stringify({ kind: "image", mimeType: "image/png", size: 3 }),
  });
  const fresh = new CapturedMediaStore(
    repository,
    { create: () => "blob:media", revoke: () => {} },
    "repository-demo",
  );
  assert.equal(await fresh.read(reference), null);
});
