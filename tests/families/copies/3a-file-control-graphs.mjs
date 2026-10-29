const corpus = (() => {
  const many = (k, f, sep = "\n") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const FILES = (main, parts) => [{ path: "main.tease", source: main }, ...parts];
  const GRAPH = [
    [
      "function chain from k files",
      (k) =>
        FILES(
          [
            ...many(
              k,
              (i) => `global function hop${i} { ${i + 1 < k ? `hop${i + 1}()` : "end"} }`,
            ).split("\n"),
            ...many(k, (i) => `call "leaf${i}.tease"`).split("\n"),
            "exit",
          ].join("\n"),
          Array.from({ length: k }, (_, i) => ({ path: `leaf${i}.tease`, source: "hop0()\nend" })),
        ),
    ],
    [
      "ending buttons before file calls",
      (k) =>
        FILES(
          `${many(k, (i) => `showPermanentButton "b${i}" { end }`)}\n${many(k, (i) => `call "leaf${i}.tease"`)}\nexit`,
          Array.from({ length: k }, (_, i) => ({
            path: `leaf${i}.tease`,
            source: "wait 1 s\nend",
          })),
        ),
    ],
    [
      "files going to one tail",
      (k) =>
        FILES(`${many(k, (i) => `call "leaf${i}.tease"`)}\nexit`, [
          ...Array.from({ length: k }, (_, i) => ({
            path: `leaf${i}.tease`,
            source: 'goto "tail.tease"',
          })),
          { path: "tail.tease", source: "end" },
        ]),
    ],
  ];
  return { shapes: Object.fromEntries(GRAPH.map((row) => [row[0], row[1]])) };
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
