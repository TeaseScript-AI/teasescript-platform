// 3a model, builder (R/3a-newcore/checkpoint-8/acct/families.mjs): the collection and work families, as the final
// chain ran them (runs/chain-all.sh, chain-final4.sh): every family at k = 32 to 256 (the series, and the four extras
// the series' grep does not see), and the attribution's families also at 512.

// The growth families: checkpoint 2's (run.mjs) and those added since.
export const FAMILIES = {
  "independent-blocks": (k) =>
    Array.from(
      { length: k },
      (_, i) => `let x${i} = []\nx${i}.add(0)\nlet y${i} = [1]\ny${i} = y${i} + [2]`,
    ).join("\n"),
  "literal-appended": (k) =>
    `let xs = [1]\n` + Array.from({ length: k }, () => `xs = xs + [2]`).join("\n"),
  "get-default-appended": (k) =>
    `let xs = [[1]]\n` +
    Array.from({ length: k }, () => `xs = xs + [xs.get(0, default: [3])]`).join("\n"),
  "add-sites": (k) =>
    `let xs = []\n` + Array.from({ length: k }, (_, i) => `xs.add(${i})`).join("\n"),
  "copy-chain": (k) =>
    `let x0 = [1]\n` + Array.from({ length: k }, (_, i) => `let x${i + 1} = x${i}`).join("\n"),
  "fan-in": (k) => `let x = null\n` + Array.from({ length: k }, (_, i) => `x = ${i}`).join("\n"),
  "null-fan-in": (k) =>
    `let x = null\n` + Array.from({ length: k }, () => `x = null`).join("\n") + `\nx = 1`,
  "copy-cycle": (k) =>
    Array.from({ length: k }, (_, i) => `let a${i} = null`).join("\n") +
    "\n" +
    Array.from({ length: k }, (_, i) => `a${i} = a${(i + 1) % k}`).join("\n") +
    `\na0 = 1`,
  "json-feedback": (k) =>
    Array.from(
      { length: k },
      (_, i) =>
        `let d${i} = {next: fromJson("{}")}\nlet p${i} = fromJson("{}", default: d${i})\nd${i}.next = p${i}`,
    ).join("\n"),
  "json-mutual": (k) =>
    Array.from({ length: k }, (_, i) => `let d${i} = {next: fromJson("{}")}`).join("\n") +
    "\n" +
    Array.from(
      { length: k },
      (_, i) => `let p${i} = fromJson("{}", default: d${(i + 1) % k})\nd${i}.next = p${i}`,
    ).join("\n"),
  "objects-distinct-names": (k) =>
    `let rooms = [${Array.from({ length: k }, (_, i) => `{name: "r${i}", f${i}: ${i}}`).join(", ")}]\nlet n = rooms.first.name`,
  "objects-same-names": (k) =>
    `let rooms = [${Array.from({ length: k }, (_, i) => `{name: "r${i}", size: ${i}}`).join(", ")}]\nlet n = rooms.first.size`,
  "written-union-chain": (k) =>
    Array.from({ length: k }, (_, i) => `let l${i}: (integer | string)[] = [${i}]`).join("\n") +
    `\nlet all = ` +
    Array.from({ length: k }, (_, i) => `l${i}`).join(" + "),
  "independent-mistakes": (k) =>
    Array.from({ length: k }, (_, i) => `let x${i} = 1\nx${i} = "s"`).join("\n"),
  "dependent-mistakes": (k) =>
    `let x0 = 1\nx0 = "s"\n` +
    Array.from({ length: k }, (_, i) => `let x${i + 1} = x${i}\nx${i + 1} = "s"`).join("\n"),
  "cycle-mistakes": (k) =>
    Array.from({ length: k }, (_, i) => `let a${i} = 1`).join("\n") +
    "\n" +
    Array.from({ length: k }, (_, i) => `a${i} = a${(i + 1) % k}\na${i} = "bad"`).join("\n"),
  "deferred-functions": (k) =>
    Array.from(
      { length: k },
      (_, i) =>
        `function keep${i}(x) {\n  let saved = x\n  return saved\n}\nlet l${i} = keep${i}({value: 1})\nlet r${i} = keep${i}({value: "s"})`,
    ).join("\n"),
  "self-rebuild-chain": (k) =>
    `let s = ""\n` + Array.from({ length: k }, () => `s = s + "x"`).join("\n"),
  // width: one wide value read or written field by field
  "wide-object-reads": (k) =>
    `let box = {${Array.from({ length: k }, (_, i) => `p${i}: ${i}`).join(", ")}}\n` +
    Array.from({ length: k }, (_, i) => `let v${i} = box.p${i}`).join("\n"),
  "wide-object-updates": (k) =>
    `let box = {${Array.from({ length: k }, (_, i) => `p${i}: null`).join(", ")}}\n` +
    Array.from({ length: k }, (_, i) => `box.p${i} = ${i}`).join("\n"),
  "wide-object-updates-reads": (k) =>
    `let box = {${Array.from({ length: k }, (_, i) => `p${i}: null`).join(", ")}}\n` +
    Array.from({ length: k }, (_, i) => `box.p${i} = ${i}\nlet v${i} = box.p${i}`).join("\n"),
  "wide-nested-updates": (k) =>
    `let state = {rooms: {${Array.from({ length: k }, (_, i) => `r${i}: {locked: false}`).join(", ")}}}\n` +
    Array.from({ length: k }, (_, i) => `state.rooms.r${i}.locked = true`).join("\n"),
  "wide-list-reads": (k) =>
    `let xs = [${Array.from({ length: k }, (_, i) => `${i}`).join(", ")}]\n` +
    Array.from({ length: k }, (_, i) => `let v${i} = xs[${i}]`).join("\n"),
  "shapes-and-reads": (k) =>
    `let rows = [${Array.from({ length: k }, (_, i) => `{name: "r${i}", f${i}: ${i}}`).join(", ")}]\n` +
    Array.from({ length: k }, (_, i) => `let n${i} = rows.first.f${i}`).join("\n"),
  "wide-missing-stores": (k) =>
    `let box = {p0: 0}\n` + Array.from({ length: k }, (_, i) => `box.q${i} = ${i}`).join("\n"),
  "defaulted-calls": (k) =>
    `function count(n = 1) {\n  return n\n}\n` +
    Array.from({ length: k }, (_, i) => `let c${i} = count(${i % 2 === 0 ? i : "1.5"})`).join("\n"),
  "typed-literal-elements": (k) =>
    `let xs: (integer | string)[] = [${Array.from({ length: k }, (_, i) => (i % 2 === 0 ? `${i}` : `"s${i}"`)).join(", ")}]`,
  "nested-joins": (k) =>
    `let xs = [[0]]\n` +
    Array.from({ length: k }, (_, i) => `xs = xs + [[${i % 3 === 0 ? `"s"` : i}]]`).join("\n"),
  "json-open-defaults": (k) =>
    Array.from(
      { length: k },
      (_, i) =>
        `let j${i} = fromJson("[]", default: [])\nlet g${i} = [j${i}].get(0, default: [${i}])`,
    ).join("\n"),
  "cyclic-defaults": (k) =>
    `let a = 1\nlet b = 1\n` +
    Array.from({ length: k }, (_, i) => `b = [a].get(0, default: b)\nb = b / 2`).join("\n"),
};

