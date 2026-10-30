// Sol's admission reconnaissance: its shapes in the quick run (31 at 4 and 8) and the attribution runs (22 at 8 and 16,
// and deep-type-many-copies at 8 and 16), as #1319's small set copied them (R/sol-m4-admission-recon-r1-evidence/probe.mjs).
// `preset-objects` is the repository's A5-presets family (tests/helpers/type-core-families.ts) and is not copied.
export const cases = [
  [
    "nested-selection-variable-4.tease",
    'let seed="origin"\nlet out=[[[[seed,"other"][0],"other"][0],"other"][0],"other"][0]\nsay out\nexit\n',
  ],
  [
    "nested-selection-variable-8.tease",
    'let seed="origin"\nlet out=[[[[[[[[seed,"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0]\nsay out\nexit\n',
  ],
  [
    "nested-choice-variable-4.tease",
    'let seed="origin"\nlet out=askChoice [(askChoice [(askChoice [(askChoice seed),"other"]),"other"]),"other"]\nsay out\nexit\n',
  ],
  [
    "nested-choice-variable-8.tease",
    'let seed="origin"\nlet out=askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice seed),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]\nsay out\nexit\n',
  ],
  [
    "nested-selection-literal-4.tease",
    'let seed="origin"\nlet out=[[[["origin","other"][0],"other"][0],"other"][0],"other"][0]\nsay out\nexit\n',
  ],
  [
    "nested-selection-literal-8.tease",
    'let seed="origin"\nlet out=[[[[[[[["origin","other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0]\nsay out\nexit\n',
  ],
  [
    "nested-choice-literal-4.tease",
    'let seed="origin"\nlet out=askChoice [(askChoice [(askChoice [(askChoice "origin"),"other"]),"other"]),"other"]\nsay out\nexit\n',
  ],
  [
    "nested-choice-literal-8.tease",
    'let seed="origin"\nlet out=askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice "origin"),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]\nsay out\nexit\n',
  ],
  [
    "ring-member-stores-4.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed,f3:typed,extra:1}\nlet a0=root\na0.f0=2\nlet a1=a0\na1.f1=2\nlet a2=a1\na2.f2=2\nlet a3=a2\na3.f3=2\na0=a3\nexit\n",
  ],
  [
    "ring-member-stores-8.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed,f3:typed,f4:typed,f5:typed,f6:typed,f7:typed,extra:1}\nlet a0=root\na0.f0=2\nlet a1=a0\na1.f1=2\nlet a2=a1\na2.f2=2\nlet a3=a2\na3.f3=2\nlet a4=a3\na4.f4=2\nlet a5=a4\na5.f5=2\nlet a6=a5\na6.f6=2\nlet a7=a6\na7.f7=2\na0=a7\nexit\n",
  ],
  [
    "ring-member-stores-width-2-4.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,extra:1}\nlet a0=root\na0.f0=2\nlet a1=a0\na1.f1=2\nlet a2=a1\na2.f0=2\nlet a3=a2\na3.f1=2\na0=a3\nexit\n",
  ],
  [
    "ring-member-stores-width-2-8.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,extra:1}\nlet a0=root\na0.f0=2\nlet a1=a0\na1.f1=2\nlet a2=a1\na2.f0=2\nlet a3=a2\na3.f1=2\nlet a4=a3\na4.f0=2\nlet a5=a4\na5.f1=2\nlet a6=a5\na6.f0=2\nlet a7=a6\na7.f1=2\na0=a7\nexit\n",
  ],
  [
    "self-copy-chain-4.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed,f3:typed}\nlet a0=root\na0.q=a0\nlet a1=a0\na1.q=a1\nlet a2=a1\na2.q=a2\nlet a3=a2\na3.q=a3\nexit\n",
  ],
  [
    "self-copy-chain-8.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed,f3:typed,f4:typed,f5:typed,f6:typed,f7:typed}\nlet a0=root\na0.q=a0\nlet a1=a0\na1.q=a1\nlet a2=a1\na2.q=a2\nlet a3=a2\na3.q=a3\nlet a4=a3\na4.q=a4\nlet a5=a4\na5.q=a5\nlet a6=a5\na6.q=a6\nlet a7=a6\na7.q=a7\nexit\n",
  ],
  [
    "deep-wrapper-reads-4.tease",
    "let typed:integer=1\nlet root={f:typed,q:null}\nlet a0={q:root}\nlet a1={q:a0}\nlet a2={q:a1}\nlet a3={q:a2}\nlet out=a3.q.q.q.q.f\nexit\n",
  ],
  [
    "deep-wrapper-reads-8.tease",
    "let typed:integer=1\nlet root={f:typed,q:null}\nlet a0={q:root}\nlet a1={q:a0}\nlet a2={q:a1}\nlet a3={q:a2}\nlet a4={q:a3}\nlet a5={q:a4}\nlet a6={q:a5}\nlet a7={q:a6}\nlet out=a7.q.q.q.q.q.q.q.q.f\nexit\n",
  ],
  [
    "chain-same-property-plain-4.tease",
    "\nlet root={f0:1,f1:1,extra:1}\nlet a0=root\na0.extra=2\nlet a1=a0\na1.extra=2\nlet a2=a1\na2.extra=2\nlet a3=a2\na3.extra=2\nexit\n",
  ],
  [
    "chain-same-property-plain-8.tease",
    "\nlet root={f0:1,f1:1,extra:1}\nlet a0=root\na0.extra=2\nlet a1=a0\na1.extra=2\nlet a2=a1\na2.extra=2\nlet a3=a2\na3.extra=2\nlet a4=a3\na4.extra=2\nlet a5=a4\na5.extra=2\nlet a6=a5\na6.extra=2\nlet a7=a6\na7.extra=2\nexit\n",
  ],
  [
    "chain-same-property-written-4.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,extra:1}\nlet a0=root\na0.extra=2\nlet a1=a0\na1.extra=2\nlet a2=a1\na2.extra=2\nlet a3=a2\na3.extra=2\nexit\n",
  ],
  [
    "chain-same-property-written-8.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,extra:1}\nlet a0=root\na0.extra=2\nlet a1=a0\na1.extra=2\nlet a2=a1\na2.extra=2\nlet a3=a2\na3.extra=2\nlet a4=a3\na4.extra=2\nlet a5=a4\na5.extra=2\nlet a6=a5\na6.extra=2\nlet a7=a6\na7.extra=2\nexit\n",
  ],
  [
    "gets-in-literal-unknown-4.tease",
    "let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1]}\nlet xs = [root]\nlet box = [xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nexit\n",
  ],
  [
    "gets-in-literal-unknown-8.tease",
    "let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1], f4: [1, raw][1], f5: [1, raw][1], f6: [1, raw][1], f7: [1, raw][1]}\nlet xs = [root]\nlet box = [xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nrepeat box[0].f4 {}\nrepeat box[0].f5 {}\nrepeat box[0].f6 {}\nrepeat box[0].f7 {}\nexit\n",
  ],
  [
    "gets-in-literal-plain-4.tease",
    "let raw = hostValue\nlet root = {f0: 1, f1: 1, f2: 1, f3: 1}\nlet xs = [root]\nlet box = [xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nexit\n",
  ],
  [
    "gets-in-literal-plain-8.tease",
    "let raw = hostValue\nlet root = {f0: 1, f1: 1, f2: 1, f3: 1, f4: 1, f5: 1, f6: 1, f7: 1}\nlet xs = [root]\nlet box = [xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nrepeat box[0].f4 {}\nrepeat box[0].f5 {}\nrepeat box[0].f6 {}\nrepeat box[0].f7 {}\nexit\n",
  ],
  [
    "alias-choices-unknown-4.tease",
    'let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1]}\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet box = askChoice {text: "0", value: alias0}, {text: "1", value: alias1}, {text: "2", value: alias2}, {text: "3", value: alias3}\nrepeat box.f0 {}\nrepeat box.f1 {}\nrepeat box.f2 {}\nrepeat box.f3 {}\nexit\n',
  ],
  [
    "alias-choices-unknown-8.tease",
    'let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1], f4: [1, raw][1], f5: [1, raw][1], f6: [1, raw][1], f7: [1, raw][1]}\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet alias4 = root\nlet alias5 = root\nlet alias6 = root\nlet alias7 = root\nlet box = askChoice {text: "0", value: alias0}, {text: "1", value: alias1}, {text: "2", value: alias2}, {text: "3", value: alias3}, {text: "4", value: alias4}, {text: "5", value: alias5}, {text: "6", value: alias6}, {text: "7", value: alias7}\nrepeat box.f0 {}\nrepeat box.f1 {}\nrepeat box.f2 {}\nrepeat box.f3 {}\nrepeat box.f4 {}\nrepeat box.f5 {}\nrepeat box.f6 {}\nrepeat box.f7 {}\nexit\n',
  ],
  [
    "alias-choices-plain-4.tease",
    'let raw = hostValue\nlet root = {f0: 1, f1: 1, f2: 1, f3: 1}\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet box = askChoice {text: "0", value: alias0}, {text: "1", value: alias1}, {text: "2", value: alias2}, {text: "3", value: alias3}\nrepeat box.f0 {}\nrepeat box.f1 {}\nrepeat box.f2 {}\nrepeat box.f3 {}\nexit\n',
  ],
  [
    "alias-choices-plain-8.tease",
    'let raw = hostValue\nlet root = {f0: 1, f1: 1, f2: 1, f3: 1, f4: 1, f5: 1, f6: 1, f7: 1}\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet alias4 = root\nlet alias5 = root\nlet alias6 = root\nlet alias7 = root\nlet box = askChoice {text: "0", value: alias0}, {text: "1", value: alias1}, {text: "2", value: alias2}, {text: "3", value: alias3}, {text: "4", value: alias4}, {text: "5", value: alias5}, {text: "6", value: alias6}, {text: "7", value: alias7}\nrepeat box.f0 {}\nrepeat box.f1 {}\nrepeat box.f2 {}\nrepeat box.f3 {}\nrepeat box.f4 {}\nrepeat box.f5 {}\nrepeat box.f6 {}\nrepeat box.f7 {}\nexit\n',
  ],
  [
    "alias-gets-unknown-4.tease",
    "let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1]}\nlet xs = [root]\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet list0 = xs\nlet list1 = xs\nlet list2 = xs\nlet list3 = xs\nlet box = [list0.get(0, default: alias0), list1.get(0, default: alias1), list2.get(0, default: alias2), list3.get(0, default: alias3)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nexit\n",
  ],
  [
    "alias-gets-unknown-8.tease",
    "let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1], f4: [1, raw][1], f5: [1, raw][1], f6: [1, raw][1], f7: [1, raw][1]}\nlet xs = [root]\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet alias4 = root\nlet alias5 = root\nlet alias6 = root\nlet alias7 = root\nlet list0 = xs\nlet list1 = xs\nlet list2 = xs\nlet list3 = xs\nlet list4 = xs\nlet list5 = xs\nlet list6 = xs\nlet list7 = xs\nlet box = [list0.get(0, default: alias0), list1.get(0, default: alias1), list2.get(0, default: alias2), list3.get(0, default: alias3), list4.get(0, default: alias4), list5.get(0, default: alias5), list6.get(0, default: alias6), list7.get(0, default: alias7)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nrepeat box[0].f4 {}\nrepeat box[0].f5 {}\nrepeat box[0].f6 {}\nrepeat box[0].f7 {}\nexit\n",
  ],
  [
    "alias-gets-plain-4.tease",
    "let raw = hostValue\nlet root = {f0: 1, f1: 1, f2: 1, f3: 1}\nlet xs = [root]\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet list0 = xs\nlet list1 = xs\nlet list2 = xs\nlet list3 = xs\nlet box = [list0.get(0, default: alias0), list1.get(0, default: alias1), list2.get(0, default: alias2), list3.get(0, default: alias3)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nexit\n",
  ],
  [
    "alias-gets-plain-8.tease",
    "let raw = hostValue\nlet root = {f0: 1, f1: 1, f2: 1, f3: 1, f4: 1, f5: 1, f6: 1, f7: 1}\nlet xs = [root]\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet alias4 = root\nlet alias5 = root\nlet alias6 = root\nlet alias7 = root\nlet list0 = xs\nlet list1 = xs\nlet list2 = xs\nlet list3 = xs\nlet list4 = xs\nlet list5 = xs\nlet list6 = xs\nlet list7 = xs\nlet box = [list0.get(0, default: alias0), list1.get(0, default: alias1), list2.get(0, default: alias2), list3.get(0, default: alias3), list4.get(0, default: alias4), list5.get(0, default: alias5), list6.get(0, default: alias6), list7.get(0, default: alias7)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nrepeat box[0].f4 {}\nrepeat box[0].f5 {}\nrepeat box[0].f6 {}\nrepeat box[0].f7 {}\nexit\n",
  ],
  [
    "host-object-property-projection-4.tease",
    "let seed={f0:1,f1:1,f2:1,f3:1}\nlet out=[({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nexit\n",
  ],
  [
    "host-object-property-projection-8.tease",
    "let seed={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1}\nlet out=[({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nrepeat out[0].f4 {}\nrepeat out[0].f5 {}\nrepeat out[0].f6 {}\nrepeat out[0].f7 {}\nexit\n",
  ],
  [
    "load-add-host-default-4.tease",
    'let raw=hostValue\nlet seed={f0:[1,raw][1],f1:[1,raw][1],f2:[1,raw][1],f3:[1,raw][1]}\nlet xs=[]\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nrepeat xs.last.f0 {}\nrepeat xs.last.f1 {}\nrepeat xs.last.f2 {}\nrepeat xs.last.f3 {}\nexit\n',
  ],
  [
    "load-add-host-default-8.tease",
    'let raw=hostValue\nlet seed={f0:[1,raw][1],f1:[1,raw][1],f2:[1,raw][1],f3:[1,raw][1],f4:[1,raw][1],f5:[1,raw][1],f6:[1,raw][1],f7:[1,raw][1]}\nlet xs=[]\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nrepeat xs.last.f0 {}\nrepeat xs.last.f1 {}\nrepeat xs.last.f2 {}\nrepeat xs.last.f3 {}\nrepeat xs.last.f4 {}\nrepeat xs.last.f5 {}\nrepeat xs.last.f6 {}\nrepeat xs.last.f7 {}\nexit\n',
  ],
  [
    "parse-add-host-default-4.tease",
    'let raw=hostValue\nlet seed={f0:[1,raw][1],f1:[1,raw][1],f2:[1,raw][1],f3:[1,raw][1]}\nlet xs=[]\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nrepeat xs.last.f0 {}\nrepeat xs.last.f1 {}\nrepeat xs.last.f2 {}\nrepeat xs.last.f3 {}\nexit\n',
  ],
  [
    "parse-add-host-default-8.tease",
    'let raw=hostValue\nlet seed={f0:[1,raw][1],f1:[1,raw][1],f2:[1,raw][1],f3:[1,raw][1],f4:[1,raw][1],f5:[1,raw][1],f6:[1,raw][1],f7:[1,raw][1]}\nlet xs=[]\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nrepeat xs.last.f0 {}\nrepeat xs.last.f1 {}\nrepeat xs.last.f2 {}\nrepeat xs.last.f3 {}\nrepeat xs.last.f4 {}\nrepeat xs.last.f5 {}\nrepeat xs.last.f6 {}\nrepeat xs.last.f7 {}\nexit\n',
  ],
  [
    "nested-preset-control-4.tease",
    'let initial={nest:{p0:0,p1:0,p2:0,p3:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif hostValue {state=c0}\nlet c1=initial\nc1.nest.p1="bad"\nif hostValue {state=c1}\nlet c2=initial\nc2.nest.p2="bad"\nif hostValue {state=c2}\nlet c3=initial\nc3.nest.p3="bad"\nif hostValue {state=c3}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nlet sink2:integer=state.nest.p2\nlet sink3:integer=state.nest.p3\nexit\n',
  ],
  [
    "nested-preset-control-8.tease",
    'let initial={nest:{p0:0,p1:0,p2:0,p3:0,p4:0,p5:0,p6:0,p7:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif hostValue {state=c0}\nlet c1=initial\nc1.nest.p1="bad"\nif hostValue {state=c1}\nlet c2=initial\nc2.nest.p2="bad"\nif hostValue {state=c2}\nlet c3=initial\nc3.nest.p3="bad"\nif hostValue {state=c3}\nlet c4=initial\nc4.nest.p4="bad"\nif hostValue {state=c4}\nlet c5=initial\nc5.nest.p5="bad"\nif hostValue {state=c5}\nlet c6=initial\nc6.nest.p6="bad"\nif hostValue {state=c6}\nlet c7=initial\nc7.nest.p7="bad"\nif hostValue {state=c7}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nlet sink2:integer=state.nest.p2\nlet sink3:integer=state.nest.p3\nlet sink4:integer=state.nest.p4\nlet sink5:integer=state.nest.p5\nlet sink6:integer=state.nest.p6\nlet sink7:integer=state.nest.p7\nexit\n',
  ],
  [
    "declared-method-beside-object-4.tease",
    "let root={f0:1,f1:1,f2:1,f3:1}\nlet a0=root\nlet a1=root\nlet a2=root\nlet a3=root\nlet out=[[a0].count(a0),[a1].count(a1),[a2].count(a2),[a3].count(a3),root]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nexit\n",
  ],
  [
    "declared-method-beside-object-8.tease",
    "let root={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1}\nlet a0=root\nlet a1=root\nlet a2=root\nlet a3=root\nlet a4=root\nlet a5=root\nlet a6=root\nlet a7=root\nlet out=[[a0].count(a0),[a1].count(a1),[a2].count(a2),[a3].count(a3),[a4].count(a4),[a5].count(a5),[a6].count(a6),[a7].count(a7),root]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nrepeat out[0].f4 {}\nrepeat out[0].f5 {}\nrepeat out[0].f6 {}\nrepeat out[0].f7 {}\nexit\n",
  ],
  [
    "conversion-beside-object-4.tease",
    "let root={f0:1,f1:1,f2:1,f3:1}\nlet a0=root\nlet a1=root\nlet a2=root\nlet a3=root\nlet out=[toInteger(a0.f0,default:0),toInteger(a1.f0,default:0),toInteger(a2.f0,default:0),toInteger(a3.f0,default:0),root]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nexit\n",
  ],
  [
    "conversion-beside-object-8.tease",
    "let root={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1}\nlet a0=root\nlet a1=root\nlet a2=root\nlet a3=root\nlet a4=root\nlet a5=root\nlet a6=root\nlet a7=root\nlet out=[toInteger(a0.f0,default:0),toInteger(a1.f0,default:0),toInteger(a2.f0,default:0),toInteger(a3.f0,default:0),toInteger(a4.f0,default:0),toInteger(a5.f0,default:0),toInteger(a6.f0,default:0),toInteger(a7.f0,default:0),root]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nrepeat out[0].f4 {}\nrepeat out[0].f5 {}\nrepeat out[0].f6 {}\nrepeat out[0].f7 {}\nexit\n",
  ],
  ["typed-empty-4.tease", "let typed:integer[][][][]=[]\n\n\nexit\n"],
  ["typed-empty-8.tease", "let typed:integer[][][][][][][][]=[]\n\n\nexit\n"],
  ["typed-empty-copy-4.tease", "let typed:integer[][][][]=[]\nlet out=typed\n\nexit\n"],
  ["typed-empty-copy-8.tease", "let typed:integer[][][][][][][][]=[]\nlet out=typed\n\nexit\n"],
  ["typed-literal-4.tease", "let typed:integer[][][][]=[[[[1]]]]\n\n\nexit\n"],
  ["typed-literal-8.tease", "let typed:integer[][][][][][][][]=[[[[[[[[1]]]]]]]]\n\n\nexit\n"],
  [
    "typed-literal-copy-read-4.tease",
    "let typed:integer[][][][]=[[[[1]]]]\nlet out=typed\nlet got=out[0][0][0][0]\nexit\n",
  ],
  [
    "typed-literal-copy-read-8.tease",
    "let typed:integer[][][][][][][][]=[[[[[[[[1]]]]]]]]\nlet out=typed\nlet got=out[0][0][0][0][0][0][0][0]\nexit\n",
  ],
  ["typed-unwritten-literal-4.tease", "let typed=[[[[1]]]]\n\n\nexit\n"],
  ["typed-unwritten-literal-8.tease", "let typed=[[[[[[[[1]]]]]]]]\n\n\nexit\n"],
  [
    "deep-type-many-copies-4.tease",
    "let typed:integer[][][][]=hostValue\nlet out=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=hostValue\nexit\n",
  ],
  [
    "deep-type-many-copies-8.tease",
    "let typed:integer[][][][][][][][]=hostValue\nlet out=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=hostValue\nexit\n",
  ],
  [
    "deep-type-fixed-depth-copies-4.tease",
    "let typed:integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][]=hostValue\nlet out=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=hostValue\nexit\n",
  ],
  [
    "deep-type-fixed-depth-copies-8.tease",
    "let typed:integer[][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][][]=hostValue\nlet out=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=hostValue\nexit\n",
  ],
  [
    "deep-type-fixed-copies-depth-4.tease",
    "let typed:integer[][][][]=hostValue\nlet out=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=hostValue\nexit\n",
  ],
  [
    "deep-type-fixed-copies-depth-8.tease",
    "let typed:integer[][][][][][][][]=hostValue\nlet out=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=hostValue\nexit\n",
  ],
  [
    "nested-selection-variable-16.tease",
    'let seed="origin"\nlet out=[[[[[[[[[[[[[[[[seed,"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0]\nsay out\nexit\n',
  ],
  [
    "nested-choice-variable-16.tease",
    'let seed="origin"\nlet out=askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice seed),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]\nsay out\nexit\n',
  ],
  [
    "nested-selection-literal-16.tease",
    'let seed="origin"\nlet out=[[[[[[[[[[[[[[[["origin","other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0],"other"][0]\nsay out\nexit\n',
  ],
  [
    "nested-choice-literal-16.tease",
    'let seed="origin"\nlet out=askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice [(askChoice "origin"),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]),"other"]\nsay out\nexit\n',
  ],
  [
    "ring-member-stores-16.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed,f3:typed,f4:typed,f5:typed,f6:typed,f7:typed,f8:typed,f9:typed,f10:typed,f11:typed,f12:typed,f13:typed,f14:typed,f15:typed,extra:1}\nlet a0=root\na0.f0=2\nlet a1=a0\na1.f1=2\nlet a2=a1\na2.f2=2\nlet a3=a2\na3.f3=2\nlet a4=a3\na4.f4=2\nlet a5=a4\na5.f5=2\nlet a6=a5\na6.f6=2\nlet a7=a6\na7.f7=2\nlet a8=a7\na8.f8=2\nlet a9=a8\na9.f9=2\nlet a10=a9\na10.f10=2\nlet a11=a10\na11.f11=2\nlet a12=a11\na12.f12=2\nlet a13=a12\na13.f13=2\nlet a14=a13\na14.f14=2\nlet a15=a14\na15.f15=2\na0=a15\nexit\n",
  ],
  [
    "self-copy-chain-16.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed,f3:typed,f4:typed,f5:typed,f6:typed,f7:typed,f8:typed,f9:typed,f10:typed,f11:typed,f12:typed,f13:typed,f14:typed,f15:typed}\nlet a0=root\na0.q=a0\nlet a1=a0\na1.q=a1\nlet a2=a1\na2.q=a2\nlet a3=a2\na3.q=a3\nlet a4=a3\na4.q=a4\nlet a5=a4\na5.q=a5\nlet a6=a5\na6.q=a6\nlet a7=a6\na7.q=a7\nlet a8=a7\na8.q=a8\nlet a9=a8\na9.q=a9\nlet a10=a9\na10.q=a10\nlet a11=a10\na11.q=a11\nlet a12=a11\na12.q=a12\nlet a13=a12\na13.q=a13\nlet a14=a13\na14.q=a14\nlet a15=a14\na15.q=a15\nexit\n",
  ],
  [
    "deep-wrapper-reads-16.tease",
    "let typed:integer=1\nlet root={f:typed,q:null}\nlet a0={q:root}\nlet a1={q:a0}\nlet a2={q:a1}\nlet a3={q:a2}\nlet a4={q:a3}\nlet a5={q:a4}\nlet a6={q:a5}\nlet a7={q:a6}\nlet a8={q:a7}\nlet a9={q:a8}\nlet a10={q:a9}\nlet a11={q:a10}\nlet a12={q:a11}\nlet a13={q:a12}\nlet a14={q:a13}\nlet a15={q:a14}\nlet out=a15.q.q.q.q.q.q.q.q.q.q.q.q.q.q.q.q.f\nexit\n",
  ],
  [
    "chain-same-property-written-16.tease",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,extra:1}\nlet a0=root\na0.extra=2\nlet a1=a0\na1.extra=2\nlet a2=a1\na2.extra=2\nlet a3=a2\na3.extra=2\nlet a4=a3\na4.extra=2\nlet a5=a4\na5.extra=2\nlet a6=a5\na6.extra=2\nlet a7=a6\na7.extra=2\nlet a8=a7\na8.extra=2\nlet a9=a8\na9.extra=2\nlet a10=a9\na10.extra=2\nlet a11=a10\na11.extra=2\nlet a12=a11\na12.extra=2\nlet a13=a12\na13.extra=2\nlet a14=a13\na14.extra=2\nlet a15=a14\na15.extra=2\nexit\n",
  ],
  [
    "gets-in-literal-unknown-16.tease",
    "let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1], f4: [1, raw][1], f5: [1, raw][1], f6: [1, raw][1], f7: [1, raw][1], f8: [1, raw][1], f9: [1, raw][1], f10: [1, raw][1], f11: [1, raw][1], f12: [1, raw][1], f13: [1, raw][1], f14: [1, raw][1], f15: [1, raw][1]}\nlet xs = [root]\nlet box = [xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root), xs.get(0, default: root)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nrepeat box[0].f4 {}\nrepeat box[0].f5 {}\nrepeat box[0].f6 {}\nrepeat box[0].f7 {}\nrepeat box[0].f8 {}\nrepeat box[0].f9 {}\nrepeat box[0].f10 {}\nrepeat box[0].f11 {}\nrepeat box[0].f12 {}\nrepeat box[0].f13 {}\nrepeat box[0].f14 {}\nrepeat box[0].f15 {}\nexit\n",
  ],
  [
    "alias-choices-unknown-16.tease",
    'let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1], f4: [1, raw][1], f5: [1, raw][1], f6: [1, raw][1], f7: [1, raw][1], f8: [1, raw][1], f9: [1, raw][1], f10: [1, raw][1], f11: [1, raw][1], f12: [1, raw][1], f13: [1, raw][1], f14: [1, raw][1], f15: [1, raw][1]}\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet alias4 = root\nlet alias5 = root\nlet alias6 = root\nlet alias7 = root\nlet alias8 = root\nlet alias9 = root\nlet alias10 = root\nlet alias11 = root\nlet alias12 = root\nlet alias13 = root\nlet alias14 = root\nlet alias15 = root\nlet box = askChoice {text: "0", value: alias0}, {text: "1", value: alias1}, {text: "2", value: alias2}, {text: "3", value: alias3}, {text: "4", value: alias4}, {text: "5", value: alias5}, {text: "6", value: alias6}, {text: "7", value: alias7}, {text: "8", value: alias8}, {text: "9", value: alias9}, {text: "10", value: alias10}, {text: "11", value: alias11}, {text: "12", value: alias12}, {text: "13", value: alias13}, {text: "14", value: alias14}, {text: "15", value: alias15}\nrepeat box.f0 {}\nrepeat box.f1 {}\nrepeat box.f2 {}\nrepeat box.f3 {}\nrepeat box.f4 {}\nrepeat box.f5 {}\nrepeat box.f6 {}\nrepeat box.f7 {}\nrepeat box.f8 {}\nrepeat box.f9 {}\nrepeat box.f10 {}\nrepeat box.f11 {}\nrepeat box.f12 {}\nrepeat box.f13 {}\nrepeat box.f14 {}\nrepeat box.f15 {}\nexit\n',
  ],
  [
    "alias-gets-unknown-16.tease",
    "let raw = hostValue\nlet root = {f0: [1, raw][1], f1: [1, raw][1], f2: [1, raw][1], f3: [1, raw][1], f4: [1, raw][1], f5: [1, raw][1], f6: [1, raw][1], f7: [1, raw][1], f8: [1, raw][1], f9: [1, raw][1], f10: [1, raw][1], f11: [1, raw][1], f12: [1, raw][1], f13: [1, raw][1], f14: [1, raw][1], f15: [1, raw][1]}\nlet xs = [root]\nlet alias0 = root\nlet alias1 = root\nlet alias2 = root\nlet alias3 = root\nlet alias4 = root\nlet alias5 = root\nlet alias6 = root\nlet alias7 = root\nlet alias8 = root\nlet alias9 = root\nlet alias10 = root\nlet alias11 = root\nlet alias12 = root\nlet alias13 = root\nlet alias14 = root\nlet alias15 = root\nlet list0 = xs\nlet list1 = xs\nlet list2 = xs\nlet list3 = xs\nlet list4 = xs\nlet list5 = xs\nlet list6 = xs\nlet list7 = xs\nlet list8 = xs\nlet list9 = xs\nlet list10 = xs\nlet list11 = xs\nlet list12 = xs\nlet list13 = xs\nlet list14 = xs\nlet list15 = xs\nlet box = [list0.get(0, default: alias0), list1.get(0, default: alias1), list2.get(0, default: alias2), list3.get(0, default: alias3), list4.get(0, default: alias4), list5.get(0, default: alias5), list6.get(0, default: alias6), list7.get(0, default: alias7), list8.get(0, default: alias8), list9.get(0, default: alias9), list10.get(0, default: alias10), list11.get(0, default: alias11), list12.get(0, default: alias12), list13.get(0, default: alias13), list14.get(0, default: alias14), list15.get(0, default: alias15)]\nrepeat box[0].f0 {}\nrepeat box[0].f1 {}\nrepeat box[0].f2 {}\nrepeat box[0].f3 {}\nrepeat box[0].f4 {}\nrepeat box[0].f5 {}\nrepeat box[0].f6 {}\nrepeat box[0].f7 {}\nrepeat box[0].f8 {}\nrepeat box[0].f9 {}\nrepeat box[0].f10 {}\nrepeat box[0].f11 {}\nrepeat box[0].f12 {}\nrepeat box[0].f13 {}\nrepeat box[0].f14 {}\nrepeat box[0].f15 {}\nexit\n",
  ],
  [
    "host-object-property-projection-16.tease",
    "let seed={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1}\nlet out=[({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s,({g:hostValue,s:seed}).s]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nrepeat out[0].f4 {}\nrepeat out[0].f5 {}\nrepeat out[0].f6 {}\nrepeat out[0].f7 {}\nrepeat out[0].f8 {}\nrepeat out[0].f9 {}\nrepeat out[0].f10 {}\nrepeat out[0].f11 {}\nrepeat out[0].f12 {}\nrepeat out[0].f13 {}\nrepeat out[0].f14 {}\nrepeat out[0].f15 {}\nexit\n",
  ],
  [
    "load-add-host-default-16.tease",
    'let raw=hostValue\nlet seed={f0:[1,raw][1],f1:[1,raw][1],f2:[1,raw][1],f3:[1,raw][1],f4:[1,raw][1],f5:[1,raw][1],f6:[1,raw][1],f7:[1,raw][1],f8:[1,raw][1],f9:[1,raw][1],f10:[1,raw][1],f11:[1,raw][1],f12:[1,raw][1],f13:[1,raw][1],f14:[1,raw][1],f15:[1,raw][1]}\nlet xs=[]\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nxs.add(load("saved",default:seed))\nrepeat xs.last.f0 {}\nrepeat xs.last.f1 {}\nrepeat xs.last.f2 {}\nrepeat xs.last.f3 {}\nrepeat xs.last.f4 {}\nrepeat xs.last.f5 {}\nrepeat xs.last.f6 {}\nrepeat xs.last.f7 {}\nrepeat xs.last.f8 {}\nrepeat xs.last.f9 {}\nrepeat xs.last.f10 {}\nrepeat xs.last.f11 {}\nrepeat xs.last.f12 {}\nrepeat xs.last.f13 {}\nrepeat xs.last.f14 {}\nrepeat xs.last.f15 {}\nexit\n',
  ],
  [
    "parse-add-host-default-16.tease",
    'let raw=hostValue\nlet seed={f0:[1,raw][1],f1:[1,raw][1],f2:[1,raw][1],f3:[1,raw][1],f4:[1,raw][1],f5:[1,raw][1],f6:[1,raw][1],f7:[1,raw][1],f8:[1,raw][1],f9:[1,raw][1],f10:[1,raw][1],f11:[1,raw][1],f12:[1,raw][1],f13:[1,raw][1],f14:[1,raw][1],f15:[1,raw][1]}\nlet xs=[]\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nxs.add(fromJson("{}",default:seed,files:false))\nrepeat xs.last.f0 {}\nrepeat xs.last.f1 {}\nrepeat xs.last.f2 {}\nrepeat xs.last.f3 {}\nrepeat xs.last.f4 {}\nrepeat xs.last.f5 {}\nrepeat xs.last.f6 {}\nrepeat xs.last.f7 {}\nrepeat xs.last.f8 {}\nrepeat xs.last.f9 {}\nrepeat xs.last.f10 {}\nrepeat xs.last.f11 {}\nrepeat xs.last.f12 {}\nrepeat xs.last.f13 {}\nrepeat xs.last.f14 {}\nrepeat xs.last.f15 {}\nexit\n',
  ],
  [
    "nested-preset-control-16.tease",
    'let initial={nest:{p0:0,p1:0,p2:0,p3:0,p4:0,p5:0,p6:0,p7:0,p8:0,p9:0,p10:0,p11:0,p12:0,p13:0,p14:0,p15:0}}\nlet state=initial\nlet c0=initial\nc0.nest.p0="bad"\nif hostValue {state=c0}\nlet c1=initial\nc1.nest.p1="bad"\nif hostValue {state=c1}\nlet c2=initial\nc2.nest.p2="bad"\nif hostValue {state=c2}\nlet c3=initial\nc3.nest.p3="bad"\nif hostValue {state=c3}\nlet c4=initial\nc4.nest.p4="bad"\nif hostValue {state=c4}\nlet c5=initial\nc5.nest.p5="bad"\nif hostValue {state=c5}\nlet c6=initial\nc6.nest.p6="bad"\nif hostValue {state=c6}\nlet c7=initial\nc7.nest.p7="bad"\nif hostValue {state=c7}\nlet c8=initial\nc8.nest.p8="bad"\nif hostValue {state=c8}\nlet c9=initial\nc9.nest.p9="bad"\nif hostValue {state=c9}\nlet c10=initial\nc10.nest.p10="bad"\nif hostValue {state=c10}\nlet c11=initial\nc11.nest.p11="bad"\nif hostValue {state=c11}\nlet c12=initial\nc12.nest.p12="bad"\nif hostValue {state=c12}\nlet c13=initial\nc13.nest.p13="bad"\nif hostValue {state=c13}\nlet c14=initial\nc14.nest.p14="bad"\nif hostValue {state=c14}\nlet c15=initial\nc15.nest.p15="bad"\nif hostValue {state=c15}\nlet sink0:integer=state.nest.p0\nlet sink1:integer=state.nest.p1\nlet sink2:integer=state.nest.p2\nlet sink3:integer=state.nest.p3\nlet sink4:integer=state.nest.p4\nlet sink5:integer=state.nest.p5\nlet sink6:integer=state.nest.p6\nlet sink7:integer=state.nest.p7\nlet sink8:integer=state.nest.p8\nlet sink9:integer=state.nest.p9\nlet sink10:integer=state.nest.p10\nlet sink11:integer=state.nest.p11\nlet sink12:integer=state.nest.p12\nlet sink13:integer=state.nest.p13\nlet sink14:integer=state.nest.p14\nlet sink15:integer=state.nest.p15\nexit\n',
  ],
  [
    "declared-method-beside-object-16.tease",
    "let root={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1}\nlet a0=root\nlet a1=root\nlet a2=root\nlet a3=root\nlet a4=root\nlet a5=root\nlet a6=root\nlet a7=root\nlet a8=root\nlet a9=root\nlet a10=root\nlet a11=root\nlet a12=root\nlet a13=root\nlet a14=root\nlet a15=root\nlet out=[[a0].count(a0),[a1].count(a1),[a2].count(a2),[a3].count(a3),[a4].count(a4),[a5].count(a5),[a6].count(a6),[a7].count(a7),[a8].count(a8),[a9].count(a9),[a10].count(a10),[a11].count(a11),[a12].count(a12),[a13].count(a13),[a14].count(a14),[a15].count(a15),root]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nrepeat out[0].f4 {}\nrepeat out[0].f5 {}\nrepeat out[0].f6 {}\nrepeat out[0].f7 {}\nrepeat out[0].f8 {}\nrepeat out[0].f9 {}\nrepeat out[0].f10 {}\nrepeat out[0].f11 {}\nrepeat out[0].f12 {}\nrepeat out[0].f13 {}\nrepeat out[0].f14 {}\nrepeat out[0].f15 {}\nexit\n",
  ],
  [
    "conversion-beside-object-16.tease",
    "let root={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1}\nlet a0=root\nlet a1=root\nlet a2=root\nlet a3=root\nlet a4=root\nlet a5=root\nlet a6=root\nlet a7=root\nlet a8=root\nlet a9=root\nlet a10=root\nlet a11=root\nlet a12=root\nlet a13=root\nlet a14=root\nlet a15=root\nlet out=[toInteger(a0.f0,default:0),toInteger(a1.f0,default:0),toInteger(a2.f0,default:0),toInteger(a3.f0,default:0),toInteger(a4.f0,default:0),toInteger(a5.f0,default:0),toInteger(a6.f0,default:0),toInteger(a7.f0,default:0),toInteger(a8.f0,default:0),toInteger(a9.f0,default:0),toInteger(a10.f0,default:0),toInteger(a11.f0,default:0),toInteger(a12.f0,default:0),toInteger(a13.f0,default:0),toInteger(a14.f0,default:0),toInteger(a15.f0,default:0),root]\nrepeat out[0].f0 {}\nrepeat out[0].f1 {}\nrepeat out[0].f2 {}\nrepeat out[0].f3 {}\nrepeat out[0].f4 {}\nrepeat out[0].f5 {}\nrepeat out[0].f6 {}\nrepeat out[0].f7 {}\nrepeat out[0].f8 {}\nrepeat out[0].f9 {}\nrepeat out[0].f10 {}\nrepeat out[0].f11 {}\nrepeat out[0].f12 {}\nrepeat out[0].f13 {}\nrepeat out[0].f14 {}\nrepeat out[0].f15 {}\nexit\n",
  ],
  ["typed-empty-16.tease", "let typed:integer[][][][][][][][][][][][][][][][]=[]\n\n\nexit\n"],
  [
    "typed-empty-copy-16.tease",
    "let typed:integer[][][][][][][][][][][][][][][][]=[]\nlet out=typed\n\nexit\n",
  ],
  [
    "typed-literal-16.tease",
    "let typed:integer[][][][][][][][][][][][][][][][]=[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]\n\n\nexit\n",
  ],
  [
    "typed-literal-copy-read-16.tease",
    "let typed:integer[][][][][][][][][][][][][][][][]=[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]\nlet out=typed\nlet got=out[0][0][0][0][0][0][0][0][0][0][0][0][0][0][0][0]\nexit\n",
  ],
  ["typed-unwritten-literal-16.tease", "let typed=[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]\n\n\nexit\n"],
  [
    "deep-type-many-copies-16.tease",
    "let typed:integer[][][][][][][][][][][][][][][][]=hostValue\nlet out=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=typed\nout=hostValue\nexit\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "node --expose-gc probe.mjs quick",
      "R/sol-m4-admission-recon-r1-evidence/build-and-quick.sh:8",
    ],
    [
      "env RECON_TRACE=1 node --expose-gc --import ./instrumentation.mjs probe.mjs attribution",
      "R/sol-m4-admission-recon-r1-evidence/commands.md:26",
    ],
    [
      "env RECON_TRACE=1 node --expose-gc --import ./instrumentation.mjs probe.mjs setup-attribution",
      "R/sol-m4-admission-recon-r1-evidence/commands.md:29",
    ],
  ],
  sources: 83,
  sha256: "5e0f1ad5941da96529303dc5dd9e4eb22452ae915bfdf94b8769e2e1307372eb",
};
