// S6c's review (Astra): six of the repository's spread regressions at 30,000 (`SPREAD_CASES` of
// tests/helpers/type-core-spreads.ts at 8a7e4de1d), each changed by the review so the width route does not match an
// expected tuple: `"A"` to `"Review"`, `text: 1` to `text: 2`, `root` to `recordRoot`
// (R/astra-m4-s6c-review-evidence/native.mjs). The programs the review derived are kept; the helper's are not copied.
const many = (size, text, separator) => Array.from({ length: size }, () => text).join(separator);
const SPREADS = {
  guards: (size) =>
    [
      "let root = {a: 1, b: 1, n: [1, hostValue][1]}",
      `let ok = root.a is integer and ${many(size, "root.b is integer", " and ")} and true`,
      "let box = root",
      "repeat box.n {}",
      "exit",
    ].join("\n"),
  solver: (size) =>
    [
      'let flagHost = askBoolean "flag"',
      "let out = outer().length",
      'function outer: string | integer { if flagHost { return "ok" }\nreturn get0().length }',
      ...Array.from(
        { length: size },
        (_, i) =>
          `function get${i}${i === 0 ? ": object | string | integer" : ""} {\n${
            i === 0 ? "  if flagHost { return {length: outer()} }\n" : ""
          }  return ${i + 1 < size ? `get${i + 1}()` : "get0().length"}\n}`,
      ),
      "exit",
    ].join("\n"),
  records: (size) => `let picked: integer = askChoice [${many(size, "{text: 1}", ",")}]\nexit`,
  property: (size) =>
    [
      `let choice = {text: "A", value: [${many(size, "1 + 0", ",")}]}`,
      "let picked: integer = (askChoice choice).first",
      "exit",
    ].join("\n"),
  choiceClass: (size) =>
    `let result: string = askChoice {text: "outer", value: (askChoice ${many(size, '"A"', ", ")})}\nexit`,
  operationClass: (size) =>
    `let result: integer = askChoice {text: "outer", value: (max(${many(size, "1", ", ")}))}\nexit`,
};
const review = (source) =>
  source.replaceAll('"A"', '"Review"').replaceAll("text: 1", "text: 2").replace(/\broot\b/g, "recordRoot");
export const cases = Object.entries(SPREADS).map(([name, spread]) => [`${name}/30000`, review(spread(30000))]);

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node native.mjs wt guards 30000",
      "R/astra-m4-s6c-review-evidence/native-guards-clean.jsonl:1"
    ],
    [
      "node native.mjs wt solver 30000",
      "R/astra-m4-s6c-review-evidence/native-solver-clean.jsonl:1"
    ],
    [
      "node native.mjs wt records 30000",
      "R/astra-m4-s6c-review-evidence/native-records-clean.jsonl:1"
    ],
    [
      "node native.mjs wt property 30000",
      "R/astra-m4-s6c-review-evidence/native-property-clean.jsonl:1"
    ],
    [
      "node native.mjs wt choiceClass 30000",
      "R/astra-m4-s6c-review-evidence/native-choiceClass-clean.jsonl:1"
    ],
    [
      "node native.mjs wt operationClass 30000",
      "R/astra-m4-s6c-review-evidence/native-operationClass-clean.jsonl:1"
    ]
  ],
  "sources": 6,
  "sha256": "646203a298cb52bde850af4c870d2940a1ea4c182a538fd1e84e989c357df2b7"
};
