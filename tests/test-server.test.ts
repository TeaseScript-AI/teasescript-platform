import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import { effectScope } from "vue";

import { CapturedMediaStore, type CapturedMediaRepository } from "../player/captured-media.js";
import type { CapturedMediaLocks } from "../player/captured-media-persistence.js";
import type { DebugRecorder } from "../player/debug-recorder.js";
import type { KeptSessionStore, KeptSessionUpdate } from "../player/kept-sessions.js";
import { uncoordinatedCapturedMediaLocks } from "../player/captured-media-persistence.js";
import {
  onlineKeptSessions,
  onlineMediaRepository,
  onlineSavedScripts,
  onlineScriptStorage,
  readOnlineAccount,
} from "../player/online-data.js";
import {
  activatePlayerRuntimeButton,
  createPlayerRuntimeSession,
  type PlayerRuntimeSession,
  type PlayerRuntimeSessionOptions,
} from "../player/runtime-adapter.js";
import type { ScriptStorageProvider } from "../player/script-storage.js";
import type { InstructionPlan } from "../src/index.js";
import { createSourcePosition, createSourceSpan } from "../src/source.js";
import { testServer } from "../test-server/server.js";
import { loadPlayerModule } from "./helpers/player-modules.js";

// The temporary test server answers the Player's online client: this test goes when the test server goes.

const log: string[] = [];
const instance = testServer({
  data: ":memory:",
  account: "peter",
  latency: { normalMs: 0, slowMs: 0, jitterMs: 0 },
  log: (line) => log.push(line),
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
  // A script with a name but no saved values is not listed.
  listing.rememberName("named only", "Nothing saved");
  // The names are stored in the background; a listing after the next request sees them.
  await storage.load();
  assert.deepEqual(await listing.scripts(), [
    { scope: "..", name: null },
    { scope: "development-package:house", name: "House" },
  ]);
  await storage.clear();
  assert.deepEqual(await storage.load(), []);
  assert.deepEqual(await listing.scripts(), [{ scope: "..", name: null }]);
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

test("a kept session continues on another device, and a stale Player cannot overwrite it", async () => {
  const at = createSourcePosition(0, 0, 0);
  const events = (...sequences: number[]): KeptSessionUpdate["events"] =>
    sequences.map((sequence) => ({ kind: "exit", sequence, span: createSourceSpan(at, at) }));
  const update = (eventsFrom: number, snapshotJson: string, ...sequences: number[]) => ({
    planJson: eventsFrom === 0 ? "plan" : null,
    snapshotJson,
    eventsFrom,
    events: events(...sequences),
    marks: { editedWhileDebugging: null, rewoundWhileDebugging: null },
  });
  const phone = onlineKeptSessions(server);
  const laptop = onlineKeptSessions(server);
  assert.equal(await phone.session("kept"), null);
  await phone.publish("kept", update(0, "one", 1));
  await phone.publish("kept", update(1, "two", 2));
  assert.deepEqual(await laptop.session("kept"), {
    planJson: "plan",
    snapshotJson: "two",
    events: JSON.parse(JSON.stringify(events(1, 2))),
    marks: { editedWhileDebugging: null, rewoundWhileDebugging: null },
  });
  // The phone plays on; the laptop continued from what it read before and is refused.
  await phone.publish("kept", update(2, "three", 3));
  await assert.rejects(laptop.publish("kept", update(2, "elsewhere", 3)), /HTTP 409/u);
  assert.equal((await phone.session("kept"))?.snapshotJson, "three");
  // Once it reads the session again, the laptop takes it over.
  await laptop.session("kept");
  await laptop.publish("kept", update(3, "four", 4));
  await assert.rejects(phone.publish("kept", update(3, "stale", 4)), /HTTP 409/u);
  await assert.rejects(laptop.publish("kept", update(9, "gap", 10)), /HTTP 400/u);
  const photo = {
    namespace: "kept",
    reference,
    kind: "image" as const,
    mimeType: "image/png",
    size: 1,
    data: new Blob([new Uint8Array([7])], { type: "image/png" }),
  };
  await laptop.media.add(photo);
  assert.notEqual(await phone.media.get("kept", reference), null);
  // Saved photos are apart from a kept session's.
  assert.equal(await onlineMediaRepository(server).get("kept", reference), null);
  // A Player that found the session cannot replace it with a new one once another kept it meanwhile.
  await laptop.publish("kept", update(4, "five", 5));
  await assert.rejects(phone.discard("kept", true), /HTTP 409/u);
  assert.equal((await laptop.session("kept"))?.snapshotJson, "five");
  // A discard that is no new session, such as an import's, goes ahead.
  await phone.discard("kept");
  assert.equal(await laptop.session("kept"), null);
  assert.equal(await laptop.media.get("kept", reference), null);
  // A new session after a discard is kept, by the Player that discarded and by one that found none.
  await phone.publish("kept", update(0, "new", 1));
  await phone.discard("kept");
  assert.equal(await laptop.session("kept"), null);
  await laptop.publish("kept", update(0, "newer", 1));
  assert.equal((await phone.session("kept"))?.snapshotJson, "newer");
});

test("saved values written meanwhile by another Player are kept, and the stand-in page lists both writers", async () => {
  const phone = onlineScriptStorage(server, "shared");
  const laptop = onlineScriptStorage(server, "shared");
  await phone.load();
  await laptop.load();
  await phone.write("level", 1);
  await laptop.write("level", 2);
  assert.deepEqual(await phone.load(), [{ key: "level", value: 2 }]);
  // Having read the latest values, the phone is no second writer.
  await phone.write("level", 3);
  const page = await (await fetch(new URL("/", server.server))).text();
  assert.equal(page.match(/saved values · shared/gu)?.length, 1);
  assert.equal(page.match(/kept session · kept/gu)?.length, 3);
});

test("of two overlapping keeps from the same revision, only the one the server finishes reading first is kept", async () => {
  const sessions = onlineKeptSessions(server);
  const at = createSourcePosition(0, 0, 0);
  const marks = { editedWhileDebugging: null, rewoundWhileDebugging: null };
  assert.equal(await sessions.session("overlap"), null);
  await sessions.publish("overlap", {
    planJson: "plan",
    snapshotJson: "first",
    eventsFrom: 0,
    events: [{ kind: "exit", sequence: 1, span: createSourceSpan(at, at) }],
    marks,
  });
  const { origin } = new URL(server.server);
  const url = `${origin}/api/scripts/${encodeURIComponent('"overlap"')}/session`;
  const body = (snapshotJson: string) =>
    JSON.stringify({ planJson: null, snapshotJson, eventsFrom: 1, events: [], marks });
  const headers = (text: string) => ({
    Authorization: `Bearer ${server.token}`,
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(text)),
    "X-Base-Revision": "1",
  });
  // The slow keep sends half of its body, and the fast one all of it, while the slow one waits.
  const slowBody = body("slow");
  const slow = httpRequest(url, { method: "PUT", headers: headers(slowBody) });
  const slowStatus = new Promise<number | undefined>((resolve, reject) => {
    slow.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    slow.on("error", reject);
  });
  slow.write(slowBody.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 100));
  const fastBody = body("fast");
  const fast = await fetch(url, { method: "PUT", headers: headers(fastBody), body: fastBody });
  assert.equal(fast.status, 204);
  slow.end(slowBody.slice(10));
  assert.equal(await slowStatus, 409);
  assert.equal((await sessions.session("overlap"))?.snapshotJson, "fast");
});

