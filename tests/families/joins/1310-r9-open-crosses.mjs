// #1310; builder/review archive.
export const cases = (() => {
  const cases = [];
  for (const [type, seed, bad] of [
    ["integer[]", "[1]", '["tail"]'],
    ["number[]", "[1.5]", "[false]"],
    ["boolean[]", "[true]", "[1]"],
    ["integer?[]", "[null,1]", "[false]"],
    ["(integer | string)[]", "[1]", "[true]"],
    ["integer[][]", "[[1]]", "[[false]]"],
  ])
    for (const side of [false, true])
      for (const kept of [false, true]) {
        const deep = type === "integer[][]",
          u = deep ? "list[]" : "list";
        const start = `let a: ${type} = ${seed}\nlet u: ${u} = []\n`;
        const inner = side ? "u + a" : "a + u";
        const source =
          start +
          (kept
            ? `let held = ${inner}\nlet result = held + ${bad}`
            : `let result = (${inner}) + ${bad}`) +
          "\nexit\n";
        cases.push({
          name: `${type}-${side ? "open-first" : "typed-first"}-${kept ? "kept" : "inline"}`,
          group: "open-cross",
          source,
        });
      }
  for (const type of ["integer[]", "integer?[]", "(integer | string)[]"])
    for (const side of [false, true])
      for (const [label, post] of [
        ["read", "say held.length"],
        ["add-null", "held.add(null)"],
        ["add-fit", "held.add(2)"],
        ["assign-nulls", "held = [null]"],
        ["bad-store", "held.add(false)"],
        ["later-null-join", "let next = held + [null]"],
      ]) {
        const start = `let a: ${type} = [1]\nlet n: null[] = [null]\n`;
        cases.push({
          name: `null-${type}-${side ? "null-first" : "typed-first"}-${label}`,
          group: "null-cross",
          source: start + `let held = ${side ? "n + a" : "a + n"}\n${post}\nexit\n`,
        });
      }
  for (const [name, start, dest] of [
    ["property", "let n: null[] = [null]\nlet box = {xs: n}\n", "box.xs"],
    ["index", "let rows: null[][] = [[null]]\n", "rows[0]"],
    ["dict", "let rows: null[] dict = dict{xs: [null]}\n", 'rows["xs"]'],
  ])
    for (const kind of ["compound", "self", "nested"]) {
      const assign =
        kind === "compound"
          ? `${dest} += [1]`
          : kind === "self"
            ? `${dest} = ${dest} + [1]`
            : `${dest} = (${dest} + [1]) + []`;
      cases.push({
        name: `strict-${name}-${kind}`,
        group: "strict-nested",
        source: start + assign + "\nexit\n",
      });
    }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];
