// #1165's finishing growth: shapes that could make part 3's finishing superlinear (repeated stores, record replacements
// and field stores at 1,024 and 2,048; deep lists, records and a typed parse's nested default at 128 and 256), each
// closed by `say "AFTER"` (desktop:~/work/evidence/1165/dbefff11c5dff5590c1b00b2dd0680824bf32e75/generators/tools/
// finish-growth.mjs), run by the builder and again in S8c's review: the same programs, one module for both runs.
const SHAPES = {
  repeated: [[1024, 2048], (n) => "let b = 1\n" + "b = 2\n".repeat(n) + "b = hostValue\n"],
  fields: [
    [1024, 2048],
    (n) =>
      "let b = {f0: 1}\n" +
      Array.from({ length: n }, (_, i) => `b = {f${i}: ${i}}\n`).join("") +
      "b = hostValue\n",
  ],
  fieldStores: [
    [1024, 2048],
    (n) =>
      "let b = {f0: 1}\n" +
      Array.from({ length: n }, (_, i) => `b.f${i} = ${i}\n`).join("") +
      "b = hostValue\n",
  ],
  deep: [[128, 256], (n) => `let b = ${"[".repeat(n)}1${"]".repeat(n)}\nb = hostValue\n`],
  deepRecord: [[128, 256], (n) => `let b = ${"{a: ".repeat(n)}1${"}".repeat(n)}\nb = hostValue\n`],
  // a typed parse's nested default, read below its default's literal
  nestedDefault: [
    [128, 256],
    (n) =>
      `let v = fromJson(hostValue, default: ${"{a: ".repeat(n)}1${"}".repeat(n)})\nsay v${".a".repeat(n)}\n`,
  ],
};
export const cases = Object.entries(SHAPES).flatMap(([name, [sizes, make]]) =>
  sizes.map((n) => [`${name}/${n}`, make(n) + 'say "AFTER"\nexit\n']),
);

// the globals the recorded runs passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node "$r6g/tools/finish-growth.mjs" "$base/$t" > "$out/finish-growth-$t.jsonl" 2> "$out/finish-growth-$t.err"; echo "finish-growth $t exit $?" >> "$out/summary.txt"',
      "desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/families.sh:7",
    ],
    [
      'node "$g/finish-growth.mjs" "$base/head" > "$out/finish-growth-head.jsonl" 2> "$out/finish-growth-head.err"',
      "R/astra-m4-s8c-review-evidence/builder/generators/jobs/families.sh:12",
    ],
    [
      'node "$g/finish-growth.mjs" "$base/main" > "$out/finish-growth-main.jsonl" 2> "$out/finish-growth-main.err"',
      "R/astra-m4-s8c-review-evidence/builder/generators/jobs/families.sh:14",
    ],
  ],
  sources: 12,
  sha256: "a9901535b3691c5076745fea502bfd21bea45dfd064e0f16688f1cd1999f212e",
};
