// S10 part 2b's review r2 (Astra): r1's scaling families, k nullable integers tested together and then waved into an
// aggregate, copied round a ring, copied with a break, or switched on, in a loop, at k = 64 to 1,024
// (R/astra-m4-s10p2b-review-r2/r1-scaling.mjs, the source closed by its `harness.mjs` `files`). The solver's order,
// its other argument, does not change the source.
const family = (name) => (k) => {
  const rows = (fn) => Array.from({ length: k }, (_, i) => fn(i)).join("\n");
  const balance = (xs, op) =>
    xs.length === 1
      ? xs[0]
      : `(${balance(xs.slice(0, xs.length >> 1), op)} ${op} ${balance(xs.slice(xs.length >> 1), op)})`;
  const names = Array.from({ length: k }, (_, i) => `v${i}`);
  const ints = rows((i) => `let v${i}: integer? = hostValue`);
  const tests = names.map((n) => `${n} != null`).join(" and ");
  const body = {
    "numeric-wave": `${ints}\nlet aggregate: integer? = 5\nif aggregate != null and ${tests} { repeat 3 {\naggregate = ${balance(
      names.map((n) => `((${n} otherwise 3) * 2)`),
      "%",
    )}\n${rows((i) => `let copy${i} = v${(i + 1) % k}`)}\n${rows((i) => `v${i} = ${i === k - 1 ? "aggregate otherwise null" : `copy${i}`}`)}\nlet sink: integer = aggregate\n} }`,
    "copy-ring": `${ints}\nif ${tests} { repeat 3 {\n${rows((i) => `let snapshot${i} = v${i}`)}\n${rows((i) => `let shifted${i} = snapshot${(i + 1) % k} + 2`)}\n${rows((i) => `v${i} = shifted${i}`)}\n${rows((i) => `let sink${i}: integer = v${i}`)}\n} }`,
    "copy-break": `${ints}\nif ${tests} { repeat 3 {\n${rows((i) => `let snapshot${i} = v${(i + 1) % k}`)}\n${rows((i) => `let next${i} = snapshot${i}`)}\n${rows((i) => `v${i} = ${i === k - 1 ? "next" + i + " otherwise null" : "next" + i}`)}\n${rows((i) => `let sink${i}: integer = v${i}`)}\n} }`,
    "switch-location": `let value: integer? = hostValue\nif value != null { repeat 3 { switch hostValue {\n${rows((i) => `case ${i} { let saved = value\nvalue = (saved otherwise 0) + 2 }`)}\n}\nlet sink: integer = value\n} }`,
  }[name];
  return body + "\nexit\n";
};
export const shapes = Object.fromEntries(
  ["numeric-wave", "copy-ring", "copy-break", "switch-location"].map((name) => [
    name,
    family(name),
  ]),
);

export const sizes = [64, 128, 256, 512, 1024];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node evidence/r1-scaling.mjs <root> head|base <family> <k> <0|1> (numeric-wave, copy-ring, copy-break, switch-location; k 64 to 1,024)",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh:280-319",
    ],
  ],
  sources: 20,
  sha256: "54949d6ddd8ebd2c2c0c456c601c0f044b6de7dadaa90f55bcb471279122922a",
};
