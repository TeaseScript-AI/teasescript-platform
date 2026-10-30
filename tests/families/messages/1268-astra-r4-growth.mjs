// original own-selection-stores, object-index and related inputs; #1268, Astra review, r4
// (R/astra-m4-i1268-review-r4-evidence/builder/generators/growth.mjs).
export const sizes = [64, 128, 256, 512];
export const shapes = (() => {
  const lines = (k, line) => Array.from({ length: k }, (_, i) => line(i)).join("\n");
  const FAMILIES = {
    // #1240: stores into an object's own first, last and random
    "own-selection-stores": (k) =>
      `let a = {first: 1, last: 2, random: 3}\n${lines(k, (i) => `a.${["first", "last", "random"][i % 3]} = ${i}`)}\nexit\n`,
    // #1242: an object indexed, a removeAt on a list and on an object
    "object-index": (k) =>
      `let door = {name: "hall"}\n${lines(k, () => 'say door["name"]')}\nexit\n`,
    "list-removeAt": (k) =>
      `let xs = [${lines(k, (i) => `${i}`).replaceAll("\n", ", ")}]\n${lines(k, () => "xs.removeAt(0)")}\nexit\n`,
    "object-removeAt": (k) => `let a = {n: 1}\n${lines(k, () => 'a.removeAt("x")')}\nexit\n`,
    // #1241: one error per line of each fix
    "unit-stores": (k) => lines(k, (i) => `let p${i}: duration = ${i} + 1`) + "\nexit\n",
    "member-fixes": (k) =>
      `let t = "x"\nlet d = dict{a: 1}\n${lines(k, (i) => ["say t.size", "say d.collar", "say t.trim", "d.add(2)"][i % 4])}\nexit\n`,
    // Astra r2: a join read's elements, k reads of a list of k objects
    "join-reads": (k) =>
      `let items = [${lines(k, (i) => `{n: ${i}}`).replaceAll("\n", ", ")}]\n${lines(k, () => "say items.join")}\nexit\n`,
    "list-plus": (k) => `let names = ["Ann"]\n${lines(k, () => 'say names + "Bo"')}\nexit\n`,
    // Codex r6 B1: one expression of k errors, each resolving what its site takes up the same chain
    "error-chain": (k) =>
      `let t = "hello"\nsay ${Array.from({ length: k }, () => "t.size").join(" + ")}\nexit\n`,
    // Astra on #1273: a null value's fallback where it divides, k divisions in one expression
    "null-divisors": (k) => `let xs = [4, null]\nsay 1${" / xs[1]".repeat(k)}\nexit\n`,
    // Codex r7, TABLE r4.160: k reads of a variable an error decides, and k calls of a function without parameter types
    "variable-reads": (k) =>
      `let t = "hello"\nlet v = t.size\n${lines(k, () => "say v + 1")}\nexit\n`,
    "untyped-calls": (k) =>
      `let t = "hello"\nfunction count(p) {\n  return p + 1\n}\n${lines(k, () => "say count(t.size)")}\nexit\n`,
    // Codex r8: a chain of k untyped copies; k fallbacks through 'otherwise' where they divide
    "copy-chain": (k) =>
      `let t = "x"\nlet v0 = t.size\n${lines(k, (i) => `let v${i + 1} = v${i}`)}\nsay v${k}.trim()\nexit\n`,
    "fallback-divisors": (k) =>
      `let xs = ["ab", null]\n${lines(k, () => "say 1 / (xs[1].length otherwise 1)")}\nexit\n`,
    // Astra on #1296: k list joins and conversions over values read by a dict's key
    "keyed-offers": (k) =>
      `let d = dict{found: [1]}\nlet e = dict{found: 2}\n${lines(k, (i) => (i % 2 === 0 ? 'say d["absent"] + 2' : `let v${i}: duration = e["absent"]`))}\nexit\n`,
    "iteration-join": (k) =>
      `let xs = [1]\n${lines(k, () => "for v in xs + 2 {\n  say v\n}")}\nexit\n`,
    // #1268: k null checks each holding its own statement; k kept values; k uses in one statement (Codex r5); a one-line
    // switch of k cases (Codex r4); k declarations a store widens; k type tests; k conditions; k checks in blocks
    "null-checks": (k) =>
      `let ns = [1, null]\n${lines(k, (i) => `let n${i} = ns[1]\nsay n${i} + 1`)}\nexit\n`,
    "kept-checks": (k) => `let ns = [1, null]\n${lines(k, (i) => `say ns[1] + ${i}`)}\nexit\n`,
    "wide-statement": (k) =>
      `let ns = [1, null]\nlet n = ns[1]\nsay [${Array.from({ length: k }, () => "n + 1").join(", ")}]\nexit\n`,
    "one-line-switch": (k) =>
      `let ns = [1, null]\nlet n = ns[1]\nlet c = 1\nswitch c { ${Array.from({ length: k }, (_, i) => `case ${i} { say n + 1 }`).join(" ")} }\nexit\n`,
    declarations: (k) => `${lines(k, (i) => `let m${i} = ${i}\nm${i} = "x"`)}\nexit\n`,
    "type-tests": (k) =>
      `let us: (integer | string)[] = [1, "a"]\n${lines(k, (i) => `let u${i} = us[0]\nsay u${i} + 1`)}\nexit\n`,
    conditions: (k) => `let c = 1\n${lines(k, () => "if c { say 1 }")}\nexit\n`,
    "block-checks": (k) =>
      `let ns = [1, null]\nlet n = ns[1]\n${lines(k, () => "if true { say n + 1 }")}\nexit\n`,
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(FAMILIES)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node gen/growth.mjs head-2cdb498a4 / main-f58a8acfe",
      "R/astra-m4-i1268-review-r4-evidence/builder/COMMANDS:8",
    ],
    [
      "/home/peter/opt/node-24.18/bin/node gen/growth.mjs head-$H",
      "R/astra-m4-i1268-review-r4-evidence/builder/generators/queue-evidence.sh:25",
    ],
    [
      "/home/peter/opt/node-24.18/bin/node gen/growth.mjs $M",
      "R/astra-m4-i1268-review-r4-evidence/builder/generators/queue-evidence.sh:27",
    ],
  ],
  sources: 96,
  sha256: "2bc670126d20fd9e5c8f4ce373174b71f9fee3a603d640a3efe10e756a1a27fe",
};
