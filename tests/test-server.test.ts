import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  onlineMediaRepository,
  onlineSavedScripts,
  onlineScriptStorage,
  readOnlineAccount,
} from "../player/online-data.js";
import { testServer } from "../test-server/server.js";

// The temporary test server answers the Player's online client: this test goes when the test server goes.

const instance = testServer({
  data: ":memory:",
  account: "peter",
  latency: { normalMs: 0, slowMs: 0, jitterMs: 0 },
});
const http = createServer(instance.listener);
let server = { server: "", token: "" };
const reference = "captured-media:00000000-0000-4000-8000-000000000000:1";
const byKey = <T extends { readonly key: string }>(entries: readonly T[]) =>
  [...entries].sort((left, right) => (left.key < right.key ? -1 : 1));

before(async () => {
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  // EVIDENCE: invariant: a server listening on TCP has an AddressInfo address.
  const { port } = http.address() as AddressInfo;
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  const token = /"token":"([^"]+)"/u.exec(page)?.[1];
  assert.ok(token, "The stand-in page carries the account's token");
  server = { server: `http://127.0.0.1:${port}/api/`, token };
});
after(async () => {
  await new Promise((resolve) => http.close(resolve));
  instance.close();
});

test("the account, its profile, and a profile the stand-in page changes reach the Player", async () => {
  assert.deepEqual(await readOnlineAccount(server), {
    account: "peter",
    profile: { firstName: "Peter", displayName: "Peter" },
  });
  const origin = new URL(server.server).origin;
  const change = (profile: unknown) =>
    fetch(`${origin}/test-server/state`, { method: "POST", body: JSON.stringify({ profile }) });
  assert.equal((await change({ firstName: "Peter", toys: ["gag"] })).status, 400);
  assert.equal((await change({ firstName: "Pete", petNames: ["pet"] })).status, 200);
  assert.deepEqual((await readOnlineAccount(server)).profile, {
    firstName: "Pete",
    petNames: ["pet"],
  });
  await assert.rejects(readOnlineAccount({ ...server, token: "wrong" }), /did not accept/u);
});

test("saved values round-trip exactly, per scope, also for texts a path could not hold", async () => {
  const storage = onlineScriptStorage(server, "development-package:house");
  const odd = onlineScriptStorage(server, "..");
  await storage.write("visits", 2);
  await storage.write("\ud800 lone", { kind: "list", items: ["a", 1.5] });
  await odd.write("visits", 9);
  assert.deepEqual(byKey(await storage.load()), [
    { key: "visits", value: 2 },
    { key: "\ud800 lone", value: { kind: "list", items: ["a", 1.5] } },
  ]);
  assert.deepEqual(await odd.load(), [{ key: "visits", value: 9 }]);
  await storage.write("visits", null);
  await storage.replace([{ key: "level", value: "high" }]);
  assert.deepEqual(await storage.load(), [{ key: "level", value: "high" }]);
  const listing = onlineSavedScripts(server);
  listing.rememberName("development-package:house", "House");
  // The name is stored in the background; a listing after the next request sees it.
  await storage.load();
  assert.deepEqual(await listing.scripts(), [
    { scope: "..", name: null },
    { scope: "development-package:house", name: "House" },
  ]);
  await storage.clear();
  assert.deepEqual(await storage.load(), []);
});

test("a photo goes up once and comes back as a record the media store accepts", async () => {
  const repository = onlineMediaRepository(server);
  const record = {
    namespace: "repository-demo",
    reference,
    kind: "image" as const,
    mimeType: "image/png",
    size: 3,
    width: 2,
    height: 1,
    data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  };
  await repository.add(record);
  await assert.rejects(repository.add(record), /HTTP 409/u);
  assert.deepEqual(await repository.listReferences("repository-demo"), [reference]);
  assert.deepEqual(await repository.listReferences("other"), []);
  const read = await new CapturedMediaStore(
    repository,
    { create: () => "blob:media", revoke: () => {} },
    "repository-demo",
  ).read(reference);
  assert.deepEqual(read && [...new Uint8Array(await read.data.arrayBuffer())], [1, 2, 3]);
  await repository.delete("repository-demo", reference);
  assert.equal(await repository.get("repository-demo", reference), null);
});

test("the switches fail the next write without storing it, and take the server down", async () => {
  const origin = new URL(server.server).origin;
  const storage = onlineScriptStorage(server, "faults");
  await storage.write("visits", 1);
  instance.state.failNextWrite = true;
  await assert.rejects(storage.write("visits", 2), /HTTP 503/u);
  assert.equal(instance.state.failNextWrite, false);
  await storage.write("other", 1);
  assert.deepEqual(byKey(await storage.load()), [
    { key: "other", value: 1 },
    { key: "visits", value: 1 },
  ]);
  const down = await fetch(`${origin}/test-server/state`, {
    method: "POST",
    body: JSON.stringify({ down: true }),
  });
  assert.equal((await down.json()).down, true);
  await assert.rejects(storage.load(), /HTTP 503/u);
  instance.state.down = false;
  assert.equal((await storage.load()).length, 2);
});

test("the server refuses saved values that are not valid", async () => {
  const response = await fetch(`${server.server}scripts/${encodeURIComponent('"x"')}/storage`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ key: "visits", value: { kind: "nothing" } }),
  });
  assert.equal(response.status, 400);
});
