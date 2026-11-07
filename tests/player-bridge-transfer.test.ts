import assert from "node:assert/strict";
import test from "node:test";

import { compilePlayerProject, createPlayerRuntimeSession } from "../player/compile-project.js";
import { BridgeRequestError, connectBridge } from "../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../player/engine-bridge/node-client.js";
import {
  playerBridgeOps,
  playerOpsContext,
  type PrepareResult,
} from "../player/engine-bridge/player-ops.js";
import type { HostSessions } from "../player/engine-bridge/worker-host.js";
import { PlayerBridge } from "../player/player-bridge.js";
import {
  createPlayerRuntimeRestorePoint,
  playerRuntimeSnapshotJson,
} from "../player/runtime-adapter.js";
import {
  sessionTransferText,
  type SessionTransfer,
  type SessionTransferMedium,
} from "../player/session-transfer.js";
import { readPlayerTransferText, restoreSessionTransfer } from "../player/session-transfer-read.js";
import { storageTransferFile, type StorageBundle } from "../player/storage-transfer.js";
import { serializeValidatedRuntimeJson } from "../src/runtime/snapshot/checkpoint-json.js";
import { cloneGraphDifference } from "./helpers/clone-graph.js";
import { inProcessBridge } from "./helpers/in-process-bridge.js";

/*
 * The reading of an exported file or text in the engine host (`ops/transfer.ts`, L5h.2): the parse, the validation and
 * a session's restore give what the main realm's reader gives, in-process and over a Worker, with every refusal's class
 * and words; the checkpoint and the restored state stay in the host under a ticket until it is let go of.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../player/engine-bridge/node-worker.js", import.meta.url);
const SCOPE = "development-package:story";
const photo = "captured-media:11111111-1111-4111-8111-111111111111:1";
const SOURCE = `let picture = "${photo}"\nsay "Hello", instant\nlet name = askText "Your name?"\nsay "Hi \${name}", instant\nexit`;
const PLAN = compilePlayerProject(SOURCE).plan!;
const PLAN_JSON = serializeValidatedRuntimeJson(PLAN);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const MEDIA: SessionTransferMedium[] = [
  {
    reference: photo,
    kind: "image",
    type: "image/png",
    width: 2,
    height: 2,
    durationMs: null,
    bytes: PNG,
  },
];

/** A session of `PLAN` at its question, with a saved value that holds its photo. */
function transferAt(session = createPlayerRuntimeSession(PLAN)): SessionTransfer {
  return {
    scope: SCOPE,
    name: "Story",
    session: createPlayerRuntimeRestorePoint(session),
    entries: [{ key: "photo", value: photo }],
    media: MEDIA,
  };
}

async function prepared(bridge: PlayerBridge, text = PLAN_JSON): Promise<string> {
  const reply = await bridge.client.request("prepare", { source: { kind: "plan", text } });
  // EVIDENCE: validation: `prepare` replies from the same build with its result.
  const result = reply.result as PrepareResult;
  assert.equal(result.kind, "prepared");
  return result.kind === "prepared" ? result.plan : "";
}

const worker = async () =>
  new PlayerBridge(await connectBridge(nodeWorkerPort(PLAYER_WORKER, BUILD), BUILD));

/** Runs `body` on the in-process backend and on a Node Worker; terminates the Worker after. */
async function onBoth<T>(body: (bridge: PlayerBridge) => Promise<T>): Promise<[T, T]> {
  const inProcess = await body(await inProcessBridge());
  const remote = await worker();
  try {
    return [inProcess, await body(remote)];
  } finally {
    remote.client.terminate();
  }
}

/** `value`, checked to be an object. */
function objectOf(value: unknown): object {
  assert.ok(typeof value === "object" && value !== null);
  return value;
}

/** The ticket of a session `readTransfer` read. */
function ticketIn(result: unknown): string {
  const value = objectOf(result);
  assert.ok("ticket" in value && typeof value.ticket === "string");
  return value.ticket;
}

