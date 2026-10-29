export const cases = (() => {
  const sourceCases = [];
  // Work families for the program-point spike: fan-out combined with context count and dependency width, both
  // reviewers' round-2 quadratic witnesses, and the earlier families. Usage: node families3.mjs 8,16,32,64,128
  const rows = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
  const wide = (k) => Array.from({ length: k }, (_, i) => `p${i}: ${i}`).join(", ");
  const total = (w, s) =>
    rows(w, (i) => `let score${i} = ${i}`) +
    `\nfunction total { return ${Array.from({ length: w }, (_, i) => `score${i}`).join(" + ")} }\n` +
    rows(s, (i) => `let result${i}: integer = total()`);
  const FAMILIES = {
    // Astra R2-4: width w, s sites, one entry state (no stores between the calls)
    "astra-wide-helper-many-calls": (k) => total(k, k),
    "astra-wide-helper-fixed-calls": (k) => total(k, 8),
    "astra-fixed-helper-many-calls": (k) => total(8, k),
    // the same with a store to one score between every two calls: every site has its own entry state (contexts × width)
    "contexts-x-width": (k) =>
      rows(k, (i) => `let score${i} = ${i}`) +
      `\nfunction total { return ${Array.from({ length: k }, (_, i) => `score${i}`).join(" + ")} }\n` +
      rows(k, (i) => `score${i % k} = score${i % k} + 1\nlet result${i}: integer = total()`),
    // Sol R2-B5: k presets stored into one state, a scalar read after each
    "sol-distinct-handles": (k) =>
      `let state = {n: 0}\n` +
      rows(
        k,
        (i) => `let preset${i} = {n: ${i}}\nstate = preset${i}\nlet read${i}: integer = state.n`,
      ),
    // an older source updated after a later capture: k presets, then the first preset changed, then reads of every copy
    "sol-older-source-updated": (k) =>
      `let state = {n: 0}\n` +
      rows(k, (i) => `let preset${i} = {n: ${i}}\nstate = preset${i}\nlet copy${i} = state`) +
      `\npreset0.n = 1.5\n` +
      rows(k, (i) => `let read${i}: integer = copy${i}.n`),
    // earlier families
    "copy-chain": (k) =>
      `let x0 = [1]\n` +
      rows(k, (i) => `let x${i + 1} = x${i}`) +
      `\n` +
      rows(k, (i) => `let r${i}: integer = x${i + 1}.first`),
    "nested-dating-sites": (k) =>
      `let a = [1]\nfunction inner { return a }\nfunction outer { return inner() }\n` +
      rows(k, (i) => `let b${i} = outer()\na.add(0.5)\nlet r${i} = b${i}.first`),
    "reverse-calls-with-reads": (k) =>
      `let source = []\n` +
      rows(k, (i) => `function f${i} { let held = source\n return held }`) +
      `\n` +
      rows(k, (i) => `let b${k - 1 - i} = f${k - 1 - i}()\nsource.add(1)`),
    "staggered-wide-refresh": (k) =>
      `let source = {${wide(k)}}\nlet held = source\n` +
      rows(k, (i) => `let next${i} = held.p0 + 1\nsource.p0 = next${i}\nheld = source`),
    "wide-refresh-reads": (k) =>
      `let source = {base: 0, ${wide(k)}}\nlet held = source\n` +
      rows(k, (i) => `source.p${i} = 0.5\nheld = source\nlet r${i} = held.base`),
    "handlers-stable-state": (k) =>
      `let state = {n: 1}\n` +
      rows(k, (i) => `showPermanentButton "b${i}" { state.n = ${i} }`) +
      `\n` +
      rows(k, (i) => `let r${i}: integer = state.n`),
    "handlers-reading-state": (k) =>
      `let state = {n: 1}\n` +
      rows(
        k,
        (i) => `showPermanentButton "b${i}" { let v${i}: integer = state.n\nstate.n = ${i} }`,
      ) +
      `\nwait 2 s`,
    "saved-views": (k) =>
      `let a = {n: 1}\nlet b = a\n` +
      rows(k, (i) => `let c${i} = b\nb = a\nlet r${i}: integer = c${i}.n`),
    "wide-copies-fields": (k) =>
      `let state = {${wide(k)}}\nlet other = {${wide(k)}}\n` +
      rows(k, (i) => `let s${i} = other\nstate = s${i}`) +
      `\n` +
      rows(k, (i) => `let x${i} = state.p${i}`),
    "loop-band-reads": (k) =>
      `let source = []\nfunction visit { let local = source\n local.add(1)\n return local }\nrepeat 3 {\n` +
      rows(k, (i) => ` let next${i} = visit()\n source.add(${i})`) +
      `\n}`,
    "nested-ifs-10": (k) =>
      `let x = 0\n` +
      rows(
        k,
        (i) =>
          `${"if hostFlag {\n".repeat(10)}x = x + ${i}\n${"}\n".repeat(10)}let r${i}: integer = x`,
      ),
  };
  const ks = ([][2] ?? "8,16,32,64").split(",").map(Number);
  for (const [name, gen] of Object.entries(FAMILIES))
    for (const k of ks) sourceCases.push({ name: `${name}/${k}`, source: gen(k), expect: "valid" });

  return sourceCases.map(({ name, source, files }) => [name, files ?? source]);
})();

export const checks = ["publication"];

export const globals = ["hostValue", "hostOther", "hostInit", "otherHost", "hostFlag"];
