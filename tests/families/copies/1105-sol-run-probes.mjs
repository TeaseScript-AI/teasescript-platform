const corpus = (() => {
  const cases = [];
  const add = (group, name, source) =>
    cases.push({ family: group, name, source: source + "\nexit\n" });
  for (const [name, text, fallback] of [
    ["toNumber", "12a", "0.5"],
    ["toInteger", "12a", "0"],
    ["toBoolean", "True", "false"],
    ["toDate", "2026-02-30", 'toDate("2026-01-01")'],
    ["toTime", "25:61", 'toTime("12:30")'],
    ["toDateTime", "2026-02-30T12:30", 'toDateTime("2026-01-01T12:30")'],
    ["toAbsoluteDateTime", "2026-02-30T12:30:00Z", 'toAbsoluteDateTime("2026-01-01T12:30:00Z")'],
  ]) {
    for (const defaulted of [false, true]) {
      const suffix = defaulted ? `, default: ${fallback}` : "";
      for (const [form, prefix, operand] of [
        ["literal", "", JSON.stringify(text)],
        ["copy", `let seed = ${JSON.stringify(text)}\nlet text = seed\n`, "text"],
        [
          "concatenation",
          "",
          `${JSON.stringify(text.slice(0, -1))} + ${JSON.stringify(text.slice(-1))}`,
        ],
      ])
        add(
          "siblings",
          `${name}-${defaulted ? "default" : "plain"}-${form}`,
          `${prefix}say ${name}(${operand}${suffix})`,
        );
    }
  }
  for (const [name, source] of [
    ["known-number", "let amount = 2.5\nlet copy = amount\nsay toInteger(copy, default: 0)"],
    ["known-boolean", "let flag = true\nlet copy = flag\nsay toBoolean(copy, default: false)"],
    ["known-duration-string", "let elapsed = 1 s\nlet copy = elapsed\nsay toString(copy)"],
    ["known-boolean-invalid", "let flag = true\nlet copy = flag\nsay toInteger(copy, default: 0)"],
    [
      "known-duration-invalid",
      "let elapsed = 1 s\nlet copy = elapsed\nsay toNumber(copy, default: 0)",
    ],
    [
      "branch-equal-constants",
      'let text = "12a"\nif load("flag", default: false) { text = "12a" }\nsay toInteger(text, default: 0)',
    ],
    ["typed-constant", 'let text: string = "12a"\nsay toInteger(text, default: 0)'],
    ["valid-prefill-concatenation", 'let answer = askText "Name?", prefill: "A" + "da"'],
    ["valid-copy", 'let seed = "12"\nlet text = seed\nsay toInteger(text, default: 0)'],
    ["regex-fallback", 'say toRegex("[", default: null)'],
    ["json-fallback", 'say fromJson("{", default: null)'],
    ["base64-fallback", 'say fromBase64("!", default: null)'],
    ["file-fallback", 'let file = fileFromBase64("!", default: null)'],
    ["toString-copy", 'let text = "12a"\nsay toString(text)'],
    ["toJson-copy", 'let text = "12a"\nsay toJson(text, files: false)'],
    ["toBase64-copy", 'let text = "12a"\nsay toBase64(text)'],
  ])
    add("siblings", name, source);
  return { cases: cases.map(({ name, source }) => [name, source]) };
})();
export const cases = corpus.cases;

for (const input of [
  ["original/1/variable", 'let text = "12a"\nsay toInteger(text, default: 0)\nexit\n'],
  [
    "original/2/two-step",
    'let first = "12"\nlet text = first + "a"\nsay toInteger(text, default: 0)\nexit\n',
  ],
  ["original/3/literal", 'say bubble(color: "transparent") "Hi"\nexit\n'],
  ["original/4/variable", 'let text = "transparent"\nsay bubble(color: text) "Hi"\nexit\n'],
  ["original/5/concatenation", 'say bubble(color: "trans" + "parent") "Hi"\nexit\n'],
  [
    "original/6/copy",
    'let seed = "transparent"\nlet text = seed\nsay bubble(color: text) "Hi"\nexit\n',
  ],
  [
    "original/7/two-step",
    'let first = "trans"\nlet text = first + "parent"\nsay bubble(color: text) "Hi"\nexit\n',
  ],
  ["original/8/literal", 'let answer = askText "Name?", prefill: "  "\nexit\n'],
  ["original/9/variable", 'let text = "  "\nlet answer = askText "Name?", prefill: text\nexit\n'],
  ["original/10/concatenation", 'let answer = askText "Name?", prefill: " " + " "\nexit\n'],
  [
    "original/11/copy",
    'let seed = "  "\nlet text = seed\nlet answer = askText "Name?", prefill: text\nexit\n',
  ],
  [
    "original/12/two-step",
    'let first = " "\nlet text = first + " "\nlet answer = askText "Name?", prefill: text\nexit\n',
  ],
  ["original/13/literal", 'say dict{ ["ab"]: 1, ab: 2 }\nexit\n'],
  ["original/14/variable", 'let text = "ab"\nsay dict{ [text]: 1, ab: 2 }\nexit\n'],
  ["original/15/concatenation", 'say dict{ ["a" + "b"]: 1, ab: 2 }\nexit\n'],
  ["original/16/copy", 'let seed = "ab"\nlet text = seed\nsay dict{ [text]: 1, ab: 2 }\nexit\n'],
  [
    "original/17/two-step",
    'let first = "a"\nlet text = first + "b"\nsay dict{ [text]: 1, ab: 2 }\nexit\n',
  ],
])
  cases.push(input);

export const checks = ["publication"];
