import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS,
  commandFacts,
  CONVERSION_FUNCTIONS,
  RANDOM_FUNCTIONS,
  CORE_RUNTIME_BUILTINS,
  TEASESCRIPT_GRAMMAR_KEYWORDS,
  TEASESCRIPT_PROTECTED_TYPE_NAMES,
} from "../src/language-facts.js";
import { CONVERSIONS } from "../src/conversions.js";
import { RANDOM_CONTRACTS } from "../src/random-functions.js";
import { MESSAGE_PRESENTATION_OPTIONS } from "../src/message-presentation.js";
import {
  askOptionNames,
  EXPORT_TEXT_OPTIONS,
  MEDIA_ARGUMENTS,
  OPEN_URL_OPTIONS,
  PERMANENT_BUTTON_OPTIONS,
  requiredAskOptionNames,
  SHOW_BUTTON_OPTIONS,
  SHOW_POPUP_OPTIONS,
  TIMER_ARGUMENTS,
} from "../src/parser.js";
import {
  classifyTokens,
  compileSource,
  createLanguageDocument,
  formatLanguageDocument,
  languageCompletions,
  languageContextHelp,
  languageDiagnostics,
  languageHover,
  languagePositionAt,
  languageSignatureHelp,
  createFreshRuntimeSnapshot,
  run,
} from "../src/index.js";

function labels(source: string, offset = source.length): readonly string[] {
  const document = createLanguageDocument("file:///main.tease", source);
  return languageCompletions(document, languagePositionAt(document, offset)).map(
    (item) => item.label,
  );
}

test("language positions use UTF-16 offsets and CRLF-aware zero-based lines", () => {
  const document = createLanguageDocument("file:///main.tease", "a\r\n😀b");
  assert.deepEqual(languagePositionAt(document, 2), { offset: 2, line: 1, column: 0 });
  assert.deepEqual(languagePositionAt(document, 3), { offset: 3, line: 1, column: 0 });
  assert.deepEqual(languagePositionAt(document, 5), { offset: 5, line: 1, column: 2 });
});

test("language diagnostics are the canonical compilation diagnostics", () => {
  const document = createLanguageDocument("file:///main.tease", "let answer = askText as");
  assert.deepEqual(languageDiagnostics(document), compileSource(document.text).diagnostics);
});

test("completion exposes accepted compact commands and takePhoto", () => {
  const statement = labels("");
  for (const expected of ["say", "showButton", "showCamera", "hideCamera"])
    assert.ok(statement.includes(expected), expected);
  const expression = labels("let answer = ");
  for (const expected of [
    "askText",
    "askNumber",
    "askInteger",
    "askDate",
    "askTime",
    "askDateTime",
    "askChoice",
    "showButton",
    "takePhoto",
    "showCamera",
  ])
    assert.ok(expression.includes(expected), expected);
  // A fallback may ask (V30 §18).
  assert.ok(labels("let name = nickname otherwise ").includes("askText"));
});

/** The commands and asks of the engine, without the grammar keywords that the parser also reads by name. */
const engineCommands = Object.keys(COMMANDS).filter(
  (name) => !TEASESCRIPT_GRAMMAR_KEYWORDS.some((keyword) => keyword === name),
);

test("completion offers every command where it starts a statement, and where it gives a value", () => {
  const statement = labels("");
  const value = labels("let answer = ");
  for (const name of engineCommands) {
    const facts = commandFacts(name)!;
    assert.equal(statement.includes(name), facts.statement !== undefined, `${name} at a statement`);
    // An earlier name is no completion.
    assert.equal(
      value.includes(name),
      facts.value === true && facts.renamed === undefined,
      `${name} as a value`,
    );
  }
});

/**
 * The named options of each command that is no compact interaction, as the parser and the name pass accept them, and a
 * call that gives each of them; the named form of a timer or media needs its first argument.
 */
const COMMAND_OPTIONS: Readonly<Record<string, readonly [readonly string[], string]>> = {
  showPopup: [SHOW_POPUP_OPTIONS, 'showPopup("Done", buttonText: "Continue")'],
  openUrl: [
    OPEN_URL_OPTIONS,
    'openUrl("https://example.com", buttonText: "Open", alwaysButton: true)',
  ],
  exportText: [
    EXPORT_TEXT_OPTIONS,
    'exportText("Report", title: "Report", fileName: "report.txt")',
  ],
  timer: [
    TIMER_ARGUMENTS.slice(1),
    'let t = timer(duration: 1 s, async: true, display: "mystery", label: "Beat", repeat: true, persist: true) {\n    say "Beat."\n}',
  ],
  showPermanentButton: [
    PERMANENT_BUTTON_OPTIONS,
    'let b = showPermanentButton "Stop", persist: true {\n    say "Stopped."\n}',
  ],
  playAudio: [
    MEDIA_ARGUMENTS.slice(1),
    'let m = playAudio(file: "a.mp3", async: true, repeat: true, startAt: 1 s, endAt: 2 s, volume: 0.5)',
  ],
  playVideo: [
    MEDIA_ARGUMENTS.slice(1),
    'let m = playVideo(file: "a.mp4", async: true, repeat: 3 times, startAt: 1 s, endAt: 2 s, volume: 0.5)',
  ],
};

