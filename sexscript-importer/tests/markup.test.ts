import assert from "node:assert/strict";
import test from "node:test";
import { legacyHtmlToMarkup, type TextPart } from "../src/markup.ts";

const text = (value: string): TextPart[] => [{ text: value }];
const converted = (value: string): string =>
  legacyHtmlToMarkup(text(value))
    .parts.map((part) => ("text" in part ? part.text : "${…}"))
    .join("");

test("legacy HTML in shown text becomes message markup", () => {
  assert.equal(
    converted("<b> Rule one </b><br>Line two<br/><i>quiet</i>"),
    "**Rule one**\nLine two\n*quiet*",
  );
  assert.equal(converted("<u>Kneel</u> <strike>now</strike>"), "[u]Kneel[/u] ~~now~~");
  assert.equal(
    converted('<FONT COLOR="#FF0000">red</FONT> plain'),
    "[color=#ff0000]red[/color] plain",
  );
  // A span ends at a line break, so it closes before it and opens again after it.
  assert.equal(converted("<b>one<br>two</b>"), "**one**\n**two**");
  assert.equal(
    converted("<h1>Title</h1>Body<ul><li>first</li><li>second</li></ul>"),
    "# Title\nBody\n- first\n- second",
  );
});

test("entities decode, also without their semicolon, and other ampersands stay", () => {
  assert.equal(
    converted("the &quot;Purity Ring&quot; now&nbsp;and &amp; &lt;3"),
    'the "Purity Ring" now and & <3',
  );
  assert.equal(converted("say &quotyes&quot"), 'say "yes"');
  assert.equal(converted("&#65;&#x42;"), "AB");
  assert.deepEqual(legacyHtmlToMarkup(text("http://x.test/?a=1&name=2 & more")), {
    parts: text("http://x.test/?a=1&name=2 & more"),
    changed: false,
    dropped: false,
  });
});

test("layout tags are dropped and reported, and interpolated values keep their places", () => {
  const value = { kind: "variable" as const, name: "name" };
  const result = legacyHtmlToMarkup([
    { text: '<TEXTFORMAT LEADING="2"><P ALIGN="CENTER"><FONT FACE="Arial" SIZE="6">Hello <b>' },
    { value },
    { text: "</b></FONT></P></TEXTFORMAT>" },
  ]);
  assert.equal(result.dropped, true);
  assert.deepEqual(result.parts, [{ text: "Hello **" }, { value }, { text: "**" }]);
});

test("a text fragment keeps its surrounding whitespace, apart from what a tag at its start introduced", () => {
  const fragment = (value: string): string =>
    legacyHtmlToMarkup(text(value), { fragment: true })
      .parts.map((part) => ("text" in part ? part.text : "${…}"))
      .join("");
  assert.equal(fragment("<h1 style='font-size:140%;'>Title</h1>\n\n"), "# Title\n\n");
  assert.equal(fragment(" and <b>more</b> "), " and **more** ");
});
