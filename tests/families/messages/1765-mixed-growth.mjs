// #1765's generated mixed-list family, its work (#1789; the lead's family rule after Codex r9–r14 and the owner's
// test-cost rule): one shape per composition dimension the walk's work must stay bounded over main at, each scaled from
// one size so that the three sizes are two doublings. `tests/type-core-mixed-family.test.ts` runs the first doubling of
// each shape; the queue runs all three against main, the head's work over main's flat (the lead's transport bar).
const CARRIERS = {
  take: (value) => `(${value}).take(9)`,
  index: (value) => `[${value}][0]`,
  get: (value) => `[].get(0, default: ${value})`,
  operand: (value) => `(${value} otherwise null)`,
  fallback: (value) => `(null otherwise ${value})`,
  property: (value) => `{p:${value}}.p`,
  join: (value) => `(${value})+[]`,
};
const nest = (n, wrap = (value) => value) => {
  let first = "[1]";
  let second = '["x"]';
  for (let at = 0; at < n; at += 1) {
    first = wrap(`dict {k:[${first}]}`);
    second = `[dict {k:${second}}]`;
  }
  return [first, second];
};
const dense = (n, wrap) => {
  let first = "[1]";
  let second = '["x"]';
  for (let at = 0; at < n; at += 1) {
    first = wrap(`[${first},null]`);
    second = `[${second}]`;
  }
  return `let xs=[${first},${second}]\nexit\n`;
};
const chain = (n, written) => {
  let type = "integer";
  let first = "1";
  let second = '"x"';
  for (let at = 0; at < n + 1; at += 1) {
    type = `${type}?[]`;
    first = `[${first},null]`;
    second = `[${second}]`;
  }
  for (let at = 0; at < n; at += 1) {
    type += "[]";
    first = `[${first}]`;
  }
  const bind = written ? `let c:${type}=hostValue` : `let c=${first}`;
  return `${bind}\nlet xs=[c${"[0]".repeat(n)},${second}]\nexit\n`;
};
const wide = (k, made) =>
  `let xs=[[${Array.from({ length: k }, (_, at) => made(`[${at}]`)).join(",")}],${Array.from({ length: k }, (_, at) => `[["s${at}"]]`).join(",")}]\nexit\n`;
export const sizes = [16, 32, 64];
export const shapes = {
  // nest depth: the nest alone, and behind a carrier (Astra r2)
  "nest-depth:plain": (size) => {
    const [a, b] = nest((size * 3) / 2);
    return `let xs=[${a},${b}]\nexit\n`;
  },
  "nest-depth:behind": (size) => {
    const [a, b] = nest((size * 3) / 2);
    return `let xs=[[${a}].take(1)[0],[${b}].take(1)[0]]\nexit\n`;
  },
  // join width: a wide operand joined size times (Astra r1), and a wide earliest literal (Codex r9)
  // (four times the size: a join per error read again shows past ×2.5 only from about 64 joins)
  "join-width:take": (size) =>
    `let xs=[[${Array.from({ length: 4 * size }, (_, at) => `[${at}]`).join(",")}].take(${4 * size})]${Array.from({ length: 4 * size }, (_, at) => `+[[["s${at}"]]]`).join("")}\nexit\n`,
  "join-width:earliest": (size) => wide(size, (value) => value),
  // the left-nested otherwise chain (Codex r11)
  "otherwise-chain": (size) =>
    `let n:integer[][]?=[[1]]\nif hostValue == 1 { n=null }\nlet xs=[${"(".repeat(8 * size)}n${") otherwise null".repeat(8 * size)},[["x"]]]\nexit\n`,
  // index-chain length at a written and an inferred copy (Codex r13)
  "index-chain:written": (size) => chain(size / 2, true),
  "index-chain:inferred": (size) => chain(size / 2, false),
  // null density: a null at every layer, alone and under carriers (Codex r13, r14)
  "null-density:plain": (size) => dense((size * 3) / 4, (value) => value),
  "null-density:take": (size) => dense((size * 3) / 4, CARRIERS.take),
  "null-density:index": (size) => dense((size * 3) / 4, CARRIERS.index),
  "null-density:property": (size) => dense((size * 3) / 4, CARRIERS.property),
  "null-density:take-first": (size) => {
    let first = "[1]";
    let second = '["x"]';
    for (let at = 0; at < (size * 3) / 4; at += 1) {
      first = `([null,${first}]).take(9)`;
      second = `[${second}]`;
    }
    return `let xs=[${first},${second}]\nexit\n`;
  },
};
for (const [kind, made] of Object.entries(CARRIERS)) {
  // each carrier kind: deep (a nest behind it), wide (size wrapped elements before as many disagreeing ones)
  shapes[`deep:${kind}`] = (size) => {
    const [a, b] = nest((size * 3) / 4);
    return `let xs=[${made(`[${a}]`)},${made(`[${b}]`)}]\nexit\n`;
  };
  shapes[`wide:${kind}`] = (size) => wide(size, made);
}
// carrier depth: a carrier at every depth of the nest (Codex r12)
for (const kind of ["take", "index", "property"])
  shapes[`every:${kind}`] = (size) => {
    const [a, b] = nest((size * 3) / 4, CARRIERS[kind]);
    return `let xs=[${a},${b}]\nexit\n`;
  };
// (the shapes main itself grows past their bound on, at the second doubling: #1857's, the head's work over main's flat
// there)
export const inherited = {
  "null-density:plain": "#1857",
  "null-density:take": "#1857",
  "null-density:take-first": "#1857",
  "every:take": "#1857",
};
export const recorded = {
  commands: [
    [
      'env -u NODE_OPTIONS node tests/families/shadow.mjs "$SX_TREE" messages --only only.json --out shadow.jsonl',
      "sx-job campaign i1765-records-f036d6734 (job 1106052456376f, tree f036d6734); " +
        "desktop:~/work/evidence/1765-family/f036d6734ec9633b603aec0b143c64fccc2387e8/shadow-growth/out/shadow.jsonl",
    ],
  ],
  sources: 87,
  sha256: "1dd3463cecdd9b56212209478e3227ce8b9990b60c37813da241f0fd637e492e",
};