test("every command has editor help that names each option the parser accepts", () => {
  for (const name of [...engineCommands, "wait"]) {
    const facts = commandFacts(name);
    if (facts?.renamed !== undefined) continue;
    if (facts?.interaction === undefined) {
      const document = createLanguageDocument("file:///main.tease", name);
      const position = languagePositionAt(document, name.length);
      const help = languageContextHelp(document, position);
      assert.equal(help?.command, name, name);
      assert.ok(help.syntax.startsWith(name), name);
      assert.deepEqual(languageHover(document, position)?.contents, [
        `**${name}**`,
        help.summary,
        `Syntax: \`${help.syntax}\``,
      ]);
      const parameters = languageSignatureHelp(document, position)?.parameters ?? [];
      const [options, call] = COMMAND_OPTIONS[name] ?? [[], null];
      for (const option of options) {
        assert.ok(help.syntax.includes(`[, ${option}:`), `${name}: ${option} in ${help.syntax}`);
        assert.ok(parameters.includes(option), `${name}: ${option} in ${parameters.join(", ")}`);
      }
      // The options the help names compile where it names them.
      if (call !== null) assert.deepEqual(compileSource(`${call}\nexit`).diagnostics, [], call);
      continue;
    }
    const source = `let answer = ${name}`;
    const document = createLanguageDocument("file:///main.tease", source);
    const position = languagePositionAt(document, source.length);
    const options =
      facts.interaction === "button" ? SHOW_BUTTON_OPTIONS : askOptionNames(facts.interaction);
    const required =
      facts.interaction === "button" ? [] : requiredAskOptionNames(facts.interaction);
    const help = languageContextHelp(document, position);
    assert.equal(help?.command, name, name);
    assert.ok(help.syntax.startsWith(`${name} `), name);
    for (const option of options) {
      // An option that the ask needs is written without brackets.
      const written = required.includes(option) ? `, ${option}:` : `[, ${option}:`;
      assert.ok(help.syntax.includes(written), `${name}: ${option} in ${help.syntax}`);
    }
    assert.deepEqual(languageSignatureHelp(document, position)?.parameters.slice(2), options, name);
  }
});

test("say's help names the options of its message modes", () => {
  const document = createLanguageDocument("file:///main.tease", 'say "Hi"');
  const summary = languageContextHelp(document, languagePositionAt(document, 1))?.summary ?? "";
  for (const option of MESSAGE_PRESENTATION_OPTIONS.prose)
    assert.ok(summary.includes(option), option);
});

test("help of a command covers its arguments as the parser reads them, and follows the option being written", () => {
  // `|` marks the cursor: the command with help there, and the parameter being written.
  for (const [marked, command, parameter] of [
    ['showPopup("Done", buttonText: |', "showPopup", "buttonText"],
    ['let shown = showPopup "Done|"', "showPopup", "message"],
    ['playAudio(file: "a.mp3", volume: |)', "playAudio", "volume"],
    ['let t = timer(duration: 1 s, async: true, label: "Go|")', "timer", "label"],
    ['let b = showPermanentButton "Stop", persist: |', "showPermanentButton", "persist"],
    ["wait (1..3) s|", "wait", "duration"],
    // The innermost of a call and a command has the help.
    ["showPopup toString(count|", "toString", "value"],
    ['let t = timer async 5 s {\n    say "Hi|"\n}', "say", "text"],
    ["let t = timer async 5 s {\n    count = 1|\n}", null, null],
    ["let t = timer(duration: 1 s, async: true)|", null, null],
    // A comma of the enclosing call ends a command's value, also while it is being written.
    ['say(showPopup "x", |1 s)', "say", "text"],
    ['say(showPopup "x", |', "say", "text"],
    ["say(timer async 5 s, |1 s)", "say", "text"],
    ["say(showCamera, |1 s)", "say", "text"],
    // A call form after a space, where the parser reads one, and a value in braces, which is no block.
    ['showPopup ("x", buttonText: |"Close")', "showPopup", "buttonText"],
    ['say(showPopup ("x"), |1 s)', "say", "text"],
    ["timer async { duration: 1 s| }.duration", "timer", "duration"],
    // Where the parser read a command's arguments in a statement it cannot read yet, such as one without its block.
    ['showPermanentButton "Go " + { text: "now|" }.text', "showPermanentButton", "text"],
    ['let t = timer async showPopup "x" "la|bel" {', "timer", "duration"],
    ['let t = timer async showPopup "x" |"label"', "timer", "duration"],
    ['let b = showPermanentButton "Stop", |', "showPermanentButton", "text"],
    // A key or a property named `wait` is no command.
    ["let x = { wait: 1| }", null, null],
    ["let x = { wait: 1 }\nsay x.wait|", "say", "text"],
    ["let t = timer(duration: 1 s, async: true) {\n    wait 1 s\n|}", null, null],
  ] as const) {
    const offset = marked.indexOf("|");
    const document = createLanguageDocument("file:///main.tease", marked.replace("|", ""));
    const position = languagePositionAt(document, offset);
    const signature = languageSignatureHelp(document, position);
    assert.deepEqual(
      [
        languageContextHelp(document, position)?.command ?? null,
        signature === null ? null : signature.parameters[signature.activeParameter],
      ],
      [command, parameter],
      marked,
    );
  }
});

