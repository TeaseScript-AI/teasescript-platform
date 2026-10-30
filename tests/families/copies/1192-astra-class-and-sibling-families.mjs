// discovery classes, written-depth and sibling stores; #1192, astra-m4-i1192-review-evidence, archived Python/shell
// evidence, round unrecorded (R/astra-m4-i1192-review-evidence/generate.py).
const generated = (() => {
  let bad,
    bindings,
    cases,
    changes,
    depth,
    expr,
    fitting,
    growth,
    guard,
    init,
    kind,
    middle,
    n,
    order,
    position,
    props,
    reverse,
    selector,
    setup,
    store,
    stores,
    tail,
    term,
    terms,
    ty,
    value,
    variant,
    xs;
  cases = [];
  function add(name, source) {
    cases.push({ name: name, files: [{ path: "main.tease", source: source + "\nexit\n" }] });
  }
  for ([kind, init] of [
    ["host", "let a=hostValue\nlet b=hostValue"],
    ["loads", 'let a=load("left",default:{v:1})\nlet b=load("right",default:{v:1})'],
    ["parse", 'let a=fromJson("{}",default:{v:1})\nlet b=fromJson("{}",default:{v:1})'],
    ["leaf", "let seed={v:1}\nlet a={part:seed}\nlet b={part:seed}"],
  ]) {
    for (order of ["a,b,w", "w,a,b", "a,w,b", "b,w,a"]) {
      if (kind === "host") {
        setup = init + "\nlet w:integer=1";
        tail = "repeat out[0] {}\nrepeat out[2] {}";
      } else {
        if (kind === "leaf") {
          setup = init + '\nlet w={part:{v:"no"}}';
          tail = "repeat out[0].part.v {}\nrepeat out[2].part.v {}";
        } else {
          setup = init + '\nlet w={v:"no"}';
          tail = "repeat out[0].v {}\nrepeat out[2].v {}";
        }
      }
      add("g1-" + kind + "-" + order, setup + "\nlet out=[" + order + "]\n" + tail);
    }
  }
  for (guard of ["hostValue is integer", "hostValue is string", "hostOther is integer"]) {
    for (order of ["a,b,w", "w,b,a", "b,w,a"]) {
      add(
        "g1-guard-" + guard + "-" + order,
        'let a=load("a",default:hostValue)\nlet w:integer=1\nif ' +
          guard +
          ' {\nlet b=load("b",default:hostValue)\nlet out=[' +
          order +
          "]\nrepeat out[0] {}\nrepeat out[2] {}\n}",
      );
    }
  }
  for (middle of ["integer", "number", "string"]) {
    for (order of ["a,w,b", "w,b,a"]) {
      value = middle === "string" ? '"yes"' : "1";
      add(
        "g1-written-middle-" + middle + "-" + order,
        "let a=hostValue otherwise 1\nlet b=hostValue otherwise 1\nlet w:" +
          middle +
          "=" +
          value +
          "\nlet out=[" +
          order +
          "]\nlet landing=out\nrepeat landing[0] {}\nrepeat landing[2] {}",
      );
    }
  }
  for (order of ["a,w,b", "b,w,a", "w,a,b"]) {
    add(
      "g1-object-leaves-" + order,
      'let a={inner:load("a",default:{v:1})}\nlet b={inner:load("b",default:{v:1})}\nlet typed:integer=0\nlet w={inner:{v:typed}}\nlet out=[' +
        order +
        ']\nlet second=[out[0],out[2],{inner:{v:"bad"}}]\nrepeat second[1].inner.v {}',
    );
  }
  terms = [
    "integer",
    "integer?",
    "integer | string",
    "integer[] | string[]",
    "list",
    "object",
    "integer set",
    "integer dict",
  ];
  for (term of terms) {
    for (depth of [2, 4]) {
      ty = "(" + term + ")" + "[]".repeat(depth);
      fitting = "[".repeat(depth) + "1" + "]".repeat(depth);
      bad = "[".repeat(depth) + "true" + "]".repeat(depth);
      add(
        "g2-" + term + "-" + String(depth),
        `let typed:${ty}=[]
let a=typed
let box={child:typed}
a=typed
box.child=typed
a=${fitting}
let after=a
a=${bad}
box.child=${bad}
let nested=[box]
let projected=nested[0].child
repeat projected` +
          "[0]".repeat(depth) +
          " {}",
      );
    }
  }
  for (depth of [3, 5]) {
    for (term of ["integer[]?[]", "(integer | string)[]", "list[]"]) {
      ty = "(" + term + ")" + "[]".repeat(depth);
      add(
        "g2-suffix-" + term + "-" + String(depth),
        `let typed:${ty}=[]
let a=typed
let box={p:typed}
a=typed
box.p=a
box.p[0]=[]
let suffix=box.p[0]
let again={deep:box.p}
again.deep=typed
let leaf=again.deep` +
          "[0]".repeat(depth + 1) +
          "\nrepeat leaf {}",
      );
    }
  }
  for (selector of ["state.nest", "[state].first.nest", "[state][0].nest"]) {
    for (store of [
      'a.nest.left="bad"',
      'a.nest={left:"bad",right:0}',
      "a.nest.left=hostValue",
      'a.nest[key]="bad"',
    ]) {
      for (reverse of [false, true]) {
        changes = [
          "let a=initial\n" + store + "\nif flag {state=a}",
          "let b=initial\nb.nest.right=true\nif flag {state=b}",
        ];
        if (reverse) {
          changes.reverse();
        }
        add(
          "g4-" + selector + "-" + store + (reverse ? "-rev" : "-src"),
          'let flag=askBoolean "flag"\nlet key=askText "key"\nlet initial={nest:{left:0,right:0}}\nlet state=initial\n' +
            changes.join("\n") +
            `
let warm=${selector}.left
let r:integer=${selector}.right
let l:integer=${selector}.left`,
        );
      }
    }
  }
  for (n of [3, 7]) {
    add(
      "g4-chain-" + String(n),
      "let c0={nest:{p:0,q:0}}\n" +
        Array.from({ length: n + 1 - 1 }, (_, i) => i + 1)
          .map(
            (i) =>
              `let c${i}=c${i - 1}
c${i}.nest.p=` + (i % 2 ? "hostValue" : '"bad"'),
          )
          .join("\n") +
        `
let a:integer=c${n}.nest.p
let b:integer=c${n}.nest.q`,
    );
    add(
      "g4-recursive-" + String(n),
      "let root={leaf:1}\n" +
        Array.from({ length: n - 0 }, (_, i) => i + 0)
          .map((_) => "root={wrap:root}")
          .join("\n") +
        "\nrepeat root" +
        ".wrap".repeat(n) +
        ".leaf {}",
    );
  }
  growth = [];
  function emit(name, n, body) {
    growth.push({ name: name, n: n, files: [{ path: "main.tease", source: body + "\nexit\n" }] });
  }
  for (n of [32, 64]) {
    props = Array.from({ length: n - 0 }, (_, i) => i + 0)
      .map((i) => "p" + String(i) + ":1")
      .join(",");
    bindings = Array.from({ length: n - 0 }, (_, i) => i + 0)
      .map((i) => `let c${i}=seed`)
      .join("\n");
    for ([variant, expr] of [
      ["methods", (i) => `[c${i}].count(c${i})`],
      ["conversions", (i) => `toInteger(c${i}.p0,default:0)`],
    ]) {
      for (position of ["first", "last"]) {
        xs = Array.from({ length: n - 0 }, (_, i) => i + 0).map((i) => "[" + expr(i) + "]");
        if (position === "first") {
          xs.splice(0, 0, "[seed]");
        } else {
          xs.push("[seed]");
        }
        emit(
          "g1-nested-" + variant + "-" + position,
          n,
          `let seed={${props}}
` +
            bindings +
            "\nlet out=[" +
            xs.join(",") +
            "]\n" +
            Array.from({ length: n - 0 }, (_, i) => i + 0)
              .map((i) => `repeat out[0][0].p${i} {}`)
              .join("\n"),
        );
      }
    }
    for (reverse of [false, true]) {
      stores = Array.from({ length: n - 0 }, (_, i) => i + 0).map(
        (i) => `let c${i}=initial
c${i}.outer.nest.p${i}="bad"
if flag {state=c${i}}`,
      );
      if (reverse) {
        stores.reverse();
      }
      emit(
        "g4-deeper-siblings" + (reverse ? "-revsource" : ""),
        n,
        'let flag=askBoolean "flag"\nlet initial={outer:{nest:{' +
          props +
          "}}}\nlet state=initial\n" +
          stores.join("\n") +
          "\n" +
          Array.from({ length: n - 0 }, (_, i) => i + 0)
            .map((i) => `let s${i}:integer=state.outer.nest.p${i}`)
            .join("\n"),
      );
    }
    for (ty of ["integer", "integer?"]) {
      emit(
        "g2-alias-copy-" + ty,
        n,
        "let typed:" +
          ty +
          "[]".repeat(n) +
          "=[]\nlet alias=typed\nlet out=alias\n" +
          Array.from({ length: n - 0 }, (_, i) => i + 0)
            .map((_) => "out=alias")
            .join("\n"),
      );
    }
  }

  return cases.concat(growth).map((c) => [c.name, c.source ?? c.files[0].source]);
})();
export const checks = ["publication"];

