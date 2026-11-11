import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BridgeLostError,
  BridgeRequestError,
  BridgeStartupError,
  connectBridge,
  type BridgeResult,
} from "../../player/engine-bridge/client.js";
import { openEngineWorker } from "../../player/engine-bridge/browser-client.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import { playerBuildIdentity } from "../../player/build-identity.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import type { PrepareResult } from "../../player/engine-bridge/player-ops.js";
import { BRIDGE_VERSION, type BuildIdentity } from "../../player/engine-bridge/protocol.js";
import { compilePlayerProject } from "../../player/runtime/compile-project.js";
import { listRandomSites, validateInstructionPlan } from "../../src/index.js";
import { clockTicket } from "../helpers/clock-ticket.js";
import { untypedClient } from "../helpers/bridge/untyped.js";
import type { UntypedClient } from "../helpers/bridge/untyped.js";

/*
 * The engine bridge over a real worker thread (a separate realm; messages are structured clones): the Worker's
 * readiness and build, `prepare` of a source and of plan text, and the bridge's rules (version, envelope, op,
 * arguments, order, sessions, basis, release, errors, loss) on a fixture counter session.
 */

const BUILD: BuildIdentity = { commit: "c0ffee", dirty: false, mode: "test", appVersion: "1" };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
const FIXTURE_WORKER = new URL("../helpers/bridge-fixture-worker.js", import.meta.url);

/**
 * A client of `entry`, untyped: the fixture Worker serves ops of its own (`add`, `slow`, ...), and the Player Worker's
 * tests send malformed arguments on purpose, neither of which the catalogue's types admit.
 */
async function connectUntyped(entry: URL): Promise<UntypedClient> {
  return untypedClient(await connectBridge(nodeWorkerPort(entry, BUILD), BUILD));
}

async function withClient<T>(entry: URL, body: (client: UntypedClient) => Promise<T>): Promise<T> {
  const client = await connectUntyped(entry);
  try {
    return await body(client);
  } finally {
    client.terminate();
  }
}

/** Every key anywhere in `value`, to show that no plan graph crossed. */
function keys(value: unknown, found = new Set<string>()): Set<string> {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    for (const [key, item] of Object.entries(current)) {
      found.add(key);
      pending.push(item);
    }
  }
  return found;
}

/** The result of a `prepare` reply. */
function prepared(reply: BridgeResult): PrepareResult {
  // EVIDENCE: fixture: `prepare` returns a PrepareResult (player-ops.ts), from the same build.
  return reply.result as PrepareResult;
}

const prepare = async (client: UntypedClient, args: unknown) =>
  prepared(await client.request("prepare", args));

const SOURCE = [
  "---",
  'title: "Bridge"',
  'author: "Lane 3"',
  "---",
  'showImage "a.png"',
  "let n = randomInteger(1..3)",
  'say "n is ${n}"',
  "exit",
].join("\n");

test("a Worker of another build does not start; one of the same build is ready", async () => {
  await assert.rejects(
    connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), { ...BUILD, commit: "other" }),
    BridgeStartupError,
  );
  await withClient(PLAYER_WORKER, async () => {});
});

test("prepare compiles a source in the Worker and returns its token, header and metadata, never the plan", async () => {
  await withClient(PLAYER_WORKER, async (client) => {
    const reply = await client.request("prepare", { source: { kind: "source", script: SOURCE } });
    const result = prepared(reply);
    assert.equal(result.kind, "prepared");
    if (result.kind !== "prepared") return;
    assert.equal(result.plan, "p1");
    assert.deepEqual(result.identity, { title: "Bridge", author: "Lane 3" });
    assert.deepEqual(result.metadata.files, ["main.tease"]);
    assert.deepEqual(result.metadata.stageImages, ["a.png"]);
    // The main realm's own reading of the same plan, which the Worker reports instead of sending the plan.
    assert.deepEqual(
      result.metadata.randomSites,
      listRandomSites(compilePlayerProject(SOURCE).plan!),
    );
    assert.deepEqual([result.metadata.locks, result.metadata.encrypts], [false, false]);
    for (const key of ["instructions", "functions", "storageTypes"])
      assert.ok(!keys(reply).has(key), key);

    // EVIDENCE: fixture: prepare's result is a PrepareResult (player-ops.ts).
    const failed = await prepare(client, { source: { kind: "source", script: "let = 1\nexit" } });
    assert.equal(failed.kind, "notCompiled");
    if (failed.kind === "notCompiled")
      assert.ok(failed.diagnostics.some((item) => item.severity === "error"));
  });
});

