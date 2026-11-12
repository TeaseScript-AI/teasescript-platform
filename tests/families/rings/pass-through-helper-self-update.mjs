// A variable set from a pass-through helper, as the converter writes one, and updated from itself (#2486): every pair of
// its axes' values (the helper's call sites and form, its argument, the update, the update's other operand, where the
// update stands, its operator), and every combination of the call sites, the update, its other operand and its operator,
// which together decide whether main's solver settles, in one source at least, chosen greedily from the product; the
// coverage check below fails the module otherwise. `*` has no compound form (V30 has `+=` and `-=` only), so that pair
// is no source. Its run: the oracle sweep and the replay of #2486's pull request.
export const axes = {
  sites: ["once", "twice"],
  helper: ["passOn", "loader"],
  argument: ["constant", "typed load", "fromJson", "built-in", "host"],
  update: ["two operations", "compound", "one operation"],
  other: ["built-in", "constant"],
  place: ["straight", "loop", "goto"],
  operator: ["+", "-", "*"],
};

const ARGUMENT = {
  constant: "0",
  "typed load": 'load "k", default: 0',
  fromJson: 'fromJson(askText("v?"), default: 0)',
  "built-in": "randomInteger(0..3)",
  host: "hostValue",
};
const OTHER = { "built-in": "randomInteger(0..3)", constant: "2" };
const UPDATE = {
  "two operations": (x, op) => `n = n ${op} ${op === "*" ? 2 : 1} ${op} ${x}`,
  compound: (x, op) => `n ${op}= ${x} ${op} 1`,
  "one operation": (x, op) => `n = n ${op} ${x}`,
};
const PASS_ON = "global function passOn(value) {\n  return value\n}\n";
const LOADER =
  "global function loadWhole(key, whenMissing = null) {\n  let value = load key, default: null\n" +
  "  if value == null {\n    return whenMissing\n  }\n  return passOn(toInteger(value))\n}\n";

function source(c) {
  const call = (key, argument) =>
    c.helper === "passOn" ? `passOn(${argument})` : `loadWhole("${key}", ${argument})`;
  const update = UPDATE[c.update](OTHER[c.other], c.operator);
  const placed =
    c.place === "straight"
      ? `${update}\n`
      : c.place === "loop"
        ? `while askBoolean("again?") {\n  ${update}\n}\n`
        : `label again\n${update}\nif askBoolean("again?") {\n  goto again\n}\n`;
  return (
    PASS_ON +
    (c.helper === "loader" ? LOADER : "") +
    (c.sites === "twice" ? `let a = ${call("a", "1")}\n` : "") +
    `let n = ${call("n", ARGUMENT[c.argument])}\n` +
    placed +
    'say "${n}"\nexit\n'
  );
}

const names = Object.keys(axes);
const pairsOf = (c) => [
  ...names.flatMap((a, i) => names.slice(i + 1).map((b) => `${a}=${c[a]}|${b}=${c[b]}`)),
  `sites=${c.sites}|update=${c.update}|other=${c.other}|operator=${c.operator}`,
];
const product = names
  .reduce(
    (done, name) => done.flatMap((c) => axes[name].map((value) => ({ ...c, [name]: value }))),
    [{}],
  )
  .filter((c) => !(c.update === "compound" && c.operator === "*"));
// (greedy: the combination covering the most pairs not yet covered, the first in the product's order on a tie)
const chosen = [];
const covered = new Set();
const every = new Set(product.flatMap(pairsOf));
while (covered.size < every.size) {
  let best = null;
  let gain = 0;
  for (const c of product) {
    const fresh = pairsOf(c).filter((pair) => !covered.has(pair)).length;
    if (fresh > gain) [best, gain] = [c, fresh];
  }
  chosen.push(best);
  for (const pair of pairsOf(best)) covered.add(pair);
}
// the coverage check: every pair of two axes' values, and every combination above, in a chosen source
const missing = [...every].filter((pair) => !chosen.some((c) => pairsOf(c).includes(pair)));
if (missing.length > 0) throw new Error(`pass-through-helper-self-update: uncovered ${missing[0]}`);

export const cases = chosen.map((c) => [names.map((name) => c[name]).join(", "), source(c)]);
export const checks = ["publication"];
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node monotone-sweep.mjs --tree <checkout> --cases cases.jsonl --out family.jsonl (base and head)",
      "~/work/evidence/2486/family/cases.jsonl",
    ],
  ],
  sources: 32,
  sha256: "b9a3b4c34016b239720c497ee0181cf00d86d4cfcffb3b78147d5997f8714464",
};
