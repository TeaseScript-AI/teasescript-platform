// bad, host and related fixed cases; #1310, builder/review archive, r10
// (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r10/repro.mjs).
export const cases = (() => {
  const programs = [
    ["bad", 'let box = {first: {n: 1}}\nbox.first.n = "bad"\nsay "DONE"\nexit\n'],
    ["host", 'let box = {first: {n: 1}}\nbox.first.n = hostValue\nsay "DONE"\nexit\n'],
    [
      "host-read",
      'let box = {first: {n: 1}}\nbox.first.n = hostValue\nrepeat box.first.n {}\nsay "DONE"\nexit\n',
    ],
    ["direct-bad", 'let box = {n: 1}\nbox.n = "bad"\nsay "DONE"\nexit\n'],
  ];
  return programs.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node repro.mjs",
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r10/repro.jsonl:1 (its result's header)",
    ],
  ],
  sources: 4,
  sha256: "e795b46be18ec7c927da9f734864b9d87c8fa3402062f61f0dff27cca1dbf7a6",
};
