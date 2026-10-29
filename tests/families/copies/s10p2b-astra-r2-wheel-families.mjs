// S10 part 2b, Astra r2 (R/astra-m4-s10p2b-review-r2/own-shapes.mjs): the wheel families at the scale runs' 64 to 1,024,
// and the semantic cases with the selection controls its semantics run added.

const range = (k) => Array.from({ length: k }, (_, i) => i);
export const names = [
  "literal-wheel",
  "computed-wheel",
  "copy-wheel",
  "selected-wheel",
  "option-wheel",
  "list-wheel",
  "mixed-list-wheel",
];
export function shape(family, k) {
  const ids = range(k),
    vars = ids.map((i) => `v${i}`);
  const setup = ids
    .map(
      (i) =>
        `let v${i}: integer? = load("ring-${i}", default: ${i + 2})\nif change { v${i} = null }`,
    )
    .join("\n");
  const gathers = {
    "literal-wheel": `let bucket = [${vars.join(", ")}]\naggregate = bucket[pick] otherwise 3`,
    "computed-wheel": `let bucket = [${vars.map((v) => `(${v} otherwise null)`).join(", ")}]\naggregate = bucket[pick] otherwise 3`,
    "copy-wheel": `${ids.map((i) => `let box${i} = {amount: v${i}}`).join("\n")}\nlet bucket = [${ids.map((i) => `box${i}`).join(", ")}]\naggregate = bucket[pick].amount otherwise 3`,
    "selected-wheel": `let buttons = [${ids.map((i) => `{text: "pick ${i}", value: v${i}}`).join(", ")}]\naggregate = (askChoice buttons) otherwise 3`,
    "option-wheel": `aggregate = (askChoice ${ids.map((i) => `{text: "pick ${i}", value: v${i}}`).join(", ")}) otherwise 3`,
    "list-wheel": `aggregate = (askChoice [${vars.join(", ")}]) otherwise 3`,
    "mixed-list-wheel": `aggregate = (askChoice [${ids.map((i) => (i === k - 1 ? `v${i}` : `{text: "pick ${i}", value: v${i}}`)).join(", ")}]) otherwise 3`,
  };
  if (!(family in gathers)) throw Error(family);
  return `let pick = 1\nlet change = askBoolean "optional?"\n${setup}\nlet aggregate: integer? = 3\nif ${vars.map((v) => `${v} != null`).join(" and ")} and aggregate != null {\nrepeat 3 {\n${gathers[family]}\n${ids.map((i) => `let carried${i} = v${(i + 1) % k}`).join("\n")}\n${ids.map((i) => `v${i} = ${i === k - 1 ? "aggregate otherwise null" : `carried${i}`}`).join("\n")}\nlet observed: integer = aggregate\n}\n}\nexit\n`;
}
export const semanticCases = [];
function add(name, body) {
  semanticCases.push({ name, source: body + "\nexit\n" });
}
for (const k of [7, 8, 9, 17, 33]) {
  for (const family of names)
    semanticCases.push({ name: `${family}/${k}`, source: shape(family, k) });
  const ids = range(k);
  for (const mode of ["keep", "call", "assign"]) {
    const mutate = mode === "keep" ? "" : mode === "call" ? "clear()" : "source = null";
    add(
      `ordered-literal/${k}/${mode}`,
      `let source: integer? = load("held", default: null)\nfunction clear { source = null }\nif source != null { let before = [${ids.map((i) => `source + ${i}`).join(", ")}]\n${mutate}\nlet after = [${ids.map((i) => `source + ${i + 1}`).join(", ")}]\nlet left: integer = before[0]\nlet right: integer = after[0] }`,
    );
  }
  add(
    `choice-mixed/${k}`,
    `let choice = askChoice [${ids.map((i) => (i % 3 === 0 ? `{text: "label ${i}"}` : i % 3 === 1 ? `{text: "label ${i}", value: load("q${i}", default: ${i})}` : `(${i} otherwise null)`)).join(", ")}]\nlet got: integer = choice`,
  );
  add(
    `choice-projection/${k}`,
    `let choice = askChoice ${ids.map((i) => `{text: "label ${i}", value: {code: ${i % 2 ? `load("code${i}", default: null)` : `${i}`}, detail: ${i % 3 ? '"ok"' : "null"}}}`).join(", ")}\nlet got: integer = choice.code\nlet detail: string = choice.detail`,
  );
  add(
    `copy-projection/${k}`,
    `${ids.map((i) => `let a${i} = {detail: {code: load("copy${i}", default: ${i})}}`).join("\n")}\nlet rows = [${ids.map((i) => `a${i}`).join(", ")}]\nlet got: integer = rows[1].detail.code`,
  );
}
for (const kind of ["literal", "choice"]) {
  const before = range(9).map((i) => `source + ${i}`),
    after = range(9).map((i) => `source + ${i + 9}`);
  const entries = [...before, "clear()", ...after];
  const value =
    kind === "literal"
      ? `[${entries.join(", ")}]`
      : `askChoice ${entries.map((v, i) => `{text: "item ${i}", value: ${v}}`).join(", ")}`;
  add(
    `order-within-wide/${kind}`,
    `let source: integer? = load("ordered", default: null)\nfunction clear: integer { source = null\nreturn 0 }\nif source != null { let collected = ${value}\nsay collected }`,
  );
}

export const shapes = Object.fromEntries(names.map((family) => [family, (k) => shape(family, k)]));
export const sizes = [64, 128, 256, 512, 1024];
const generated = semanticCases.map(({ name, source }) => [name, source]);
export const checks = ["publication"];

// The selection controls its semantics run added (R/astra-m4-s10p2b-review-r2/evidence/semantics.mjs).
const captured = [
  [
    "semantics-0/15",
    'let choice = askBoolean "change?"\nlet xs: integer?[] = [1]\nif choice { xs = [null] }\nif xs is integer[] { let sink: integer = xs[0] }\nexit\n',
  ],
  [
    "semantics-1/14",
    'let choice = askBoolean "change?"\nlet xs: integer?[] = [1]\nif choice { xs = [null] }\nif xs is integer[] { let sink: integer = xs.first }\nexit\n',
  ],
  [
    "semantics-2/14",
    'let choice = askBoolean "change?"\nlet xs: integer?[] = [1]\nif choice { xs = [null] }\nif xs is integer[] { let sink: integer = xs.last }\nexit\n',
  ],
  [
    "semantics-3/14",
    'let choice = askBoolean "change?"\nlet xs: integer?[] = [1]\nif choice { xs = [null] }\nif xs is integer[] { let sink: integer = xs.random }\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node evidence/scale.mjs <root> <tree> <family> <k> <reverse> <route>, every wheel family at 64 to 1,024, both orders and both routes",
      "R/astra-m4-s10p2b-review-r2/queue-checks.sh, queue-quick.sh",
    ],
    [
      "node evidence/semantics.mjs <root> <shard> (shards 0 to 3), components.mjs <root> <family> and stops.mjs <root> <family>",
      "R/astra-m4-s10p2b-review-r2/REPRODUCE.md",
    ],
  ],
  sources: 106,
  sha256: "1c7ee728147d7bad056f2367f1511a7dcb4d87c09b3c09bed2d61901496a18a6",
};
