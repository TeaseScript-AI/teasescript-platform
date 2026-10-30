// nested, nestedFinal and related fixed cases; #1240, Astra review, round unrecorded
// (R/astra-m4-i1240-review/control.mjs).
export const cases = (() => {
  const sources = {
    nested: 'let a = {first: {n: 1}}\na.first.n = "bad"\nsay a.first.n\nexit\n',
    nestedFinal:
      'let a = {first: {last: {random: 1}}}\na.first.last.random = "bad"\nsay a.first.last.random\nexit\n',
    typedListFixed: "let xs = [1]\nlet ys: integer[] = xs + [2]\nsay ys\nexit\n",
    dateFixed: 'let day: date = toDate("2026-10-28")\nsay day\nexit\n',
    dictFixed: 'let d = dict{a: 1}\nd["b"] = 2\nsay d["b"]\nexit\n',
    substringFixed: 'let t = "hello"\nsay t.substring(0, 2)\nexit\n',
  };
  return Object.entries(sources);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node control.mjs (no command recorded: its run without arguments)",
      "R/astra-m4-i1240-review/control.mjs",
    ],
  ],
  sources: 6,
  sha256: "0fe8f82f463edef9ff2c93173e3129dc5d257aa8cc302db036950a367b48bdbd",
};
