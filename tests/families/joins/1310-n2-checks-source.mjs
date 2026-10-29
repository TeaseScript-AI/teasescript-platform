// 1 fixed n2 checks source input; #1310, builder/review archive
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n2-checks.mjs).
export const cases = (() => {
  const source =
    'let box = {first: {last: {random: {n: 1}}}}\nbox.first.last = hostValue\nbox.first.last.random.n = "bad"\nsay "AFTER"\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node n2-checks.mjs (no command recorded: its run without arguments)",
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n2-checks.mjs",
    ],
  ],
  sources: 1,
  sha256: "77ca00ba89034ff5c1b742560c2205970cf1c36fcec77871c245277bc3f4f6c9",
};
