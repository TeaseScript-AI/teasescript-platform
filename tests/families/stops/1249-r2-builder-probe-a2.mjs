// #1249's builder, review r2: the five A5 cases of its builder/tools/cases-a5.json, run by probe-a2.mjs
// (R/astra-m4-i1249-review-r2-evidence/builder/tools/).
export const cases = [
  [
    "077-0-1",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:0,p1:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif flag {state=c0}\nlet c1=initial\nc1.nest.p0=2\nif flag {state=c1}\nlet c2=initial\nc2.nest={p0:true,p1:1}\nif flag {state=c2}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nlet whole=state.nest\nexit\n',
  ],
  [
    "077-0-2",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:0,p1:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif flag {state=c0}\nlet c1=initial\nc1.nest.p0=2\nif flag {state=c1}\nlet c2=initial\nc2.nest={p0:true,p1:1}\nif flag {state=c2}\nexit\n',
  ],
  [
    "077-0-3",
    "let initial={nest:{p0:0,p1:0}}\nlet c2=initial\nc2.nest={p0:true,p1:1}\nlet sink0:integer=c2.nest.p0\nexit\n",
  ],
  ["077-0-4", "let initial={nest:{p0:0,p1:0}}\nlet c2=initial\nc2.nest={p0:true,p1:1}\nexit\n"],
  ["077-0-5", "let c2={nest:{p0:0,p1:0}}\nc2.nest={p0:true,p1:1}\nexit\n"],
];

// the globals the recorded run passed
export const globals = ["hostValue"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "- #1319's A5 witness: `node tools/probe-a2.mjs <tree>/dist tools/cases-a5.json` on `base6`, `pre4`, `final2` →",
      "R/astra-m4-i1249-review-r2-evidence/builder/COMMANDS.md:9",
    ],
  ],
  sources: 5,
  sha256: "c58935f2605bb13ea688b12eefa15ba3005dac200d8e67b41e4a0efcb42ae915",
};
