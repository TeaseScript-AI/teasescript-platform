// the written domain at every level through copies and cycles (the lead's S9b shape 2): 11 written types, held in a
// field, a nested field, an element, behind an empty or null intermediate or a projection, reached through one copy, a
// chain, a fan-out, a cycle or a self store, with nothing, a fitting, wrong, null, host or host-list content stored at
// the copy's field, read or not; F1's `gen-domains.py` (/tmp/agent-work/o4-m4-f1/probe/; copy kept in
// desktop:~/work/evidence/1463/retained/), run in F1 review r3's corpus. The corpus's other lists are not copied: the
// repository's fixture, its exported families, its written-type cases and other runs' case files.
export const cases = (() => {
  const TYPES = [
    ["integer", "1"],
    ["integer?", "null"],
    ["null", "null"],
    ["number", "1.5"],
    ["list", "[1]"],
    ["integer[]", "[1]"],
    ["integer?[]", "[null]"],
    ["(integer | string)[]", '["s"]'],
    ["integer[][]", "[[1]]"],
    ["object", "{v: 1}"],
    ["string | integer", '"s"'],
  ];
  // how the written binding reaches the record whose field the copies carry
  const HOLDERS = [
    ["field", ["let root = {f: typed, g: 1}"]],
    ["nested", ["let root = {h: {f: typed}}"]],
    ["element", ["let root = {f: [typed]}"]],
    ["empty-intermediate", ["let mid = {}", "mid = {f: typed}", "let root = mid"]],
    ["null-intermediate", ["let mid = null", "mid = {f: typed}", "let root = mid"]],
    ["projection", ["let wrap = {r: {f: typed}}", "let root = wrap.r"]],
  ];
  const FIELD = { nested: "h.f" };
  const COPIES = [
    ["one", ["let a = root"]],
    ["chain", ["let a0 = root", "let a1 = a0", "let a = a1"]],
    ["fan-out", ["let a = root", "let b = root"]],
    ["cycle", ["let a = root", "let b = a", "a = b"]],
    ["self", ["root.q = root", "let a = root.q"]],
  ];
  const STORES = [
    ["nothing", null],
    ["fitting", "VALUE"],
    ["wrong", '"wrong"'],
    ["null", "null"],
    ["host", "hostValue"],
    ["list-host", "[hostValue]"],
  ];
  const cases = [];
  for (const [type, value] of TYPES)
    for (const [holder, made] of HOLDERS)
      for (const [copy, lines] of COPIES)
        for (const [store, stored] of STORES)
          for (const read of [true, false]) {
            const field = FIELD[holder] ?? "f";
            const body = [`let typed: ${type} = ${value}`, ...made, ...lines];
            if (stored !== null)
              body.push(
                `a.${field}${holder === "element" ? "[0]" : ""} = ${stored === "VALUE" ? value : stored}`,
              );
            // a read at the copy's field, as an author's would be, or none
            if (read) body.push(`let seen = a.${field}`);
            body.push("exit");
            cases.push([
              `${type} | ${holder} | ${copy} | ${store} | ${read ? "read" : "unread"}`,
              body.join("\n") + "\n",
            ]);
          }
  return cases;
})();

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node corpus.mjs $PWD/base $PWD/head 0/1 corpus.json shapes1.json shapes2.json shapes3.json shapes4.json shapes5.json domains.json rv-cases.json",
      "/tmp/agent-work/o4-m4-f1/review/r3/report.md:90",
    ],
  ],
  sources: 3840,
  sha256: "0702cbd7d7ac43b8fc27c5c797828509d2de915b752b9e3ad01c10835950f038",
};
