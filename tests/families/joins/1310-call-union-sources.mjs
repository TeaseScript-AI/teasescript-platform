// #1310; builder/review archive.
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
