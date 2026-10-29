// first/bad, first/host and related fixed cases; #1310, builder/review archive, r10
// (desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r10/stops.mjs).
export const cases = (() => {
  const programs = [];
  for (const own of ["first", "last", "random"]) {
    for (const [label, body] of [
      ["bad", `let box = {${own}: {n: 1}}\nbox.${own}.n = "bad"`],
      ["host", `let box = {${own}: {n: 1}}\nbox.${own}.n = hostValue\nrepeat box.${own}.n {}`],
      [
        "deep-bad",
        `let box = {${own}: null}\nbox.${own} = {${own}: {n: 1}}\nbox.${own}.${own}.n = "bad"`,
      ],
      [
        "nested-host",
        `let box = {${own}: {n: 1}}\nbox.${own} = hostValue\nbox.${own}.n = hostOther\nrepeat box.${own}.n {}`,
      ],
      [
        "dependent",
        `let box = {${own}: {n: 1}}\n${Array.from({ length: 18 }, (_, i) => `box.${own}.n = ${i + 2}`).join("\n")}\nbox.${own}.n = hostValue\nlet pair = [box.${own}.n]\nrepeat pair.first {}\nlet count = 1\ncount = 0.5\nrepeat count {}`,
      ],
      [
        "target-heavy",
        `let box = {${own}: {n: 1}}\n${Array.from({ length: 18 }, (_, i) => `box.${own} = {n: ${i + 2}}`).join("\n")}\nbox.${own}.n = hostValue\nrepeat box.${own}.n {}`,
      ],
    ])
      programs.push({ name: own + "/" + label, source: body + '\nsay "DONE"\nexit\n' });
  }
  return programs.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node stops.mjs r9",
      "desktop:~/work/evidence/1310/64105f339108dec9005bad103b2f942e5bcadeb2/codex-r10/stop-shapes.jsonl:1 (its result's header)",
    ],
  ],
  sources: 18,
  sha256: "de77685c26c4fc6eeb7e0ed19019f3204adbd476883f98ee955e90d090aec0d8",
};
