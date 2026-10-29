// #1417; builder/review archive: size-dependent shapes source families.
export const sizes = [16, 32];
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
export const shapes = corpus.shapes;
export const checks = ["publication"];
