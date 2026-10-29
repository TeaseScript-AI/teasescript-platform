// 3a model builder: size-dependent GRAPH source families.
export const sizes = [4, 8];
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
  return {
    shapes: {
      "function chain from k files/1": (n) => GRAPH[0][1](n),
      "ending buttons before file calls/1": (n) => GRAPH[1][1](n),
      "files going to one tail/1": (n) => GRAPH[2][1](n),
    },
    cases: [["0", GRAPH["0"]["0"]]],
  };
})();
export const shapes = corpus.shapes;
export const cases = corpus.cases;
export const checks = ["publication"];
