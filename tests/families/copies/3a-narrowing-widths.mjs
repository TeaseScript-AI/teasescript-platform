const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const NARROW = [
    [
      "one key's tests",
      (k) =>
        `let n = 1\nif hostFlag { n = null }\n${many(k, () => "if n != null { repeat n {} }")}\nexit`,
    ],
    [
      "sibling tests then reads",
      (k) =>
        `let n = 1\nif hostFlag { n = null }\n${many(k, () => "if n != null { say 1 }")}\n${many(k, () => "repeat n {}")}\nexit`,
    ],
    [
      "an and chain",
      (k) =>
        `let r = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { r = {${many(k, (i) => `f${i}: null`, ", ")}} }\nif ${many(k, (i) => `r.f${i} != null`, " and ")} and ${many(k, (i) => `r.f${i}`, " + ")} > 0 { say "ok" }\nexit`,
    ],
    [
      "an or chain read after",
      (k) =>
        `let r = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { r = {${many(k, (i) => `f${i}: null`, ", ")}} }\nif ${many(k, (i) => `r.f${i} == null`, " or ")} { exit }\n${many(k, (i) => `repeat r.f${i} {}`)}\nexit`,
    ],
    [
      "invalidations",
      (k) =>
        `let xs = [1, null]\n${many(k, (i) => `if xs[${i}] == null { exit }`)}\n${many(k, () => "xs.reverse()")}\n${many(k, (i) => `repeat xs[${i}] {}`)}\nexit`,
    ],
    // round 14 (N5): one subset of preserving stores per (location, kind set), its entries counted, never walked
    [
      "one key's preserving loops",
      (k) =>
        `let v = 1\nif hostFlag { v = null }\n${many(k, () => "if v != null { repeat 2 { repeat v {}\nv = v + 1 } }")}\nexit`,
    ],
    [
      "a loop of preserving stores",
      (k) =>
        `let v = 1\nif hostFlag { v = null }\nif v != null { repeat 2 {\n${many(k, () => "repeat v {}")}\n${many(k, () => "v = v + 1")}\n} }\nexit`,
    ],
    [
      "k scalars preserved in one loop",
      (k) =>
        `${many(k, (i) => `let v${i} = 1\nif hostFlag { v${i} = null }`)}\n${many(k, (i) => `if v${i} == null { exit }`)}\nrepeat 2 {\n${many(k, (i) => `v${i} = v${i} + 1`)}\n${many(k, (i) => `repeat v${i} {}`)}\n}\nexit`,
    ],
  ];
  return { shapes: Object.fromEntries(NARROW.map((row) => [row[0], row[1]])) };
})();
export const sizes = [8, 32];
export const shapes = corpus.shapes;

export const cases = [
  [
    "original/1/original-1",
    "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
  ],
];

export const checks = ["publication"];

export const globals = ["hostValue", "hostOther", "hostInit", "otherHost", "hostFlag"];
