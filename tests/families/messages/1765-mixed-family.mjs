// #1765's generated mixed-list family, the full product (#1789, the lead's family rule after Codex r9–r11 and Astra r2;
// the owner's test-cost rule moved it out of CI). A whole-number side two or three lists deep against its text twin:
// its `null` at no layer, at each layer or at the leaf; at the element or any layer its value carried (`take`, an index,
// a `get` default, an `otherwise`'s operand or fallback, a property, a join), or a copy (narrowed, maybe null, held in
// an inferred one, a typed host value plain, tested by `is` or `!= null` or stored again, an `otherwise` of a copy or
// of two);
// the pair as list elements, object properties or the operands of `+`, joined with a second disagreeing side, or the
// whole-number side itself a `+` of two sides whose nulls are at different layers; both orders. A case's name is its dimensions:
// `d<depth>/n<null layer>/<kind>@<layer>/<position>/<first|later>`, which `tests/type-core-mixed-family.test.ts` samples.
const CARRIERS = {
  take: (value) => `(${value}).take(9)`,
  index: (value) => `[${value}][0]`,
  get: (value) => `[].get(0, default: ${value})`,
  operand: (value) => `(${value} otherwise null)`,
  fallback: (value) => `(null otherwise ${value})`,
  property: (value) => `{p:${value}}.p`,
  join: (value) => `(${value})+[]`,
};
// (a copy: its written type's `?`, its value, any statement after it, the block around the pair, and its read)
const COPIES = {
  narrowed: (list) => ({ value: list, read: "c" }),
  maybe: (list) => ({ value: list, after: "if hostValue == 1 { c=null }\n", read: "c" }),
  held: (list) => ({ value: list, after: "let h={p:c}\n", read: "h.p" }),
  host: () => ({ value: "hostValue", read: "c" }),
  sure: () => ({ value: "hostValue", sure: true, read: "c" }),
  is: (_, type) => ({ value: "hostValue", block: [`if c is ${type} {\n`, "}\n"], read: "c" }),
  notNull: () => ({ value: "hostValue", block: ["if c != null {\n", "}\n"], read: "c" }),
  invalidated: () => ({
    value: "hostValue",
    block: ["if c != null {\nc=hostValue\n", "}\n"],
    read: "c",
  }),
  nullOr: (list) => ({ value: "null", read: `(c otherwise ${list})` }),
  maybeOr: (list) => ({
    value: list,
    after: "if hostValue == 1 { c=null }\n",
    read: `(c otherwise ${list})`,
  }),
  orNull: (list) => ({ value: list, read: "(c otherwise null)" }),
  hostOrNull: () => ({ value: "hostValue", read: "(c otherwise null)" }),
  // (an `otherwise` of two copies, each kept by the walk: the maybe-null copy of the layer and a null-free twin)
  orCopy: (list, _, plain, plainType) => ({
    value: list,
    after: `if hostValue == 1 { c=null }\nlet d:${plainType}=${plain}\n`,
    read: "(c otherwise d)",
  }),
};
const KINDS = ["plain", ...Object.keys(CARRIERS), ...Object.keys(COPIES)];
// (the pair as list elements, object properties or `+` operands; joined with a second disagreeing side, the text
// side's true-or-false twin, so the first join's operands are asked again, Codex r16; and the whole-number side a join
// of two kept operands, it and its twin with the null at another layer, each a list of it under a `take`, so the join
// asked again takes two answers that each hold a layer, Codex r17)
const POSITIONS = {
  element: (a, b) => `let xs=[${a},${b}]`,
  property: (a, b) => `let xs=[{f:${a}},{f:${b}}]`,
  join: (a, b) => `let xs=[${a}]+[${b}]`,
  joinTwice: (a, b, other) => `let xs=[${a}]+[${b}]+[${other}]`,
  joinNulls: (a, b, other) => `let xs=${a}+${b}+[${other}]`,
};

function side(leaf, depth, nullAt, at, kind, before, block) {
  const type = (layer) =>
    layer === depth
      ? leaf === "1"
        ? "integer"
        : "string"
      : `${type(layer + 1)}${nullAt === layer + 1 ? "?" : ""}[]`;
  const plainType = (layer) =>
    layer === depth ? (leaf === "1" ? "integer" : "string") : `${plainType(layer + 1)}[]`;
  const plain = (layer) => (layer === depth ? leaf : `[${plain(layer + 1)}]`);
  const build = (layer) => {
    if (layer === depth) return leaf;
    const list = `[${build(layer + 1)}${nullAt === layer + 1 ? ",null" : ""}]`;
    if (at !== layer) return list;
    if (kind in CARRIERS) return CARRIERS[kind](list);
    const copy = COPIES[kind](list, type(layer), plain(layer), plainType(layer));
    before.push(`let c:${type(layer)}${copy.sure ? "" : "?"}=${copy.value}\n${copy.after ?? ""}`);
    if (copy.block !== undefined) block.push(...copy.block);
    return copy.read;
  };
  return build(0);
}

export const cases = [];
for (const depth of [2, 3])
  for (let nullAt = 0; nullAt <= depth; nullAt += 1)
    for (let at = -1; at < depth; at += 1)
      for (const kind of at < 0 ? ["plain"] : KINDS.slice(1))
        for (const [position, make] of Object.entries(POSITIONS))
          for (const later of [false, true]) {
            const before = [];
            const block = [];
            const one = side("1", depth, nullAt, at, kind, before, block);
            const twin = side("2", depth, (nullAt % depth) + 1, -1, "plain", [], []);
            const joined = position === "joinNulls";
            const a = joined ? `(([${one}]).take(9)+([${twin}]).take(9))` : one;
            const text = side('"x"', depth, 0, -1, "plain", [], []);
            const b = joined ? `[${text}]` : text;
            const other = side("true", depth, 0, -1, "plain", [], []);
            const pair = later ? make(b, a, other) : make(a, b, other);
            cases.push([
              `d${depth}/n${nullAt}/${kind}@${at}/${position}/${later ? "later" : "first"}`,
              `${before.join("")}${block[0] ?? ""}${pair}\n${block[1] ?? ""}exit\n`,
            ]);
          }
export const globals = ["hostValue"];
export const recorded = {
  commands: [
    [
      'env -u NODE_OPTIONS node tests/families/shadow.mjs "$SX_TREE" messages --only only.json --out shadow.jsonl',
      "sx-job campaign i1765-records-2993d9df7 (job 1106061845794d, tree 2993d9df7); " +
        "desktop:~/work/evidence/1765-family/2993d9df7c33a543d41de0197696c6665a2ffdab/shadow-family/out/shadow.jsonl",
    ],
  ],
  sources: 2936,
  sha256: "95f11565e00b6bd0c41c54ea57efe0d769a0cd7e4e3f5edf9f5daff5ff466b88",
};
