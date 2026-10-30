// concrete-conflicts-padding-0-third-2-order-012, concrete-conflicts-padding-0-third-2-order-210 and related fixed
// cases; #1359, r1, reviewer unrecorded (retained in #1417)
// (desktop:~/work/evidence/1417/a0abf39f0/tools/r1/ordering-cases.mjs).
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

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node differential.mjs ordering-cases.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:36",
    ],
  ],
  sources: 48,
  sha256: "960c4ea4f95c7fbf1507e632c1cfb3dd315e0784054b42648ba264889eb619b6",
};
