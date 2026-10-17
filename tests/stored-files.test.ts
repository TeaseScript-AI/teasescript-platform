import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import type { RuntimeFileStoreActionSnapshot } from "../src/runtime/actions/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { run } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { SerializableRuntimeValue } from "../src/runtime/serializable-values.js";
import {
  validateRuntimeSnapshot,
  type FreshRuntimeOptions,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { fileType, storedFileKind, type StoredFileKind } from "../src/runtime/stored-files.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import type { PlayerFileStoreAnswer } from "../player/runtime-adapter.js";

/*
 * fileFromBase64, fileToBase64, hashFile, and toJson and fromJson with files (V30 §13 and §33), from source through the
 * Player's file store, which a fake store answers here as the trusted Player does: it keeps each file under a new
 * reference and vouches only for references it handed out, of the kind of their type, and hashes with a native digest.
 */

const bytes = (...parts: (string | number[])[]): Buffer =>
  Buffer.concat(
    parts.map((part) =>
      typeof part === "string" ? Buffer.from(part, "latin1") : Buffer.from(part),
    ),
  );

/** A short file of each recognized type, and files of other types, by their first bytes. */
const SAMPLES = {
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF\0"),
  png: bytes([0x89], "PNG\r\n\x1a\n", [0, 0, 0, 13], "IHDR"),
  gif87: bytes("GIF87a", [1, 0, 1, 0]),
  gif89: bytes("GIF89a", [1, 0, 1, 0]),
  webp: bytes("RIFF", [36, 0, 0, 0], "WEBPVP8 "),
  mp3: bytes("ID3", [3, 0, 0, 0, 0, 0, 0]),
  // Two MPEG-1 Layer III frame headers, 128 kbit/s at 44.1 kHz, so the second starts 417 bytes after the first.
  mp3Frames: bytes(
    [0xff, 0xfb, 0x90, 0x00],
    new Array<number>(413).fill(0),
    [0xff, 0xfb, 0x90, 0x00],
  ),
  ogg: bytes("OggS\0", [2, 0, 0, 0]),
  wav: bytes("RIFF", [36, 0, 0, 0], "WAVEfmt "),
  m4a: bytes([0, 0, 0, 32], "ftypM4A ", [0, 0, 0, 0], "M4A mp42isom", [0, 0, 0, 0]),
  mp4: bytes([0, 0, 0, 24], "ftypisom", [0, 0, 2, 0], "isommp41"),
  webm: bytes(
    [0x1a, 0x45, 0xdf, 0xa3, 0x9f],
    [
      0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81,
      0x08,
    ],
    [0x42, 0x82, 0x84],
    "webm",
  ),
  svg: bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
  svgProlog: bytes('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
  html: bytes("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>"),
  bmp: bytes("BM", [0, 0, 0, 0]),
  avif: bytes([0, 0, 0, 24], "ftypavif", [0, 0, 0, 0], "mif1miaf"),
  text: bytes("Hello, world"),
  empty: bytes(),
};

const base64 = (name: keyof typeof SAMPLES) => SAMPLES[name].toString("base64");

/** The SHA-256 of `data` from Node's native digest, as 64 lowercase hexadecimal digits. */
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

test("a file's type comes from its first bytes, for the fixed list of image, audio, and video types", () => {
  const types = Object.fromEntries(
    Object.entries(SAMPLES).map(([name, data]) => [name, fileType(data.toString("latin1"))]),
  );
  assert.deepEqual(types, {
    jpeg: "image/jpeg",
    png: "image/png",
    gif87: "image/gif",
    gif89: "image/gif",
    webp: "image/webp",
    mp3: "audio/mpeg",
    mp3Frames: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wave",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    webm: "video/webm",
    // Never shown or played: kept, passed along, and turned back into Base64 only.
    svg: "application/octet-stream",
    svgProlog: "application/octet-stream",
    html: "application/octet-stream",
    bmp: "application/octet-stream",
    avif: "application/octet-stream",
    text: "application/octet-stream",
    empty: "application/octet-stream",
  });
  // One frame header alone, or a second one that does not follow where the first frame ends, is not MP3.
  assert.equal(
    fileType(SAMPLES.mp3Frames.subarray(0, 417).toString("latin1")),
    "application/octet-stream",
  );
  assert.equal(
    fileType(bytes([0xff, 0xfb, 0x90, 0x00], new Array<number>(500).fill(0)).toString("latin1")),
    "application/octet-stream",
  );
  assert.deepEqual(
    ["image/png", "audio/ogg", "video/webm", "application/octet-stream"].map(storedFileKind),
    ["image", "audio", "video", "file"],
  );
});

/** The Player's file store as the engine meets it, which can also fail to keep or to read files. */
class FakeFileStore {
  readonly files = new Map<string, { readonly kind: StoredFileKind; readonly base64: string }>();
  failing = false;
  #next = 1;

  /** Vouches only for files of `kind` it holds. */
  readonly admission = {
    holds: (reference: string, kind: StoredFileKind) => this.files.get(reference)?.kind === kind,
  };

  keep(type: string, data: string): string {
    const reference = `stored:${this.#next++}`;
    this.files.set(reference, { kind: storedFileKind(type), base64: data });
    return reference;
  }

  answer(action: RuntimeFileStoreActionSnapshot): PlayerFileStoreAnswer {
    if (this.failing) return { kind: "failed" };
    if (action.operation === "hash")
      return {
        kind: "hashed",
        hashes: action.references.map((reference) =>
          sha256(Buffer.from(this.files.get(reference)!.base64, "base64")),
        ),
      };
    return action.operation === "store"
      ? {
          kind: "stored",
          references: action.files.map((file) => this.keep(file.type, file.base64)),
        }
      : {
          kind: "read",
          files: action.references.map((reference) => this.files.get(reference)!.base64),
        };
  }
}

interface Played {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
  readonly events: InterpreterEvent[];
  /** The file store requests, in order. */
  readonly requests: RuntimeFileStoreActionSnapshot[];
}

/**
 * Runs `source` until it ends, answering each file store from `store` and each photo with a JPEG it keeps, and letting
 * each wait's time pass. It restores a checkpoint of the state at every boundary first, so that each pending request
 * and each handed-off answer is also carried by a checkpoint.
 */
function play(
  source: string,
  store = new FakeFileStore(),
  options: Pick<FreshRuntimeOptions, "storedFiles" | "scriptStorage"> = {},
): Played {
  const plan = compileValidPlan(source);
  assert.equal(validateInstructionPlan(plan).valid, true);
  const restored = (snapshot: RuntimeSnapshot): RuntimeSnapshot => {
    assert.deepEqual(validateRuntimeSnapshot(snapshot, plan).errors, []);
    const json = serializeCheckpoint(createCheckpoint(plan, snapshot));
    const checkpoint = deserializeCheckpoint(json);
    assert.equal(serializeCheckpoint(checkpoint), json);
    return checkpoint.snapshot;
  };
  const events: InterpreterEvent[] = [];
  const requests: RuntimeFileStoreActionSnapshot[] = [];
  let result = run(plan, createImmediatePacingRuntimeSnapshot(plan, options));
  events.push(...result.events);
  for (let guard = 0; result.snapshot.status === "waiting"; guard += 1) {
    assert.ok(guard < 50, "the script keeps waiting");
    const snapshot = restored(result.snapshot);
    const action = snapshot.foregroundAction!;
    if (action.kind === "delay") {
      // Time passes to the end of the wait, and a block due meanwhile runs.
      const observed = observeTime(plan, snapshot, action.deadlineMs);
      events.push(...observed.events);
      result = run(plan, restored(observed.snapshot));
      events.push(...result.events);
      continue;
    }
    if (action.kind === "fileStore") requests.push(action);
    else assert.equal(action.kind, "capture");
    const completed = completeAction(
      plan,
      snapshot,
      action.kind === "fileStore"
        ? { actionId: action.actionId, actionKind: "fileStore", payload: store.answer(action) }
        : {
            actionId: action.actionId,
            actionKind: "capture",
            payload: {
              kind: "captured",
              media: { kind: "image", reference: store.keep("image/jpeg", base64("jpeg")) },
            },
          },
      { capturedMedia: store.admission },
    );
    assert.equal(completed.outcome.kind, "completed", JSON.stringify(completed.outcome));
    events.push(...completed.events);
    result = run(plan, restored(completed.snapshot));
    events.push(...result.events);
  }
  return { plan, snapshot: result.snapshot, events, requests };
}

function variables(played: Played): Record<string, SerializableRuntimeValue> {
  assert.equal(played.snapshot.failure, null, JSON.stringify(played.snapshot.failure));
  return Object.fromEntries(
    played.snapshot.frames[0]!.bindings.map((binding) => [binding.name, binding.value]),
  );
}

const list = (...items: SerializableRuntimeValue[]): SerializableRuntimeValue => ({
  kind: "list",
  items,
});
const dict = (...entries: [string, SerializableRuntimeValue][]): SerializableRuntimeValue => ({
  kind: "dict",
  entries: entries.map(([key, value]) => ({ key, value })),
});

test("fileFromBase64 stores a file and gives its reference, and fileToBase64 reads it back", () => {
  const store = new FakeFileStore();
  const played = play(
    [
      `let picture = fileFromBase64("${base64("png")}", default: "")`,
      "let again = fileToBase64(picture)",
      `let page = fileFromBase64("${base64("html")}", default: "")`,
      "let html = fileToBase64(page)",
      "exit",
    ].join("\n"),
    store,
  );
  assert.deepEqual(variables(played), {
    picture: "stored:1",
    again: base64("png"),
    page: "stored:2",
    html: base64("html"),
  });
  assert.deepEqual(
    played.requests.map((request) => [request.operation, request.files, request.references]),
    [
      ["store", [{ type: "image/png", base64: base64("png") }], []],
      ["read", [], ["stored:1"]],
      // HTML is kept, but as a file of no recognized type.
      ["store", [{ type: "application/octet-stream", base64: base64("html") }], []],
      ["read", [], ["stored:2"]],
    ],
  );
  assert.deepEqual(
    [...store.files.values()].map((file) => file.kind),
    ["image", "file"],
  );
  assert.deepEqual(played.snapshot.storedFiles, ["stored:1", "stored:2"]);
});

test("hashFile gives a stored file's SHA-256 as sha256sum does, and the same as hashText where the bytes are the text", () => {
  const store = new FakeFileStore();
  const played = play(
    [
      // The bytes of the text "abc".
      'let letters = fileFromBase64("YWJj", default: "")',
      `let picture = fileFromBase64("${base64("png")}", default: "")`,
      'let photo = takePhoto() otherwise ""',
      "let lettersHash = hashFile(letters)",
      'let textHash = hashText("abc")',
      "let pictureHash = hashFile(picture)",
      "let changed = hashFile(photo) != pictureHash",
      'say "${hashFile(letters)}", instant',
      "exit",
    ].join("\n"),
    store,
  );
  const { lettersHash, textHash, pictureHash, changed } = variables(played);
  // FIPS 180-4's example for "abc".
  assert.equal(lettersHash, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(textHash, lettersHash);
  // As `sha256sum` gives it for the bytes of the PNG sample.
  assert.equal(pictureHash, "02a3e298f1533f62558c58e4c70edcab9af5a50d62d925fd5390942020fb0fb8");
  assert.equal(changed, true);
  // Each hash asks for one stored file and is answered with its hash alone, never with its bytes.
  assert.deepEqual(
    played.requests.map((request) => [request.operation, request.files, request.references]),
    [
      ["store", [{ type: "application/octet-stream", base64: "YWJj" }], []],
      ["store", [{ type: "image/png", base64: base64("png") }], []],
      ["hash", [], ["stored:1"]],
      ["hash", [], ["stored:2"]],
      ["hash", [], ["stored:3"]],
      ["hash", [], ["stored:1"]],
    ],
  );
  assert.deepEqual(
    played.events.flatMap((event) =>
      event.kind === "actionCompleted" &&
      "outcome" in event.settlement &&
      event.settlement.actionKind === "fileStore"
        ? [event.settlement.outcome]
        : [],
    ),
    ["stored", "stored", "hashed", "hashed", "hashed", "hashed"],
  );
  assert.ok(played.events.some((event) => event.kind === "say" && event.text === lettersHash));
});

test("a hash completion must hold one SHA-256 in lowercase hexadecimal digits, and its handoff is checked on restore", () => {
  const store = new FakeFileStore();
  const plan = compileValidPlan(
    'let letters = fileFromBase64("YWJj", default: "")\nlet hash = hashFile(letters)\nexit',
  );
  let snapshot = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  const kept = snapshot.foregroundAction;
  assert.ok(kept?.kind === "fileStore");
  snapshot = run(
    plan,
    completeAction(
      plan,
      snapshot,
      { actionId: kept.actionId, actionKind: "fileStore", payload: store.answer(kept) },
      { capturedMedia: store.admission },
    ).snapshot,
  ).snapshot;
  const action = snapshot.foregroundAction;
  assert.ok(action?.kind === "fileStore" && action.operation === "hash");
  const hash = sha256(Buffer.from("abc"));
  const complete = (payload: unknown) =>
    completeAction(plan, snapshot, { actionId: action.actionId, actionKind: "fileStore", payload });
  for (const payload of [
    { kind: "hashed", hashes: [] },
    { kind: "hashed", hashes: [hash, hash] },
    { kind: "hashed", hashes: [hash.toUpperCase()] },
    { kind: "hashed", hashes: [hash.slice(1)] },
    { kind: "hashed", hashes: [hash], extra: true },
    { kind: "read", files: ["YWJj"] },
  ])
    assert.equal(complete(payload).outcome.kind, "invalidPayload", JSON.stringify(payload));
  const completed = complete({ kind: "hashed", hashes: [hash] });
  assert.equal(completed.outcome.kind, "completed");
  assert.deepEqual(validateRuntimeSnapshot(completed.snapshot, plan).errors, []);
  const handoff = completed.snapshot.interactionResultHandoff;
  assert.ok(handoff !== null);
  const forged = {
    ...completed.snapshot,
    interactionResultHandoff: { ...handoff, result: list("not a hash") },
  };
  assert.deepEqual(validateRuntimeSnapshot(forged, plan).errors, [
    "Runtime file store answer handoff is malformed.",
  ]);
});

test("fileFromBase64 reads Base64 as fromBase64 does, and a data URL by its bytes, never by its declared type", () => {
  const png = base64("png");
  const loose = `${png.slice(0, 8)}\n ${png.slice(8).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")}`;
  const played = play(
    [
      `let spaced = fileFromBase64(${JSON.stringify(loose)}, default: "")`,
      `let declared = fileFromBase64("data:text/plain;base64,${png}", default: "")`,
      `let named = fileFromBase64("data:image/png;base64,${base64("svg")}", default: "")`,
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(
    played.requests.map((request) => request.files),
    [
      [{ type: "image/png", base64: png }],
      [{ type: "image/png", base64: png }],
      [{ type: "application/octet-stream", base64: base64("svg") }],
    ],
  );
});

test("text that is not Base64, and a value that is not text, give the default at once", () => {
  const played = play(
    [
      'let invalid = fileFromBase64("not Base64!", default: null)',
      'let broken = fileFromBase64("data:image/png;base64,%%%", default: "none")',
      'let plain = fileFromBase64("data:image/png,PNG", default: 0)',
      'let unknownValue = fromJson("[1]", default: null)',
      "let notText = fileFromBase64(unknownValue, default: false)",
      "exit",
    ].join("\n"),
  );
  assert.deepEqual(played.requests, []);
  const { invalid, broken, plain, notText } = variables(played);
  assert.deepEqual([invalid, broken, plain, notText], [null, "none", 0, false]);
});

test("toJson writes stored files as data URLs and fromJson stores them again, in a dict and a list", () => {
  const store = new FakeFileStore();
  const played = play(
    [
      "let photo = takePhoto()",
      `let clip = fileFromBase64("${base64("ogg")}", default: "")`,
      'let files = dict { "photo": photo, "path": "images/a.jpg" }',
      'let preset = { name: "Corner", files: files, media: [clip, photo, "images/a.jpg"] }',
      "let json = toJson(preset)",
      "let kept = toJson(preset, files: false)",
      "let read = fromJson(json, default: null)",
      "let text = fromJson(json, default: null, files: false)",
      "exit",
    ].join("\n"),
    store,
  );
  const jpeg = `data:image/jpeg;base64,${base64("jpeg")}`;
  const ogg = `data:audio/ogg;base64,${base64("ogg")}`;
  const { json, kept, read, text } = variables(played);
  assert.equal(
    json,
    JSON.stringify({
      name: "Corner",
      files: { photo: jpeg, path: "images/a.jpg" },
      media: [ogg, jpeg, "images/a.jpg"],
    }),
  );
  // Without files a reference stays its text.
  assert.equal(
    kept,
    JSON.stringify({
      name: "Corner",
      files: { photo: "stored:1", path: "images/a.jpg" },
      media: ["stored:2", "stored:1", "images/a.jpg"],
    }),
  );
  // Each file is read once and stored once; the same file twice gives one reference.
  assert.deepEqual(
    played.requests.map((request) => [
      request.operation,
      request.files.map((file) => file.type),
      request.references,
    ]),
    [
      ["store", ["audio/ogg"], []],
      ["read", [], ["stored:1", "stored:2"]],
      ["store", ["image/jpeg", "audio/ogg"], []],
    ],
  );
  assert.deepEqual(
    read,
    dict(
      ["name", "Corner"],
      ["files", dict(["photo", "stored:3"], ["path", "images/a.jpg"])],
      ["media", list("stored:4", "stored:3", "images/a.jpg")],
    ),
  );
  assert.deepEqual(
    text,
    dict(
      ["name", "Corner"],
      ["files", dict(["photo", jpeg], ["path", "images/a.jpg"])],
      ["media", list(ogg, jpeg, "images/a.jpg")],
    ),
  );
  assert.deepEqual(
    [...store.files.entries()].map(([reference, file]) => [reference, file.kind, file.base64]),
    [
      ["stored:1", "image", base64("jpeg")],
      ["stored:2", "audio", base64("ogg")],
      ["stored:3", "image", base64("jpeg")],
      ["stored:4", "audio", base64("ogg")],
    ],
  );
});

test("only stored files become data URLs, and only data URLs of recognized types become files", () => {
  const png = `data:image/png;base64,${base64("png")}`;
  const played = play(
    [
      'let paths = toJson(["images/a.jpg", "stored:1", "data:image/png;base64,AAAA"])',
      `let refused = fromJson(${JSON.stringify(JSON.stringify([`data:image/svg+xml;base64,${base64("svg")}`, `data:text/html;base64,${base64("html")}`]))}, default: null)`,
      `let keyed = fromJson(${JSON.stringify(JSON.stringify({ a: png, [png]: 1 }))}, default: null)`,
      `let root = fromJson(${JSON.stringify(JSON.stringify(`data:video/webm;base64,${base64("webm")}`))}, default: null)`,
      "exit",
    ].join("\n"),
  );
  const { paths, refused, keyed, root } = variables(played);
  // No toJson here holds a stored file, so none waits; a text that looks like a reference is text.
  assert.equal(paths, '["images/a.jpg","stored:1","data:image/png;base64,AAAA"]');
  assert.deepEqual(
    refused,
    list(`data:image/svg+xml;base64,${base64("svg")}`, `data:text/html;base64,${base64("html")}`),
  );
  // A key stays text; a value becomes a file.
  assert.deepEqual(keyed, dict(["a", "stored:1"], [png, 1]));
  assert.equal(root, "stored:2");
  assert.deepEqual(
    played.requests.map((request) => request.files.map((file) => file.type)),
    [["image/png"], ["video/webm"]],
  );
});

test("a saved file is a file in a later session, whose host names it at Start", () => {
  const store = new FakeFileStore();
  const saved = play(
    [
      `let picture = fileFromBase64("${base64("gif89")}", default: "")`,
      'save picture as "picture"',
      "exit",
    ].join("\n"),
    store,
  );
  assert.deepEqual(saved.snapshot.scriptStorage, [{ key: "picture", value: "stored:1" }]);
  const later = [
    'let picture: string = load("picture", default: "")',
    "let json = toJson([picture])",
    "let data = fileToBase64(picture)",
    "exit",
  ].join("\n");
  assert.deepEqual(
    variables(
      play(later, store, {
        scriptStorage: saved.snapshot.scriptStorage,
        storedFiles: ["stored:1"],
      }),
    ),
    {
      picture: "stored:1",
      json: `["data:image/gif;base64,${base64("gif89")}"]`,
      data: base64("gif89"),
    },
  );
  // A host that does not name it leaves it text.
  const unnamed = play(later.replace("let data = fileToBase64(picture)\n", ""), store, {
    scriptStorage: saved.snapshot.scriptStorage,
  });
  assert.deepEqual(variables(unnamed).json, '["stored:1"]');
});

test("fileToBase64 and hashFile need a stored file this session knows", () => {
  const pass =
    "Pass the text that takePhoto(), askImage(...), fileFromBase64(...), or fromJson(...) gave for a file.";
  for (const [call, message] of [
    [
      'fileToBase64("images/a.jpg")',
      `fileToBase64(...) reads a stored file, but "images/a.jpg" is not one. ${pass}`,
    ],
    [
      'fileToBase64(fromJson("1", default: null))',
      `fileToBase64(...) reads a stored file, not a number. ${pass}`,
    ],
    // A package path is a file of the package, not a stored file.
    [
      'hashFile("images/a.jpg")',
      `hashFile(...) hashes a stored file, but "images/a.jpg" is not one. ${pass}`,
    ],
    [
      'hashFile(fromJson("1", default: null))',
      `hashFile(...) hashes a stored file, not a number. ${pass}`,
    ],
  ] as const) {
    const played = play(`let data = ${call}\nexit`);
    assert.deepEqual(played.requests, []);
    assert.deepEqual(
      [played.snapshot.failure?.code, played.snapshot.failure?.message],
      ["TSR059", message],
    );
  }
});

test("a file store's default runs only when it is used, after the Player's answer, and resumes when it waits", () => {
  const helpers = [
    "function same(value) {",
    "    return value",
    "}",
    "function slow(value) {",
    "    wait 1 s",
    '    say "default ${value}"',
    "    return value",
    "}",
  ];
  const json = JSON.stringify(JSON.stringify([`data:image/png;base64,${base64("png")}`]));
  const source = [
    ...helpers,
    `let picture = fileFromBase64("${base64("png")}", default: slow("none"))`,
    `let read = fromJson(${json}, default: slow("nothing"))`,
    'let bad = fileFromBase64(same("!!"), default: slow("bad"))',
    "exit",
  ].join("\n");
  const kept = play(source);
  assert.deepEqual(
    kept.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["default bad"],
  );
  assert.equal(variables(kept).bad, "bad");
  const store = new FakeFileStore();
  store.failing = true;
  const failed = play(source, store);
  assert.deepEqual(
    failed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["default none", "default nothing", "default bad"],
  );
  const { picture, read, bad } = variables(failed);
  assert.deepEqual([picture, read, bad], ["none", "nothing", "bad"]);
});

test("a block may run while a file store waits, before its default, so the check forgets what it may change", () => {
  const json = JSON.stringify(JSON.stringify([`data:image/png;base64,${base64("png")}`]));
  for (const call of ['fileFromBase64("YWJj", default: @)', `fromJson(${json}, default: @)`]) {
    // The check reports the read in the default, which may run after the block.
    const checked = compileSource(
      [
        "let x: integer | null = 1",
        "timer async 1 ms { x = null }",
        "x = 1",
        `let result = ${call.replace("@", "x + 1")}`,
        "exit",
      ].join("\n"),
    );
    assert.deepEqual(
      checked.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.span.start.line]),
      [["TSV043", 3]],
      call,
    );
    // Through a property, which the check does not follow, the read fails there when the block ran meanwhile.
    const plan = compileValidPlan(
      [
        "let o: object = { n: 1 }",
        "timer async 1 ms { o.n = null }",
        `let result = ${call.replace("@", "o.n + 1")}`,
        "exit",
      ].join("\n"),
    );
    let snapshot = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
    snapshot = run(plan, observeTime(plan, snapshot, 1).snapshot).snapshot;
    const action = snapshot.foregroundAction;
    assert.ok(action?.kind === "fileStore", call);
    const answered = completeAction(plan, snapshot, {
      actionId: action.actionId,
      actionKind: "fileStore",
      payload: { kind: "failed" },
    });
    const failure = run(plan, answered.snapshot).snapshot.failure;
    assert.deepEqual([failure?.code, failure?.span.start.line], ["TSR027", 2], call);
  }
});

test("when the Player cannot keep a file the call gives its default with a warning, and a file it cannot read fails", () => {
  const store = new FakeFileStore();
  store.failing = true;
  const kept = play(
    [
      `let picture = fileFromBase64("${base64("png")}", default: "none")`,
      `let read = fromJson(${JSON.stringify(JSON.stringify([`data:image/png;base64,${base64("png")}`]))}, default: [])`,
      "exit",
    ].join("\n"),
    store,
  );
  assert.deepEqual(variables(kept), { picture: "none", read: list() });
  assert.deepEqual(
    kept.events.flatMap((event) =>
      event.kind === "developerWarning" ? [[event.code, event.message]] : [],
    ),
    [
      ["TSW019", "The Player could not keep the file, so fileFromBase64(...) gave its default."],
      [
        "TSW019",
        "The Player could not keep the files of this JSON, so fromJson(...) gave its default.",
      ],
    ],
  );
  for (const [call, name] of [
    ["fileToBase64(photo)", "fileToBase64"],
    ["hashFile(photo)", "hashFile"],
    ["toJson([photo])", "toJson"],
  ] as const) {
    const failing = new FakeFileStore();
    const plan = compileValidPlan(`let photo = takePhoto() otherwise ""\nlet data = ${call}\nexit`);
    let result = run(plan, createImmediatePacingRuntimeSnapshot(plan));
    const capture = result.snapshot.foregroundAction!;
    result = run(
      plan,
      completeAction(
        plan,
        result.snapshot,
        {
          actionId: capture.actionId,
          actionKind: "capture",
          payload: {
            kind: "captured",
            media: { kind: "image", reference: failing.keep("image/jpeg", base64("jpeg")) },
          },
        },
        { capturedMedia: failing.admission },
      ).snapshot,
    );
    const read = result.snapshot.foregroundAction!;
    assert.equal(read.kind, "fileStore");
    result = run(
      plan,
      completeAction(plan, result.snapshot, {
        actionId: read.actionId,
        actionKind: "fileStore",
        payload: { kind: "failed" },
      }).snapshot,
    );
    assert.deepEqual(
      [result.snapshot.status, result.snapshot.failure?.code, result.snapshot.failure?.message],
      [
        "failed",
        "TSR085",
        `${name}(...) could not read a stored file it needs, because this browser no longer has it or could not read it. Take, choose, or store the file again.`,
      ],
    );
  }
});

test("a completion is checked against its request, and a repeated one replays its settlement", () => {
  const store = new FakeFileStore();
  const plan = compileValidPlan(
    `let picture = fileFromBase64("${base64("webp")}", default: "")\nexit`,
  );
  const waiting = run(plan, createImmediatePacingRuntimeSnapshot(plan)).snapshot;
  const action = waiting.foregroundAction;
  assert.ok(action?.kind === "fileStore");
  const complete = (snapshot: RuntimeSnapshot, payload: unknown, trusted = true) =>
    completeAction(
      plan,
      snapshot,
      { actionId: action.actionId, actionKind: "fileStore", payload },
      trusted ? { capturedMedia: store.admission } : {},
    );
  const audio = store.keep("audio/ogg", base64("ogg"));
  const reference = store.keep("image/webp", base64("webp"));
  for (const payload of [
    { kind: "read", files: [base64("webp")] },
    { kind: "stored", references: [] },
    { kind: "stored", references: [reference, reference] },
    { kind: "stored", references: ["unknown"] },
    // A reference of another kind than the file's.
    { kind: "stored", references: [audio] },
    { kind: "failed", reason: "quota" },
  ])
    assert.equal(
      complete(waiting, payload).outcome.kind,
      "invalidPayload",
      JSON.stringify(payload),
    );
  // Without a trusted store no stored file is accepted.
  assert.equal(
    complete(waiting, { kind: "stored", references: [reference] }, false).outcome.kind,
    "invalidPayload",
  );
  const completed = complete(waiting, { kind: "stored", references: [reference] });
  assert.equal(completed.outcome.kind, "completed");
  const again = complete(completed.snapshot, { kind: "stored", references: [reference] });
  assert.equal(again.outcome.kind, "alreadySettled");
  assert.deepEqual(again.events, []);
});

test("a call without files gives its result at once, and the same answers give the same session", () => {
  const source = [
    'let data = toJson({ a: [1, 2], b: "c" })',
    "let back = fromJson(data, default: null)",
    "let photo = takePhoto()",
    "let twice = toJson([photo, photo])",
    "exit",
  ].join("\n");
  const first = play(source);
  const second = play(source);
  assert.deepEqual(
    first.requests.map((request) => [request.operation, request.references]),
    [["read", ["stored:1"]]],
  );
  assert.deepEqual(first.events, second.events);
  assert.equal(
    serializeCheckpoint(createCheckpoint(first.plan, first.snapshot)),
    serializeCheckpoint(createCheckpoint(second.plan, second.snapshot)),
  );
  const photo = `data:image/jpeg;base64,${base64("jpeg")}`;
  assert.equal(variables(first).twice, JSON.stringify([photo, photo]));
});

test("the file functions are checked where the types show their arguments", () => {
  const diagnostics = (source: string) =>
    compileSource(`${source}\nexit`).diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.message,
    ]);
  assert.deepEqual(diagnostics('let f = fileFromBase64("AAAA")'), [
    [
      "TSV020",
      "'fileFromBase64(text, default: value)' needs a 'default:' for text that is not valid Base64. Add one, such as 'default: null'.",
    ],
  ]);
  assert.deepEqual(diagnostics("let f = fileFromBase64(3, default: null)"), [
    ["TSV043", "fileFromBase64(...) reads text (string), not a whole number (integer)."],
  ]);
  assert.deepEqual(diagnostics('let f = fileToBase64("x", default: "")'), [
    ["TSV022", "fileToBase64() takes its arguments without names. Remove 'default:'."],
  ]);
  assert.deepEqual(diagnostics("let h = hashFile(3)"), [
    [
      "TSV043",
      "hashFile(...) hashes a stored file, which is text (string), but this is a whole number (integer).",
    ],
  ]);
  assert.deepEqual(diagnostics('let h = hashFile("x", type: "sha1")'), [
    ["TSV022", "hashFile() takes its arguments without names. Remove 'type:'."],
  ]);
  assert.deepEqual(diagnostics("let h = hashFile()"), [
    ["TSV020", "hashFile() takes 1 argument (file), received 0."],
  ]);
  assert.deepEqual(
    diagnostics("let hashFile = 1").map(([code]) => code),
    ["TSV001"],
  );
  assert.deepEqual(diagnostics('let j = toJson(1, files: "yes")'), [
    ["TSV043", "'files:' takes true or false (boolean), not text (string)."],
  ]);
  assert.deepEqual(diagnostics("let j = toJson(1, keep: true)"), [
    ["TSV022", "toJson() has no parameter 'keep'. Its only named argument is 'files:'."],
  ]);
});

test("a file call waits and gives its result in a parameter default, a condition, and a timer block too", () => {
  const store = new FakeFileStore();
  const played = play(
    [
      `let picture = fileFromBase64("${base64("png")}", default: "")`,
      "function packed(json = toJson([picture])) {",
      "  return json",
      "}",
      "let fromDefault = packed()",
      "let decided = false",
      'if fileToBase64(picture) != "" and toJson(picture) != "" {',
      "  decided = true",
      "}",
      'let fromBlock = ""',
      "timer async 1 ms {",
      "  fromBlock = toJson([picture])",
      "}",
      "wait 1 s",
      "exit",
    ].join("\n"),
    store,
  );
  const data = `["data:image/png;base64,${base64("png")}"]`;
  const { fromDefault, decided, fromBlock } = variables(played);
  assert.deepEqual([fromDefault, decided, fromBlock], [data, true, data]);
  assert.deepEqual(
    played.requests.map((request) => request.operation),
    ["store", "read", "read", "read", "read"],
  );
});
