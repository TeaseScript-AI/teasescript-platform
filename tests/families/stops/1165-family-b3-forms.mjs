// #1165; builder/review archive: size-dependent FORMS source families.
export const sizes = [4, 8];
const corpus = (() => {
  const chain = (from, to) =>
    Array.from({ length: to - from }, (_, i) => `global g${from + i + 1} = g${from + i}`);
  const FORMS = {
    two: (n) => [
      { path: "main.tease", source: `repeat g${n} {}\ng${n} = 2\nsay "DONE"\nexit\n` },
      { path: "data.tease", source: ["global g0 = 1.5", ...chain(0, n), "end"].join("\n") + "\n" },
    ],
    three: (n) => [
      { path: "main.tease", source: `repeat g${n} {}\ng${n} = 2\nsay "DONE"\nexit\n` },
      {
        path: "data.tease",
        source: ["global g0 = 1.5", ...chain(0, n / 2), "end"].join("\n") + "\n",
      },
      { path: "more.tease", source: [...chain(n / 2, n), "end"].join("\n") + "\n" },
    ],
    second: (n) => [
      { path: "main.tease", source: `say "DONE"\nexit\n` },
      {
        path: "data.tease",
        source:
          ["global g0 = 1.5", ...chain(0, n), `global h: integer = g${n}`, "end"].join("\n") + "\n",
      },
    ],
    function: (n) => [
      { path: "main.tease", source: `check()\nsay "DONE"\nexit\n` },
      {
        path: "data.tease",
        source:
          [
            "global g0 = 1.5",
            ...chain(0, n),
            "global function check {",
            `  repeat g${n} {}`,
            "}",
            "end",
          ].join("\n") + "\n",
      },
    ],
  };
  return {
    shapes: {
      two: (n) => FORMS["two"](n),
      three: (n) => FORMS["three"](n),
      second: (n) => FORMS["second"](n),
      function: (n) => FORMS["function"](n),
    },
  };
})();
export const shapes = corpus.shapes;
export const checks = ["publication", "stops"];
