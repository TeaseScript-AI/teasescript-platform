// #1105; Sol review.
export const cases = (() => {
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
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
