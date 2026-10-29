// #1310, Astra review (desktop:~/work/evidence/1310/2eba4965c443bbf3a4b945560fd315d7cf736ae4/astra/probe.mjs): the stops action's twelve programs,
// four shapes each storing a text, a number or a host value below a selection, which it stopped at every allowance.
const shapes = [
  ["copy", "let seed = {last: {n: 1}}\nlet box = seed\n", "box.last.n"],
  ["index", "let boxes = [{random: {n: 1}}]\n", "boxes[0].random.n"],
  [
    "chain",
    "let box = {last: null}\nbox.last = {first: null}\nbox.last.first = {n: 1}\n",
    "box.last.first.n",
  ],
  [
    "extra-neighbor",
    "let box = {random: {first: {last: {n: 1}}}}\nbox.random.first = hostOther\n",
    "box.random.first.last.n",
  ],
];
export const cases = [];
for (const [shape, start, target] of shapes)
  for (const value of ['"bad"', "2", "hostValue"])
    cases.push([
      `${shape}/${value}`,
      `${start}say "BEFORE"\n${target} = ${value}\nsay "AFTER"\nexit\n`,
    ]);
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node probe.mjs <dir> stops 0", "R/astra-m4-i1272-review-r2/commands.md:22"],
    ["node probe.mjs <dir> stops 1", "R/astra-m4-i1272-review-r2/commands.md:23"],
    ["node probe.mjs <dir> stops 2", "R/astra-m4-i1272-review-r2/commands.md:24"],
    ["node probe.mjs <dir> stops 3", "R/astra-m4-i1272-review-r2/commands.md:25"],
  ],
  sources: 12,
  sha256: "6e021263ae2117520a3444db18865aaf1ac90a63985762622495ce81f285ec17",
};