test("completion exposes optional speaker and current say modifiers", () => {
  const speakers = labels('speaker mistress { name: "Mistress" }\nlet answer = askText as');
  assert.ok(speakers.includes("mistress"));
  const protectedSpeaker = labels(
    'speaker set { name: "Set" }\nspeaker mistress { name: "Mistress" }\nsay as',
  );
  assert.ok(protectedSpeaker.includes("mistress"));
  assert.ok(!protectedSpeaker.includes("set"));
  const say = labels("say");
  assert.ok(say.includes("as"));
  assert.ok(say.includes("skippable"));
  assert.ok(say.includes("unskippable"));
});

test("the pacing values offered after a say's comma compile there", () => {
  // `|` marks the cursor, and the rest is written after the completion.
  const cases: readonly (readonly [marked: string, rest: string])[] = [
    ['say "Hi",|\nexit', ""],
    ['say "Hi", |\nexit', ""],
    ['say("Hi", |)\nexit', ""],
    ['say("Hi", |', ")\nexit"],
    ['let line = say "Hi", |\nexit', ""],
    ['let lines = [say("Hi", |)]\nexit', ""],
    ['speaker mistress { name: "Mistress" }\nsay as mistress skippable "Hi", |\nexit', ""],
  ];
  for (const [marked, rest] of cases) {
    const offset = marked.indexOf("|");
    const source = marked.replace("|", "");
    const document = createLanguageDocument("file:///main.tease", source);
    const values = languageCompletions(document, languagePositionAt(document, offset)).filter(
      (item) => item.kind === "value",
    );
    assert.ok(
      values.some((item) => item.label === "instant"),
      marked,
    );
    for (const item of values) {
      const completed = source.slice(0, offset) + item.insertText + source.slice(offset) + rest;
      assert.deepEqual(compileSource(completed).diagnostics, [], completed);
    }
  }
});

test("context, hover, and signature help select the compact command and its slots", () => {
  const document = createLanguageDocument(
    "file:///main.tease",
    'let answer = askText "Type here"\nexit',
  );
  const start = document.text.indexOf("askText");
  const position = languagePositionAt(document, document.text.indexOf("Type"));
  assert.equal(languageContextHelp(document, position)?.command, "askText");
  assert.deepEqual(languageHover(document, position)?.range, {
    start: languagePositionAt(document, start),
    end: languagePositionAt(document, start + "askText".length),
  });
  const signature = languageSignatureHelp(document, position);
  assert.deepEqual(signature?.parameters, ["speaker", "question", "prefill", "hint"]);
  assert.equal(signature?.activeParameter, 1);
});

test("a conversion call has help from its contract, also while it is being written", () => {
  // The help at the end of `source`: its command, the signature's label, and its active parameter.
  const help = (source: string, after = "") => {
    const document = createLanguageDocument("file:///main.tease", source + after);
    const position = languagePositionAt(document, source.length);
    const signature = languageSignatureHelp(document, position);
    return [
      languageContextHelp(document, position)?.command ?? null,
      signature?.label ?? null,
      signature === null ? null : (signature.parameters[signature.activeParameter] ?? null),
    ];
  };
  for (const name of CONVERSION_FUNCTIONS) {
    const document = createLanguageDocument("file:///main.tease", `say ${name}(value`);
    const position = languagePositionAt(document, document.text.length);
    const context = languageContextHelp(document, position);
    assert.deepEqual([context?.command, context?.summary], [name, CONVERSIONS[name].summary]);
    assert.deepEqual(languageHover(document, position)?.contents, [
      `**${name}**`,
      CONVERSIONS[name].summary,
      `Syntax: \`${context?.syntax}\``,
    ]);
    assert.deepEqual(languageHover(document, position)?.range, {
      start: languagePositionAt(document, 4),
      end: languagePositionAt(document, 4 + name.length),
    });
  }
  // The syntax is the call's shape (V30 §8, §13, §35), and the active parameter the argument being written.
  assert.deepEqual(help("say toNumber("), [
    "toNumber",
    "toNumber(value [, default: number])",
    "value",
  ]);
  assert.deepEqual(help("say toNumber(text, default: "), [
    "toNumber",
    "toNumber(value [, default: number])",
    "default",
  ]);
  assert.deepEqual(help("let rule = toRegex(text, ", ")\nexit"), [
    "toRegex",
    "toRegex(text, default: regex?)",
    "default",
  ]);
  assert.deepEqual(help("say fromJson(text, files: false, default: "), [
    "fromJson",
    "fromJson(text, default: value [, files: boolean])",
    "default",
  ]);
  assert.deepEqual(help("say toJson(value, "), [
    "toJson",
    "toJson(value [, files: boolean])",
    "files",
  ]);
  const dateTime =
    "toDateTime(value [, default: datetime])  or  toDateTime(date, time [, default: datetime])";
  assert.deepEqual(help("let at = toDateTime(text"), ["toDateTime", dateTime, "value"]);
  assert.deepEqual(help("let at = toDateTime(day, "), ["toDateTime", dateTime, "time"]);
  // The innermost of a command and a call has the help: a call in a say or an interpolation, an ask in a call.
  assert.deepEqual(help('say "${toBase64(text'), ["toBase64", "toBase64(text)", "text"]);
  assert.equal(help('say toString(askText "Name?')[0], "askText");
  // A method of the same name converts through the player's zone (V30 §35), and a declared name is no call.
  assert.equal(help("say stamp.toDateTime(", ").toISO()\nexit")[0], "say");
  assert.equal(help("say local.toAbsoluteDateTime(", ").toISO()\nexit")[0], "say");
  assert.equal(help("function toNumber(")[0], null);
  assert.equal(help("say toString(count) + ")[0], "say");
  assert.equal(help("sa", "y toString(count)\nexit")[0], "say");
});

