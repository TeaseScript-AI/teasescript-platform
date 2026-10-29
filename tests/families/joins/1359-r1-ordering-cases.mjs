// #1359 review r1 (reviewer not recorded); retained in #1417.
export const cases = (() => {
  const expressions = [
    '{z: 1, a: "s", m: true, ext: hostValue}',
    '{a: 1, m: "s", z: false, ext: otherHost}',
    '{m: 1, z: "s", a: false, ext: hostValue}',
    '(hostValue otherwise {z: 1, a: "s", m: true})',
    '(otherHost otherwise {a: 1, m: "s", z: false})',
    'load("k", default: {m: 1, z: "s", a: false, ext: hostValue})',
    '(load("k", default: hostValue) otherwise {z: false, a: 1, m: "s"})',
    '(fromJson("{}", default: hostValue) otherwise {a: true, m: 1, z: "s"})',
  ];
  const cases = [];
  for (const padding of [0, 11])
    for (const third of [2, 3, 4, 5, 6, 7])
      for (const permutation of [
        [0, 1, 2],
        [2, 1, 0],
        [1, 2, 0],
        [2, 0, 1],
      ]) {
        const triple = [expressions[0], expressions[1], expressions[third]];
        const names = ["one", "two", "three"];
        const source = [
          padding
            ? `let pad = [${Array.from({ length: padding }, (_, i) => `{p${i}: hostValue}`).join(", ")}]\nsay pad[0]`
            : "",
          ...triple.map((e, i) => `let ${names[i]} = ${e}`),
          `let xs = [${permutation.map((i) => names[i]).join(", ")}]`,
          `let ys = [${[...permutation]
            .reverse()
            .map((i) => names[i])
            .join(", ")}]`,
          "say xs[hostValue.i].z",
          "say ys[hostValue.i].a",
          "exit",
        ].join("\n");
        cases.push({
          name: `concrete-conflicts-padding-${padding}-third-${third}-order-${permutation.join("")}`,
          files: [{ path: "main.tease", source }],
        });
      }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
})();
export const checks = ["publication"];
