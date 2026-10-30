// #1188's design r1: Astra's F1 cases (`astra-cases.mjs`: 5 written types, 5 values, 16 forms, the deduplicated forms
// and a three-file project) and the two `b1.mjs` adds, run by `b1.mjs astra` (/tmp/agent-work/o4-m4-f1/probe/; copy
// kept in desktop:~/work/evidence/1463/retained/).
export const cases = [
  [
    "astra::forward-projection/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=8\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:8,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=8\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=8\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=8\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=8 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=8\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=8\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=8\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=8\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=8\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer/8",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=8\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=2.5\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:2.5,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=2.5\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=2.5\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=2.5\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=2.5 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=2.5\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=2.5\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=2.5\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=2.5\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=2.5\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer/2.5",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=2.5\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    'astra::forward-projection/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n="bad"\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    'astra::local-above/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:"bad",keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-below/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n="bad"\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::two-root-forward/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::whole-cycle-local/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n="bad"\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    'astra::path-cycle-local/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n="bad"\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::two-fed-cycle/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::guarded-replacement/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n="bad" }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    'astra::guarded-join/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    'astra::snapshot-local/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n="bad"\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::list-copy/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n="bad"\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-then-landing/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n="bad"\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::duplicates/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    'astra::defaults/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n="bad"\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::default-null-word/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n="bad"\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    'astra::read-operation/integer/"bad"',
    'let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n="bad"\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::forward-projection/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=null\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:null,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=null\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=null\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=null\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=null }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=null\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=null\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=null\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=null\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=null\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer/null",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=null\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=hostValue\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:hostValue,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=hostValue\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=hostValue\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=hostValue\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=hostValue }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=hostValue\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=hostValue\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=hostValue\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=hostValue\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=hostValue\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer/hostValue",
    "let t:integer=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=hostValue\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=8\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:8,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=8\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=8\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=8\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=8 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=8\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=8\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=8\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=8\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=8\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer?/8",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=8\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=2.5\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:2.5,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=2.5\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=2.5\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=2.5\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=2.5 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=2.5\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=2.5\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=2.5\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=2.5\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=2.5\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer?/2.5",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=2.5\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    'astra::forward-projection/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n="bad"\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    'astra::local-above/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:"bad",keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-below/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n="bad"\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::two-root-forward/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::whole-cycle-local/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n="bad"\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    'astra::path-cycle-local/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n="bad"\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::two-fed-cycle/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::guarded-replacement/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n="bad" }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    'astra::guarded-join/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    'astra::snapshot-local/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n="bad"\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::list-copy/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n="bad"\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-then-landing/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n="bad"\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::duplicates/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    'astra::defaults/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n="bad"\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::default-null-word/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n="bad"\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    'astra::read-operation/integer?/"bad"',
    'let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n="bad"\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::forward-projection/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=null\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:null,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=null\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=null\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=null\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=null }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=null\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=null\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=null\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=null\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=null\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer?/null",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=null\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=hostValue\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:hostValue,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=hostValue\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=hostValue\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=hostValue\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=hostValue }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=hostValue\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=hostValue\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=hostValue\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=hostValue\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=hostValue\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer?/hostValue",
    "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=hostValue\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=8\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:8,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=8\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=8\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=8\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=8 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=8\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=8\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=8\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=8\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=8\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer | string/8",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=8\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=2.5\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:2.5,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=2.5\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=2.5\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=2.5\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=2.5 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=2.5\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=2.5\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=2.5\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=2.5\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=2.5\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer | string/2.5",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=2.5\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    'astra::forward-projection/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n="bad"\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    'astra::local-above/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:"bad",keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-below/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n="bad"\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::two-root-forward/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::whole-cycle-local/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n="bad"\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    'astra::path-cycle-local/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n="bad"\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::two-fed-cycle/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::guarded-replacement/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n="bad" }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    'astra::guarded-join/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    'astra::snapshot-local/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n="bad"\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::list-copy/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n="bad"\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-then-landing/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n="bad"\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::duplicates/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    'astra::defaults/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n="bad"\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::default-null-word/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n="bad"\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    'astra::read-operation/integer | string/"bad"',
    'let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n="bad"\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::forward-projection/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=null\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:null,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=null\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=null\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=null\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=null }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=null\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=null\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=null\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=null\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=null\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer | string/null",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=null\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=hostValue\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:hostValue,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=hostValue\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=hostValue\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=hostValue\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=hostValue }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=hostValue\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=hostValue\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=hostValue\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=hostValue\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=hostValue\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/integer | string/hostValue",
    "let t:integer | string=7\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=hostValue\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=8\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    "astra::local-above/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:8,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::local-below/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=8\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::two-root-forward/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::whole-cycle-local/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=8\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    "astra::path-cycle-local/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=8\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::two-fed-cycle/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    "astra::guarded-replacement/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=8 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    "astra::guarded-join/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    "astra::snapshot-local/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=8\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    "astra::list-copy/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=8\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::local-then-landing/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=8\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::duplicates/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    "astra::defaults/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=8\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::default-null-word/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=8\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    "astra::read-operation/string/8",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=8\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::forward-projection/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=2.5\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    "astra::local-above/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:2.5,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::local-below/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=2.5\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::two-root-forward/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::whole-cycle-local/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=2.5\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    "astra::path-cycle-local/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=2.5\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::two-fed-cycle/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    "astra::guarded-replacement/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=2.5 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    "astra::guarded-join/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    "astra::snapshot-local/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=2.5\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    "astra::list-copy/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=2.5\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::local-then-landing/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=2.5\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::duplicates/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    "astra::defaults/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=2.5\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::default-null-word/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=2.5\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    "astra::read-operation/string/2.5",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=2.5\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::forward-projection/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n="bad"\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    'astra::local-above/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:"bad",keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-below/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n="bad"\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::two-root-forward/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::whole-cycle-local/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n="bad"\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    'astra::path-cycle-local/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n="bad"\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::two-fed-cycle/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::guarded-replacement/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n="bad" }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    'astra::guarded-join/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    'astra::snapshot-local/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n="bad"\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::list-copy/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n="bad"\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-then-landing/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n="bad"\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::duplicates/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    'astra::defaults/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n="bad"\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::default-null-word/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n="bad"\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    'astra::read-operation/string/"bad"',
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n="bad"\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::forward-projection/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=null\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    "astra::local-above/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:null,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::local-below/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=null\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::two-root-forward/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::whole-cycle-local/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=null\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    "astra::path-cycle-local/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=null\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::two-fed-cycle/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    "astra::guarded-replacement/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=null }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    "astra::guarded-join/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    "astra::snapshot-local/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=null\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    "astra::list-copy/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=null\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::local-then-landing/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=null\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::duplicates/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    "astra::defaults/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=null\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::default-null-word/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=null\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    "astra::read-operation/string/null",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=null\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::forward-projection/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=hostValue\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    "astra::local-above/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:hostValue,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::local-below/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=hostValue\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::two-root-forward/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::whole-cycle-local/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=hostValue\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    "astra::path-cycle-local/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=hostValue\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::two-fed-cycle/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    "astra::guarded-replacement/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=hostValue }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    "astra::guarded-join/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    "astra::snapshot-local/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=hostValue\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    "astra::list-copy/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=hostValue\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    "astra::local-then-landing/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=hostValue\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::duplicates/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    "astra::defaults/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=hostValue\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::default-null-word/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=hostValue\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    "astra::read-operation/string/hostValue",
    'let t:string="ok"\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=hostValue\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::forward-projection/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=8\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:8,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=8\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=8\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=8\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=8 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=8\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=8\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=8\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:8,nest:{n:8,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=8\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=8\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/null/8",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=8\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=2.5\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:2.5,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=2.5\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=2.5\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=2.5\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=2.5 }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=2.5\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=2.5\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=2.5\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=2.5\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=2.5\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/null/2.5",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=2.5\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    'astra::forward-projection/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n="bad"\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n',
  ],
  [
    'astra::local-above/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:"bad",keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-below/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n="bad"\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::two-root-forward/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::whole-cycle-local/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n="bad"\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n',
  ],
  [
    'astra::path-cycle-local/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n="bad"\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::two-fed-cycle/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::guarded-replacement/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n="bad" }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n',
  ],
  [
    'astra::guarded-join/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n',
  ],
  [
    'astra::snapshot-local/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n="bad"\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n',
  ],
  [
    'astra::list-copy/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n="bad"\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n',
  ],
  [
    'astra::local-then-landing/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n="bad"\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::duplicates/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:"bad",nest:{n:"bad",keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n',
  ],
  [
    'astra::defaults/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n="bad"\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    'astra::default-null-word/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n="bad"\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n',
  ],
  [
    'astra::read-operation/null/"bad"',
    'let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n="bad"\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n',
  ],
  [
    "astra::forward-projection/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=null\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:null,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=null\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=null\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=null\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=null }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=null\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=null\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=null\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:null,nest:{n:null,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=null\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=null\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/null/null",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=null\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::forward-projection/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet box={left:root}\nlet twin={right:box.left}\nlet a=twin.right\na.nest.n=hostValue\nlet out={selected:a.nest}\nrepeat out.selected.n {}\nexit\n",
  ],
  [
    "astra::local-above/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\na.nest={n:hostValue,keep:1}\nlet c={p:a}\nlet d=c.p\nlet out=[b,d]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-below/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\na.nest.n=hostValue\nlet b=a\nb.n=8\nlet c={p:b}\nlet out=[root,c.p]\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::two-root-forward/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet left={a:root}\nlet right={b:other}\nlet a=left.a\nlet b=right.b\na=b\nlet out=a\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::whole-cycle-local/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b=a\nlet c=b\nb=c\na=b\nc.nest.n=hostValue\nlet out={p:a}\nrepeat out.p.nest.n {}\nexit\n",
  ],
  [
    "astra::path-cycle-local/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet wrap={slot:a}\na=wrap.slot\nwrap.slot.nest.n=hostValue\nlet out=wrap.slot\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::two-fed-cycle/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nlet b=a\na=b\nb=other\nlet out=[a,b]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::guarded-replacement/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nif hostValue != null { a.nest.n=hostValue }\nlet b={x:a}\nlet c=b.x\nif c != null { let out=[root,c]\nrepeat out[0].nest.n {} }\nexit\n",
  ],
  [
    "astra::guarded-join/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
  ],
  [
    "astra::snapshot-local/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet old=a.nest\na.nest.n=hostValue\nlet fresh=a.nest\nlet out=[old,fresh]\nrepeat out[0].n {}\nexit\n",
  ],
  [
    "astra::list-copy/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=[root]\nlet b=a\nb[0].nest.n=hostValue\nlet c={list:b}\nlet out=c.list\nrepeat out[0].nest.n {}\nexit\n",
  ],
  [
    "astra::local-then-landing/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet plain={n:1,nest:{n:1,keep:1},spare:1}\nlet a=plain\na.nest.n=hostValue\nlet b=a\nlet out=root\nout=b\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::duplicates/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:hostValue,nest:{n:hostValue,keep:1},spare:1}\nlet a=[root,root,other,root]\nlet b=[root,other,root,root]\nlet out=[a,b]\nrepeat out[0][0].n {}\nexit\n",
  ],
  [
    "astra::defaults/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=root) { let a=arg\na.nest.n=hostValue\nreturn a }\nlet out=make()\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::default-null-word/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nfunction make(arg=null) { let a=arg\na=root\nreturn a }\nlet out=make()\nout.nest.n=hostValue\nlet z=out.nest.n otherwise 1\nrepeat z {}\nexit\n",
  ],
  [
    "astra::read-operation/null/hostValue",
    "let t:null=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet a=root\nlet b={p:a}\nb.p.nest.n=hostValue\nlet out=[b.p,root].get(0, default: root)\nrepeat out.nest.n {}\nexit\n",
  ],
  [
    "astra::dedup/2/false",
    "let t:integer=1\nlet r0={same:t,nest:{same:t}}\nlet r1={same:t,nest:{same:t}}\nlet raw={same:1,nest:{same:hostValue}}\nlet a=[r0,r1,r0,r1]\nlet b=[r1,r0]\nrepeat a[0].nest.same {}\nrepeat b[0].nest.same {}\nexit\n",
  ],
  [
    "astra::dedup/2/true",
    "let t:integer=1\nlet r0={same:t,nest:{same:t}}\nlet r1={same:t,nest:{same:t}}\nlet raw={same:1,nest:{same:hostValue}}\nlet a=[r0,r1,r0,r1,raw]\nlet b=[raw,r1,r0]\nrepeat a[0].nest.same {}\nrepeat b[0].nest.same {}\nexit\n",
  ],
  [
    "astra::dedup/3/false",
    "let t:integer=1\nlet r0={same:t,nest:{same:t}}\nlet r1={same:t,nest:{same:t}}\nlet r2={same:t,nest:{same:t}}\nlet raw={same:1,nest:{same:hostValue}}\nlet a=[r0,r1,r2,r0,r1,r2]\nlet b=[r2,r1,r0]\nrepeat a[0].nest.same {}\nrepeat b[0].nest.same {}\nexit\n",
  ],
  [
    "astra::dedup/3/true",
    "let t:integer=1\nlet r0={same:t,nest:{same:t}}\nlet r1={same:t,nest:{same:t}}\nlet r2={same:t,nest:{same:t}}\nlet raw={same:1,nest:{same:hostValue}}\nlet a=[r0,r1,r2,r0,r1,r2,raw]\nlet b=[raw,r2,r1,r0]\nrepeat a[0].nest.same {}\nrepeat b[0].nest.same {}\nexit\n",
  ],
  [
    "astra::dedup/5/false",
    "let t:integer=1\nlet r0={same:t,nest:{same:t}}\nlet r1={same:t,nest:{same:t}}\nlet r2={same:t,nest:{same:t}}\nlet r3={same:t,nest:{same:t}}\nlet r4={same:t,nest:{same:t}}\nlet raw={same:1,nest:{same:hostValue}}\nlet a=[r0,r1,r2,r3,r4,r0,r1,r2,r3,r4]\nlet b=[r4,r3,r2,r1,r0]\nrepeat a[0].nest.same {}\nrepeat b[0].nest.same {}\nexit\n",
  ],
  [
    "astra::dedup/5/true",
    "let t:integer=1\nlet r0={same:t,nest:{same:t}}\nlet r1={same:t,nest:{same:t}}\nlet r2={same:t,nest:{same:t}}\nlet r3={same:t,nest:{same:t}}\nlet r4={same:t,nest:{same:t}}\nlet raw={same:1,nest:{same:hostValue}}\nlet a=[r0,r1,r2,r3,r4,r0,r1,r2,r3,r4,raw]\nlet b=[raw,r4,r3,r2,r1,r0]\nrepeat a[0].nest.same {}\nrepeat b[0].nest.same {}\nexit\n",
  ],
  [
    "astra::project-file-order",
    [
      { path: "z.tease", source: "let z:integer=hostValue\nrepeat hostValue {}\nexit\n" },
      { path: "a.tease", source: "let a:integer=hostValue\nrepeat hostValue {}\nexit\n" },
      { path: "main.tease", source: "let m:integer=hostValue\nrepeat hostValue {}\nexit\n" },
    ],
  ],
  [
    "astra::one-field",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[root,other]\nexit\n',
  ],
  [
    "astra::reverse-items",
    'let t:string="ok"\nlet root={spare:t}\nlet other={spare:1}\nlet a=[other,root]\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    ["node b1.mjs astra $H/main-c1d $H/proto9", "/tmp/agent-work/o4-m4-i1188/design-r1.md:438"],
  ],
  sources: 409,
  sha256: "ebf4186b825995e14aa2937ca9195a2f7bd8ee4e57bda00e096fcaaa5ca7aaf5",
};