test("a random function's call has help from its contract, also while it is being written", () => {
  // The help at the end of `source`: its command, the signature's label, and its active parameter.
  const help = (source: string, after = "") => {
    const document = createLanguageDocument("file:///main.tease", source + after);
    const position = languagePositionAt(document, source.length);
    const signature = languageSignatureHelp(document, position);
    return [
      languageContextHelp(document, position)?.command ?? null,
      signature?.label ?? null,
      signature === null ? null : (signature.parameters[signature.activeParameter] ?? null),
    ];
  };
  for (const name of RANDOM_FUNCTIONS) {
    const document = createLanguageDocument("file:///main.tease", `say ${name}(`);
    const position = languagePositionAt(document, document.text.length);
    const context = languageContextHelp(document, position);
    assert.deepEqual([context?.command, context?.summary], [name, RANDOM_CONTRACTS[name].summary]);
    assert.deepEqual(languageHover(document, position)?.contents, [
      `**${name}**`,
      RANDOM_CONTRACTS[name].summary,
      `Syntax: \`${context?.syntax}\``,
    ]);
  }
  // The syntax is the call's shape (V30 §4), and the active parameter the argument being written.
  assert.deepEqual(help("say random("), ["random", "random()", null]);
  assert.deepEqual(help("if chance("), ["chance", "chance(percent)", "percent"]);
  assert.deepEqual(help("let roll = randomInteger("), [
    "randomInteger",
    "randomInteger(range)",
    "range",
  ]);
  assert.deepEqual(help("let pause = randomNormal(30, "), [
    "randomNormal",
    "randomNormal(mean, spread)",
    "spread",
  ]);
  assert.deepEqual(help("let reps = round(randomPert(5, 10, "), [
    "randomPert",
    "randomPert(min, mostLikely, max)",
    "max",
  ]);
  const weighted = "randomWeighted(dict)  or  randomWeighted(list, weight: text)";
  assert.deepEqual(help("let task = randomWeighted("), ["randomWeighted", weighted, "dict"]);
  assert.deepEqual(help("let task = randomWeighted(tasks, weight: "), [
    "randomWeighted",
    weighted,
    "weight",
  ]);
  // A method of the same name, a declared name, and a property are no call of the function.
  assert.equal(help("say items.random(", ")\nexit")[0], "say");
  assert.equal(help("function chance(")[0], null);
});

test("askChoice help names set options and the prefill after the options (V30 §19)", () => {
  const source = 'let pick = askChoice hint: "Hint", set["a", "b"], prefill: "b"\nexit';
  assert.deepEqual(compileSource(source).diagnostics, []);
  const document = createLanguageDocument("file:///main.tease", source);
  const at = (text: string) => languagePositionAt(document, source.indexOf(text) + text.length);
  const hover = languageHover(document, at("askC"));
  assert.ok(hover?.contents.some((line) => /\bset\b/u.test(line)));
  assert.ok(hover?.contents.some((line) => line.includes("[, prefill: value]")));
  const slot = (text: string) => {
    const help = languageSignatureHelp(document, at(text));
    return help === null ? null : help.parameters[help.activeParameter];
  };
  // An option's value written before ':' is no named option.
  assert.equal(slot('hint: "Hi'), "options");
  assert.equal(slot('set["a'), "options");
  assert.equal(slot("prefill: "), "prefill");
});

test("formatting reaches a command inside a computed call target", () => {
  const document = createLanguageDocument(
    "file:///main.tease",
    'call script(askText   "Room?")\nexit',
  );
  assert.equal(formatLanguageDocument(document).text, 'call script(askText "Room?")\nexit');
});

test("formatting a say leaves its regex literals as written, also in a nested say", () => {
  // The parse finds a regex after a message mode; lexing the say alone would take its slashes for division.
  const source = [
    "speaker vera {}",
    "say   as   vera /a ,b/",
    "say   prose() /c ,d/",
    "say (say   prose() /e ,f/).text",
    'say "${(say prose() /g ,h/).text}"',
    "exit",
  ].join("\n");
  assert.equal(
    formatLanguageDocument(createLanguageDocument("file:///main.tease", source)).text,
    source.replaceAll("   ", " "),
  );
});

test("formatting spaces an ask's question mode and reaches the asks inside its options", () => {
  const document = createLanguageDocument(
    "file:///main.tease",
    'let name = askText   prose(font: askText   "Font?")   "Name?"\nlet pic = askImage prose(font: askText   "Font?") ("Image?")\nexit',
  );
  assert.equal(
    formatLanguageDocument(document).text,
    'let name = askText prose(font: askText "Font?") "Name?"\nlet pic = askImage prose(font: askText "Font?") ("Image?")\nexit',
  );
});

test("editor help and formatting cover showButton used as a value with a timeout", () => {
  const source = 'let elapsed = showButton   as   mistress "Go", timeout: 5 s';
  const document = createLanguageDocument(
    "file:///main.tease",
    `speaker mistress { name: "Mistress" }\n${source}\nexit`,
  );
  const start = document.text.indexOf("showButton");
  const hover = languageHover(document, languagePositionAt(document, document.text.indexOf("5")));
  assert.deepEqual(hover?.range, {
    start: languagePositionAt(document, start),
    end: languagePositionAt(document, start + "showButton".length),
  });
  assert.ok(hover?.contents.some((line) => line.includes("timeout: duration")));
  assert.match(
    formatLanguageDocument(document).text,
    /let elapsed = showButton as mistress "Go", timeout: 5/u,
  );
});

