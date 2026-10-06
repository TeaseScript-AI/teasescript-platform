import assert from "node:assert/strict";
import test from "node:test";

import { storageMembers, storagePreview } from "../player/storage-preview.js";
import { createPlayerRuntimeSession } from "../player/runtime-adapter.js";

// Debug's Storage tab previews each saved value by its type. The values come from real saves, as the Player stores
// them; members are listed only on request, in their order, with the label that names them.

function savedValues(source: string) {
  const session = createPlayerRuntimeSession(`${source}\nexit`);
  return new Map(session.snapshot.scriptStorage.map((entry) => [entry.key, entry.value]));
}

test("each saved value is previewed by its type", () => {
  const saved = savedValues(
    [
      'save 3 as "integer"',
      'save 2.5 as "number"',
      'save "Ada" as "text"',
      'save true as "flag"',
      'save [1, null] as "list"',
      'save { level: 2, tags: ["a"] } as "object"',
      'save 90 s as "duration"',
      'save "captured-media:11111111-1111-4111-8111-111111111111:1" as "photo"',
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
  assert.deepEqual(preview("object"), {
    type: "Object",
    text: "2 properties",
    photo: null,
    size: 2,
  });
  assert.equal(preview("duration").type, "Duration");
  assert.deepEqual(preview("photo"), {
    type: "Photo",
    text: "Captured or chosen image",
    photo: "captured-media:11111111-1111-4111-8111-111111111111:1",
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
