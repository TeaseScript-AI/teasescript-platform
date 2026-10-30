// copies, cycles, projections and controls; #1249, astra-m4-i1249-review-evidence, archived Python/shell evidence,
// round unrecorded (R/astra-m4-i1249-review-evidence/make-cases.py).
export const cases = (() => {
  let a,
    axes,
    axis,
    b,
    bad,
    body,
    cases,
    depth,
    expr,
    first,
    form,
    good,
    kind,
    left,
    literal,
    make,
    optional,
    prop,
    read,
    right,
    second,
    setup,
    style,
    swapped,
    use,
    wrap;
  cases = [];
  function add(name, source, family, expect = null) {
    cases.push({ name: name, source: source + "\nexit\n" });
  }
  for ([style, setup, left, right, prop] of [
    ["inferred", 'let first={tone:1}\nlet second={tone:"bad"}', "first", "second", "tone"],
    [
      "written",
      'let n:integer=1\nlet s:string="bad"\nlet first={tone:n}\nlet second={tone:s}',
      "first",
      "second",
      "tone",
    ],
    [
      "nested",
      'let first={inside:{tone:1}}\nlet second={inside:{tone:"bad"}}',
      "first",
      "second",
      "inside.tone",
    ],
    [
      "projection",
      'let source={a:{inside:{tone:1}},b:{inside:{tone:"bad"}}}',
      "source.a",
      "source.b",
      "inside.tone",
    ],
    [
      "nullable",
      'let first={inside:null}\nfirst={inside:{tone:1}}\nlet second={inside:{tone:"bad"}}',
      "first",
      "second",
      "inside.tone",
    ],
    [
      "nested-list",
      'let first={inside:[{tone:1}]}\nlet second={inside:[{tone:"bad"}]}',
      "first",
      "second",
      "inside[0].tone",
    ],
  ]) {
    for (swapped of [false, true]) {
      [a, b] = swapped ? [right, left] : [left, right];
      for (read of [false, true]) {
        for ([form, make, use] of [
          ["list", `let result=[${a},${b}]`, `result[0].${prop}`],
          ["set", `let result=set[${a},${b}]`, null],
          ["dict", `let result=dict{"one":${a},"two":${b}}`, `result["one"].${prop}`],
          [
            "store",
            `let result=${a}
result=${b}`,
            `result.${prop}`,
          ],
        ]) {
          if (read && use === null) {
            continue;
          }
          add(
            `copies/${style}/${swapped}/${form}/${read}`,
            setup + "\n" + make + (read ? "\nsay " + use : ""),
            "copy",
            { error: true, code: form === "store" ? "TSV041" : "TSV044", text: b },
          );
        }
      }
      add(
        `late/${style}/${swapped}`,
        setup +
          `
let result=${a}
say result.${prop}
result=${b}`,
        "late",
        { error: true, text: b },
      );
    }
  }
  for (depth of [0, 1, 3]) {
    wrap = (x) => (false ? "{inside:" + x + "}" : x);
    function object_(value) {
      let _;
      value = "{tone:" + value + "}";
      for (_ of Array.from({ length: depth - 0 }, (_, i) => i + 0)) {
        value = "{inside:" + value + "}";
      }
      return value;
    }
    prop = "inside.".repeat(depth) + "tone";
    for (swapped of [false, true]) {
      [good, bad] = swapped ? ['"bad"', "1"] : ["1", '"bad"'];
      setup = `let good=${object_(good)}
let bad=${object_(bad)}
let flag:boolean=hostValue
`;
      axes = {
        relay: "let a=bad\nlet b=good\nlet relay=b\nrelay=a\nb=relay\na=b",
        "long-relay": "let a=bad\nlet b=good\nlet x=b\nlet y=x\ny=a\nb=y\na=b",
        empty: "let a=good\nlet b=a\nlet c=b\na=c\nb={}\nc={}\na=bad",
        same: "let a=good\nlet b=a\nlet c=b\na=c\nb=good\nc=good\na=bad",
        other: "let a=good\nlet b=a\nlet c=b\na=c\nb=bad\nc=bad",
        guard: "let a=bad\nlet b=good\nlet relay=b\nrelay=a\nif flag { b=relay }\nif flag { a=b }",
        unreachable:
          "let a=bad\nlet b=good\nlet relay=b\nrelay=a\nif false { b=relay }\nif false { a=b }",
        "projection-feed":
          "let box={left:good,right:bad}\nlet a=box.left\nlet b=a\nlet c=b\na=c\nc=box.right",
        "late-feed": "let a=good\nlet b=a\nlet c=b\na=c\nsay b." + prop + "\nc=bad",
        otherwise: "let a=bad\nlet b=good\nlet relay=b otherwise a\nrelay=a\nb=relay\na=b",
        diamond: "let a=good\nlet b=a\nlet c=a\nlet d=b\nd=c\na=d\nc=bad",
      };
      for ([axis, body] of Object.entries(axes)) {
        for (read of [false, true]) {
          add(
            `cycles/${axis}/${depth}/${swapped}/${read}`,
            setup + body + (read ? "\nsay a." + prop : ""),
            "cycle",
          );
        }
      }
      add(
        `cycle-control/${depth}/${swapped}`,
        setup + "let a=good\nlet b=a\nlet c=b\na=c\nb=good\nc={}",
        "control",
        { valid: true },
      );
    }
  }
  for ([kind, setup, prop, bad] of [
    ["down", "let a={tone:1,inner:null}\na.inner=a", "inner.tone", '{inner:{tone:"bad"}}'],
    ["up", "let a={inner:{tone:1}}\na=a.inner", "tone", '{tone:"bad"}'],
    [
      "composed",
      "let a={left:{right:{tone:1}}}\nlet bridge=a.left\na=bridge.right",
      "tone",
      '{tone:"bad"}',
    ],
    [
      "mixed",
      "let a={tone:1,inner:null}\nlet bridge=a\na=bridge\na.inner=bridge",
      "inner.tone",
      '{inner:{tone:"bad"}}',
    ],
  ]) {
    for (swapped of [false, true]) {
      [first, second] = swapped ? ["bad", "a"] : ["a", "bad"];
      for (read of [false, true]) {
        for (literal of [false, true]) {
          body = literal
            ? `let other=[${first},${second}]`
            : `let other=${first}
other=${second}`;
          expr = literal ? "other[0]." + prop : "other." + prop;
          add(
            `stepped/${kind}/${swapped}/${read}/${literal}`,
            setup +
              `
let bad=${bad}
` +
              body +
              (read ? "\nsay " + expr : ""),
            "step",
          );
        }
      }
    }
  }
  for (optional of ["object", "object?"]) {
    for (swapped of [false, true]) {
      [a, b] = swapped ? ["b", "a"] : ["a", "b"];
      add(
        `generic/${optional}/${swapped}`,
        `let a={tone:1}
let b={tone:"bad"}
let result:${optional}=${a}
result=${b}`,
        "control",
        { valid: true },
      );
      add(
        `generic-source/${optional}/${swapped}`,
        `let a:${optional}={tone:1}
let b:${optional}={tone:"bad"}
let result=[${a},${b}]`,
        "generic",
      );
    }
  }

  return cases.map((c) => [c.name, c.source ?? c.files[0].source]);
})();
export const checks = ["publication", "stops"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["python3 make-cases.py", "R/astra-m4-i1249-review-evidence/REPRODUCE.md:15"],
    [
      'node run.mjs "$review_tree" cases.json out/cases-new.jsonl',
      "R/astra-m4-i1249-review-evidence/REPRODUCE.md:17",
    ],
    [
      "node run.mjs /home/peter/work/astra1293/base cases.json out/cases-base.jsonl",
      "R/astra-m4-i1249-review-evidence/jobs.json#/home/peter/queue/done/5-20261028212624102310046-astra1293-cases-base.job:4",
    ],
    [
      "node run.mjs /home/peter/work/astra1293/head cases.json out/cases-head.jsonl",
      "R/astra-m4-i1249-review-evidence/jobs.json#/home/peter/queue/done/5-20261028212624095546012-astra1293-cases-head.job:4",
    ],
  ],
  sources: 274,
  sha256: "cbff250004edd31623c3cfa50935925948a2828e2f52cf8d4503b7c1ff35ecbf",
};
