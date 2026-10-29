// nine original askInteger admission controls; experimental askRating inputs excluded; 3a model, builder
// (R/3a-newcore/checkpoint-9/port-plan/extensibility/s6/admission-trial.mjs).
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

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node admission-trial.mjs (no command recorded: its run without arguments)",
      "R/3a-newcore/checkpoint-9/port-plan/extensibility/s6/admission-trial.mjs",
    ],
  ],
  sources: 18,
  sha256: "7f93b596a59761af983aa9af45579bb1e836c8874e08e3ef89703ba593169b12",
  dropped: [
    [
      "b4c607830cd0b6eaddadebacd25afcbe2321db272ae5e646a78864af045b6498",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
    [
      "c5f97b2e2acdae5acb38e8bb5e1fb440823c3c896b1964643932e32010e2fdef",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
    [
      "994d0ab9bb6807f0d4d3c76e53a0fe0d77e27cdeb0c6bb711ec0d2d0e5478f6c",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
    [
      "b0f389d41a6d46a0bb4493a594f74bf9a6a75039f503c4e52edf597cf562f992",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
    [
      "6d0a8f10555fb26b421c6f4475361e9609477f729ace9e6d8df5dbe988e70246",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
    [
      "c281fc4a1839df78a34af31e349a084ad86e9c2220865150ae1b7447d80b052e",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
    [
      "1b46620e6a0117eb6a353fa9372cca157b59bfc6f7a7f169ddbfd36ae4d8338e",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
    [
      "30069e3745a3f00c7cc6e689dfe372689d284ce7202f82cb0ec4cae6063cae21",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
    [
      "747e531c3cada220920b9c88fa3d569f76f10723a50e0938573c365c138d95e5",
      "Experimental askRating syntax is not accepted on main; the trial compares the new rating category with askInteger, not a parser error. (undefined)",
    ],
  ],
};
