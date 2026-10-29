// 3a model builder; shared generation code from one original module.
export const sizes = [8, 16];
const outputs = (() => {
  const rows = (k, f) => Array.from({ length: k }, (_, i) => f(i)).join("\n");
  const wide = (k) => Array.from({ length: k }, (_, i) => `p${i}: ${i}`).join(", ");
  const total = (w, s) =>
    rows(w, (i) => `let score${i} = ${i}`) +
    `\nfunction total { return ${Array.from({ length: w }, (_, i) => `score${i}`).join(" + ")} }\n` +
    rows(s, (i) => `let result${i}: integer = total()`);
  const AXES = {
    "handlers-readers": (h, r) =>
      `let state = {n: 1}\n` +
      rows(h, (i) => `showPermanentButton "b${i}" { state.n = ${i} }`) +
      `\nwait 1 s\n` +
      rows(r, (i) => `let read${i}: integer = state.n`),
    "calls-width": (w, s) =>
      rows(w, (i) => `let score${i} = ${i}`) +
      `\nfunction total { return ${Array.from({ length: w }, (_, i) => `score${i}`).join(" + ")} }\n` +
      rows(s, (i) => `score${i % w} = score${i % w} + 1\nlet result${i}: integer = total()`),
    "loops-keys": (w, s) =>
      `let state = {${wide(w)}}\nlet preset = state\n` +
      rows(s, () => `repeat 2 { state = preset }`) +
      `\n` +
      rows(w, (i) => `let result${i}: integer = state.p${i}`),
    "files-globals": (g, f) => [
      {
        path: "main.tease",
        source:
          rows(g, (i) => `global score${i} = ${i}`) +
          `\n` +
          rows(f, (i) => `call "part${i}.tease"`) +
          `\n` +
          rows(g, (i) => `let result${i}: integer = score${i}`),
      },
      ...Array.from({ length: f }, (_, i) => ({
        path: `part${i}.tease`,
        source: `score${i % g} = score${i % g} + 1\nend`,
      })),
    ],
    "wide-copies-fields": (w, s) =>
      `let state = {${wide(w)}}\nlet other = {${wide(w)}}\n` +
      rows(s, (i) => `let s${i} = other\nstate = s${i}`) +
      `\n` +
      rows(w, (i) => `let x${i} = state.p${i}`),
    "handlers-reading-state": (h, r) =>
      `let state = {n: 1}\n` +
      rows(
        h,
        (i) => `showPermanentButton "b${i}" { let v${i}: integer = state.n\nstate.n = ${i} }`,
      ) +
      `\nwait 2 s\n` +
      rows(r, (i) => `let read${i}: integer = state.n`),
    "astra-handlers": (h, r) =>
      `let n = 1\n` +
      rows(h, (i) => `showPermanentButton "B${i}" { n = 1 }`) +
      `\nwait 1 s\n` +
      rows(r, (i) => `let r${i}: integer = n`),
    "sol-tag-changing-sum": (w, s) =>
      rows(w, (i) => `let n${i} = ${i}`) +
      `\nfunction total { return ${Array.from({ length: w }, (_, i) => `n${i}`).join(" + ")} }\n` +
      rows(s, (i) => `let r${i} = total()\nn${i % w} = 1.5`) +
      `\nexit`,
    "sol5-record-fields-loops": (w, l) =>
      `let preset = {${Array.from({ length: w }, (_, i) => `k${i}: ${i}`).join(", ")}}\nlet settings = preset\n` +
      rows(l, () => `for item in [1, 2] { settings = preset }`) +
      `\n` +
      rows(w, (i) => `let r${i}: integer = settings.k${i}`) +
      `\nexit`,
    // round 6, Astra: one helper that changes w scores, called c times, then one typed read of each score
    "astra6-calls-mutate": (w, c) =>
      rows(w, (i) => `let score${i} = 0`) +
      `\nfunction advance {\n` +
      rows(w, (i) => `score${i} += 1`) +
      `\n}\n` +
      rows(c, () => `advance()`) +
      `\n` +
      rows(w, (i) => `let x${i}: integer = score${i}`),
    // round 6, Sol: the shared-state helper called c times, or invoked by c buttons, then w typed reads
    "sol6-calls-global": (w, c) =>
      rows(w, (i) => `let score${i} = 0`) +
      `\nfunction resetScores {\n` +
      rows(w, (i) => `score${i} = ${i}`) +
      `\n}\n` +
      rows(c, () => `resetScores()`) +
      `\n` +
      rows(w, (i) => `let total${i}: integer = score${i}`) +
      `\nexit`,
    "sol6-handler-shared": (w, h) =>
      rows(w, (i) => `let score${i} = 0`) +
      `\nfunction resetScores {\n` +
      rows(w, (i) => `score${i} = ${i}`) +
      `\n}\n` +
      rows(h, (i) => `showPermanentButton "Reset${i}" { resetScores() }`) +
      `\nwait 1 s\n` +
      rows(w, (i) => `let total${i}: integer = score${i}`) +
      `\nexit`,
    // round 6, Sol: l called labels entering a common tail of w statements
    "sol6-labels-shared-tail": (l, w) =>
      `let score = 0\n` +
      rows(l, (i) => `call part${i}`) +
      `\nexit\n` +
      rows(l, (i) => `label part${i}`) +
      `\n` +
      rows(w, (i) => `let temp${i} = ${i}`) +
      `\nscore = score + 1\nend`,
  };
  const ONE = {
    "astra-wide-helper-many-calls": (k) => total(k, k),
    "sol-calls-scalar-with-many-stores": (k) =>
      `let n = 1\nfunction read { return n }\n` +
      rows(k, (i) => `n = ${i}\nlet r${i}: integer = read()`),
    "sol-loops-keys": (k) =>
      rows(k, (i) => `let state${i} = {n: 1}\nlet hold${i} = state${i}`) +
      `\nrepeat 3 {\n` +
      rows(
        k,
        (i) => `state${i} = hold${i}\nhold${i} = state${i}\nlet r${i}: integer = hold${i}.n`,
      ) +
      `\n}`,
    "sol-files-globals": (k) => [
      {
        path: "main.tease",
        source:
          rows(k, (i) => `global g${i} = ${i}`) + `\n` + rows(k, (i) => `call "file${i}.tease"`),
      },
      ...Array.from({ length: k }, (_, i) => ({
        path: `file${i}.tease`,
        source: `let r: integer = g${i}\nend`,
      })),
    ],
    "sol-files-globals-shared-reader": (k) => [
      {
        path: "main.tease",
        source:
          rows(k, (i) => `global g${i} = ${i}`) + `\n` + rows(k, (i) => `call "file${i}.tease"`),
      },
      ...Array.from({ length: k }, (_, i) => ({
        path: `file${i}.tease`,
        source: `let r: integer = g0\nend`,
      })),
    ],
    "sol-distinct-handles": (k) =>
      `let state = {n: 0}\n` +
      rows(
        k,
        (i) => `let preset${i} = {n: ${i}}\nstate = preset${i}\nlet read${i}: integer = state.n`,
      ),
    "sol-older-source-updated": (k) =>
      `let state = {n: 0}\n` +
      rows(k, (i) => `let preset${i} = {n: ${i}}\nstate = preset${i}\nlet copy${i} = state`) +
      `\npreset0.n = 1.5\n` +
      rows(k, (i) => `let read${i}: integer = copy${i}.n`),
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
    "saved-views": (k) =>
      `let a = {n: 1}\nlet b = a\n` +
      rows(k, (i) => `let c${i} = b\nb = a\nlet r${i}: integer = c${i}.n`),
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
    "diamond-depth": (k) =>
      `let n = 1\nfunction f0 { return n }\n` +
      rows(k, (i) => `function f${i + 1} { return f${i}() + f${i}() }`) +
      `\nlet early = f${k}()\nn = 1.5\nlet late = f${k}()\nlet earlyChecked: integer = early\nlet lateChecked: number = late`,
    "while-helper-loop": (k) =>
      `let n = 1\nfunction again { let x: integer = n\n return hostFlag }\n` +
      rows(k, (i) => `while again() { n = n + ${i} }`),
    "astra-wide-private-locals": (k) =>
      `function work {\n` +
      rows(k, (i) => `let x${i} = ${i}`) +
      `\nreturn 1\n}\n` +
      rows(k, (i) => `let r${i}: integer = work()`),
    "astra-default-many-calls": (k) =>
      `function id(value = 1) { return value }\n` + rows(k, (i) => `let r${i}: integer = id(${i})`),
    "astra-many-shallow-wrappers": (k) =>
      `function base {\n` +
      rows(k, (i) => `let x${i} = ${i}`) +
      `\nreturn 1\n}\n` +
      rows(k, (i) => `function f${i} { return base() }\nlet r${i}: integer = f${i}()`),
    "astra-many-independent-functions": (k) =>
      rows(k, (i) => `function f${i} { return 1 }\nlet r${i}: integer = f${i}()`),
    "astra-loop-presets": (k) =>
      `let state = {${wide(k)}}\nlet preset = state\n` +
      rows(k, () => `repeat 2 { state = preset }`) +
      `\n` +
      rows(k, (i) => `let r${i}: integer = state.p${i}`),
    "astra-whole-presets": (k) =>
      `let state = {${wide(k)}}\nlet preset = state\n` +
      rows(k, () => `state = preset`) +
      `\n` +
      rows(k, (i) => `let r${i}: integer = state.p${i}`),
    "sol-plain-bindings": (k) => rows(k, (i) => `let x${i} = ${i}`) + `\nexit`,
    "sol-functions": (k) =>
      rows(k, (i) => `function f${i} { return ${i} }\nlet r${i} = f${i}()`) + `\nexit`,
    "sol-default-calls": (k) =>
      `function f(n = 0) { return n }\n` + rows(k, (i) => `let r${i} = f(${i})`) + `\nexit`,
    "sol-local-call-width": (k) =>
      `function f {\n` +
      rows(k, (i) => `let n${i} = ${i}`) +
      `\nreturn 1 }\n` +
      rows(k, (i) => `let r${i}: integer = f()`) +
      `\nexit`,
    "sol-handler-lifecycle": (k) =>
      `let n = 1\n` +
      rows(
        k,
        (i) =>
          `let b${i} = showPermanentButton "b${i}" { n = ${i} }\nb${i}.remove()\nlet r${i}: integer = n`,
      ) +
      `\nexit`,
    "quiet-score-buttons": (k) =>
      rows(k, (i) => `let score${i} = 0`) +
      `\n` +
      rows(k, (i) => `showPermanentButton "+${i}" { score${i} = score${i} + 1 }`) +
      `\nwait 5 s\n` +
      rows(k, (i) => `let s${i}: integer = score${i}`),
    "quiet-settings-helpers": (k) =>
      rows(k, (i) => `let setting${i} = ${i}`) +
      `\n` +
      rows(k, (i) => `function show${i} { say "{setting${i}}"\n return setting${i} }`) +
      `\n` +
      rows(k, (i) => `let v${i}: integer = show${i}()`),
    "quiet-timers-counters": (k) =>
      rows(k, (i) => `let tick${i} = 0`) +
      `\n` +
      rows(
        k,
        (i) => `timer(duration: ${i + 1} s, repeat: true, async: true) { tick${i} = tick${i} + 1 }`,
      ) +
      `\nwait 10 s\n` +
      rows(k, (i) => `let t${i}: integer = tick${i}`),
    "astra5-handlers-readers": (k) =>
      `let score = 0\n` +
      rows(k, (i) => `showPermanentButton "Point ${i}" { score += ${i + 1} }`) +
      `\nwait 1 s\n` +
      rows(k, (i) => `let result${i}: integer = score`),
    "astra5-handlers-independent-keys": (k) =>
      rows(k, (i) => `let score${i} = 0`) +
      `\n` +
      rows(k, (i) => `showPermanentButton "Point ${i}" { score${i} += 1 }`) +
      `\nwait 1 s\n` +
      rows(k, (i) => `let result${i}: integer = score${i}`),
    "astra5-loops-keys": (k) =>
      rows(k, (i) => `let score${i} = 0`) +
      `\n` +
      rows(k, (i) => `repeat 2 { score${i} += 1 }`) +
      `\n` +
      rows(k, (i) => `let result${i}: integer = score${i}`),
    "astra5-nested-ifs-10-groups": (k) =>
      `let score = 0\n` +
      rows(k, (i) => "if hostFlag {\n".repeat(10) + `score += ${i + 1}\n` + "}\n".repeat(10)) +
      `\nlet result: integer = score`,
    "astra5-files-globals": (k) => [
      {
        path: "main.tease",
        source:
          rows(k, (i) => `global g${i} = 0`) +
          `\n` +
          rows(k, (i) => `call "part${i}.tease"`) +
          `\n` +
          rows(k, (i) => `let result${i}: integer = g${i}`),
      },
      ...Array.from({ length: k }, (_, i) => ({
        path: `part${i}.tease`,
        source: `g${i} += 1\nend`,
      })),
    ],
    "astra5-call-chain": (k) =>
      rows(k, (i) => `function f${i} { return ${i + 1 < k ? `f${i + 1}()` : "1"} }`) +
      `\nlet result: integer = f0()\nexit`,
    "sol5-loops-keys": (k) =>
      rows(k, (i) => `let n${i} = ${i}`) +
      `\n` +
      rows(k, (i) => `repeat 2 { n${i} = n${i} + 1 }`) +
      `\n` +
      rows(k, (i) => `let r${i}: integer = n${i}`) +
      `\nexit`,
    "sol5-nested-ifs10-groups-reads": (k) =>
      `let n = 1\n` +
      rows(
        k,
        (i) =>
          "if hostFlag {\n".repeat(10) +
          `n = n + ${i}\n` +
          "}\n".repeat(10) +
          `let r${i}: integer = n`,
      ) +
      `\nexit`,
    "sol5-wrapper-chains10": (k) =>
      rows(k, (i) =>
        [
          `function h${i}_0 { return 1 }`,
          ...Array.from({ length: 9 }, (_, j) => `function h${i}_${j + 1} { return h${i}_${j}() }`),
          `let r${i}: integer = h${i}_9()`,
        ].join("\n"),
      ) + `\nexit`,
    "sol5-global-state-shared-helpers": (k) =>
      `let n = 1\n` +
      rows(k, (i) => `function f${i} { return n }`) +
      `\n` +
      rows(k, (i) => `n = ${i}\nlet a${i}: integer = f${i}()`) +
      `\n` +
      rows(k, (i) => `n = ${i + 1}\nlet b${i}: integer = f${i}()`) +
      `\nexit`,
    "sol5-global-functions-two-files": (k) => [
      { path: "main.tease", source: rows(k, (i) => `let r${i}: integer = f${i}()`) + `\nexit` },
      { path: "functions.tease", source: rows(k, (i) => `global function f${i} { return ${i} }`) },
    ],
    "sol5-sequential-ifs-depth1": (k) =>
      `let n = 1\n` +
      rows(k, (i) => "if hostFlag {\n" + `n = n + ${i}\n` + "}\n" + `let r${i}: integer = n`) +
      `\nexit`,
    "sol5-sequential-ifs-depth2": (k) =>
      `let n = 1\n` +
      rows(
        k,
        (i) =>
          "if hostFlag {\n".repeat(2) +
          `n = n + ${i}\n` +
          "}\n".repeat(2) +
          `let r${i}: integer = n`,
      ) +
      `\nexit`,
    "sol5-sequential-ifs-depth10": (k) =>
      `let n = 1\n` +
      rows(
        k,
        (i) =>
          "if hostFlag {\n".repeat(10) +
          `n = n + ${i}\n` +
          "}\n".repeat(10) +
          `let r${i}: integer = n`,
      ) +
      `\nexit`,
    // round 6, Astra
    "astra6-handler-records": (k) =>
      `let state = {n: 0}\n` +
      rows(k, (i) => `showPermanentButton "State ${i}" { state = {n: ${i}} }`) +
      `\nwait 1 s\n` +
      rows(k, (i) => `let x${i}: integer = state.n`),
    "astra6-wide-record": (k) =>
      `let preset = {${wide(k)}}\nlet settings = preset\n` +
      rows(k, (i) => `let x${i}: integer = settings.p${i}`),
    "astra6-handler-created-locals": (k) =>
      rows(
        k,
        (i) =>
          `function install${i} { let n = 0\nshowPermanentButton "Count ${i}" { n += 1\nlet x: integer = n } }\ninstall${i}()`,
      ),
    "astra6-ten-deep-groups": (k) =>
      `let score = 0\n` +
      rows(k, (i) => "if hostFlag {\n".repeat(10) + "score += 1\n" + "}\n".repeat(10)) +
      `\nlet x: integer = score`,
    // round 6, Sol
    "sol6-labels-fallthrough": (k) =>
      `global score = 0\n` +
      rows(k, (i) => `call part${i}`) +
      `\nexit\n` +
      rows(k, (i) => `label part${i}\nscore = score + 1`) +
      `\nend`,
    "sol6-files-shared-helper": (k) => [
      {
        path: "main.tease",
        source:
          `global score = 0\nglobal function bumpScore { score = score + 1 }\n` +
          rows(k, (i) => `call "f${i}.tease"`) +
          `\nexit`,
      },
      ...Array.from({ length: k }, (_, i) => ({ path: `f${i}.tease`, source: `bumpScore()\nend` })),
    ],
    "sol6-independent-handlers": (k) =>
      rows(
        k,
        (i) =>
          `let score${i} = 0\nfunction install${i} { showPermanentButton "Add${i}" { score${i} = score${i} + 1 } }\ninstall${i}()`,
      ) +
      `\nwait 1 s\n` +
      rows(k, (i) => `let value${i}: integer = score${i}`) +
      `\nexit`,
    "sol6-loop-rotation": (k) =>
      rows(k, (i) => `let cell${i}: integer | string = 0`) +
      `\nrepeat 3 {\n` +
      rows(k, (i) => `cell${i} = cell${(i + 1) % k}`) +
      `\ncell0 = "key"\n}\nlet value: integer = cell2\nexit`,
    "sol6-wide-record": (k) =>
      `let settings = {${wide(k)}}\n` +
      rows(k, (i) => `let value${i}: integer = settings.p${i}`) +
      `\nexit`,
  };
  const shapes0 = (() => {
    return {
      "handlers-readers": (n) => AXES["handlers-readers"](n),
      "calls-width": (n) => AXES["calls-width"](n),
      "loops-keys": (n) => AXES["loops-keys"](n),
      "files-globals": (n) => AXES["files-globals"](n),
      "wide-copies-fields": (n) => AXES["wide-copies-fields"](n),
      "handlers-reading-state": (n) => AXES["handlers-reading-state"](n),
      "astra-handlers": (n) => AXES["astra-handlers"](n),
      "sol-tag-changing-sum": (n) => AXES["sol-tag-changing-sum"](n),
      "sol5-record-fields-loops": (n) => AXES["sol5-record-fields-loops"](n),
      "astra6-calls-mutate": (n) => AXES["astra6-calls-mutate"](n),
      "sol6-calls-global": (n) => AXES["sol6-calls-global"](n),
      "sol6-handler-shared": (n) => AXES["sol6-handler-shared"](n),
      "sol6-labels-shared-tail": (n) => AXES["sol6-labels-shared-tail"](n),
    };
  })();
  const shapes1 = (() => {
    return {
      "astra-wide-helper-many-calls": (n) => ONE["astra-wide-helper-many-calls"](n),
      "sol-calls-scalar-with-many-stores": (n) => ONE["sol-calls-scalar-with-many-stores"](n),
      "sol-loops-keys": (n) => ONE["sol-loops-keys"](n),
      "sol-files-globals": (n) => ONE["sol-files-globals"](n),
      "sol-files-globals-shared-reader": (n) => ONE["sol-files-globals-shared-reader"](n),
      "sol-distinct-handles": (n) => ONE["sol-distinct-handles"](n),
      "sol-older-source-updated": (n) => ONE["sol-older-source-updated"](n),
      "copy-chain": (n) => ONE["copy-chain"](n),
      "nested-dating-sites": (n) => ONE["nested-dating-sites"](n),
      "reverse-calls-with-reads": (n) => ONE["reverse-calls-with-reads"](n),
      "staggered-wide-refresh": (n) => ONE["staggered-wide-refresh"](n),
      "wide-refresh-reads": (n) => ONE["wide-refresh-reads"](n),
      "saved-views": (n) => ONE["saved-views"](n),
      "loop-band-reads": (n) => ONE["loop-band-reads"](n),
      "nested-ifs-10": (n) => ONE["nested-ifs-10"](n),
      "diamond-depth": (n) => ONE["diamond-depth"](n),
      "while-helper-loop": (n) => ONE["while-helper-loop"](n),
      "astra-wide-private-locals": (n) => ONE["astra-wide-private-locals"](n),
      "astra-default-many-calls": (n) => ONE["astra-default-many-calls"](n),
      "astra-many-shallow-wrappers": (n) => ONE["astra-many-shallow-wrappers"](n),
      "astra-many-independent-functions": (n) => ONE["astra-many-independent-functions"](n),
      "astra-loop-presets": (n) => ONE["astra-loop-presets"](n),
      "astra-whole-presets": (n) => ONE["astra-whole-presets"](n),
      "sol-plain-bindings": (n) => ONE["sol-plain-bindings"](n),
      "sol-functions": (n) => ONE["sol-functions"](n),
      "sol-default-calls": (n) => ONE["sol-default-calls"](n),
      "sol-local-call-width": (n) => ONE["sol-local-call-width"](n),
      "sol-handler-lifecycle": (n) => ONE["sol-handler-lifecycle"](n),
      "quiet-score-buttons": (n) => ONE["quiet-score-buttons"](n),
      "quiet-settings-helpers": (n) => ONE["quiet-settings-helpers"](n),
      "quiet-timers-counters": (n) => ONE["quiet-timers-counters"](n),
      "astra5-handlers-readers": (n) => ONE["astra5-handlers-readers"](n),
      "astra5-handlers-independent-keys": (n) => ONE["astra5-handlers-independent-keys"](n),
      "astra5-loops-keys": (n) => ONE["astra5-loops-keys"](n),
      "astra5-nested-ifs-10-groups": (n) => ONE["astra5-nested-ifs-10-groups"](n),
      "astra5-files-globals": (n) => ONE["astra5-files-globals"](n),
      "astra5-call-chain": (n) => ONE["astra5-call-chain"](n),
      "sol5-loops-keys": (n) => ONE["sol5-loops-keys"](n),
      "sol5-nested-ifs10-groups-reads": (n) => ONE["sol5-nested-ifs10-groups-reads"](n),
      "sol5-wrapper-chains10": (n) => ONE["sol5-wrapper-chains10"](n),
      "sol5-global-state-shared-helpers": (n) => ONE["sol5-global-state-shared-helpers"](n),
      "sol5-global-functions-two-files": (n) => ONE["sol5-global-functions-two-files"](n),
      "sol5-sequential-ifs-depth1": (n) => ONE["sol5-sequential-ifs-depth1"](n),
      "sol5-sequential-ifs-depth2": (n) => ONE["sol5-sequential-ifs-depth2"](n),
      "sol5-sequential-ifs-depth10": (n) => ONE["sol5-sequential-ifs-depth10"](n),
      "astra6-handler-records": (n) => ONE["astra6-handler-records"](n),
      "astra6-wide-record": (n) => ONE["astra6-wide-record"](n),
      "astra6-handler-created-locals": (n) => ONE["astra6-handler-created-locals"](n),
      "astra6-ten-deep-groups": (n) => ONE["astra6-ten-deep-groups"](n),
      "sol6-labels-fallthrough": (n) => ONE["sol6-labels-fallthrough"](n),
      "sol6-files-shared-helper": (n) => ONE["sol6-files-shared-helper"](n),
      "sol6-independent-handlers": (n) => ONE["sol6-independent-handlers"](n),
      "sol6-loop-rotation": (n) => ONE["sol6-loop-rotation"](n),
      "sol6-wide-record": (n) => ONE["sol6-wide-record"](n),
    };
  })();
  return { shapes0, shapes1 };
})();
export const shapes = Object.fromEntries([
  ...Object.entries(outputs.shapes0).map(([name, make]) => ["shapes0/" + name, make]),
  ...Object.entries(outputs.shapes1).map(([name, make]) => ["shapes1/" + name, make]),
]);
export const checks = ["publication"];
