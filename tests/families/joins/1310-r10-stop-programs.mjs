// #1310; builder/review archive.
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
