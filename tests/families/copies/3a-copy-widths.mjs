const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const COPIES = [
    // round 17 (r4.36): a test on the source before each copy (Sol r9 D1), and copies inside tests that mark their reads
    [
      "a tested whole-copy chain read at k fields",
      (k) =>
        `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if box${i}.f0 != null {}\nlet box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\nexit`,
    ],
    [
      "a marked whole-copy chain",
      (k) =>
        `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if box${i}.f0 > 1 {\nlet box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\n${"}".repeat(k)}\nexit`,
    ],
    // round 18 (r4.38): k sibling guarded copies each testing its own field (Astra r10 D1), an `and` over k fields with k
    // copies inside (Sol R10-D1), a chain of copies with a store to a different field between each pair (Astra r10 D2)
    [
      "sibling guarded copies, one field each",
      (k) =>
        `let root = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { root = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `if root.f${i} != null {\nif root.f${i} > 0 {\nlet copy${i} = root\nrepeat copy${i}.f${i} {}\n}\n}`)}\nexit`,
      ["exactQueries", "indexSteps", "eventSteps"],
    ],
    [
      "copies inside an and over k fields",
      (k) =>
        `let seed = load("n", default: null)\nlet box0 = {${many(k, (i) => `f${i}: seed`, ", ")}}\nif ${many(k, (i) => `box0.f${i} > 0`, " and ")} {\n${many(k, (i) => `let box${i + 1} = box0`)}\n${many(k, (i) => `repeat box${i + 1}.f${i} {}`)}\n}\nexit`,
      ["exactQueries", "indexSteps", "eventSteps"],
    ],
    [
      "a whole-copy chain read at k fields",
      (k) =>
        `let box0 = {${many(k, (i) => `f${i}: 1`, ", ")}}\nif hostFlag { box0 = {${many(k, (i) => `f${i}: null`, ", ")}} }\n${many(k, (i) => `let box${i + 1} = box${i}`)}\n${many(k, (i) => `repeat box${k}.f${i} {}`)}\nexit`,
    ],
  ];
  return { shapes: Object.fromEntries(COPIES.map((row) => [row[0], row[1]])) };
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