test("a photo the server keeps with a session is sent once, however often the session is kept", async () => {
  const sessions = onlineKeptSessions(server);
  const photo = {
    namespace: "photos-once",
    reference,
    kind: "image" as const,
    mimeType: "image/png",
    size: 1,
    data: new Blob([new Uint8Array([7])], { type: "image/png" }),
  };
  await sessions.media.add(photo);
  await assert.rejects(sessions.media.add(photo), { name: "ConstraintError" });
  assert.equal(
    log.filter((line) => line.startsWith("PUT /api/scripts/%22photos-once%22/session-media/"))
      .length,
    1,
  );
  // After a discard the photo is sent again with the next session.
  await sessions.discard("photos-once");
  await sessions.media.add(photo);
  assert.equal(
    log.filter((line) => line.startsWith("PUT /api/scripts/%22photos-once%22/session-media/"))
      .length,
    2,
  );
});

test("a Player that starts over a session another Player kept meanwhile leaves that session, and the server notices", async (context) => {
  // EVIDENCE: validation: Vite loaded the real source module; this test uses only these members of its host API.
  const { usePlayerSession } = (await loadPlayerModule("player/vue/src/usePlayerSession.ts")) as {
    usePlayerSession(options: {
      readonly scriptStorage: ScriptStorageProvider;
      readonly keptSessions: KeptSessionStore;
      readonly capturedMedia: {
        readonly repository: CapturedMediaRepository;
        readonly locks: CapturedMediaLocks;
      };
    }): {
      readonly session: { readonly value: PlayerRuntimeSession | null };
      loadScriptStorage(): Promise<void>;
      scriptStorageOptions(): PlayerRuntimeSessionOptions;
      prepareScript(
        plan: InstructionPlan,
        create: (recording: { readonly recorder: DebugRecorder }) => PlayerRuntimeSession,
      ): Promise<void>;
      activate(): void;
      update(session: PlayerRuntimeSession): void;
    };
  };
  // Event targets are the browser surface a session that only shows buttons uses.
  for (const name of ["document", "window"]) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    const target = Object.assign(new EventTarget(), { visibilityState: "visible" });
    Object.defineProperty(globalThis, name, { configurable: true, value: target });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const source = 'showButton "First"\nshowButton "Second"\nexit';
  const plan = createPlayerRuntimeSession(source).plan;
  const open = async () => {
    const scope = effectScope();
    context.after(() => scope.stop());
    const locks = uncoordinatedCapturedMediaLocks();
    const player = scope.run(() =>
      usePlayerSession({
        scriptStorage: onlineScriptStorage(server, "two-starts"),
        keptSessions: onlineKeptSessions(server),
        capturedMedia: { repository: onlineMediaRepository(server), locks },
      }),
    )!;
    await player.loadScriptStorage();
    await player.prepareScript(plan, (recording) =>
      createPlayerRuntimeSession(plan, { ...recording, ...player.scriptStorageOptions() }),
    );
    return player;
  };
  const kept = onlineKeptSessions(server);
  const until = async (done: () => Promise<boolean>) => {
    const deadline = Date.now() + 4000;
    while (!(await done())) {
      assert.ok(Date.now() < deadline, "Timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  // Both Players show Start; the first starts and plays on, then the second starts too.
  const first = await open();
  const second = await open();
  first.activate();
  first.update(activatePlayerRuntimeButton(first.session.value!)!.session);
  await until(
    async () =>
      (await kept.session("two-starts"))?.events.length === first.session.value?.events.length,
  );
  const before = await kept.session("two-starts");
  second.activate();
  await until(async () => log.includes("Two writers: kept session of two-starts"));
  assert.deepEqual(await kept.session("two-starts"), before);
});