test("formatting and help reach a say used as a value, which keeps its parentheses where they are written", () => {
  const document = createLanguageDocument(
    "file:///main.tease",
    'let line = say   "Waiting."  ,instant\nlet lines = [say("A" ,instant), say   ("B")]\nexit',
  );
  assert.equal(
    formatLanguageDocument(document).text,
    'let line = say "Waiting.", instant\nlet lines = [say("A", instant), say ("B")]\nexit',
  );
  const hover = languageHover(document, languagePositionAt(document, document.text.indexOf('"A"')));
  assert.ok(hover?.contents.some((line) => line.includes("messageHandle")));
});

test("formatting and help reach a command in a named timer's label and display and in an askChoice's parts", () => {
  // The parts come from the shared order helpers: a named timer's label may come first, and an askChoice's prefill
  // follows its options.
  const source = [
    'let t = timer(label: askText   "Label?", duration: 5 s, display: askText   "Display?", async: true)',
    'let c = askChoice yes: askText   "Yes?", no: "No", prefill: askText   "Which?"',
    "exit",
  ].join("\n");
  const document = createLanguageDocument("file:///main.tease", source);
  assert.equal(formatLanguageDocument(document).text, source.replaceAll("   ", " "));
  for (const question of ['"Label?"', '"Display?"', '"Yes?"', '"Which?"']) {
    const offset = source.indexOf(question);
    const command = source.lastIndexOf("askText", offset);
    assert.deepEqual(
      languageHover(document, languagePositionAt(document, offset + 1))?.range,
      {
        start: languagePositionAt(document, command),
        end: languagePositionAt(document, command + "askText".length),
      },
      question,
    );
  }
});

const DEEP_SAY = 'say   "deep"  ,instant';

/** The deepest `say` has irregular owned whitespace, so formatting that stops descending leaves it unchanged. */
function assertDeepSayTooling(source: string): void {
  assert.notEqual(compileSource(source).plan, null);
  const document = createLanguageDocument("file:///main.tease", source);
  const start = source.indexOf(DEEP_SAY);
  const formatted = formatLanguageDocument(document);
  assert.equal(formatted.text, source.replace(DEEP_SAY, 'say "deep", instant'));
  assert.notEqual(formatted.edits.length, 0);
  for (const edit of formatted.edits) {
    assert.ok(edit.range.start.offset > start && edit.range.end.offset < start + DEEP_SAY.length);
  }
  const say = classifyTokens(source).find((token) => token.span.start.offset === start);
  assert.equal(say?.kind, "keyword");
  const hover = languageHover(document, languagePositionAt(document, start + 1));
  assert.deepEqual(hover?.range, {
    start: languagePositionAt(document, start),
    end: languagePositionAt(document, start + "say".length),
  });
  const topLevel = createLanguageDocument("file:///top.tease", 'say "top"\nexit');
  assert.deepEqual(
    hover?.contents,
    languageHover(topLevel, languagePositionAt(topLevel, 1))?.contents,
  );
}

test("hover and formatting handle deeply nested source inside a timer expiry block", () => {
  const depth = 4_000;
  assertDeepSayTooling(
    `timer async 1 s {\n${"if true {\n".repeat(depth)}${DEEP_SAY}\n${"}\n".repeat(depth)}}\nexit\n`,
  );
});

test("formatter normalizes compact owned whitespace and is idempotent", () => {
  const source = [
    'speaker mistress { name: "Mistress" }',
    'showButton   as   mistress   "Continue"',
    'let answer = askText   as   mistress   "Type here"',
    'let result = askChoice   first :   "A"  ,\n   second  : "B"',
    'say as mistress skippable   "Good",   instant',
    "exit",
  ].join("\n");
  const document = createLanguageDocument("file:///main.tease", source);
  const first = formatLanguageDocument(document);
  assert.match(first.text, /showButton as mistress "Continue"/u);
  assert.match(first.text, /askText as mistress "Type here"/u);
  assert.match(first.text, /askChoice first: "A", second: "B"/u);
  assert.match(first.text, /"Good", instant/u);
  const second = formatLanguageDocument(createLanguageDocument(document.uri, first.text));
  assert.equal(second.text, first.text);
  assert.equal(second.edits.length, 0);
});

test("formatter preserves strings, escapes, interpolation, comments, and choice order", () => {
  const source = [
    "// keep  comment spacing",
    'let prefix = "x  y"',
    'let result = askChoice   first :   "A  ${prefix}"  ,   second  :  "B\\n  C"',
    "exit",
  ].join("\n");
  const result = formatLanguageDocument(createLanguageDocument("file:///main.tease", source));
  assert.notEqual(result.edits.length, 0);
  const formatted = result.text;
  assert.ok(formatted.includes("// keep  comment spacing"));
  assert.ok(formatted.includes('"x  y"'));
  assert.ok(formatted.includes('askChoice first: "A  ${prefix}", second: "B\\n  C"'));
  assert.ok(formatted.indexOf("first:") < formatted.indexOf("second:"));
});

