// #1268's review r4 (Astra): the guard cases it read in both polarities, name and index guards at a say, a repeat and a
// condition, each with its element index flipped (R/astra-m4-i1268-review-r4-evidence/polarity.mjs over its own
// case-results.json).
export const cases = [
  ["guard-name-say/analysis", "let a = [7, null]\nlet n = a[0]\nsay 2 * n\nexit\n"],
  [
    "guard-name-say/compile/check",
    "let a = [7, null]\nlet n = a[0]\nif n != null { say 2 * n }\nexit\n",
  ],
  [
    "guard-name-say/compile/fallback",
    "let a = [7, null]\nlet n = a[0]\nsay 2 * (n otherwise 0)\nexit\n",
  ],
  ["guard-name-repeat/analysis", 'let a = [7, null]\nlet n = a[0]\nrepeat n { say "r" }\nexit\n'],
  [
    "guard-name-repeat/compile/check",
    'let a = [7, null]\nlet n = a[0]\nif n != null { repeat n { say "r" } }\nexit\n',
  ],
  [
    "guard-name-repeat/compile/fallback",
    'let a = [7, null]\nlet n = a[0]\nrepeat n otherwise 0 { say "r" }\nexit\n',
  ],
  [
    "guard-name-condition/analysis",
    'let a = [7, null]\nlet n = a[0]\nif n <= 7 { say "yes" }\nexit\n',
  ],
  [
    "guard-name-condition/compile/check",
    'let a = [7, null]\nlet n = a[0]\nif n != null { if n <= 7 { say "yes" } }\nexit\n',
  ],
  [
    "guard-name-condition/compile/fallback",
    'let a = [7, null]\nlet n = a[0]\nif (n otherwise 0) <= 7 { say "yes" }\nexit\n',
  ],
  ["guard-index-say/analysis", "let a = [7, null]\nsay 2 * a[0]\nexit\n"],
  [
    "guard-index-say/compile/check",
    "let a = [7, null]\nlet value = a[0]\nif value != null { say 2 * value }\nexit\n",
  ],
  ["guard-index-say/compile/fallback", "let a = [7, null]\nsay 2 * (a[0] otherwise 0)\nexit\n"],
  ["guard-index-repeat/analysis", 'let a = [7, null]\nrepeat a[0] { say "r" }\nexit\n'],
  [
    "guard-index-repeat/compile/check",
    'let a = [7, null]\nlet value = a[0]\nif value != null { repeat value { say "r" } }\nexit\n',
  ],
  [
    "guard-index-repeat/compile/fallback",
    'let a = [7, null]\nrepeat a[0] otherwise 0 { say "r" }\nexit\n',
  ],
  ["guard-index-condition/analysis", 'let a = [7, null]\nif a[0] <= 7 { say "yes" }\nexit\n'],
  [
    "guard-index-condition/compile/check",
    'let a = [7, null]\nlet value = a[0]\nif value != null { if value <= 7 { say "yes" } }\nexit\n',
  ],
  [
    "guard-index-condition/compile/fallback",
    'let a = [7, null]\nif (a[0] otherwise 0) <= 7 { say "yes" }\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "systemd-run --user --scope --quiet --unit=astra-i1268r4-polarity -p MemoryMax=2G -p MemorySwapMax=0 timeout 180m /home/peter/opt/node-24.18/bin/node polarity.mjs",
      "R/astra-m4-i1268-review-r4-evidence/COMMANDS.txt:53",
    ],
  ],
  sources: 18,
  sha256: "63cb9c779c484d22f07a8b0cb5563ea202c52d72e8adcbf45e2269841550b376",
};
