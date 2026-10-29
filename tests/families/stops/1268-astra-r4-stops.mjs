// #1268; Astra review.
export const cases = (() => {
  const cases = [
    [
      "set-hidden",
      'function identity(v) { return v }\nlet checked: integer = hostValue\nlet amount: integer? = identity(null)\nlet bag: integer set = set["x", amount * 3]\nexit\n',
    ],
    [
      "list-hidden",
      'function nothing { return null }\nlet checked: integer = hostValue\nlet bag: integer[] = ["x", nothing() * 3]\nexit\n',
    ],
    [
      "dict-hidden",
      'function identity(v) { return v }\nlet checked: integer = hostValue\nlet amount: integer? = identity(null)\nlet bag: integer dict = dict{a:"x", b:amount * 3}\nexit\n',
    ],
    [
      "function-region",
      'function show(v) {\n  let data: integer[] = ["x"]\n  say v + 2\n  return data\n}\nlet data: integer[] = ["x"]\nsay show(hostValue)\nexit\n',
    ],
    [
      "function-check",
      "function show(v) {\n  let data = [5,null]\n  say data[1] * 2\n  say v + 2\n  return 3\n}\nlet data = [5,null]\nsay data[1] * 2\nsay show(hostValue)\nexit\n",
    ],
    [
      "nested-check",
      "function show(v) {\n if true {\n  let data = [5,null]\n  say data[1] * 2\n  say v + 2\n }\n return 3\n}\nsay show(hostValue)\nexit\n",
    ],
    [
      "member-warning",
      'let caption = " Ab "\nsay caption.toUpperCase()\nsay hostValue + 2\nexit\n',
    ],
    ["own-site", "let duration = 2 s\nsay 7 / duration.seconds\nsay hostValue + 2\nexit\n"],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
