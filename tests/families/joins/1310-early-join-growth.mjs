// #1310 (before its rebase onto 6d8f874a7): the repairs' join and own-store families, as growth.mjs ran them at its
// recorded k = 64 and the doubling (desktop:~/work/evidence/1310/e31779d45c8bc60b3426f1c670403156674312a1/
// pre-rebase-6d8f874a7/tools/growth.mjs).
const lines = (k, line) => Array.from({ length: k }, (_, i) => line(i)).join("\n");
const terms = (k, term) => Array.from({ length: k }, (_, i) => term(i)).join(" + ");
export const shapes = {
  // #1272: runs of k joined lists, of one type, ending in another, of objects, nested; k joins and k compound joins
  "join-run": (k) =>
    `let xs = [0]\nlet s = xs + ${terms(k, (i) => `[${i + 1}]`)}\nsay s.length\nexit\n`,
  "join-run-mixed": (k) =>
    `let xs = [0]\nlet s = xs + ${terms(k, (i) => `[${i + 1}]`)} + ["x"]\nsay s.length\nexit\n`,
  "join-run-objects": (k) =>
    `let s = ${terms(k, (i) => `[{n: ${i}, m: "a"}]`)}\nsay s.length\nexit\n`,
  "join-run-nested": (k) => `let s = ${terms(k, (i) => `[[${i}]]`)}\nsay s.length\nexit\n`,
  "join-lines": (k) =>
    `let xs = [0]\n${lines(k, (i) => `let m${i} = xs + [${i}]\nsay m${i}.length`)}\nexit\n`,
  "join-lines-mixed": (k) =>
    `let xs = [0]\n${lines(k, (i) => `let m${i} = xs + ["x"]\nsay m${i}[1] + 1`)}\nexit\n`,
  "join-compound": (k) => `let xs = [0]\n${lines(k, (i) => `xs += [${i}]`)}\nsay xs.length\nexit\n`,
  "join-compound-mixed": (k) =>
    `let xs = [0]\n${lines(k, () => 'xs += ["x"]')}\nsay xs.length\nexit\n`,
  // #1275: k stores below an own selection, with reads between, k objects each stored below, a list's selection stores
  "own-stores": (k) =>
    `let box = {first: {n: 0}, last: {n: 0}}\n${lines(k, (i) => `box.${i % 2 ? "last" : "first"}.n = ${i}`)}\nexit\n`,
  "own-stores-reads": (k) =>
    `let box = {random: {n: 0}}\n${lines(k, (i) => `box.random.n = ${i}\nsay box.random.n + 1`)}\nexit\n`,
  "own-objects": (k) =>
    `${lines(k, (i) => `let b${i} = {first: {n: 0}}\nb${i}.first.n = hostValue`)}\nexit\n`,
  "list-selection-stores": (k) =>
    `let xs = [{n: 0}]\n${lines(k, (i) => `xs.first.n = ${i}`)}\nexit\n`,
  "own-copies": (k) =>
    `let seed = {first: {n: 0}}\n${lines(k, (i) => `let c${i} = seed\nc${i}.first.n = ${i}`)}\nexit\n`,
  // a chain of k own selections, each level settled by its own store from null (Sol's research: one pass per level)
  "own-depth": (k) =>
    `let a = {first: null}\n${lines(k, (i) => `a${".first".repeat(i + 1)} = {first: null}`)}\nexit\n`,
  // review r1: right-nested joins, and k stores of the receiver beside k stores below it
  "join-right-nested": (k) =>
    `let xs = ${Array.from({ length: k }).reduce((e, _, i) => `[${i + 1}] + (${e})`, "[0]")}\nsay xs.length\nexit\n`,
  "own-receiver-history": (k) =>
    `let a = {first: {last: {random: {n: 1}}}}\n${lines(k, () => "a.first.last = {random: {n: 1}}")}\n${lines(k, () => "a.first.last.random.n = 2")}\nexit\n`,
  "join-chain-vars": (k) =>
    `let x0 = [0]\n${lines(k, (i) => `let x${i + 1} = x${i} + [${i}]`)}\nsay x${k}.length\nexit\n`,
};

export const sizes = [64, 128];
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> 64",
      "desktop:~/work/evidence/1310/e31779d45c8bc60b3426f1c670403156674312a1/pre-rebase-6d8f874a7/README.md:10",
    ],
  ],
  sources: 34,
  sha256: "d416aeceb25564a9923bbb0c31e5a29a34b7b89c6524a578b3b9708b2615635c",
};
