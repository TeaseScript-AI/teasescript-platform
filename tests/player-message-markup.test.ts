import { normalizeColor } from "../src/color.js";
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
  assert.deepEqual(blocks[0].lines[0]?.pieces, [
    { text: "x", classes: ["markup-underline"], style: {}, href: null },
  ]);
  assert.doesNotThrow(() => JSON.stringify(blocks));
});

test("combines nested style precedence, safe link targets", () => {
  const content = parseMessageMarkup(
    "[color=#112233]outer [color=#aabbcc][label](https://example.com)[/color][/color]",
  );
  const blocks = preparePlayerMessageMarkup(content);
  assert.equal(blocks[0]?.kind, "paragraph");
  if (blocks[0]?.kind !== "paragraph") throw new Error("Expected paragraph markup.");
  const groups = blocks[0].lines[0]?.pieces;
  assert.equal(groups?.length, 2);
  assert.deepEqual(groups, [
    { text: "outer ", classes: [], style: { color: normalizeColor("#112233") }, href: null },
    {
      text: "label",
      classes: [],
      style: { color: normalizeColor("#aabbcc") },
      href: "https://example.com/",
    },
  ]);
});

test("ends each inline style before adjacent plain text and honors nested weight depth", () => {
  const blocks = preparePlayerMessageMarkup(
    parseMessageMarkup(
      "[weight=light]light **bold** light[/weight] plain *italic* plain ~~strike~~ plain `code` plain [u]under[/u] plain",
    ),
  );
  assert.equal(blocks[0]?.kind, "paragraph");
  if (blocks[0]?.kind !== "paragraph") throw new Error("Expected paragraph markup.");
  const pieces = blocks[0].lines[0]?.pieces ?? [];
  const byText = (text: string) => pieces.filter((piece) => piece.text.trim() === text);
  const presentation = (piece: { classes: unknown; style: unknown } | undefined) => [
    piece?.classes,
    piece?.style,
  ];
  const unnested = (source: string) => {
    const [block] = preparePlayerMessageMarkup(parseMessageMarkup(source));
    if (block?.kind !== "paragraph") throw new Error("Expected paragraph markup.");
    return presentation(block.lines[0]?.pieces[0]);
  };
  const light = unnested("[weight=light]x[/weight]");
  const bold = unnested("**x**");
  assert.notDeepEqual(light, bold);
  assert.deepEqual(presentation(byText("bold")[0]), bold);
  assert.deepEqual(
    byText("light").map((piece) => presentation(piece)),
    [light, light],
  );
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
