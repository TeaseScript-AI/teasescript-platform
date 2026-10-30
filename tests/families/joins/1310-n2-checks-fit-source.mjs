// 1 fixed n2 checks fit source input; #1310, builder/review archive
// (desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n2-checks-fit.mjs).
export const cases = (() => {
  const source =
    'let box = {first: {last: {random: {n: 1}}}}\nbox.first.last = hostValue\nbox.first.last.random.n = 2\nsay "AFTER"\nexit\n';
  return [["source", source]];
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node n2-checks-fit.mjs (no command recorded: its run without arguments)",
      "desktop:~/work/evidence/1310/9a9b4382435f5eec49fd995ce5b171b7c2c012d8/tools/n2-checks-fit.mjs",
    ],
  ],
  sources: 1,
  sha256: "342b6f04c4e0fa8d7ed4a330cb9545c78a51bebf5da7ab89a130f0187ea37a5c",
};
