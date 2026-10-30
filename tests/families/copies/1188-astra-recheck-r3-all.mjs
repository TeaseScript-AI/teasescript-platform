// #1188's design recheck r3 (Astra): the rejected, live, cycle, union and oracle families of its `generate.py` (145
// cases), analysed by its `run.mjs` (R/astra-m4-i1188-design-recheck-r3-evidence/).
export const cases = [
  [
    "astra-all::reject/integer/list/True/list",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/list/True/reverse",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/list/True/assign",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/list/True/field",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/dict/True/list",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/dict/True/reverse",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/dict/True/assign",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/dict/True/field",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/record/True/list",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/record/True/reverse",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/record/True/assign",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/record/True/field",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/list/False/list",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/list/False/reverse",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/list/False/assign",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/list/False/field",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/dict/False/list",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/dict/False/reverse",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/dict/False/assign",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/dict/False/field",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/record/False/list",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/record/False/reverse",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer/record/False/assign",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer/record/False/field",
    'let count:integer=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/list/True/list",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/list/True/reverse",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/list/True/assign",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/list/True/field",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/dict/True/list",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/dict/True/reverse",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/dict/True/assign",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/dict/True/field",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/record/True/list",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/record/True/reverse",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/record/True/assign",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/record/True/field",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/list/False/list",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/list/False/reverse",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/list/False/assign",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/list/False/field",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/dict/False/list",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/dict/False/reverse",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/dict/False/assign",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/dict/False/field",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/record/False/list",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/record/False/reverse",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/record/False/assign",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/integer | string/record/False/field",
    'let count:integer | string=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/list/True/list",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/list/True/reverse",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/list/True/assign",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/list/True/field",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[{meta:{score:false},label:"ok"},parcel]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/dict/True/list",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/dict/True/reverse",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/dict/True/assign",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/dict/True/field",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:{meta:{score:false},label:"ok"},right:parcel}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/record/True/list",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/record/True/reverse",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/record/True/assign",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/record/True/field",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[{meta:{score:false},label:"ok"},parcel]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/list/False/list",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/list/False/reverse",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/list/False/assign",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/list/False/field",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=[parcel,{meta:{score:false},label:"ok"}]\nlet capsule={value:broken.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/dict/False/list",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/dict/False/reverse",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/dict/False/assign",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/dict/False/field",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken=dict{left:parcel,right:{meta:{score:false},label:"ok"}}\nlet capsule={value:broken.values.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/record/False/list",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[picked.meta,parcel.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/record/False/reverse",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=[parcel.meta,picked.meta]\nexit\n',
  ],
  [
    "astra-all::reject/inferred/record/False/assign",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final=picked.meta\nfinal=parcel.meta\nexit\n',
  ],
  [
    "astra-all::reject/inferred/record/False/field",
    'let count=11\nlet parcel={meta:{score:count},label:"ok"}\nlet broken={inside:[parcel,{meta:{score:false},label:"ok"}]}\nlet capsule={value:broken.inside.first}\nlet relay=capsule\nlet picked=relay.value\nlet final={slot:picked.meta}\nfinal.slot=parcel.meta\nexit\n',
  ],
  [
    "astra-all::live/integer/list/False/False",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[[{node:{score:false}}],[source]]\nlet final=[grid.first.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/list/False/True",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[[{node:{score:false}}],[source]]\nlet irrelevant=[false,42]\nlet final=[grid.first.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/list/True/False",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[[{node:{score:false}}],[source]]\nlet final=[source.node,grid.first.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/list/True/True",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[[{node:{score:false}}],[source]]\nlet irrelevant=[false,42]\nlet final=[source.node,grid.first.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/dict/False/False",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[dict{a:{node:{score:false}}},dict{b:source}]\nlet final=[grid.first.values.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/dict/False/True",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[dict{a:{node:{score:false}}},dict{b:source}]\nlet irrelevant=[false,42]\nlet final=[grid.first.values.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/dict/True/False",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[dict{a:{node:{score:false}}},dict{b:source}]\nlet final=[source.node,grid.first.values.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/dict/True/True",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[dict{a:{node:{score:false}}},dict{b:source}]\nlet irrelevant=[false,42]\nlet final=[source.node,grid.first.values.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/record/False/False",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[{rows:[{node:{score:false}}]},{rows:[source]}]\nlet final=[grid.first.rows.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/record/False/True",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[{rows:[{node:{score:false}}]},{rows:[source]}]\nlet irrelevant=[false,42]\nlet final=[grid.first.rows.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/record/True/False",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[{rows:[{node:{score:false}}]},{rows:[source]}]\nlet final=[source.node,grid.first.rows.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer/record/True/True",
    "let score:integer=13\nlet source={node:{score:score}}\nlet grid=[{rows:[{node:{score:false}}]},{rows:[source]}]\nlet irrelevant=[false,42]\nlet final=[source.node,grid.first.rows.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/list/False/False",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[[{node:{score:false}}],[source]]\nlet final=[grid.first.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/list/False/True",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[[{node:{score:false}}],[source]]\nlet irrelevant=[false,42]\nlet final=[grid.first.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/list/True/False",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[[{node:{score:false}}],[source]]\nlet final=[source.node,grid.first.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/list/True/True",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[[{node:{score:false}}],[source]]\nlet irrelevant=[false,42]\nlet final=[source.node,grid.first.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/dict/False/False",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[dict{a:{node:{score:false}}},dict{b:source}]\nlet final=[grid.first.values.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/dict/False/True",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[dict{a:{node:{score:false}}},dict{b:source}]\nlet irrelevant=[false,42]\nlet final=[grid.first.values.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/dict/True/False",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[dict{a:{node:{score:false}}},dict{b:source}]\nlet final=[source.node,grid.first.values.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/dict/True/True",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[dict{a:{node:{score:false}}},dict{b:source}]\nlet irrelevant=[false,42]\nlet final=[source.node,grid.first.values.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/record/False/False",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[{rows:[{node:{score:false}}]},{rows:[source]}]\nlet final=[grid.first.rows.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/record/False/True",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[{rows:[{node:{score:false}}]},{rows:[source]}]\nlet irrelevant=[false,42]\nlet final=[grid.first.rows.first.node,source.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/record/True/False",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[{rows:[{node:{score:false}}]},{rows:[source]}]\nlet final=[source.node,grid.first.rows.first.node]\nexit\n",
  ],
  [
    "astra-all::live/integer | string/record/True/True",
    "let score:integer | string=13\nlet source={node:{score:score}}\nlet grid=[{rows:[{node:{score:false}}]},{rows:[source]}]\nlet irrelevant=[false,42]\nlet final=[source.node,grid.first.rows.first.node]\nexit\n",
  ],
  [
    "astra-all::cycle/2/False/none",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nr0=r1\nlet envelope={tail:r1}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/2/False/member",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nr0=r1\nr1={f:"wrong",g:"stable"}\nlet envelope={tail:r1}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/2/False/foreign",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nr0=r1\nlet rejected=[{f:false},origin]\nlet envelope={tail:r1}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/2/True/none",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nr0=r1\nr1.g="still"\nlet envelope={tail:r1}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/2/True/member",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nr0=r1\nr1.g="still"\nr1={f:"wrong",g:"stable"}\nlet envelope={tail:r1}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/2/True/foreign",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nr0=r1\nr1.g="still"\nlet rejected=[{f:false},origin]\nlet envelope={tail:r1}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/3/False/none",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nr0=r2\nlet envelope={tail:r2}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/3/False/member",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nr0=r2\nr1={f:"wrong",g:"stable"}\nlet envelope={tail:r2}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/3/False/foreign",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nr0=r2\nlet rejected=[{f:false},origin]\nlet envelope={tail:r2}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/3/True/none",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nr0=r2\nr1.g="still"\nlet envelope={tail:r2}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/3/True/member",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nr0=r2\nr1.g="still"\nr1={f:"wrong",g:"stable"}\nlet envelope={tail:r2}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/3/True/foreign",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nr0=r2\nr1.g="still"\nlet rejected=[{f:false},origin]\nlet envelope={tail:r2}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/4/False/none",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nlet r3=r2\nr0=r3\nlet envelope={tail:r3}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/4/False/member",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nlet r3=r2\nr0=r3\nr1={f:"wrong",g:"stable"}\nlet envelope={tail:r3}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/4/False/foreign",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nlet r3=r2\nr0=r3\nlet rejected=[{f:false},origin]\nlet envelope={tail:r3}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/4/True/none",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nlet r3=r2\nr0=r3\nr1.g="still"\nlet envelope={tail:r3}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/4/True/member",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nlet r3=r2\nr0=r3\nr1.g="still"\nr1={f:"wrong",g:"stable"}\nlet envelope={tail:r3}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::cycle/4/True/foreign",
    'let exact:integer=19\nlet origin={f:exact,g:"stable"}\nlet other={f:1.75,g:"stable"}\nlet inlet=origin\ninlet=other\nlet r0=inlet\nlet r1=r0\nlet r2=r1\nlet r3=r2\nr0=r3\nr1.g="still"\nlet rejected=[{f:false},origin]\nlet envelope={tail:r3}\nlet final=[other,envelope.tail]\nexit\n',
  ],
  [
    "astra-all::whole/False/False/own",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nleft=right\nright=left\nright.g=2\nlet box={a:left,b:right}\nlet final=[left,right]\nexit\n',
  ],
  [
    "astra-all::whole/False/False/outside",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nleft=right\nright=left\nlet next=left\nleft=next\nlet box={a:left,b:right}\nlet final=[left,right]\nexit\n',
  ],
  [
    "astra-all::whole/False/False/both",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nleft=right\nright=left\nright.g=2\nlet next=left\nleft=next\nlet box={a:left,b:right}\nlet final=[left,right]\nexit\n',
  ],
  [
    "astra-all::whole/False/True/own",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nleft=right\nright=left\nright.g=2\nlet box={a:left,b:right}\nlet final=[box.a,box.b]\nexit\n',
  ],
  [
    "astra-all::whole/False/True/outside",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nleft=right\nright=left\nlet next=left\nleft=next\nlet box={a:left,b:right}\nlet final=[box.a,box.b]\nexit\n',
  ],
  [
    "astra-all::whole/False/True/both",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nleft=right\nright=left\nright.g=2\nlet next=left\nleft=next\nlet box={a:left,b:right}\nlet final=[box.a,box.b]\nexit\n',
  ],
  [
    "astra-all::whole/True/False/own",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nright=left\nleft=right\nright.g=2\nlet box={a:left,b:right}\nlet final=[left,right]\nexit\n',
  ],
  [
    "astra-all::whole/True/False/outside",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nright=left\nleft=right\nlet next=left\nleft=next\nlet box={a:left,b:right}\nlet final=[left,right]\nexit\n',
  ],
  [
    "astra-all::whole/True/False/both",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nright=left\nleft=right\nright.g=2\nlet next=left\nleft=next\nlet box={a:left,b:right}\nlet final=[left,right]\nexit\n',
  ],
  [
    "astra-all::whole/True/True/own",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nright=left\nleft=right\nright.g=2\nlet box={a:left,b:right}\nlet final=[box.a,box.b]\nexit\n',
  ],
  [
    "astra-all::whole/True/True/outside",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nright=left\nleft=right\nlet next=left\nleft=next\nlet box={a:left,b:right}\nlet final=[box.a,box.b]\nexit\n',
  ],
  [
    "astra-all::whole/True/True/both",
    'let nvalue:integer=23\nlet wordvalue:string="s"\nlet left={f:nvalue,g:0}\nlet right={f:wordvalue,g:0}\nright=left\nleft=right\nright.g=2\nlet next=left\nleft=next\nlet box={a:left,b:right}\nlet final=[box.a,box.b]\nexit\n',
  ],
  [
    "astra-all::union/integer | string/31/root",
    "let declared:integer | string=31\nlet seed={v:declared}\nlet source={v:31}\nlet mix=seed\nmix=source\nlet echo=mix\nlet final=[seed,echo]\nexit\n",
  ],
  [
    "astra-all::union/integer | string/31/nested",
    "let declared:integer | string=31\nlet seed={v:declared}\nlet source={v:31}\nlet mix=seed\nmix=source\nlet outer={deep:mix}\nlet echo=outer.deep\nlet final=[echo,seed]\nexit\n",
  ],
  [
    'astra-all::union/integer | string/"s"/root',
    'let declared:integer | string=31\nlet seed={v:declared}\nlet source={v:"s"}\nlet mix=seed\nmix=source\nlet echo=mix\nlet final=[seed,echo]\nexit\n',
  ],
  [
    'astra-all::union/integer | string/"s"/nested',
    'let declared:integer | string=31\nlet seed={v:declared}\nlet source={v:"s"}\nlet mix=seed\nmix=source\nlet outer={deep:mix}\nlet echo=outer.deep\nlet final=[echo,seed]\nexit\n',
  ],
  [
    "astra-all::union/integer | string/false/root",
    "let declared:integer | string=31\nlet seed={v:declared}\nlet source={v:false}\nlet mix=seed\nmix=source\nlet echo=mix\nlet final=[seed,echo]\nexit\n",
  ],
  [
    "astra-all::union/integer | string/false/nested",
    "let declared:integer | string=31\nlet seed={v:declared}\nlet source={v:false}\nlet mix=seed\nmix=source\nlet outer={deep:mix}\nlet echo=outer.deep\nlet final=[echo,seed]\nexit\n",
  ],
  [
    "astra-all::union/integer | string/2.25/root",
    "let declared:integer | string=31\nlet seed={v:declared}\nlet source={v:2.25}\nlet mix=seed\nmix=source\nlet echo=mix\nlet final=[seed,echo]\nexit\n",
  ],
  [
    "astra-all::union/integer | string/2.25/nested",
    "let declared:integer | string=31\nlet seed={v:declared}\nlet source={v:2.25}\nlet mix=seed\nmix=source\nlet outer={deep:mix}\nlet echo=outer.deep\nlet final=[echo,seed]\nexit\n",
  ],
  [
    "astra-all::union/integer/31/root",
    "let declared:integer=31\nlet seed={v:declared}\nlet source={v:31}\nlet mix=seed\nmix=source\nlet echo=mix\nlet final=[seed,echo]\nexit\n",
  ],
  [
    "astra-all::union/integer/31/nested",
    "let declared:integer=31\nlet seed={v:declared}\nlet source={v:31}\nlet mix=seed\nmix=source\nlet outer={deep:mix}\nlet echo=outer.deep\nlet final=[echo,seed]\nexit\n",
  ],
  [
    'astra-all::union/integer/"s"/root',
    'let declared:integer=31\nlet seed={v:declared}\nlet source={v:"s"}\nlet mix=seed\nmix=source\nlet echo=mix\nlet final=[seed,echo]\nexit\n',
  ],
  [
    'astra-all::union/integer/"s"/nested',
    'let declared:integer=31\nlet seed={v:declared}\nlet source={v:"s"}\nlet mix=seed\nmix=source\nlet outer={deep:mix}\nlet echo=outer.deep\nlet final=[echo,seed]\nexit\n',
  ],
  [
    "astra-all::union/integer/false/root",
    "let declared:integer=31\nlet seed={v:declared}\nlet source={v:false}\nlet mix=seed\nmix=source\nlet echo=mix\nlet final=[seed,echo]\nexit\n",
  ],
  [
    "astra-all::union/integer/false/nested",
    "let declared:integer=31\nlet seed={v:declared}\nlet source={v:false}\nlet mix=seed\nmix=source\nlet outer={deep:mix}\nlet echo=outer.deep\nlet final=[echo,seed]\nexit\n",
  ],
  [
    "astra-all::union/integer/2.25/root",
    "let declared:integer=31\nlet seed={v:declared}\nlet source={v:2.25}\nlet mix=seed\nmix=source\nlet echo=mix\nlet final=[seed,echo]\nexit\n",
  ],
  [
    "astra-all::union/integer/2.25/nested",
    "let declared:integer=31\nlet seed={v:declared}\nlet source={v:2.25}\nlet mix=seed\nmix=source\nlet outer={deep:mix}\nlet echo=outer.deep\nlet final=[echo,seed]\nexit\n",
  ],
  [
    "astra-all::oracle/plain",
    'let n:integer=41\nlet good={score:n}\nlet bad={score:"no"}\nlet pair=[good,bad]\nexit\n',
  ],
  [
    "astra-all::oracle/union",
    "let n:integer | string=41\nlet good={score:n}\nlet bad={score:false}\nlet pair=[good,bad]\nexit\n",
  ],
  [
    "astra-all::oracle/fitting",
    "let n:integer | string=41\nlet good={score:n}\nlet bad={score:44}\nlet pair=[good,bad]\nexit\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      'node "$review_root/run.mjs" "$review_root/$variant-d93-review" "$review_root/cases/$family.json" "$review_root/out/$family-$variant-$order.jsonl" "$order" > "$review_root/out/$family-$variant-$order.log" 2>&1',
      "R/astra-m4-i1188-design-recheck-r3-evidence/run-one.sh:6",
    ],
  ],
  sources: 145,
  sha256: "08cc33346ea03c52c3805aa051a4e704254399cfaf90d547309cb987aaa42ecb",
};
