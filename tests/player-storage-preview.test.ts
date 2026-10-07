import assert from "node:assert/strict";
import test from "node:test";

import {
  STORAGE_MEMBER_PAGE,
  storageMembers,
  storageOutline,
  storagePreview,
} from "../player/storage-preview.js";
import { createPlayerRuntimeSession, playerRuntimeSnapshot } from "../player/runtime-adapter.js";
import type { SerializableRuntimeValue } from "../src/index.js";

// Debug's Storage tab previews each saved value by its type. The values come from real saves, as the Player stores
// them; members are listed only on request, in their order, with the label that names them.

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
      'save toDate("2026-10-06") as "date"',
      'save toTime("21:30") as "time"',
      'save toDateTime("2026-10-06T21:30") as "datetime"',
      'save toTimestamp("2026-10-06T19:30:00Z") as "timestamp"',
      'save dict{ "a b": 1 } as "dict"',
      `save "${reference}" as "photo"`,
      'save "captured-media:note" as "note"',
    ].join("\n"),
  );
  const preview = (key: string) => {
    const { type, text, photo, size } = storagePreview(saved.get(key)!);
    return { type, text, photo, size };
  };
  assert.deepEqual(preview("integer"), { type: "Integer", text: "3", photo: null, size: null });
  assert.deepEqual(preview("number"), { type: "Number", text: "2.5", photo: null, size: null });
  assert.deepEqual(preview("text"), { type: "Text", text: '"Ada"', photo: null, size: null });
  assert.deepEqual(preview("flag"), { type: "Yes/no", text: "true", photo: null, size: null });
  assert.deepEqual(preview("list"), { type: "List", text: "2 items", photo: null, size: 2 });
  assert.deepEqual(preview("set"), { type: "Set", text: "2 items", photo: null, size: 2 });
  assert.deepEqual(preview("object"), {
    type: "Object",
    text: "2 properties",
    photo: null,
    size: 2,
  });
  assert.deepEqual(preview("range"), { type: "Range", text: "2 to 5", photo: null, size: null });
  assert.equal(preview("duration").type, "Duration");
  assert.deepEqual(preview("date"), { type: "Date", text: "2026-10-06", photo: null, size: null });
  assert.deepEqual(preview("time"), { type: "Time", text: "21:30", photo: null, size: null });
  assert.deepEqual(preview("datetime"), {
    type: "Date and time",
    text: "2026-10-06T21:30",
    photo: null,
    size: null,
  });
  assert.equal(preview("timestamp").type, "Timestamp");
  assert.deepEqual(preview("dict"), { type: "Dict", text: "1 entry", photo: null, size: 1 });
  assert.deepEqual(
    storageMembers(saved.get("dict")!).map((member) => member.label),
    ['"a b"'],
  );
  assert.deepEqual(
    storagePreview({ kind: "script", path: "rooms/hall.tease", label: "door" }).text,
    "rooms/hall.tease, label door",
  );
  // Text shaped like a photo reference stays text; the store decides whether it names a saved photo.
  assert.deepEqual(preview("photo"), {
    type: "Text",
    text: JSON.stringify(reference),
    photo: reference,
    size: null,
  });
  assert.deepEqual(preview("note"), {
    type: "Text",
    text: '"captured-media:note"',
    photo: null,
    size: null,
  });
  // A long text is shortened for the preview only.
  assert.equal(storagePreview("x".repeat(200)).text.length, 80);
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
