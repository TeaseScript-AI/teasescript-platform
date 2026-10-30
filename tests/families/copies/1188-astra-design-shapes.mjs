// #1188's design review (Astra): its own shapes (nested diamonds, rejected projections, guarded and fed fans, opaque
// bags and cycles, sparse and equal pairs, plain and stored acyclic and fed cycles), at the sizes its recorded runs
// used: the smoke runs at 4 and 8, the series at 64, 128 and 256, the residual pairs at 8 to 32
// (R/astra-m4-i1188-design-review-evidence/probe/shapes.mjs, run by its `probe/run.mjs`). One earlier smoke template
// with a parameterless `()` function, which `main` no longer parses (TSP026), is dropped: it was meant valid.
const rows = (n, f) => Array.from({length:n}, (_,i)=>f(i));
const fields = (n, value='t', prefix='f')=>rows(n,i=>`${prefix}${i}:${value}`).join(',');
const source = (...s)=>s.flat(Infinity).join('\n')+'\nexit\n';
const T='let t:integer=1';
const shapes={
  'nested-diamonds':n=>source(T,`let root={${fields(n)}}`,`let peer={${fields(n,'t','g')}}`,rows(n,i=>[
    `let x${i}={left:{cell:root},right:{cell:root}}`, `let y${i}=x${i}`,
    `y${i}.left.cell={h${i}:t}`, `let z${i}=[y${i}.left.cell,peer]`,
    `let w${i}=[y${i}.right.cell,peer]`])),
  'rejected-projections':n=>source(T,`let root={${fields(n)}}`,`let peer={${fields(n,'1')}}`,rows(n,i=>[
    `let x${i}=root`, `x${i}.f0="bad"`, `let box${i}={cell:x${i}}`,
    `let copy${i}=box${i}.cell`,`let again${i}=copy${i}`,`let pair${i}=[again${i},peer]`])),
  'guarded-mixed-fan':n=>source(T,`let root={${fields(n)}}`,`let peer={${fields(n,'1')}}`,rows(n,i=>[
    `let x${i}=root`, `if hostValue { x${i}={extra${i}:t} }`,
    `let y${i}={slot:x${i},direct:{own${i}:t}}`, `let z${i}=y${i}.slot`]),
    `let bag=[peer,${rows(n,i=>`z${i}`).join(',')}]`),
  'fed-cycle-fan':n=>source(T,`let root={${fields(n)}}`,`let peer={${fields(n,'t','g')}}`,rows(n,i=>[
    `let a${i}=root`,`let b${i}=a${i}`,`a${i}=b${i}`,`b${i}.extra${i}=t`,
    `let c${i}={nest:b${i}}`,`let pair${i}=[c${i}.nest,peer]`])),
  'opaque-bag':n=>source('function make(x) { return hostValue }',rows(n,i=>`let u${i}=make(${i})`),
    `let bag=[${rows(n,i=>`u${i}`).join(',')}]`),
  'opaque-projected-bag':n=>source(T,'function make(x) { return hostValue }',rows(n,i=>`let u${i}={cell:make(${i})}`),
    `let bag=[${rows(n,i=>`u${i}.cell`).join(',')},{x:t}]`),
  'sparse-pairs':n=>source(T,rows(n,i=>`let r${i}={${fields(n,'t',`p${i}k`)}}`),
    rows(n,i=>rows(n,j=>i<j?`let pair${i}x${j}=[r${i},r${j}]`:[]))),
  'equal-pairs':n=>source(T,rows(n,i=>`let r${i}={${fields(n)}}`),
    rows(n,i=>rows(n,j=>i<j?`let pair${i}x${j}=[r${i},r${j}]`:[]))),
};
shapes['opaque-distinct-functions']=n=>source(T,rows(n,i=>[`function make${i}(x) { return hostValue }`,`let u${i}=make${i}(0)`]),`let bag=[${rows(n,i=>`u${i}`).join(',')},{x:t}]`);
shapes['opaque-cyclic-elements']=n=>source(T,rows(n,i=>[`let u${i}=hostValue`,`u${i}=u${i}`]),`let bag=[${rows(n,i=>`u${i}`).join(',')},{x:t}]`);
shapes['fed-cycle-plain']=n=>source(T,`let root={${fields(n)}}`,`let peer={${fields(n,'t','g')}}`,rows(n,i=>[
 `let a${i}=root`,`let b${i}=a${i}`,`a${i}=b${i}`,`let c${i}={nest:b${i}}`,`let pair${i}=[c${i}.nest,peer]`]));
