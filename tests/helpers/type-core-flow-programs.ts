/*
 * Programs for the coarse core's flow graph (src/type-inference/core/flow-graph.ts): every statement kind and every
 * expression with its own control flow, with `say` markers before, inside and after each construct. The graph test
 * compares the graph with the lowering's control flow on each; the dominators test checks the dominators of their
 * graphs. The first programs are those of the research model's validator (spike 14's `validate14.mjs`), without the
 * removed `fallback` and with `call` starting files at their top.
 *
 * `hostFlag`, `hostValue` and `hostList` are host globals, values the compiler cannot know, so a condition on one can
 * go either way. Where the graph proves more than the lowering's facts, `refinements` lists each difference, as the
 * test writes it, with the literal fact that explains it.
 */

export const HOST_GLOBALS: readonly string[] = [
  "hostValue",
  "hostFlag",
  "hostText",
  "hostList",
  "hostDict",
];

export interface FlowProgram {
  readonly name: string;
  /** The source of `main.tease`, or every file with `main.tease` first. */
  readonly files: string | readonly { readonly path: string; readonly source: string }[];
  /** The differences from the lowering that a literal fact only the graph uses explains. */
  readonly refinements?: { readonly reason: string; readonly differences: readonly string[] };
  /** Some way of it loops without end, so a run of it stops only at its step limit (the runtime check skips it). */
  readonly endless?: true;
}

const m = (marker: string): string => `say "${marker}"`;

