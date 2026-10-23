import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_MEMBER_PAGE,
  storageMembers,
  storageOutline,
  storagePreview,
} from "../player/storage-preview.js";
import {
  createPlayerRuntimeSession,
  playerRuntimeDebugVariables,
  playerRuntimeSnapshot,
} from "../player/runtime-adapter.js";
import { RUNTIME_DEBUG_TRACE_LIMITS, type SerializableRuntimeValue } from "../src/index.js";

// Debug's Storage tab previews each saved value by its type, in the engine's notation that Variables shows too. The
// values come from real saves, as the Player stores them; members are listed only on request, in their order, with the
// label that names them.

function savedValues(source: string) {
  const session = createPlayerRuntimeSession(`${source}\nexit`);
  return new Map(
    playerRuntimeSnapshot(session).scriptStorage.map((entry) => [entry.key, entry.value]),
  );
}

const reference = "captured-media:11111111-1111-4111-8111-111111111111:1";

test("each saved value is previewed by its type", () => {
  const saved = savedValues(
    [
      'save 3 as "integer"',
      'save 2.5 as "number"',
      'save "Ada" as "text"',
      'save true as "flag"',
      'save [1, null] as "list"',
      'save set["a", "b"] as "set"',
      'save { level: 2, tags: ["a"] } as "object"',
      'save 2..=5 as "range"',
      'save 1.5 s as "duration"',
      'save 1 rad as "angle"',
      'save toDate("2026-10-06") as "date"',
      'save toTime("21:30") as "time"',
      'save toDateTime("2026-10-06T21:30") as "datetime"',
      'save toAbsoluteDateTime("2026-10-06T19:30:00Z") as "absoluteDateTime"',
      'save dict{ "a b": 1 } as "dict"',
      `save "${reference}" as "photo"`,
      'save "captured-media:note" as "note"',
    ].join("\n"),
  );
  const preview = (key: string) => {
    const { type, photo, size } = storagePreview(saved.get(key)!);
    return { type, photo, size };
  };
  const scalar = (type: string) => ({ type, photo: null, size: null });
  assert.deepEqual(preview("integer"), scalar("Integer"));
  assert.deepEqual(preview("number"), scalar("Number"));
  assert.deepEqual(preview("text"), scalar("Text"));
  assert.deepEqual(preview("flag"), scalar("Yes/no"));
  assert.deepEqual(preview("list"), { type: "List", photo: null, size: 2 });
  assert.deepEqual(preview("set"), { type: "Set", photo: null, size: 2 });
  assert.deepEqual(preview("object"), { type: "Object", photo: null, size: 2 });
  assert.deepEqual(preview("dict"), { type: "Dict", photo: null, size: 1 });
  assert.deepEqual(preview("range"), scalar("Range"));
  assert.deepEqual(preview("duration"), scalar("Duration"));
  assert.deepEqual(preview("angle"), scalar("Angle"));
  assert.deepEqual(preview("date"), scalar("Date"));
  assert.deepEqual(preview("time"), scalar("Time"));
  assert.deepEqual(preview("datetime"), scalar("Date and time"));
  assert.deepEqual(preview("absoluteDateTime"), scalar("Absolute date and time"));
  assert.deepEqual(storagePreview(null), {
    type: "Nothing",
    text: "null",
    photo: null,
    size: null,
  });
  assert.equal(storagePreview({ kind: "script", path: "rooms/hall.tease" }).type, "Script");
  assert.equal(storagePreview({ kind: "regex", source: "\\d+", flags: "i" }).type, "Regex");
  // Text shaped like a photo reference stays text; the store decides whether it names a saved photo.
  assert.deepEqual(storagePreview(saved.get("photo")!), {
    type: "Text",
    text: `"${reference}"`,
    photo: reference,
    size: null,
  });
  assert.deepEqual(preview("note"), scalar("Text"));
});

