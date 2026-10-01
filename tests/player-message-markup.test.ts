import { normalizeColor } from "../src/color.js";
import assert from "node:assert/strict";
import test from "node:test";

import { preparePlayerMessageMarkup, type PlayerMarkupPiece } from "../player/message-markup.js";
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
  const formatting = (piece: PlayerMarkupPiece | undefined) => ({
    classes: piece?.classes,
    style: piece?.style,
  });
  const light = formatting(firstLinePieces("[weight=light]light[/weight]")[0]);
  const bold = formatting(firstLinePieces("**bold**")[0]);
  assert.notDeepEqual(light, bold);

  const pieces = firstLinePieces(
    "[weight=light]light **bold** light[/weight] plain *italic* plain ~~strike~~ plain `code` plain [u]under[/u] plain",
  );
  const byText = (text: string) => pieces.filter((piece) => piece.text.trim() === text);
  assert.deepEqual(byText("bold").map(formatting), [bold]);
  assert.deepEqual(byText("light").map(formatting), [light, light]);
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

test("Player runs keep rejected link targets and HTML-like text inert", () => {
  const source = '[bad](javascript:alert) <b onclick="x">tag</b> [good](https://example.com)';
  const pieces = firstLinePieces(source);
  assert.equal(pieces.map((piece) => piece.text).join(""), parseMessageMarkup(source).visibleText);
  assert.deepEqual(
    pieces.filter((piece) => piece.href !== null).map((piece) => [piece.text, piece.href]),
    [["good", "https://example.com/"]],
  );
  const literal = pieces.find((piece) => piece.text.includes('<b onclick="x">tag</b>'));
  assert.deepEqual([literal?.classes, literal?.style], [[], {}]);
});

function firstLinePieces(source: string): readonly PlayerMarkupPiece[] {
  const blocks = preparePlayerMessageMarkup(parseMessageMarkup(source));
  if (blocks[0]?.kind !== "paragraph") throw new Error("Expected paragraph markup.");
  return blocks[0].lines[0]?.pieces ?? [];
}
