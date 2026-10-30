// #1188's design review r4 (Sol): the independent cases of its `generate.py` (128 rejection forms, 72 cycles, 12 nested
// copied-collection cells), run by its `run.mjs` (/tmp/agent-work/o4-m4-i1188-r4/sol-r4/; copy kept in
// desktop:~/work/evidence/1463/retained/). Its witness collection is earlier reviews' and is not copied.
export const cases = [
  [
    "sol-own::literal/integer/join",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{f:"bad"},src]\nlet recv=bad.first\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::literal/integer/reverse",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{f:"bad"},src]\nlet recv=bad.first\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::literal/integer/place",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{f:"bad"},src]\nlet recv=bad.first\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::literal/integer/wrapped",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{f:"bad"},src]\nlet recv=bad.first\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::add/integer/join",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{f:"bad"}]\nbad.add(src)\nlet recv=bad.first\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::add/integer/reverse",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{f:"bad"}]\nbad.add(src)\nlet recv=bad.first\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::add/integer/place",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{f:"bad"}]\nbad.add(src)\nlet recv=bad.first\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::add/integer/wrapped",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{f:"bad"}]\nbad.add(src)\nlet recv=bad.first\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::assign/integer/join",
    'let typed:integer=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::assign/integer/reverse",
    'let typed:integer=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::assign/integer/place",
    'let typed:integer=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::assign/integer/wrapped",
    'let typed:integer=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::field/integer/join",
    'let typed:integer=3\nlet src={f:typed}\nlet obj={box:{f:"bad"}}\nobj.box=src\nlet recv=obj.box\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::field/integer/reverse",
    'let typed:integer=3\nlet src={f:typed}\nlet obj={box:{f:"bad"}}\nobj.box=src\nlet recv=obj.box\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::field/integer/place",
    'let typed:integer=3\nlet src={f:typed}\nlet obj={box:{f:"bad"}}\nobj.box=src\nlet recv=obj.box\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::field/integer/wrapped",
    'let typed:integer=3\nlet src={f:typed}\nlet obj={box:{f:"bad"}}\nobj.box=src\nlet recv=obj.box\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::nestedcell/integer/join",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{box:{f:"bad"}},{box:src}]\nlet recv=bad.first.box\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::nestedcell/integer/reverse",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{box:{f:"bad"}},{box:src}]\nlet recv=bad.first.box\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::nestedcell/integer/place",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{box:{f:"bad"}},{box:src}]\nlet recv=bad.first.box\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::nestedcell/integer/wrapped",
    'let typed:integer=3\nlet src={f:typed}\nlet bad=[{box:{f:"bad"}},{box:src}]\nlet recv=bad.first.box\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::ret/integer/join",
    'let typed:integer=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:"bad"} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::ret/integer/reverse",
    'let typed:integer=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:"bad"} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::ret/integer/place",
    'let typed:integer=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:"bad"} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::ret/integer/wrapped",
    'let typed:integer=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:"bad"} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::parameter/integer/join",
    'let typed:integer=3\nlet src={f:typed}\nfunction use(x={f:"bad"}) { return x }\nlet recv=use(src)\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::parameter/integer/reverse",
    'let typed:integer=3\nlet src={f:typed}\nfunction use(x={f:"bad"}) { return x }\nlet recv=use(src)\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::parameter/integer/place",
    'let typed:integer=3\nlet src={f:typed}\nfunction use(x={f:"bad"}) { return x }\nlet recv=use(src)\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::parameter/integer/wrapped",
    'let typed:integer=3\nlet src={f:typed}\nfunction use(x={f:"bad"}) { return x }\nlet recv=use(src)\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::emptydead/integer/join",
    'let typed:integer=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::emptydead/integer/reverse",
    'let typed:integer=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::emptydead/integer/place",
    'let typed:integer=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::emptydead/integer/wrapped",
    'let typed:integer=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::literal/integer|string/join",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{f:false},src]\nlet recv=bad.first\nlet out=[recv,src]\nexit\n",
  ],
  [
    "sol-own::literal/integer|string/reverse",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{f:false},src]\nlet recv=bad.first\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::literal/integer|string/place",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{f:false},src]\nlet recv=bad.first\nlet out=recv\nout=src\nexit\n",
  ],
  [
    "sol-own::literal/integer|string/wrapped",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{f:false},src]\nlet recv=bad.first\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n",
  ],
  [
    "sol-own::add/integer|string/join",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{f:false}]\nbad.add(src)\nlet recv=bad.first\nlet out=[recv,src]\nexit\n",
  ],
  [
    "sol-own::add/integer|string/reverse",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{f:false}]\nbad.add(src)\nlet recv=bad.first\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::add/integer|string/place",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{f:false}]\nbad.add(src)\nlet recv=bad.first\nlet out=recv\nout=src\nexit\n",
  ],
  [
    "sol-own::add/integer|string/wrapped",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{f:false}]\nbad.add(src)\nlet recv=bad.first\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n",
  ],
  [
    "sol-own::assign/integer|string/join",
    "let typed:integer | string=3\nlet src={f:typed}\nlet recv={f:false}\nrecv=src\nlet out=[recv,src]\nexit\n",
  ],
  [
    "sol-own::assign/integer|string/reverse",
    "let typed:integer | string=3\nlet src={f:typed}\nlet recv={f:false}\nrecv=src\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::assign/integer|string/place",
    "let typed:integer | string=3\nlet src={f:typed}\nlet recv={f:false}\nrecv=src\nlet out=recv\nout=src\nexit\n",
  ],
  [
    "sol-own::assign/integer|string/wrapped",
    "let typed:integer | string=3\nlet src={f:typed}\nlet recv={f:false}\nrecv=src\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n",
  ],
  [
    "sol-own::field/integer|string/join",
    "let typed:integer | string=3\nlet src={f:typed}\nlet obj={box:{f:false}}\nobj.box=src\nlet recv=obj.box\nlet out=[recv,src]\nexit\n",
  ],
  [
    "sol-own::field/integer|string/reverse",
    "let typed:integer | string=3\nlet src={f:typed}\nlet obj={box:{f:false}}\nobj.box=src\nlet recv=obj.box\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::field/integer|string/place",
    "let typed:integer | string=3\nlet src={f:typed}\nlet obj={box:{f:false}}\nobj.box=src\nlet recv=obj.box\nlet out=recv\nout=src\nexit\n",
  ],
  [
    "sol-own::field/integer|string/wrapped",
    "let typed:integer | string=3\nlet src={f:typed}\nlet obj={box:{f:false}}\nobj.box=src\nlet recv=obj.box\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n",
  ],
  [
    "sol-own::nestedcell/integer|string/join",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{box:{f:false}},{box:src}]\nlet recv=bad.first.box\nlet out=[recv,src]\nexit\n",
  ],
  [
    "sol-own::nestedcell/integer|string/reverse",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{box:{f:false}},{box:src}]\nlet recv=bad.first.box\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::nestedcell/integer|string/place",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{box:{f:false}},{box:src}]\nlet recv=bad.first.box\nlet out=recv\nout=src\nexit\n",
  ],
  [
    "sol-own::nestedcell/integer|string/wrapped",
    "let typed:integer | string=3\nlet src={f:typed}\nlet bad=[{box:{f:false}},{box:src}]\nlet recv=bad.first.box\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n",
  ],
  [
    "sol-own::ret/integer|string/join",
    "let typed:integer | string=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:false} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=[recv,src]\nexit\n",
  ],
  [
    "sol-own::ret/integer|string/reverse",
    "let typed:integer | string=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:false} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::ret/integer|string/place",
    "let typed:integer | string=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:false} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=recv\nout=src\nexit\n",
  ],
  [
    "sol-own::ret/integer|string/wrapped",
    "let typed:integer | string=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:false} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n",
  ],
  [
    "sol-own::parameter/integer|string/join",
    "let typed:integer | string=3\nlet src={f:typed}\nfunction use(x={f:false}) { return x }\nlet recv=use(src)\nlet out=[recv,src]\nexit\n",
  ],
  [
    "sol-own::parameter/integer|string/reverse",
    "let typed:integer | string=3\nlet src={f:typed}\nfunction use(x={f:false}) { return x }\nlet recv=use(src)\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::parameter/integer|string/place",
    "let typed:integer | string=3\nlet src={f:typed}\nfunction use(x={f:false}) { return x }\nlet recv=use(src)\nlet out=recv\nout=src\nexit\n",
  ],
  [
    "sol-own::parameter/integer|string/wrapped",
    "let typed:integer | string=3\nlet src={f:typed}\nfunction use(x={f:false}) { return x }\nlet recv=use(src)\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n",
  ],
  [
    "sol-own::emptydead/integer|string/join",
    "let typed:integer | string=3\nlet src={f:typed}\nlet recv={f:false}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=[recv,src]\nexit\n",
  ],
  [
    "sol-own::emptydead/integer|string/reverse",
    "let typed:integer | string=3\nlet src={f:typed}\nlet recv={f:false}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::emptydead/integer|string/place",
    "let typed:integer | string=3\nlet src={f:typed}\nlet recv={f:false}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=recv\nout=src\nexit\n",
  ],
  [
    "sol-own::emptydead/integer|string/wrapped",
    "let typed:integer | string=3\nlet src={f:typed}\nlet recv={f:false}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n",
  ],
  [
    "sol-own::literal/string/join",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{f:true},src]\nlet recv=bad.first\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::literal/string/reverse",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{f:true},src]\nlet recv=bad.first\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::literal/string/place",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{f:true},src]\nlet recv=bad.first\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::literal/string/wrapped",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{f:true},src]\nlet recv=bad.first\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::add/string/join",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{f:true}]\nbad.add(src)\nlet recv=bad.first\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::add/string/reverse",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{f:true}]\nbad.add(src)\nlet recv=bad.first\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::add/string/place",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{f:true}]\nbad.add(src)\nlet recv=bad.first\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::add/string/wrapped",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{f:true}]\nbad.add(src)\nlet recv=bad.first\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::assign/string/join",
    'let typed:string="ok"\nlet src={f:typed}\nlet recv={f:true}\nrecv=src\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::assign/string/reverse",
    'let typed:string="ok"\nlet src={f:typed}\nlet recv={f:true}\nrecv=src\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::assign/string/place",
    'let typed:string="ok"\nlet src={f:typed}\nlet recv={f:true}\nrecv=src\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::assign/string/wrapped",
    'let typed:string="ok"\nlet src={f:typed}\nlet recv={f:true}\nrecv=src\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::field/string/join",
    'let typed:string="ok"\nlet src={f:typed}\nlet obj={box:{f:true}}\nobj.box=src\nlet recv=obj.box\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::field/string/reverse",
    'let typed:string="ok"\nlet src={f:typed}\nlet obj={box:{f:true}}\nobj.box=src\nlet recv=obj.box\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::field/string/place",
    'let typed:string="ok"\nlet src={f:typed}\nlet obj={box:{f:true}}\nobj.box=src\nlet recv=obj.box\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::field/string/wrapped",
    'let typed:string="ok"\nlet src={f:typed}\nlet obj={box:{f:true}}\nobj.box=src\nlet recv=obj.box\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::nestedcell/string/join",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{box:{f:true}},{box:src}]\nlet recv=bad.first.box\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::nestedcell/string/reverse",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{box:{f:true}},{box:src}]\nlet recv=bad.first.box\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::nestedcell/string/place",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{box:{f:true}},{box:src}]\nlet recv=bad.first.box\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::nestedcell/string/wrapped",
    'let typed:string="ok"\nlet src={f:typed}\nlet bad=[{box:{f:true}},{box:src}]\nlet recv=bad.first.box\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::ret/string/join",
    'let typed:string="ok"\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:true} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::ret/string/reverse",
    'let typed:string="ok"\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:true} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::ret/string/place",
    'let typed:string="ok"\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:true} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::ret/string/wrapped",
    'let typed:string="ok"\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:true} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::parameter/string/join",
    'let typed:string="ok"\nlet src={f:typed}\nfunction use(x={f:true}) { return x }\nlet recv=use(src)\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::parameter/string/reverse",
    'let typed:string="ok"\nlet src={f:typed}\nfunction use(x={f:true}) { return x }\nlet recv=use(src)\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::parameter/string/place",
    'let typed:string="ok"\nlet src={f:typed}\nfunction use(x={f:true}) { return x }\nlet recv=use(src)\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::parameter/string/wrapped",
    'let typed:string="ok"\nlet src={f:typed}\nfunction use(x={f:true}) { return x }\nlet recv=use(src)\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::emptydead/string/join",
    'let typed:string="ok"\nlet src={f:typed}\nlet recv={f:true}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::emptydead/string/reverse",
    'let typed:string="ok"\nlet src={f:typed}\nlet recv={f:true}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::emptydead/string/place",
    'let typed:string="ok"\nlet src={f:typed}\nlet recv={f:true}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::emptydead/string/wrapped",
    'let typed:string="ok"\nlet src={f:typed}\nlet recv={f:true}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::literal/integer|boolean/join",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{f:"bad"},src]\nlet recv=bad.first\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::literal/integer|boolean/reverse",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{f:"bad"},src]\nlet recv=bad.first\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::literal/integer|boolean/place",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{f:"bad"},src]\nlet recv=bad.first\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::literal/integer|boolean/wrapped",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{f:"bad"},src]\nlet recv=bad.first\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::add/integer|boolean/join",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{f:"bad"}]\nbad.add(src)\nlet recv=bad.first\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::add/integer|boolean/reverse",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{f:"bad"}]\nbad.add(src)\nlet recv=bad.first\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::add/integer|boolean/place",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{f:"bad"}]\nbad.add(src)\nlet recv=bad.first\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::add/integer|boolean/wrapped",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{f:"bad"}]\nbad.add(src)\nlet recv=bad.first\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::assign/integer|boolean/join",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::assign/integer|boolean/reverse",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::assign/integer|boolean/place",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::assign/integer|boolean/wrapped",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::field/integer|boolean/join",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet obj={box:{f:"bad"}}\nobj.box=src\nlet recv=obj.box\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::field/integer|boolean/reverse",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet obj={box:{f:"bad"}}\nobj.box=src\nlet recv=obj.box\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::field/integer|boolean/place",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet obj={box:{f:"bad"}}\nobj.box=src\nlet recv=obj.box\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::field/integer|boolean/wrapped",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet obj={box:{f:"bad"}}\nobj.box=src\nlet recv=obj.box\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::nestedcell/integer|boolean/join",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{box:{f:"bad"}},{box:src}]\nlet recv=bad.first.box\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::nestedcell/integer|boolean/reverse",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{box:{f:"bad"}},{box:src}]\nlet recv=bad.first.box\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::nestedcell/integer|boolean/place",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{box:{f:"bad"}},{box:src}]\nlet recv=bad.first.box\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::nestedcell/integer|boolean/wrapped",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet bad=[{box:{f:"bad"}},{box:src}]\nlet recv=bad.first.box\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::ret/integer|boolean/join",
    'let typed:integer | boolean=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:"bad"} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::ret/integer|boolean/reverse",
    'let typed:integer | boolean=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:"bad"} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::ret/integer|boolean/place",
    'let typed:integer | boolean=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:"bad"} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::ret/integer|boolean/wrapped",
    'let typed:integer | boolean=3\nlet src={f:typed}\nfunction chooseValue(flag:boolean) {\nif flag { return {f:"bad"} }\nreturn src\n}\nlet recv=chooseValue(true)\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::parameter/integer|boolean/join",
    'let typed:integer | boolean=3\nlet src={f:typed}\nfunction use(x={f:"bad"}) { return x }\nlet recv=use(src)\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::parameter/integer|boolean/reverse",
    'let typed:integer | boolean=3\nlet src={f:typed}\nfunction use(x={f:"bad"}) { return x }\nlet recv=use(src)\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::parameter/integer|boolean/place",
    'let typed:integer | boolean=3\nlet src={f:typed}\nfunction use(x={f:"bad"}) { return x }\nlet recv=use(src)\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::parameter/integer|boolean/wrapped",
    'let typed:integer | boolean=3\nlet src={f:typed}\nfunction use(x={f:"bad"}) { return x }\nlet recv=use(src)\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::emptydead/integer|boolean/join",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=[recv,src]\nexit\n',
  ],
  [
    "sol-own::emptydead/integer|boolean/reverse",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::emptydead/integer|boolean/place",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet out=recv\nout=src\nexit\n',
  ],
  [
    "sol-own::emptydead/integer|boolean/wrapped",
    'let typed:integer | boolean=3\nlet src={f:typed}\nlet recv={f:"bad"}\nrecv=src\nlet reject=[recv,src]\nlet isolated=reject.last\n\nlet one={nest:recv}\nlet two={nest:src}\nlet out=[one,two]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/fed/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/fed/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/whole/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/whole/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/field/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nr0=r1\nr1=r0\nr0.box=alt\nlet recv=r1.box\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/field/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nr0=r1\nr1=r0\nr0.box=alt\nlet recv=r1.box\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/direct/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:"bad"}\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/direct/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:"bad"}\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/late/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/late/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/host/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/2/host/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/fed/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/fed/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/whole/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/whole/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/field/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0.box=alt\nlet recv=r2.box\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/field/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0.box=alt\nlet recv=r2.box\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/direct/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:"bad"}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/direct/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:"bad"}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/late/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/late/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/host/join",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-string/3/host/place",
    'let first:integer=3\nlet second:string="bad"\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n',
  ],
  [
    "sol-own::cycle/integer-vs-number/2/fed/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/fed/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/whole/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/whole/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/field/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nr0=r1\nr1=r0\nr0.box=alt\nlet recv=r1.box\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/field/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nr0=r1\nr1=r0\nr0.box=alt\nlet recv=r1.box\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/direct/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:1.25}\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/direct/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:1.25}\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/late/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/late/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/host/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/2/host/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/fed/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/fed/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/whole/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/whole/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/field/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0.box=alt\nlet recv=r2.box\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/field/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0.box=alt\nlet recv=r2.box\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/direct/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:1.25}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/direct/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:1.25}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/late/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/late/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/host/join",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer-vs-number/3/host/place",
    "let first:integer=3\nlet second:number=1.25\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/fed/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/fed/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/whole/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/whole/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/field/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nr0=r1\nr1=r0\nr0.box=alt\nlet recv=r1.box\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/field/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nr0=r1\nr1=r0\nr0.box=alt\nlet recv=r1.box\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/direct/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:true}\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/direct/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:true}\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/late/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/late/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/host/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/2/host/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nr0=r1\nr1=r0\nr0=alt\nlet recv=r1\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/fed/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/fed/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet base=src\nbase=alt\nlet r0=base\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/whole/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/whole/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=src\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/field/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0.box=alt\nlet recv=r2.box\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/field/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0={box:src}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0.box=alt\nlet recv=r2.box\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/direct/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:true}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/direct/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0={f:true}\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/late/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/late/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=alt\nlet r1=alt\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/host/join",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=[src,recv]\nexit\n",
  ],
  [
    "sol-own::cycle/integer|string-vs-boolean/3/host/place",
    "let first:integer | string=3\nlet second:boolean=true\nlet src={f:first}\nlet alt={f:second}\nlet r0=hostValue\nr0=src\nlet r1=r0\nlet r2=r1\nr0=r1\nr1=r2\nr2=r0\nr0=alt\nlet recv=r2\nlet out=src\nout=recv\nexit\n",
  ],
  [
    "sol-own::cell/object/first",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[{box:{f:true}},{box:seed}]\nlet out=[bad.first.box,seed]\nexit\n",
  ],
  [
    "sol-own::cell/object/last",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[{box:{f:true}},{box:seed}]\nlet out=[bad.last.box,seed]\nexit\n",
  ],
  [
    "sol-own::cell/object/copy",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[{box:{f:true}},{box:seed}]\nlet tmp=bad\nlet out=[tmp.first.box,seed]\nexit\n",
  ],
  [
    "sol-own::cell/object/field",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[{box:{f:true}},{box:seed}]\nlet holder={bag:bad}\nlet out=[holder.bag.first.box,seed]\nexit\n",
  ],
  [
    "sol-own::cell/list/first",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet out=[bad.first.first,seed]\nexit\n",
  ],
  [
    "sol-own::cell/list/last",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet out=[bad.last.first,seed]\nexit\n",
  ],
  [
    "sol-own::cell/list/copy",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet out=[tmp.first.first,seed]\nexit\n",
  ],
  [
    "sol-own::cell/list/field",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet out=[holder.bag.first.first,seed]\nexit\n",
  ],
  [
    "sol-own::cell/double/first",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[{a:{box:{f:true}}},{a:{box:seed}}]\nlet out=[bad.first.a.box,seed]\nexit\n",
  ],
  [
    "sol-own::cell/double/last",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[{a:{box:{f:true}}},{a:{box:seed}}]\nlet out=[bad.last.a.box,seed]\nexit\n",
  ],
  [
    "sol-own::cell/double/copy",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[{a:{box:{f:true}}},{a:{box:seed}}]\nlet tmp=bad\nlet out=[tmp.first.a.box,seed]\nexit\n",
  ],
  [
    "sol-own::cell/double/field",
    "let token:integer | string=3\nlet seed={f:token}\nlet bad=[{a:{box:{f:true}}},{a:{box:seed}}]\nlet holder={bag:bad}\nlet out=[holder.bag.first.a.box,seed]\nexit\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'sx-queue add --priority 2 --name "sol-r4-$tree-$cases" --dir "$PWD" -- bash -c "systemd-run --user --scope --quiet --unit=sol-r4-$tree-$cases-\\$\\$ -p MemoryMax=4G -p MemorySwapMax=0 timeout 3600 node run.mjs \\$HOME/work/o4-m4-i1188-r4/trees/$tree $cases.json $cases-$tree.jsonl > $cases-$tree.log 2>&1; code=\\$?; echo exit=\\$code >> $cases-$tree.log; exit \\$code"',
      "/tmp/agent-work/o4-m4-i1188-r4/sol-r4/queue.sh:9",
    ],
  ],
  sources: 212,
  sha256: "643e4e3e26065068a8cd54ef969f42db4c4e25a86a7c01cebac3561b7e06d0eb",
};
