// wide-object and host-read cases; #1417, builder/review archive
// (desktop:~/work/evidence/1417/a0abf39f0/tools/family1297.mjs).
export const cases = (() => {
  const many = (n, row, by = "\n") => Array.from({ length: n }, (_, i) => row(i)).join(by);
  const reads = (n, list, typed) =>
    many(n, (i) => (typed ? `let a${i}: integer = ${list}.f${i}` : `say ${list}.f${i}`));
  const elements = {
    host: () => "hostValue",
    load: () => 'load("k", default: hostValue)',
    loadKeys: (i) => `load("k${i}", default: hostValue)`,
    loadRaw: () => 'load("k", default: raw)',
    loadMixed: (i) => (i % 2 ? 'load("k", default: raw)' : 'load("k", default: hostValue)'),
    loadText: () => 'load("k", default: hostValue.text)',
    loadNull: () => 'load("k", default: null)',
    loadSeed: () => 'load("k", default: seed)',
    loadComputed: (i) => `load(hostValue.key${i}, default: hostValue)`,
    parse: () => "fromJson(hostValue, default: seed, files: false)",
    parseRaw: () => "fromJson(raw, default: seed, files: false)",
    loadTyped: () => 'load("k", default: hostValue)',
    loadObject: () => 'load("k", default: {f0: hostValue, f1: 1})',
    loadPlus: () => 'load("k", default: hostValue) + 1',
  };
  const pre = 'let raw = hostValue\nlet seed = {f0: 1, f1: 2, f2: "x"}';
  const shapes = [];
  for (const [name, element] of Object.entries(elements))
    for (const how of ["first", "direct"])
      for (const typed of [true, false])
        for (const n of [1, 2, 3, 5, 9])
          shapes.push({
            name: `${name}-${how}-${typed ? "typed" : "say"}-${n}`,
            source: [
              pre,
              `let wide = [${many(n, element, ", ")}]`,
              how === "first" ? "let first = wide[0]" : "",
              reads(Math.max(n, 3), how === "first" ? "first" : "wide[0]", typed),
              "exit",
            ].join("\n"),
          });
  for (const n of [2, 5])
    shapes.push(
      {
        name: `guarded-load-${n}`,
        source: [
          pre,
          "if hostValue.f0 is integer {",
          `let wide = [${many(n, () => 'load("k", default: hostValue)', ", ")}]`,
          reads(3, "wide[0]", true),
          "}",
          "exit",
        ].join("\n"),
      },
      {
        name: `stored-load-${n}`,
        source: [
          pre,
          `let wide = [${many(n, () => 'load("k", default: hostValue)', ", ")}]`,
          "wide[0].f1 = 2",
          reads(3, "wide[0]", true),
          "exit",
        ].join("\n"),
      },
      {
        name: `loop-load-${n}`,
        source: [
          pre,
          'let flag = askBoolean "go"',
          `let wide = [${many(n, () => 'load("k", default: hostValue)', ", ")}]`,
          "while flag {",
          reads(3, "wide[0]", true),
          'wide = [load("k", default: hostValue)]',
          "}",
          "exit",
        ].join("\n"),
      },
      {
        name: `written-load-${n}`,
        source: [
          pre,
          `let wide: object[] = [${many(n, () => 'load("k", default: hostValue)', ", ")}]`,
          reads(3, "wide[0]", true),
          "exit",
        ].join("\n"),
      },
      {
        name: `wide-objects-${n}`,
        source: [
          "let t: integer = 1",
          `let a = [{${many(n + 2, (i) => `f${i}: t`, ", ")}}, ${many(n, (i) => `{f${i}: "x"}`, ", ")}, {g: hostValue}]`,
          "say a[0].f0",
          "exit",
        ].join("\n"),
      },
      {
        name: `wide-objects-conflict-${n}`,
        source: [
          "let raw = hostValue",
          "let t: integer = 1",
          `let a = [{${many(n + 2, (i) => `f${i}: t`, ", ")}}, ${many(n, (i) => `{f${i}: "x", h: {f${i}: 2}}`, ", ")}, raw]`,
          "say a[1].h",
          "exit",
        ].join("\n"),
      },
      {
        name: `choice-objects-${n}`,
        source: [
          "let t: integer = 1",
          `let picked = askChoice [{text: "a", value: {${many(n + 2, (i) => `f${i}: t`, ", ")}}}, ${many(n, (i) => `{text: "${i}", value: {f${i}: "x"}}`, ", ")}]`,
          "say picked",
          "exit",
        ].join("\n"),
      },
    );
  return shapes.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node family1297.mjs <tree> <out>",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:29",
    ],
  ],
  sources: 270,
  sha256: "4557602e9deb83d982b536cdced0447878fe5fa575672bba7963ac84cc703bf2",
};
