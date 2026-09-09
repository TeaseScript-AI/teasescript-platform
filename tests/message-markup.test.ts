import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeMarkup,
  messageMarkupVisibleText,
  parseMessageMarkup,
  type MessageMarkup,
  type MessageMarkupSpan,
} from "../src/message-markup.js";

test("parses exact line-start block forms and preserves line endings", () => {
  const markup = parseMessageMarkup(
    "plain\n# Head\r\n> quote\n- one\n- two\n1. first\n27. second\n#### literal\n # indented",
  );

  assert.deepEqual(
    markup.blocks.map((block) => block.kind),
    ["paragraph", "heading", "quote", "list", "list", "paragraph"],
  );
  assert.equal(markup.blocks[1]?.kind, "heading");
  if (markup.blocks[1]?.kind !== "heading") throw new Error("Expected a heading.");
  assert.equal(markup.blocks[1].level, 1);
  assert.equal(markup.blocks[3]?.kind, "list");
  if (markup.blocks[3]?.kind !== "list") throw new Error("Expected an unordered list.");
  assert.equal(markup.blocks[3].ordered, false);
  assert.equal(markup.blocks[3].items.length, 2);
  assert.equal(markup.blocks[4]?.kind, "list");
  if (markup.blocks[4]?.kind !== "list") throw new Error("Expected an ordered list.");
  assert.deepEqual(
    markup.blocks[4].items.map((item) => item.ordinal),
    ["1", "27"],
  );
  assert.equal(
    markup.visibleText,
    "plain\nHead\r\nquote\none\ntwo\nfirst\nsecond\n#### literal\n # indented",
  );
  assert.equal(messageMarkupVisibleText(markup), markup.visibleText);
});

test("requires exact block marker spelling and separates adjacent block kinds", () => {
  const markup = parseMessageMarkup(
    [
      "#Heading",
      "#### Heading",
      ">quote",
      "-item",
      "0. zero",
      "01. zero",
      "# ",
      "> ",
      "- ",
      "1. ",
    ].join("\n"),
  );

  assert.deepEqual(
    markup.blocks.map((block) => block.kind),
    ["paragraph", "heading", "quote", "list", "list"],
  );
  assert.equal(
    markup.visibleText,
    ["#Heading", "#### Heading", ">quote", "-item", "0. zero", "01. zero", "", "", "", ""].join(
      "\n",
    ),
  );
});

test("parses inline styles, recursive nesting, and triple asterisk runs deterministically", () => {
  const markup = parseMessageMarkup(
    "*italic* **bold [u]under[/u]** ~~strike~~ ***both*** [spoiler]secret[/spoiler]",
  );

  assert.deepEqual(spanKinds(markup), [
    "italic",
    "bold",
    "underline",
    "strikethrough",
    "bold",
    "italic",
    "spoiler",
  ]);
  assert.equal(markup.visibleText, "italic bold under strike both secret");
  assert.deepEqual(allSpans(markup).slice(4, 6), [
    { kind: "bold", start: 25, end: 29, depth: 0 },
    { kind: "italic", start: 25, end: 29, depth: 1 },
  ]);
});

test("parses inline code atomically and suppresses nested markup", () => {
  const valid = parseMessageMarkup("`**literal** https://example.com \\*` **active**");
  assert.deepEqual(spanKinds(valid), ["code", "bold"]);
  assert.equal(valid.visibleText, "**literal** https://example.com * active");

  const invalid = parseMessageMarkup("`` ` **not bold** ` **bold** `unmatched");
  assert.deepEqual(spanKinds(invalid), ["bold"]);
  assert.equal(invalid.visibleText, "`` ` **not bold** ` bold `unmatched");
});

test("accepts every constrained extension value and normalizes hex colors", () => {
  const source = [
    "[u]u[/u]",
    "[color=#Aa00Ff]c[/color]",
    "[bg=#123456]b[/bg]",
    ...["thin", "light", "normal", "medium", "semibold", "bold", "black"].map(
      (value) => `[weight=${value}]w[/weight]`,
    ),
    ...["small", "normal", "large", "x-large"].map((value) => `[size=${value}]s[/size]`),
    "[spoiler]p[/spoiler]",
    "[u][/u]",
  ].join(" ");
  const spans = allSpans(parseMessageMarkup(source));

  assert.equal(spans.filter((span) => span.kind === "weight").length, 7);
  assert.equal(spans.filter((span) => span.kind === "size").length, 4);
  assert.equal(spans.filter((span) => span.kind === "underline").length, 2);
  assert.equal(spans.filter((span) => span.kind === "spoiler").length, 1);
  assert.deepEqual(
    spans.flatMap((span) =>
      span.kind === "color" || span.kind === "backgroundColor" ? [span.value] : [],
    ),
    ["#aa00ff", "#123456"],
  );
});

