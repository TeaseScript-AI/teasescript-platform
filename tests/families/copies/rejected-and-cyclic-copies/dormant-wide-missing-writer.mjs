// Its id is its file name before its area was grouped, which keeps its sources' places in a stored baseline.
export const id = "1323-dormant-wide.mjs";
// #1323: the dormant shape (`copies/rejected-and-cyclic-copies/split-dormant-and-residual-copies.mjs`) with objects twice as wide as its reads, so
// no read reaches the property index (#1456) and the levels' own fold answers every one: the literal written first
// is stored last, and with the sharing on F11's `missing` must name it as the sharing off does. Sizes 8, 64 and 128.
const seq = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const fields = (n, v) => seq(n, (i) => `f${i}:${v}`).join(",");
const wide = (n, place) =>
  [
    "let exact:integer=71",
    `let annotated={${fields(2 * n, "exact")}}`,
    `let loose={${fields(2 * n, "1.25")}}`,
    "let container=loose",
    "container=annotated",
    ...seq(n, (i) => [
      `let part${i}=container`,
      `part${i}.local${i}=exact`,
      `let relay${i}=part${i}`,
      ...(place
        ? [`let sink${i}=container`, `sink${i}=relay${i}`]
        : [`let sink${i}=[relay${i},container]`]),
    ]).flat(),
  ].join("\n") + "\nexit\n";
const shapes = {
  "dormant-wide": (n) => wide(n, false),
  "dormant-wide-place": (n) => wide(n, true),
};
export const cases = Object.entries(shapes).flatMap(([name, make]) =>
  [8, 64, 128].map((n) => [`${name}@${n}`, make(n)]),
);
export const checks = ["publication"];
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "sx-job submit … --commit base=<main 504343841> --commit head=<#1323's head> --in job.sh --in fam.mjs -- bash job.sh",
      "~/work/evidence/i1323-dormant-wide/50434384124160329db57898ab684715f58771f6/job.sh",
    ],
  ],
  sources: 6,
  sha256: "0abb1225e38406396fcfd20f67fb0b12012c2e0d626c0f7b016b2cf4452c2ffb",
};
