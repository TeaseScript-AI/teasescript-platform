import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

import {
  compilePlayerProject,
  createPlayerRuntimeSession,
} from "../../player/runtime/compile-project.js";
import { BridgeRequestError, connectBridge } from "../../player/engine-bridge/client.js";
import { nodeWorkerPort } from "../../player/engine-bridge/node-client.js";
import {
  playerBridgeOps,
  playerOpsContext,
  type PrepareResult,
} from "../../player/engine-bridge/player-ops.js";
import type { HostSessions } from "../../player/engine-bridge/worker-host.js";
import { transferOps } from "../../player/engine-bridge/ops/transfer.js";
import { PlayerBridge } from "../../player/runtime/player-bridge.js";
import {
  createPlayerRuntimeRestorePoint,
  playerRuntimeSnapshotJson,
} from "../../player/runtime/runtime-adapter.js";
import {
  sessionTransferFile,
  sessionTransferText,
  type SessionTransfer,
  type SessionTransferMedium,
} from "../../player/persistence/session-transfer.js";
import {
  readPlayerTransferText,
  restoreSessionTransfer,
} from "../../player/persistence/session-transfer-read.js";
import {
  storageTransferFile,
  type StorageBundle,
} from "../../player/persistence/storage-transfer.js";
import { serializeValidatedRuntimeJson } from "../../src/runtime/snapshot/checkpoint-json.js";
import {
  formObligations,
  malformedArguments,
  type ArgumentForm,
} from "../helpers/bridge/argument-forms.js";
import { cloneGraphDifference } from "../helpers/clone-graph.js";
import { inProcessBridge } from "../helpers/in-process-bridge.js";
import { deliveredRun } from "../helpers/bridge/delivered-run.js";

/*
 * The reading of an exported file or text in the engine host (`ops/transfer.ts`, L5h.2): the parse, the validation and
 * a session's restore give what the main realm's reader gives, in-process and over a Worker, with every refusal's class
 * and words; the checkpoint and the restored state stay in the host under a ticket until it is let go of.
 */

const BUILD = { commit: null, dirty: null, mode: null, appVersion: null };
const PLAYER_WORKER = new URL("../../player/engine-bridge/node-worker.js", import.meta.url);
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

/*
 * The transfer ops' family: each op of `transferOps` with each of its declared outcomes, every malformed argument its
 * forms give (`ARGUMENTS`), and each refusal the reader and the review make (`player/persistence/session-transfer-read.ts`). Refusal messages are
 * written here; commit contents are compared with a direct-reader result. Every row runs in-process and over a Node
 * Worker. The coverage check compares the rows with the ops, their declared outcomes, and each `StorageTransferError`
 * the reader's source raises.
 */

/** Each transfer op's outcomes; a row names one, and each is some row's. */
const OUTCOMES = {
  readTransfer: ["session", "savedData", "refused", "malformed"],
  reviewTransfer: [
    "reviewed",
    "reviewedAgain",
    "refused",
    "unknownTicket",
    "unknownPlan",
    "malformed",
  ],
  transferCommit: ["committed", "committedAgain", "unreviewed", "unknownTicket", "malformed"],
  releaseTransfer: ["released", "unknownTicket", "malformed"],
} as const satisfies Record<keyof ReturnType<typeof transferOps>, readonly string[]>;
type TransferOp = keyof typeof OUTCOMES;

/** Refusals of the reader's source no row reaches, by their words, and why. */
const UNREACHED: Readonly<Record<string, string>> = {
  "This session's checkpoint is too large for this browser.":
    "a checkpoint whose JSON passes the engine's string limit, far above what a test can build",
};

/** What a row answers: its op's result, projected, or the refusal's class and words. */
type Answer = { readonly answer: Answered } | { readonly name: string; readonly message: string };
/** An op's result as a row compares it: a read's kind, a commit's strings, or `null`. */
type Answered = string | Committed | null;
interface Committed {
  readonly snapshotJson: string;
  readonly eventsJson: readonly string[];
}