test("recovers invalid, unknown, unmatched, and crossed extensions literally", () => {
  const invalid = parseMessageMarkup(
    "[color=red]**x**[/color] [weight=heavy]y[/weight] [b]z[/b] [u]open",
  );
  assert.equal(
    invalid.visibleText,
    "[color=red]x[/color] [weight=heavy]y[/weight] [b]z[/b] [u]open",
  );
  assert.deepEqual(spanKinds(invalid), ["bold"]);

  const crossed = parseMessageMarkup("[u][spoiler]x[/u][/spoiler]");
  assert.equal(crossed.visibleText, "[u]x[/u]");
  assert.deepEqual(spanKinds(crossed), ["spoiler"]);
});

test("keeps unmatched delimiters literal while retaining complete nested spans", () => {
  const markup = parseMessageMarkup("*outer **inner** and ~~open");
  assert.equal(markup.visibleText, "*outer inner and ~~open");
  assert.deepEqual(spanKinds(markup), ["bold"]);
  assert.equal(parseMessageMarkup("~~~literal~~~").visibleText, "~~~literal~~~");
});

test("parses labeled and bare HTTP links with deterministic boundaries", () => {
  const markup = parseMessageMarkup(
    "[**Docs**](https://example.com/a?q=1) (HTTP://example.com/path_(x)). " +
      "**https://example.org/bold** abchttps://example.net https://example.test/end!,",
  );
  const links = allSpans(markup).filter((span) => span.kind === "link");

  assert.deepEqual(
    links.map((link) => link.target),
    [
      "https://example.com/a?q=1",
      "http://example.com/path_(x)",
      "https://example.org/bold",
      "https://example.test/end",
    ],
  );
  assert.equal(
    markup.visibleText,
    "Docs (HTTP://example.com/path_(x)). https://example.org/bold " +
      "abchttps://example.net https://example.test/end!,",
  );
  assert.deepEqual(spanKinds(markup).slice(0, 2), ["link", "bold"]);
});

test("finds labeled-link closers after brackets owned by label markup", () => {
  const markup = parseMessageMarkup(
    "[[u]under[/u]](https://example.com) [label `]` code](https://example.org)",
  );

  assert.equal(markup.visibleText, "under label ] code");
  assert.deepEqual(spanKinds(markup), ["link", "underline", "link", "code"]);
  assert.deepEqual(
    allSpans(markup).map((span) => span.depth),
    [0, 1, 0, 1],
  );
});

test("pairs each labeled link with its own bracket boundary", async (context) => {
  const cases = [
    {
      name: "extension followed by link",
      source: "[u]under[/u] [label](https://example.com)",
      visibleText: "under label",
      kinds: ["underline", "link"],
      depths: [0, 0],
    },
    {
      name: "link nested in extension",
      source: "[u][label](https://example.com)[/u]",
      visibleText: "label",
      kinds: ["underline", "link"],
      depths: [0, 1],
    },
    {
      name: "unknown bracket text followed by link",
      source: "[first] ordinary [label](https://example.com)",
      visibleText: "[first] ordinary label",
      kinds: ["link"],
      depths: [0],
    },
    {
      name: "balanced literal brackets inside label",
      source: "[a [b] c](https://example.com)",
      visibleText: "a [b] c",
      kinds: ["link"],
      depths: [0],
    },
    {
      name: "escaped literal brackets inside label",
      source: "[a \\[b\\] c](https://example.com)",
      visibleText: "a [b] c",
      kinds: ["link"],
      depths: [0],
    },
    {
      name: "unmatched earlier bracket followed by link",
      source: "[broken ordinary [label](https://example.com)",
      visibleText: "[broken ordinary label",
      kinds: ["link"],
      depths: [0],
    },
    {
      name: "invalid complete link followed by valid link",
      source: "[bad](javascript:alert) [good](https://example.com)",
      visibleText: "[bad](javascript:alert) good",
      kinds: ["link"],
      depths: [0],
    },
    {
      name: "unmatched target opener followed by valid link",
      source: "[broken](no close [label](https://example.com)",
      visibleText: "[broken](no close label",
      kinds: ["link"],
      depths: [0],
    },
    {
      name: "code atom followed by link",
      source: "`[` [label](https://example.com)",
      visibleText: "[ label",
      kinds: ["code", "link"],
      depths: [0, 0],
    },
  ] as const;

  for (const example of cases) {
    await context.test(example.name, () => {
      const markup = parseMessageMarkup(example.source);
      const spans = allSpans(markup);
      assert.equal(markup.visibleText, example.visibleText);
      assert.deepEqual(
        spans.map((span) => span.kind),
        example.kinds,
      );
      assert.deepEqual(
        spans.map((span) => span.depth),
        example.depths,
      );
    });
  }
});

