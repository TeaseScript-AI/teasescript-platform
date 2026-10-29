// #1310, Astra review (desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/astra/probe.mjs): the joins action's inline and kept
// joins over twelve operand forms, both sides, both ends and four contexts, and its seven extras; the growth action's
// four families at k and 2k for the recorded k = 4 and 32.
const operandForms = [
  ["written", "let u: (boolean | string)[] = [true]\n", "u", "[false]", '["tail"]', "[2]"],
  [
    "written-copy",
    "let u: (boolean | string)[] = [true]\nlet clone = u\n",
    "clone",
    "[false]",
    '["tail"]',
    "[2]",
  ],
  [
    "written-call",
    "function make: (boolean | string)[] { return [true] }\n",
    "make()",
    "[false]",
    '["tail"]',
    "[2]",
  ],
  [
    "inferred-call",
    "let u: (boolean | string)[] = [true]\nfunction make { return u }\n",
    "make()",
    "[false]",
    '["tail"]',
    "[2]",
  ],
  [
    "property-read",
    "let box = {values: [1]}\nbox.values.add(1.5)\n",
    "box.values",
    "[3]",
    "[2.5]",
    '["tail"]',
  ],
  ["indexed-read", "let box = [[1]]\n", "box[0]", "[2]", "[3]", '["tail"]'],
  [
    "nulls",
    "let u: (integer | string | null)[] = [null]\n",
    "u",
    "[1,null]",
    '["tail",null]',
    "[true,null]",
  ],
  ["nested", "let u: (boolean | string)[][] = [[true]]\n", "u", "[[false]]", '[["tail"]]', "[[2]]"],
  [
    "nested-null",
    "let u: ((boolean | string | null)[]?)[] = [[true],null]\n",
    "u",
    "[[false],null]",
    '[["tail",null]]',
    "[[2]]",
  ],
  ["host-before", "", "[hostValue, 1]", "[2]", "[3]", '["tail"]'],
  ["host-after", "", "[1, hostValue]", "[2]", "[3]", '["tail"]'],
  ["open", "let u: list = [1]\n", "u", "[2]", "[3]", '["tail"]'],
];
export const cases = [];
for (const [name, start, u, fit, beside, bad] of operandForms)
  for (const [sub, join] of [
    ["left", `${u} + ${fit}`],
    ["right", `${fit} + ${u}`],
  ])
    for (const [end, neighbor] of [
      ["fit", beside],
      ["bad", bad],
    ])
      for (const [context, make] of [
        ["left", (j) => `let result = ${j} + ${neighbor}\n`],
        ["right", (j) => `let result = ${neighbor} + ${j}\n`],
        ["deep", (j) => `let result = [] + (${j} + (${neighbor} + []))\n`],
        ["compound", (j) => `let result = ${j}\nresult += ${neighbor}\n`],
      ]) {
        const label = `${name}-${sub}-${end}-${context}`;
        cases.push([`${label}/inline`, `${start}${make("(" + join + ")")}exit\n`]);
        cases.push([`${label}/kept`, `${start}let held = ${join}\n${make("held")}exit\n`]);
      }
const extras = [
  [
    "overlap-copy",
    "let a: (integer | string)[] = [1]\nlet b: (integer | boolean)[] = [1]\nlet x = a\nlet y = b\nlet z = (x + y) + [true]\nexit\n",
  ],
  [
    "own-compound",
    'let box = {last: {items: [1,null]}}\nbox.last.items += [2]\nbox.last.items += ["bad",null]\nbox.last.items += [true]\nexit\n',
  ],
  ["host-arithmetic-inline", 'let result = ([1,hostValue / 3] + [2]) + ["bad"]\nexit\n'],
  [
    "host-arithmetic-kept",
    'let held = [1,hostValue / 3]\nlet result = (held + [2]) + ["bad"]\nexit\n',
  ],
  ["right-object-new", 'let result = [{p: {q: 1}}] + ([{p: {q: "bad"}}] + [])\nexit\n'],
  ["nullable-diagnostic", 'let xs = [[null, 1], null]\nxs += [["bad",null]]\nexit\n'],
  [
    "join-recovery",
    "let u: (boolean | string)[] = [true]\nlet result = ([false] + u) + [2]\nresult[0] = 3\nexit\n",
  ],
];
cases.push(...extras);

export const shapes = {
  "right-optional-objects": (k) =>
    `let xs = ${Array.from({ length: k }, (_, i) => i).reduce((inner, i) => `[{p${i}: [null, ${i + 1}]}] + (${inner})`, "[{end: [null, 0]}]")}\nexit\n`,
  "left-optional-objects": (k) =>
    `let xs = ${Array.from({ length: k }, (_, i) => `[{p${i}: [null, ${i + 1}]}]`).join(" + ")}\nexit\n`,
  "balanced-null-lists": (k) => {
    let leaves = Array.from({ length: k }, (_, i) => `[[null,${i + 1}]]`);
    while (leaves.length > 1)
      leaves = Array.from({ length: Math.ceil(leaves.length / 2) }, (_, i) =>
        leaves[2 * i + 1] ? `(${leaves[2 * i]} + ${leaves[2 * i + 1]})` : leaves[2 * i],
      );
    return `let xs = ${leaves[0]}\nexit\n`;
  },
  "copied-own-random": (k) =>
    `let seed = {random: {last: {items: [1]}}}\n${Array.from({ length: k }, (_, i) => `let c${i} = seed\nc${i}.random.last.items = [2]\n`).join("")}exit\n`,
};
export const sizes = [4, 8, 32, 64];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node probe.mjs <dir> joins",
      "desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/README.md:6",
    ],
    [
      "node probe.mjs <dir> growth 32",
      "desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/README.md:6",
    ],
    ["node probe.mjs <dir> growth 4", "R/astra-m4-i1272-review-r2/commands.md:20"],
  ],
  sources: 407,
  sha256: "9554e9f8e6bdcefeb008111132e86132afb6e83cbc66e93ad9ca7fd7be9e91d1",
};
