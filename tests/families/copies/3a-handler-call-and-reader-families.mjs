// 3a model, builder (R/3a-newcore/checkpoint-9/spike13/families8.mjs): handler, call, file and reader families over
// their axes, as families8.mjs printed them without arguments for the spike's gates (spike13 tools).
const generated = (() => {
  const sourceCases = [];
  // Work families for spike 7: revision 6's families (both reviewers' round-4 and round-5 families, the earlier
  // families, the quiet shapes at scale) and both reviewers' round-6 witnesses and families: the mutating helper called
  // k times (calls × modified keys), the shared-state helper behind k buttons, shared label tails, label fall-through,
  // records replaced by buttons, wide records, handler-created locals, loop rotation, files sharing a global helper and
  // independent registering functions. Usage: node families8.mjs [8,16,32,64,128] [axes]  (axes: both,first,second)
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
  const ks = ([][2] ?? "8,16,32,64,128").split(",").map(Number);
  const axes = ([][3] ?? "both,first,second").split(",");
  for (const [name, gen] of Object.entries(AXES))
    for (const ax of axes)
      for (const k of ks) {
        const [x, y] = ax === "both" ? [k, k] : ax === "first" ? [8, k] : [k, 8];
        sourceCases.push({ name: `${name}-${ax}/${k}`, source: gen(x, y), expect: "valid" });
      }
  for (const [name, gen] of Object.entries(ONE))
    for (const k of name === "diamond-depth"
      ? [2, 4, 6, 8, 10]
      : name.startsWith("sol5-sequential")
        ? [...ks, 256]
        : ks)
      sourceCases.push({ name: `${name}/${k}`, source: gen(k), expect: "valid" });
  // revision 8: both reviewers' revision-7 delta families. Astra: the chapter family (k scores, `advanceDay` increments
  // all, k chapters each call it, main reads each score: linear source), the shared-label tail in surface syntax, and
  // the interleaved story (k reward helpers over k relationship scores, k×k reward calls, k×k typed scene snapshots each
  // behind a narration helper that changes nothing: quadratic source). Sol: k story variables, k chapter-ending helpers,
  // k² chapter calls, k² status reads interleaved with `describeScene()` (a separate counter), the distinct-narrator
  // variant, and the linear control. Own: the dispatcher family (k keys each with its own setter, one `endOfDay`
  // dispatcher calling every setter, k scenes each calling the dispatcher, k typed reads): k classes at one entry.
  const DELTA = {
    "astra7-chapter-shared-update": [
      [8, 16, 32, 64, 128],
      (k) =>
        rows(k, (i) => `global mood${i} = 0`) +
        `\nfunction advanceDay {\n` +
        rows(k, (i) => `mood${i} += 1`) +
        `\n}\n` +
        rows(k, (i) => `function chapter${i} {\nsay "Chapter ${i}"\nadvanceDay()\n}`) +
        `\n` +
        rows(k, (i) => `chapter${i}()`) +
        `\n` +
        rows(k, (i) => `let check${i}: integer = mood${i}`) +
        `\nexit`,
    ],
    "astra7-labels-shared-tail": [
      [8, 16, 32, 64, 128],
      (k) =>
        `let score = 0\n` +
        rows(k, (i) => `call part${i}`) +
        `\nexit\n` +
        rows(k, (i) => `label part${i}`) +
        `\n` +
        rows(k, (i) => `let temp${i} = ${i}`) +
        `\nscore += 1\nend`,
    ],
    "astra7-story-interleaved": [
      [8, 16, 32, 64],
      (k) =>
        rows(k, (i) => `global rapport${i} = 0`) +
        `\n` +
        rows(
          k,
          (h) => `function reward${h} {\n` + rows(k, (i) => `rapport${i} = ${h + i}`) + `\n}`,
        ) +
        `\nfunction describeRoom { say "You look around the room." }\n` +
        rows(k, () => rows(k, (h) => `reward${h}()`)) +
        `\n` +
        rows(k, (scene) =>
          rows(k, (i) => `describeRoom()\nlet scene${scene}Score${i}: integer = rapport${i}`),
        ) +
        `\nexit`,
    ],
    "sol7-story-shared-state": [
      [4, 8, 16, 32, 64],
      (k) =>
        rows(k, (i) => `let trust${i} = 0`) +
        `\nlet sceneNumber = 0\n` +
        rows(
          k,
          (h) =>
            `function finishChapter${h} {\n` + rows(k, (i) => `trust${i} = ${(h + i) % 5}`) + `\n}`,
        ) +
        `\nfunction describeScene { sceneNumber += 1\n say "A door opens" }\n` +
        rows(k * k, (j) => `finishChapter${j % k}()`) +
        `\n` +
        rows(k * k, (j) => `describeScene()\nsay trust${j % k} + 1`) +
        `\nexit`,
    ],
    "sol7-story-distinct-scenes": [
      [4, 8, 16, 32, 64],
      (k) =>
        rows(k, (i) => `let trust${i} = 0`) +
        `\nlet sceneNumber = 0\n` +
        rows(
          k,
          (h) =>
            `function finishChapter${h} {\n` + rows(k, (i) => `trust${i} = ${(h + i) % 5}`) + `\n}`,
        ) +
        `\n` +
        rows(k, (h) => `function describeScene${h} { sceneNumber += 1\n say "A door opens" }`) +
        `\n` +
        rows(k * k, (j) => `finishChapter${j % k}()`) +
        `\n` +
        rows(k * k, (j) => `describeScene${j % k}()\nsay trust${j % k} + 1`) +
        `\nexit`,
    ],
    "sol7-story-linear-control": [
      [4, 8, 16, 32, 64],
      (k) =>
        rows(k, (i) => `let trust${i} = 0`) +
        `\nlet sceneNumber = 0\nfunction finishChapter {\n` +
        rows(k, (i) => `trust${i} = 1`) +
        `\n}\nfunction describeScene { sceneNumber += 1\n say "A door opens" }\nfinishChapter()\n` +
        rows(k, (i) => `describeScene()\nsay trust${i} + 1`) +
        `\nexit`,
    ],
    "own8-dispatcher-classes": [
      [8, 16, 32, 64, 128],
      (k) =>
        rows(k, (i) => `global stat${i} = 0`) +
        `\n` +
        rows(k, (i) => `function raise${i} { stat${i} = stat${i} + 1 }`) +
        `\nfunction endOfDay {\n` +
        rows(k, (i) => `raise${i}()`) +
        `\n}\n` +
        rows(k, (i) => `function scene${i} {\nsay "Scene ${i}"\nendOfDay()\n}`) +
        `\n` +
        rows(k, (i) => `scene${i}()`) +
        `\n` +
        rows(k, (i) => `let shown${i}: integer = stat${i}`) +
        `\nexit`,
    ],
  };
  for (const [name, [sizes, gen]] of Object.entries(DELTA))
    for (const k of sizes)
      if ([][2] === undefined || ks.includes(k))
        sourceCases.push({ name: `${name}/${k}`, source: gen(k), expect: "valid" });

  return sourceCases.map(({ name, source, files }) => [name, files ?? source]);
})();

