const corpus = (() => {
  const cases = [];
  const literalGroups = [
    ["null", "integer | null", ["(null)"]],
    ["integer", "number | string | null", ["8", "(8.0)", "-0"]],
    ["number", "number | string | null", ["3.75", "(-3.75)"]],
    ["string", "string | null", ['"orchid"', '("orchid")']],
    ["boolean", "boolean | null", ["false", "((true))"]],
    ["duration", "duration | null", ["3 min", "180 s", "-250 ms"]],
    ["calendarDuration", "calendarDuration | null", ["2 calendar years", "24 calendar months"]],
    ["angle", "angle | null", ["180 deg", "3.141592653589793 rad", "-0 deg", "0 rad"]],
  ];
  for (const [kind, type, literals] of literalGroups)
    for (const literal of literals) {
      cases.push({
        name: `case-${literal}`,
        source: `let sample: ${type} = load("review.case", default: null)\nswitch sample { case ${literal} { say sample } default { say "other" } }\nexit\n`,
        marker: "say sample",
        delta: 4,
        kind,
        expected:
          kind === "null"
            ? { kind: "null" }
            : { kind: "is", kinds: [kind], ...(kind === "number" ? { fractional: true } : {}) },
      });
    }
  for (const literal of ["3..=6", "is integer", "false, true"])
    cases.push({
      name: `refused-${literal}`,
      source: `let needle = 4\nlet sample: integer | boolean | null = load("review.refused", default: null)\nswitch sample { case ${literal} { say sample } default { say 0 } }\nexit\n`,
      marker: "say sample",
      delta: 4,
      expected: null,
    });
  const prefix =
    'let takeAlternate = askBoolean "take alternate?"\nlet payload: integer | string | boolean | null = 7\n';
  const fallbacks = [
    ["parenthesized-left", "(null) otherwise null", "null", true],
    ["string-right", 'null otherwise "cobalt"', "string", true],
    ["boolean-right", "null otherwise false", "boolean", true],
    ["integer-right", "null otherwise 11", "integer", true],
    ["wrong-requested-kind", "null otherwise 11", "null", false],
    ["dead-right", "11 otherwise null", "null", false],
    ["uncertified-left", "[11].get(0, default: null) otherwise null", "null", false],
  ];
  for (const [name, expression, tag, expected] of fallbacks)
    cases.push({
      name,
      source: `${prefix}if takeAlternate { payload = ${expression} }\nsay payload\nexit\n`,
      marker: "say payload",
      delta: 4,
      tag,
      witness: expected,
    });
  for (const [name, calls, expected] of [
    ["no-call", "", false],
    ["omitted", "inspect()", true],
    ["supplied", "inspect(11)", false],
    ["named", "inspect(value: 11)", false],
    ["two-sites", "inspect()\ninspect(11)", false],
  ]) {
    cases.push({
      name: `default-${name}`,
      source: `function inspect(value: integer? = (null) otherwise null) { repeat value {} }\n${calls}\nexit\n`,
      marker: "repeat value",
      delta: 7,
      tag: "null",
      witness: expected,
      dead: name === "no-call",
    });
  }
  cases.push({
    name: "not-live-right",
    source: `${prefix}if false { payload = null otherwise null }\nsay payload\nexit\n`,
    marker: "say payload",
    delta: 4,
    tag: "null",
    witness: false,
  });
  return { cases: cases.map(({ name, source }) => [name, source]) };
})();
export const cases = corpus.cases;

for (const input of [
  ["original/1/original-35", "switch hostValue { case 8 { say 1 } }\nexit\n"],
  ["original/2/original-36", "switch hostValue { case 3 min { say 1 } }\nexit\n"],
  ["original/3/original-37", "switch hostValue { case 2 calendar years { say 1 } }\nexit\n"],
  ["original/4/original-38", "switch hostValue { case 180 deg { say 1 } }\nexit\n"],
  ["original/5/original-39", "switch hostValue { case -0 deg { say 1 } }\nexit\n"],
])
  cases.push(input);

export const checks = ["publication"];
