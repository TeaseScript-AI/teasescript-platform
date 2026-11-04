// node tests/families/seeded.mjs <base tree> <head tree> <first seed> <count>
// A seeded family on two trees (#1652's builder, for #1646): each seed's program, objects copied into each other's
// properties and lists then a host value stored below them, compiled on both built trees (`dist/`) in the source order;
// per seed one JSON line with each tree's units (every `WorkLedger.charge`) and whether the outcomes (each diagnostic's
// code and offset and the plan's checks, or a thrown error's name and message) are the same, and both outcomes and the
// source where they differ. A mutant runs it against its own tree (`seeded-mutant.sh`, README "A seeded family").
import path from "node:path";
import { pathToFileURL } from "node:url";

const [baseRoot, headRoot, firstText, countText] = process.argv.slice(2);
const [first, count] = [Number(firstText), Number(countText)];
if (headRoot === undefined || !Number.isInteger(first) || !Number.isInteger(count) || count < 1) {
  process.stderr.write(
    "usage: node tests/families/seeded.mjs <base tree> <head tree> <first seed> <count>\n",
  );
  process.exit(2);
}

/** A built tree's compiler and backend, its ledger charges counted in `units`. */
async function load(root) {
  const load = (file) => import(pathToFileURL(path.join(root, "dist", file)).href);
  const tree = {
    compiler: await load("src/compiler.js"),
    backend: await load("src/type-inference/core/backend.js"),
    units: 0,
  };
  const { WorkLedger } = await load("src/type-inference/core/budget.js");
  const { charge } = WorkLedger.prototype;
  WorkLedger.prototype.charge = function (counter, units = 1) {
    tree.units += units;
    return charge.call(this, counter, units);
  };
  return tree;
}

/** mulberry32: the seed's numbers in [0, 1). */
const numbers = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The seed's program: two to four objects, two to six copies among them, a host value stored below one. */
function program(seed) {
  const next = numbers(seed);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const names = Array.from({ length: 2 + Math.floor(next() * 3) }, (_, i) => `p${i}`);
  const lines = ["let typed:object={x:1}"];
  for (const p of names)
    lines.push(
      pick([`let ${p}={f:[[1]],g:1}`, `let ${p}={f:typed,g:"s"}`, `let ${p}={g:2}`, `let ${p}={}`]),
    );
  const steps = 2 + Math.floor(next() * 5);
  for (let i = 0; i < steps; i += 1) {
    const [a, b] = [pick(names), pick(names)];
    const property = pick(["q", "q", "s"]);
    lines.push(
      pick([
        `${a}.${property}=${b}`,
        `${a}.${property}={r:${b}}`,
        `${a}.${property}=[${b}]`,
        `${a}=${b}`,
        `${a}.${property}=${b}.${pick(["q", "s", "g"])}`,
        `${a}.${property}.${pick(["q", "s"])}=${b}.${pick(["q", "s"])}`,
        `${a}=${b}.${pick(["q", "s"])}`,
        `${a}.${property}=[{r:1},{r:${b}}][${pick(["0", "1"])}].r`,
      ]),
    );
  }
  lines.push(`${pick(names)}.f=hostValue`);
  if (next() < 0.5) lines.push(`let out={p:${pick(names)}}`, "out.p.g=hostOther");
  return `${lines.join("\n")}\nsay "AFTER"\nexit\n`;
}

/** A tree's outcome of a source and the units it charged. */
function outcome(tree, source) {
  tree.units = 0;
  let text;
  try {
    const { diagnostics, plan } = tree.compiler.compileSourceWithBackend(
      source,
      { globals: ["hostValue", "hostOther"] },
      tree.backend.CORE_BACKEND,
    );
    text = JSON.stringify([
      diagnostics.map((d) => [d.code, d.span?.start?.offset ?? null]),
      (plan?.instructions ?? []).filter((each) => each.typeCheck).map((each) => each.typeCheck),
    ]);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    text = `${error.name}: ${error.message}`;
  }
  return { text, units: tree.units };
}

const trees = { base: await load(baseRoot), head: await load(headRoot) };
for (let seed = first; seed < first + count; seed += 1) {
  const source = program(seed);
  const [base, head] = [outcome(trees.base, source), outcome(trees.head, source)];
  const same = base.text === head.text;
  console.log(
    JSON.stringify({
      seed,
      same,
      units: [base.units, head.units],
      ...(same ? {} : { base: base.text.slice(0, 300), head: head.text.slice(0, 300), source }),
    }),
  );
}
