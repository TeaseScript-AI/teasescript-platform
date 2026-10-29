// #1105; Astra review.
export const cases = (() => {
  const cases = [];
  function add(name, source, expect = "quiet", runtime = true) {
    cases.push({ name, source: source + "\nexit\n", expect, runtime });
  }
  const specs = [
    ["toNumber", "7,25", "  +7.25e1  "],
    ["toInteger", "0x10", " -8.75 "],
    ["toBoolean", "TRUE", " false "],
    ["toDate", "2100-02-29", "2000-02-29"],
    ["toTime", "23:59:60", "23:59:59.125"],
    ["toDateTime", "2028-04-31T23:59", "2028-04-30T23:59"],
    ["toAbsoluteDateTime", "2028-04-30T23:59", "2028-04-30T23:59:59+02:30"],
  ];
  for (const [fn, bad, good] of specs) {
    const q = JSON.stringify;
    const fallback = { toNumber: "0.0", toInteger: "0", toBoolean: "false" }[fn] ?? "hostValue";
    const call = (arg, def = true) =>
      `let result = ${fn}(${arg}${def ? ", default: " + fallback : ""})\nsay "done"`;
    for (const def of [true, false]) {
      const tag = `${fn}/${def ? "default" : "plain"}`;
      add(tag + "/literal", call(q(bad), def), "error", false);
      add(
        tag + "/copies",
        `let seed = ${q(bad)}\nlet next = seed\nlet last = next\n${call("last", def)}`,
        "error",
        false,
      );
      add(
        tag + "/valid-copies",
        `let seed = ${q(good)}\nlet next = seed\nlet last = next\n${call("last", def)}`,
      );
    }
    add(
      fn + "/typed-parentheses",
      `let text: string = ${q(bad)}\n${call("(text)")}`,
      "error",
      false,
    );
    add(
      fn + "/two-step",
      `let prefix = ${q(bad.slice(0, -1))}\nlet text = prefix + ${q(bad.slice(-1))}\n${call("text")}`,
      "error",
      false,
    );
    add(fn + "/interpolation", `let text = ${q(bad)}\n${call('"${text}"')}`, "deferred", false);
    add(
      fn + "/loop-invariant",
      `let seed = ${q(bad)}\nrepeat 2 {\nlet text = seed\n${call("text")}\n}`,
      "error",
      false,
    );
    add(
      fn + "/loop-written",
      `let text = ${q(good)}\nrepeat 2 { text = ${q(bad)} }\n${call("text")}`,
    );
    add(
      fn + "/loop-built",
      `let text = ${q(bad.slice(0, -1))}\nrepeat 1 { text = text + ${q(bad.slice(-1))} }\n${call("text")}`,
    );
    add(
      fn + "/branch-merged",
      `let text = ${q(bad)}\nif load("flag", default: false) { text = ${q(bad)} }\n${call("text")}`,
    );
    add(fn + "/reassigned-valid", `let text = ${q(bad)}\ntext = ${q(good)}\n${call("text")}`);
    add(fn + "/assigned-after", `let text = ${q(bad)}\n${call("text")}\ntext = ${q(good)}`);
    add(fn + "/dead", `let text = ${q(bad)}\nif false {\n${call("text")}\n}`, "error", false);
    add(fn + "/loaded", `let text = load("input", default: ${q(bad)})\n${call("text")}`);
    add(
      fn + "/host-fallback",
      `let text = ${q(bad)}\nlet result = ${fn}(text, default: hostValue)`,
      "error",
      false,
    );
    add(
      fn + "/host-fallback-unused",
      `let text = ${q(good)}\nlet result = ${fn}(text, default: hostValue)\nsay "done"`,
    );
    add(
      fn + "/parameter",
      `function convert(text) {\nreturn ${fn}(text, default: ${fallback})\n}\nlet result = convert(${q(bad)})\nsay "done"`,
      "deferred",
    );
  }
  add("number/accepted", "let amount = -6.75\nlet copy = amount\nsay toInteger(copy, default: 0)");
  add(
    "boolean/accepted",
    "let answer = false\nlet copy = answer\nsay toBoolean(copy, default: false)",
  );
  add(
    "number/boolean-C13",
    "let amount = 1\nsay toBoolean(amount, default: false)",
    "deferred",
    false,
  );
  add(
    "boolean/number-C13",
    "let answer = true\nsay toNumber(answer, default: 0.0)",
    "deferred",
    false,
  );
  add(
    "duration/number-C13",
    "let elapsed = 2 s\nsay toNumber(elapsed, default: 0.0)",
    "deferred",
    false,
  );
  add(
    "datetime/pair-C13",
    'let datePart = toDate("2028-04-30")\nlet timePart = toTime("23:59")\nlet value = toDateTime(datePart, timePart)\nsay "done"',
    "deferred",
  );
  for (const [fn, text] of [
    ["toRegex", "[a"],
    ["fromJson", "{broken"],
    ["fromBase64", "!"],
    ["fileFromBase64", "!"],
  ])
    add(
      fn + "/fallback",
      `let seed = ${JSON.stringify(text)}\nlet copy = seed\nlet result = ${fn}(copy, default: null)\nsay result`,
    );
  for (const fn of ["toString", "toJson", "toBase64"])
    add(
      fn + "/text",
      `let text = "not convertible"\nsay ${fn}(text${fn === "toJson" ? ", files: false" : ""})`,
    );
  add(
    "nested-json/invalid",
    'let parsed = fromJson("\\\"bad\\\"", default: "fallback", files: false)\nsay toNumber(parsed, default: 0.0)',
    "error",
    false,
  );
  add(
    "nested-json/repaired-valid",
    'let parsed = fromJson("\\\"bad\\\"", default: 9, files: false)\nsay toNumber(parsed, default: 0.0)',
  );
  add(
    "nested-json/repaired-invalid",
    'let parsed = fromJson("12", default: "bad", files: false)\nsay toNumber(parsed, default: 0.0)',
    "error",
    false,
  );
  add(
    "nested-json/typed",
    'let parsed: string = fromJson("12", default: "bad", files: false)\nsay toInteger(parsed, default: 0)',
    "error",
    false,
  );
  add(
    "otherwise/known-invalid",
    'let text = null otherwise "bad"\nsay toInteger(text, default: 0)',
    "error",
    false,
  );
  add("otherwise/valid", 'let text = "14" otherwise "bad"\nsay toInteger(text, default: 0)');
  add("count/invalid", "let seed = -1\nlet rounds = seed\nrepeat rounds {}", "count", false);
  add(
    "count/valid",
    'let text = "2"\nlet rounds = toInteger(text, default: 1)\nrepeat rounds { say "loop" }',
  );
  add("default/wrong", 'say toInteger("bad", default: "wrong")', "error", false);
  add(
    "c10/selected",
    'let n = toInteger(load("t", default: "bad"), default: hostValue)\nsay "done"',
    "quiet",
    false,
  );
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
