import assert from "node:assert/strict";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";

import { CapturedMediaStore } from "../player/captured-media.js";
import {
  checkStorageTransferImages,
  collectStorageTransfer,
  remapCapturedMediaReferences,
  parseStorageTransfer,
  readStorageTransferFile,
  readStorageTransferText,
  storageTransferFile,
  storageTransferFileName,
  storageTransferText,
  StorageTransferError,
  type StorageTransfer,
} from "../player/storage-transfer.js";
import type { RuntimeScriptStorageEntrySnapshot, SerializableRuntimeValue } from "../src/index.js";
import { FakeMediaRepository } from "./helpers/fake-media-repository.js";

const photo = "captured-media:11111111-1111-4111-8111-111111111111:1";
const second = "captured-media:22222222-2222-4222-8222-222222222222:7";
const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 250, 251, 255,
]);

const entries: RuntimeScriptStorageEntrySnapshot[] = [
  { key: "player.score", value: 3 },
  { key: "unicode ✓ \u{1f600} lone \udfff", value: "ünïcødé \u{1f600} lone \ud800" },
  { key: "", value: "an empty key" },
  { key: "__proto__", value: { kind: "object", properties: [{ name: "__proto__", value: true }] } },
  {
    key: "player.flags",
    value: {
      kind: "dict",
      entries: [
        { key: "done", value: true },
        { key: photo, value: "a photo as a dict key" },
      ],
    },
  },
  { key: "album", value: { kind: "list", items: [photo, photo, second, null, 2.5] } },
  { key: "set", value: { kind: "set", items: ["a", 1] } },
  { key: "range", value: { kind: "range", start: 1, end: 5, inclusive: false } },
  { key: "duration", value: { kind: "duration", milliseconds: 1_500, months: 1, days: 2 } },
  { key: "date", value: { kind: "date", year: 2026, month: 10, day: 6 } },
  { key: "time", value: { kind: "time", hour: 23, minute: 59, second: 59, millisecond: 999 } },
  {
    key: "datetime",
    value: {
      kind: "datetime",
      year: 2026,
      month: 1,
      day: 2,
      hour: 3,
      minute: 4,
      second: 5,
      millisecond: 6,
    },
  },
  { key: "timestamp", value: { kind: "timestamp", epochMilliseconds: 1_790_000_000_000 } },
  { key: "script", value: { kind: "script", path: "rooms/cellar.tease", label: null } },
  { key: "unresolved", value: "captured-media:33333333-3333-4333-8333-333333333333:1" },
];

const transfer: StorageTransfer = {
  scope: "development-package:Example",
  entries,
  images: [
    { reference: photo, bytes: pngBytes },
    // Large enough to span several encoding slices, with every byte value.
    {
      reference: second,
      bytes: Uint8Array.from({ length: 100_003 }, (_, index) => (index * 7) % 256),
    },
  ],
};

const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

/** The plain JSON document of a transfer, for editing like a player would. */
async function plainDocument(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await (await storageTransferFile(transfer, false)).text());
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return { ...parsed };
}

async function rejects(read: Promise<StorageTransfer> | (() => StorageTransfer), message: RegExp) {
  await assert.rejects(
    async () => {
      await (typeof read === "function" ? read() : read);
    },
    (error: unknown) => error instanceof StorageTransferError && message.test(error.message),
  );
}

test("a file round trips every stored value type, shared photos, and their exact bytes", async () => {
  for (const gzip of [true, false]) {
    const file = await storageTransferFile(transfer, gzip);
    const bytes = await bytesOf(file);
    assert.equal(file.type, gzip ? "application/gzip" : "application/json;charset=utf-8");
    assert.equal(bytes[0] === 0x1f && bytes[1] === 0x8b, gzip, "gzip magic only when compressed");
    assert.deepEqual(await readStorageTransferFile(bytes), transfer);
  }
  // Independently decompressed, the file is the plain document.
  const gzipped = await bytesOf(await storageTransferFile(transfer, true));
  assert.equal(
    gunzipSync(gzipped).toString("utf8"),
    await (await storageTransferFile(transfer, false)).text(),
  );
});

