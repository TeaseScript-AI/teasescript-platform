// 3a model builder.
export const cases = (() => {
  const programs = [
    ["A2: the ask decides, a number widens it", "let r = RATE\nr = 2.5\nexit\n"],
    ["A6: a text into the place the ask decides", 'let r = RATE\nr = "x"\nexit\n'],
    [
      "A6: the rejected store leaves the count a whole number",
      'let r = RATE\nr = "x"\nrepeat r {}\nexit\n',
    ],
    ["A2: a whole number decides, the ask fits", "let r = 1\nr = RATE\nrepeat r {}\nexit\n"],
    ["A6: the ask into a place text decides", 'let s = "a"\ns = RATE\nexit\n'],
    ["A8: the ask beside text in one literal", 'let xs = [RATE, "b"]\nexit\n'],
    ["C1: the ask into a written text", "let n: string = RATE\nexit\n"],
    [
      "A5, A6: a list the ask's add decides",
      'let rated = []\nrated.add(RATE)\nrated.add("x")\nrepeat rated.first {}\nexit\n',
    ],
    [
      "A7: a copy before the ask decides",
      "let v = null\nlet copy = v\nv = RATE\ncopy = 1.5\nexit\n",
    ],
  ];
  return programs.map(([name, source]) => [name, source.replaceAll("RATE", 'askInteger "Rate"')]);
})();
export const checks = ["publication"];