test("formatter preserves block-string values and is idempotent", () => {
  const source = 'say   """\r\n\tFirst\r\n\t  Second ${1 + 1}\r\n\t""",   instant\nexit';
  const document = createLanguageDocument("file:///block.tease", source);
  const first = formatLanguageDocument(document);
  const second = formatLanguageDocument(createLanguageDocument(document.uri, first.text));
  assert.equal(second.text, first.text);
  assert.equal(second.edits.length, 0);

  for (const candidate of [source, first.text]) {
    const compiled = compileSource(candidate);
    assert.deepEqual(compiled.diagnostics, []);
    assert.notEqual(compiled.plan, null);
    const execution = run(compiled.plan!, createFreshRuntimeSnapshot(compiled.plan!));
    assert.equal(execution.events.find((event) => event.kind === "say")?.text, "First\n  Second 2");
  }
});

test("formatter leaves malformed and incomplete source untouched", () => {
  for (const source of [
    "showButton",
    "let x = askChoice",
    'let x = askChoice "A",',
    "let x = askText as",
  ]) {
    const result = formatLanguageDocument(createLanguageDocument("file:///main.tease", source));
    assert.equal(result.text, source);
    assert.equal(result.edits.length, 0);
  }
});

test("signature help ignores punctuation inside say strings and tracks grammar slots", () => {
  // Compare slot names, not positions, so adding an accepted slot to a signature does not shift the expectations.
  // `after` follows the cursor.
  const activeSlot = (source: string, after = "") => {
    const document = createLanguageDocument("file:///main.tease", source + after);
    const help = languageSignatureHelp(document, languagePositionAt(document, source.length));
    return help === null ? null : help.parameters[help.activeParameter];
  };
  assert.equal(activeSlot('say "Hello, there"'), "text");
  assert.equal(activeSlot('say "Hello, there",'), "pacing");
  assert.equal(activeSlot("say as narrator"), "speaker");
  assert.equal(activeSlot("say as narrator "), "text");
  assert.equal(activeSlot("say skippable"), "skip policy");
  assert.equal(activeSlot("say skippable "), "text");
  assert.equal(activeSlot("say unskippable "), "text");
  assert.equal(activeSlot("askText as mistress"), "speaker");
  assert.equal(activeSlot("askText as mistress "), "question");
  assert.equal(activeSlot("askNumber as mistress "), "question");
  assert.equal(activeSlot('askText "Name?", prefill: '), "prefill");
  assert.equal(activeSlot("askNumber prefill: "), "prefill");
  assert.equal(activeSlot('askInteger "How many?", prefill: '), "prefill");
  assert.equal(activeSlot('askDateTime "When?", prefill: '), "prefill");
  assert.equal(activeSlot('askText "Name?", hint: '), "hint");
  // A parenthesized ask's own parentheses hold its arguments.
  assert.equal(activeSlot('askText("Q", prefill: '), "prefill");
  assert.equal(activeSlot('askText("Q", hint: '), "hint");
  assert.equal(activeSlot('askText as mistress ("Q", prefill: '), "prefill");
  // So do the parentheses after the question's mode and its own parentheses.
  assert.equal(activeSlot('askText prose() ("Q", prefill: '), "prefill");
  assert.equal(activeSlot('askText as mistress prose(align: "left") ("Q", hint: '), "hint");
  assert.equal(activeSlot('let more = askText prose() ("Q") + '), null);
  assert.equal(activeSlot('askText prose "Q", hint: '), "hint");
  assert.equal(activeSlot('askText("Q"'), "question");
  assert.equal(activeSlot('askText("Q", prefill: pick(hint: 1'), "prefill");
  assert.equal(activeSlot('say "${askText("Q", hint: '), "hint");
  // Its `)` ends it, so what follows belongs to the enclosing construct, if any.
  assert.equal(activeSlot('let more = askInteger("How many?", prefill: 3) + '), null);
  assert.equal(activeSlot('let more = askInteger as mistress ("How many?") + '), null);
  assert.equal(activeSlot('askText("Q", prefill: askText("Default") + '), "prefill");
  assert.equal(activeSlot('say askText("Q") + '), "text");
  // Before its `)`, as an editor that closes brackets leaves the cursor, the ask is still open.
  assert.equal(activeSlot("askText(", ")"), "question");
  assert.equal(activeSlot('askText("Q", hint: ', ")"), "hint");
  assert.equal(activeSlot('askText("Q", prefill: askText(', "))"), "question");
  assert.equal(activeSlot('askText("Q", prefill: askText("D"', "))"), "question");
  assert.equal(activeSlot('askText("Q", prefill: askText("D")', ")"), "prefill");
  assert.equal(activeSlot('askInteger "How many?", hint: "1 to 10", prefill: '), "prefill");
  assert.equal(activeSlot('askText { default: "Name?" }.default'), "question");
  assert.equal(activeSlot('let answer = askText "${askNumber prefill: 3}"'), "question");
  assert.equal(activeSlot("showButton as mistress "), "label");
  assert.equal(activeSlot('showButton "Go", timeout: '), "timeout");
  assert.equal(
    activeSlot('let elapsed = showButton "Go", background: "gold", timeout: 5 s'),
    "timeout",
  );
  assert.equal(activeSlot('showButton "Go", timeout: 5 s, background: '), "background");
  assert.equal(activeSlot('let e = { x: (showButton "A"), timeout: 3 s'), null);
  assert.equal(
    activeSlot('showButton "A", timeout: (askNumber "Seconds"), background: '),
    "background",
  );
  assert.equal(activeSlot("askChoice as mistress "), "options");
  assert.equal(activeSlot('say ["Hello", "there"]'), "text");
});

