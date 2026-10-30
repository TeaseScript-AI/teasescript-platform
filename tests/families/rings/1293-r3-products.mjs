// #1293's review r3: its product probes, a ring of k copies of a record with k or k² fields, every member but the first
// replaced by an empty record and the first fed a conflicting record, read at each member or not, at the k each probe
// ran (desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/product.mjs, product-modes.mjs, product-source.mjs,
// delta-product.mjs, budget-product.mjs and profile-product.mjs: one construction, so one module for their six runs).
function product(k, width, read) {
  const fields = (v) => Array.from({ length: width }, (_, i) => `p${i}:${v}`).join(",");
  const lines = [
    `let good={${fields("1")}}`,
    `let bad={${fields('"x"')}}`,
    "let a0=good",
    ...Array.from({ length: k - 1 }, (_, i) => `let a${i + 1}=a${i}`),
    `a0=a${k - 1}`,
    ...Array.from({ length: k - 1 }, (_, i) => `a${i + 1}={}`),
    "a0=bad",
  ];
  if (read) lines.push(...Array.from({ length: k }, (_, i) => `say a${i}.p0`));
  lines.push("exit");
  return lines.join("\n");
}
// [k, fields k², read]: the union of the six runs' programs
const RUNS = [
  [8, false, false],
  [8, true, false],
  [8, true, true],
  [16, false, false],
  [16, false, true],
  [16, true, false],
  [16, true, true],
  [32, false, false],
  [32, false, true],
  [32, true, false],
  [32, true, true],
  [52, true, false],
];
export const cases = RUNS.map(([k, squared, read]) => [
  `${k}/${squared ? "k2" : "k"}/${read ? "read" : "unread"}`,
  product(k, squared ? k * k : k, read),
]);

// the globals the recorded runs passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'SX_HEAVY_MEM=2G sx-queue add --name i1249r3-product --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-product-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 900 node "$root/product.mjs" "$root" "$root/results/product.jsonl"',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-product.sh:3",
    ],
    [
      'SX_HEAVY_MEM=2G sx-queue add --name "i1249r3-product-$group" --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-product-$group-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 300 node "$root/product-$group.mjs" "$root" "$root/results/product-$group.jsonl" || exit 1',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-product2.sh:4",
    ],
    [
      'SX_HEAVY_MEM=2G sx-queue add --name i1249r3-delta-product --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-delta-product-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 300 node "$root/delta-product.mjs" "$root" "$root/results/delta-product.jsonl"',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-delta-product.sh:8",
    ],
    [
      'SX_HEAVY_MEM=2G sx-queue add --name i1249r3-budget-product --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-budget-product-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 180 node "$root/budget-product.mjs" "$root" "$root/results/budget-product.jsonl"',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-budget-product.sh:3",
    ],
    [
      'SX_HEAVY_MEM=2G sx-queue add --name i1249r3-profile --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-profile-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 300 node "$root/profile-product.mjs" "$root" "$root/results/profile-product.jsonl"',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-profile.sh:3",
    ],
  ],
  sources: 12,
  sha256: "2ce86effcb9af7fc30936cfc56add702ef467b21d41be3e0375936073c6011e3",
};
