// 3a review.
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