test("text round trips compressed and as plain JSON, also when wrapped across lines", async () => {
  const compressed = await storageTransferText(transfer, true);
  assert.match(compressed, /^TSST1\.gzip\.[A-Za-z0-9_-]+$/u);
  assert.deepEqual(await readStorageTransferText(compressed), transfer);
  const wrapped = `\n  ${compressed.match(/.{1,76}/gu)!.join("\r\n")}\t\n`;
  assert.deepEqual(await readStorageTransferText(wrapped), transfer);

  const plain = await storageTransferText(transfer, false);
  assert.ok(plain.startsWith("{"));
  assert.deepEqual(await readStorageTransferText(` ${plain}\n`), transfer);
  // The text decodes with an independent base64url decoder to the same gzip document.
  const independent = Buffer.from(compressed.slice("TSST1.gzip.".length), "base64url");
  assert.equal(gunzipSync(independent).toString("utf8"), plain);
});

test("the plain document keeps stored values readable, one saved value per line", async () => {
  const plain = await storageTransferText({ ...transfer, images: [] }, false);
  assert.ok(plain.includes(`\n{"key":"player.score","value":3}`));
  const document: unknown = JSON.parse(plain);
  assert.deepEqual(document, {
    format: "teasescript-script-storage",
    version: 1,
    scope: transfer.scope,
    entries,
    images: [],
  });
});

test("values edited by hand and a replaced photo are accepted, without any signature", async () => {
  const document = await plainDocument();
  document["entries"] = [
    { key: "player.score", value: 99 },
    { key: "album", value: { kind: "list", items: [photo] } },
  ];
  const replacement = Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]);
  document["images"] = [
    {
      reference: photo,
      byteLength: replacement.length,
      data: Buffer.from(replacement).toString("base64url"),
    },
  ];
  const edited = await readStorageTransferText(JSON.stringify(document));
  assert.deepEqual(edited.entries, document["entries"]);
  assert.deepEqual(edited.images, [{ reference: photo, bytes: replacement }]);
  // The same edit, compressed by another tool, reads as a file.
  assert.deepEqual(await readStorageTransferFile(gzipSync(JSON.stringify(document))), edited);
});

test("damaged files and text are refused with a message", async () => {
  const gzipped = await bytesOf(await storageTransferFile(transfer, true));
  await rejects(
    readStorageTransferFile(gzipped.slice(0, gzipped.length - 9)),
    /damaged or incomplete/,
  );
  await rejects(readStorageTransferFile(gzipped.slice(0, 40)), /damaged or incomplete/);
  // A flipped byte in the stored checksum, and one in the compressed data.
  for (const offset of [gzipped.length - 6, Math.floor(gzipped.length / 2)]) {
    const corrupt = gzipped.slice();
    corrupt[offset]! ^= 0x55;
    await rejects(readStorageTransferFile(corrupt), /damaged|not/);
  }
  // Bytes after the compressed document.
  await rejects(
    readStorageTransferFile(Uint8Array.from([...gzipped, 0x41])),
    /damaged or incomplete/,
  );
  await rejects(readStorageTransferFile(Uint8Array.from([0x7b, 0xff, 0x7d])), /not UTF-8/);
  await rejects(readStorageTransferFile(new TextEncoder().encode("not json")), /not valid JSON/);

  const text = await storageTransferText(transfer, true);
  await rejects(readStorageTransferText(text.slice(0, -10)), /damaged or incomplete/);
  await rejects(readStorageTransferText(`${text}==`), /damaged or incomplete/);
  await rejects(readStorageTransferText(`TSST1.gzip.+${text.slice(12)}`), /damaged or incomplete/);
  await rejects(readStorageTransferText("TSST1.gzip.AAAA"), /damaged or incomplete/);
  await rejects(readStorageTransferText("TSST2.gzip.AAAA"), /not exported saved data/);
  await rejects(readStorageTransferText("hello"), /not exported saved data/);
  await rejects(readStorageTransferText(""), /not exported saved data/);
});

