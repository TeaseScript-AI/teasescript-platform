// original loop, branches and related inputs; #1278, Astra review, r2 (R/astra-m4-i1278-review-r2-evidence/cases.mjs).
export const sizes = [64, 128, 256]; // the recorded growth run's k
const outputs = (() => {
  const options =
    'let options = [{text:"a",value:p},{text:"b",value:p}]\nlet picked = askChoice options';
  const reads = "repeat picked.f {}\nrepeat picked.extra {}\nsay picked.missing\nexit";
  const definition = (i, varied) =>
    `p = ${varied && i % 2 ? `{extra:${i}, f:2.5}` : `{f:${i + 1}, extra:${i}}`}`;
  function program(shape, k, varied = false) {
    const definitions = Array.from({ length: k - 1 }, (_, i) => definition(i, varied));
    const start = "let p = {f:1, extra:0}";
    let lines;
    if (shape === "loop") lines = [start, "repeat 2 {", ...definitions, "}"];
    else if (shape === "branches")
      lines = [
        start,
        "if hostValue is integer {",
        ...definitions.filter((_, i) => i % 2 === 0),
        "} else {",
        ...definitions.filter((_, i) => i % 2 === 1),
        "}",
      ];
    else if (shape === "store-between")
      lines = [
        start,
        ...definitions.slice(0, Math.floor(k / 2)),
        "p.extra = 2.5",
        ...definitions.slice(Math.floor(k / 2)),
      ];
    else if (shape === "stores-below")
      lines = [start, ...definitions, ...Array.from({ length: k }, (_, i) => `p.g${i} = ${i}`)];
    else if (shape === "repeated-branches")
      lines = [start, ...definitions.map((d) => `if hostValue is integer { ${d} }`)];
    else throw new Error(`Unknown shape ${shape}`);
    return {
      name: `${shape}-${k}-${varied ? "varied" : "integer"}`,
      files: [{ path: "main.tease", source: [...lines, options, reads].join("\n") }],
    };
  }
  const shapes = ["loop", "branches", "store-between", "stores-below", "repeated-branches"];
  function independent() {
    const out = shapes.flatMap((shape) =>
      [4, 9].flatMap((k) => [false, true].map((v) => program(shape, k, v))),
    );
    for (const placement of ["before", "between", "after"])
      for (const value of ["2.5", '"changed"', "hostValue"]) {
        const statements = [
          "let p = {f:1, extra:0}",
          'let a = {text:"a",value:p}',
          ...Array.from({ length: 7 }, (_, i) => definition(i, true)),
          'let b = {text:"b",value:p}',
          "let options = [a,b,a,b]",
          "let picked = askChoice options",
          "repeat picked.f {}",
          "repeat picked.extra {}",
          "say picked.missing",
          "exit",
        ];
        statements.splice(
          placement === "before" ? 1 : placement === "between" ? 6 : 12,
          0,
          `p.extra = ${value}`,
        );
        out.push({
          name: `snapshot-store-${placement}-${value}`,
          files: [{ path: "main.tease", source: statements.join("\n") }],
        });
      }
    return out;
  }
  const __fixedG322_0 = independent();
  const cases0 = (() => {
    return __fixedG322_0.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
  })();
  const cases1 = (() => {
    return [["options", options]];
  })();
  const shapes2 = (() => {
    return {
      loop: (n) => program("loop", n, undefined).files,
      branches: (n) => program("branches", n, undefined).files,
      "store-between": (n) => program("store-between", n, undefined).files,
      "stores-below": (n) => program("stores-below", n, undefined).files,
      "repeated-branches": (n) => program("repeated-branches", n, undefined).files,
    };
  })();
  const cases3 = (() => {
    return [["reads", reads]];
  })();
  return { cases0, cases1, shapes2, cases3 };
})();
export const cases = [...outputs.cases0, ...outputs.cases1, ...outputs.cases3];
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes2).map(([name, make]) => ["shapes2/" + name, make]),
]);
export const checks = ["publication"];

for (const index of [30, 29]) cases.splice(index, 1);

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "ssh desktop 'bash /tmp/agent-work/o4-3a-lead-astra-i1278-r2/run.sh quick'",
      "R/astra-m4-i1278-review-r2-evidence/RUNS.txt:20",
    ],
    [
      "ssh desktop 'bash /tmp/agent-work/o4-3a-lead-astra-i1278-r2/run.sh independent'",
      "R/astra-m4-i1278-review-r2-evidence/RUNS.txt:22",
    ],
    [
      "ssh desktop 'bash /tmp/agent-work/o4-3a-lead-astra-i1278-r2/run.sh growth'",
      "R/astra-m4-i1278-review-r2-evidence/RUNS.txt:23",
    ],
  ],
  sources: 44,
  sha256: "4a9f16abd12879df686da02b340c1112e32ebcfec9a9685942f93f49b78e6fe1",
};
