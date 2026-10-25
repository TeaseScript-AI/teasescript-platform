import assert from "node:assert/strict";
import test from "node:test";

import {
  compilePlayerProject,
  createPlayerRuntimeRestorePoint,
  createPlayerRuntimeSession,
  playerRuntimeForeground,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import {
  readPlayerTransferFile,
  readPlayerTransferText,
  restoreSessionTransfer,
  sessionMediumRecord,
  sessionTransferFile,
  sessionTransferFileName,
  sessionTransferText,
  type SessionTransfer,
  type SessionTransferMedium,
} from "../player/session-transfer.js";
import { storageTransferFile, StorageTransferError } from "../player/storage-transfer.js";

const scope = "development-package:story";
const photo = "captured-media:11111111-1111-4111-8111-111111111111:1";
const held = "captured-media:22222222-2222-4222-8222-222222222222:3";
const locked = "captured-media:33333333-3333-4333-8333-333333333333:2";
const source = `let picture = "${held}"\nsay "Hello", instant\nlet name = askText "Your name?"\nsay "Hi \${name}", instant\nexit`;
const plan = compilePlayerProject(source).plan!;

const media: SessionTransferMedium[] = [
  {
    reference: photo,
    kind: "image",
    type: "image/png",
    width: 2,
    height: 3,
    durationMs: null,
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]),
  },
  {
    reference: held,
    kind: "audio",
    type: "audio/webm",
    width: null,
    height: null,
    durationMs: 1_250,
    bytes: Uint8Array.from([1, 2, 3]),
  },
  {
    reference: locked,
    kind: "file",
    type: "application/octet-stream",
    width: null,
    height: null,
    durationMs: null,
    bytes: new Uint8Array(0),
  },
];

/** The session at its question, with saved values that hold a photo and a locked file. */
function transferAt(session = createPlayerRuntimeSession(plan)): SessionTransfer {
  return {
    scope,
    name: "Story ✓",
    session: createPlayerRuntimeRestorePoint(session),
    entries: [
      { key: "photo", value: photo },
      { key: "vault", value: { kind: "list", items: [locked, 3] } },
    ],
    media,
  };
}

async function bytesOf(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

function refused(message: RegExp) {
  return (error: unknown) => error instanceof StorageTransferError && message.test(error.message);
}

test("an exported session reads back as it was, as a file or text, and restores at the same state", async () => {
  const session = createPlayerRuntimeSession(plan);
  const transfer = transferAt(session);
  for (const gzip of [true, false]) {
    const fromFile = await readPlayerTransferFile(
      await bytesOf(await sessionTransferFile(transfer, gzip)),
    );
    const fromText = await readPlayerTransferText(await sessionTransferText(transfer, gzip));
    for (const read of [fromFile, fromText]) {
      assert.equal(read.kind, "session");
      if (read.kind !== "session") continue;
      assert.deepEqual(read.session, transfer);
      const restored = restoreSessionTransfer(read.session, scope, plan);
      assert.deepEqual(playerRuntimeSnapshot(restored), playerRuntimeSnapshot(session));
      assert.deepEqual(restored.transcriptEntries, session.transcriptEntries);
      assert.equal(playerRuntimeForeground(restored)?.kind, "ask-text");
    }
  }
  // Each medium becomes the record it was, of the importing script's scope.
  const record = sessionMediumRecord(media[1]!, scope);
  assert.deepEqual(
    { ...record, data: await bytesOf(record.data) },
    {
      namespace: scope,
      reference: held,
      kind: "audio",
      mimeType: "audio/webm",
      size: 3,
      durationMs: 1_250,
      data: Uint8Array.from([1, 2, 3]),
    },
  );
  assert.equal(sessionTransferFileName("Story ✓", true), "Story-session.teasesession.json.gz");
  // The same import reads saved data, which keeps its own format.
  const saved = await readPlayerTransferFile(
    await bytesOf(
      await storageTransferFile(
        {
          scripts: [{ scope, name: null, photos: [], entries: [{ key: "a", value: 1 }] }],
          images: [],
        },
        false,
      ),
    ),
  );
  assert.equal(saved.kind, "savedData");
  await assert.rejects(
    readPlayerTransferText('{"format":"teasescript-checkpoint"}'),
    refused(/not saved data or a session/),
  );
});

test("a session import is refused with the reason: another script, another version, damage, or an ended session", async () => {
  const exported = JSON.parse(await (await sessionTransferFile(transferAt(), false)).text());
  const read = async (document: unknown) => {
    const transfer = await readPlayerTransferText(JSON.stringify(document));
    assert.equal(transfer.kind, "session");
    return transfer.kind === "session" ? transfer.session : transferAt();
  };
  const restore = async (document: unknown, into = plan) =>
    restoreSessionTransfer(await read(document), scope, into);
  const otherPlan = compilePlayerProject(source.replace("Hello", "Hello again")).plan!;
  const ended = createPlayerRuntimeSession('say "Bye", instant\nexit');
  const withMedium = (change: Record<string, unknown>) => ({
    ...exported,
    media: [{ ...exported.media[0], ...change }],
  });
  const cases: readonly [string, () => Promise<object>, RegExp][] = [
    [
      "another script",
      () => restore({ ...exported, scope: "development-package:other" }),
      /another script, Story ✓\. Open that script/,
    ],
    [
      "a changed script",
      () => restore(exported, otherPlan),
      /another version of this script or of the Player/,
    ],
    [
      "another checkpoint revision",
      () => restore({ ...exported, checkpoint: { ...exported.checkpoint, version: 1 } }),
      /exported by another version of the Player/,
    ],
    [
      "a damaged state",
      () =>
        restore({
          ...exported,
          checkpoint: {
            ...exported.checkpoint,
            snapshot: { ...exported.checkpoint.snapshot, status: "unknown" },
          },
        }),
      /damaged, so it cannot continue/,
    ],
    [
      "an ended session",
      async () =>
        restoreSessionTransfer(
          { ...(await read(exported)), session: createPlayerRuntimeRestorePoint(ended) },
          scope,
          ended.plan,
        ),
      /has ended/,
    ],
    [
      "another format version",
      () => read({ ...exported, version: 2 }),
      /format version this Player cannot read/,
    ],
    ["an extra field", () => read({ ...exported, extra: true }), /must have exactly/],
    [
      "a damaged event",
      () => read({ ...exported, events: [{ kind: "say" }] }),
      /events of this session are damaged/,
    ],
    [
      "an invalid saved value",
      () => read({ ...exported, entries: [{ key: "x", value: { kind: "nothing" } }] }),
      /saved value of this session is invalid/,
    ],
    [
      "an unused photo",
      () =>
        read(withMedium({ reference: "captured-media:44444444-4444-4444-8444-444444444444:1" })),
      /Photo or file 1 is not used/,
    ],
    [
      "a photo listed twice",
      () => read({ ...exported, media: [exported.media[0], exported.media[0]] }),
      /listed twice/,
    ],
    ["damaged data", () => read(withMedium({ data: "+" })), /not base64url/],
    ["missing bytes", () => read(withMedium({ byteLength: 7 })), /6 bytes instead of 7/],
    [
      "a kind its type does not have",
      () => read(withMedium({ type: "audio/webm" })),
      /its kind, type, size, or dimensions are not valid/,
    ],
    [
      "a width that is none",
      () => read(withMedium({ width: 0 })),
      /its kind, type, size, or dimensions are not valid/,
    ],
  ];
  for (const [name, attempt, message] of cases)
    await assert.rejects(attempt, refused(message), name);
});
