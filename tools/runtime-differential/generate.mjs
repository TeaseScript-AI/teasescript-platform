// The differential harness's generator (docs/TESTING.md "Differential harness"), migrated from the research kit of
// I-differential with its compositions and seeds: a deterministic, seeded source per (seed, index), from source facts
// only, with its feature tags, its host values, and its runtime seed. With `project`, the same program is an ordered
// project: its shared values are globals, and its last message is said by a second file it calls.
export const families = [
  "mutation-graph",
  "mutation-graph",
  "capture-container",
  "capture-container",
  "call-capture",
  "call-capture",
  "compound-target",
  "receiver-detachment",
  "loop-copy",
  "scope-reuse",
  "defaults",
  "recursion",
  "wait-call",
  "rng-selectors",
  "borrow-return",
  "collection-methods",
  "fault-order",
  "fault-order",
  "lazy-order",
  "rebase",
  "dict-order",
  "loop-control-wait",
  "parameter-alias",
  "warning-events",
  "lazy-get",
  "expression-tree",
  "expression-tree",
  "host-stores",
  "recursive-wait",
  "wide-calls",
];
export class Choices {
  constructor(seed, index = 0) {
    this.state = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0 || 1;
  }
  next() {
    let s = this.state;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (this.state = s >>> 0);
  }
  int(n) {
    return this.next() % n;
  }
  pick(xs) {
    return xs[this.int(xs.length)];
  }
}
const base = `let root = {v: 1, xs: [1, 2, 3], inner: {v: 2}}
let copy = root
let rows = [[1, 2], [3, 4], [5, 6]]
let marks = [1, 2, 3, 4, 5, 6, 7, 8]
let total = 0
function tick(value = 1) { total += value\nreturn value }
function replace { root = {v: 9, xs: [7, 8, 9], inner: {v: 6}}\nreturn 3 }
function pair(first, second = tick()) { return first + second }
function view(value) { return value }
`;
const finish = `say "\${root.v}:\${root.xs.join(",")}:\${copy.v}:\${copy.xs.join(",")}:\${total}", instant
exit
`;
export function generate(seed, index, requested) {
  const c = new Choices(seed, index),
    family = requested ?? c.pick(families);
  const n = c.int(4) + 1,
    at = c.int(3),
    delay = c.pick(["", "wait 1 ms\n"]);
  let body = "",
    tags = [],
    globals;
  const num = (depth) =>
    depth <= 0
      ? c.pick([
          "root.v",
          "root.xs[0]",
          "marks.length",
          "randomInteger(0..5)",
          "marks.removeFirst()",
          `tick(${n})`,
        ])
      : c.pick([
          () => `(${num(depth - 1)} + ${num(depth - 1)})`,
          () => `(${num(depth - 1)} - ${num(depth - 1)})`,
          () => `root.xs.get(${c.int(5)}, default: ${num(depth - 1)})`,
          () => `[${num(depth - 1)}, ${num(depth - 1)}][0]`,
        ])();
  switch (family) {
    case "mutation-graph": {
      tags = ["references", "copies", "nested-mutation", "evaluation-order"];
      const actions = [
        "root.xs[0] += tick()",
        "root.inner.v = root.xs[1]",
        "copy = root",
        "root = copy",
        "rows[0][1] += tick()",
        "rows[1] = rows[0]",
        "root.xs = rows[0]",
        "root.xs.add(root.inner.v)",
        "root.xs.reverse()",
        "root.xs.sort()",
        "root.v += root.xs.removeFirst()",
        "root.xs.add(tick())",
        "rows[0] = root.xs",
        "root.xs = copy.xs",
        "root.inner = copy.inner",
        "root.xs[0] += root.xs.removeLast()",
      ];
      body = Array.from({ length: 3 + c.int(13) }, () => c.pick(actions)).join("\n") + "\n";
      break;
    }
    case "capture-container": {
      tags = ["references", "copies", "capture", "evaluation-order"];
      body = c.pick([
        "let out = [root, {v: replace(), xs: [1], inner: {v: 1}}]\n",
        "let out = {a: root, b: replace()}\n",
        "let out = [root.xs, [root.xs.removeFirst()]]\n",
        "let out = {a: rows[0], b: rows.removeFirst()}\n",
        "let out = [root, {v: root.xs.removeFirst(), xs: root.xs, inner: root.inner}]\n",
        "let out = dict{a: root, b: {v: replace(), xs: [1], inner: {v: 1}}}\n",
      ]);
      break;
    }
    case "call-capture":
      tags = ["calls", "references", "capture", "copies", "evaluation-order"];
      body = `function capture(a, b) { return a }
let out = capture(${c.pick(["root, replace()", "root.xs, root.xs.removeFirst()", "rows[0], rows.removeFirst()", "b: replace(), a: root"])})
${delay}let again = view(out)
`;
      break;
    case "compound-target":
      tags = ["references", "nested-mutation", "capture", "evaluation-order"];
      body = c.pick([
        "root.v += replace()\n",
        "root.xs[0] += replace()\n",
        "root.xs[tick(0)] += root.xs.removeFirst()\n",
        "rows[0][tick(0)] += rows.removeFirst()[0]\n",
        "root.xs[0] = pair(replace(), tick())\n",
        "root.xs[marks.removeFirst() - 1] += marks.removeFirst()\n",
      ]);
      break;
    case "receiver-detachment":
      tags = ["references", "capture", "evaluation-order", "nested-mutation", "calls"];
      body = c.pick([
        "root.xs.add(replace())\n",
        "root.xs.add(replace())\n",
        "root.xs.add(root.xs.removeFirst())\n",
        "rows[0].add(rows.removeFirst()[0])\n",
        "root.xs.removeAt(pair(0, replace()) - 3)\n",
      ]);
      break;
    case "loop-copy":
      tags = ["loops", "break", "continue", "copies", "nested-mutation", "scopes"];
      body = `for item in ${c.pick(["root.xs", "rows[0]", "[1, 2, 3]"])} {
  if item == 2 { continue }
  root.xs[0] += item
  if item == 3 { break }
  let local = root
  local.xs[0] += ${n}
}
for item in rows { item[0] += 7\ntotal += item[0] }
`;
      break;
    case "scope-reuse":
      tags = ["scopes", "loops", "break", "continue", "calls"];
      body = `function scope(limit) {
 let result = 0
 for index in 0..limit {
  if index == 1 { continue }
  if index == 4 { break }
  if index > 1 { let saved = [index]\nresult += saved[0] }
  let parked = {v: index}
  result += parked.v
 }
 return result
}
repeat ${n} { total += scope(${n + 2}) }
`;
      break;
    case "defaults":
      tags = ["calls", "defaults", "evaluation-order", "capture"];
      body = `function defaults(a = tick(10), b = tick(20), value = root) {
 value.v += 1
 return a + b + value.v
}
let result = ${c.pick(["defaults()", "defaults(b: tick(2))", "defaults(value: root, a: replace())", "defaults(tick(3), b: tick(4))"])}
total += result
`;
      break;
    case "recursion":
      tags = ["calls", "defaults", "recursion", "copies", "scopes", "loops"];
      body = `function recur(depth, value = root) {
 if depth <= 0 { return value }
 let saved = value
 value.v += depth
 for item in 0..2 { if item == 0 { continue }\nsaved = recur(depth - 1, value) }
 return saved
}
let out = recur(${n})
copy = out
`;
      break;
    case "wait-call":
      tags = ["calls", "defaults", "waits", "capture", "copies"];
      body = `function slow(value = root) { wait ${n} ms\nvalue.v += 1\nreturn value }
function waitDefault(a = slow(), b = slow()) { return [a, b] }
let out = waitDefault(${c.pick(["", "b: slow()", "a: root"])})
wait 1 ms
root.v += 1
`;
      break;
    case "rng-selectors":
      tags = ["rng", "references", "evaluation-order", "capture", "nested-mutation"];
      body = c.pick([
        "root.xs[randomInteger(0..3)] += randomInteger(1..10)\n",
        "let out = [root.xs.random, root.xs.random, root.xs.random]\n",
        "let out = [rows.random, rows.random]\nrows.random[0] += randomInteger(1..4)\n",
        'say "${root.xs}:${root.xs}:${root.xs}", instant\n',
        "let out = [root.xs.first, root.xs.last]\nroot.xs.shuffle()\n",
      ]);
      break;
    case "borrow-return":
      tags = ["calls", "copies", "references", "loops", "waits"];
      body = `function readonly(value) { for item in value { if item[0] > 1 { return item } }\nreturn value[0] }
let out = readonly(rows)
${delay}out[0] += ${n}
rows[0][0] += ${n}
let again = readonly(rows)
`;
      break;
    case "collection-methods":
      tags = ["copies", "references", "nested-mutation", "evaluation-order"];
      body = c.pick([
        "let bag = set[[1, 2], [3, 4]]\nlet out = bag.first\nout[0] += 5\nbag.add(out)\n",
        'let bag = dict{a: root, b: copy}\nlet out = bag.values\nout[0].v += 4\nbag["a"].xs.add(5)\n',
        "let out = rows.take(2)\nout[0][0] += 7\n",
        "let out = rows.removeFirst()\nout[0] += 5\n",
        "let out = root.xs.toSet()\nroot.xs.add(1)\nlet again = out.toList()\n",
      ]);
      break;
    case "lazy-order":
      tags = ["rng", "evaluation-order", "calls", "capture"];
      body = `let opt: integer? = ${c.pick(["null", "2"])}
let flag = ${c.pick(["true", "false"])}
let out = flag and tick(3) > 0
let next = flag or tick(4) > 0
let choice = opt otherwise tick(5)
let randomFlag = flag and randomInteger(0..2) == 1
`;
      break;
    case "rebase":
      tags = ["references", "nested-mutation", "capture", "evaluation-order"];
      body = c.pick([
        "rows[1][0] += rows.removeFirst()[0]\n",
        "rows[2][0] = rows.removeFirst()[0]\n",
        "rows[1].add(rows.removeFirst()[0])\n",
        "rows[1][0] += rows.removeLast()[0]\n",
        "rows[1][0] += rows[1].removeFirst()\n",
      ]);
      break;
    case "dict-order":
      tags = ["references", "nested-mutation", "copies", "capture", "evaluation-order"];
      body = `let stock = dict{a: [1, 2], b: [3, 4]}
let saved = stock
${c.pick(['stock["a"][0] += stock["a"].removeFirst()', 'stock["a"][0] = stock["b"].removeFirst()', 'stock["c"] = stock["a"]', 'stock.remove("a")\nstock["a"] = [5, 6]'])}
let keys = stock.keys
let values = stock.values
`;
      break;
    case "loop-control-wait":
      tags = ["loops", "break", "continue", "scopes", "waits", "rng"];
      body = `let counter = 0
while counter < ${n + 2} {
 counter += 1
 if counter == 2 { continue }
 repeat 2 { let local = counter\ntotal += local\nif local > 2 { break } }
 wait 1 ms
 root.xs[randomInteger(0..3)] += 1
}
`;
      break;
    case "parameter-alias":
      tags = ["calls", "defaults", "references", "copies", "nested-mutation", "capture"];
      body = `function change(a, b = a) { a.xs[0] += 1\nb.xs[1] += 2\nreturn [a, b] }
let out = change(root${c.pick(["", ", root", ", b: copy"])})
`;
      break;
    case "warning-events":
      tags = ["events", "evaluation-order", "nested-mutation"];
      body = c.pick([
        "root.xs.remove(99)\n",
        "let missing = 99\nroot.xs.remove(missing)\n",
        "rows.remove([99])\n",
      ]);
      break;
    case "lazy-get":
      tags = ["defaults", "evaluation-order", "rng", "capture", "copies"];
      body = `let index = ${c.pick(["0", "9", "-1"])}
let out = root.xs.get(index, default: ${c.pick(["marks.removeFirst()", "randomInteger(1..10)", "tick(7)"])})
`;
      break;
    case "expression-tree":
      tags = ["references", "copies", "capture", "evaluation-order", "calls", "rng"];
      body = `root.xs[randomInteger(0..3)] += ${num(c.int(3) + 1)}
let result = ${num(c.int(3) + 1)}
total += result
`;
      break;
    case "host-stores":
      tags = ["host-values", "faults", "copies", "nested-mutation"];
      globals = { incoming: c.pick([1, 1.5, "bad", null]) };
      body = c.pick([
        "let strict: integer = 0\nstrict = incoming\n",
        "let strict: integer[] = [1]\nstrict.add(incoming)\n",
        "let strict: integer[] = [1]\nstrict[0] = incoming\n",
        "let strict: integer = 1\nlet carrier = {x: strict}\ncarrier.x = incoming\n",
        "let strict: integer[] = [1]\nlet carrier = {x: strict}\ncarrier.x = [incoming]\n",
      ]);
      break;
    case "recursive-wait":
      tags = ["calls", "defaults", "recursion", "waits", "copies", "capture", "scopes"];
      body = `function descend(depth, value = root) {
 if depth <= 0 { wait 1 ms\nreturn value }
 let saved = [value]
 value.v += depth
 let returned = descend(depth - 1, value)
 wait 1 ms
 saved[0].v += returned.v
 return saved[0]
}
let out = descend(${n})
copy = out
`;
      break;
    case "wide-calls":
      tags = ["calls", "evaluation-order"];
      body = `let out = ${c.pick(["min", "max"])}(${Array.from({ length: 2 + c.int(24) }, (_, i) => "root.v + " + i).join(", ")})
`;
      break;
    case "fault-order":
      tags = ["faults", "evaluation-order", "rng", "nested-mutation"];
      body = c.pick([
        "let bad = randomInteger(6..9)\nroot.xs[bad] = tick() + randomInteger(1..9)\n",
        "let bad = randomInteger(6..9)\nroot.xs[bad] += marks.removeFirst()\n",
        "let zero = randomInteger(0..1)\nroot.v = tick() / zero\n",
        "let empty: integer[] = []\nroot.v = empty.removeFirst() + tick()\n",
        "let bad = randomInteger(6..9)\nroot.xs.removeAt(bad + tick(0))\n",
        "let bad = randomInteger(6..9)\nroot.xs[bad] = marks.removeFirst()\n",
      ]);
      break;
    default:
      throw new Error("unknown family " + family);
  }
  // Independent composition puts retained copies, calls and RNG around the risky operation.
  if (c.int(3) === 0) {
    body = `let before = view(rows)\n${body}rows[${at}][0] += ${n}\n`;
    tags.push("copies", "calls");
  }
  const runtimeSeed = c.next() || 1;
  const source =
    base.replace("v: 1, xs: [1, 2, 3]", `v: ${n}, xs: [${n}, ${n + 1}, ${n + 2}]`) + body;
  const program = {
    id: `${seed}-${index}`,
    seed,
    index,
    family,
    tags: [...new Set(tags)],
    runtimeSeed,
    ...(globals ? { globals } : {}),
  };
  // Drawn after the runtime seed, so that the single sources and their runtime seeds stay the research kit's.
  if (c.int(4) !== 0)
    return { ...program, sources: [{ path: "main.tease", source: source + finish }] };
  const shared = source.replace(/^let (root|copy|total) =/gm, "global $1 =");
  return {
    ...program,
    id: `${program.id}-project`,
    tags: [...program.tags, "project"],
    project: true,
    sources: [
      { path: "main.tease", source: `${shared}call "lib/finish.tease"\nexit\n` },
      { path: "lib/finish.tease", source: finish.replace("exit\n", "end\n") },
    ],
  };
}