// The label-call families, dropped: they called labels in the same file, which `main` no longer has (#1446).
const labelCalls =
  /^(sol6-labels-shared-tail-(both|first|second)|sol6-labels-fallthrough|astra7-labels-shared-tail)\//;
export const cases = generated.filter(([name]) => !labelCalls.test(name));

export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "$N spike13/families8.mjs > gates/families-k.jsonl",
      "R/3a-newcore/checkpoint-9/spike13/vps/run-all13.sh:19",
    ],
  ],
  sources: 471,
  sha256: "928f0097858c7c48dba09a8cb5ece3ac775ea820959afa86ced3b1d912def4f2",
  dropped: [
    [
      "6a06d8e3bdf345c88c4fd41779f1a361a7c775acdc653cbcda42a6d18e9ea2fd",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "843b0199cc23395c7da9a17e89f5459147d3732c66d2d9c455b90de78d351a61",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "8d3b1b798336f38c8f32aacd3fe494db7871fe2b78e4ba177d672ef0605e42e4",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "32e7c0ac3e3ca81e9e16886a43259cf213d5554ffff03f9ad3ccdd6f441bb892",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "f87eebfcf07d715f4e425c70fd1c668f697ff6cef18145d46489b85ff7b7ae66",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "0a4d74f3d60c180207dae143b22ad042d13335241eaea224ad7584a15518499f",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "b2ef7f2b78cef330f24bf942d5f755db4d3cc54ec7c14047c7b27f8732308633",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "14b1cf266ccf668112fa3cce07cafbc4e85c7c1a5724ef86be7f4e06f4e6054d",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "00e9da85a0cc6c2ea5b1934cfd94bb1f2774cc6d9c613e391e41e04bce53cf60",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "deb9772f075af733847a7019dee31cfbb4b3c983c075abc2137f96a92e96adc4",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "5aede77f797403166e648b86dad8d39cc9ab1c52a28f1e9d27cb4cbe5e1ca129",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "17c0617efbed97f8d98f1501e4307ce222fc725a1be6b1f5f2a1eac8c40c14de",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "c3d0acafc353ce6d8b3586edaac412c97e88b7d233e0609de3fb8f7a413301fe",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "0273bfa51b523c1c0c72d004c3955ba873f4b8990de750dbb39315f77142eb5b",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "7c59bec8dec21753b4d632f1075da117cfca1310edba559d7a5e2d50aa028614",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "7465aa1ba1e8ee372b2ee736e38ce7e13dab9b3ca4573690b113ac69fb31c62a",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "c90e3f3b77c0568664c9cb8226be78fcb4885b51198dcb27c845fd86fdba8be0",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "9ecc0a316d5c864a87b39c824ada96994230cccc6e0b8ae5a588585eef0ba962",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "d7464f05b0c36eb7e9feb81bdf058856c7c61e2840abe233024da64e8bb76307",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "a8fa0cd19b07bc3328b04e31b627f27dc50f9eaeee9b4ffac6a7e6cdc5114003",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "2979ff3ba5ab42b37981603f499b8047e35ff3ec4377646f7ca79c687482e346",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "d3105a9fc8019df619167b51f8a9064d7c5f903b3effb82bcf358bb1947ae9f3",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
    [
      "1c60d3a28b267fc368d9d96644d00d42ddf68cbc01f4ad6568b1865f0bf59bbd",
      "The workload expects valid label-call programs; main removed same-file call-to-label behavior. (undefined)",
    ],
  ],
};