test("prepare loads plan text through the owned loader, with the complete diagnostics of an invalid plan", async () => {
  const plan = compilePlayerProject(SOURCE).plan!;
  const text = JSON.stringify(plan);
  const broken = JSON.stringify({ ...plan, version: -1, extra: true });
  await withClient(PLAYER_WORKER, async (client) => {
    // EVIDENCE: fixture: prepare's result is a PrepareResult (player-ops.ts).
    const loaded = await prepare(client, { source: { kind: "plan", text } });
    assert.equal(loaded.kind, "prepared");
    if (loaded.kind === "prepared") {
      assert.equal(loaded.identity, null);
      assert.deepEqual(loaded.metadata.stageImages, ["a.png"]);
    }
    // EVIDENCE: fixture: prepare's result is a PrepareResult (player-ops.ts).
    const invalid = await prepare(client, { source: { kind: "plan", text: broken } });
    assert.deepEqual(invalid, {
      kind: "invalid",
      errors: validateInstructionPlan(JSON.parse(broken)).errors,
    });
    // EVIDENCE: fixture: prepare's result is a PrepareResult (player-ops.ts).
    const unreadable = await prepare(client, { source: { kind: "plan", text: "{" } });
    assert.equal(unreadable.kind, "unreadable");
    await assert.rejects(
      client.request("prepare", { source: { kind: "plan", text: 1 } }),
      (error: unknown) => error instanceof BridgeRequestError && error.code === "arguments",
    );
    // Arrays are read by index: an array's own `every` or a hole is a malformed argument, and the Worker still answers.
    const tampered = Object.assign([{ path: "main.tease", source: "exit" }], { every: 0 });
    const sparse: unknown[] = [];
    sparse.length = 1;
    for (const files of [tampered, sparse])
      await assert.rejects(
        client.request("prepare", { source: { kind: "source", script: { files } } }),
        (error: unknown) => error instanceof BridgeRequestError && error.code === "arguments",
      );
    assert.equal((await client.request("teardown", null)).result, null);
  });
});

/** A refusal's code, from a request that must fail. */
async function refused(request: Promise<unknown>): Promise<string | null> {
  try {
    await request;
  } catch (error) {
    assert.ok(error instanceof BridgeRequestError);
    assert.equal(error.kind, "bridge");
    return error.code;
  }
  assert.fail("The request succeeded.");
}

test("a session op runs only from a revision the session accepts; release ends the session", async () => {
  await withClient(FIXTURE_WORKER, async (client) => {
    const started = await client.request("start", null);
    const session = started.session!;
    assert.equal(started.revision, 0);
    const add = (by: number, basis: number | null) =>
      client.request("add", { by }, { session, basis });
    assert.deepEqual(
      [(await add(1, 0)).result, await add(1, 0).catch(() => "refused")],
      [1, "refused"],
    );
    assert.equal(await refused(add(1, 0)), "basis");
    // An op that changes nothing publishes a revision but keeps earlier ones of the same state usable.
    assert.equal((await add(0, 1)).revision, 2);
    assert.equal((await add(2, 1)).result, 3);
    assert.equal(await refused(add(1, 99)), "basis");
    assert.equal(
      await refused(client.request("add", { by: "x" }, { session, basis: 3 })),
      "arguments",
    );
    assert.equal(await refused(client.request("start", null, { session })), "session");
    assert.equal(await refused(client.request("nothing", null)), "unknownOp");
    await client.request("release", null, { session, basis: null });
    assert.equal(await refused(add(1, 3)), "session");
  });
});

