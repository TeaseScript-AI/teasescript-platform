// S8c's review (Astra): tally assignments of length 1, 4 and 12, built by its worker's demand-witness.mjs and again by
// its later copy, #1165's astra-b1.mjs (R/astra-m4-s8c-review-evidence/worker/, desktop:~/work/evidence/1165/
// c4866420d9bf0dc376ae373aebee812815e5912c/generators/astra/): the same programs, so one module stands for both runs.
export const cases = [
  ["demand-witness-j0-input1", "let tally = 1\ntally = 2\ntally = hostValue\nlet picked: integer = tally\nrepeat tally {}\nsay \"DONE\"\nexit\n"],
  ["demand-witness-j0-input2", "let tally = 1\ntally = 2\ntally = 3\ntally = 4\ntally = 5\ntally = hostValue\nlet picked: integer = tally\nrepeat tally {}\nsay \"DONE\"\nexit\n"],
  ["demand-witness-j0-input3", "let tally = 1\ntally = 2\ntally = 3\ntally = 4\ntally = 5\ntally = 6\ntally = 7\ntally = 8\ntally = 9\ntally = 10\ntally = 11\ntally = 12\ntally = 13\ntally = hostValue\nlet picked: integer = tally\nrepeat tally {}\nsay \"DONE\"\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node demand-witness.mjs",
      "R/astra-m4-s8c-review-evidence/README.md:16"
    ],
    [
      "ROOT=$base/$t timeout 3600 node $g/astra/astra-b1.mjs > \"$out/b1-$t.jsonl\" 2> \"$out/b1-$t.err\"; echo \"b1 $t exit $?\" >> \"$out/summary.txt\"",
      "desktop:~/work/evidence/1165/c4866420d9bf0dc376ae373aebee812815e5912c/generators/jobs/astra.sh:5"
    ]
  ],
  "sources": 3,
  "sha256": "5737900c9250cdec71d06341e96dd0cc2c79342bc13415e58b05bd976c5e49f8"
};
