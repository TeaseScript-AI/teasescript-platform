// #1188's builder, round 5: the cycles of its `gen/cycles.py` (whole cycles of two and three, integer, text and unseeded
// members, ring, back and full edges, direct, projected, place and read consumers, and fed controls), as
// `cases/cycles.json` holds them, analysed by `probe/keptseq2.mjs` (/tmp/agent-work/o4-m4-i1188-r5/; copy kept in
// desktop:~/work/evidence/1463/retained/).
export const cases = [
  [
    "cycles::whole/2/integer-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nm1.g=2\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nm1.g=2\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nm1.g=2\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/2/integer-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nexit\n',
  ],
  [
    "cycles::whole/2/string-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nm1.g=2\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/2/string-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nexit\n',
  ],
  [
    "cycles::whole/2/string-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nm1.g=2\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/2/string-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nexit\n',
  ],
  [
    "cycles::whole/2/string-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nm1.g=2\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/string-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/2/string-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nm1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nexit\n',
  ],
  [
    "cycles::whole/2/none-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/2/none-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/none-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nm1.g=2\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/none-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/2/none-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nm1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nexit\n',
  ],
  [
    "cycles::whole/2/none-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/2/none-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/none-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nm1.g=2\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/2/none-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/2/none-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nm1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-integer-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-string-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/integer-none-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vi,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-integer-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-string-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/string-none-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:vs,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-integer-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vi,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-string-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:vs,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-integer/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vi,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-string/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:vs,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/ring/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/ring/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/ring/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/ring/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/ring/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/back/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/back/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/back/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/back/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/back/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm0=m1\nm1=m2\nm2=m0\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/full/direct",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet final=[m0,m1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/full/projected",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/full/projected/own",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nm1.g=2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/full/place",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet sink=m1\nsink=m0\nlet probe=[sink,{f:true,g:0}]\nexit\n',
  ],
  [
    "cycles::whole/3/none-none-none/full/read",
    'let vi:integer=23\nlet vs:string="s"\nlet m0={f:1.5,g:0}\nlet m1={f:1.5,g:0}\nlet m2={f:1.5,g:0}\nm1=m0\nm2=m0\nm0=m1\nm2=m1\nm0=m2\nm1=m2\nlet r=[m0.f,m2.f]\nexit\n',
  ],
  [
    "cycles::fed/2/live/none/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nlet final=[m0,m1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/live/none/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/live/none/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/live/member/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1={f:"wrong",g:"s"}\nlet final=[m0,m1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/live/member/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1={f:"wrong",g:"s"}\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/live/member/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1={f:"wrong",g:"s"}\nlet r=[m0.f,m1.f]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/live/edge/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1.f="wrong"\nlet final=[m0,m1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/live/edge/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1.f="wrong"\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/live/edge/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1.f="wrong"\nlet r=[m0.f,m1.f]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/none/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nlet final=[m0,m1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/none/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/none/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nlet r=[m0.f,m1.f]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/member/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1={f:"wrong",g:"s"}\nlet final=[m0,m1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/member/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1={f:"wrong",g:"s"}\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/member/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1={f:"wrong",g:"s"}\nlet r=[m0.f,m1.f]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/edge/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1.f="wrong"\nlet final=[m0,m1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/edge/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1.f="wrong"\nlet box={k0:m0,k1:m1}\nlet final=[box.k0,box.k1]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/2/dead/edge/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nm0=m1\nm1.f="wrong"\nlet r=[m0.f,m1.f]\nlet tail=[other,m1]\nexit\n',
  ],
  [
    "cycles::fed/3/live/none/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nlet final=[m0,m1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/live/none/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/live/none/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/live/member/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1={f:"wrong",g:"s"}\nlet final=[m0,m1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/live/member/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1={f:"wrong",g:"s"}\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/live/member/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1={f:"wrong",g:"s"}\nlet r=[m0.f,m2.f]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/live/edge/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1.f="wrong"\nlet final=[m0,m1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/live/edge/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1.f="wrong"\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/live/edge/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1.f="wrong"\nlet r=[m0.f,m2.f]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/none/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nlet final=[m0,m1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/none/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/none/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nlet r=[m0.f,m2.f]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/member/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1={f:"wrong",g:"s"}\nlet final=[m0,m1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/member/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1={f:"wrong",g:"s"}\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/member/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1={f:"wrong",g:"s"}\nlet r=[m0.f,m2.f]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/edge/direct",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1.f="wrong"\nlet final=[m0,m1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/edge/projected",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1.f="wrong"\nlet box={k0:m0,k1:m1,k2:m2}\nlet final=[box.k0,box.k1]\nlet tail=[other,m2]\nexit\n',
  ],
  [
    "cycles::fed/3/dead/edge/read",
    'let exact:integer=19\nlet origin={f:exact,g:"s"}\nlet other={f:1.75,g:"s"}\nlet inlet=origin\ninlet=other\nlet m0=inlet\nlet m1=m0\nlet m2=m1\nm0=m2\nm1.f="wrong"\nlet r=[m0.f,m2.f]\nlet tail=[other,m2]\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'bash -c "systemd-run --user --scope --quiet --unit=i1188r5-$tag-$tree-$set-\\$\\$ -p MemoryMax=3G -p MemorySwapMax=0 timeout 3000 env $e node probe/keptseq2.mjs \\$PWD/trees/$tree cases/$set.json out/$tag-$tree-$set.jsonl > $log 2>&1; echo exit=\\$? >> $log" >/dev/null',
      "/tmp/agent-work/o4-m4-i1188-r5/probe/q2.sh:10",
    ],
  ],
  sources: 481,
  sha256: "36f1ca1c88c94c01cfca16e1df8f3e169c0abdeb03e3817a48280125997e9565",
};