// round 2's width and length families (Astra r2), possibilities and written defaults (checkpoint 3)
Object.assign(FAMILIES, {
  "optional-field-records": (k) =>
    `let rooms = [\n${Array.from({ length: k }, (_, i) => `  {name: "room${i}", option${i}: false}`).join(",\n")}\n]\nlet name = rooms.first.name`,
  "dict-of-records": (k) =>
    `let rooms = dict{ ${Array.from({ length: k }, (_, i) => `"r${i}": {name: "room${i}", option${i}: false}`).join(", ")} }\nlet name = rooms["r0"].name`,
  "nested-field-updates": (k) =>
    `let state = {inner: {${Array.from({ length: k }, (_, i) => `f${i}: null`).join(", ")}}}\n` +
    Array.from({ length: k }, (_, i) => `state.inner.f${i} = ${i}`).join("\n"),
  "forward-values": (k) =>
    Array.from({ length: k }, (_, i) => `let v${i} = ${i === 0 ? "1" : `v${i - 1} + 1`}`).join(
      "\n",
    ),
  "return-chains": (k) =>
    Array.from(
      { length: k },
      (_, i) => `function f${i}(x) {\n  return ${i === 0 ? "x" : `f${i - 1}(x)`}\n}`,
    ).join("\n") + `\nlet r = f${k - 1}(1)`,
  "repeated-field-stores": (k) =>
    `let box = {n: null}\n` + Array.from({ length: k }, (_, i) => `box.n = ${i}`).join("\n"),
  "possibility-stores": (k) =>
    `let xs = []\n` +
    Array.from({ length: k }, (_, i) =>
      i % 2 === 0 ? `xs.add(hostValue / ${i + 1})` : `xs.add(${i})`,
    ).join("\n"),
  "possibility-objects": (k) =>
    Array.from(
      { length: k },
      (_, i) => `let o${i} = {n: hostValue / 4, keep: ${i}}\no${i} = {n: 1.5, keep: ${i + 1}}`,
    ).join("\n"),
  "written-defaults": (k) =>
    `let ns = [1]\n` +
    Array.from(
      { length: k },
      (_, i) => `let x${i}: integer | string = ns.get(${i}, default: "s")`,
    ).join("\n"),
});

