// complete scalar/list/object reader programs at 4/12 stores, with the dependent reader at 60; #1165 S8 part 3, r7
// retained builder/probe9 evidence
// (desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/family/family-b1.mjs).
export const sizes = [4, 12];
const bindings = {
  scalar: {
    key: "tally",
    init: "1",
    store: (i) => `${i + 2}`,
    readers: {
      value: ["repeat tally {}"],
      later: ["let picked: integer = tally", "repeat tally {}", "repeat tally {}"],
      composed: ["say [tally]", "repeat tally {}"],
      copy: ["let other = tally", "repeat other {}"],
      // Codex c-r7 B1: a literal's property or element read in place, and an operation over the read
      objectRead: ["repeat {kept: tally}.kept {}"],
      listRead: ["repeat [tally].first {}"],
      operation: ["repeat tally + 1 {}"],
      // TABLE r4.180: a stored literal holding the read, reread after the stop
      dependent: ["let pair = [tally]", "repeat pair.first {}"],
      // Codex c-r8 B1: a read under a type test of the key, and one beside it
      narrowed: ["if tally is integer {", "  let picked: integer = tally", "}", "repeat tally {}"],
      narrowedNot: ["if tally is not integer {", "  let picked = tally", "}", "repeat tally {}"],
    },
    sizes: { dependent: [60] },
  },
  list: {
    key: "basket",
    init: "[1]",
    store: (i) => `[${i + 2}]`,
    readers: {
      descendant: ["repeat basket.first {}"],
      composed: ["say [basket.first]", "repeat basket.first {}"],
      whole: ["let copied = basket", "repeat copied.first {}"],
    },
  },
  object: {
    key: "box",
    init: "{n: 1}",
    store: (i) => `{n: ${i + 2}}`,
    readers: {
      descendant: ["repeat box.n {}"],
      receiver: ["box.n = 3", "repeat box.n {}"],
      composed: ["say [box.n]", "repeat box.n {}"],
    },
  },
};
const program = (shape, lines, n) =>
  [
    `let ${shape.key} = ${shape.init}`,
    ...Array.from({ length: n }, (_, i) => `${shape.key} = ${shape.store(i)}`),
    `${shape.key} = hostValue`,
    ...lines,
    'say "DONE"',
    "exit",
  ].join("\n") + "\n";
export const shapes = {};
export const cases = [];
for (const [binding, shape] of Object.entries(bindings)) {
  for (const [reader, lines] of Object.entries(shape.readers)) {
    const name = binding + "/" + reader;
    if (shape.sizes?.[reader]) {
      for (const n of shape.sizes[reader]) cases.push([name + "@" + n, program(shape, lines, n)]);
    } else shapes[name] = (n) => program(shape, lines, n);
  }
}
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'SIZES=4,12 node $g/family/family-b1.mjs "$mode"',
      "D/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/family-b1.sh:5",
    ],
  ],
  sources: 31,
  sha256: "5ef58ec70cb2c9d5b4401331b7601d265a3b5b5d31ea18e537703dad12fde56c",
};
