// original script-label, script-path and related inputs; 3a review, round unrecorded
// (R/pr-3a-closing-check-files/strict-parameters.mjs).
export const cases = (() => {
  const cases = [
    ["script-label", 'function f { return f() }\nlet r = script("main.tease", label: f())\nexit'],
    ["script-path", "function f { return f() }\nlet r = script(f())\nexit"],
    ["toString-files", "function f { return f() }\nlet r = toString(1, files: f())\nexit"],
    [
      "encrypt-password",
      'function f { return f() }\nlet r = encryptText("a", password: f(), publicKey: false, timeLock: false)\nexit',
    ],
    ["hash-default", 'let xs = [1]\nlet r = hashText("a", default: xs)\nexit'],
  ];
  return cases.map(([name, source]) => [name, source]);
})();
export const checks = ["publication"];

for (const index of [0]) cases.splice(index, 1);

// the globals the recorded run passed
export const globals = [];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node strict-parameters.mjs (no command recorded: its run without arguments)",
      "R/pr-3a-closing-check-files/strict-parameters.mjs",
    ],
  ],
  sources: 5,
  sha256: "e412ad43259bf80bf2650139ccbedcecc8a60ec1463d9f728f19b214bb1ec6ed",
  dropped: [
    [
      "eabbccec7b0cba347e472b906709b5468f167dce4dbd77a93e8e8a69a38a3f41",
      "The strict-parameter probe intends recursive label argument evaluation; script(label:) is no longer supported. (undefined)",
    ],
  ],
};
