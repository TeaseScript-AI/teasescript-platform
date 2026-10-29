// #1165 / S8, Astra r6 (R/astra-m4-s8b-r6-evidence/probe/matrix.mjs): the generated stop matrix, of which the r6 sweeps
// ran the fourteen cases its cases.mjs selects.

// The generated stop matrix (TABLE r4.138): every consumer position against every value shape, each program one case.
// Positions: a store into an inferred place, into a written one, a direct consumer, an argument of a single-site and of
// a multi-site call, a return, a condition, a selection (`.first`, `.get`). Shapes: mixed literals with a named element
// (list, set, dict, nested), a plain literal, ingress (a scalar, in a list, in an object), typed calls (fromJson with a
// scalar, list and object default, load), copies (of a written list, of an inferred one).
const prefix = "let count: integer = 2\nlet base: integer[] = [1]\nlet src = [1, 2]\n";
const shapes = {
  "mixed-list": '[count, "bad"]',
  "mixed-set": 'set[count, "bad"]',
  "mixed-dict": 'dict{a: count, b: "bad"}',
  "mixed-nested": '{items: [[count, "bad"]]}',
  "plain-list": "[1, 2]",
  "ingress-scalar": "hostValue",
  "ingress-list": "[hostValue]",
  "ingress-object": "{n: hostValue}",
  "parse-scalar": "fromJson(hostValue, default: 9)",
  "parse-list": "fromJson(hostValue, default: [1])",
  "parse-object": "fromJson(hostValue, default: {n: 1})",
  "load-scalar": 'load("key", default: 9)',
  "copy-written": "base",
  "copy-inferred": "src",
};
const positions = {
  "store-inferred": (x) => `let v = ${x}\nsay v`,
  "store-written": (x) => `let v: (integer | string)[] = [1]\nv = ${x}\nsay v`,
  direct: (x) => `say ${x}`,
  "argument-single": (x) => `function f(p) { say p }\nf(${x})`,
  "argument-multi": (x) => `function f(p) { say p }\nf(${x})\nf(${x})`,
  return: (x) => `function make { return ${x} }\nsay make()`,
  condition: (x) => `if ${x} != null { say "set" }`,
  "selection-first": (x) => `say ${x}.first`,
  "selection-get": (x) => `say ${x}.get(0, default: 3)`,
};
export const matrix = [];
for (const [p, place] of Object.entries(positions))
  for (const [s, shape] of Object.entries(shapes))
    matrix.push([`m-${p}-${s}`, `${prefix}${place(shape)}\nsay "DONE"\nexit`]);

// (probe/cases.mjs:47)
export const cases = Array.from({ length: 14 }, (_, i) => matrix[(i % 9) * 14 + i]);
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node sweep.mjs <case> <mode> for each of the fourteen m-* cases (job.sh run once per job jobs.txt names, as6-sweep-m-<case>-<mode>)",
      "R/astra-m4-s8b-r6-evidence/job.sh:8 and jobs.txt",
    ],
  ],
  sources: 14,
  sha256: "d3e986529a7985093ccb354e8d8836e30f8b28e7c778f0b3a9672134a1c16e31",
};