test("keeps rejected complete labeled links atomic and non-activatable", () => {
  for (const source of [
    "[script](javascript:alert)",
    "[data](data:text/plain,hello)",
    "[space](https://example.com/a b)",
    "[paren](https://example.com/a(b))",
    "[empty](https://)",
  ]) {
    const markup = parseMessageMarkup(source);
    assert.equal(markup.visibleText, source, source);
    assert.equal(
      allSpans(markup).some((span) => span.kind === "link"),
      false,
      source,
    );
  }
});

test("renders raw HTML-like input as literal text", () => {
  const source = '<script>alert("x")</script><b>bold</b>';
  const markup = parseMessageMarkup(source);
  assert.equal(markup.visibleText, source);
  assert.deepEqual(allSpans(markup), []);
});

test("escapeMarkup round trips every syntax-significant construct as literal text", () => {
  const inputs = [
    "*italic* **bold** ~~strike~~ `code`",
    "[u]under[/u] [color=#ff3344]red[/color]",
    "# heading\n> quote\r\n- item\n12. ordered",
    "[label](https://example.com) https://example.org/path",
    "\\ * ~ ` [ ] ( ) # > - . :",
    "Unicode 👩🏽‍💻 café 日本語",
  ];

  for (const input of inputs) {
    const parsed = parseMessageMarkup(escapeMarkup(input));
    assert.equal(parsed.visibleText, input, input);
    assert.equal(messageMarkupVisibleText(parsed), input, input);
    assert.deepEqual(allSpans(parsed), [], input);
  }

  const once = escapeMarkup("**x**");
  const twice = escapeMarkup(once);
  assert.notEqual(twice, once);
  assert.equal(parseMessageMarkup(twice).visibleText, once);
});

test("retains unknown backslash pairs and never exposes protected syntax in a second pass", () => {
  const markup = parseMessageMarkup("\\q \\*x\\* https\\://example.com");
  assert.equal(markup.visibleText, "\\q *x* https://example.com");
  assert.deepEqual(allSpans(markup), []);
});

test("returns frozen flat JSON-safe data and handles input-sized nesting iteratively", () => {
  const depth = 5_000;
  const markup = parseMessageMarkup(`${"[u]".repeat(depth)}x${"[/u]".repeat(depth)}`);
  assert.equal(markup.visibleText, "x");
  assert.equal(messageMarkupVisibleText(markup), "x");
  assert.equal(Object.isFrozen(markup), true);
  assert.equal(Object.isFrozen(markup.blocks), true);
  assert.doesNotThrow(() => JSON.stringify(markup));

  const spans = allSpans(markup);
  assert.equal(spans.length, depth);
  assert.equal(
    spans.every((span) => span.kind === "underline"),
    true,
  );
  assert.equal(spans.every(Object.isFrozen), true);
  assert.deepEqual(spans[0], { kind: "underline", start: 0, end: 1, depth: 0 });
  assert.deepEqual(spans.at(-1), { kind: "underline", start: 0, end: 1, depth: depth - 1 });

  const unmatchedSource = "[u]x".repeat(depth);
  const unmatched = parseMessageMarkup(unmatchedSource);
  assert.equal(unmatched.visibleText, unmatchedSource);
  assert.deepEqual(allSpans(unmatched), []);
  assert.doesNotThrow(() => JSON.stringify(unmatched));
});

test("uses UTF-16 ranges and depth to distinguish nested and adjacent empty spans", () => {
  const empty = parseMessageMarkup("[u][spoiler][/spoiler][/u][u][/u]");
  assert.deepEqual(allSpans(empty), [
    { kind: "underline", start: 0, end: 0, depth: 0 },
    { kind: "spoiler", start: 0, end: 0, depth: 1 },
    { kind: "underline", start: 0, end: 0, depth: 0 },
  ]);

  const unicode = parseMessageMarkup("[u]👩🏽‍💻[/u]");
  assert.equal(unicode.visibleText.length, 7);
  assert.deepEqual(allSpans(unicode), [{ kind: "underline", start: 0, end: 7, depth: 0 }]);
});

function spanKinds(markup: MessageMarkup): MessageMarkupSpan["kind"][] {
  return allSpans(markup).map((span) => span.kind);
}

function allSpans(markup: MessageMarkup): MessageMarkupSpan[] {
  const spans: MessageMarkupSpan[] = [];
  for (const block of markup.blocks) {
    if (block.kind === "paragraph" || block.kind === "quote") {
      for (const line of block.lines) spans.push(...line.spans);
    } else if (block.kind === "heading") {
      spans.push(...block.line.spans);
    } else {
      for (const item of block.items) spans.push(...item.line.spans);
    }
  }
  return spans;
}
