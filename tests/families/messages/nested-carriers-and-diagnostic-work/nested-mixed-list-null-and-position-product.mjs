// Its id is its file name before its area was grouped, which keeps its sources' places in a stored baseline.
export const id = "1765-mixed-family.mjs";
// #1765's generated mixed-list family, the full product (#1789, the lead's family rule after Codex r9–r11 and Astra r2;
// the owner's test-cost rule moved it out of CI). A whole-number side two or three lists deep against its text twin:
// its `null` at no layer, at each layer or at the leaf; at the element or any layer its value carried (`take`, an index,
// a `get` default, an `otherwise`'s operand or fallback, a property, a join), or a copy (narrowed, maybe null, held in
// an inferred one, a typed host value plain, tested by `is` or `!= null` or stored again, an `otherwise` of a copy or
// of two);
// the pair as list elements, object properties or the operands of `+`, joined with a second disagreeing side, or the
// whole-number side itself a `+` of two sides whose nulls are at different layers; both orders. The family is the product
// of its axes (`axes`), a case's source made from its axis values alone and its name exactly them, `<axis>:<value>` in
// the axes' order: `tests/type-core/type-core-mixed-family.test.ts` samples it by them (its coverage invariant).
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

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, at) => from + at);
// (the family's axes, in order, each with its values given the axes before it: the only values a case varies by. A
// parameter a case varies by enters here, and so its name and the sampled test's coverage invariant, which asserts a
// name's axes are these, the lead's ruling on #1789. A source that changes otherwise is caught by its record, `keys`,
// and the queue's run; the sampled test also evaluates this module again where the realm's own outside inputs throw)
export const axes = [
  ["depth", () => [2, 3]],
  ["nullAt", ({ depth }) => range(0, depth)],
  ["at", ({ depth }) => range(-1, depth - 1)],
  ["kind", ({ at }) => (at < 0 ? ["plain"] : KINDS.slice(1))],
  ["position", () => Object.keys(POSITIONS)],
  // (the twin's null layer, where the whole-number side is joined with its twin; 0 for none)
  ["twin", ({ depth, nullAt, position }) => [position === "joinNulls" ? (nullAt % depth) + 1 : 0]],
  ["later", () => [false, true]],
];

// (a case's source, from its axis values alone)
function source({ depth, nullAt, at, kind, position, twin: twinAt, later }) {
  const before = [];
  const block = [];
  const one = side("1", depth, nullAt, at, kind, before, block);
  const joined = position === "joinNulls";
  const twin = side("2", depth, twinAt, -1, "plain", [], []);
  const a = joined ? `(([${one}]).take(9)+([${twin}]).take(9))` : one;
  const text = side('"x"', depth, 0, -1, "plain", [], []);
  const b = joined ? `[${text}]` : text;
  const other = side("true", depth, 0, -1, "plain", [], []);
  const make = POSITIONS[position];
  const pair = later ? make(b, a, other) : make(a, b, other);
  return `${before.join("")}${block[0] ?? ""}${pair}\n${block[1] ?? ""}exit\n`;
}

const product = (next, values) =>
  next === axes.length
    ? [values]
    : axes[next][1](values).flatMap((value) =>
        product(next + 1, { ...values, [axes[next][0]]: value }),
      );
export const cases = product(0, {}).map((values) => [
  axes.map(([axis]) => `${axis}:${values[axis]}`).join("/"),
  source(values),
]);
export const globals = ["hostValue"];
export const recorded = {
  commands: [
    [
      'env -u NODE_OPTIONS node tests/families/shadow.mjs "$SX_TREE" messages --only only.json --out shadow.jsonl',
      "sx-job campaign i1765-records-16c50f635 (job 1106071425980a, tree 16c50f635); " +
        "desktop:~/work/evidence/1765-family/16c50f63555996c8aa5c5fa745e0f7fdf52a2748/i1765-records-16c50f635/" +
        "shadow-family/out/shadow.jsonl",
    ],
    [
      'node --input-type=module -e \'import { sourcesOf, sourceKey } from "./tests/families/sources.mjs"; ' +
        'import * as g from "./tests/families/messages/nested-carriers-and-diagnostic-work/nested-mixed-list-null-and-position-product.mjs"; ' +
        "for (const s of sourcesOf(g)) console.log(JSON.stringify([s.name, sourceKey(s)]));' " +
        "> tests/families/messages/nested-carriers-and-diagnostic-work/1765-mixed-family.keys.jsonl",
      "each case's source key by name (`keys`), the run's set (its set key is `sha256`), Astra r3's B1 on #1789",
    ],
  ],
  keys: "1765-mixed-family.keys.jsonl",
  sources: 3670,
  sha256: "447575b546fa8bede623c9d1570170a43d63b2e545e239400701d42aef29f085",
};