test("an op's error keeps its class, code, details and whether the session ended", async () => {
  await withClient(FIXTURE_WORKER, async (client) => {
    const session = (await client.request("start", null)).session!;
    const error = await client
      .request("fail", null, { session, basis: 0 })
      .catch((e: unknown) => e);
    assert.ok(error instanceof BridgeRequestError);
    assert.deepEqual(
      [error.name, error.kind, error.code, error.info, error.ended],
      ["RangeError", "engine", "TSX001", { path: "$.count" }, true],
    );
    assert.equal(await refused(client.request("add", { by: 1 }, { session, basis: 0 })), "session");
    const checkpoint = await client.request("checkpoint", null).catch((e: unknown) => e);
    assert.ok(checkpoint instanceof BridgeRequestError);
    assert.deepEqual(
      [checkpoint.name, checkpoint.code, checkpoint.info, checkpoint.ended],
      [
        "CheckpointError",
        "TSK001",
        { code: "TSK001", message: "Checkpoint snapshot is invalid.", path: "$.snapshot" },
        false,
      ],
    );
    const clone = await client.request("clone", null).catch((e: unknown) => e);
    assert.ok(clone instanceof BridgeRequestError);
    assert.deepEqual([clone.name, clone.kind], ["DataCloneError", "engine"]);
  });
});

test("requests for one session go one at a time, and a section holds its session for its whole chain", async () => {
  await withClient(FIXTURE_WORKER, async (client) => {
    const order: string[] = [];
    const slow = client.request("slow", 40).then(() => order.push("slow"));
    const quick = client.request("slow", 1).then(() => order.push("quick"));
    await Promise.all([slow, quick]);
    assert.deepEqual(order, ["slow", "quick"]);

    const session = (await client.request("start", null)).session!;
    const seen: unknown[] = [];
    const section = client.section(session, clockTicket(), async (send) => {
      seen.push((await send("add", { by: 1 }, 0)).result);
      await new Promise((resolve) => setTimeout(resolve, 20));
      seen.push((await send("add", { by: 1 }, 1)).result);
    });
    const later = client
      .request("add", { by: 10 }, { session, basis: 2 })
      .then((reply) => seen.push(reply.result));
    await Promise.all([section, later]);
    assert.deepEqual(seen, [1, 2, 12]);
  });
});

/** Raw messages to and from a fixture worker, below the client, for envelopes a client never sends. */
async function rawExchange(messages: unknown[]): Promise<unknown[]> {
  const port = nodeWorkerPort(FIXTURE_WORKER, BUILD);
  const received: unknown[] = [];
  try {
    await new Promise<void>((resolve) => {
      port.listen((data) => {
        received.push(data);
        // The last message is always a well-formed request, so its reply ends the exchange.
        if (typeof data === "object" && data !== null && "id" in data && data.id === 99) resolve();
      });
      for (const message of messages) port.post(message);
    });
  } finally {
    port.terminate();
  }
  return received.slice(1);
}