test("a document that is not valid saved data is refused with a message naming the problem", async () => {
  const base = await plainDocument();
  const image = (fields: Record<string, unknown>) => ({
    ...base,
    images: [
      {
        reference: photo,
        byteLength: pngBytes.length,
        data: Buffer.from(pngBytes).toString("base64url"),
        ...fields,
      },
    ],
    entries: [{ key: "album", value: photo }],
  });
  const cases: [unknown, RegExp][] = [
    [[], /not exported saved data/],
    [null, /not exported saved data/],
    [{ ...base, format: "teasescript-checkpoint" }, /not exported saved data/],
    [{ ...base, version: 2 }, /format version/],
    [{ ...base, version: "1" }, /format version/],
    [{ ...base, extra: true }, /fields other than/],
    [{ format: base["format"], version: 1, scope: "s", entries: [] }, /fields other than/],
    [{ ...base, scope: 7 }, /names no script/],
    [{ ...base, entries: {} }, /saved value is invalid/],
    [{ ...base, entries: [{ key: "a", value: null }] }, /saved value is invalid.*null/],
    [
      {
        ...base,
        entries: [
          { key: "a", value: 1 },
          { key: "a", value: 2 },
        ],
      },
      /more than once/,
    ],
    [
      { ...base, entries: [{ key: "a", value: { kind: "timerHandle", timerId: 1 } }] },
      /saved value is invalid/,
    ],
    [{ ...base, entries: [{ key: "a", value: { kind: "list" } }] }, /saved value is invalid/],
    [{ ...base, entries: [{ key: "a", value: 1, extra: 2 }] }, /saved value is invalid/],
    [{ ...base, images: {} }, /not a list/],
    [image({ extra: 1 }), /exactly reference, byteLength, and data/],
    [image({ reference: "captured-media:not-a-reference" }), /no valid photo reference/],
    [image({ reference: "images/room.png" }), /no valid photo reference/],
    [{ ...image({}), images: [...image({}).images, ...image({}).images] }, /listed twice/],
    [
      { ...image({}), entries: [{ key: "album", value: "no photo" }] },
      /not used by any saved value/,
    ],
    [image({ byteLength: 0 }), /no valid byteLength/],
    [image({ byteLength: 1.5 }), /no valid byteLength/],
    [image({ byteLength: pngBytes.length + 1 }), /damaged or incomplete.*14 bytes instead of 15/],
    [image({ data: Buffer.from(pngBytes).toString("base64") + "==" }), /not base64url/],
    [
      image({
        data:
          Buffer.from(pngBytes).toString("base64").replace(/=+$/u, "").replaceAll("/", "+") + "+",
      }),
      /not base64url/,
    ],
    [image({ data: 42 }), /not base64url/],
    // Stray bits after the last byte: "AB" decodes to one byte only when its low bits are zero.
    [image({ byteLength: 1, data: "AB" }), /not base64url/],
  ];
  for (const [document, message] of cases) {
    await rejects(() => parseStorageTransfer(JSON.stringify(document)), message);
  }
  // The canonical single byte is accepted.
  const single = parseStorageTransfer(JSON.stringify(image({ byteLength: 1, data: "AA" })));
  assert.deepEqual(single.images, [{ reference: photo, bytes: Uint8Array.of(0) }]);
});

test("an export file name keeps only safe characters", () => {
  assert.equal(
    storageTransferFileName("development-package:My Script/../x", true),
    "development-package-My-Script-..-x-saved-data.teasestorage.json.gz",
  );
  assert.equal(storageTransferFileName("../", false), "script-saved-data.teasestorage.json");
  assert.equal(storageTransferFileName("", true), "script-saved-data.teasestorage.json.gz");
});

