const corpus = (() => {
  const many = (n, f, sep = "\n") => Array.from({ length: n }, (_, i) => f(i)).join(sep);
  const program = (...s) => s.join("\n") + "\nexit\n";
  const chain = (n, last) => `[0] + ${many(n, (i) => `[${i + 1}]`, " + ")} + [${last}]`;
  const choice = (n, global = "hostValue", wrap = (x) => x) =>
    `askChoice ${many(n, (i) => `{text: "option${i}", value: ${wrap(`${global}.p${i}`)}}`, ", ")}`;
  const max = (n) => `${"max(".repeat(n)}hostValue.n${many(n, (i) => `, ${i})`, "")}`;
  const shapes = {};
  const endings = {
    string: '"tail"',
    number: "1.5",
    boolean: "true",
    null: "null",
    duration: "1 s",
    angle: "90 deg",
    calendar: "1 calendar month",
    object: "{n:1}",
    list: "[1]",
    dict: "dict{a:1}",
    set: "set[1,2]",
    range: "1..3",
    regex: "/x/",
    date: 'toDate("2026-01-01")',
    time: 'toTime("12:00")',
    datetime: 'toDateTime("2026-01-01T12:00")',
    host: "otherHost",
  };
  for (const [name, last] of Object.entries(endings))
    shapes[`end-${name}`] = (n) => program(`let s = ${chain(n, last)}`, "say s.length");
  for (const type of ["absoluteDateTime", "speaker", "timer", "media", "messageHandle", "script"])
    shapes[`end-${type}`] = (n) =>
      program(`let tail: ${type} = otherHost`, `let s = ${chain(n, "tail")}`, "say s.length");
  shapes["nested-object-joins"] = (n) => {
    let e = "[0]";
    for (let i = 0; i < n; i++) e = `({a: [${e} + [${i}]]}).a[0]`;
    return program(`let s = ${e} + [true]`, "say s.length");
  };
  shapes["forked-bound-prefixes"] = (n) =>
    program(
      "let a0 = [0]",
      "let b0 = [0]",
      many(
        n,
        (i) => `let a${i + 1} = a${i} + [${i}]
let b${i + 1} = b${i} + [${i}]
let z${i} = [a${i + 1}, b${i + 1}]
say z${i}[hostValue.i].length`,
      ),
    );
  shapes["wide-role-alias-permutations"] = (n) =>
    program(
      `let a = ${max(n)}`,
      `let b = ${max(n)}`,
      `let c = ${max(n)}`,
      "let d = a",
      many(
        n,
        (i) => `let s${i} = [${["a,b,c", "c,a,b", "b,d,c", "d,b"][i % 4]}]
let n${i}: integer = s${i}[hostValue.i]`,
      ),
    );
  shapes["three-leaf-classes-rotating"] = (n) =>
    program(
      `let a = ${choice(n)}`,
      `let b = ${choice(n)}`,
      `let c = ${choice(n, "otherHost")}`,
      `let d = ${choice(n, "otherHost")}`,
      `let e = ${choice(n, "hostValue", (x) => `load("${x}", default: ${x})`)}`,
      `let f = ${choice(n, "hostValue", (x) => `load("${x}", default: ${x})`)}`,
      many(
        n,
        (i) => `let s${i} = [${["a,b,c,d,e,f", "f,e,d,c,b,a", "c,a,e,d,b,f"][i % 3]}]
let n${i}: integer = s${i}[hostValue.i]`,
      ),
    );
  shapes["leaf-choices-in-properties"] = (n) =>
    program(
      `let a = ${choice(n)}`,
      `let b = ${choice(n)}`,
      many(
        n,
        (i) => `let s${i} = [{p:a}, {p:b}]
let n${i}: integer = s${i}[hostValue.i].p`,
      ),
    );
  shapes["wide-choice-with-literal"] = (n) =>
    program(
      `let a = ${choice(n)}`,
      `let b = ${choice(n)}`,
      many(
        n,
        (i) => `let s${i} = [${i % 2 ? "b, [false], a" : "a, [0], b"}]
let n${i}: integer = s${i}[hostValue.i]`,
      ),
    );
  shapes["repeat-add-classes"] = (n) =>
    program(
      "let xs = []",
      many(n, (i) => `xs.add({a: ${i}, b: true})`),
      "say xs[hostValue.i].a",
    );
  shapes["long-right-operands"] = (n) =>
    program(
      `let x = ${max(n)}`,
      `let y = ${max(n)}`,
      `let z = ${max(n)}`,
      "let s = x + y + z + x + y + z",
      "say s",
    );
  return { shapes: shapes };
})();
export const sizes = [4, 8, 64, 128];
export const shapes = corpus.shapes;

export const checks = ["publication"];