interface Row {
  readonly op: TransferOp;
  readonly outcome: string;
  /** A malformed row's argument form, as `malformedArguments` names it. */
  readonly form?: string;
  /** Makes the row's requests on `bridge`; its answer is the last one's. */
  readonly run: (bridge: PlayerBridge) => Promise<Answer>;
  readonly expected: Answer;
}

/** The answer of `request`, its result projected by `project`, or its refusal. */
async function answerOf(
  request: Promise<{ readonly result: unknown }>,
  project: (result: unknown) => Answered = nullOf,
): Promise<Answer> {
  try {
    return { answer: project((await request).result) };
  } catch (error) {
    assert.ok(error instanceof Error);
    return { name: error.name, message: error.message };
  }
}

const refusedWith = (message: string): Answer => ({ name: "StorageTransferError", message });
const MALFORMED = (op: string): Answer => ({
  name: "BridgeRefusal",
  message: `Malformed arguments for '${op}'.`,
});
const NO_TICKET = {
  name: "Error",
  message: "No session read for an import is held under this ticket.",
};
/** A read's kind. */
function kindOf(result: unknown): string {
  const value = objectOf(result);
  assert.ok("kind" in value && typeof value.kind === "string");
  return value.kind;
}
/** A result that is none. */
function nullOf(result: unknown): null {
  assert.equal(result, null);
  return null;
}
/** A commit's state and events' JSON. */
function committedOf(result: unknown): Committed {
  const value = objectOf(result);
  assert.ok("snapshotJson" in value && typeof value.snapshotJson === "string");
  assert.ok("eventsJson" in value && isStringArray(value.eventsJson));
  return { snapshotJson: value.snapshotJson, eventsJson: value.eventsJson };
}
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** The exported session's document, as JSON. */
const exportedDocument = async (): Promise<Record<string, unknown>> =>
  // EVIDENCE: fixture: an exported session is a JSON object.
  JSON.parse(await sessionTransferText(transferAt(), false)) as Record<string, unknown>;

/** The first medium of the exported session's document. */
const mediumOf = (document: Record<string, unknown>) => {
  const media = document.media;
  assert.ok(Array.isArray(media));
  return { ...objectOf(media[0]) };
};

const ENDED_PLAN = compilePlayerProject('say "Bye", instant\nexit').plan!;
const OTHER_PLAN_JSON = serializeValidatedRuntimeJson(
  compilePlayerProject(SOURCE.replace("Hello", "Hello again")).plan!,
);
const UNUSED = "captured-media:22222222-2222-4222-8222-222222222222:1";

/** A document read: `change` makes it from the exported session's. */
const readRow = (
  outcome: string,
  change: (document: Record<string, unknown>) => object,
  expected: Answer,
): Row => ({
  op: "readTransfer",
  outcome,
  run: async (bridge) =>
    answerOf(
      bridge.client.request("readTransfer", {
        text: JSON.stringify(change(await exportedDocument())),
      }),
      kindOf,
    ),
  expected,
});

/** A document's session read, then reviewed against `planText`'s plan as script `scope`. */
const reviewRow = (
  outcome: string,
  text: () => Promise<string>,
  expected: Answer,
  { scope = SCOPE, planText = PLAN_JSON }: { scope?: string; planText?: string } = {},
): Row => ({
  op: "reviewTransfer",
  outcome,
  run: async (bridge) => {
    const plan = await prepared(bridge, planText);
    const ticket = ticketIn(
      (await bridge.client.request("readTransfer", { text: await text() })).result,
    );
    return answerOf(bridge.client.request("reviewTransfer", { ticket, scope, plan }));
  },
  expected,
});

/** The exported session's text, its document changed by `change`. */
const changed = (change: (document: Record<string, unknown>) => object) => async () =>
  JSON.stringify(change(await exportedDocument()));
const plainText = () => sessionTransferText(transferAt(), false);