test("the Worker refuses a wrong version, a malformed envelope and an old ID, and ignores a message without an ID or a malformed flat form", async () => {
  const request = (id: number, extra: Readonly<Record<string, unknown>> = {}) => ({
    v: BRIDGE_VERSION,
    kind: "request",
    id,
    session: null,
    basis: null,
    op: "slow",
    args: 0,
    ...extra,
  });
  const replies = await rawExchange([
    request(5, { v: 2 }),
    request(6, { extra: true }),
    { v: BRIDGE_VERSION, kind: "request" },
    request(10),
    request(10),
    // A flat form (`transport.ts`) is decoded first; a malformed one has no readable ID, so it is ignored.
    { v: BRIDGE_VERSION, kind: "nested", nodes: [request(11)], links: [] },
    { v: BRIDGE_VERSION, kind: "nested", nodes: [request(12)], links: [0, "id", 5] },
    request(99),
  ]);
  const codes = replies.map((reply) => {
    // EVIDENCE: fixture: every message after `ready` is a reply envelope (protocol.ts).
    const { id, ok, error } = reply as { id: number; ok: boolean; error?: { code: string } };
    return ok ? `${id} ok` : `${id} ${error!.code}`;
  });
  assert.deepEqual(codes, ["5 version", "6 envelope", "10 ok", "10 order", "11 ok", "99 ok"]);
});

test("a lost Worker fails its pending requests and every later one; nothing is retried", async () => {
  const client = await connectUntyped(FIXTURE_WORKER);
  const losses: BridgeLostError[] = [];
  client.onLoss((error) => losses.push(error));
  await assert.rejects(client.request("exit", null), BridgeLostError);
  await assert.rejects(client.request("slow", 0), BridgeLostError);
  assert.equal(losses.length, 1);
});

test("an intentional terminate fails pending and later requests but reports no loss", async () => {
  const client = await connectUntyped(FIXTURE_WORKER);
  const losses: BridgeLostError[] = [];
  client.onLoss((error) => losses.push(error));
  const pending = client.request("slow", 0);
  client.terminate();
  await assert.rejects(pending, BridgeLostError);
  await assert.rejects(client.request("slow", 0), BridgeLostError);
  client.onLoss((error) => losses.push(error));
  assert.equal(losses.length, 0);
});

test("the browser Worker's host loads no compiler or language-tooling module until a source is prepared", () => {
  const url = new URL("../../player/engine-bridge/engine-host.js", import.meta.url).href;
  const script = [
    'import { registerHooks } from "node:module";',
    "const loaded = new Set();",
    "registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); loaded.add(result.url); return result; } });",
    // The entry runs as a dedicated Worker's global scope.
    "globalThis.postMessage = () => {};",
    "globalThis.addEventListener = () => {};",
    `await import(${JSON.stringify(url)});`,
    "process.stdout.write(JSON.stringify([...loaded]));",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
  });
  assert.equal(child.status, 0, child.stderr);
  // EVIDENCE: fixture: the child script writes the JSON of a list of URLs.
  const loaded = JSON.parse(child.stdout) as string[];
  assert.ok(loaded.some((module) => module.endsWith("/dist/src/plan/load.js")));
  // The adapter and the recorder run the sessions there, on the playback entry: no compiler comes with them.
  assert.ok(loaded.some((module) => module.endsWith("/dist/player/runtime/runtime-adapter.js")));
  assert.ok(loaded.some((module) => module.endsWith("/dist/player/debug/debug-recorder.js")));
  const authoring =
    /\/dist\/src\/(index|compiler|parser|lexer|semantic|type-checker|language-tooling|source-debug-sidecar|static-types|ast-validation)(\.js$|\/)|\/dist\/src\/(type-inference|editor)\/|\/dist\/player\/runtime\/(compile-project|script-identity)\.js$/;
  assert.deepEqual(
    loaded.filter((module) => authoring.test(module)),
    [],
  );
});

/** An event a fake Worker dispatches: a message's data, or an error's message. */
interface WorkerEvent {
  readonly data?: unknown;
  readonly message?: string;
}

/**
 * A browser `Worker` for `browser-client.ts`, installed as the global for one test: it records how it was constructed,
 * what was posted and whether it was terminated, and dispatches the events a test gives it. `fail` makes its
 * constructor throw, as a browser does for a blocked or opaque-origin script.
 */
