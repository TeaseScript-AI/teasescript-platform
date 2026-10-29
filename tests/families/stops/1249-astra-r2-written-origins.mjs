// written origins and guarded-disjoint companions; #1249, astra-m4-i1249-review-r2-evidence, archived Python/shell
// evidence (R/astra-m4-i1249-review-r2-evidence/make-cases.py; R/astra-m4-i1249-review-r2-evidence/make-disjoint.py).
export const cases = (() => {
  let a,
    at,
    b,
    bad,
    body,
    cases,
    close,
    f,
    first,
    name,
    other,
    path,
    place,
    pre,
    read,
    reverse,
    s,
    same,
    second,
    setup,
    shape,
    source,
    transform,
    typ,
    val;
  cases = [];
  function origin(name, typ, val) {
    let pre;
    pre = `let written: ${typ} = ${val}
`;
    if (name === "function") {
      return [pre + "function produce { return written }\n", "{n: produce()}", "n", ""];
    }
    if (name === "nested") {
      return [pre, "{outer: {inner: {n: written}}}", "outer.inner.n", ""];
    }
    if (name === "object-property") {
      return [
        "let written: object? = {payload: 1}\nlet box = {outer: {n: written}}\n",
        "{n: box.outer.n}",
        "n",
        "",
      ];
    }
    if (name === "guarded-union") {
      return [
        `let written: integer | string = ${val}
if written is ${typ} {
`,
        "{n: written}",
        "n",
        "}\n",
      ];
    }
    if (name === "copy-copy") {
      return [
        pre + "let firstCopy = written\nlet secondCopy = firstCopy\n",
        "{n: secondCopy}",
        "n",
        "",
      ];
    }
    if (name === "nested-projection") {
      return [pre + "let box = {outer: {inner: {n: written}}}\n", "box.outer.inner", "n", ""];
    }
    throw new Error(name);
  }
  for (name of [
    "function",
    "nested",
    "object-property",
    "guarded-union",
    "copy-copy",
    "nested-projection",
  ]) {
    for ([typ, val, other] of [
      ["integer", "3", '"other"'],
      ["string", '"written"', "7"],
    ]) {
      [pre, a, path, close] = origin(name, typ, val);
      b = name === "nested" ? "{outer: {inner: {n: " + other + "}}}" : "{n: " + other + "}";
      for (shape of ["list", "store"]) {
        for (reverse of [false, true]) {
          [first, second] = reverse ? ["b", "a"] : ["a", "b"];
          body =
            shape === "list"
              ? `let xs = [${first}, ${second}]
`
              : `let c = ${first}
c = ${second}
`;
          place = shape === "list" ? "xs[0]" : "c";
          for (read of [false, true]) {
            source =
              pre +
              `let a = ${a}
let b = ${b}
` +
              body +
              (read
                ? `say ${place}.${path}
`
                : "") +
              close +
              "exit\n";
            at = source.indexOf(body) + body.lastIndexOf(second);
            cases.push({ name: `${name}/${typ}/${shape}/${reverse}/${read}`, source: source });
          }
        }
      }
      same =
        name === "nested"
          ? "{outer: {inner: {n: " + val + "}}}"
          : name === "object-property"
            ? "{n: null}"
            : "{n: " + val + "}";
      cases.push({
        name: `quiet/${name}/${typ}`,
        source:
          pre +
          `let a = ${a}
let b = ${same}
let xs = [a,b]
` +
          close +
          "exit\n",
      });
    }
  }
  for (reverse of [false, true]) {
    for (shape of ["list", "store"]) {
      for (read of [false, true]) {
        [f, s] = reverse ? ["b", "a"] : ["a", "b"];
        body =
          shape === "list"
            ? `let xs=[${f},${s}]
`
            : `let c=${f}
c=${s}
`;
        place = shape === "list" ? "xs[0]" : "c";
        source =
          'let written: object? = {n: 1}\nlet a = {p: written}\nlet b = {p: {n: "text"}}\n' +
          body +
          (read
            ? `say ${place}.p.n
`
            : "") +
          "exit\n";
        cases.push({ name: `below-object/${shape}/${reverse}/${read}`, source: source });
      }
    }
    for (read of [false, true]) {
      [f, s] = reverse ? ["b", "a"] : ["a", "b"];
      source =
        `let w: integer | string = 1
let alias = w
let a = {n: alias}
let b = {n: "text"}
let xs = [${f}, ${s}]
` +
        (read ? "say xs[0].n\n" : "") +
        "exit\n";
      cases.push({ name: `union/${reverse}/${read}`, source: source });
    }
  }
  for ([transform, setup, path] of [
    ["down", "let a={n: alias, next: null}\na.next=a\n", "next.n"],
    ["up", "let a={inner: {n: alias}}\na=a.inner\n", "n"],
    ["composed", "let a={left:{right:{n:alias}}}\nlet relay=a.left\na=relay.right\n", "n"],
  ]) {
    for (reverse of [false, true]) {
      for (shape of ["list", "store"]) {
        for (read of [false, true]) {
          [f, s] = reverse ? ["b", "a"] : ["a", "b"];
          bad = transform === "down" ? '{next:{n:"text"}}' : '{n:"text"}';
          body =
            shape === "list"
              ? `let xs=[${f},${s}]
`
              : `let c=${f}
c=${s}
`;
          place = shape === "list" ? "xs[0]" : "c";
          source =
            "let w:integer=1\nlet first=w\nlet alias=first\n" +
            setup +
            `let b=${bad}
` +
            body +
            (read
              ? `say ${place}.${path}
`
              : "") +
            "exit\n";
          cases.push({ name: `stepped/${transform}/${shape}/${reverse}/${read}`, source: source });
        }
      }
    }
  }

  const originals = cases.map((c) => [c.name, c.source]);
  const disjoint = cases
    .filter((c) => c.name.startsWith("guarded-union/"))
    .map((c) => [
      c.name.replace("guarded-union/", "guarded-disjoint/"),
      c.source
        .replaceAll('let b = {n: "other"}', "let b = {n: true}")
        .replaceAll("let b = {n: 7}", "let b = {n: true}"),
    ]);
  return originals.concat(disjoint);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "python3 make-cases.py; python3 make-disjoint.py; node run.mjs <tree> <cases> <out> for its case, disjoint and growth lists",
      "R/astra-m4-i1249-review-r2-evidence/REPRODUCE.md, jobs/done/",
    ],
  ],
  sources: 159,
  sha256: "cee1415f332807b35864d701003282dc43f37db248e3d308d5b04bcc46b6668c",
};
