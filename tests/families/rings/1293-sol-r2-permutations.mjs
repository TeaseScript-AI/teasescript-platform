// Retained source cases from sol-m4-admission-design-g5-r1-evidence/r2-permutations.json.
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