// checkpoint 4: Astra round 3's families (R3-B3 and its neighbours) and the phase-O families
const lines4 = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
const fields4 = (k) => Array.from({ length: k }, (_, i) => `p${i}: ${i}`).join(", ");
Object.assign(FAMILIES, {
  "late-concrete-adds": (k) =>
    "let xs = []\n" + lines4(k, (i) => `xs.add(hostValue / ${i + 1})`) + "\nxs.add(1)",
  "open-possibility-adds": (k) =>
    "let xs = []\n" + lines4(k, (i) => `xs.add(hostValue / ${i + 1})`),
  "obliged-object-stores": (k) =>
    "let box = {n: null, keep: 1}\n" +
    lines4(k, (i) => `box = {n: hostValue / ${i + 1}, keep: ${i}}`),
  "wide-possibility-fields": (k) =>
    `let box = {${Array.from({ length: k }, (_, i) => `p${i}: hostValue / 4`).join(", ")}}\n` +
    lines4(k, (i) => `box.p${i} = ${i}`),
  "mixed-default-call-sites": (k) =>
    "let n = 1\nn = hostValue\n" + lines4(k, (i) => `let x${i} = n otherwise 1.5`),
  "wide-defaulted-calls": (k) =>
    `let settings = {${fields4(k)}}\nfunction use(s = settings) { return s.p0 }\n` +
    lines4(k, (i) => `let x${i} = use(settings)`),
  "many-returns-possibility": (k) =>
    "function f {\n" +
    lines4(k, (i) => `if hostFlag { return [hostValue / ${i + 1}] }`) +
    "\nreturn [1]\n}\nlet x = f()",
  "ordinary-store-chain": (k) =>
    "let x0 = {n: 1}\n" + lines4(k, (i) => `let x${i + 1} = x${i}\nx${i + 1}.n = ${i}`),
  // phase O: k justified failures removed in one batch (two rounds)
  "failing-adds": (k) =>
    "let xs = []\n" + lines4(k, (i) => `xs.add(hostValue / ${i + 1})`) + '\nxs.add("a")',
  "failing-objects": (k) =>
    'let x = {a: "s", n: null}\n' +
    lines4(k, (i) => `x = {a: "t${i}", n: hostValue / ${i + 1}}`) +
    '\nx = {a: "u", n: "z"}',
  // phase O: one withdrawal per round (constructed: k mutually dependent typing errors in one place)
  "dependent-chain": (k) =>
    lines4(
      k + 1,
      (i) => (i === 0 ? "let x = " : "x = ") + `{a${i}: hostValue / ${i + 1}, b${i}: 1}`,
    ) +
    '\nx = {a0: "s"}\n' +
    lines4(k, (i) => `x = {b${i}: "t", a${i + 1}: "s"}`),
  // phase O: k independent paradoxes (each a tie-break and a warning)
  "independent-paradoxes": (k) =>
    lines4(
      k,
      (i) =>
        `let x${i} = {n: hostValue / 4, q: 1}\nx${i} = {n: null, q: "s"}\nx${i} = {n: [1], q: 2}`,
    ),
});
// checkpoint 4: one wide value stored k times into one place, and k forward errors followed by k valid stores
Object.assign(FAMILIES, {
  "wide-repeated-stores": (k) =>
    `let settings = {${fields4(k)}}\nlet x = settings\n` + lines4(k, () => `x = settings`),
  "errors-then-valid": (k) =>
    lines4(k, (i) => (i === 0 ? "let x = " : "x = ") + `{n: hostValue / ${i + 1}, q: ${i}}`) +
    '\nx = {n: "z", q: 0}\n' +
    lines4(k, (i) => `x = {n: "y${i}", q: ${i}}`),
});
// Astra round 4's own families (its report's appendix), and checkpoint 5's: a wide value stored k times into a place
// whose first value is a possibility (round 4's B1 shape, a warning and the shared verdict memo), k warned stores whose
// unknown operands come through a chain of copies of a load, and k warnings through k places
Object.assign(FAMILIES, {
  "r4-wide-dict": (k) =>
    `let settings = dict{${Array.from({ length: k }, (_, i) => `"k${i}": [${i}, hostValue]`).join(",")}}\n` +
    lines4(k, (i) => `let item${i} = settings.get("k${i}", default: [3])`),
  "r4-record-copy-chain": (k) =>
    'let item0 = {score: 1, label: "ok"}\n' +
    lines4(k, (i) => `let item${i + 1} = item${i}\nitem${i + 1}.score = ${i}`),
  "r4-forward-copy-errors": (k) =>
    'let item0 = "ok"\n' +
    lines4(k, (i) => `let item${i + 1} = hostValue / 7\nitem${i + 1} = item${i}`),
  "r4-forward-result-errors": (k) =>
    'function source { return "ok" }\n' +
    lines4(
      k,
      (i) =>
        `function item${i} {\nif hostFlag { return hostValue / 7 }\nreturn ${i === 0 ? "source" : `item${i - 1}`}()\n}\n`,
    ) +
    `let answer = item${k - 1}()`,
  "r4-forward-property-errors": (k) =>
    'let state = {value0: "ok", ' +
    Array.from({ length: k }, (_, i) => `value${i + 1}: null`).join(",") +
    "}\n" +
    lines4(k, (i) => `state.value${i + 1} = hostValue / 7\nstate.value${i + 1} = state.value${i}`),
  "r4-repeat-mixed-parameter": (k) =>
    `let settings = {${Array.from({ length: k }, (_, i) => `p${i}: [${i}, hostValue]`).join(",")}}\nfunction use(s = settings) { return s.p0 }\n` +
    lines4(k, (i) => `let result${i} = use(settings)`),
  "r4-record-mixed-failures": (k) =>
    'let record = {score: null, note: "ok"}\n' +
    lines4(k, (i) => `record = {score: hostValue / 7, note: "step${i}"}`) +
    '\nrecord = {score: "done", note: "ok"}',
  "r4-independent-error-readers": (k) =>
    lines4(
      k,
      (i) =>
        `let state${i} = {score: hostValue / 7, note: 1}\nstate${i} = {score: [3]}\nlet reader${i} = state${i}.score`,
    ),
  "r4-wide-forward-errors": (k) =>
    `let state = {${Array.from({ length: k }, (_, i) => `p${i}: null`).join(",")}}\n` +
    lines4(k, (i) => `state.p${i} = hostValue / 7`) +
    "\n" +
    lines4(k, (i) => `state.p${i} = "done"`),
  "repeated-stores-warning": (k) =>
    `let seed = {${fields4(k)}}\nlet result = hostValue / 7\n` + lines4(k, () => "result = seed"),
  "warned-load-copies": (k) =>
    'let x0 = load("score", default: hostValue)\n' +
    lines4(k, (i) => `let x${i + 1} = x${i}`) +
    "\nlet ys = []\n" +
    lines4(k, (i) => `ys.add(x${i + 1} / 4)`) +
    '\nys.add("a")',
  "warnings-per-place": (k) =>
    lines4(k, (i) => `let ys${i} = []\nys${i}.add(hostValue / 4)\nys${i}.add("a")`),
});
// checkpoint 5: a place whose k candidates each wait on a different place decided later (functions defined below)
Object.assign(FAMILIES, {
  "late-function-adds": (k) =>
    "let ys = []\n" +
    lines4(k, (i) => `ys.add(f${i}() + 1)`) +
    "\n" +
    lines4(k, (i) => `function f${i} {\nreturn ${i}\n}`),
  "reverse-chain-adds": (k) =>
    "let ys = []\n" +
    lines4(k, (i) => `ys.add(f${i + 1}() + 1)`) +
    "\n" +
    lines4(k, (j) => {
      const i = k - j;
      return `function f${i} {\nreturn f${i - 1}()\n}`;
    }) +
    "\nfunction f0 {\nreturn 0\n}",
  "reverse-chain-fields": (k) =>
    `let box = {${Array.from({ length: k }, (_, i) => `p${i}: 0`).join(", ")}}\n` +
    lines4(k, (i) => `box.p${i} = f${i + 1}()`) +
    "\n" +
    lines4(k, (j) => {
      const i = k - j;
      return `function f${i} {\nreturn f${i - 1}()\n}`;
    }) +
    "\nfunction f0 {\nreturn 0\n}",
  "late-function-stores": (k) =>
    "let box = {n: 0}\n" +
    lines4(k, (i) => `box.n = f${i}()`) +
    "\n" +
    lines4(k, (i) => `function f${i} {\nreturn ${i}\n}`),
});
// Astra round 5's nine families (evidence/astra-3a-newcore-design-review-r5.md, appendix C), as written there
const line5 = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
const defs5 = (k, reverse, root = "0") =>
  line5(k, (j) => {
    const i = reverse ? k - j : j + 1;
    return `function f${i} {\n return f${i - 1}()\n}`;
  }) + `\nfunction f0 {\n return ${root}\n}`;