/** A session read and reviewed, its ticket and plan, on `bridge`. */
async function reviewed(bridge: PlayerBridge): Promise<{ ticket: string; plan: string }> {
  const plan = await prepared(bridge);
  const ticket = ticketIn(
    (await bridge.client.request("readTransfer", { text: await plainText() })).result,
  );
  await bridge.client.request("reviewTransfer", { ticket, scope: SCOPE, plan });
  return { ticket, plan };
}

/** What a reviewed session's commit gives, by the main realm's restore. */
async function committedOracle() {
  const read = await readPlayerTransferText(await plainText());
  assert.ok(read.kind === "session");
  return {
    snapshotJson: playerRuntimeSnapshotJson(restoreSessionTransfer(read.session, SCOPE, PLAN_JSON)),
    eventsJson: read.session.session.events.map(serializeValidatedRuntimeJson),
  };
}

async function transferRows(): Promise<Row[]> {
  const committed = { answer: await committedOracle() };
  const bundle: StorageBundle = {
    scripts: [
      { scope: SCOPE, name: null, photos: [photo], entries: [{ key: "photo", value: photo }] },
    ],
    images: [{ reference: photo, bytes: PNG }],
  };
  const bundleBytes = new Uint8Array(
    await (await storageTransferFile(bundle, false)).arrayBuffer(),
  );
  const medium =
    (change: (medium: Readonly<Record<string, unknown>>) => object) =>
    (document: Record<string, unknown>) => ({ ...document, media: [change(mediumOf(document))] });
  return [
    // readTransfer
    {
      op: "readTransfer",
      outcome: "session",
      run: async (bridge) =>
        answerOf(bridge.client.request("readTransfer", { text: await plainText() }), kindOf),
      expected: { answer: "session" },
    },
    {
      op: "readTransfer",
      outcome: "session",
      run: async (bridge) =>
        answerOf(
          bridge.client.request("readTransfer", {
            bytes: new Uint8Array(
              await (await sessionTransferFile(transferAt(), true)).arrayBuffer(),
            ),
          }),
          kindOf,
        ),
      expected: { answer: "session" },
    },
    {
      op: "readTransfer",
      outcome: "savedData",
      run: (bridge) =>
        answerOf(bridge.client.request("readTransfer", { bytes: bundleBytes }), kindOf),
      expected: { answer: "savedData" },
    },
    {
      op: "readTransfer",
      outcome: "refused",
      run: (bridge) => answerOf(bridge.client.request("readTransfer", { text: "not json" })),
      expected: refusedWith("This text is not saved data or a session exported from a Player."),
    },
    {
      op: "readTransfer",
      outcome: "refused",
      run: (bridge) => answerOf(bridge.client.request("readTransfer", { text: "{not json" })),
      expected: refusedWith(
        "This is not saved data or a session exported from a Player: it is not valid JSON.",
      ),
    },
    {
      op: "readTransfer",
      outcome: "refused",
      run: (bridge) =>
        answerOf(bridge.client.request("readTransfer", { bytes: new Uint8Array([1, 2, 3]) })),
      expected: refusedWith(
        "This is not saved data or a session exported from a Player: it is not valid JSON.",
      ),
    },
    {
      op: "readTransfer",
      outcome: "refused",
      // A file whose JSON is no object; a text of one starts with no brace, which the first refusal row refuses.
      run: (bridge) =>
        answerOf(bridge.client.request("readTransfer", { bytes: new TextEncoder().encode("[]") })),
      expected: refusedWith("This is not saved data or a session exported from a Player."),
    },
    readRow(
      "refused",
      () => ({ format: "teasescript-checkpoint" }),
      refusedWith("This is not saved data or a session exported from a Player."),
    ),
    readRow(
      "refused",
      (d) => ({ ...d, version: 2 }),
      refusedWith("This session uses a format version this Player cannot read."),
    ),
    readRow(
      "refused",
      (d) => ({ ...d, extra: true }),
      refusedWith(
        "This session must have exactly format, version, scope, name, checkpoint, events, entries, and media.",
      ),
    ),
    readRow("refused", (d) => ({ ...d, scope: 1 }), refusedWith("This session has no scope.")),
    readRow(
      "refused",
      (d) => ({ ...d, name: 1 }),
      refusedWith("The name of this session's script is not text."),
    ),
    readRow(
      "refused",
      (d) => ({ ...d, checkpoint: null }),
      refusedWith("This session has no checkpoint."),
    ),
    readRow(
      "refused",
      (d) => ({ ...d, events: [{ kind: "damaged" }] }),
      refusedWith("The events of this session are damaged, so it cannot continue."),
    ),
    readRow(
      "refused",
      (d) => ({ ...d, entries: [{ key: 1, value: 1 }] }),
      refusedWith("A saved value of this session is invalid: entries[0].key must be a string."),
    ),
    readRow(
      "refused",
      (d) => ({ ...d, media: {} }),
      refusedWith("The photos and files of this session are not a list."),
    ),
    readRow(
      "refused",
      (d) => ({ ...d, media: [{}] }),
      refusedWith(
        "Photo or file 1 must have exactly reference, kind, type, width, height, durationMs, byteLength, and data.",
      ),
    ),
    readRow(
      "refused",
      medium((m) => ({ ...m, reference: "photo" })),
      refusedWith("Photo or file 1 has no valid reference."),
    ),
    readRow(
      "refused",
      (d) => ({ ...d, media: [mediumOf(d), mediumOf(d)] }),
      refusedWith("Photo or file 2 is listed twice."),
    ),
    readRow(
      "refused",
      medium((m) => ({ ...m, reference: UNUSED })),
      refusedWith("Photo or file 1 is not used by the session or its saved values."),
    ),
    readRow(
      "refused",
      medium((m) => ({ ...m, byteLength: -1 })),
      refusedWith("Photo or file 1 has no valid byteLength."),
    ),
    readRow(
      "refused",
      medium((m) => ({ ...m, data: "***" })),
      refusedWith("Photo or file 1 is damaged: its data is not base64url."),
    ),
    readRow(
      "refused",
      medium((m) => ({ ...m, byteLength: PNG.length + 1 })),
      refusedWith(
        `Photo or file 1 is damaged or incomplete: it has ${PNG.length} bytes instead of ${PNG.length + 1}.`,
      ),
    ),
    readRow(
      "refused",
      medium((m) => ({ ...m, kind: "audio" })),
      refusedWith("Photo or file 1 is damaged: its kind, type, size, or dimensions are not valid."),
    ),
    // reviewTransfer
    reviewRow("reviewed", plainText, { answer: null }),
    reviewRow(
      "refused",
      plainText,
      refusedWith(
        "This session belongs to another script, Story. Open that script and import it there.",
      ),
      { scope: "development-package:other" },
    ),
    reviewRow(
      "refused",
      plainText,
      refusedWith(
        "This session comes from another version of this script or of the Player, so it cannot continue here. Continue it where it was exported.",
      ),
      { planText: OTHER_PLAN_JSON },
    ),
    reviewRow(
      "refused",
      changed((d) => ({ ...d, checkpoint: { ...objectOf(d.checkpoint), version: 1 } })),
      refusedWith(
        "This session was exported by another version of the Player, so this Player cannot continue it. Continue it where it was exported.",
      ),
    ),
    reviewRow(
      "refused",
      changed((d) => ({ ...d, checkpoint: { ...objectOf(d.checkpoint), snapshot: null } })),
      refusedWith(
        "This session is damaged, so it cannot continue. Export it again where it runs. Details: Runtime snapshot must be an object.",
      ),
    ),
    reviewRow(
      "refused",
      () => sessionTransferText(transferAt(createPlayerRuntimeSession(ENDED_PLAN)), false),
      refusedWith("This session has ended, so there is nothing to continue."),
      { planText: serializeValidatedRuntimeJson(ENDED_PLAN) },
    ),
    {
      op: "reviewTransfer",
      outcome: "reviewedAgain",
      // Refused for another script, then reviewed for this one: the ticket holds its session for a retry.
      run: async (bridge) => {
        const plan = await prepared(bridge);
        const ticket = ticketIn(
          (await bridge.client.request("readTransfer", { text: await plainText() })).result,
        );
        await answerOf(
          bridge.client.request("reviewTransfer", {
            ticket,
            scope: "development-package:other",
            plan,
          }),
        );
        return answerOf(bridge.client.request("reviewTransfer", { ticket, scope: SCOPE, plan }));
      },
      expected: { answer: null },
    },
    {
      op: "reviewTransfer",
      outcome: "unknownTicket",
      run: async (bridge) =>
        answerOf(
          bridge.client.request("reviewTransfer", {
            ticket: "t0",
            scope: SCOPE,
            plan: await prepared(bridge),
          }),
        ),
      expected: NO_TICKET,
    },
    {
      op: "reviewTransfer",
      outcome: "unknownPlan",
      run: async (bridge) => {
        const ticket = ticketIn(
          (await bridge.client.request("readTransfer", { text: await plainText() })).result,
        );
        return answerOf(
          bridge.client.request("reviewTransfer", { ticket, scope: SCOPE, plan: "p0" }),
        );
      },
      expected: { name: "Error", message: "No plan 'p0' is held." },
    },
    // transferCommit
    {
      op: "transferCommit",
      outcome: "committed",
      run: async (bridge) =>
        answerOf(
          bridge.client.request("transferCommit", { ticket: (await reviewed(bridge)).ticket }),
          committedOf,
        ),
      expected: committed,
    },
    {
      op: "transferCommit",
      outcome: "committedAgain",
      // An import that failed after its commit commits again on its retry.
      run: async (bridge) => {
        const { ticket } = await reviewed(bridge);
        await bridge.client.request("transferCommit", { ticket });
        return answerOf(bridge.client.request("transferCommit", { ticket }), committedOf);
      },
      expected: committed,
    },
    {
      op: "transferCommit",
      outcome: "unreviewed",
      run: async (bridge) =>
        answerOf(
          bridge.client.request("transferCommit", {
            ticket: ticketIn(
              (await bridge.client.request("readTransfer", { text: await plainText() })).result,
            ),
          }),
        ),
      expected: { name: "Error", message: "This session was not reviewed for an import." },
    },
    {
      op: "transferCommit",
      outcome: "unknownTicket",
      run: (bridge) => answerOf(bridge.client.request("transferCommit", { ticket: "t0" })),
      expected: NO_TICKET,
    },
    // releaseTransfer
    {
      op: "releaseTransfer",
      outcome: "released",
      // Let go of, the ticket holds nothing: its commit finds no session.
      run: async (bridge) => {
        const { ticket } = await reviewed(bridge);
        await bridge.client.request("releaseTransfer", { ticket });
        return answerOf(bridge.client.request("transferCommit", { ticket }));
      },
      expected: NO_TICKET,
    },
    {
      op: "releaseTransfer",
      outcome: "unknownTicket",
      run: (bridge) => answerOf(bridge.client.request("releaseTransfer", { ticket: "t0" })),
      expected: { answer: null },
    },
    ...malformedRows(),
  ];
}

