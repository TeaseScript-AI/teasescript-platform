// #1313; Astra review; shared generation code from one original module.
export const sizes = [64, 128];
const outputs = (() => {
  const many = (k, f, sep = ", ") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const wide = (k, value = "1") => `{${many(k, (i) => `p${i}:${value}`)}}`;
  const nested = (value, depth) => (depth ? `{box:${nested(value, depth - 1)}}` : value);
  const comp = (i, host = "hostValue", fallback = "{p0:1}", inner = false) =>
    `(load("own${i}", default:${host}) otherwise ${inner ? `(fromJson("{}", default:otherHost) otherwise ${fallback})` : fallback})`;
  const growth = {
    namedTwoGlobals(k) {
      const decl = many(
        k,
        (i) => `let n${i}=load("own${i}", default:${i % 2 ? "otherHost" : "hostValue"})`,
        "\n",
      );
      const es = Array.from({ length: k }, (_, i) => `n${i}`);
      es.splice(Math.floor(k / 3), 0, wide(k));
      es.push(wide(k));
      return `${decl}\nlet xs=[${es}]\n${many(k, (i) => `let out${i}:integer=xs[0].p${i}`, "\n")}\nexit`;
    },
    namedParsesTwoWide(k) {
      const decl = many(
        k,
        (i) => `let n${i}=fromJson("{}", default:${i % 2 ? "hostValue" : "otherHost"})`,
        "\n",
      );
      return `${decl}\nlet xs=[${wide(k)},${many(k, (i) => `n${k - i - 1}`)},${wide(k)}]\n${many(k, (i) => `let out${i}:integer=xs[1].p${i}`, "\n")}\nexit`;
    },
    namedComposites(k) {
      const decl = many(
        k,
        (i) =>
          `let n${i}=${comp(i, i % 2 ? "hostValue" : "otherHost", i % 3 ? "{p0:1}" : "{p0:1,p1:2}")}`,
        "\n",
      );
      return `${decl}\nlet xs=[${many(k, (i) => `n${i}`)},${wide(k)},${wide(k)}]\n${many(k, (i) => `let out${i}:integer=xs[0].p${i}`, "\n")}\nexit`;
    },
    twoDeepTwoWide(k) {
      const es = Array.from({ length: k }, (_, i) =>
        nested(comp(i, i % 2 ? "hostValue" : "otherHost", "{p0:1}", true), 2),
      );
      es.splice(Math.floor(k / 3), 0, nested(wide(k), 2));
      es.push(nested(wide(k), 2));
      return `let xs=[${es}]\n${many(k, (i) => `let out${i}:integer=xs[0].box.box.p${i}`, "\n")}\nexit`;
    },
    compositeDifferentProperties(k) {
      const es = Array.from({ length: k }, (_, i) =>
        comp(i, "hostValue", i % 2 ? "{p0:1,p1:2}" : "{p0:1}"),
      );
      es.splice(Math.floor(k / 3), 0, wide(k));
      es.push(wide(k));
      return `let xs=[${es}]\n${many(k, (i) => `let out${i}:integer=xs[0].p${i}`, "\n")}\nexit`;
    },
    alternatingNamedObjects(k) {
      const decl = many(
        k,
        (i) => `let n${i}=${i % 3 === 0 ? "{p0:1}" : i % 3 === 1 ? "{p0:1,p1:2}" : "hostValue"}`,
        "\n",
      );
      const es = Array.from({ length: k }, (_, i) => `n${k - i - 1}`);
      es.splice(Math.floor(k / 3), 0, wide(k));
      es.push(wide(k));
      return `${decl}\nlet xs=[${es}]\n${many(k, (i) => `let out${i}:integer=xs[0].p${i}`, "\n")}\nexit`;
    },
  };
  const cases = [];
  const add = (name, source, extras = {}) =>
    cases.push({ name, source: source + "\nexit", ...extras });
  const values = [
    ["object", "{p:1,q:2}", "{p:3,q:4}"],
    ["load", 'load("a",default:hostValue)', 'load("b",default:otherHost)'],
    [
      "composite",
      '(load("a",default:hostValue) otherwise {p:1,q:2})',
      '(fromJson("{}",default:otherHost) otherwise {p:3,q:4})',
    ],
  ];
  for (const [kind, va, vb] of values)
    for (const reversed of [false, true]) {
      const order = reversed ? "b,a" : "a,b";
      const xs = `let xs=[${order},{p:5,q:6}]\nlet take:integer=xs[0].p\nsay xs[1].q`;
      const decl = `let a=${va}\nlet b=${vb}`;
      const templates = {
        branchDefinitions: `if hostValue is boolean {\n${decl}\n${xs}\n}`,
        loopDefinitions: `for i in [1,2] {\n${decl}\n${xs}\n}`,
        branchReassignment: `${decl}\nif hostValue is boolean { a=${vb} }\n${xs}`,
        loopReassignment: `${decl}\nfor i in [1,2] { a=${vb}\n${xs}\n}`,
        laterWhole: `${decl}\n${xs}\na=${vb}\nsay xs[0].p`,
        laterBelow: `${decl}\n${xs}\na.p=9\nsay xs[0].p`,
        aliasWhole: `${decl}\nlet ca=a\nlet cb=b\nlet xs=[${reversed ? "cb,ca" : "ca,cb"},{p:5,q:6}]\nlet take:integer=xs[0].p\na=${vb}\nsay xs[1].q`,
        aliasBelow: `${decl}\nlet ca=a\nlet cb=b\nlet xs=[${reversed ? "cb,ca" : "ca,cb"},{p:5,q:6}]\nca.p=9\nlet take:integer=xs[0].p`,
        projections: `let oa={box:${va}}\nlet ob={box:${vb}}\nlet a=oa.box\nlet b=ob.box\n${xs}\nob.box.p=9`,
        guardOne: `${decl}\nif a.p is integer {\n${xs}\n}`,
        guardedDefinitions: `if hostValue.p is integer {\n${decl}\n${xs}\n}`,
        deadLocal: `function inspect {\nexit\n${decl}\n${xs}\n}\ninspect()`,
        callableWrite: `${decl}\nfunction change { a=${vb} }\n${xs}\nchange()\nsay xs[0].p`,
      };
      for (const [shape, source] of Object.entries(templates))
        add(`${kind}-${shape}-${reversed}`, source);
    }
  for (const receiver of ["a.p", "b.p", "xs[0].p", "copy[0].p"])
    for (const reversed of [false, true])
      for (const bad of [false, true]) {
        const statement = `${receiver}=${bad ? '"wrong"' : "9"}`;
        add(
          `store-${receiver}-${reversed}-${bad}`,
          `let a={p:1}\nlet b={p:2}\nlet xs=[${reversed ? "b,a" : "a,b"},{p:3,q:4}]\nlet copy=xs\n${statement}\nsay xs[0].p`,
          { control: { bad, statement } },
        );
      }
  for (const other of ['{p:"text"}', "{q:2}", "{p:null}", "{p:1.5}", "{p:true}", "[1,2]"])
    for (const reversed of [false, true])
      add(
        `different-${other}-${reversed}`,
        `let a={p:1}\nlet b=${other}\nlet xs=[${reversed ? "b,a" : "a,b"},{p:3,q:4}]\nsay xs[0].p\nxs[0].p="wrong"`,
      );
  for (const depth of [0, 2])
    for (const variation of ["defaults", "otherwise", "roles", "fan"])
      for (const reversed of [false, true]) {
        const members = [0, 1, 2, 3].map((i) => {
          const host = variation === "defaults" && i % 2 ? "otherHost" : "hostValue";
          let fallback = variation === "otherwise" && i % 2 ? "{p0:1,p1:2}" : "{p0:1}";
          let v = comp(i, host, fallback, true);
          if (variation === "roles")
            v = `([${i % 2 ? "hostValue,otherHost" : "hostValue"}][0] otherwise ${fallback})`;
          if (variation === "fan")
            v = `((hostValue + ${i % 2 ? '"text"' : "1"}) otherwise ${i % 2 ? '"text"' : "1"})`;
          return nested(v, depth);
        });
        if (reversed) members.reverse();
        members.splice(1, 0, nested(wide(3), depth));
        members.push(nested(wide(3), depth));
        const access = `xs[0].${"box.".repeat(depth)}p1`;
        add(
          `composite-${variation}-${depth}-${reversed}`,
          `let xs=[${members}]\nlet answer:integer=${access}\nsay xs[1].${"box.".repeat(depth)}p2`,
          {
            ...(variation === "defaults" || variation === "otherwise"
              ? { origins: { text: access, pattern: "load|fromJson|hostValue|otherHost" } }
              : {}),
          },
        );
      }
  for (const [name, generate] of Object.entries(growth)) add(`growth-small-${name}`, generate(4));
  const cases0 = (() => {
    return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
  })();
  const shapes1 = (() => {
    return {
      namedTwoGlobals: (n) => growth["namedTwoGlobals"](n),
      namedParsesTwoWide: (n) => growth["namedParsesTwoWide"](n),
      namedComposites: (n) => growth["namedComposites"](n),
      twoDeepTwoWide: (n) => growth["twoDeepTwoWide"](n),
      compositeDifferentProperties: (n) => growth["compositeDifferentProperties"](n),
      alternatingNamedObjects: (n) => growth["alternatingNamedObjects"](n),
    };
  })();
  return { cases0, shapes1 };
})();
export const cases = [...outputs.cases0];
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes1).map(([name, make]) => ["shapes1/" + name, make]),
]);
export const checks = ["publication"];