Object.assign(FAMILIES, {
  "r5-width": (k) =>
    `let data = dict{${Array.from({ length: k }, (_, i) => `k${i}: ${i}`).join(",")}}\n` +
    line5(k, (i) => `let x${i} = data.get("k${i}", default: 0)`),
  "r5-length": (k) =>
    "let x0 = {n: 0}\n" + line5(k, (i) => `let x${i + 1} = x${i}\nx${i + 1}.n = ${i}`),
  "r5-wait-forward": (k) =>
    "let xs = []\n" + line5(k, (i) => `xs.add(f${i + 1}())`) + `\n${defs5(k, false)}`,
  "r5-wait-reverse": (k) =>
    "let xs = []\n" + line5(k, (i) => `xs.add(f${i + 1}())`) + `\n${defs5(k, true)}`,
  "r5-wait-object-readers": (k) =>
    "let box = {n: 0}\n" +
    line5(k, (i) => `box = f${i + 1}()`) +
    "\n" +
    line5(k, (i) => `let r${i} = box.n`) +
    `\n${defs5(k, true, "{n: 0}")}`,
  "r5-wait-null-readers": (k) =>
    "let x = null\n" +
    line5(k, (i) => `x = f${i + 1}()`) +
    "\n" +
    line5(k, (i) => `let r${i} = x otherwise 0`) +
    `\n${defs5(k, true, "null")}`,
  "r5-repeated-wide-reader": (k) =>
    `let seed = {${Array.from({ length: k }, (_, i) => `p${i}: ${i}`).join(",")}}\nlet dest = hostValue / 7\n` +
    line5(k, () => "dest = seed") +
    "\nlet value = dest.p0",
  "r5-warning-copy-chain": (k) =>
    'let raw0 = load("score", default: hostValue)\n' +
    line5(k, (i) => `let raw${i + 1} = raw${i}`) +
    "\nlet ys = []\n" +
    line5(k, (i) => `ys.add(raw${i + 1} / 4)`) +
    '\nys.add("s")',
  "r5-warning-operation-chain": (k) =>
    'let raw0 = load("score", default: hostValue)\n' +
    line5(k, (i) => `let raw${i + 1} = raw${i} / 4`) +
    "\nlet ys = []\n" +
    line5(k, () => `ys.add(raw${k})`) +
    '\nys.add("s")',
});
// checkpoint 6: record replacements that read their own fields (R5-B1's ordinary shape), the fold and the collected
// plan over k arguments (L-1), readers waiting at k distinct positions of one place decided k times (R5-B2's other
// shape), and k independent genuine cycles (the provisional check)
Object.assign(FAMILIES, {
  "c6-record-replace": (k) =>
    'let state = {n: 0, d: 4, label: "s"}\n' +
    line5(k, (i) => `state = {n: state.n / state.d, d: ${i + 1}, label: "s${i}"}`),
  "c6-record-replace-errors": (k) =>
    'let state = {n: "s", d: 4, keep: null}\n' +
    line5(k, (i) => `state = {n: hostValue / state.d, d: ${i + 1}, keep: ${i}}`),
  "c6-fold-arguments": (k) =>
    line5(k, (i) => `let a${i}: integer | number = ${i}`) +
    `\nlet r = min(${Array.from({ length: k }, (_, i) => `a${i}`).join(", ")})\nr = "s"`,
  "c6-fold-items": (k) =>
    "let a = 1\na = 2.5\n" + `let r = min(${Array.from({ length: k }, () => "a").join(", ")})`,
  "c6-distinct-waits": (k) =>
    "let box = {q: 0}\n" +
    line5(k, (i) => `box = {p${i}: f${i + 1}()}`) +
    "\n" +
    line5(k, (i) => `let r${i} = box.p${i}`) +
    `\n${defs5(k, true)}`,
  // a chain of k function results that each copy a k-name object (a known representation cost, REPORT §4: each result
  // place owns its parts, so width × depth)
  "c6-wide-result-chain": (k) =>
    "let box = {q: 0}\n" +
    line5(k, (i) => `box = f${i + 1}()`) +
    "\n" +
    line5(k, (i) => `let r${i} = box.p${i}`) +
    `\n${defs5(k, true, `{${Array.from({ length: k }, (_, i) => `p${i}: ${i}`).join(", ")}}`)}`,
  "c6-recovered-cycles": (k) =>
    line5(
      k,
      (i) =>
        `let a${i} = {v: 1, w: null}\nlet b${i} = {v: null}\na${i} = {v: b${i}.v, w: "s"}\nb${i} = {v: a${i}.w}`,
    ),
});

