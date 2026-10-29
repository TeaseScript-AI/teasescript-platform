export const cases = [
  [
    "original-1",
    "let seed = {a: 1}\nlet picked = seed\nif hostFlag { picked = seed }\nif hostFlag { picked = seed }\nlet n: integer = picked.a",
  ],
  [
    "another contribution tested",
    "let seed = {n: 1.5, m: 2.5}\nlet a = seed\nif seed.n is integer { a = seed }\nlet b = seed\nif hostFlag { b = seed }\nlet x: integer = b.n\nexit",
  ],
  [
    "no contribution tested",
    "let seed = {n: 1.5, m: 2.5}\nlet a = seed\nif hostFlag { a = seed }\nlet b = seed\nif hostFlag { b = seed }\nlet x: integer = b.n\nexit",
  ],
  [
    "the untested field",
    "let seed = {n: 1.5, m: 2.5}\nlet a = seed\nif seed.n is integer { a = seed }\nlet b = seed\nif hostFlag { b = seed }\nlet x: integer = b.m\nexit",
  ],
];

export const checks = ["publication"];

export const globals = ["hostValue", "hostOther", "hostInit", "otherHost", "hostFlag"];
