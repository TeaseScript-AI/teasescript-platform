// #1310's Codex r11 N2: its growth families for the stopped-key stores' scans, a record replaced and its selection
// stored k times, an inner record likewise, k independent keys and k adds to one list, at 32 to 256
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/cost-n2.mjs).
const make = {
  "one-root-and-selections": (n) => [
    "let box = {first: {n: 1}}",
    ...Array.from({ length: n }, (_, i) => `box = {first: {n: ${i + 2}}}`),
    ...Array.from({ length: n }, (_, i) => `box.first.n = ${i + 2}`),
  ],
  "one-inner-and-selections": (n) => [
    "let box = {last: {inner: {n: 1}}}",
    ...Array.from({ length: n }, (_, i) => `box.last.inner = {n: ${i + 2}}`),
    ...Array.from({ length: n }, (_, i) => `box.last.inner.n = ${i + 2}`),
  ],
  "independent-keys": (n) => Array.from({ length: n }, (_, i) => `let box${i} = {first: {n: 1}}\nbox${i}.first.n = ${i + 2}`),
  "one-add-key": (n) => ["let xs = [1]", ...Array.from({ length: n }, (_, i) => `xs.add(${i + 2})`)],
};
export const shapes = Object.fromEntries(
  Object.entries(make).map(([name, lines]) => [name, (n) => lines(n).concat(['say "DONE"', "exit"]).join("\n") + "\n"]),
);

export const sizes = [32, 64, 128, 256];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "SX_HEAVY_MEM=4G sx-queue add --priority 1 --name \"i1272c2-cost\" --dir $W/c2 -- bash -c \"$P; timeout 60m node $T/cost-n2.mjs $O/ev/cost-n2.jsonl 32,64,128,256 $W/c1 $W/c2 > $O/ev/cost-n2.log 2>&1; echo exit=\\$? >> $O/ev/cost-n2.log\"",
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-c2.sh:26"
    ]
  ],
  "sources": 16,
  "sha256": "4165f0276526dd3f2d8909b7ef4bfb8d39e9477956f1216a7f5ffea5f2e567ac"
};