shapes['acyclic-plain']=n=>source(T,`let root={${fields(n)}}`,`let peer={${fields(n,'t','g')}}`,rows(n,i=>[
 `let a${i}=root`,`let b${i}=a${i}`,`let c${i}={nest:b${i}}`,`let pair${i}=[c${i}.nest,peer]`]));
shapes['fed-cycle-store']=n=>source(T,`let root={${fields(n)}}`,`let peer={${fields(n,'t','g')}}`,rows(n,i=>[
 `let a${i}=root`,`let b${i}=a${i}`,`a${i}=b${i}`,`b${i}.f0=t`,`let c${i}={nest:b${i}}`,`let pair${i}=[c${i}.nest,peer]`]));
shapes['acyclic-store']=n=>source(T,`let root={${fields(n)}}`,`let peer={${fields(n,'t','g')}}`,rows(n,i=>[
 `let a${i}=root`,`let b${i}=a${i}`,`b${i}.f0=t`,`let c${i}={nest:b${i}}`,`let pair${i}=[c${i}.nest,peer]`]));
shapes['opaque-cycle-place']=n=>source(T,rows(n,i=>[`let u${i}=hostValue`,`u${i}=u${i}`]),'let bag={x:t}',rows(n,i=>`bag=u${i}`));
shapes['opaque-written-cycle-place']=n=>source(rows(n,i=>[`let u${i}:object=hostValue`,`u${i}=u${i}`]),'let bag=u0',rows(n,i=>i===0?[]:`bag=u${i}`));
// the sizes each shape ran at in the recorded runs (REPRODUCE.md:20 and the saved series)
const SERIES = [4, 8, 64, 128, 256];
const SIZES = {
  "nested-diamonds": SERIES,
  "rejected-projections": SERIES,
  "guarded-mixed-fan": SERIES,
  "fed-cycle-fan": SERIES,
  "opaque-bag": SERIES,
  "opaque-projected-bag": SERIES,
  "opaque-cyclic-elements": SERIES,
  "fed-cycle-plain": SERIES,
  "fed-cycle-store": SERIES,
  "acyclic-store": SERIES,
  "sparse-pairs": [4, 8, 16, 32],
  "equal-pairs": [4, 8, 16, 32],
  "acyclic-plain": [4, 8],
  "opaque-distinct-functions": [4, 8],
  "opaque-cycle-place": [4, 8],
  "opaque-written-cycle-place": [4, 8],
};
export const cases = Object.entries(SIZES).flatMap(([name, sizes]) =>
  sizes.map((n) => [`${name}-${n}`, shapes[name](n)]),
);

