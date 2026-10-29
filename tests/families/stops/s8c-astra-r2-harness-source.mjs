// captured astra r2 harness source input; #1165 / S8, Astra review, r2
// (R/astra-m4-s8c-review-r2-evidence/worker/harness.mjs).
export const cases = [
  ["original-1", "say set[3, false]\nexit"],
  ["original-2", "let values: boolean dict = dict{west: 3, east: false}\nexit"],
  ["original-3", 'function accept(xs: integer set) { say xs }\nexit\naccept(set["one", "two"])'],
  ["original-4", 'let flags: boolean dict = dict{first: 3, second: "bad", third: true}\nexit'],
  ["original-5", 'let groups: integer set dict = dict{one: set["x", "y"], two: set[false]}\nexit'],
  ["original-6", "let counts: integer[] = [{value: hostValue}, {value: 4}]\nexit"],
  ["original-7", 'let labels: integer[] = ["red", "blue", "green"]\nexit'],
  ["original-8", 'let pair = [3, "bad"]\nlet second = pair\nsay second\nexit'],
  ["original-9", 'say [2, "bad"]\nexit'],
  ["original-10", 'let groups: (integer | string)[] set = set[]\ngroups.add([3, "bad"])\nexit'],
  [
    "original-11",
    'function accept(xs: integer[][]) { say xs }\naccept([["one", "two"]])\naccept([[false, true]])\nexit',
  ],
  ["original-12", 'let groups: integer[][] = [[1, "bad"], [2, false]]\nexit'],
  [
    "original-13",
    'let decoded = fromJson(hostValue, default: {groups: [[3, "bad"]]})\nsay decoded\nexit',
  ],
  ["original-14", 'let groups: integer[] set = set[["one", "two"], [true, false]]\nexit'],
  ["original-15", "let counts: integer set = set[{value: 7}, {value: 8}]\nexit"],
  ["original-16", "let data: integer[] = [null, hostValue]\nsay data\nexit"],
  ["original-17", 'function make: integer[][] { return [["bad", "also"]] }\nsay make()\nexit'],
  ["original-18", 'let value: integer = "wrong"\nexit'],
];

export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node worker/harness.mjs", "R/astra-m4-s8c-review-r2-evidence/worker/run-harness.sh:3"],
  ],
  sources: 18,
  sha256: "7af5fc332dab217b1777676908db921c65e7d3cb6f933a86745141045904d721",
};