test("an export reads the saved values fresh with each stored photo once, never unsaved or foreign media", async () => {
  const urls = { create: () => "blob:", revoke: () => {} };
  const repository = new FakeMediaRepository();
  // An earlier run saved this photo, so it is stored durably in the script's namespace.
  const earlier = new CapturedMediaStore(repository, urls, "script");
  const saved = earlier.add("image", new Blob([pngBytes], { type: "image/png" })).reference;
  await earlier.promote([saved]);
  const foreignStore = new CapturedMediaStore(repository, urls, "another script");
  const foreign = foreignStore.add("image", new Blob([pngBytes], { type: "image/png" })).reference;
  await foreignStore.promote([foreign]);
  // This run took a photo that no save stored.
  const media = new CapturedMediaStore(repository, urls, "script");
  const unsaved = media.add("image", new Blob(["unsaved"], { type: "image/png" })).reference;
  const values = new Map<string, RuntimeScriptStorageEntrySnapshot["value"]>([
    ["album", { kind: "list", items: [saved, saved, unsaved] }],
    ["named", { kind: "dict", entries: [{ key: saved, value: foreign }] }],
    ["forged", "captured-media:not a reference"],
  ]);
  const provider = {
    scope: "script",
    load: async () => [...values].map(([key, value]) => ({ key, value })),
    write: async () => {},
    replace: async () => {},
    clear: async () => {},
  };
  const { transfer: collected, missingPhotos } = await collectStorageTransfer(provider, media);
  assert.equal(collected.scope, "script");
  assert.deepEqual(collected.entries, await provider.load());
  assert.deepEqual(collected.images, [{ reference: saved, bytes: pngBytes }]);
  assert.equal(missingPhotos, 3, "the unsaved, foreign, and forged references");
  // A later save is part of the next export, not of this one.
  values.set("later", 1);
  assert.equal((await collectStorageTransfer(provider, media)).transfer.entries.length, 4);
  // The collected data is a valid export.
  assert.deepEqual(
    await readStorageTransferFile(await bytesOf(await storageTransferFile(collected))),
    collected,
  );
});

test("an import remaps a photo reference wherever a value can hold one, and nothing else", () => {
  const fresh = "captured-media:99999999-9999-4999-8999-999999999999:1";
  const references = new Map([[photo, fresh]]);
  const value: SerializableRuntimeValue = {
    kind: "object",
    properties: [
      { name: photo, value: photo },
      {
        name: "items",
        value: { kind: "list", items: [photo, { kind: "set", items: [photo, second] }] },
      },
      {
        name: "named",
        value: { kind: "dict", entries: [{ key: photo, value: { kind: "list", items: [photo] } }] },
      },
      { name: "script", value: { kind: "script", path: photo, label: null } },
    ],
  };
  const original = structuredClone(value);
  assert.deepEqual(remapCapturedMediaReferences(value, references), {
    kind: "object",
    properties: [
      { name: fresh, value: fresh },
      {
        name: "items",
        value: { kind: "list", items: [fresh, { kind: "set", items: [fresh, second] }] },
      },
      {
        name: "named",
        value: { kind: "dict", entries: [{ key: fresh, value: { kind: "list", items: [fresh] } }] },
      },
      // A script path is no place for a photo reference.
      { name: "script", value: { kind: "script", path: photo, label: null } },
    ],
  });
  assert.deepEqual(value, original, "the imported value is not changed in place");
  assert.equal(remapCapturedMediaReferences(photo, references), fresh);
  assert.equal(remapCapturedMediaReferences(second, references), second);
  assert.equal(remapCapturedMediaReferences(3, references), 3);

  // Nesting deeper than a recursive copy could go.
  let deep: SerializableRuntimeValue = photo;
  for (let depth = 0; depth < 200_000; depth += 1) deep = { kind: "list", items: [deep] };
  let remapped = remapCapturedMediaReferences(deep, references);
  for (let depth = 0; depth < 200_000; depth += 1) {
    assert.ok(remapped !== null && typeof remapped === "object" && remapped.kind === "list");
    remapped = remapped.items[0]!;
  }
  assert.equal(remapped, fresh);
});

test("an import's photos are checked by their bytes and decoded, one damaged photo refusing all", async () => {
  const decode = async (data: Blob) => {
    assert.equal(data.type, "image/png", "the type comes from the bytes");
    return { width: 3, height: 2 };
  };
  const [checked, ...rest] = await checkStorageTransferImages(
    { ...transfer, images: transfer.images.slice(0, 1) },
    decode,
  );
  assert.equal(rest.length, 0);
  assert.equal(checked?.reference, photo);
  assert.deepEqual([checked?.width, checked?.height], [3, 2]);
  assert.deepEqual(new Uint8Array(await checked!.data.arrayBuffer()), pngBytes);
  // The second photo's bytes are no image.
  await rejects(
    checkStorageTransferImages(transfer, decode).then(() => transfer),
    /Saved photo 2 is damaged/,
  );
  // An image the browser cannot decode.
  await rejects(
    checkStorageTransferImages({ ...transfer, images: transfer.images.slice(0, 1) }, async () => {
      throw new Error("cannot decode");
    }).then(() => transfer),
    /Saved photo 1 is damaged/,
  );
});