// checkpoint 6.1: Astra round 6's families (evidence/astra-3a-newcore-design-review-r6.md, appendix B), as written
// there: R6-B6 is `r6-warning-distinct-fields`, R6-B7 `r6-duplicate-pools`, R6-B8 the `r6-choice-*` families (with site
// attribution at k >= 128); the four `r6-wide-*` families are R6-B5, the pending owner decision (they still fail)
const lines6 = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
const fields6 = (k, v = (i) => i) =>
  Array.from({ length: k }, (_, i) => `p${i}: ${v(i)}`).join(", ");
const list6 = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join(", ");
Object.assign(FAMILIES, {
  "r6-readers-object": (k) =>
    "let box = {v: null}\n" +
    lines6(
      k,
      (i) =>
        `function f${i} { return ${i + 1 === k ? "1" : `f${i + 1}()`} }\nbox = {v: f${i}()}\nlet x${i} = box.v`,
    ),
  "r6-readers-null": (k) =>
    "let box = null\n" +
    lines6(
      k,
      (i) =>
        `function f${i} { return ${i + 1 === k ? "null" : `f${i + 1}()`} }\nbox = f${i}()\nlet x${i} = box`,
    ),
  "r6-readers-distinct": (k) =>
    `let box = {${fields6(k, () => null)}}\n` +
    lines6(
      k,
      (i) =>
        `function f${i} { return ${i + 1 === k ? "1" : `f${i + 1}()`} }\nbox.p${i} = f${i}()\nlet x${i} = box.p${i}`,
    ),
  "r6-readers-nested": (k) =>
    `let box = {v: {${fields6(k, () => null)}}}\n` +
    lines6(
      k,
      (i) =>
        `function f${i} { return ${i + 1 === k ? "1" : `f${i + 1}()`} }\nbox.v.p${i} = f${i}()\nlet x${i} = box.v.p${i}`,
    ),
  "r6-resolve-forward": (k) =>
    "let x = null\n" +
    lines6(k, (i) => `function f${i} { return ${i === 0 ? "1" : `f${i - 1}()`} }\nx = f${i}()`),
  "r6-resolve-backward": (k) =>
    "let x = null\n" +
    lines6(k, (i) => `function f${i} { return ${i + 1 === k ? "1" : `f${i + 1}()`} }\nx = f${i}()`),
  "r6-resolve-forward-behind": (k) =>
    "let x = null\n" +
    lines6(k, (i) => `function f${i} { return ${i === 0 ? "1" : `f${i - 1}()`} }\nx = f${i}()`) +
    "\n" +
    lines6(k, (i) => `x = ${i}`),
  "r6-resolve-backward-behind": (k) =>
    "let x = null\n" +
    lines6(
      k,
      (i) => `function f${i} { return ${i + 1 === k ? "1" : `f${i + 1}()`} }\nx = f${i}()`,
    ) +
    "\n" +
    lines6(k, (i) => `x = ${i}`),
  "r6-warning-operations": (k) =>
    "let v0 = hostValue\n" +
    lines6(k, (i) => `let v${i + 1} = v${i} / 4`) +
    "\nlet xs = []\n" +
    lines6(k, (i) => `xs.add(v${k})`) +
    '\nxs.add("s")',
  "r6-warning-copies": (k) =>
    "let v0 = hostValue / 4\n" +
    lines6(k, (i) => `let v${i + 1} = v${i}`) +
    "\nlet xs = []\n" +
    lines6(k, (i) => `xs.add(v${k})`) +
    '\nxs.add("s")',
  "r6-warning-calls": (k) =>
    lines6(k, (i) => `function f${i} { return ${i === 0 ? "hostValue / 4" : `f${i - 1}()`} }`) +
    "\nlet xs = []\n" +
    lines6(k, (i) => `xs.add(f${k - 1}())`) +
    '\nxs.add("s")',
  "r6-warning-literal-parts": (k) =>
    "let v0 = {p: hostValue / 4}\n" +
    lines6(k, (i) => `let v${i + 1} = {p: v${i}.p}`) +
    "\nlet xs = []\n" +
    lines6(k, (i) => `xs.add(v${k}.p)`) +
    '\nxs.add("s")',
  "r6-warning-distinct-fields": (k) =>
    `let raw = {${fields6(k, () => null)}}\n` +
    lines6(k, (i) => `raw.p${i} = hostValue`) +
    "\nlet xs = []\n" +
    lines6(k, (i) => `xs.add(raw.p${i} / 4)`) +
    '\nxs.add("s")',
  "r6-min-numeric-unions": (k) =>
    lines6(k, (i) => `let u${i}: integer | number = 1`) +
    "\nlet r = min(" +
    list6(k, (i) => `u${i}`) +
    ")",
  "r6-max-mixed-unions": (k) =>
    lines6(k, (i) => `let u${i}: integer | string = 1`) +
    "\nlet r = max(" +
    list6(k, (i) => `u${i}`) +
    ")",
  "r6-min-dynamic": (k) => "let r = min(" + list6(k, () => `hostValue`) + ")",
  "r6-choice-scalar": (k) => "let r = askChoice " + list6(k, (i) => `"Choice ${i}"`),
  "r6-choice-union": (k) =>
    lines6(k, (i) => `let u${i}: integer | string = 1`) +
    "\nlet r = askChoice " +
    list6(k, (i) => `u${i}`),
  "r6-choice-record": (k) =>
    "let r = askChoice " + list6(k, (i) => `{text: "Choice ${i}", value: ${i}}`),
  "r6-replacements-known": (k) =>
    "let state = {score: 1, divisor: 4}\n" +
    lines6(k, (i) => `state = {score: state.score / state.divisor, divisor: 4}`),
  "r6-replacements-own": (k) =>
    lines6(
      k,
      (i) =>
        `let state${i} = {score: "s", divisor: null}\nstate${i} = {score: hostValue / state${i}.divisor, divisor: 4}`,
    ),
  "r6-inplace-previous": (k) =>
    `let state = {${fields6(k + 1, (i) => (i === 0 ? "1" : "null"))}}\n` +
    lines6(k, (i) => `state.p${i + 1} = state.p${i} / 4`),
  "r6-genuine-cycles": (k) =>
    lines6(k, (i) => `let a${i} = null\nlet b${i} = null\na${i} = b${i}\nb${i} = a${i}`),
  "r6-wide-stores": (k) =>
    `let settings = {${fields6(k)}}\nlet x = settings\n` + lines6(k, () => `x = settings`),
  "r6-wide-copies": (k) => `let v0 = {${fields6(k)}}\n` + lines6(k, (i) => `let v${i + 1} = v${i}`),
  "r6-wide-result-chain": (k) =>
    `let settings = {${fields6(k)}}\n` +
    lines6(k, (i) => `function f${i} { return ${i === 0 ? "settings" : `f${i - 1}()`} }`) +
    `\nlet r = f${k - 1}().p0`,
  "r6-wide-result-fanout": (k) =>
    `let settings = {${fields6(k)}}\n` +
    lines6(k, (i) => `function f${i} { return settings }\nlet r${i} = f${i}().p0`),
  "r6-wide-copy-override": (k) =>
    `let settings = {${fields6(k)}}\n` +
    lines6(k, (i) => `let x${i} = settings\nx${i}.p0 = ${i}\nlet r${i} = x${i}.p0`),
  "r6-duplicate-pools": (k) =>
    "let box = {n: null}\n" +
    lines6(
      k,
      (i) => `let s${i} = {n: null, p${i}: ${i}}\nlet t${i} = s${i}\nbox = s${i}\nbox = t${i}`,
    ) +
    "\nlet r = box.n",
});
// checkpoint 6.1: the neighbours of the work repairs (the family sweep): the warned fields' place reset k times to one
// blank template, replaced k times by small values without the warned fields, and read through a copy (R6-B6); a
// collected call with k list options (R6-B8)
Object.assign(FAMILIES, {
  "c61-provenance-blank-resets": (k) =>
    `let blank = {${fields6(k, () => "null")}}\nlet raw = blank\n` +
    lines6(k, () => "raw = blank") +
    "\n" +
    lines6(k, (i) => `raw.p${i} = hostValue`) +
    "\nlet xs = []\n" +
    lines6(k, (i) => `xs.add(raw.p${i} / 4)`) +
    '\nxs.add("s")',
  "c61-provenance-small-roots": (k) =>
    `let raw = {${fields6(k, () => "null")}}\n` +
    lines6(k, () => "raw = {p0: null}") +
    "\n" +
    lines6(k, (i) => `raw.p${i} = hostValue`) +
    "\nlet xs = []\n" +
    lines6(k, (i) => `xs.add(raw.p${i} / 4)`) +
    '\nxs.add("s")',
  "c61-provenance-copied-place": (k) =>
    `let raw = {${fields6(k, () => "null")}}\n` +
    lines6(k, (i) => `raw.p${i} = hostValue`) +
    "\nlet view = raw\nlet xs = []\n" +
    lines6(k, (i) => `xs.add(view.p${i} / 4)`) +
    '\nxs.add("s")',
  "c61-choice-lists": (k) =>
    "let r = askChoice " + Array.from({ length: k }, (_, i) => `[${i}, ${i + 1}]`).join(", "),
});
// checkpoint 6.1's findings, outside the default series (single-quoted names, which series.sh's default list does not
// read; run them with FAMILIES=...): k copies of one wide value stored and read at k fields (an R6-B5 sibling, width x
// count, pending), and ordinary save/restore k times (each restore a genuine cycle through the deadlock break; the
// recovery mechanism, pending with R6-B1)
Object.assign(FAMILIES, {
  "c61-duplicate-pools-fields": (k) =>
    `let src = {${fields6(k, () => "null")}}\nlet box = {${fields6(k, () => "null")}}\nlet s = src\n` +
    lines6(k, (i) => `let t${i} = s\nbox = t${i}`) +
    "\n" +
    lines6(k, (i) => `let r${i} = box.p${i}`),
  "c61-restore-1field": (k) =>
    "let state = {score: 0}\nlet saved = state\n" + lines6(k, () => "state = saved"),
  "c61-restore-3fields": (k) =>
    'let state = {a: 0, b: "s", c: null}\nlet saved = state\n' +
    lines6(k, (i) => `state.a = ${i}\nstate = saved`),
});
// checkpoint 7's growth families: save and restore through pure copies (the owner's evidence), impure and transported
// cycles (one bounded break each), wide records copied, returned and overridden (R6-B5)
const line7 = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
const wide7 = (k) => `{${Array.from({ length: k }, (_, i) => `p${i}: ${i}`).join(", ")}}`;
Object.assign(FAMILIES, {
  "c7-save-restore": (k) =>
    "let state = {score: 0}\nlet saved = state\n" + line7(k, () => "state = saved"),
  "c7-save-restore-fields": (k) =>
    "let state = {score: 0, a: 0, b: 0}\nlet saved = state\n" +
    line7(k, (i) => `state.a = ${i}\nstate = saved`),
  "c7-save-restore-impure": (k) =>
    "let state = {score: 0}\nlet other = {score: 1}\nlet saved = state\nsaved = other\n" +
    line7(k, () => "state = saved"),
  "c7-transported-circles": (k) =>
    "let state = {n: 1, divisor: null}\n" +
    line7(
      k,
      (i) =>
        `function make${i} {\n return {n: 8 / state.divisor, divisor: ${i + 1}}\n}\nstate = make${i}()`,
    ),
  "c7-transported-warnings": (k) =>
    'let state = {n: "s", divisor: null}\n' +
    line7(
      k,
      (i) =>
        `function make${i} {\n return {n: hostValue / state.divisor, divisor: ${i + 1}}\n}\nstate = make${i}()`,
    ),
  "c7-wide-copies": (k) => `let settings = ${wide7(k)}\n` + line7(k, (i) => `let c${i} = settings`),
  "c7-wide-results": (k) =>
    `let settings = ${wide7(k)}\n` +
    line7(k, (i) => `function f${i} { return settings }\nlet r${i} = f${i}().p0`),
  "c7-wide-overrides": (k) =>
    `let settings = ${wide7(k)}\n` + line7(k, (i) => `let c${i} = settings\nc${i}.p0 = ${i}`),
  // checkpoint 6.1's restore families (linear since checkpoint 7: pure copies make the restores trivial) and its
  // kind-level R6-B5 sibling (k copies of one k-field value, k field reads)
  "c61-restore-1field": (k) =>
    "let state = {score: 0}\nlet saved = state\n" + lines6(k, () => "state = saved"),
  "c61-restore-3fields": (k) =>
    'let state = {a: 0, b: "s", c: null}\nlet saved = state\n' +
    lines6(k, (i) => `state.a = ${i}\nstate = saved`),
  "c61-duplicate-pools-fields": (k) =>
    `let src = {${fields6(k, () => "null")}}\nlet box = {${fields6(k, () => "null")}}\nlet s = src\n` +
    lines6(k, (i) => `let t${i} = s\nbox = t${i}`) +
    "\n" +
    lines6(k, (i) => `let r${i} = box.p${i}`),
  // checkpoint 7's cycle shapes: k adds on one side of a mutual copy (`a = b; b = a`), the last add on the other side
  // conflicting (one rule-5 fact); k places in a cycle of literal reads, the first decided by text, the second storing
  // an integer (one rule-5 fact)
  "c7-copy-cycle-adds": (k) =>
    "let a = []\nlet b = []\na = b\nb = a\n" + line7(k, () => 'a.add("s")') + "\nb.add(1)",
  "c7-literal-cycle-chain": (k) =>
    line7(k, (i) => `let p${i} = {v: null}`) +
    "\n" +
    line7(k, (i) => `p${i} = {v: p${(i + 1) % k}.v}`) +
    '\np0 = {v: "s"}\np1 = {v: 1}',
});
// checkpoint 8's growth families: the shapes of the bounded-read repair (readers of a place in both orders, readers
// after every write, record replacements each followed by a reader), the families of the four work mutants that no
// family exercised since copies are independent (a slow chain of results: each result an operation on the next, so the
// results decide one at a time; k restores through a function-made copy beside k functions returning the place), and
// a plain function restore
const line8 = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
const nulls8 = (k) => Array.from({ length: k }, (_, i) => `p${i}: null`).join(", ");
Object.assign(FAMILIES, {
  "c8-readers-after-writes": (k) =>
    "let box = {v: null}\n" +
    line8(k, (i) => `box = {v: ${i}}`) +
    "\n" +
    line8(k, (i) => `let x${i} = box.v`),
  "c8-replace-readers": (k) =>
    'let state = {n: 0, d: 4, label: "s"}\n' +
    line8(
      k,
      (i) => `state = {n: state.n / state.d, d: ${i + 1}, label: "s${i}"}\nlet x${i} = state.n`,
    ),
  "c8-slow-chain-fields": (k) =>
    `let box = {${nulls8(k)}}\n` +
    line8(
      k,
      (i) =>
        `function f${i} { return ${i + 1 === k ? "1" : `f${i + 1}() + 1`} }\nbox.p${i} = f${i}()`,
    ),
  "c8-op-readers-slow": (k) =>
    `let box = {${nulls8(k)}}\n` +
    line8(
      k,
      (i) =>
        `function f${i} { return ${i + 1 === k ? "1" : `f${i + 1}() + 1`} }\nbox.p${i} = f${i}()\nlet x${i} = box.p${i} + 1`,
    ),
  "c8-restore-function": (k) =>
    "let state = {score: 0}\nfunction snapshot {\n return state\n}\nlet saved = snapshot()\n" +
    line8(k, () => "state = saved"),
  "c8-restore-function-views": (k) =>
    "let state = {score: 0}\nfunction snapshot {\n return state\n}\nlet saved = snapshot()\n" +
    line8(k, (i) => `function view${i} {\n return state\n}\nstate = saved\nlet r${i} = view${i}()`),
  // Sol's round-7 family (R7-B3): k distinct impure copies, each restored, with a reader after each restore
  "c8-impure-restores-distinct": (k) =>
    "let state = {n: 1}\nlet other = {n: 2}\n" +
    line8(
      k,
      (i) => `let saved${i} = state\nsaved${i} = other\nstate = saved${i}\nlet x${i} = state.n`,
    ),
});
// outside the default series (single-quoted, run with FAMILIES=...): a chain of k transported circles through functions
// a button handler calls (the handler runs at any time, so its reads are unbounded and the circles remain: 2k breaks,
// one sink component per break; the break's graph is built from every blocked place each time, k² scans; the
// evaluations are linear since checkpoint 8's remembered break reads; REPORT §4). The same chain in the main flow
// (`c8-circle-chain`) has no circle under the read-view contract: every function reads its place at the call.
Object.assign(FAMILIES, {
  "c8-circle-chain": (k) =>
    line8(k, (i) => `let s${i} = {n: 1, d: null}`) +
    "\n" +
    line8(
      k,
      (i) =>
        `function make${i} {\n return {n: 8 / s${i}.d, d: ${i === 0 ? "1" : `s${i - 1}.d`}}\n}\ns${i} = make${i}()`,
    ),
  "c8-handler-circle-chain": (k) =>
    line8(k, (i) => `let s${i} = {n: 1, d: null}`) +
    "\n" +
    line8(
      k,
      (i) =>
        `function make${i} {\n return {n: 8 / s${i}.d, d: ${i === 0 ? "1" : `s${i - 1}.d`}}\n}\nshowPermanentButton "b${i}" {\n s${i} = make${i}()\n}`,
    ),
});

