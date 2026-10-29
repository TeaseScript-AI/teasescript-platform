// 3a model builder.
export const cases = (() => {
  const PAIR = (guard, read) =>
    `let seed = {n: 1.5, m: 2.5}\nlet a = seed\n${guard}\nlet b = seed\nif hostFlag { b = seed }\n${read}\nexit`;
  const MARK_PAIRS = [
    // [name, source, outcome, a copy-type check on x expected]
    [
      "another contribution tested",
      PAIR("if seed.n is integer { a = seed }", "let x: integer = b.n"),
      "warning-runtime-check",
      true,
    ],
    [
      "no contribution tested",
      PAIR("if hostFlag { a = seed }", "let x: integer = b.n"),
      "compile-error",
      false,
    ],
    [
      "the untested field",
      PAIR("if seed.n is integer { a = seed }", "let x: integer = b.m"),
      "compile-error",
      false,
    ],
  ];
  return MARK_PAIRS.map(([name, source]) => [name, source]);
})();
export const checks = ["publication"];
