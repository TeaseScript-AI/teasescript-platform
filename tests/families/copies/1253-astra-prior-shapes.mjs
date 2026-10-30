// #1253's review (Astra): the prior fallback shapes (chain, every, siblings, wide, mixed, file) at 4, the siblings also
// at 16 and 32 (R/astra-m4-i1253-review-evidence/prior-shapes.mjs).
export const cases = [
  ["63-chain4/1", "let parcel: object = fromJson(hostValue, default: {next: {next: {next: {next: {score: 4}}}}}, files: false)\nsay \"complete\"\nexit\n"],
  ["63-every4/1", "let parcel: object = fromJson(hostValue, default: {next: {next: {next: {next: {score: 4},score: 4},score: 4},score: 4},score: 4}, files: false)\nsay \"complete\"\nexit\n"],
  ["63-siblings4/1", "let parcel: object = fromJson(hostValue, default: {left: {next: {next: {next: {next: {score: 4}}}}},right: {next: {next: {next: {next: {score: 4}}}}}}, files: false)\nsay \"complete\"\nexit\n"],
  ["63-wide4/1", "let parcel: object = fromJson(hostValue, default: {score: 4,missing: [1,2]}, files: false)\nsay \"complete\"\nexit\n"],
  ["63-mixed4/1", "let parcel: object = fromJson(hostValue, default: {bad: 4,rows: [{items: [{items: [{items: [{items: [{score: 4}]}]}]}]}]}, files: false)\nsay \"complete\"\nexit\n"],
  ["63-file4/1", "let parcel: object = fromJson(hostValue, default: {score: 4}, files: false)\nsay \"complete\"\nexit\n"],
  ["63-siblings16/1", "let parcel: object = fromJson(hostValue, default: {left: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {score: 4}}}}}}}}}}}}}}}}},right: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {score: 4}}}}}}}}}}}}}}}}}}, files: false)\nsay \"complete\"\nexit\n"],
  ["63-siblings32/1", "let parcel: object = fromJson(hostValue, default: {left: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {score: 4}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}},right: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {next: {score: 4}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}}, files: false)\nsay \"complete\"\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "add prior-$family-4 node prior-shapes.mjs \"$root\" \"$family\" 4",
      "R/astra-m4-i1253-review-evidence/queue-initial.sh:10"
    ],
    [
      "SX_HEAVY_MEM=2G SX_HEAVY_SWAP=0 sx-queue add --name astra-i1253-prior-siblings-$n --priority 2 --dir \"$root\" -- timeout 180m bash \"$root/run-job.sh\" prior-siblings-$n node prior-shapes.mjs \"$root\" siblings \"$n\"",
      "R/astra-m4-i1253-review-evidence/queue-helper-series.sh:10"
    ]
  ],
  "sources": 8,
  "sha256": "5cd9e87f5465a8bfea3306b57250181a79fe75d7ef4cb96669fe18f065a1ecb7"
};