export const shapes = FAMILIES;
export const sizes = [32, 64, 128, 256];
// chain-all.sh:16's $ATTR, as runs/attrib-final-p0/units.txt lists it at 512
const attributed = [
  "c7-save-restore",
  "c7-save-restore-fields",
  "c7-save-restore-impure",
  "c7-transported-circles",
  "c7-transported-warnings",
  "c7-wide-copies",
  "c7-wide-results",
  "c7-wide-overrides",
  "c7-copy-cycle-adds",
  "c6-wide-result-chain",
  "r6-wide-copies",
  "r6-wide-copy-override",
  "r6-wide-result-chain",
  "r6-wide-result-fanout",
  "r6-wide-stores",
  "c61-restore-1field",
  "c61-restore-3fields",
  "r6-readers-object",
  "r6-readers-null",
  "c6-record-replace",
  "cyclic-defaults",
  "r6-replacements-known",
  "wide-object-updates",
  "c8-readers-after-writes",
  "c8-replace-readers",
  "c8-slow-chain-fields",
  "c8-op-readers-slow",
  "c8-restore-function",
  "c8-restore-function-views",
  "c6-distinct-waits",
  "r6-duplicate-pools",
  "shapes-and-reads",
  "return-chains",
  "r6-resolve-forward",
  "c8-impure-restores-distinct",
];
export const cases = attributed.map((name) => [`${name}@512`, FAMILIES[name](512)]);
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "KS=32,64,128,256 bash scripts/vps-shards.sh series 6 (both parts), and acct/series.sh at the same k",
      "R/3a-newcore/checkpoint-8/runs/chain-all.sh:15, chain-final4.sh:12-13",
    ],
    [
      'KS=64,128,256,512 FAMILIES="$ATTR" bash scripts/vps-shards.sh attrib 6 (both parts)',
      "R/3a-newcore/checkpoint-8/runs/chain-all.sh:17",
    ],
    [
      'FAMILIES="<the four extras>" KS=32,64,128,256 ATTRIB=1 bash scripts/vps-shards.sh attrib',
      "R/3a-newcore/checkpoint-8/runs/chain-all.sh:18",
    ],
  ],
  sources: 581,
  sha256: "c49009d8e357ded6dda2592810d3860f7f7a420e2ddb64fcc319269c5ca107cc",
};
