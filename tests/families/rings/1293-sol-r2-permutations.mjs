// r2 repeated/('good', 'bad', 'bad')/[2, 0, 1]/True, r2 repeated/('good', 'flag', 'flag')/[2, 0, 1]/True and related
// fixed cases; #1293 A2 / G5 Sol reconstruction, r1 (R/sol-m4-admission-design-g5-r1-evidence/r2-permutations.json).
const archivedCases = [
  [
    "r2 repeated/('good', 'bad', 'bad')/[2, 0, 1]/True",
    'let good={n:1}\nlet bad={n:"x"}\nlet flag={n:true}\nlet a2=bad\nlet a0=good\nlet a1=bad\na2=a0\na1=a2\na0=a1\nexit',
  ],
  [
    "r2 repeated/('good', 'flag', 'flag')/[2, 0, 1]/True",
    'let good={n:1}\nlet bad={n:"x"}\nlet flag={n:true}\nlet a2=flag\nlet a0=good\nlet a1=flag\na2=a0\na1=a2\na0=a1\nexit',
  ],
  [
    "r2 repeated/('bad', 'good', 'good')/[2, 0, 1]/True",
    'let good={n:1}\nlet bad={n:"x"}\nlet flag={n:true}\nlet a2=good\nlet a0=bad\nlet a1=good\na2=a0\na1=a2\na0=a1\nexit',
  ],
  [
    "r2 repeated/('bad', 'flag', 'flag')/[2, 0, 1]/True",
    'let good={n:1}\nlet bad={n:"x"}\nlet flag={n:true}\nlet a2=flag\nlet a0=bad\nlet a1=flag\na2=a0\na1=a2\na0=a1\nexit',
  ],
  [
    "r2 repeated/('flag', 'good', 'good')/[2, 0, 1]/True",
    'let good={n:1}\nlet bad={n:"x"}\nlet flag={n:true}\nlet a2=good\nlet a0=flag\nlet a1=good\na2=a0\na1=a2\na0=a1\nexit',
  ],
  [
    "r2 repeated/('flag', 'bad', 'bad')/[2, 0, 1]/True",
    'let good={n:1}\nlet bad={n:"x"}\nlet flag={n:true}\nlet a2=bad\nlet a0=flag\nlet a1=bad\na2=a0\na1=a2\na0=a1\nexit',
  ],
];
export const cases = archivedCases;
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node matrix.mjs <root> cases.json (four trees, four modes)",
      "desktop:~/work/evidence/1293/7d6c5fb2f/review-r3/submit-matrix.sh:3",
    ],
    [
      "its six `r2 repeated/` cases with their head rows, as Sol kept them (r2-permutations.json)",
      "R/sol-m4-admission-design-g5-r1-evidence/collect.py:68-71",
    ],
  ],
  sources: 6,
  sha256: "6436801e206edffa5dc8f5190031f61996cd57467c6599580662c76e1e087011",
};