export const FLOW_PROGRAMS: readonly FlowProgram[] = [
  {
    name: "if-host",
    files: `${m("A")}\nif hostFlag { ${m("B")} } else { ${m("C")} }\n${m("D")}\nexit`,
  },
  { name: "if-literal-false", files: `${m("A")}\nif false { ${m("B")} }\n${m("C")}\nexit` },
  {
    name: "if-literal-true-else",
    files: `${m("A")}\nif true { ${m("B")} } else { ${m("C")} }\n${m("D")}\nexit`,
  },
  {
    name: "nested-ifs",
    files: `${m("A")}\nif hostFlag { if hostFlag { ${m("B")} }\n ${m("C")} }\n${m("D")}\nexit`,
  },
  { name: "if-ask", files: `${m("A")}\nif askBoolean "Go?" { ${m("B")} }\n${m("C")}\nexit` },
  {
    name: "switch-host",
    files: `${m("A")}\nswitch hostValue { case 1 { ${m("B")} } case 2 { ${m("C")} } default { ${m("D")} } }\n${m("E")}\nexit`,
  },
  {
    name: "switch-literal",
    files: `${m("A")}\nswitch 2 { case 1 { ${m("B")} } case 2 { ${m("C")} } default { ${m("D")} } }\n${m("E")}\nexit`,
    refinements: {
      reason:
        "a literal subject with literal cases: the type check does not decide the cases, the graph does",
      differences: [
        "reach A->B: lowering=true graph=false",
        "reach A->D: lowering=true graph=false",
        "live B: lowering=true graph=false",
        "dom C->E: lowering=false graph=true",
        "live D: lowering=true graph=false",
        "way main.tease:2 case 0 taken: lowering=true graph=false",
        "way main.tease:2 case 1 none: lowering=true graph=false",
      ],
    },
  },
  {
    name: "while-host",
    files: `${m("A")}\nwhile hostFlag { ${m("B")}\n if hostFlag { continue }\n ${m("C")}\n if hostFlag { break }\n ${m("D")} }\n${m("E")}\nexit`,
  },
  { name: "while-false", files: `${m("A")}\nwhile false { ${m("B")} }\n${m("C")}\nexit` },
  {
    name: "while-helper",
    files: `function again { ${m("C")}\n return hostFlag }\n${m("A")}\nwhile again() { ${m("B")} }\n${m("E")}\nexit`,
  },
  {
    name: "while-helper-continue",
    files: `function again { ${m("C")}\n return hostFlag }\n${m("A")}\nwhile again() { ${m("B")}\n continue\n ${m("D")} }\n${m("E")}\nexit`,
  },
  {
    name: "repeat-2",
    files: `${m("A")}\nrepeat 2 { ${m("B")}\n if hostFlag { break }\n ${m("C")} }\n${m("D")}\nexit`,
  },
  {
    name: "repeat-2-plain",
    files: `${m("A")}\nrepeat 2 { ${m("B")}\n ${m("C")} }\n${m("D")}\nexit`,
  },
  {
    name: "repeat-1",
    files: `${m("A")}\nrepeat 1 { ${m("B")}\n if hostFlag { continue }\n ${m("C")} }\n${m("D")}\nexit`,
    refinements: {
      reason: "a literal count of one: the body runs once, so the graph has no second round",
      differences: ["reach C->B: lowering=true graph=false"],
    },
  },
  { name: "repeat-0", files: `${m("A")}\nrepeat 0 { ${m("B")} }\n${m("C")}\nexit` },
  {
    name: "repeat-host",
    files: `${m("A")}\nrepeat hostValue { ${m("B")}\n if hostFlag { continue }\n ${m("C")} }\n${m("D")}\nexit`,
  },
  {
    name: "for-list",
    files: `${m("A")}\nfor x in hostList { ${m("B")}\n if hostFlag { break }\n ${m("C")} }\n${m("D")}\nexit`,
  },
  {
    name: "function-return-value",
    files: `function f { ${m("B")}\n if hostFlag { return 1 }\n ${m("C")}\n return 2 }\n${m("A")}\nlet x = f()\n${m("D")}\nexit`,
  },
  {
    name: "function-bare-return",
    files: `function f { ${m("B")}\n if hostFlag { return }\n ${m("C")} }\n${m("A")}\nf()\n${m("D")}\nexit`,
  },
  {
    name: "function-two-calls",
    files: `function f { ${m("B")} }\n${m("A")}\nf()\n${m("C")}\nf()\n${m("D")}\nexit`,
  },
  {
    name: "function-nested-calls",
    files: `function g { ${m("C")} }\nfunction f { ${m("B")}\n g()\n ${m("D")} }\n${m("A")}\nf()\n${m("E")}\nexit`,
  },
  { name: "function-never-called", files: `function f { ${m("B")} }\n${m("A")}\n${m("C")}\nexit` },
  {
    name: "function-exit",
    files: `function f { ${m("B")}\n exit\n ${m("C")} }\n${m("A")}\nf()\n${m("D")}\nexit`,
  },
  {
    name: "dead-suffix",
    files: `${m("A")}\nexit\n${m("B")}\n${m("C")}\nlet x = 1\n${m("D")}\nexit`,
  },
  {
    name: "dead-after-return",
    files: `function f { ${m("B")}\n return 1\n ${m("C")}\n ${m("D")} }\n${m("A")}\nlet x = f()\n${m("E")}\nexit`,
  },
  { name: "goto-label", files: `${m("A")}\ngoto skip\n${m("B")}\nlabel skip\n${m("C")}\nexit` },
  {
    name: "label-fallthrough",
    files: `${m("A")}\nlabel again\n${m("B")}\nif hostFlag { goto again }\n${m("C")}\nexit`,
  },
  {
    name: "and-or-otherwise",
    files: `function f { ${m("B")}\n return true }\nfunction g { ${m("C")}\n return 1 }\n${m("A")}\nlet x = hostFlag and f()\nlet y = false and f()\nlet z = null otherwise g()\nlet w = 1 otherwise g()\n${m("D")}\nexit`,
    refinements: {
      reason:
        "a `null` literal before `otherwise`: the graph always runs its fallback, the type check does not record it",
      differences: ["way main.tease:8 otherwise skip: lowering=true graph=false"],
    },
  },
  {
    name: "lazy-get",
    files: `function f { ${m("B")}\n return 0 }\n${m("A")}\nlet x = hostList.get(0, default: f())\nlet y = [1].get(0, default: f())\nlet z = [].get(0, default: f())\n${m("C")}\nexit`,
    refinements: {
      reason:
        "a `get` on a list literal with a literal index: the graph knows whether its default runs, the lowering's facts do not",
      differences: [
        "way main.tease:5 default runs: lowering=true graph=false",
        "way main.tease:6 default skipped: lowering=true graph=false",
      ],
    },
  },
  {
    name: "parameter-default-supplied",
    files: `function f { ${m("B")}\n return 0 }\nfunction use(n = f()) { ${m("C")}\n return n }\n${m("A")}\nuse(1)\n${m("D")}\nexit`,
    refinements: {
      reason: "every call supplies the argument: the graph never runs the default",
      differences: ["live B: lowering=true graph=false", "reach A->B: lowering=true graph=false"],
    },
  },
  {
    name: "parameter-default-omitted",
    files: `function f { ${m("B")}\n return 0 }\nfunction use(n = f()) { ${m("C")}\n return n }\n${m("A")}\nuse()\n${m("D")}\nexit`,
  },
  {
    name: "parameter-default-mixed",
    files: `function f { ${m("B")}\n return 0 }\nfunction use(n = f()) { ${m("C")}\n return n }\n${m("A")}\nuse()\nuse(1)\n${m("D")}\nexit`,
  },
  {
    name: "button-handler",
    files: `${m("A")}\nshowPermanentButton "Go" { ${m("B")}\n if hostFlag { return }\n ${m("C")} }\n${m("D")}\nwait 1 s\n${m("E")}\nexit`,
  },
  {
    name: "timer-handler-helper",
    files: `function h { ${m("C")} }\n${m("A")}\nlet t = timer(duration: 1 s, async: true) { ${m("B")}\n h() }\n${m("D")}\nwait 2 s\n${m("E")}\nexit`,
  },
  {
    name: "handler-end",
    files: `${m("A")}\nshowPermanentButton "Go" { ${m("B")}\n end\n ${m("C")} }\n${m("D")}\nwait 1 s\nexit`,
  },
  {
    name: "handler-goto",
    files: `${m("A")}\nshowPermanentButton "Go" { ${m("B")}\n goto after\n ${m("C")} }\nwait 1 s\n${m("D")}\nlabel after\n${m("E")}\nexit`,
  },
  {
    name: "media-statement",
    files: `${m("A")}\nplayAudio async "clip.mp3" { ${m("B")} }\n${m("C")}\nwait 1 s\n${m("D")}\nexit`,
  },
  {
    name: "media-expression",
    files: `${m("A")}\nlet clip = playAudio async "clip.mp3" { ${m("B")} }\n${m("C")}\nwait 1 s\n${m("D")}\nexit`,
  },
  {
    name: "media-finish",
    files: `${m("A")}\nlet clip = playAudio async "clip.mp3" { finish { ${m("B")} } }\n${m("C")}\nwait 1 s\n${m("D")}\nexit`,
  },
  {
    name: "file-call-end",
    files: [
      { path: "main.tease", source: `${m("A")}\ncall "part.tease"\n${m("B")}\nexit` },
      { path: "part.tease", source: `${m("C")}\nif hostFlag { end }\n${m("D")}\nend` },
    ],
  },
  {
    name: "file-goto",
    files: [
      { path: "main.tease", source: `${m("A")}\ngoto "part.tease"\n${m("B")}\nexit` },
      { path: "part.tease", source: `${m("C")}\nexit` },
    ],
  },
  {
    name: "file-goto-from-called",
    files: [
      { path: "main.tease", source: `${m("A")}\ncall "part.tease"\n${m("B")}\nexit` },
      { path: "part.tease", source: `${m("C")}\ngoto "tail.tease"\n${m("D")}` },
      { path: "tail.tease", source: `${m("E")}\nend` },
    ],
  },
  {
    name: "end-in-function-of-called-file",
    files: [
      { path: "main.tease", source: `${m("A")}\ncall "part.tease"\n${m("B")}\nexit` },
      { path: "part.tease", source: `function leave { ${m("C")}\n end }\nleave()\n${m("D")}\nend` },
    ],
  },
  {
    name: "end-in-function-conditional",
    files: [
      { path: "main.tease", source: `${m("A")}\ncall "part.tease"\n${m("B")}\nexit` },
      {
        path: "part.tease",
        source: `function leave { ${m("C")}\n if hostFlag { end }\n ${m("E")} }\nleave()\n${m("D")}\nend`,
      },
    ],
  },
  {
    name: "handler-end-in-called-file",
    files: [
      { path: "main.tease", source: `${m("A")}\ncall "part.tease"\n${m("B")}\nexit` },
      {
        path: "part.tease",
        source: `${m("C")}\nshowPermanentButton "Go" { ${m("D")}\n end\n ${m("F")} }\nwait 1 s\n${m("E")}\nend`,
      },
    ],
  },
  {
    name: "dynamic-call",
    files: [
      {
        path: "main.tease",
        source: `${m("A")}\nlet target = script("part.tease")\ncall (target)\n${m("B")}\nexit`,
      },
      { path: "part.tease", source: `${m("C")}\nend\nlabel late\n${m("D")}\nend` },
    ],
  },
  {
    name: "file-never-entered",
    files: [
      { path: "main.tease", source: `${m("A")}\nexit` },
      { path: "part.tease", source: `${m("B")}\nend` },
    ],
  },
  {
    name: "recursion",
    files: `function f(n: integer) { ${m("B")}\n if n > 0 { f(n - 1) }\n ${m("C")} }\n${m("A")}\nf(2)\n${m("D")}\nexit`,
  },
  {
    name: "glob-call",
    files: [
      { path: "main.tease", source: `${m("A")}\ncall "parts/*.tease"\n${m("B")}\nexit` },
      { path: "parts/one.tease", source: `${m("C")}\nend` },
      { path: "parts/two.tease", source: `${m("D")}\nend` },
    ],
  },
  // Every other statement kind, every expression with control flow of its own or with operands in an order, the
  // literal forms the type check decides, the start values of the session, and the forms of calls and transfers.
  { name: "speaker-start", files: 'say "A"\nspeaker vera { firstName: "Vera" }\nsay "Z"\nexit\n' },
  {
    name: "speaker-set",
    files: 'say "A"\nspeaker vera { firstName: "Vera" }\nspeaker vera\nsay "Z"\nexit\n',
  },
  {
    name: "wait-operand",
    files: 'say "A"\nfunction delay { say "B"\n return 1 s }\nwait delay()\nsay "Z"\nexit\n',
  },
  {
    name: "image-show-hide",
    files: 'say "A"\nshowImage "photo.jpg"\nsay "B"\nhideImage\nsay "Z"\nexit\n',
  },
  { name: "camera-show-hide", files: 'say "A"\nshowCamera\nsay "B"\nhideCamera\nsay "Z"\nexit\n' },
  { name: "popup", files: 'say "A"\nshowPopup "B"\nsay "Z"\nexit\n' },
  {
    name: "open-url",
    files: 'say "A"\nopenUrl("https://example.com", buttonText: "B")\nsay "Z"\nexit\n',
  },
  {
    name: "export-text",
    files: 'say "A"\nexportText("B", title: "Report", fileName: "report.txt")\nsay "Z"\nexit\n',
  },
  { name: "audio-stop", files: 'say "A"\nstopAudio\nsay "Z"\nexit\n' },
  {
    name: "storage-save-delete",
    files: 'say "A"\nsave "B" as "key"\nsay "C"\ndelete "key"\nsay "Z"\nexit\n',
  },
  {
    name: "binding-assignment",
    files: 'say "A"\nlet n = 1\nsay "B"\nn += 2\nsay "C"\nn = 3\nsay "Z"\nexit\n',
  },
  { name: "global-start", files: 'say "A"\nglobal n = 0\nsay "Z"\nexit\n' },
  {
    name: "global-body-default",
    files:
      'say "A"\nfunction f { say "B"\n let local = 2\n global n = local, default: 0\n say "C" }\nf()\nsay "Z"\nexit\n',
  },
  {
    name: "timer-statement",
    files: 'say "A"\ntimer(duration: 1 s, async: true) { say "B"\n say "C" }\nsay "Z"\nexit\n',
  },
  { name: "timer-blocking", files: 'say "A"\ntimer 1 s\nsay "Z"\nexit\n' },
  { name: "button-statement", files: 'say "A"\nshowButton "B"\nsay "Z"\nexit\n' },
  {
    name: "media-blocking",
    files:
      'say "A"\nplayAudio "clip.mp3" { at 1 s { say "B" }\n beforeEnd 1 s { say "C" }\n finish { say "D" } }\nsay "Z"\nexit\n',
  },
  {
    name: "permanent-button-text-order",
    files:
      'say "A"\nfunction text { say "B"\n return "Go" }\nshowPermanentButton text() { say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "call-expression",
    files: 'say "A"\nfunction f { say "B"\n return 1 }\nf()\nsay "Z"\nexit\n',
  },
  {
    name: "assignment-index-order",
    files:
      'say "A"\nfunction idx { say "B"\n return 0 }\nfunction value { say "C"\n return 2 }\nlet xs = [1]\nxs[idx()] += value()\nsay "Z"\nexit\n',
  },
  {
    name: "permanent-button-value",
    files: 'say "A"\nlet button = showPermanentButton "Go" { say "B"\n say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "timer-value",
    files:
      'say "A"\nlet timerHandle = timer(duration: 1 s, async: true) { say "B"\n say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "timer-no-handler",
    files: 'say "A"\nlet handle = timer(duration: 1 s, async: true)\nsay "Z"\nexit\n',
  },
  { name: "say-value", files: 'say "A"\nlet line = say "B"\nsay "Z"\nexit\n' },
  {
    name: "button-value",
    files: 'say "A"\nlet elapsed = showButton "B", timeout: 1 s\nsay "Z"\nexit\n',
  },
  { name: "popup-value", files: 'say "A"\nlet elapsed = showPopup "B"\nsay "Z"\nexit\n' },
  { name: "camera-value", files: 'say "A"\nlet view = showCamera stage\nsay "Z"\nexit\n' },
  { name: "ask-text", files: 'say "A"\nlet answer = askText "B"\nsay "Z"\nexit\n' },
  {
    name: "ask-form",
    files:
      'say "A"\nlet value = askForm("B", fields: { active: false, count: 1 })\nsay "Z"\nexit\n',
  },
  { name: "ask-choice", files: 'say "A"\nlet value = askChoice "B", "C"\nsay "Z"\nexit\n' },
  { name: "take-photo", files: 'say "A"\nlet photo = takePhoto()\nsay "Z"\nexit\n' },
  {
    name: "lock-password-field",
    files:
      'say "A"\nlet locked = encryptText("text", password: askPassword "B", publicKey: false, timeLock: false)\nsay "C"\nlet opened = decryptText(locked, password: askPassword "D", default: "fallback")\nsay "Z"\nexit\n',
  },
  {
    name: "file-store-hash",
    files:
      'say "A"\nlet file = fileFromBase64("YWJj", default: "fallback")\nlet hash = hashFile(file)\nsay "B"\nlet base64 = fileToBase64(file)\nsay "Z"\nexit\n',
  },
  {
    name: "tag-query-bound",
    files:
      'say "A"\nfunction bound { say "B"\n return 1 }\nlet images = findImages(where: "rating" > bound())\nsay "Z"\nexit\n',
  },
  {
    name: "media-cues",
    files:
      'say "A"\nplayAudio async "clip.mp3" { at 1 s { say "B" }\n beforeEnd 1 s { say "C" }\n finish { say "D" } }\nsay "Z"\nexit\n',
  },
  {
    name: "video-expression",
    files: 'say "A"\nlet clip = playVideo async "clip.mp4" { say "B" }\nsay "Z"\nexit\n',
  },
  {
    name: "timer-nested-handler",
    files:
      'say "A"\ntimer(duration: 1 s, async: true) { say "B"\n showPermanentButton "Go" { say "C" }\n say "D" }\nsay "Z"\nexit\n',
  },
  {
    name: "dict-order",
    files:
      'function f { say "B"\n return 0 }\nfunction key { say "C"\n return "key" }\nfunction obj { say "D"\n return { value: 1 } }\nsay "A"\nlet xs = dict { [key()]: f(), [key()]: f() }\nsay "Z"\nexit\n',
  },
  {
    name: "index-order",
    files:
      'function f { say "B"\n return 0 }\nfunction key { say "C"\n return "key" }\nfunction obj { say "D"\n return { value: 1 } }\nsay "A"\nlet result = [f(), f()][f()]\nsay "Z"\nexit\n',
  },
  {
    name: "method-order",
    files:
      'function f { say "B"\n return 0 }\nfunction key { say "C"\n return "key" }\nfunction obj { say "D"\n return { value: 1 } }\nsay "A"\nlet result = [1].get(f(), default: f())\nsay "Z"\nexit\n',
  },
  {
    name: "string-interpolation",
    files:
      'function f { say "B"\n return 0 }\nfunction key { say "C"\n return "key" }\nfunction obj { say "D"\n return { value: 1 } }\nsay "A"\nsay "B ${f()} C ${f()}"\nsay "Z"\nexit\n',
  },
  {
    name: "say-presentation",
    files:
      'function text { say "B"\n return "value" }\nfunction delay { say "C"\n return 1 s }\nfunction color { say "D"\n return "#112233" }\nfunction flagValue { say "E"\n return false }\nsay "A"\nsay prose(color: color()) text()\nsay "Z"\nexit\n',
  },
  {
    name: "say-pacing",
    files:
      'function text { say "B"\n return "value" }\nfunction delay { say "C"\n return 1 s }\nfunction color { say "D"\n return "#112233" }\nfunction flagValue { say "E"\n return false }\nsay "A"\nsay text(), delay()\nsay "Z"\nexit\n',
  },
  {
    name: "nested-short-circuit",
    files:
      'say "A"\nfunction flag { say "B"\n return true }\nlet k = load "k1", default: false\nlet value = (k and flag()) or flag()\nsay "Z"\nexit\n',
  },
  {
    name: "global-in-dead-block",
    files: 'say "A"\nif false { global n = 1\n say "B" }\nsay n\nsay "Z"\nexit\n',
  },
  {
    name: "global-in-handler",
    files:
      'say "A"\nshowPermanentButton "Go" { say "B"\n global n = 1\n say "C" }\nsay n\nsay "Z"\nexit\n',
  },
  {
    name: "global-cross-file",
    files: [
      { path: "main.tease", source: 'say "A"\nsay n\nsay "Z"\nexit\n' },
      { path: "lib.tease", source: "global n = 2\n" },
    ],
  },
  {
    name: "speaker-cross-file",
    files: [
      { path: "main.tease", source: 'say "A"\nspeaker vera\nsay as vera "B"\nsay "Z"\nexit\n' },
      { path: "lib.tease", source: 'speaker vera { firstName: "Vera" }\n' },
    ],
  },
  {
    name: "global-body-interaction",
    files:
      'say "A"\nfunction f { say "B"\nglobal n = (askInteger "C"), default: 0\nsay "D" }\nf()\nsay "Z"\nexit\n',
  },
  {
    name: "while-true",
    files:
      'let k = load "k1", default: false\nsay "A"\nwhile true { say "B"\n if k { continue }\n say "C"\n break\n say "D" }\nsay "Z"\nexit\n',
    endless: true,
  },
  {
    name: "while-true-no-break",
    files:
      'let k = load "k1", default: false\nif k { exit }\nsay "A"\nwhile true { say "B" }\nsay "Z"\nexit\n',
    endless: true,
  },
  { name: "repeat-constant-zero", files: 'say "A"\nrepeat (1 - 1) { say "B" }\nsay "Z"\nexit\n' },
  { name: "repeat-constant-one", files: 'say "A"\nrepeat +1 { say "B" }\nsay "Z"\nexit\n' },
  {
    name: "condition-not-false",
    files:
      'say "A"\nlet k = load "k1", default: false\nif not false { say "B" } else { say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "condition-k-and-false",
    files:
      'say "A"\nlet k = load "k1", default: false\nif k and false { say "B" } else { say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "condition-k-or-true",
    files:
      'say "A"\nlet k = load "k1", default: false\nif k or true { say "B" } else { say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "repeat-one-continue",
    files: 'say "A"\nrepeat 1 { say "B"\n continue\n say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "switch-literal-string",
    files:
      'say "A"\nswitch "b" { case "a" { say "B" } case "b" { say "C" } default { say "D" } }\nsay "Z"\nexit\n',
    refinements: {
      reason:
        "a literal subject with literal cases: the type check does not decide the cases, the graph does",
      differences: [
        "dom C->Z: lowering=false graph=true",
        "live B: lowering=true graph=false",
        "live D: lowering=true graph=false",
        "reach A->B: lowering=true graph=false",
        "reach A->D: lowering=true graph=false",
        "way main.tease:2 case 0 taken: lowering=true graph=false",
        "way main.tease:2 case 1 none: lowering=true graph=false",
      ],
    },
  },
  {
    name: "switch-literal-boolean",
    files:
      'say "A"\nswitch true { case false { say "B" } case true { say "C" } default { say "D" } }\nsay "Z"\nexit\n',
    refinements: {
      reason:
        "a literal subject with literal cases: the type check does not decide the cases, the graph does",
      differences: [
        "dom C->Z: lowering=false graph=true",
        "live B: lowering=true graph=false",
        "reach A->B: lowering=true graph=false",
        "way main.tease:2 case 0 taken: lowering=true graph=false",
      ],
    },
  },
  {
    name: "switch-literal-null",
    files: 'say "A"\nswitch null { case null { say "B" } default { say "D" } }\nsay "Z"\nexit\n',
  },
  {
    name: "lazy-and-true",
    files:
      'function f { say "B"\n return true }\nlet k = load "k1", default: false\nlet n: integer? = load "n1", default: null\nsay "A"\nlet result = true and f()\nsay "Z"\nexit\n',
  },
  {
    name: "lazy-or-true",
    files:
      'function f { say "B"\n return true }\nlet k = load "k1", default: false\nlet n: integer? = load "n1", default: null\nsay "A"\nlet result = true or f()\nsay "Z"\nexit\n',
  },
  {
    name: "lazy-or-false",
    files:
      'function f { say "B"\n return true }\nlet k = load "k1", default: false\nlet n: integer? = load "n1", default: null\nsay "A"\nlet result = false or f()\nsay "Z"\nexit\n',
  },
  {
    name: "lazy-otherwise-n",
    files:
      'function f { say "B"\n return 2 }\nlet k = load "k1", default: false\nlet n: integer? = load "n1", default: null\nsay "A"\nlet result = n otherwise f()\nsay "Z"\nexit\n',
  },
  {
    name: "lazy-get-dict",
    files:
      'function f { say "B"\n return 2 }\nlet xs = load "xs", default: [1]\nlet i = load "i", default: 0\nsay "A"\nlet result = dict { "a": 1 }.get("z", default: f())\nsay "Z"\nexit\n',
  },
  {
    name: "lazy-get-grouped",
    files:
      'function f { say "B"\n return 2 }\nlet xs = load "xs", default: [1]\nlet i = load "i", default: 0\nsay "A"\nlet result = ([1].get)(0, default: f())\nsay "Z"\nexit\n',
    refinements: {
      reason:
        "a `get` on a list literal with a literal index: the graph knows whether its default runs, the lowering's facts do not",
      differences: [
        "live B: lowering=true graph=false",
        "reach A->B: lowering=true graph=false",
        "way main.tease:6 default runs: lowering=true graph=false",
      ],
    },
  },
  {
    name: "load-default-host",
    files:
      'function f { say "B"\n return 2 }\nsay "A"\nlet result = load "k2", default: f()\nsay "Z"\nexit\n',
  },
  {
    name: "load-default-pure",
    files:
      'function f { say "B"\n return 2 }\nsay "A"\nlet result = load "k2", default: 0\nsay "Z"\nexit\n',
  },
  {
    name: "lazy-call-toNumber",
    files:
      'function f { say "B"\n return 0 }\nlet input = load "input", default: "invalid"\nsay "A"\nlet result = toNumber(input, default: f())\nsay "Z"\nexit\n',
  },
  {
    name: "get-default-pure",
    files:
      'function f { say "B"\n return 0 }\nfunction key { say "C"\n return "key" }\nfunction obj { say "D"\n return { value: 1 } }\nsay "A"\nlet result = [1].get(0, default: 0)\nsay "Z"\nexit\n',
  },
  {
    name: "repeat-helper",
    files:
      'function count { say "B"\n return 2 }\nsay "A"\nrepeat count() { say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "for-helper",
    files:
      'function items { say "B"\n return [1, 2] }\nsay "A"\nfor x in items() { say "C" }\nsay "Z"\nexit\n',
  },
  {
    name: "handler-in-loop-timer",
    files:
      'say "A"\nrepeat 2 { say "C"\ntimer(duration: 1 s, async: true) { say "B" }\nsay "D" }\nsay "Z"\nexit\n',
  },
  {
    name: "label-backedge",
    files:
      'say "A"\nlet k = load "k1", default: false\nlabel again\nsay "B"\nif k { goto again }\nsay "Z"\nexit\n',
  },
  {
    name: "parameters-written-order",
    files:
      'function first { say "B"\n return 1 }\nfunction second { say "C"\n return 2 }\nfunction use(a = first(), b = second()) { say "D"\n return a + b }\nsay "A"\nuse(b: second())\nsay "Z"\nexit\n',
  },
  {
    name: "parameter-pure-default",
    files:
      'say "A"\nfunction use(n = 1) { say "B"\n return n }\nuse()\nsay "C"\nuse(2)\nsay "Z"\nexit\n',
  },
  {
    name: "parameter-dead-omitted-site",
    files:
      'say "A"\nfunction value { say "B"\n return 0 }\nfunction use(n = value()) { say "C" }\nuse(1)\nif false { use()\nsay "D" }\nsay "Z"\nexit\n',
  },
  {
    name: "parameter-dead-supplied-site",
    files:
      'say "A"\nfunction value { say "B"\n return 0 }\nfunction use(n = value()) { say "C" }\nuse()\nif false { use(1)\nsay "D" }\nsay "Z"\nexit\n',
  },
  {
    name: "global-function-cross-file",
    files: [
      { path: "main.tease", source: 'say "A"\nhelper()\nsay "Z"\nexit\n' },
      { path: "lib.tease", source: 'global function helper { say "B" }\n' },
    ],
  },
  {
    name: "called-function-end",
    files: [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "Z"\nexit\n' },
      {
        path: "part.tease",
        source:
          'function f { say "B"\nend\n say "C" }\nf()\nsay "D"\nend\nlabel after\nsay "E"\nend\n',
      },
    ],
  },
  {
    name: "called-function-exit",
    files: [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "Z"\nexit\n' },
      {
        path: "part.tease",
        source:
          'function f { say "B"\nexit\n say "C" }\nf()\nsay "D"\nend\nlabel after\nsay "E"\nend\n',
      },
    ],
  },
  {
    name: "called-function-goto",
    files: [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "Z"\nexit\n' },
      {
        path: "part.tease",
        source:
          'function f { say "B"\ngoto after\n say "C" }\nf()\nsay "D"\nend\nlabel after\nsay "E"\nend\n',
      },
    ],
  },
  {
    name: "handler-return",
    files:
      'say "A"\nshowPermanentButton "Go" { say "B"\nreturn\n say "C" }\nwait 1 s\nlabel after\nsay "D"\nsay "Z"\nexit\n',
  },
  {
    name: "handler-exit",
    files:
      'say "A"\nshowPermanentButton "Go" { say "B"\nexit\n say "C" }\nwait 1 s\nlabel after\nsay "D"\nsay "Z"\nexit\n',
  },
  {
    name: "goto-file-top-before-label",
    files: [
      { path: "main.tease", source: 'say "A"\ngoto "part.tease"\nsay "Z"\nexit\n' },
      { path: "part.tease", source: 'say "B"\nlabel start\nsay "C"\nexit\nsay "D"\n' },
    ],
  },
  {
    name: "call-file-top-before-label",
    files: [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "Z"\nexit\n' },
      { path: "part.tease", source: 'say "B"\nlabel start\nsay "C"\nend\nsay "D"\n' },
    ],
  },
  {
    name: "goto-glob",
    files: [
      { path: "main.tease", source: 'say "A"\ngoto "parts/*.tease"\nsay "Z"\nexit\n' },
      { path: "parts/one.tease", source: 'say "B"\nexit\n' },
      { path: "parts/two.tease", source: 'say "C"\nexit\n' },
    ],
  },
  {
    name: "goto-glob-segments",
    files: [
      { path: "main.tease", source: 'say "A"\ngoto "parts/*.tease"\nsay "Z"\nexit\n' },
      { path: "parts/one.tease", source: 'say "B"\nexit\n' },
      { path: "parts/deep/two.tease", source: 'say "C"\nexit\n' },
    ],
  },
  {
    name: "goto-glob-declarations",
    files: [
      { path: "main.tease", source: 'say "A"\ngoto "parts/*.tease"\nsay "Z"\nexit\n' },
      { path: "parts/one.tease", source: 'say "B"\nexit\n' },
      { path: "parts/lib.tease", source: 'global function neverCalled { say "C" }\n' },
    ],
  },
  {
    name: "goto-computed",
    files: [
      {
        path: "main.tease",
        source: 'let target = script("part.tease")\nsay "A"\ngoto (target)\nsay "Z"\nexit\n',
      },
      { path: "part.tease", source: 'say "B"\nexit\n' },
    ],
  },
  {
    name: "call-file",
    files: [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "Z"\nexit\n' },
      { path: "part.tease", source: 'say "B"\nend\n' },
    ],
  },
  {
    name: "call-glob-segments",
    files: [
      { path: "main.tease", source: 'say "A"\ncall "parts/*.tease"\nsay "Z"\nexit\n' },
      { path: "parts/one.tease", source: 'say "B"\nend\n' },
      { path: "parts/deep/two.tease", source: 'say "C"\nexit\n' },
    ],
  },
  {
    name: "call-glob-declarations",
    files: [
      { path: "main.tease", source: 'say "A"\ncall "parts/*.tease"\nsay "Z"\nexit\n' },
      { path: "parts/one.tease", source: 'say "B"\nend\n' },
      { path: "parts/lib.tease", source: 'global function neverCalled { say "C" }\n' },
    ],
  },
  {
    name: "call-computed",
    files: [
      {
        path: "main.tease",
        source: 'let target = script("part.tease")\nsay "A"\ncall (target)\nsay "Z"\nexit\n',
      },
      { path: "part.tease", source: 'say "B"\nend\n' },
    ],
  },
  {
    name: "nonreturning-function",
    files:
      'say "A"\nlet k = load "k1", default: false\nif k { exit }\nfunction stop { say "B"\n exit\n say "C" }\nstop()\nsay "Z"\nexit\n',
  },
  {
    name: "for-empty",
    files:
      'let xs = load "xs", default: [1, 2]\nsay "A"\nfor x in [] { say "B"\n say "C" }\nsay "Z"\nexit\n',
    refinements: {
      reason:
        "lowering only: the type check knows that a `for` over an empty literal never runs its body; the graph proves literal `repeat` counts only (P7), and F5a decides held iterables",
      differences: [
        "live B: lowering=false graph=true",
        "live C: lowering=false graph=true",
        "reach A->B: lowering=false graph=true",
        "reach A->C: lowering=false graph=true",
        "way main.tease:3 loop body: lowering=false graph=true",
      ],
    },
  },
  {
    name: "for-once",
    files:
      'let xs = load "xs", default: [1, 2]\nsay "A"\nfor x in [1] { say "B"\n say "C" }\nsay "Z"\nexit\n',
    refinements: {
      reason:
        "lowering only: the type check knows that a `for` over a non-empty literal runs its body; the graph proves literal `repeat` counts only (P7), and F5a decides held iterables",
      differences: [
        "dom B->Z: lowering=true graph=false",
        "dom C->Z: lowering=true graph=false",
        "way main.tease:3 loop no-run: lowering=false graph=true",
      ],
    },
  },
  {
    name: "otherwise-nonnull-210",
    files:
      'say "A"\nfunction fallbackValue { say "B"\n return 0 }\nlet value = (1 deg) otherwise fallbackValue()\nsay "Z"\nexit\n',
    refinements: {
      reason:
        "lowering only: the type check knows by its type that an angle is never null; the graph proves it for literals only",
      differences: [
        "live B: lowering=false graph=true",
        "reach A->B: lowering=false graph=true",
        "way main.tease:4 otherwise right: lowering=false graph=true",
      ],
    },
  },
  {
    name: "type-not-and-grouping",
    files:
      'function inspect(n: integer) {\n    say "BEFORE"\n    if not (((n) is string)) { say "THEN" } else { say "ELSE" }\n    say "AFTER"\n}\ninspect(1)\nexit\n',
    refinements: {
      reason:
        "lowering only: the type check rules the way out by the type of the tested variable (narrowing, 3b), not by a literal",
      differences: [
        "dom THEN->AFTER: lowering=true graph=false",
        "live ELSE: lowering=false graph=true",
        "reach BEFORE->ELSE: lowering=false graph=true",
        "way main.tease:3 if else: lowering=false graph=true",
      ],
    },
  },
];
