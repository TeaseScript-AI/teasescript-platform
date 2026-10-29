// family-choice-read, family-literal-read and related fixed cases; Astra review, round unrecorded
// (R/astra-m4-s6c-review-evidence/cases.mjs).
export const cases = (() => {
  const cases = [];
  const add = (
    name,
    setup,
    expr,
    after = "",
    paths = [[], ["f"], ["element"], ["element", "f"]],
  ) => {
    const prefix = setup + "\nlet observed = ";
    cases.push({
      name,
      files: [{ path: "main.tease", source: prefix + expr + "\n" + after + "\nexit\n" }],
      probe: { start: prefix.length, end: prefix.length + expr.length, paths },
    });
  };
  const pair = (a, b) => `askChoice {text:"left",value:(${a})},{text:"right",value:(${b})}`;
  const root =
    "let raw = hostValue\nlet root = {f:1, g:2.5}\nlet bucket = [root]\nlet maybe = [null,root].first";
  const families = [
    ["read", "root"],
    ["alias", "alias"],
    ["property", "({wrap:root}).wrap"],
    ["selection", "[root].last"],
    ["index", "[root][0]"],
    ["length", "({length:root}).length"],
    ["dict-values", "dict{a:root}.values.first"],
    ["call", "give()"],
    ["literal", "{f:1,g:2.5}"],
    ["get", "bucket.get(9,default:root)"],
    ["otherwise", "maybe otherwise root"],
    ["load", 'load("record",default:root)'],
    ["parse", 'fromJson("{}",default:root,files:false)'],
    ["removeFirst", "[root].removeFirst()"],
    ["removeLast", "[root].removeLast()"],
    ["removeAt", "[root].removeAt(0)"],
    ["remove-dict", 'dict{a:root}.remove("a")'],
    ["take", "bucket.take(1).first"],
    ["takeLast", "bucket.takeLast(1).first"],
    ["toList", "bucket.toList().first"],
    ["toSet", "bucket.toSet().first"],
    ["sum", "([root]+[root]).last"],
    ["choice", 'askChoice {text:"inner",value:root}'],
    ["declared", "bucket.count(root)"],
    ["unmodelled", '"abc".split("b")'],
    ["builtin", "max(1,2)"],
    ["convert", 'toInteger("2",default:1)'],
    ["operator", "1+2"],
    ["logic", "true and false"],
    ["comparison", "1<2"],
    ["test", "root is object"],
    ["interpolation", '"value {1}"'],
    ["ask", 'askInteger "n"'],
    ["clock", "getDateTime()"],
    ["unit", "1 s"],
    ["angle", "2 deg"],
    ["range", "1..3"],
  ];
  for (const [name, expr] of families) {
    const setup = root + "\nlet alias = root\nfunction give { return root }";
    add("family-choice-" + name, setup, pair(expr, expr), "repeat observed.f {}");
    add("family-literal-" + name, setup, `[(${expr}),(${expr})]`, "repeat observed.first.f {}");
  }
  add(
    "callee",
    'function left { return {f:1} }\nfunction right { return {f:"bad"} }',
    pair("left()", "right()"),
    "repeat observed.f {}",
  );
  add(
    "call-return-signature",
    'global state = {f:1}\nfunction sample { return state }\nfunction shift { state = {f:"bad"}\nreturn "second" }',
    'askChoice {text:"first",value:sample()},{text:shift(),value:sample()}',
    "repeat observed.f {}",
  );
  add(
    "method-name",
    "let root = {f:1}",
    pair("[root].removeFirst()", "[root].clear()"),
    "repeat observed.f {}",
  );
  add(
    "method-copy-name",
    "let xs = [1]",
    pair("xs.toList()", "xs.toSet()"),
    "let check: integer[] = observed",
  );
  add(
    "projection-step",
    'let seed = {a:{f:1},b:{f:"bad"}}',
    pair("({x:seed}).x.a", "({x:seed}).x.b"),
    "repeat observed.f {}",
  );
  add(
    "parse-named-default",
    'let good = {f:1}\nlet bad = {f:"bad"}',
    pair('fromJson("{}",default:good,files:false)', 'fromJson("{}",default:bad,files:false)'),
    "repeat observed.f {}",
  );
  for (const kind of ["load", "parse", "fan"]) {
    const expr =
      kind === "load"
        ? 'load("slot",default:root)'
        : kind === "parse"
          ? 'fromJson("{}",default:root,files:false)'
          : "a+1";
    add(
      "mixed-" + kind,
      "let raw = hostValue\nlet a = [raw,1].first\nlet root = {f:a,g:1}",
      pair(expr, expr),
      "repeat observed.f {}\nrepeat observed {}",
    );
    add(
      "mixed-literal-" + kind,
      "let raw = hostValue\nlet a = [raw,1].first\nlet root = {f:a,g:1}",
      `[${expr},${expr}]`,
      "repeat observed.first.f {}",
    );
  }
  for (const broken of ["class", "writer", "mixed"]) {
    const setup =
      broken === "class"
        ? 'let a=[{f:1}]\nlet b=[{f:"bad"}]'
        : broken === "writer"
          ? "let root=[{f:1}]\nlet a=root\nlet b=root"
          : 'let raw=hostValue\nlet a=[load("a",default:{f:raw})]\nlet b=[load("b",default:{f:raw})]';
    add(
      "sum-" + broken,
      setup,
      broken === "writer" ? "b+b+b+b+a" : "a+a+a+a+b",
      "repeat observed.first.f {}",
    );
  }
  for (const event of [
    'if raw != null { root.inner.f = "bad" }',
    'root.inner.f = "bad"',
    'root = {inner:{f:"bad",g:1}}',
    "change()",
  ]) {
    for (const placement of ["before", "between"]) {
      const setup =
        'let raw=hostValue\nglobal root={inner:{f:1,g:2}}\nfunction change { root.inner.f="bad" }\n' +
        (placement === "before" ? event + "\n" : "") +
        "let a=root.inner\n" +
        (placement === "between" ? event + "\n" : "") +
        "let b=root.inner";
      add(
        "events-" + placement + "-" + event,
        setup,
        pair("a", "b"),
        "repeat observed.f {}\nrepeat observed.g {}",
      );
    }
  }
  for (const domain of ["number", "number?", "null", "number | string"])
    for (const form of ["otherwise", "get", "remove", "choice", "dict", "call"]) {
      const seed = domain === "null" ? "null" : "1";
      const setup = `let typed:${domain}=${seed}\nlet copy=(typed)\nfunction read { return copy }`;
      const expr = {
        otherwise: "null otherwise copy",
        get: "[].get(0,default:copy)",
        remove: "[copy].removeLast()",
        choice: 'askChoice {text:"a",value:copy},{text:"b",value:typed}',
        dict: "dict{a:copy}.values.first",
        call: "read()",
      }[form];
      add(
        "written-" + domain + "-" + form,
        setup,
        pair(expr, expr),
        "observed = hostValue\nrepeat observed {}",
      );
    }
  add(
    "choice-held-options",
    'let held={text:"fallback",value:{f:1}}\nlet absent={text:{f:"bad"}}',
    "askChoice held,absent",
    "repeat observed.f {}",
  );
  add(
    "choice-bottom",
    "function empty { return empty() }",
    'askChoice {text:"fallback",value:empty()},{text:{f:1}}',
    "repeat observed.f {}",
  );
  add(
    "choice-mixed-root",
    "let raw=hostValue\nlet root={f:raw,g:1}\nlet alias=root",
    pair("root", "alias"),
    "repeat observed.f {}\nrepeat observed.g {}",
  );
  add(
    "crossed-roles",
    'let root={f:"bad",g:1}\nlet xs=[root]\nlet l0=xs\nlet l1=xs\nlet a0=root\nlet a1=root',
    pair("l1.get(0,default:a0)", "l0.get(0,default:a1)"),
    "repeat observed.f {}",
  );
  add(
    "choice-different-empty",
    "let a=[]\nlet b=[{f:1}]",
    pair("a.first", "b.first"),
    "repeat observed.f {}",
  );
  for (const event of ["if raw != null { root.inner.f = 3.5 }", "root.inner.f = 3.5", "mutate()"]) {
    for (const early of [true, false])
      for (const shape of ["plain", "written", "mixed"]) {
        const setup =
          "let raw=hostValue\nglobal root={inner:{f:1,g:1}}\nroot={inner:{f:[1,raw].first,g:1}}\nfunction mutate { root.inner.f=3.5 }\n" +
          (early ? event + "\n" : "") +
          "let stable=root.inner\nlet box=" +
          (shape === "mixed" ? "{f:raw,g:0}" : "root.inner") +
          "\n" +
          (shape === "written" ? "let written:object=stable\n" : "") +
          (early ? "" : event + "\n") +
          Array.from(
            { length: 5 },
            (_, i) => `box=${shape === "written" && i % 2 ? "written" : "stable"}`,
          ).join("\n");
        add(
          "member-" + event + "-" + early + "-" + shape,
          setup,
          "box",
          "box.f = hostValue\nrepeat observed.f {}\nrepeat box.f {}\nrepeat box.g {}",
        );
      }
  }
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [["node review.mjs own", "R/astra-m4-s6c-review-evidence/own3.jsonl:1"]],
  sources: 144,
  sha256: "bf5746c394f9113fb16248fb1615aa59c156122ec86a5d85089273353ddadc49",
};
