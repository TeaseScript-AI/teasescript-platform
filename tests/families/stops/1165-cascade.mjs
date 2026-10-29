// #1165 S8 part 3, r7 retained builder/probe9 evidence.
export const cases = (() => {
  const nest = (k, leaf) => "[".repeat(k) + leaf + "]".repeat(k);
  const copies = (k) =>
    [
      `let typed: integer${"[]".repeat(k)} = []`,
      "let out = typed",
      ...Array.from({ length: k }, () => "out = typed"),
      "exit",
    ].join("\n") + "\n";
  const shapes = {
    copies32: copies(32),
    copies64: copies(64),
    union300: `let typed: integer | string = 1\nlet xs = [${nest(300, "typed")}, ${nest(300, '"ok"')}]\nexit\n`,
  };
  return Object.entries(shapes);
})();
export const checks = ["publication", "stops"];