function fakeWorkers(context: import("node:test").TestContext, fail: Error | null = null) {
  const made: {
    url: URL;
    options: unknown;
    terminated: boolean;
    emit(type: "message" | "error" | "messageerror", event: WorkerEvent): void;
  }[] = [];
  class FakeWorker {
    readonly #listeners = new Map<string, ((event: WorkerEvent) => void)[]>();
    constructor(url: URL, options: unknown) {
      if (fail !== null) throw fail;
      made.push({
        url,
        options,
        terminated: false,
        emit: (type, event) => {
          for (const listener of this.#listeners.get(type) ?? []) listener(event);
        },
      });
    }
    postMessage() {}
    addEventListener(type: string, listener: (event: WorkerEvent) => void) {
      this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
    }
    terminate() {
      made.at(-1)!.terminated = true;
    }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: FakeWorker });
  context.after(() => Reflect.deleteProperty(globalThis, "Worker"));
  return made;
}

const ready = (build: BuildIdentity = playerBuildIdentity) => ({
  data: { v: BRIDGE_VERSION, kind: "ready", build },
});

test("the page starts the engine's module Worker and has its bridge once a ready of this build arrives", async (context) => {
  const made = fakeWorkers(context);
  const opening = openEngineWorker();
  assert.equal(made.length, 1);
  assert.ok(
    made[0]!.url.href.endsWith("/player/engine-bridge/engine.worker.ts"),
    made[0]!.url.href,
  );
  assert.deepEqual(made[0]!.options, { type: "module" });
  made[0]!.emit("message", ready());
  assert.ok((await opening) instanceof PlayerBridge);
  assert.equal(made[0]!.terminated, false);
});

test("a Worker that cannot start is the page's startup failure, with the browser's message", async (context) => {
  const failure = (message: string) => ({
    name: "BridgeStartupError",
    message: `The engine Worker failed: ${message}`,
  });
  // The constructor throws.
  fakeWorkers(context, new Error("Failed to construct 'Worker': access denied"));
  await assert.rejects(openEngineWorker(), (error: unknown) => {
    assert.ok(error instanceof BridgeStartupError);
    assert.deepEqual(
      { name: error.name, message: error.message },
      failure("Failed to construct 'Worker': access denied"),
    );
    return true;
  });
  // Its events before `ready`: an error with the browser's message, one without (a script that did not load), a message
  // it could not receive, and a ready of another build. Each ends the Worker.
  const cases: readonly [
    type: "error" | "messageerror" | "message",
    event: WorkerEvent,
    message: string,
  ][] = [
    [
      "error",
      { message: "Uncaught SyntaxError: Unexpected token" },
      "The engine Worker failed: Uncaught SyntaxError: Unexpected token",
    ],
    ["error", {}, "The engine Worker failed: its script could not be loaded or run"],
    ["messageerror", {}, "The engine Worker failed: it sent a message the page cannot receive"],
    [
      "message",
      ready({ ...playerBuildIdentity, commit: "another" }),
      "The engine Worker belongs to another build of the Player.",
    ],
  ];
  for (const [type, event, message] of cases) {
    const made = fakeWorkers(context);
    const opening = openEngineWorker();
    made[0]!.emit(type, event);
    await assert.rejects(opening, (error: unknown) => {
      assert.ok(error instanceof BridgeStartupError, `${type}: ${String(error)}`);
      assert.equal(error.message, message);
      return true;
    });
    assert.equal(made[0]!.terminated, true, type);
  }
});

test("after ready, the Worker's error is the bridge's loss", async (context) => {
  const made = fakeWorkers(context);
  const opening = openEngineWorker();
  made[0]!.emit("message", ready());
  const bridge = await opening;
  const lost = new Promise<BridgeLostError>((resolve) => bridge.client.onLoss(resolve));
  made[0]!.emit("error", { message: "Uncaught RangeError: Maximum call stack size exceeded" });
  const error = await lost;
  assert.ok(error instanceof BridgeLostError);
  assert.match(error.message, /Maximum call stack size exceeded/u);
  assert.equal(made[0]!.terminated, true);
});