/** The refusal of `request`, as the main side meets it: its class and words. */
async function refusal(request: Promise<unknown>): Promise<{ name: string; message: string }> {
  const error = await request.then(
    () => assert.fail("not refused"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof Error);
  return { name: error.name, message: error.message };
}

test("a session read, reviewed and committed in the host gives what the main realm's restore gives, in-process and in a Worker", async () => {
  const transfer = transferAt();
  const text = await sessionTransferText(transfer, false);
  // The oracle: today's reader and restore in the main realm.
  const read = await readPlayerTransferText(text);
  assert.ok(read.kind === "session");
  const expected = {
    snapshotJson: playerRuntimeSnapshotJson(restoreSessionTransfer(read.session, SCOPE, PLAN_JSON)),
    eventsJson: read.session.session.events.map(serializeValidatedRuntimeJson),
  };
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const plan = await prepared(bridge);
    // EVIDENCE: fixture: `readTransfer` of a session answers its plain parts and a ticket, checked below.
    const answer = (await bridge.client.request("readTransfer", { text })).result as {
      readonly kind: string;
      readonly ticket: string;
    };
    assert.deepEqual(Object.keys(answer).sort(), [
      "entries",
      "events",
      "kind",
      "media",
      "name",
      "scope",
      "ticket",
    ]);
    // The checkpoint stays in the host.
    assert.equal(
      JSON.stringify(answer).includes(transfer.session.checkpointJson.slice(0, 200)),
      false,
    );
    await bridge.client.request("reviewTransfer", { ticket: answer.ticket, scope: SCOPE, plan });
    const committed = (await bridge.client.request("transferCommit", { ticket: answer.ticket }))
      .result;
    assert.deepEqual(committed, expected);
    const { ticket: _ticket, ...rest } = answer;
    return rest;
  });
  assert.equal(cloneGraphDifference(remote, inProcess), null);
  assert.deepEqual(inProcess, {
    kind: "session",
    scope: SCOPE,
    name: "Story",
    entries: read.session.entries,
    media: read.session.media,
    events: read.session.session.events,
  });
});

test("saved data comes back whole from the host, as the main realm's reader gives it", async () => {
  const bundle: StorageBundle = {
    scripts: [
      { scope: SCOPE, name: null, photos: [photo], entries: [{ key: "photo", value: photo }] },
    ],
    images: [{ reference: photo, bytes: PNG }],
  };
  const bytes = new Uint8Array(await (await storageTransferFile(bundle, false)).arrayBuffer());
  const [inProcess, remote] = await onBoth(
    async (bridge) => (await bridge.client.request("readTransfer", { bytes })).result,
  );
  assert.deepEqual(inProcess, remote);
  assert.deepEqual(inProcess, { kind: "savedData", bundle });
});

