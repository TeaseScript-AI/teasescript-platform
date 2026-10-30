// written origins and guarded-disjoint companions; #1249, astra-m4-i1249-review-r2-evidence, archived Python/shell
// evidence (R/astra-m4-i1249-review-r2-evidence/make-cases.py; R/astra-m4-i1249-review-r2-evidence/make-disjoint.py).
const generated = (() => {
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
// the growth-quick job's inputs (run.mjs growth-quick.json, jobs/done/…-astra1293r2-growth-quick.job:4)
const captured = [
  [
    "run.mjs:6a56357df396",
    'let w0: integer = 0\nlet alias0 = w0\nlet copied0 = alias0\nlet w1: integer = 1\nlet alias1 = w1\nlet copied1 = alias1\nlet w2: integer = 2\nlet alias2 = w2\nlet copied2 = alias2\nlet w3: integer = 3\nlet alias3 = w3\nlet copied3 = alias3\nlet badValue: string = "text"\nlet good={outer:{inner:{f0: copied0, f1: copied1, f2: copied2, f3: copied3}}}\nlet bad={outer:{inner:{f0: badValue, f1: copied1, f2: copied2, f3: copied3}}}\nlet xs=[good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, bad.outer.inner]\nsay xs[0].f0\nexit\n',
  ],
  [
    "run.mjs:3cd333de93b5",
    'let w0: integer = 0\nlet alias0 = w0\nlet copied0 = alias0\nlet w1: integer = 1\nlet alias1 = w1\nlet copied1 = alias1\nlet w2: integer = 2\nlet alias2 = w2\nlet copied2 = alias2\nlet w3: integer = 3\nlet alias3 = w3\nlet copied3 = alias3\nlet badValue: string = "text"\nlet good={outer:{inner:{f0: copied0, f1: copied1, f2: copied2, f3: copied3}}}\nlet bad={outer:{inner:{f0: badValue, f1: copied1, f2: copied2, f3: copied3}}}\nlet xs=[bad.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner]\nsay xs[0].f0\nexit\n',
  ],
  [
    "run.mjs:6f234b4fb91d",
    'let w0: integer = 0\nlet alias0 = w0\nlet copied0 = alias0\nlet w1: integer = 1\nlet alias1 = w1\nlet copied1 = alias1\nlet w2: integer = 2\nlet alias2 = w2\nlet copied2 = alias2\nlet w3: integer = 3\nlet alias3 = w3\nlet copied3 = alias3\nlet badValue: string = "text"\nlet good={outer:{inner:{f0: copied0, f1: copied1, f2: copied2, f3: copied3}}}\nlet bad={outer:{inner:{f0: badValue, f1: copied1, f2: copied2, f3: copied3}}}\nlet c0={slot:good.outer.inner}\nc0.slot=bad.outer.inner\nsay c0.slot.f0\nlet c1={slot:good.outer.inner}\nc1.slot=bad.outer.inner\nsay c1.slot.f0\nlet c2={slot:good.outer.inner}\nc2.slot=bad.outer.inner\nsay c2.slot.f0\nlet c3={slot:good.outer.inner}\nc3.slot=bad.outer.inner\nsay c3.slot.f0\nexit\n',
  ],
  [
    "run.mjs:6de0e9d8a9f9",
    'let w0: integer = 0\nlet alias0 = w0\nlet copied0 = alias0\nlet w1: integer = 1\nlet alias1 = w1\nlet copied1 = alias1\nlet w2: integer = 2\nlet alias2 = w2\nlet copied2 = alias2\nlet w3: integer = 3\nlet alias3 = w3\nlet copied3 = alias3\nlet badValue: string = "text"\nlet good={outer:{inner:{f0: copied0, f1: copied1, f2: copied2, f3: copied3}}}\nlet bad={outer:{inner:{f0: badValue, f1: copied1, f2: copied2, f3: copied3}}}\nlet c0={slot:bad.outer.inner}\nc0.slot=good.outer.inner\nsay c0.slot.f0\nlet c1={slot:bad.outer.inner}\nc1.slot=good.outer.inner\nsay c1.slot.f0\nlet c2={slot:bad.outer.inner}\nc2.slot=good.outer.inner\nsay c2.slot.f0\nlet c3={slot:bad.outer.inner}\nc3.slot=good.outer.inner\nsay c3.slot.f0\nexit\n',
  ],
  [
    "run.mjs:8bf0d858564b",
    'let w0: integer = 0\nlet alias0 = w0\nlet copied0 = alias0\nlet w1: integer = 1\nlet alias1 = w1\nlet copied1 = alias1\nlet w2: integer = 2\nlet alias2 = w2\nlet copied2 = alias2\nlet w3: integer = 3\nlet alias3 = w3\nlet copied3 = alias3\nlet w4: integer = 4\nlet alias4 = w4\nlet copied4 = alias4\nlet w5: integer = 5\nlet alias5 = w5\nlet copied5 = alias5\nlet w6: integer = 6\nlet alias6 = w6\nlet copied6 = alias6\nlet w7: integer = 7\nlet alias7 = w7\nlet copied7 = alias7\nlet badValue: string = "text"\nlet good={outer:{inner:{f0: copied0, f1: copied1, f2: copied2, f3: copied3, f4: copied4, f5: copied5, f6: copied6, f7: copied7}}}\nlet bad={outer:{inner:{f0: badValue, f1: copied1, f2: copied2, f3: copied3, f4: copied4, f5: copied5, f6: copied6, f7: copied7}}}\nlet xs=[good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, bad.outer.inner]\nsay xs[0].f0\nexit\n',
  ],
  [
    "run.mjs:d6d8715ddeb2",
    'let w0: integer = 0\nlet alias0 = w0\nlet copied0 = alias0\nlet w1: integer = 1\nlet alias1 = w1\nlet copied1 = alias1\nlet w2: integer = 2\nlet alias2 = w2\nlet copied2 = alias2\nlet w3: integer = 3\nlet alias3 = w3\nlet copied3 = alias3\nlet w4: integer = 4\nlet alias4 = w4\nlet copied4 = alias4\nlet w5: integer = 5\nlet alias5 = w5\nlet copied5 = alias5\nlet w6: integer = 6\nlet alias6 = w6\nlet copied6 = alias6\nlet w7: integer = 7\nlet alias7 = w7\nlet copied7 = alias7\nlet badValue: string = "text"\nlet good={outer:{inner:{f0: copied0, f1: copied1, f2: copied2, f3: copied3, f4: copied4, f5: copied5, f6: copied6, f7: copied7}}}\nlet bad={outer:{inner:{f0: badValue, f1: copied1, f2: copied2, f3: copied3, f4: copied4, f5: copied5, f6: copied6, f7: copied7}}}\nlet xs=[bad.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner, good.outer.inner]\nsay xs[0].f0\nexit\n',
  ],
  [
    "run.mjs:4c3b623d2c9b",
    'let w0: integer = 0\nlet alias0 = w0\nlet copied0 = alias0\nlet w1: integer = 1\nlet alias1 = w1\nlet copied1 = alias1\nlet w2: integer = 2\nlet alias2 = w2\nlet copied2 = alias2\nlet w3: integer = 3\nlet alias3 = w3\nlet copied3 = alias3\nlet w4: integer = 4\nlet alias4 = w4\nlet copied4 = alias4\nlet w5: integer = 5\nlet alias5 = w5\nlet copied5 = alias5\nlet w6: integer = 6\nlet alias6 = w6\nlet copied6 = alias6\nlet w7: integer = 7\nlet alias7 = w7\nlet copied7 = alias7\nlet badValue: string = "text"\nlet good={outer:{inner:{f0: copied0, f1: copied1, f2: copied2, f3: copied3, f4: copied4, f5: copied5, f6: copied6, f7: copied7}}}\nlet bad={outer:{inner:{f0: badValue, f1: copied1, f2: copied2, f3: copied3, f4: copied4, f5: copied5, f6: copied6, f7: copied7}}}\nlet c0={slot:good.outer.inner}\nc0.slot=bad.outer.inner\nsay c0.slot.f0\nlet c1={slot:good.outer.inner}\nc1.slot=bad.outer.inner\nsay c1.slot.f0\nlet c2={slot:good.outer.inner}\nc2.slot=bad.outer.inner\nsay c2.slot.f0\nlet c3={slot:good.outer.inner}\nc3.slot=bad.outer.inner\nsay c3.slot.f0\nlet c4={slot:good.outer.inner}\nc4.slot=bad.outer.inner\nsay c4.slot.f0\nlet c5={slot:good.outer.inner}\nc5.slot=bad.outer.inner\nsay c5.slot.f0\nlet c6={slot:good.outer.inner}\nc6.slot=bad.outer.inner\nsay c6.slot.f0\nlet c7={slot:good.outer.inner}\nc7.slot=bad.outer.inner\nsay c7.slot.f0\nexit\n',
  ],
  [
    "run.mjs:f5065bedb050",
    'let w0: integer = 0\nlet alias0 = w0\nlet copied0 = alias0\nlet w1: integer = 1\nlet alias1 = w1\nlet copied1 = alias1\nlet w2: integer = 2\nlet alias2 = w2\nlet copied2 = alias2\nlet w3: integer = 3\nlet alias3 = w3\nlet copied3 = alias3\nlet w4: integer = 4\nlet alias4 = w4\nlet copied4 = alias4\nlet w5: integer = 5\nlet alias5 = w5\nlet copied5 = alias5\nlet w6: integer = 6\nlet alias6 = w6\nlet copied6 = alias6\nlet w7: integer = 7\nlet alias7 = w7\nlet copied7 = alias7\nlet badValue: string = "text"\nlet good={outer:{inner:{f0: copied0, f1: copied1, f2: copied2, f3: copied3, f4: copied4, f5: copied5, f6: copied6, f7: copied7}}}\nlet bad={outer:{inner:{f0: badValue, f1: copied1, f2: copied2, f3: copied3, f4: copied4, f5: copied5, f6: copied6, f7: copied7}}}\nlet c0={slot:bad.outer.inner}\nc0.slot=good.outer.inner\nsay c0.slot.f0\nlet c1={slot:bad.outer.inner}\nc1.slot=good.outer.inner\nsay c1.slot.f0\nlet c2={slot:bad.outer.inner}\nc2.slot=good.outer.inner\nsay c2.slot.f0\nlet c3={slot:bad.outer.inner}\nc3.slot=good.outer.inner\nsay c3.slot.f0\nlet c4={slot:bad.outer.inner}\nc4.slot=good.outer.inner\nsay c4.slot.f0\nlet c5={slot:bad.outer.inner}\nc5.slot=good.outer.inner\nsay c5.slot.f0\nlet c6={slot:bad.outer.inner}\nc6.slot=good.outer.inner\nsay c6.slot.f0\nlet c7={slot:bad.outer.inner}\nc7.slot=good.outer.inner\nsay c7.slot.f0\nexit\n',
  ],
];
export const cases = [...generated, ...captured];

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
  sources: 167,
  sha256: "5106a2d42922101d848bc5558a4d83ec382e76b2f6afe59c1ec2f7c2ce7dd2b3",
};
