// #1319's own witnesses (`cases/g1`, `g1r`, `g2`, `g4`, each `.tease` with `exit` added): in its small set, analysed by
// `harness/probe/keptseq2.mjs`, and in its quick run, by `tools/rec.mjs` (with `hostValue` only)
// (desktop:~/work/evidence/1319/a320e5bc530113e947d9b48139bb694ae9cb7060/). The small set's 85 programs of Sol's
// admission reconnaissance are that run's (`copies/sol-admission-recon-shapes.mjs`).
export const cases = [
  [
    "own-g1::conv-first.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[root,toInteger(a0.f0,default:0),toInteger(a1.f0,default:0)]\nrepeat out[0].f0 {}\nexit\n",
  ],
  [
    "own-g1::conv-last.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[toInteger(a0.f0,default:0),toInteger(a1.f0,default:0),root]\nrepeat out[0].f0 {}\nexit\n",
  ],
  [
    "own-g1::host-beside.tease",
    "let raw=hostValue\nlet root={f0:1,f1:raw}\nlet a0=root\nlet a1=root\nlet out=[[a0].count(a0),[a1].count(a1),root]\nrepeat out[2].f1 {}\nexit\n",
  ],
  [
    "own-g1::method-first.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[root,[a0].count(a0),[a1].count(a1)]\nrepeat out[0].f0 {}\nexit\n",
  ],
  [
    "own-g1::method-last.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[[a0].count(a0),[a1].count(a1),root]\nrepeat out[0].f0 {}\nexit\n",
  ],
  [
    "own-g1::middle.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[[a0].count(a0),root,[a1].count(a1)]\nlet again=[out[1],root]\nrepeat out[0].f0 {}\nexit\n",
  ],
  [
    "own-g1::nested-classes.tease",
    "let root={f0:1,f1:{g:1}}\nlet a0=root\nlet a1=root\nlet b0=[a0.f1]\nlet b1=[a1.f1]\nlet out=[b0,b1,[root]]\nlet other=[[root],b0,b1]\nrepeat out[0][0].g {}\nexit\n",
  ],
  [
    "own-g1::two-literals.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet xs=[[a0].count(a0),root]\nxs=[root,[a1].count(a1)]\nrepeat xs[0].f0 {}\nexit\n",
  ],
  [
    "own-g1::written-scalar.tease",
    'let word:string="w"\nlet root={f0:word,f1:1}\nlet a0=root\nlet a1=root\nlet out=[toInteger(a0.f1,default:0),toInteger(a1.f1,default:0),root.f0]\nlet back=[root.f0,toInteger(a0.f1,default:0),toInteger(a1.f1,default:0)]\nexit\n',
  ],
  [
    "own-g2::nullable-leaf.tease",
    'let typed:integer?[][]=[]\nlet out=typed\nout=typed\nout=[[null],[2]]\nout=[["x"]]\nexit\n',
  ],
  [
    "own-g2::open-element.tease",
    'let typed:list[]=[]\nlet out=typed\nout=typed\nout=[[1]]\nout=[["x"]]\nlet deep:integer[][][]=[]\nlet copy=deep\ncopy=deep\ncopy=[[["y"]]]\nexit\n',
  ],
  [
    "own-g2::optional-middle.tease",
    'let typed:integer[]?[][]=[]\nlet out=typed\nout=typed\nout=[[null]]\nout=[[["x"]]]\nexit\n',
  ],
  [
    "own-g2::union-element.tease",
    'let typed:(integer | string)[][]=[]\nlet out=typed\nout=typed\nout=[["two"]]\nout=[[true]]\nexit\n',
  ],
  [
    "own-g4::preset-chain-joined.tease",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:0,p1:0}}\nlet c0=initial\nc0.nest.p1="bad"\nlet state=c0\nlet c1=state\nc1.nest.p0=false\nlet other=c1\nif flag {other=c0}\nlet sink0:integer=other.nest.p0\nlet sink1:integer=other.nest.p1\nexit\n',
  ],
  [
    "own-g4::preset-shared-and-prefix.tease",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:0,p1:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif flag {state=c0}\nlet c1=initial\nc1.nest.p0=2\nif flag {state=c1}\nlet c2=initial\nc2.nest={p0:true,p1:1}\nif flag {state=c2}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nlet whole=state.nest\nexit\n',
  ],
  [
    "own-g4::preset-siblings.tease",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:0,p1:0,p2:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif flag {state=c0}\nlet c1=initial\nc1.nest.p1="bad"\nif flag {state=c1}\nlet c2=initial\nc2.nest.p2="bad"\nif flag {state=c2}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nlet sink2:integer=state.nest.p2\nexit\n',
  ],
  [
    "own-g1::nested-member-last.tease",
    'let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[{g:a0},{g:a1},{g:{f0:"x",f1:1}}]\nrepeat out[0].g.f0 {}\nexit\n',
  ],
  [
    "own-g1::nested-member-first.tease",
    'let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[{g:{f0:"x",f1:1}},{g:a0},{g:a1}]\nrepeat out[0].g.f0 {}\nexit\n',
  ],
  [
    "own-g1r::guarded-first-reversed.tease",
    'let normal={x:1,y:1}\nlet root={x:"bad",y:1}\nif root.y is integer {\n let out=[[root].first,normal]\n say out[0].x\n}\nexit\n',
  ],
  [
    "own-g1r::guarded-first.tease",
    'let normal={x:1,y:1}\nlet root={x:"bad",y:1}\nif root.y is integer {\n let out=[normal,[root].first]\n say out[1].x\n}\nexit\n',
  ],
  [
    "own-g1r::guarded-get.tease",
    'let normal={x:1,y:1}\nlet root={x:"bad",y:1}\nif root.y is integer {\n let out=[normal,[root].get(0,default:normal)]\n say out[1].x\n}\nexit\n',
  ],
  [
    "own-g1r::guarded-index.tease",
    'let normal={x:1,y:1}\nlet root={x:"bad",y:1}\nif root.y is integer {\n let out=[normal,[root][0]]\n say out[1].x\n}\nexit\n',
  ],
  [
    "g1/conv-first.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[root,toInteger(a0.f0,default:0),toInteger(a1.f0,default:0)]\nrepeat out[0].f0 {}\nexit\n",
    ["hostValue"],
  ],
  [
    "g1/conv-last.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[toInteger(a0.f0,default:0),toInteger(a1.f0,default:0),root]\nrepeat out[0].f0 {}\nexit\n",
    ["hostValue"],
  ],
  [
    "g1/host-beside.tease",
    "let raw=hostValue\nlet root={f0:1,f1:raw}\nlet a0=root\nlet a1=root\nlet out=[[a0].count(a0),[a1].count(a1),root]\nrepeat out[2].f1 {}\nexit\n",
    ["hostValue"],
  ],
  [
    "g1/method-first.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[root,[a0].count(a0),[a1].count(a1)]\nrepeat out[0].f0 {}\nexit\n",
    ["hostValue"],
  ],
  [
    "g1/method-last.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[[a0].count(a0),[a1].count(a1),root]\nrepeat out[0].f0 {}\nexit\n",
    ["hostValue"],
  ],
  [
    "g1/middle.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[[a0].count(a0),root,[a1].count(a1)]\nlet again=[out[1],root]\nrepeat out[0].f0 {}\nexit\n",
    ["hostValue"],
  ],
  [
    "g1/nested-classes.tease",
    "let root={f0:1,f1:{g:1}}\nlet a0=root\nlet a1=root\nlet b0=[a0.f1]\nlet b1=[a1.f1]\nlet out=[b0,b1,[root]]\nlet other=[[root],b0,b1]\nrepeat out[0][0].g {}\nexit\n",
    ["hostValue"],
  ],
  [
    "g1/nested-member-first.tease",
    'let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[{g:{f0:"x",f1:1}},{g:a0},{g:a1}]\nrepeat out[0].g.f0 {}\nexit\n',
    ["hostValue"],
  ],
  [
    "g1/nested-member-last.tease",
    'let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet out=[{g:a0},{g:a1},{g:{f0:"x",f1:1}}]\nrepeat out[0].g.f0 {}\nexit\n',
    ["hostValue"],
  ],
  [
    "g1/two-literals.tease",
    "let root={f0:1,f1:1}\nlet a0=root\nlet a1=root\nlet xs=[[a0].count(a0),root]\nxs=[root,[a1].count(a1)]\nrepeat xs[0].f0 {}\nexit\n",
    ["hostValue"],
  ],
  [
    "g1/written-scalar.tease",
    'let word:string="w"\nlet root={f0:word,f1:1}\nlet a0=root\nlet a1=root\nlet out=[toInteger(a0.f1,default:0),toInteger(a1.f1,default:0),root.f0]\nlet back=[root.f0,toInteger(a0.f1,default:0),toInteger(a1.f1,default:0)]\nexit\n',
    ["hostValue"],
  ],
  [
    "g1r/guarded-first-reversed.tease",
    'let normal={x:1,y:1}\nlet root={x:"bad",y:1}\nif root.y is integer {\n let out=[[root].first,normal]\n say out[0].x\n}\nexit\n',
    ["hostValue"],
  ],
  [
    "g1r/guarded-first.tease",
    'let normal={x:1,y:1}\nlet root={x:"bad",y:1}\nif root.y is integer {\n let out=[normal,[root].first]\n say out[1].x\n}\nexit\n',
    ["hostValue"],
  ],
  [
    "g1r/guarded-get.tease",
    'let normal={x:1,y:1}\nlet root={x:"bad",y:1}\nif root.y is integer {\n let out=[normal,[root].get(0,default:normal)]\n say out[1].x\n}\nexit\n',
    ["hostValue"],
  ],
  [
    "g1r/guarded-index.tease",
    'let normal={x:1,y:1}\nlet root={x:"bad",y:1}\nif root.y is integer {\n let out=[normal,[root][0]]\n say out[1].x\n}\nexit\n',
    ["hostValue"],
  ],
  [
    "g2/nullable-leaf.tease",
    'let typed:integer?[][]=[]\nlet out=typed\nout=typed\nout=[[null],[2]]\nout=[["x"]]\nexit\n',
    ["hostValue"],
  ],
  [
    "g2/open-element.tease",
    'let typed:list[]=[]\nlet out=typed\nout=typed\nout=[[1]]\nout=[["x"]]\nlet deep:integer[][][]=[]\nlet copy=deep\ncopy=deep\ncopy=[[["y"]]]\nexit\n',
    ["hostValue"],
  ],
  [
    "g2/optional-middle.tease",
    'let typed:integer[]?[][]=[]\nlet out=typed\nout=typed\nout=[[null]]\nout=[[["x"]]]\nexit\n',
    ["hostValue"],
  ],
  [
    "g2/union-element.tease",
    'let typed:(integer | string)[][]=[]\nlet out=typed\nout=typed\nout=[["two"]]\nout=[[true]]\nexit\n',
    ["hostValue"],
  ],
  [
    "g4/preset-chain-joined.tease",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:0,p1:0}}\nlet c0=initial\nc0.nest.p1="bad"\nlet state=c0\nlet c1=state\nc1.nest.p0=false\nlet other=c1\nif flag {other=c0}\nlet sink0:integer=other.nest.p0\nlet sink1:integer=other.nest.p1\nexit\n',
    ["hostValue"],
  ],
  [
    "g4/preset-read-prefix.tease",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:null,p1:null}}\nlet state=initial\nlet c0=initial\nc0.nest={p0:"text",p1:null}\nif flag {state=c0}\nlet c1=initial\nc1.nest.p1=true\nif flag {state=c1}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nexit\n',
    ["hostValue"],
  ],
  [
    "g4/preset-read-through.tease",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:null,p1:null}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="text"\nif flag {state=c0}\nlet c1=initial\nc1.nest.p1=true\nif flag {state=c1}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nexit\n',
    ["hostValue"],
  ],
  [
    "g4/preset-shared-and-prefix.tease",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:0,p1:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif flag {state=c0}\nlet c1=initial\nc1.nest.p0=2\nif flag {state=c1}\nlet c2=initial\nc2.nest={p0:true,p1:1}\nif flag {state=c2}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nlet whole=state.nest\nexit\n',
    ["hostValue"],
  ],
  [
    "g4/preset-siblings.tease",
    'let flag=askBoolean "flag"\nlet initial={nest:{p0:0,p1:0,p2:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif flag {state=c0}\nlet c1=initial\nc1.nest.p1="bad"\nif flag {state=c1}\nlet c2=initial\nc2.nest.p2="bad"\nif flag {state=c2}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nlet sink2:integer=state.nest.p2\nexit\n',
    ["hostValue"],
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "else env TOUCH_ORACLE=0 $NODE harness/probe/keptseq2.mjs $R/trees/$1 cases/$set.json out/rec-$1-$set.jsonl || exit 1; fi",
      "desktop:~/work/evidence/1319/a320e5bc530113e947d9b48139bb694ae9cb7060/commands/tools/jobs/records.sh:7",
    ],
    [
      "for t in base c1 c3; do $NODE tools/rec.mjs $R/trees/$t/dist cases/g1r/*.tease cases/g1/*.tease cases/g2/*.tease cases/g4/*.tease | sed 's/ totals.*//' > out/quick-wit-$t.txt || exit 1; done",
      "desktop:~/work/evidence/1319/a320e5bc530113e947d9b48139bb694ae9cb7060/commands/tools/jobs/quick.sh:6",
    ],
  ],
  sources: 46,
  sha256: "e370a2dd49730a25b4444037bb6c3555d085d256f4125a55c2254d6623ec0429",
};
