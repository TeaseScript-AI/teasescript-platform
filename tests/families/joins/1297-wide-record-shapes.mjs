// original wide-inline, wide-inline-same and related inputs; #1417, builder/review archive
// (desktop:~/work/evidence/1417/a0abf39f0/tools/shapes1297.mjs).
const corpus = (() => {
  const many = (n, row, by = "\n") => Array.from({ length: n }, (_, i) => row(i)).join(by);
  const wideLiteral = (n) => `{${many(n, (i) => `f${i}: 1`, ", ")}}`;
  const shapes = {
    // #1199: one list of a wide object and k small objects
    "wide-inline": (n) =>
      [
        `let xs = [${wideLiteral(n)}, ${many(n, (i) => `{f${i}: 2}`, ", ")}]`,
        "say xs.length",
        "exit",
      ].join("\n"),
    "wide-inline-same": (n) =>
      [
        `let xs = [${wideLiteral(n)}, ${many(n, () => "{f0: 2}", ", ")}]`,
        "say xs.length",
        "exit",
      ].join("\n"),
    "wide-inline-other": (n) =>
      [
        `let xs = [${wideLiteral(n)}, ${many(n, (i) => `{g${i}: 2}`, ", ")}]`,
        "say xs.length",
        "exit",
      ].join("\n"),
    "wide-named": (n) =>
      [
        "let t: integer = 1",
        `let root = {${many(n, (i) => `f${i}: t`, ", ")}}`,
        many(n, (i) => `let r${i} = {f${i}: 2}`),
        `let a = [root, ${many(n, (i) => `r${i}`, ", ")}]`,
        "exit",
      ].join("\n"),
    "wide-named-read": (n) =>
      [
        "let t: integer = 1",
        `let root = {${many(n, (i) => `f${i}: t`, ", ")}}`,
        many(n, (i) => `let r${i} = {f${i}: 2}`),
        `let a = [root, ${many(n, (i) => `r${i}`, ", ")}]`,
        "say a[0].f0",
        "exit",
      ].join("\n"),
    "wide-inline-reads": (n) =>
      [
        `let xs = [${wideLiteral(n)}, ${many(n, (i) => `{f${i}: 2}`, ", ")}]`,
        "let first = xs[0]",
        many(n, (i) => `say first.f${i}`),
        "exit",
      ].join("\n"),
    "wide-last": (n) =>
      [
        `let xs = [${many(n, (i) => `{f${i}: 2}`, ", ")}, ${wideLiteral(n)}]`,
        "say xs.length",
        "exit",
      ].join("\n"),
    // #1207: a list of direct host reads, read at k properties
    "host-list": (n) =>
      [
        `let wide = [${many(n, () => "hostValue", ", ")}]`,
        "let first = wide[0]",
        many(n, (i) => `let a${i}: integer = first.f${i}`),
        "exit",
      ].join("\n"),
    "host-load": (n) =>
      [
        `let wide = [${many(n, () => 'load("k", default: hostValue)', ", ")}]`,
        "let first = wide[0]",
        many(n, (i) => `let a${i}: integer = first.f${i}`),
        "exit",
      ].join("\n"),
    "host-raw": (n) =>
      [
        "let raw = hostValue",
        `let wide = [${many(n, () => "raw", ", ")}]`,
        "let first = wide[0]",
        many(n, (i) => `let a${i}: integer = first.f${i}`),
        "exit",
      ].join("\n"),
    "host-list-say": (n) =>
      [
        `let wide = [${many(n, () => "hostValue", ", ")}]`,
        "let first = wide[0]",
        many(n, (i) => `say first.f${i}`),
        "exit",
      ].join("\n"),
    "host-raw-direct": (n) =>
      [
        "let raw = hostValue",
        `let wide = [${many(n, () => "raw", ", ")}]`,
        many(n, (i) => `let a${i}: integer = wide[0].f${i}`),
        "exit",
      ].join("\n"),
    "host-load-raw": (n) =>
      [
        "let raw = hostValue",
        `let wide = [${many(n, () => 'load("k", default: raw)', ", ")}]`,
        "let first = wide[0]",
        many(n, (i) => `let a${i}: integer = first.f${i}`),
        "exit",
      ].join("\n"),
    "host-load-say": (n) =>
      [
        `let wide = [${many(n, () => 'load("k", default: hostValue)', ", ")}]`,
        "let first = wide[0]",
        many(n, (i) => `say first.f${i}`),
        "exit",
      ].join("\n"),
    "host-load-direct": (n) =>
      [
        `let wide = [${many(n, () => 'load("k", default: hostValue)', ", ")}]`,
        many(n, (i) => `let a${i}: integer = wide[0].f${i}`),
        "exit",
      ].join("\n"),
    "host-list-direct-say": (n) =>
      [
        `let wide = [${many(n, () => "hostValue", ", ")}]`,
        many(n, (i) => `say wide[0].f${i}`),
        "exit",
      ].join("\n"),
    "host-list-one": (n) =>
      [
        `let wide = [${many(n, () => "hostValue", ", ")}]`,
        "let a: integer = wide[0].f0",
        "exit",
      ].join("\n"),
    "host-list-fields": (n) =>
      [
        `let wide = [hostValue, hostValue, hostValue]`,
        many(n, (i) => `let a${i}: integer = wide[0].f${i}`),
        "exit",
      ].join("\n"),
    "wide-named-plain": (n) =>
      [
        `let root = {${many(n, (i) => `f${i}: 1`, ", ")}}`,
        many(n, (i) => `let r${i} = {f${i}: 2}`),
        `let a = [root, ${many(n, (i) => `r${i}`, ", ")}]`,
        "exit",
      ].join("\n"),
    "wide-named-inline": (n) =>
      [
        "let t: integer = 1",
        `let a = [{${many(n, (i) => `f${i}: t`, ", ")}}, ${many(n, (i) => `{f${i}: 2}`, ", ")}]`,
        "exit",
      ].join("\n"),
    "wide-root-inline-small": (n) =>
      [
        "let t: integer = 1",
        `let root = {${many(n, (i) => `f${i}: t`, ", ")}}`,
        `let a = [root, ${many(n, (i) => `{f${i}: 2}`, ", ")}]`,
        "exit",
      ].join("\n"),
    "small-named-only": (n) =>
      [
        many(n, (i) => `let r${i} = {f${i}: 2}`),
        `let a = [${many(n, (i) => `r${i}`, ", ")}]`,
        "exit",
      ].join("\n"),
    "host-list-direct": (n) =>
      [
        `let wide = [${many(n, () => "hostValue", ", ")}]`,
        many(n, (i) => `let a${i}: integer = wide[0].f${i}`),
        "exit",
      ].join("\n"),
    // Astra's B1 (the wide object below shared properties or a list, first, amid, last) and B2 (k loads beside it)
    "b1-nested-first": (n) => nested(n, (o) => `{box: ${o}}`, 0),
    "b1-twice-nested-amid": (n) => nested(n, (o) => `{box: {box: ${o}}}`, n >> 1),
    "b1-twice-nested-last": (n) => nested(n, (o) => `{box: {box: ${o}}}`, n),
    "b1-listed-last": (n) => nested(n, (o) => `{box: [${o}]}`, n),
    "b2-loads-amid": (n) => loadsBeside(n, n >> 1),
    "b2-loads-last": (n) => loadsBeside(n, n),
  };
  function nested(n, around, at) {
    const objects = Array.from({ length: n }, (_, i) => around(`{f${i}: 2}`));
    objects.splice(at, 0, around(`{${many(n, (i) => `f${i}: t`, ", ")}}`));
    return ["let t: integer = 1", `let a = [${objects.join(", ")}]`, "exit"].join("\n");
  }
  function loadsBeside(n, at) {
    const elements = Array.from({ length: n }, () => 'load("k", default: hostValue)');
    elements.splice(at, 0, wideLiteral(n));
    return [
      `let xs = [${elements.join(", ")}]`,
      many(n, (i) => `let a${i}: integer = xs[0].f${i}`),
      "exit",
    ].join("\n");
  }
  return { shapes: shapes };
})();
export const sizes = [1, 2, 3, 5, 9, 64, 128]; // the recorded consumers' sizes
export const shapes = corpus.shapes;

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "otherHost"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node growth.mjs <tree> desktop:~/work/evidence/1417/a0abf39f0/tools/shapes1297.mjs all 64 src,rev literalUnits,mergeItems,checks,invSteps",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:20",
    ],
    [
      "node answers.mjs <tree> <out> shapes desktop:~/work/evidence/1417/a0abf39f0/tools/shapes1297.mjs 1,3,5",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:26",
    ],
    [
      "node oracle-run.mjs <base> <head> <out> desktop:~/work/evidence/1417/a0abf39f0/tools/shapes1297.mjs",
      "desktop:~/work/evidence/1417/a0abf39f0/tools/queue-evidence.sh:34",
    ],
  ],
  sources: 201,
  sha256: "d790bf4cebdc765c91285f440643f78f63fb49349e5acade61ea5232c319c483",
};
