export const cases = [
  ["original-1", 'let d = dict{found: [1]}\nsay d["absent"] + 2\nexit\n'],
  ["original-2", 'let d = dict{found: 2}\nlet delay: duration = d["absent"]\nsay delay\nexit\n'],
  ["original-3", 'let d = dict{found: [1]}\nsay d["found"] + 2\nexit\n'],
  ["original-4", 'let d = dict{found: 2}\nlet delay: duration = d["found"]\nsay delay\nexit\n'],
  ['archived paste/d["absent"] + [2]', 'let d = dict{found: [1]}\nsay d["absent"] + [2]\nexit\n'],
  [
    'archived paste/d["absent"].add(2)',
    'let d = dict{found: [1]}\nd["absent"].add(2)\nsay d["absent"]\nexit\n',
  ],
  ['archived paste/d["found"] + [2]', 'let d = dict{found: [1]}\nsay d["found"] + [2]\nexit\n'],
  [
    'archived paste/d["found"].add(2)',
    'let d = dict{found: [1]}\nd["found"].add(2)\nsay d["found"]\nexit\n',
  ],
];

export const checks = ["publication"];