test("editor help reads only the statement the parser finds at the cursor", () => {
  // The signature slot and the context help's command; hover finds the command as context help does. `after` follows
  // the cursor.
  const help = (source: string, after = "") => {
    const document = createLanguageDocument("file:///main.tease", source + after);
    const position = languagePositionAt(document, source.length);
    const signature = languageSignatureHelp(document, position);
    const hover = languageHover(document, position);
    assert.equal(
      hover?.contents[0] ?? null,
      signature === null ? null : `**${signature.label.split(" ")[0]}**`,
    );
    return [
      signature === null ? null : signature.parameters[signature.activeParameter],
      languageContextHelp(document, position)?.command ?? null,
    ];
  };
  const ask = 'let answer = askText "Q", hint: 1';
  // A later statement, or a line between statements, is not part of an earlier command.
  assert.deepEqual(help(`${ask}\nlet y = `), [null, null]);
  assert.deepEqual(help(`${ask}\n`), [null, null]);
  assert.deepEqual(help(`if true {\n  ${ask}\n  let y = `, "\n}"), [null, null]);
  assert.deepEqual(help(`timer 5 s {\n  ${ask}\n  `, "\n}"), [null, null]);
  assert.deepEqual(help('let answer = askText "Q", hint:\nlet y = '), [null, null]);
  // The rest of the command's line, and every line the command continues on, keep its help.
  assert.deepEqual(help(`${ask} `), ["hint", "askText"]);
  assert.deepEqual(help('let answer = askText "Q", hint: (\n"a"\n) + '), ["hint", "askText"]);
  assert.deepEqual(help('let answer = askText "Q", hint: [\n"a"\n][0] + '), ["hint", "askText"]);
  assert.deepEqual(help('let answer = askText("Q"\n, prefill: "A"\n, hint: '), ["hint", "askText"]);
  assert.deepEqual(help("let answer = askText {\ntext: "), ["question", "askText"]);
  assert.deepEqual(
    help(
      'speaker narrator { alias: "A" }\nlet answer = askText as narrator "Q", hint: (\n speaker.alias + ',
      ")",
    ),
    ["hint", "askText"],
  );
  // An unfinished command also holds the line breaks after it, where the author completes it.
  assert.deepEqual(help('let answer = askText "Q",\n  ', "\nexit"), ["question", "askText"]);
  assert.deepEqual(help('let answer = askText "Q", hint:\n  ', "\nexit"), ["hint", "askText"]);
  assert.deepEqual(help('let pick = askChoice [\n  "a",\n  '), ["options", "askChoice"]);
});

/** Each token and comment of `source` with its class, as `text:class`. */
function tokenClasses(source: string): readonly string[] {
  return classifyTokens(source).map(
    ({ kind, span }) => `${source.slice(span.start.offset, span.end.offset)}:${kind}`,
  );
}

test("token classes are the compiler's reading of numbers, names, comments, and regexes", () => {
  // A hyphen subtracts (V30 §38), and a number may start with its dot or have an exponent.
  assert.deepEqual(tokenClasses("let n = x-1 + 1e3 * .5"), [
    "let:keyword",
    "n:name",
    "=:operator",
    "x:name",
    "-:operator",
    "1:number",
    "+:operator",
    "1e3:number",
    "*:operator",
    ".5:number",
  ]);
  // A block comment is one comment, also over several lines, and the code in it is no code.
  assert.deepEqual(tokenClasses('/* say "x"\n*/ exit // done'), [
    '/* say "x"\n*/:comment',
    "exit:keyword",
    "// done:comment",
  ]);
  // After a message mode the parser expects a value, so the slash starts a regex (V30 §8), also one whose class holds
  // what starts a comment elsewhere; a comment stays one right after an operator and before a division.
  assert.deepEqual(tokenClasses("say prose /[a-z]+/\nsay prose /[/*]/"), [
    "say:keyword",
    "prose:keyword",
    "/[a-z]+/:regex",
    "say:keyword",
    "prose:keyword",
    "/[/*]/:regex",
  ]);
  assert.deepEqual(tokenClasses("let x = /* c */ 6\nsay x /* c */ / 2"), [
    "let:keyword",
    "x:name",
    "=:operator",
    "/* c */:comment",
    "6:number",
    "say:keyword",
    "x:name",
    "/* c */:comment",
    "/:operator",
    "2:number",
  ]);
});

