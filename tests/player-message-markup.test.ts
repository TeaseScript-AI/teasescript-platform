import assert from "node:assert/strict";
import test from "node:test";

import { preparePlayerMessageMarkup } from "../player/message-markup.js";
import { parseMessageMarkup } from "../src/message-markup.js";

test("prepares constrained Player runs without input-depth recursion", () => {
  const depth = 10_000;
  const content = parseMessageMarkup(`${"[u]".repeat(depth)}x${"[/u]".repeat(depth)}`);
  const blocks = preparePlayerMessageMarkup(content);
  assert.equal(blocks[0]?.kind, "paragraph");
  if (blocks[0]?.kind !== "paragraph") throw new Error("Expected paragraph markup.");
  assert.deepEqual(blocks[0].lines[0]?.groups, [
    {
      spoilerId: null,
      pieces: [{ text: "x", classes: ["markup-underline"], style: {}, href: null }],
    },
  ]);
  assert.doesNotThrow(() => JSON.stringify(blocks));
});

test("combines nested style precedence, spoiler groups, and safe link targets", () => {
  const content = parseMessageMarkup(
    "[color=#112233]outer [color=#aabbcc][spoiler][label](https://example.com)[/spoiler][/color][/color]",
  );
  const blocks = preparePlayerMessageMarkup(content);
  assert.equal(blocks[0]?.kind, "paragraph");
  if (blocks[0]?.kind !== "paragraph") throw new Error("Expected paragraph markup.");
  const groups = blocks[0].lines[0]?.groups;
  assert.equal(groups?.length, 2);
  assert.deepEqual(groups?.[0], {
    spoilerId: null,
    pieces: [{ text: "outer ", classes: [], style: { color: "#112233" }, href: null }],
  });
  assert.deepEqual(groups?.[1]?.pieces, [
    { text: "label", classes: [], style: { color: "#aabbcc" }, href: "https://example.com/" },
  ]);
  assert.notEqual(groups?.[1]?.spoilerId, null);
});

test("ends each inline style before adjacent plain text and honors nested weight depth", () => {
  const blocks = preparePlayerMessageMarkup(
    parseMessageMarkup(
      "[weight=light]light **bold** light[/weight] plain *italic* plain ~~strike~~ plain `code` plain [u]under[/u] plain",
    ),
  );
  assert.equal(blocks[0]?.kind, "paragraph");
  if (blocks[0]?.kind !== "paragraph") throw new Error("Expected paragraph markup.");
  const pieces = blocks[0].lines[0]?.groups.flatMap((group) => group.pieces) ?? [];
  const byText = (text: string) => pieces.filter((piece) => piece.text.trim() === text);
  assert.equal(byText("bold")[0]?.style.fontWeight, "700");
  assert.equal(byText("light")[0]?.style.fontWeight, "300");
  assert.deepEqual(
    byText("plain").map((piece) => [piece.classes, piece.style]),
    [
      [[], {}],
      [[], {}],
      [[], {}],
      [[], {}],
      [[], {}],
    ],
  );
  assert.deepEqual(byText("italic")[0]?.classes, ["markup-italic"]);
  assert.deepEqual(byText("strike")[0]?.classes, ["markup-strikethrough"]);
  assert.deepEqual(byText("code")[0]?.classes, ["markup-code"]);
  assert.deepEqual(byText("under")[0]?.classes, ["markup-underline"]);
});