test("a saved value and a dict key show in TeaseScript notation, as Variables shows the same value", () => {
  // Each value is saved and kept in a variable, and the session waits at a question, where Variables lists them.
  const values: readonly [name: string, literal: string][] = [
    ["textValue", '"a\\${b}"'],
    ["quotedValue", '"say \\"hi\\"\\n"'],
    ["rangeValue", "1..5"],
    ["inclusiveValue", "2..=5"],
    ["dateValue", 'toDate("2026-10-04")'],
    ["timeValue", 'toTime("21:30")'],
    ["dateTimeValue", 'toDateTime("2026-10-06T21:30")'],
    ["instantValue", 'toAbsoluteDateTime("2026-10-06T19:30:00Z")'],
    ["durationValue", "1.5 s"],
    ["angleValue", "1 rad"],
    ["scriptValue", 'script("rooms/hall.tease")'],
    ["listValue", "[1, 2, 3]"],
    ["setValue", 'set["a", "b"]'],
    ["objectValue", '{ level: 2, tags: ["a"] }'],
    ["dictValue", 'dict{ "a b": 1, "c\\${d}": 2 }'],
  ];
  const main = [
    ...values.map(([name, literal]) => `let ${name} = ${literal}\nsave ${name} as "${name}"`),
    'let stop = askChoice "Stop"',
    "exit",
  ].join("\n");
  const session = createPlayerRuntimeSession({
    files: [
      { path: "main.tease", source: main },
      { path: "rooms/hall.tease", source: 'label start\nsay "hall"\nexit' },
    ],
  });
  const saved = new Map(
    playerRuntimeSnapshot(session).scriptStorage.map((entry) => [entry.key, entry.value]),
  );
  const { variables } = playerRuntimeDebugVariables(session);
  const shown = new Map(
    [...variables.globals, ...variables.frames.flatMap((frame) => frame.variables)].map(
      (variable) => [variable.name, `${variable.preview}${variable.truncated ? "…" : ""}`],
    ),
  );
  for (const [name] of values) {
    assert.ok(shown.has(name), name);
    assert.equal(storagePreview(saved.get(name)!).text, shown.get(name), name);
  }
  // Not JSON: a text escapes `${` as its literal does, and a range, a script reference and a date read as code.
  const text = (name: string) => storagePreview(saved.get(name)!).text;
  assert.equal(text("textValue"), '"a\\${b}"');
  assert.equal(text("quotedValue"), '"say \\"hi\\"\\n"');
  assert.equal(text("rangeValue"), "1..5");
  assert.equal(text("scriptValue"), 'script("rooms/hall.tease")');
  assert.equal(text("dateValue"), "<date 2026-10-04>");
  assert.deepEqual(
    storageMembers(saved.get("dictValue")!).map((member) => member.label),
    ['"a b"', '"c\\${d}"'],
  );
});

test("a long value shows the start of its notation, cut at the engine's preview limit", () => {
  const limit = RUNTIME_DEBUG_TRACE_LIMITS.maxPreviewCharacters;
  assert.equal(storagePreview("x".repeat(limit)).text, `"${"x".repeat(limit - 1)}…`);
  assert.equal(storagePreview("x".repeat(limit - 2)).text, `"${"x".repeat(limit - 2)}"`);
  // A wide list is written only as far as the limit.
  const wide = storagePreview({
    kind: "list",
    items: Array.from({ length: 100_000 }, (_, index) => index),
  }).text;
  assert.ok(wide.startsWith("[0, 1, 2, 3"));
  assert.equal(wide.length, limit + 1);
  assert.ok(wide.endsWith("…"));
  const longKey = storageMembers({
    kind: "dict",
    entries: [{ key: "k".repeat(limit * 2), value: 1 }],
  });
  assert.equal(longKey[0]?.label, `"${"k".repeat(limit - 1)}…`);
});

test("members are listed in order with their index, property name, or dict key", () => {
  const saved = savedValues('save { level: 2, tags: ["a", null] } as "object"');
  const members = storageMembers(saved.get("object")!);
  assert.deepEqual(
    members.map((member) => member.label),
    ["level", "tags"],
  );
  assert.deepEqual(
    storageMembers(members[1]!.value).map(({ label, value }) => [
      label,
      storagePreview(value).type,
    ]),
    [
      ["[0]", "Text"],
      ["[1]", "Nothing"],
    ],
  );
  assert.deepEqual(storageMembers(3), []);
});

test("the outline shows only what is expanded, a page of members at a time", () => {
  const wide: SerializableRuntimeValue = {
    kind: "list",
    items: Array.from({ length: 10_000 }, (_, index) => index),
  };
  assert.deepEqual(
    storageOutline(wide, new Set(), new Map()).map((row) => row.kind),
    ["value"],
  );
  const firstPage = storageOutline(wide, new Set([""]), new Map());
  assert.equal(firstPage.length, 1 + STORAGE_MEMBER_PAGE + 1);
  assert.deepEqual(firstPage.at(-1), {
    kind: "more",
    path: "",
    depth: 1,
    shown: STORAGE_MEMBER_PAGE,
    size: 10_000,
  });
  const secondPage = storageOutline(wide, new Set([""]), new Map([["", 2]]));
  assert.equal(secondPage.length, 1 + 2 * STORAGE_MEMBER_PAGE + 1);
  const last = secondPage.at(-2);
  assert.ok(last?.kind === "value");
  assert.deepEqual(
    [last.path, last.label, last.value],
    [`/${2 * STORAGE_MEMBER_PAGE - 1}`, "[39]", 39],
  );
});

test("a deep value expands level by level without recursion", () => {
  const depth = 10_000;
  let deep: SerializableRuntimeValue = "bottom";
  for (let level = 0; level < depth; level += 1) deep = { kind: "list", items: [deep] };
  const paths = new Set<string>();
  for (let path = ""; paths.size < depth; path += "/0") paths.add(path);
  const rows = storageOutline(deep, paths, new Map());
  assert.equal(rows.length, depth + 1);
  const bottom = rows.at(-1);
  assert.ok(bottom?.kind === "value");
  assert.deepEqual([bottom.depth, bottom.preview.text], [depth, '"bottom"']);
});