test("token classes take keywords, types, and commands from the language facts", () => {
  // Every grammar keyword (V30 §38), also the literals and the logical operators.
  assert.deepEqual(tokenClasses("if true and not null { break }"), [
    "if:keyword",
    "true:keyword",
    "and:keyword",
    "not:keyword",
    "null:keyword",
    "{:punctuation",
    "break:keyword",
    "}:punctuation",
  ]);
  // The words that the parser reads as commands or asks are commands; a built-in function, constant, or engine
  // reference has no colour of its own, so it is a name.
  assert.deepEqual(
    tokenClasses('let c = askChoice yes: "Yes"\nshowButton "Go"\nlet r = round(player.age * pi)'),
    [
      "let:keyword",
      "c:name",
      "=:operator",
      "askChoice:command",
      "yes:name",
      "::punctuation",
      '":string',
      "Yes:string",
      '":string',
      "showButton:command",
      '":string',
      "Go:string",
      '":string',
      "let:keyword",
      "r:name",
      "=:operator",
      "round:name",
      "(:punctuation",
      "player:name",
      ".:punctuation",
      "age:name",
      "*:operator",
      "pi:name",
      "):punctuation",
    ],
  );
  // So is every command and ask, and every built-in function that is no type name.
  const typeNames: readonly string[] = TEASESCRIPT_PROTECTED_TYPE_NAMES;
  for (const name of engineCommands) assert.deepEqual(tokenClasses(name), [`${name}:command`]);
  for (const name of CORE_RUNTIME_BUILTINS)
    if (!typeNames.includes(name)) assert.deepEqual(tokenClasses(name), [`${name}:name`]);
  assert.deepEqual(tokenClasses("let turn: angle = 90 deg"), [
    "let:keyword",
    "turn:name",
    "::punctuation",
    "angle:type",
    "=:operator",
    "90:number",
    "deg:name",
  ]);
});

test("token classes follow the parse where a word means something else", () => {
  // In a written type, `set` and `timer` are types; a function, a unit, also after a wait's length, and a property are
  // names.
  const source = [
    'let s: string set = set["a"]',
    "let t: timer? = null",
    "let m = min(1, 2)",
    "wait 2 min",
    "wait m min",
    "say [1, 2].random",
  ].join("\n");
  assert.deepEqual(compileSource(`${source}\nexit`).diagnostics, []);
  assert.deepEqual(
    tokenClasses(source).filter((token) => /^(set|timer|min|random):/u.test(token)),
    ["set:type", "set:keyword", "timer:type", "min:name", "min:name", "min:name", "random:name"],
  );
  // A keyword after `.` names a property too.
  assert.deepEqual(compileSource("say {set: 1}.set\nexit").diagnostics, []);
  assert.equal(tokenClasses("say {set: 1}.set").at(-1), "set:name");
});

test("token classes take a message mode, a skip word, and instant from the parse", () => {
  // They are keywords where the parse reads them as a say's or a question's mode, a skip word, or the pacing, and
  // names where they are values.
  const source = [
    'say prose(align: "center") skippable "x", instant',
    'let line = say bubble unskippable ("y", instant)',
    'let name = askText prose "Name?"',
    'let pic = askImage bubble ("Image?")',
    "let prose = 3",
    'let skippable = "s"',
    "let instant = 2 s",
    "say prose",
    "say skippable, instant + 1 s",
  ].join("\n");
  assert.deepEqual(compileSource(`${source}\nexit`).diagnostics, []);
  assert.deepEqual(
    tokenClasses(source).filter((token) =>
      /^(prose|bubble|skippable|unskippable|instant):/u.test(token),
    ),
    [
      "prose:keyword",
      "skippable:keyword",
      "instant:keyword",
      "bubble:keyword",
      "unskippable:keyword",
      "instant:keyword",
      "prose:keyword",
      "bubble:keyword",
      "prose:name",
      "skippable:name",
      "instant:name",
      "prose:name",
      "skippable:name",
      "instant:name",
    ],
  );
});

test("token classes make a key or a label in name: a name, also a protected word", () => {
  const source = [
    'let o = { min: 1, set: 2, string: "s" }',
    "let d = dict{ max: 3 }",
    'let m = max(o.min, d.get("cap", default: 0))',
    'let n = load("count", default: 0)',
    'let c = load "count", default: 0',
    "switch m {",
    '  case 1 { say "one" }',
    '  default { say "other" }',
    "}",
  ].join("\n");
  assert.deepEqual(compileSource(`${source}\nexit`).diagnostics, []);
  assert.deepEqual(
    tokenClasses(source).filter((token) => /^(min|set|string|max|default):/u.test(token)),
    [
      "min:name",
      "set:name",
      "string:name",
      "max:name",
      "max:name",
      "min:name",
      "default:name",
      "default:name",
      "default:name",
      "default:keyword",
    ],
  );
});

test("token classes keep a string's text, its interpolations, and their code apart", () => {
  assert.deepEqual(tokenClasses('say "Hi ${name}!"'), [
    "say:keyword",
    '":string',
    "Hi :string",
    "${:interpolation",
    "name:name",
    "}:interpolation",
    "!:string",
    '":string',
  ]);
});

test("a problem the lexer reports leaves every other token its class", () => {
  // An invalid character, and a regex without its closing slash, which ends with its line.
  const source = 'let a = @ + 1\nlet r = /a(b\nshowButton "Go"';
  assert.ok(compileSource(source).diagnostics.some(({ code }) => code === "TSL001"));
  assert.deepEqual(tokenClasses(source), [
    "let:keyword",
    "a:name",
    "=:operator",
    "+:operator",
    "1:number",
    "let:keyword",
    "r:name",
    "=:operator",
    "/a(b:regex",
    "showButton:command",
    '":string',
    "Go:string",
    '":string',
  ]);
});

test("editor tooling handles deeply nested media blocks without native recursion", () => {
  const depth = 2_500;
  assertDeepSayTooling(
    `${'playAudio async "a" {\n'.repeat(depth)}${DEEP_SAY}\n${"}\n".repeat(depth)}exit\n`,
  );
});
