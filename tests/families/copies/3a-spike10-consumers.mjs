// the integer-only consumers' neighbours (spike 10, Astra's property-repeat): a repeat count, an index read, an index
// store and removeAt over every read form resolved through a projection, in value situations from whole to fractional,
// null, conditional, handler-made, helper-widened and external, each with a twin that copies the operand into a local
// first, and the hand-checked core; 3a checkpoint 9, spike 10 (R/3a-newcore/checkpoint-9/spike10/tools/make-consumers.py),
// each program analysed by spike 10's harness.
export const cases = (() => {
  const out = [];
  const add = (name, source) => out.push([name, source]);
  // value situations: the record and list literals, the setup before the use, the functions
  const SIT = [
    ["whole", "{n: 2}", "[2]", "", ""],
    ["fraction", "{n: 1.5}", "[1.5]", "", ""],
    ["null", "{n: null}", "[null]", "", ""],
    ["null-filled", "{n: null}", "[null]", "fill()", "function fill {\nSET 3\n}"],
    ["conditional", "{n: 2}", "[2]", "if hostFlag {\nSET 1.5\n}", ""],
    ["helper-before", "{n: 2}", "[2]", "halve()", "function halve {\nSET 0.5\n}"],
    ["helper-after", "{n: 2}", "[2]", "", "function halve {\nSET 0.5\n}"],
    ["handler", "{n: 2}", "[2]", 'showPermanentButton "b" {\nSET 0.5\n}\nwait 1 s', ""],
    ["external", "{n: hostValue}", "[hostValue]", "", ""],
  ];
  // (declaration kind, read expression, store into the read path)
  const FORMS = [
    ["property", "rec", "state.n", (v) => `state.n = ${v}`],
    ["nested", "nest", "state.inner.n", (v) => `state.inner.n = ${v}`],
    ["first", "list", "xs.first", (v) => `xs.add(${v})`],
    ["last", "list", "xs.last", (v) => `xs.add(${v})`],
    ["index", "list", "xs[0]", (v) => `xs[0] = ${v}`],
    ["paren", "rec", "(state.n)", (v) => `state.n = ${v}`],
  ];
  const CONS = [
    ["repeat", (r) => [`repeat ${r} {`, 'say "tick"', "}"]],
    ["index", (r) => ["let ys = [1, 2, 3]", `let got = ys[${r}]`]],
    ["store", (r) => ["let ys = [1, 2, 3]", `ys[${r}] = 0`]],
    ["removeAt", (r) => ["let ys = [1, 2, 3]", `ys.removeAt(${r})`]],
  ];
  for (const [situation, record, list, setup, fns] of SIT)
    for (const [form, kind, read, store] of FORMS) {
      const decl =
        kind === "rec"
          ? `let state = ${record}`
          : kind === "nest"
            ? "let state = {inner: " + record + "}"
            : `let xs = ${list}`;
      const set = (text) =>
        text
          .replaceAll("SET 3", store("3"))
          .replaceAll("SET 1.5", store("1.5"))
          .replaceAll("SET 0.5", store("0.5"));
      for (const [consumer, cons] of CONS) {
        const pre = [decl, ...(fns ? [set(fns)] : []), ...(setup ? [set(setup)] : [])];
        const post = situation === "helper-after" ? ["halve()"] : [];
        add(`consumer/${consumer}/${form}/${situation}`, [...pre, ...cons(read), ...post, "exit"].join("\n"));
        add(
          `consumer-twin/${consumer}/${form}/${situation}`,
          [...pre, `let operand = ${read}`, ...cons("operand"), ...post, "exit"].join("\n"),
        );
      }
    }
  // the hand-checked core
  add("core/property-repeat", 'let state = {n: 1.5}\nrepeat state.n { say "Tick" }\nexit');
  add("core/property-repeat-whole", 'let state = {n: 2}\nrepeat state.n { say "Tick" }\nexit');
  add("core/property-index", "let state = {n: 1.5}\nlet xs = [1, 2]\nlet v = xs[state.n]\nexit");
  add("core/property-store-index", "let state = {n: 0.5}\nlet xs = [1, 2]\nxs[state.n] = 3\nexit");
  add("core/property-removeAt", "let state = {n: 1.5}\nlet xs = [1, 2]\nxs.removeAt(state.n)\nexit");
  add("core/element-repeat", 'let xs = [1.5]\nrepeat xs.first { say "Tick" }\nexit');
  add("core/element-index-repeat", 'let xs = [1.5]\nrepeat xs[0] { say "Tick" }\nexit');
  add("core/element-index-whole", 'let xs = [2]\nrepeat xs[0] { say "Tick" }\nexit');
  add("core/parenthesized", 'let state = {n: 1.5}\nrepeat (state.n) { say "Tick" }\nexit');
  add("core/nested", 'let state = {inner: {n: 1.5}}\nrepeat state.inner.n { say "Tick" }\nexit');
  add(
    "core/handler-property",
    'let state = {n: 2}\nshowPermanentButton "b" { state.n = 0.5 }\nwait 1 s\nrepeat state.n { say "Tick" }\nexit',
  );
  add("core/conditional-element", 'let xs = [2]\nif hostFlag { xs.add(0.5) }\nrepeat xs.last { say "Tick" }\nexit');
  add("core/read-before-widening", 'let state = {n: 2}\nrepeat state.n { say "Tick" }\nstate.n = 0.5\nexit');
  add("core/external-property", 'let state = {n: hostValue}\nrepeat state.n { say "Tick" }\nexit');
  add(
    "core/dispatched-property",
    'let state = {n: 2}\nfunction halve { state.n = state.n / 2 }\nfunction step(name: string) {\nif name == "halve" { halve() }\n}\nstep("halve")\nlet xs = [1, 2, 3]\nlet v = xs[state.n]\nexit',
  );
  return out;
})();

// spike 10's harness globals
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "python3 -I tools/make-consumers.py spike10/cases-consumers10.jsonl",
      "R/3a-newcore/checkpoint-9/spike10/README.md:425"
    ]
  ],
  "sources": 447,
  "sha256": "f05c3f96dcb1583a7248d8df4d6bf0b7833acebc0a9e4ed306cbf464cd1d6c74"
};
