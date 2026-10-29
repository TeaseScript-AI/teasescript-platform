// first/positive, first/none and related fixed cases; Astra review, round unrecorded
// (R/astra-m4-u4a-review/probes.mjs).
export const cases = (() => {
  const choice = 'let choice = askBoolean "change?"';
  const xs = `${choice}\nlet xs: integer?[] = [4, 7]\nif choice { xs = [null, 9] }`;
  const rows = `${choice}\nlet rows: integer?[][] = [[4], [7]]\nif choice { rows = [[null], [9]] }`;
  const cases = [];
  const add = (name, source, expected = null) =>
    cases.push({ name, source: source + "\nexit\n", expected });
  for (const sel of ["first", "last", "random"]) {
    const read = `xs.${sel}`,
      sink = `let sink: integer = ${read}`;
    add(`${sel}/positive`, `${xs}\nif xs is integer[] { ${sink} }`, "valid");
    add(`${sel}/none`, `${xs}\n${sink}`, "warning-runtime-check");
    add(
      `${sel}/root-only`,
      `${choice}\nlet xs: integer?[]? = [4]\nif choice { xs = [null] }\nif choice { xs = null }\nif xs != null { ${sink} }`,
      "warning-runtime-check",
    );
    for (const [id, effect] of Object.entries({
      reverse: "xs.reverse()",
      element: "xs[0] = null",
      replace: "xs = [null]",
      clear: "xs.clear()",
      add: "xs.add(null)",
    }))
      add(
        `${sel}/effect-${id}`,
        `${xs}\nif xs is integer[] { ${effect}\n${sink} }`,
        "warning-runtime-check",
      );
    add(`${sel}/new-good`, `${xs}\nif xs is integer[] { xs = [8]\n${sink} }`, "valid");
    add(
      `${sel}/call`,
      `${xs}\nfunction spoil { xs = [null] }\nif xs is integer[] { spoil()\n${sink} }`,
      "warning-runtime-check",
    );
    add(
      `${sel}/empty`,
      `${choice}\nlet xs: integer?[] = []\nif choice { xs = [null] }\nif xs is integer[] { ${sink} }`,
      "empty",
    );
    add(
      `${sel}/handler-yield`,
      `${xs}\ntimer(duration: 1 s, async: true) { xs = [null] }\nif xs is integer[] { wait 2 s\n${sink} }`,
      "warning-runtime-check",
    );
    add(
      `${sel}/handler-body`,
      `${xs}\nif xs is integer[] { timer(duration: 1 s, async: true) { ${sink} } }`,
      "warning-runtime-check",
    );
    add(
      `${sel}/first-test`,
      `${xs}\nif xs.first != null { ${sink} }`,
      sel === "first" ? "valid" : "warning-runtime-check",
    );
    add(`${sel}/random-test`, `${xs}\nif xs.random != null { ${sink} }`, "warning-runtime-check");
    add(
      `${sel}/last-test`,
      `${xs}\nif xs.last != null { ${sink} }`,
      sel === "last" ? "valid" : "warning-runtime-check",
    );
    add(
      `${sel}/nested`,
      `${rows}\nif rows is integer[][] { let sink: integer = rows[0].${sel} }`,
      "valid",
    );
    add(
      `${sel}/computed`,
      `${rows}\nlet row = 0\nif rows is integer[][] { let sink: integer = rows[row + 1].${sel} }`,
      "valid",
    );
    add(
      `${sel}/computed-invalidated`,
      `${rows}\nlet row = 0\nif rows is integer[][] { rows[row + 1] = [null]\nlet sink: integer = rows[row + 1].${sel} }`,
      "warning-runtime-check",
    );
    add(
      `${sel}/row-test`,
      `${rows}\nif rows[0] is integer[] { let sink: integer = rows[0].${sel} }`,
      "valid",
    );
    add(
      `${sel}/other-row`,
      `${rows}\nif rows[0] is integer[] { let sink: integer = rows[1].${sel} }`,
      "warning-runtime-check",
    );
    add(
      `${sel}/row-index-reassigned`,
      `${rows}\nlet row = 0\nif rows[row] is integer[] { row = 1\nlet sink: integer = rows[row].${sel} }`,
      "warning-runtime-check",
    );
    add(
      `${sel}/object-elements`,
      `${choice}\nlet xs: object?[] = [{ok: 1}]\nif choice { xs = [null] }\nif xs is object[] { let sink: object = ${read} }`,
      "valid",
    );
    add(
      `${sel}/property-not-proved`,
      `${choice}\nlet xs: object?[] = [{ok: 1}]\nif choice { xs = [null] }\nif xs is object[] { let selected: object = ${read}\nlet sink: integer = selected.missing }`,
      "not-valid",
    );
    add(
      `${sel}/shared-around-call`,
      `${xs}\nfunction spoil { xs = [null]\nreturn 0 }\nif xs is integer[] { let both: integer[] = [${read}, spoil(), ${read}] }`,
      "one-null",
    );
    add(
      `${sel}/different-tests`,
      `${choice}\nlet xs: (integer | string | null)[] = [1]\nif choice { xs = ["s"] }\nif choice { xs = [null] }\nif xs is integer[] { let a: integer[] = [${read}, ${read}] }\nif xs is string[] { let b: string[] = [${read}, ${read}] }`,
      "valid",
    );
    add(
      `${sel}/saved`,
      `${xs}\nif xs is integer[] { let saved = ${read}\nxs = [null]\nlet sink: integer = saved }`,
      "valid",
    );
    add(`${sel}/index-control`, `${xs}\nif xs is integer[] { let sink: integer = xs[0] }`, "valid");
    add(
      `${sel}/f11-own`,
      `function pick(v) { if v.${sel} != null { let sink: integer = v.${sel} } }\npick([1, null])\npick({${sel}: "bad"})`,
      "not-valid",
    );
  }
  add(
    "two-environments-literal",
    `${xs}\nfunction spoil { xs = [null]\nreturn 0 }\nif xs is integer[] { let out = [xs.first, spoil(), xs.first]\nlet sink: integer[] = out }`,
    "one-null",
  );
  add(
    "negative-collection",
    `${xs}\nif xs is not integer[] { let sink: integer = xs.first }`,
    "warning-runtime-check",
  );
  add(
    "else-collection",
    `${xs}\nif xs is integer[] { say "ok" } else { let sink: integer = xs.last }`,
    "warning-runtime-check",
  );
  add(
    "inner-selection-deferred",
    `${rows}\nif rows is integer[][] { let sink: integer = rows.first.last }`,
    "warning-runtime-check",
  );
  add(
    "below-selection-property",
    `${choice}\nlet xs = [{f: 1}]\nif choice { xs = [{f: null}] }\nif xs.first.f != null { let sink: integer = xs.first.f }`,
    "warning-runtime-check",
  );
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.source]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      '/home/peter/opt/node-24.18/bin/node "$root/evidence/probes.mjs" "$root"',
      "R/astra-m4-u4a-review/queue-final.sh:4",
    ],
    ["node ROOT/evidence/probes.mjs ROOT", "R/astra-m4-u4a-review/REPRODUCE.md:8"],
    ["python3 evidence/summarize.py", "R/astra-m4-u4a-review/REPRODUCE.md:21"],
  ],
  sources: 90,
  sha256: "3fd208be26cc967a2b2596855e34fb7c861238dc41a54b079704c7dba8d8e9d4",
};