// The computed and identity controls its all-own.json oracle recheck also compiled (R/astra-m4-i1192-review-evidence/).
const captured = [
  [
    'g4-computed-valid-state.nest[index]-a.nest[index].left="bad"',
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index].left="bad"\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=state.nest[index].left\nlet r:integer=state.nest[index].right\nexit\n',
  ],
  [
    'g4-computed-valid-state.nest[index]-a.nest[index]={left:"bad",right:0}',
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index]={left:"bad",right:0}\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=state.nest[index].left\nlet r:integer=state.nest[index].right\nexit\n',
  ],
  [
    "g4-computed-valid-state.nest[index]-a.nest[index].left=hostValue",
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index].left=hostValue\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=state.nest[index].left\nlet r:integer=state.nest[index].right\nexit\n',
  ],
  [
    'g4-computed-valid-[state].first.nest[index]-a.nest[index].left="bad"',
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index].left="bad"\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=[state].first.nest[index].left\nlet r:integer=[state].first.nest[index].right\nexit\n',
  ],
  [
    'g4-computed-valid-[state].first.nest[index]-a.nest[index]={left:"bad",right:0}',
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index]={left:"bad",right:0}\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=[state].first.nest[index].left\nlet r:integer=[state].first.nest[index].right\nexit\n',
  ],
  [
    "g4-computed-valid-[state].first.nest[index]-a.nest[index].left=hostValue",
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index].left=hostValue\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=[state].first.nest[index].left\nlet r:integer=[state].first.nest[index].right\nexit\n',
  ],
  [
    'g4-computed-valid-state.nest.get(index, default:{left:0,right:0})-a.nest[index].left="bad"',
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index].left="bad"\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=state.nest.get(index, default:{left:0,right:0}).left\nlet r:integer=state.nest.get(index, default:{left:0,right:0}).right\nexit\n',
  ],
  [
    'g4-computed-valid-state.nest.get(index, default:{left:0,right:0})-a.nest[index]={left:"bad",right:0}',
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index]={left:"bad",right:0}\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=state.nest.get(index, default:{left:0,right:0}).left\nlet r:integer=state.nest.get(index, default:{left:0,right:0}).right\nexit\n',
  ],
  [
    "g4-computed-valid-state.nest.get(index, default:{left:0,right:0})-a.nest[index].left=hostValue",
    'let flag=askBoolean "flag"\nlet index:integer=hostValue\nlet initial={nest:[{left:0,right:0}]}\nlet state=initial\nlet a=initial\na.nest[index].left=hostValue\nif flag {state=a}\nlet b=initial\nb.nest[index].right=true\nif flag {state=b}\nlet l:integer=state.nest.get(index, default:{left:0,right:0}).left\nlet r:integer=state.nest.get(index, default:{left:0,right:0}).right\nexit\n',
  ],
  [
    "g1-identity-inline-list",
    "let out=[hostValue,hostValue,1]\nrepeat out[0] {}\nrepeat out[1] {}\nexit\n",
  ],
  [
    "g1-identity-inline-objects",
    "let out=[{inner:hostValue},{inner:hostValue},{inner:1}]\nrepeat out[0].inner {}\nexit\n",
  ],
  ["g1-identity-written-list", "let out:integer[]=[hostValue,hostValue]\nrepeat out[0] {}\nexit\n"],
  [
    "g1-identity-two-paths",
    "let out={left:hostValue,right:hostValue}\nlet a:integer=out.left\nlet b:string=out.right\nexit\n",
  ],
  [
    "g1-identity-copies",
    "let a=[hostValue,hostValue]\nlet out=[a,a,[1]]\nrepeat out[1][0] {}\nexit\n",
  ],
  [
    "g1-identity-guard",
    "let a=[hostValue,hostValue,1]\nif hostValue is integer {\nlet out=[hostValue,hostValue,a[0]]\nrepeat out[0] {}\n}\nexit\n",
  ],
];
export const cases = [...generated, ...captured];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "TOUCH_ORACLE=1 SUBS_ORACLE=1 node runner.mjs own.json own-results.jsonl main3,h7,h7-oracle,h7-subs own",
      "R/astra-m4-i1192-review-evidence/README.md:11",
    ],
    [
      "env MUTANT=identities node --import ./register.mjs runner.mjs own.json identities-results.jsonl h7 identities",
      "R/astra-m4-i1192-review-evidence/README.md:15",
    ],
    [
      "env MUTANT=one-class node --import ./register.mjs runner.mjs own.json one-class-results.jsonl h7 one-class",
      "R/astra-m4-i1192-review-evidence/README.md:16",
    ],
    [
      "env MUTANT=selector-exact node --import ./register.mjs runner.mjs own.json selector-exact-results.jsonl h7 selector-exact",
      "R/astra-m4-i1192-review-evidence/README.md:17",
    ],
    [
      "env MUTANT=stale-levels node --import ./register.mjs runner.mjs own.json stale-levels-results.jsonl h7 stale-levels",
      "R/astra-m4-i1192-review-evidence/README.md:18",
    ],
    [
      "node --import ./register.mjs runner.mjs growth.json growth-results.jsonl main3,h7 growth",
      "R/astra-m4-i1192-review-evidence/README.md:14",
    ],
    [
      "env TOUCH_ORACLE=1 TRACE_GROUPS=1 node --import ./register.mjs runner.mjs all-own.json oracle-recheck.jsonl h7-oracle oracle-recheck",
      "R/astra-m4-i1192-review-evidence/README.md:19",
    ],
  ],
  sources: 115,
  sha256: "b2dea548a9f00380fa090f87cd02ce961676f81f3fa711d85fa9c53e7ebb37ed",
};