/** Each transfer op's argument forms: one or more alternatives, each its fields with their value classes. */
const ARGUMENTS = {
  readTransfer: [{ required: { text: "string" } }, { required: { bytes: "bytes" } }],
  reviewTransfer: [{ required: { ticket: "string", scope: "string", plan: "string" } }],
  transferCommit: [{ required: { ticket: "string" } }],
  releaseTransfer: [{ required: { ticket: "string" } }],
} as const satisfies Record<TransferOp, readonly ArgumentForm[]>;

/** The malformed rows of every op. */
function malformedRows(): Row[] {
  // EVIDENCE: invariant: the keys of `ARGUMENTS`, declared literally above.
  return (Object.keys(ARGUMENTS) as TransferOp[]).flatMap((op) =>
    malformedArguments(ARGUMENTS[op]).map(({ id, args }) => ({
      op,
      outcome: "malformed",
      form: id,
      run: (bridge: PlayerBridge) => answerOf(bridge.client.request(op, args)),
      expected: MALFORMED(op),
    })),
  );
}

test("every transfer op's argument forms, outcomes and refusals answer as written, in-process and in a Worker", async () => {
  const rows = await transferRows();
  const [inProcess, remote] = await onBoth(async (bridge) => {
    const answers: Answer[] = [];
    for (const row of rows) answers.push(await row.run(bridge));
    return answers;
  });
  assert.deepEqual(remote, inProcess);
  const named = (answers: readonly Answer[]) =>
    answers.map((answer, index) => ({
      row: `${rows[index]!.op} ${rows[index]!.outcome} ${rows[index]!.form ?? `#${index + 1}`}`,
      ...answer,
    }));
  assert.deepEqual(named(inProcess), named(rows.map(({ expected }) => expected)));
});

