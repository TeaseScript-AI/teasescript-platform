import assert from "node:assert/strict";
import test from "node:test";
import { editorFontSize, legacyHtmlToMarkup, type TextPart } from "../src/markup.ts";

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
  // Banjo_LarasDigSite: the blank line between paragraphs in a span gets no delimiters, so the paragraphs stay apart.
  assert.equal(
    converted("<i>DAY 3\n\nYou gather your gear and get off the bus.</i>"),
    "*DAY 3*\n\n*You gather your gear and get off the bus.*",
  );
  // spinthebottle: a second <i> where </i> was meant adds nothing, as in HTML, and the span closes at the end.
  assert.equal(converted("<i>Ann said: well done<i>"), "*Ann said: well done*");
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
  const result = legacyHtmlToMarkup(
    [
      { text: '<TEXTFORMAT LEADING="2"><P ALIGN="CENTER"><FONT FACE="Arial" SIZE="6">Hello <b>' },
      { value },
      { text: "</b></FONT></P></TEXTFORMAT>" },
    ],
    { editorSize: "6" },
  );
  assert.equal(result.dropped, true);
  assert.deepEqual(result.parts, [{ text: "Hello **" }, { value }, { text: "**" }]);
  // catwoman: a size computed at runtime goes with its tag, and the shown values keep theirs.
  const [m, ms, ss] = ["m", "ms", "ss"].map((name) => ({ kind: "variable" as const, name }));
  const timer = legacyHtmlToMarkup([
    { text: "<font size='" },
    { value: m! },
    { text: "'>" },
    { value: ms! },
    { text: ":" },
    { value: ss! },
    { text: "</font>" },
  ]);
  assert.equal(timer.dropped, true);
  assert.deepEqual(timer.parts, [{ value: ms }, { text: ":" }, { value: ss }]);
});

test("a font size becomes a size span on each line, apart from the size of the text around it", () => {
  // DisciplineClinic's spank intro: the size nests outside the bold, as legacy wrote them, on each line with text.
  assert.equal(
    converted("<font size='10'><b>Right cheek\n\n....... </b></font>"),
    "[size=x-large]**Right cheek**[/size]\n\n[size=x-large]**.......**[/size]",
  );
  assert.equal(
    converted("<font size=1>fine</font> <font size='3'>print</font> <font size=\"4\">big</font>"),
    "[size=small]fine[/size] print [size=large]big[/size]",
  );
  // A size that legacy did not read as a whole number adds nothing, and is reported as dropped.
  assert.deepEqual(legacyHtmlToMarkup(text('<font size="34px">Sissy</font>')), {
    parts: text("Sissy"),
    changed: true,
    dropped: true,
  });
});

test("the size an editor gave every text is normal, so only the sizes it emphasized remain", () => {
  const flash = (size: string, body: string): string =>
    `<TEXTFORMAT LEADING="2"><P ALIGN="CENTER"><FONT FACE="FontSans" SIZE="${size}" COLOR="#FFFFFF">${body}</FONT></P></TEXTFORMAT>`;
  assert.equal(
    editorFontSize([
      flash("6", "a") + flash("6", "b"),
      flash("8", "c") + flash("6", "d"),
      '<font size="10">x</font>',
    ]),
    "6",
  );
  const shown = (value: string): string =>
    legacyHtmlToMarkup(text(value), { editorSize: "6" })
      .parts.map((part) => ("text" in part ? part.text : "${…}"))
      .join("");
  assert.equal(
    shown(flash("8", "<B>Not interested!</B>") + flash("6", "You have been blocked.")),
    "[color=#ffffff][size=x-large]**Not interested!**[/size][/color]\n[color=#ffffff]You have been blocked.[/color]",
  );
  // Domme: the editor's size inside a larger one sets the text back to normal.
  assert.equal(
    shown(flash("8", '<B>It\'s a M</B><FONT SIZE="6"><B>ATCH</B><FONT SIZE="8"></FONT></FONT>')),
    "[color=#ffffff][size=x-large]**It's a M**[size=normal]**ATCH**[/size][/size][/color]",
  );
});

test("a text fragment keeps its surrounding whitespace, apart from what a tag at its start introduced", () => {
  const fragment = (value: string): string =>
    legacyHtmlToMarkup(text(value), { fragment: true })
      .parts.map((part) => ("text" in part ? part.text : "${…}"))
      .join("");
  assert.equal(fragment("<h1 style='font-size:140%;'>Title</h1>\n\n"), "# Title\n\n");
  assert.equal(fragment(" and <b>more</b> "), " and **more** ");
});
