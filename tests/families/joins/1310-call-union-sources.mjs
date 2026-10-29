// written-result, variable-control and related fixed cases; #1310, builder/review archive
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/call-union.mjs).
export const cases = (() => {
  const sources = {
    "written-result":
      'function make: (integer | boolean)[] { return [1] }\nlet both = make() + ["x"]\nexit\n',
    "variable-control": 'let xs: (integer | boolean)[] = [1]\nlet both = xs + ["x"]\nexit\n',
    "matching-result-control":
      "function make: (integer | boolean)[] { return [1] }\nlet both = make() + [true]\nexit\n",
    "written-result-fixed":
      'function make: (integer | boolean | string)[] { return [1] }\nlet both = make() + ["x"]\nexit\n',
    "admitted-result-copy":
      'function make: (integer | boolean)[] { return [1] }\nlet xs = make()\nlet both = xs + ["x"]\nexit\n',
  };
  return Object.entries(sources);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node call-union.mjs <tree>",
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/queue-r3.sh:28",
    ],
  ],
  sources: 5,
  sha256: "0656b91a4fd0ada0ffd2b5b524b9ff1885b8638874ec8d3c1f9f4726a611e927",
};
