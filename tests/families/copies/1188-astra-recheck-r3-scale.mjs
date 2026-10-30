// #1188's design recheck r3 (Astra): n typed fields of one shared record, each wrapped in a list beside a false field,
// relayed through a record and read back beside the shared one, at 16, 32 and 64 and the recorded extra 128
// (R/astra-m4-i1188-design-recheck-r3-evidence/scale.mjs).
function source(n) {
  const fields = Array.from({ length: n }, (_, i) => `f${i}:typed`).join(",");
  const lines = ["let typed:integer=17", `let shared={${fields}}`];
  for (let i = 0; i < n; i++)
    lines.push(
      `let inner${i}=[{f${i}:false},shared]`,
      `let wrap${i}={value:inner${i}}`,
      `let relay${i}=wrap${i}`,
      `let final${i}=[relay${i}.value.first,shared]`,
    );
  return lines.concat("exit").join("\n");
}
export const shapes = { scale: source };

export const sizes = [16, 32, 64, 128];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node \"$review_root/scale.mjs\" \"$review_root/$variant-d93-review\" \"$order\" \"$review_root/out/scale-$variant-$order.jsonl\"",
      "R/astra-m4-i1188-design-recheck-r3-evidence/last-queue.sh:16"
    ],
    [
      "node \"$review_root/scale.mjs\" \"$review_root/$variant-d93-review\" \"$order\" \"$review_root/out/scale128-$variant-$order.jsonl\" 128",
      "R/astra-m4-i1188-design-recheck-r3-evidence/scale128-queue.sh:10"
    ]
  ],
  "sources": 4,
  "sha256": "db9bd25e01ca630287325adee6bc09259998dc449e2cfd17c94c4642501e4051"
};