// the globals the recorded runs passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  "commands": [
    [
      "node probe/run.mjs base prototype acyclic-store,fed-cycle-store 4,8 out/cycle-store-smoke.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#acyclic-store-4, R/astra-m4-i1188-design-review-evidence/out/cycle-store-smoke.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype fed-cycle-store 4 out/cycle-trace.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#fed-cycle-store-4, R/astra-m4-i1188-design-review-evidence/out/cycle-trace.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype opaque-distinct-functions 4 out/neighbours-smoke.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-distinct-functions-4, R/astra-m4-i1188-design-review-evidence/out/neighbours-smoke.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype acyclic-plain,fed-cycle-plain,opaque-cyclic-elements,opaque-distinct-functions 4,8 out/neighbours2.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#acyclic-plain-4, R/astra-m4-i1188-design-review-evidence/out/neighbours2.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype opaque-cyclic-elements 64,128,256 out/opaque-observed.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-cyclic-elements-128, R/astra-m4-i1188-design-review-evidence/out/opaque-observed.jsonl:1, R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:27"
    ],
    [
      "node probe/run.mjs base prototype opaque-cycle-place 4,8 out/opaque-place-smoke.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-cycle-place-4, R/astra-m4-i1188-design-review-evidence/out/opaque-place-smoke.jsonl:1"
    ],
    [
      "NO_OBSERVE=1 node probe/run.mjs base prototype opaque-cyclic-elements 64,128,256 out/opaque-unobserved.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-cyclic-elements-128, R/astra-m4-i1188-design-review-evidence/out/opaque-unobserved.jsonl:1, R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:28"
    ],
    [
      "node probe/run.mjs base pr1-only fed-cycle-store 64,128,256 out/pr1-cycle.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#fed-cycle-store-128, R/astra-m4-i1188-design-review-evidence/out/pr1-cycle.jsonl:1, R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:25"
    ],
    [
      "node probe/run.mjs base prototype fed-cycle-store,opaque-written-cycle-place 4,8 out/pr1-neighbour-smoke.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#fed-cycle-store-4, R/astra-m4-i1188-design-review-evidence/out/pr1-neighbour-smoke.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype opaque-cycle-place 4,8 out/pr1-opaque-place-smoke.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-cycle-place-4, R/astra-m4-i1188-design-review-evidence/out/pr1-opaque-place-smoke.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype opaque-cyclic-elements 64,128,256 out/pr1-opaque.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-cyclic-elements-128, R/astra-m4-i1188-design-review-evidence/out/pr1-opaque.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#acyclic-store-128, R/astra-m4-i1188-design-review-evidence/out/series-cycle-store.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#fed-cycle-fan-128, R/astra-m4-i1188-design-review-evidence/out/series-fed-cycle-fan.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#fed-cycle-plain-128, R/astra-m4-i1188-design-review-evidence/out/series-fed-cycle-plain.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#guarded-mixed-fan-128, R/astra-m4-i1188-design-review-evidence/out/series-guarded-mixed-fan.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#nested-diamonds-128, R/astra-m4-i1188-design-review-evidence/out/series-nested-diamonds.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-bag-128, R/astra-m4-i1188-design-review-evidence/out/series-opaque-bag.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-cyclic-elements-128, R/astra-m4-i1188-design-review-evidence/out/series-opaque-cyclic-elements.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#opaque-projected-bag-128, R/astra-m4-i1188-design-review-evidence/out/series-opaque-projected-bag.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype <shape> 64,128,256 out/series-<shape>.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#rejected-projections-128, R/astra-m4-i1188-design-review-evidence/out/series-rejected-projections.jsonl:1"
    ],
    [
      "node probe/run.mjs base prototype sparse-pairs,equal-pairs 8,16,32 out/series-residual.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#equal-pairs-16, R/astra-m4-i1188-design-review-evidence/out/series-residual.jsonl:1, R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:24"
    ],
    [
      "node probe/run.mjs base prototype equal-pairs,fed-cycle-fan,guarded-mixed-fan,nested-diamonds,opaque-bag,opaque-projected-bag,rejected-projections,sparse-pairs 4,8 out/smoke.jsonl",
      "R/astra-m4-i1188-design-review-evidence/REPRODUCE.md:20, R/astra-m4-i1188-design-review-evidence/records-and-sources.tar.gz#equal-pairs-4, R/astra-m4-i1188-design-review-evidence/out/smoke.jsonl:1"
    ]
  ],
  "sources": 67,
  "sha256": "03d4f86880bd0092d5f2b8f1a9492bb2bdb8add62f19ee2aa5e088684fd36595",
  "dropped": [
    [
      "14601225a57ec3268a37397090b3e1a24cc5ca5f92794f444fdea66b24be3efd",
      "an earlier smoke template with a parameterless '()' function, which main no longer parses (TSP026): meant valid"
    ]
  ]
};
