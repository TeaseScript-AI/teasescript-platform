export const cases = (() => {
  // #1417; builder/review archive: size-dependent shapes source families.
  const sizes = [16, 32];
  const corpus = (() => {
    const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
    const shapes = {
      rotatedWideRolePeers: (n) => {
        const peers = Math.max(2, Math.floor(n / 8));
        const expr = `${"max(".repeat(n)}hostValue.n${many(n, (i) => `, ${i})`, "")}`;
        return [
          many(peers, (i) => `let p${i} = ${expr}`),
          many(
            n,
            (i) =>
              `let xs${i} = [${many(peers, (j) => `p${(i + j) % peers}`, ", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
          ),
          "exit",
        ].join("\n");
      },
      rotatedWideLeafPeers: (n) => {
        const peers = Math.max(2, Math.floor(n / 8));
        const expr = `askChoice ${many(n, (i) => `{text:"${i}", value:hostValue.p${i}}`, ", ")}`;
        return [
          many(peers, (i) => `let p${i} = ${expr}`),
          many(
            n,
            (i) =>
              `let xs${i} = [${many(peers, (j) => `p${(i + j) % peers}`, ", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
          ),
          "exit",
        ].join("\n");
      },
    };
    return {
      shapes: {
        rotatedWideRolePeers: (n) => shapes["rotatedWideRolePeers"](n),
        rotatedWideLeafPeers: (n) => shapes["rotatedWideLeafPeers"](n),
      },
    };
  })();
  const shapes = corpus.shapes;
  const checks = ["publication"];

  const selected = [];
  for (const [name, sizes] of [
    ["rotatedWideRolePeers", [16, 32, 2, 3, 5, 9, 64, 128]],
    ["rotatedWideLeafPeers", [16, 32, 2, 3, 5, 9, 64]],
  ])
    for (const n of sizes) selected.push([name + "@" + n, shapes[name](n)]);
  return selected;
})();

export const checks = ["publication"];