test("every refusal keeps its class and its words, in-process and in a Worker", async () => {
  // EVIDENCE: fixture: an exported session is a JSON object.
  const exported = JSON.parse(await sessionTransferText(transferAt(), false)) as Record<
    string,
    unknown
  >;
  const documents = [
    "not json",
    JSON.stringify({ format: "teasescript-checkpoint" }),
    JSON.stringify({ ...exported, version: 2 }),
    JSON.stringify({ ...exported, extra: true }),
    JSON.stringify({ ...exported, checkpoint: null }),
    JSON.stringify({ ...exported, events: [{ kind: "damaged" }] }),
    JSON.stringify({ ...exported, entries: [{ key: 1, value: 1 }] }),
    JSON.stringify({ ...exported, media: {} }),
  ];
  const expected = await Promise.all(
    documents.map((text) => refusal(readPlayerTransferText(text))),
  );
  for (const answer of expected) assert.equal(answer.name, "StorageTransferError");
  // A review's refusals: another script, another plan, a damaged state, an ended session.
  const ended = transferAt(createPlayerRuntimeSession('say "Bye", instant\nexit'));
  const reviews = [
    { text: JSON.stringify(exported), scope: "development-package:other", planText: PLAN_JSON },
    {
      text: JSON.stringify(exported),
      scope: SCOPE,
      planText: serializeValidatedRuntimeJson(
        compilePlayerProject(SOURCE.replace("Hello", "Hello again")).plan!,
      ),
    },
    {
      text: JSON.stringify({
        ...exported,
        checkpoint: { ...objectOf(exported.checkpoint), version: 1 },
      }),
      scope: SCOPE,
      planText: PLAN_JSON,
    },
    { text: await sessionTransferText(ended, false), scope: SCOPE, planText: PLAN_JSON },
  ];
  const expectedReviews = await Promise.all(
    reviews.map(async ({ text, scope, planText }) => {
      const read = await readPlayerTransferText(text);
      assert.ok(read.kind === "session");
      return refusal(
        Promise.resolve().then(() => restoreSessionTransfer(read.session, scope, planText)),
      );
    }),
  );
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const reads = await Promise.all(
      documents.map((text) => refusal(bridge.client.request("readTransfer", { text }))),
    );
    const reviewed = [];
    for (const { text, scope, planText } of reviews) {
      const plan = await prepared(bridge, planText);
      // EVIDENCE: fixture: `readTransfer` of a session answers its ticket.
      const answer = (await bridge.client.request("readTransfer", { text })).result as {
        readonly ticket: string;
      };
      reviewed.push(
        await refusal(
          bridge.client.request("reviewTransfer", { ticket: answer.ticket, scope, plan }),
        ),
      );
    }
    return { reads, reviewed };
  });
  assert.deepEqual(inProcess, remote);
  assert.deepEqual(inProcess, { reads: expected, reviewed: expectedReviews });
});

/** The host's ops on one connection, with no session. */
function connection() {
  const context = playerOpsContext();
  const ops = playerBridgeOps(context);
  const sessions: HostSessions = {
    get: () => undefined,
    add: () => {
      throw new Error("No session here");
    },
    delete: () => {},
    clear: () => {},
  };
  const run = async (op: string, args: unknown) => ops[op]!.run(args, sessions, null);
  return { context, run };
}

test("a ticket stays in the host until it is let go of or the connection is torn down", async () => {
  const { context, run } = connection();
  const text = await sessionTransferText(transferAt(), false);
  const ticketOf = async () => ticketIn((await run("readTransfer", { text })).result);
  const first = await ticketOf();
  assert.equal(context.transfers.size, 1);
  await run("releaseTransfer", { ticket: first });
  assert.equal(context.transfers.size, 0);
  await assert.rejects(run("transferCommit", { ticket: first }), /No session read for an import/);
  await ticketOf();
  await ticketOf();
  assert.equal(context.transfers.size, 2);
  await run("teardown", null);
  assert.equal(context.transfers.size, 0);
});

test("the review compares the plans with the JSON the lease holds, and writes the held plan no more", async () => {
  const { context, run } = connection();
  // EVIDENCE: fixture: `prepare` of this plan's text prepares.
  const plan = (
    (await run("prepare", { source: { kind: "plan", text: PLAN_JSON } })).result as { plan: string }
  ).plan;
  await run("preparePlanText", { plan });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const held = context.plans.get(plan);
  const text = await sessionTransferText(transferAt(), false);
  // EVIDENCE: fixture: `readTransfer` of a session answers its ticket.
  const { ticket } = (await run("readTransfer", { text })).result as { ticket: string };
  const stringify = JSON.stringify;
  let writes = 0;
  JSON.stringify = new Proxy(stringify, {
    apply(target, _self, args) {
      if (args[0] === held) writes += 1;
      return target(args[0], args[1], args[2]);
    },
  });
  try {
    await run("reviewTransfer", { ticket, scope: SCOPE, plan });
  } finally {
    JSON.stringify = stringify;
  }
  assert.equal(writes, 0);
});

test("a refusal keeps its class across the bridge: the host's error names it", async () => {
  const bridge = await inProcessBridge();
  const error = await bridge.client.request("readTransfer", { text: "not json" }).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof BridgeRequestError);
  assert.equal(error.name, "StorageTransferError");
});
