// #1293's review r3: its growth shapes, a ring of k copies of a k-field record fed a conflicting record, with duplicate,
// self, property or empty extra stores, read or not, and a fixed two-member group, at the sizes its three series runs
// reached (submit-growth.sh, quick-growth.sh and submit-dimensions.sh; a run stops a shape at its first budget stop)
// (desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/growth-shapes.mjs, run by series-growth.mjs).
const rows = (k, f) => Array.from({ length: k }, (_, i) => f(i));
const fields = (k, v) => rows(k, (i) => `p${i}:${v}`).join(",");
const ring = (k) => ["let a0=good", ...rows(k - 1, (i) => `let a${i + 1}=a${i}`), `a0=a${k - 1}`];
const extra = (k, kind) =>
  rows(k - 1, (i) =>
    kind === "duplicate"
      ? `a${i + 1}=a${i}`
      : kind === "self"
        ? `a${i + 1}=a${i + 1}`
        : kind === "property"
          ? `a${i + 1}.own=1`
          : `a${i + 1}=empty`,
  );
const shapes = {};
for (const kind of ["duplicate", "self", "property", "empty"])
  for (const conflict of [true, false])
    for (const read of [false, true])
      shapes[`${kind}-${conflict ? "bad" : "quiet"}${read ? "-read" : ""}`] = (k) =>
        [
          "let good={" + fields(k, "1") + "}",
          `let bad={${fields(k, conflict ? '"x"' : "2")}}`,
          "let empty={}",
          ...ring(k),
          ...extra(k, kind),
          "a0=bad",
          ...(read ? rows(k, (i) => `say a${i}.p0`) : []),
          "exit",
        ].join("\n");
// each forwarding store is whole: all members have two stores; only one feed errs, a fixed-size group with k paths
shapes["fixed-bad"] = (k) =>
  [
    "let good={" + fields(k, "1") + "}",
    "let bad={" + fields(k, '"x"') + "}",
    ...ring(2),
    ...extra(2, "duplicate"),
    "a0=bad",
    "exit",
  ].join("\n");
const SIZES = {
  "duplicate-bad": [8, 16, 32, 64],
  "duplicate-bad-read": [8, 16, 32],
  "self-bad": [8, 16, 32, 64, 128],
  "self-bad-read": [8, 16, 32, 64, 128],
  "property-bad": [8, 16],
  "property-bad-read": [8, 16],
  "empty-bad": [8, 16, 32, 64, 128],
  "empty-bad-read": [8, 16, 32, 64, 128],
  "empty-quiet": [8, 16, 32, 64, 128],
  "fixed-bad": [8, 16, 32, 64, 128],
};
export const cases = Object.entries(SIZES).flatMap(([name, sizes]) =>
  sizes.map((k) => [`${name}@${k}`, shapes[name](k)]),
);

// the globals the recorded runs passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'SX_HEAVY_MEM=2G sx-queue add --name "i1249r3-growth-$tree" --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-growth-$tree-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 900 node "$root/series-growth.mjs" "$root/$tree" duplicate-bad,duplicate-bad-read,duplicate-quiet,self-bad,property-bad,empty-bad,fixed-bad 8,16,32,64 "$root/results/growth-$tree.jsonl" src-on || exit 1',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-growth.sh:4",
    ],
    [
      'SX_HEAVY_MEM=2G sx-queue add --name "i1249r3-growth2-$tree" --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-growth2-$tree-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 900 node "$root/series-growth.mjs" "$root/$tree" empty-bad,empty-bad-read,empty-quiet,self-bad,self-bad-read,property-bad,property-bad-read,fixed-bad 8,16 "$root/results/growth2-$tree.jsonl" src-on || exit 1',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/quick-growth.sh:4",
    ],
    [
      'SX_HEAVY_MEM=2G sx-queue add --name "i1249r3-dimensions-$tree" --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-dimensions-$tree-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 900 node "$root/series-growth.mjs" "$root/$tree" empty-bad,empty-bad-read,self-bad,self-bad-read,empty-quiet,fixed-bad 32,64,128 "$root/results/dimensions-$tree.jsonl" src-on || exit 1',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-dimensions.sh:4",
    ],
  ],
  sources: 41,
  sha256: "179631c9f15e92ff66d7ee843418efae5983b65fab02345cce2367cb7e064630",
};
