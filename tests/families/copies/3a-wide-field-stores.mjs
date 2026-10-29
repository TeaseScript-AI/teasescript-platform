const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const WIDE = [
    [
      "a wide literal certificate",
      (k) =>
        `let box = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `repeat box.f${i} {}`)}\nexit`,
    ],
    [
      "a copy chain with interleaved field stores",
      (k) =>
        `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if hostFlag { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\nexit`,
      ["exactQueries", "invSteps"],
    ],
    // round 19d (r4.46 (3), W44): k sibling fields, each stored, projected into its own copy and read: the keys below a
    // projection from the prefix index, never the root's whole key set per copy
    [
      "sibling fields each stored, projected and read",
      (k) =>
        `let root = {${many(k, (i) => `f${i}: {v: 1}`, ", ")}}\n${many(k, (i) => `root.f${i}.v = 2\nlet p${i} = root.f${i}\nrepeat p${i}.v {}`)}\nexit`,
      ["invSteps"],
    ],
    // round 19e: the same chain read once (its copies' listings dominate: an inherited node copied per prefix is k²/2)
    [
      "a copy chain with interleaved field stores, read once",
      (k) =>
        `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if hostFlag { box${i}.f${i} = 2 }\nlet box${i + 1} = box${i}`)}\nrepeat box${k}.f0 {}\nexit`,
      ["invSteps", "prefixEntries"],
    ],
    // round 19e (r4.47 (3), W45): k destinations each copying root `a` then storing root `b`, each root with k stored
    // fields: each root listed whole in one shared entry, never flattened per destination
    [
      "the two-roots join",
      (k) =>
        `let a = {${many(k, (i) => `f${i}: 1`, ", ")}}\nlet b = {${many(k, (i) => `f${i}: 1`, ", ")}}\n${many(k, (i) => `a.f${i} = 2\nb.f${i} = 3`)}\n${many(k, (i) => `let d${i} = a\nd${i} = b\nrepeat d${i}.f${i} {}`)}\nexit`,
      ["invSteps", "prefixEntries"],
    ],
    [
      "a needed form under k tests",
      (k) =>
        `let n: integer | string | null = 1\nif hostFlag { n = "bad" }\nif hostFlag { n = null }\n${many(k, () => "if n == null { exit }")}\n${many(k, () => "repeat n {}")}\nexit`,
    ],
  ];
  return { shapes: Object.fromEntries(WIDE.map((row) => [row[0], row[1]])) };
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
