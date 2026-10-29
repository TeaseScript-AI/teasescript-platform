// #1310; builder/review archive.
export const cases = (() => {
  const host = (hostValue, hostOther = 2) => ({ hostValue, hostOther });
  const sources = [];
  for (const own of ["first", "last", "random"]) {
    sources.push([`${own}/bad`, `let box = {${own}: {n: 1}}\nbox.${own}.n = "bad"`, [], []]);
    sources.push([`${own}/fit`, `let box = {${own}: {n: 1}}\nbox.${own}.n = 2`, [], []]);
    sources.push([
      `${own}/host`,
      `let box = {${own}: {n: 1}}\nbox.${own}.n = hostValue\nrepeat box.${own}.n {}`,
      [host(2)],
      [host("bad"), host(2.5)],
    ]);
    sources.push([
      `${own}/nested-host`,
      `let box = {${own}: {n: 1}}\nbox.${own} = hostValue\nbox.${own}.n = hostOther\nrepeat box.${own}.n {}`,
      [host({ kind: "object", properties: [{ name: "n", value: 2 }] })],
      [
        host({ kind: "object", properties: [{ name: "n", value: "bad" }] }),
        host({ kind: "object", properties: [{ name: "n", value: 2 }] }, "bad"),
      ],
    ]);
    sources.push([
      `${own}/deep-bad`,
      `let box = {${own}: null}\nbox.${own} = {${own}: {n: 1}}\nbox.${own}.${own}.n = "bad"`,
      [],
      [],
    ]);
  }
  sources.push(["inner/bad", 'let box = {inner: {n: 1}}\nbox.inner.n = "bad"', [], []]);
  sources.push(["variable/bad", 'let n = 1\nn = "bad"', [], []]);
  sources.push(["add/bad", 'let xs = [1]\nxs.add("bad")', [], []]);
  for (const own of ["first", "last"])
    sources.push([
      `${own}/joined-index-64`,
      `let w: integer[] = [1]\nlet box = {${own}: {xs: ${Array(64).fill("w").join(" + ")}}}\nbox.${own}.xs[0] = "bad"`,
      [],
      [],
    ]);
  return sources.map(([name, source]) => [name, source]);
})();
export const checks = ["publication", "stops"];
