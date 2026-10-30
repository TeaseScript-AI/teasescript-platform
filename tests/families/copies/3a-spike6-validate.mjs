// spike 6's execution-fidelity programs (the graph against the lowering), as its validator builds them; 3a
// checkpoint 9 (R/3a-newcore/checkpoint-9/spike6/validate6.mjs). The seven that use the removed fallback form or call
// a label do not resolve on `main` (TSP001, TSV057) and are dropped: the validator compared runs, not parses.
export const cases = [
  ["if-host", 'say "A"\nif hostFlag { say "B" } else { say "C" }\nsay "D"'],
  ["if-literal-false", 'say "A"\nif false { say "B" }\nsay "C"'],
  ["if-literal-true-else", 'say "A"\nif true { say "B" } else { say "C" }\nsay "D"'],
  ["nested-ifs", 'say "A"\nif hostFlag { if hostFlag { say "B" }\n say "C" }\nsay "D"'],
  ["if-ask", 'say "A"\nif askBoolean "Go?" { say "B" }\nsay "C"'],
  [
    "switch-host",
    'say "A"\nswitch hostValue { case 1 { say "B" } case 2 { say "C" } default { say "D" } }\nsay "E"',
  ],
  [
    "switch-literal",
    'say "A"\nswitch 2 { case 1 { say "B" } case 2 { say "C" } default { say "D" } }\nsay "E"',
  ],
  [
    "while-host",
    'say "A"\nwhile hostFlag { say "B"\n if hostFlag { continue }\n say "C"\n if hostFlag { break }\n say "D" }\nsay "E"',
  ],
  ["while-false", 'say "A"\nwhile false { say "B" }\nsay "C"'],
  [
    "while-helper",
    'function again { say "C"\n return hostFlag }\nsay "A"\nwhile again() { say "B" }\nsay "E"',
  ],
  [
    "while-helper-continue",
    'function again { say "C"\n return hostFlag }\nsay "A"\nwhile again() { say "B"\n continue\n say "D" }\nsay "E"',
  ],
  ["repeat-2", 'say "A"\nrepeat 2 { say "B"\n if hostFlag { break }\n say "C" }\nsay "D"'],
  ["repeat-2-plain", 'say "A"\nrepeat 2 { say "B"\n say "C" }\nsay "D"'],
  ["repeat-1", 'say "A"\nrepeat 1 { say "B"\n if hostFlag { continue }\n say "C" }\nsay "D"'],
  ["repeat-0", 'say "A"\nrepeat 0 { say "B" }\nsay "C"'],
  [
    "repeat-host",
    'say "A"\nrepeat hostValue { say "B"\n if hostFlag { continue }\n say "C" }\nsay "D"',
  ],
  ["for-list", 'say "A"\nfor x in hostList { say "B"\n if hostFlag { break }\n say "C" }\nsay "D"'],
  [
    "function-return-value",
    'function f { say "B"\n if hostFlag { return 1 }\n say "C"\n return 2 }\nsay "A"\nlet x = f()\nsay "D"',
  ],
  [
    "function-bare-return",
    'function f { say "B"\n if hostFlag { return }\n say "C" }\nsay "A"\nf()\nsay "D"',
  ],
  ["function-two-calls", 'function f { say "B" }\nsay "A"\nf()\nsay "C"\nf()\nsay "D"'],
  [
    "function-nested-calls",
    'function g { say "C" }\nfunction f { say "B"\n g()\n say "D" }\nsay "A"\nf()\nsay "E"',
  ],
  ["function-never-called", 'function f { say "B" }\nsay "A"\nsay "C"'],
  ["function-exit", 'function f { say "B"\n exit\n say "C" }\nsay "A"\nf()\nsay "D"'],
  ["function-end", 'function f { say "B"\n end\n say "C" }\nsay "A"\nf()\nsay "D"'],
  ["dead-suffix", 'say "A"\nexit\nsay "B"\nsay "C"\nlet x = 1\nsay "D"'],
  [
    "dead-after-return",
    'function f { say "B"\n return 1\n say "C"\n say "D" }\nsay "A"\nlet x = f()\nsay "E"',
  ],
  ["goto-label", 'say "A"\ngoto skip\nsay "B"\nlabel skip\nsay "C"'],
  ["label-fallthrough", 'say "A"\nlabel again\nsay "B"\nif hostFlag { goto again }\nsay "C"'],
  [
    "and-or-otherwise",
    'function f { say "B"\n return true }\nfunction g { say "C"\n return 1 }\nsay "A"\nlet x = hostFlag and f()\nlet y = false and f()\nlet z = null otherwise g()\nlet w = 1 otherwise g()\nsay "D"',
  ],
  [
    "lazy-get",
    'function f { say "B"\n return 0 }\nsay "A"\nlet x = hostList.get(0, default: f())\nlet y = [1].get(0, default: f())\nlet z = [].get(0, default: f())\nsay "C"',
  ],
  [
    "parameter-default-supplied",
    'function f { say "B"\n return 0 }\nfunction use(n = f()) { say "C"\n return n }\nsay "A"\nuse(1)\nsay "D"',
  ],
  [
    "parameter-default-omitted",
    'function f { say "B"\n return 0 }\nfunction use(n = f()) { say "C"\n return n }\nsay "A"\nuse()\nsay "D"',
  ],
  [
    "parameter-default-mixed",
    'function f { say "B"\n return 0 }\nfunction use(n = f()) { say "C"\n return n }\nsay "A"\nuse()\nuse(1)\nsay "D"',
  ],
  [
    "button-handler",
    'say "A"\nshowPermanentButton "Go" { say "B"\n if hostFlag { return }\n say "C" }\nsay "D"\nwait 1 s\nsay "E"',
  ],
  [
    "timer-handler-helper",
    'function h { say "C" }\nsay "A"\nlet t = timer(duration: 1 s, async: true) { say "B"\n h() }\nsay "D"\nwait 2 s\nsay "E"',
  ],
  [
    "handler-end",
    'say "A"\nshowPermanentButton "Go" { say "B"\n end\n say "C" }\nsay "D"\nwait 1 s',
  ],
  [
    "handler-goto",
    'say "A"\nshowPermanentButton "Go" { say "B"\n goto after\n say "C" }\nwait 1 s\nsay "D"\nlabel after\nsay "E"',
  ],
  [
    "media-statement",
    'say "A"\nplayAudio async "clip.mp3" { say "B" }\nsay "C"\nwait 1 s\nsay "D"',
  ],
  [
    "media-expression",
    'say "A"\nlet clip = playAudio async "clip.mp3" { say "B" }\nsay "C"\nwait 1 s\nsay "D"',
  ],
  [
    "file-call-end",
    [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "B"' },
      { path: "part.tease", source: 'say "C"\nif hostFlag { end }\nsay "D"\nend' },
    ],
  ],
  [
    "file-goto",
    [
      { path: "main.tease", source: 'say "A"\ngoto "part.tease"\nsay "B"' },
      { path: "part.tease", source: 'say "C"\nend' },
    ],
  ],
  [
    "file-goto-from-called",
    [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "B"' },
      { path: "part.tease", source: 'say "C"\ngoto "tail.tease"\nsay "D"' },
      { path: "tail.tease", source: 'say "E"\nend' },
    ],
  ],
  [
    "end-in-function-of-called-file",
    [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "B"' },
      { path: "part.tease", source: 'function leave { say "C"\n end }\nleave()\nsay "D"\nend' },
    ],
  ],
  [
    "end-in-function-conditional",
    [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "B"' },
      {
        path: "part.tease",
        source: 'function leave { say "C"\n if hostFlag { end }\n say "E" }\nleave()\nsay "D"\nend',
      },
    ],
  ],
  [
    "handler-end-in-called-file",
    [
      { path: "main.tease", source: 'say "A"\ncall "part.tease"\nsay "B"' },
      {
        path: "part.tease",
        source:
          'say "C"\nshowPermanentButton "Go" { say "D"\n end\n say "F" }\nwait 1 s\nsay "E"\nend',
      },
    ],
  ],
  [
    "dynamic-call",
    [
      {
        path: "main.tease",
        source: 'say "A"\nlet target = script("part.tease")\ncall (target)\nsay "B"',
      },
      { path: "part.tease", source: 'say "C"\nend\nlabel late\nsay "D"\nend' },
    ],
  ],
  [
    "file-never-entered",
    [
      { path: "main.tease", source: 'say "A"' },
      { path: "part.tease", source: 'say "B"\nend' },
    ],
  ],
  [
    "recursion",
    'function f(n: integer) { say "B"\n if n > 0 { f(n - 1) }\n say "C" }\nsay "A"\nf(2)\nsay "D"',
  ],
  [
    "sol-glob-call",
    [
      { path: "main.tease", source: 'say "A"\ncall "parts/*.tease"\nsay "B"\nexit' },
      { path: "parts/one.tease", source: 'say "C"\nend' },
      { path: "parts/two.tease", source: 'say "D"\nend' },
    ],
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostFlag", "hostText", "hostList", "hostDict"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node validate6.mjs <dist> [--list]", "R/3a-newcore/checkpoint-9/spike6/README.md:37"],
  ],
  sources: 56,
  sha256: "5f17fe5785bcf0b23e2847cd35afc17667bd4ae339b173d341482f8a6e77ad4e",
  dropped: [
    [
      "209fe5d79f877248e5668726e5a2a5cbe898df89af22c3848eb168ddcfa03c6a",
      "the removed fallback form (TSP001) or a call to a label (TSV057): the validator compared runs, not parses",
    ],
    [
      "8facf24f2fd0b3fffca0c951c21881b650e4dcbf4c6161c371f6a7384c1643e8",
      "the removed fallback form (TSP001) or a call to a label (TSV057): the validator compared runs, not parses",
    ],
    [
      "03f1587f61b18834f3a2f00763ad8bf4901dffd660180a95f9b85d1c8a13946a",
      "the removed fallback form (TSP001) or a call to a label (TSV057): the validator compared runs, not parses",
    ],
    [
      "8909d128ffb1d23da9b889120ffaee9fb8b9bd51c7d2e82d8f9fba375e48f878",
      "the removed fallback form (TSP001) or a call to a label (TSV057): the validator compared runs, not parses",
    ],
    [
      "4c0b9ea02f82c733cd7db0589865142e3d4ad26d5d53b9d09607071bbee0a75f",
      "the removed fallback form (TSP001) or a call to a label (TSV057): the validator compared runs, not parses",
    ],
    [
      "53d6fae6feee90c9e625f03d5a7fa06bf1d9418338f656154b5a73f9e2f79e45",
      "the removed fallback form (TSP001) or a call to a label (TSV057): the validator compared runs, not parses",
    ],
    [
      "d394287231f5bded707b1c74eb45f630b8291c111c7f9b8a857a5ed25d779059",
      "the removed fallback form (TSP001) or a call to a label (TSV057): the validator compared runs, not parses",
    ],
  ],
};