/** The words of each `StorageTransferError` the reader's source raises, as a pattern its template's parts make. */
function readerRefusals(): RegExp[] {
  const path = resolve(process.cwd(), "player/persistence/session-transfer-read.ts");
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found: RegExp[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "StorageTransferError"
    ) {
      const words = node.arguments?.[0];
      assert.ok(
        words !== undefined &&
          (ts.isStringLiteral(words) ||
            ts.isTemplateExpression(words) ||
            ts.isNoSubstitutionTemplateLiteral(words)),
        `a refusal with words the check reads, line ${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
      );
      const pattern = ts.isTemplateExpression(words)
        ? [
            escape(words.head.text),
            ...words.templateSpans.map((span) => escape(span.literal.text)),
          ].join(".+")
        : escape(words.text);
      found.push(new RegExp(`^${pattern}$`, "s"));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test("the transfer family covers every op, outcome and refusal of the reader", async () => {
  const rows = await transferRows();
  assert.deepEqual(
    Object.keys(transferOps(playerOpsContext())).sort(),
    Object.keys(OUTCOMES).sort(),
  );
  for (const [op, outcomes] of Object.entries(OUTCOMES))
    for (const outcome of outcomes)
      assert.ok(
        rows.some((row) => row.op === op && row.outcome === outcome),
        `${op} ${outcome} has a row`,
      );
  for (const row of rows)
    assert.ok(
      OUTCOMES[row.op].some((outcome) => outcome === row.outcome),
      `${row.op} declares ${row.outcome}`,
    );
  // Every malformed argument the forms' domains oblige runs, under its own id.
  // EVIDENCE: invariant: the keys of `ARGUMENTS`, declared literally above.
  for (const op of Object.keys(ARGUMENTS) as TransferOp[])
    assert.deepEqual(
      rows.filter((row) => row.op === op && row.outcome === "malformed").map(({ form }) => form),
      formObligations(ARGUMENTS[op]),
      `${op}'s malformed forms`,
    );
  const messages = rows.flatMap(({ expected }) =>
    "message" in expected ? [expected.message] : [],
  );
  const refusals = readerRefusals();
  for (const message of Object.keys(UNREACHED))
    assert.ok(
      refusals.some((refusal) => refusal.test(message)),
      `${message} is no refusal of the reader`,
    );
  for (const refusal of refusals) {
    const reached = messages.some((message) => refusal.test(message));
    const unreached = Object.keys(UNREACHED).some((message) => refusal.test(message));
    assert.ok(
      reached !== unreached,
      `${refusal.source}: ${reached ? "reached and named unreached" : "no row reaches it"}`,
    );
  }
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
  const run = deliveredRun(context, ops, sessions);
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
