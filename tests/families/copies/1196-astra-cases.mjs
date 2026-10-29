// #1196; Astra review.
export const cases = (() => {
  const parse = (input, fallback = "seed", files = "false") =>
    `fromJson(${input}${fallback === null ? "" : `, default: ${fallback}`}, files: ${files})`;
  const cases = [];
  const add = (name, lines, globals = ["hostValue", "otherHost", "thirdHost"]) =>
    cases.push({
      name,
      globals,
      files: [{ path: "main.tease", source: [...lines, "exit", ""].join("\n") }],
    });
  add("nested-list-leaves", [
    "let box = [{a: [hostValue]}, {a: [hostValue]}, {a: [hostValue]}]",
    "let n: integer = box[0].a[0]",
  ]);
  add("nested-record-leaves", [
    "let box = [{a: {b: hostValue}}, {a: {b: hostValue}}, {a: {b: hostValue}}]",
    "let n: integer = box.last.a.b",
  ]);
  add("several-globals-leaves", [
    "let box = [{a: hostValue}, {a: otherHost}, {a: hostValue}, {a: thirdHost}]",
    "let n: integer = box[0].a",
  ]);
  add("root-versus-projection", [
    "let box = [[hostValue.text], [hostValue], [hostValue.text], [otherHost.text]]",
    "let n: integer = box.first[0]",
  ]);
  add("otherwise-nested", [
    "let box = [{a: hostValue otherwise null}, {a: hostValue otherwise null}, {a: otherHost otherwise null}]",
    "let n: integer = box[0].a",
  ]);
  add("choice-nested", [
    'let chosen = askChoice {text: "x", value: {a: [hostValue]}}, {text: "y", value: {a: [hostValue]}}, {text: "z", value: {a: [otherHost]}}',
    "let n: integer = chosen.a[0]",
  ]);
  add("call-arguments", [
    "function echo(x) { return x }",
    "let box = [echo({a: hostValue}), echo({a: hostValue}), echo({a: otherHost})]",
    "let n: integer = box[0].a",
  ]);
  add("typed-call-arguments", [
    "function sumValues(x: integer, y: integer) { return x + y }",
    "let n = sumValues(hostValue, hostValue)",
    "let m = sumValues(otherHost, hostValue)",
  ]);
  add("guarded-root", [
    "let raw = hostValue",
    "if hostValue is string {",
    " let box = [[hostValue], [hostValue], [raw], [otherHost]]",
    " let n: integer = box[0][0]",
    "}",
    "let outside: integer = hostValue",
  ]);
  add("guarded-descendant", [
    "let before = {a: hostValue}",
    "if hostValue.text is string {",
    " let box = [{a: hostValue}, {a: hostValue}, before]",
    " let n: integer = box[0].a.text",
    "}",
    "let after: integer = hostValue.text",
  ]);
  add("guarded-siblings", [
    "if hostValue.left is integer {",
    " let a = [hostValue, hostValue]",
    " let n: integer = a[0].left",
    "}",
    "if hostValue.right is string {",
    " let b = [hostValue, hostValue]",
    " let m: integer = b[0].left",
    "}",
  ]);
  add("written-list-landings", [
    `let a: number[][] = [${parse("hostValue", "[1]")}, ${parse("hostValue", "[1]")}]`,
    `let b: integer[][] = [${parse("hostValue", "[1]")}, ${parse("otherHost", "[1]")}]`,
    "let n: integer = a[0][0]",
    "repeat b[0][0] {}",
  ]);
  add("null-open-fields", [
    "let seed = {count: 2, child: {open: null}, list: []}",
    `let box = [${parse("hostValue")}, ${parse("hostValue")}, ${parse("otherHost")}]`,
    "repeat box[0].count {}",
    "let n: integer = box[0].child.open",
    "let m: integer = box[0].list[0]",
  ]);
  add("host-open-default", [
    "let seed = {count: 2, child: {open: otherHost}}",
    `let box = [${parse("hostValue")}, ${parse("hostValue")}, ${parse("thirdHost")}]`,
    "let n: integer = box[0].child.open",
  ]);
  for (const files of ["true", "false", "hostValue"])
    add(`files-${files}`, [
      "let seed = {count: 2}",
      `let box = [${parse("hostValue", "seed", files)}, ${parse("hostValue", "seed", "false")}, ${parse("otherHost", "seed", "true")}]`,
      "repeat box[0].count {}",
    ]);
  add("defaults-nested-different", [
    "let a = {child: {n: 1}, open: null}",
    "let b = {child: {n: 1.5}, open: null}",
    `let box = [${parse("hostValue", "a")}, ${parse("hostValue", "b")}, ${parse("hostValue", "a")}]`,
    "let n: integer = box[0].child.n",
    "let m: integer = box[0].open",
  ]);
  add("open-and-typed-parses", [
    "let seed = {a: {n: 1}}",
    `let box = [${parse("hostValue", null)}, ${parse("hostValue")}, ${parse("hostValue", null)}, ${parse("hostValue")}]`,
    "let n: integer = box[0].a.n",
  ]);
  add("guarded-parse-options", [
    "let seed = {n: 1}",
    `let before = ${parse("hostValue.text")}`,
    "if hostValue.text is string {",
    ` let box = [${parse("hostValue.text")}, ${parse("hostValue")}, before, ${parse("hostValue.text")}]`,
    " repeat box[0].n {}",
    "}",
  ]);
  add("reassigned-default", [
    "let seed = {a: {n: 1}}",
    `let old = ${parse("hostValue")}`,
    "seed.a.n = 2.5",
    `let box = [old, ${parse("hostValue")}, ${parse("otherHost")}]`,
    "let n: integer = box[0].a.n",
  ]);
  add("call-writes-default", [
    "global seed = {a: {n: 1}}",
    "function change {",
    " seed.a.n = 2.5",
    " return hostValue",
    "}",
    `let box = [${parse("hostValue")}, ${parse("change()")}, ${parse("hostValue")}]`,
    "let n: integer = box[0].a.n",
  ]);
  add("alias-of-parsed", [
    "let seed = {a: {n: 1}, open: null}",
    `let parsed = ${parse("hostValue")}`,
    "let one = parsed",
    "let two = one",
    `let box = [one, two, ${parse("hostValue")}, parsed]`,
    "repeat box[0].a.n {}",
    "let n: integer = box[0].open",
  ]);
  add("nested-parse-carriers", [
    "let seed = {a: {n: 1}, open: null}",
    `let box = [{x: {y: ${parse("hostValue")}}}, {x: {y: ${parse("hostValue")}}}, {x: {y: ${parse("otherHost")}}}]`,
    "repeat box[0].x.y.a.n {}",
    "let n: integer = box[0].x.y.open",
  ]);
  add("load-with-direct-default", [
    'let box = [load("alpha", default: hostValue), load("beta", default: hostValue), load("alpha", default: otherHost)]',
    "let n: integer = box[0].count",
  ]);
  add("computed-key-and-nested-parse", [
    "let seed = {n: 1}",
    `let box = [load(hostValue, default: ${parse("otherHost")}), load(otherHost, default: ${parse("hostValue")})]`,
    "repeat box[0].n {}",
  ]);
  add("adds-and-nested-wrappers", [
    "let box = []",
    "box.add({a: [hostValue]})",
    "box.add({a: [hostValue]})",
    "box.add({a: [otherHost]})",
    "let n: integer = box.last.a[0]",
  ]);
  add("set-and-concatenation", [
    "let a = [{n: hostValue}] + [{n: hostValue}] + [{n: otherHost}]",
    "let b = set[hostValue, hostValue, otherHost]",
    "let n: integer = a[0].n",
    "let m: integer = b.first",
  ]);
  add("separate-file-reads", [
    "let a = {n: hostValue}",
    "let b = {n: hostValue}",
    "let n: integer = a.n",
    "let m: integer = b.n",
  ]);
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
})();
export const checks = ["publication"];
