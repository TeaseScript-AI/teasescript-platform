// #1293's review r3: its fair growth, the empty and self rings of growth-shapes.mjs fed a conflicting record at 16, 32
// and 64, unread, read once at each member, read at every field, or both
// (desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/fair-growth.mjs).
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
export const cases = ["empty", "self"].flatMap((kind) =>
  [16, 32, 64].flatMap((k) =>
    ["unread", "read-one-each", "read-width", "read-width-and-members"].map((variant) => {
      const reads = [];
      if (variant.includes("width")) for (let i = 0; i < k; i++) reads.push(`say a0.p${i}`);
      if (variant === "read-one-each" || variant === "read-width-and-members")
        for (let i = 0; i < k; i++) reads.push(`say a${i}.p0`);
      return [
        `${kind}/${k}/${variant}`,
        shapes[`${kind}-bad`](k).replace("\nexit", "\n" + reads.join("\n") + "\nexit"),
      ];
    }),
  ),
);

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'SX_HEAVY_MEM=2G sx-queue add --name i1249r3-fair --priority 2 --dir "$root" -- systemd-run --user --scope --quiet --unit="i1249r3-fair-$$" -p MemoryMax=2G -p MemorySwapMax=0 timeout 300 node "$root/fair-growth.mjs" "$root" "$root/results/fair-growth.jsonl"',
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-fair.sh:3",
    ],
  ],
  sources: 24,
  sha256: "f19af7758683a7a93c1e9bcaf522c6e81fb6f4125c77411adf633c0330aba834",
};
