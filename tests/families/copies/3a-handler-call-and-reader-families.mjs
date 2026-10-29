export const cases = (() => {
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

for (const index of [
  491, 490, 486, 485, 481, 480, 477, 476, 475, 474, 473, 447, 446, 445, 444, 443, 194, 193, 192,
  191, 190, 189, 188, 187, 186, 185, 184, 183, 182, 181, 180,
])
  cases.splice(index, 1);

export const checks = ["publication"];

export const globals = ["hostValue", "hostOther", "hostInit", "otherHost", "hostFlag"];
