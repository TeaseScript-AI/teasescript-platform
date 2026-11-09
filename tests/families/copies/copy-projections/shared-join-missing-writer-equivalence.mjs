// Its id is its file name before its area was grouped, which keeps its sources' places in a stored baseline.
export const id = "1323-fold-siblings.mjs";
// #1323 (the lead's ruling on Sol's design round, #1323 comment 6648736650): with the sharing on, a group
// read's F11 `missing` names what the unshared join names. Every row of Sol's family/obligation table: the original
// shapes and HEAD 0's 21 siblings (`siblings/`), Astra r1's nested call arguments and Codex r3's list elements
// (`nested/`), Codex r4's projections, own steps and `.get` (`cases/`), compositions, selections, references and
// empties (`cases/`, `extra/`), the solver lifecycle (`cycles/`, `extra/cycle-fresh`), root folds (`root-cases/`), the
// growth family (`extra/fresh-growth`) and the two stop witnesses (`untyped-cases/`, `stops-cases/`). Sources from
// `~/work/evidence/1323-sol-fold/dff711474/` and `~/work/evidence/1736/`.
const rows = [
  [
    "cases/projection-missing-root-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:{}},{}][0].p)),p:{}},{}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-missing-root-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(([{},{noise:read(([{},{noise:0,p:{}}][0].p)),p:{}}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-several-missing-root-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:{}},{q:1}][0].p)),p:{}},{q:1}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-several-missing-root-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:{}},{q:1},{}][0].p)),p:{}},{q:1},{}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-missing-.q-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.q\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:{q:{}}},{}][0].p)),p:{q:{}}},{}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-missing-.q-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.q\nalias.extra=1\nreturn 0 }\nlet result=read(([{},{noise:read(([{},{noise:0,p:{q:{}}}][0].p)),p:{q:{}}}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-several-missing-.q-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.q\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:{q:{}}},{q:1}][0].p)),p:{q:{}}},{q:1}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-several-missing-.q-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.q\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:{q:{}}},{q:1},{}][0].p)),p:{q:{}}},{q:1},{}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-missing-[0]-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x[0]\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:[{}]},{}][0].p)),p:[{}]},{}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-missing-[0]-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x[0]\nalias.extra=1\nreturn 0 }\nlet result=read(([{},{noise:read(([{},{noise:0,p:[{}]}][0].p)),p:[{}]}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-several-missing-[0]-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x[0]\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:[{}]},{q:1}][0].p)),p:[{}]},{q:1}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-several-missing-[0]-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x[0]\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:[{}]},{q:1},{}][0].p)),p:[{}]},{q:1},{}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-missing-[0].q-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x[0].q\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:[{q:{}}]},{}][0].p)),p:[{q:{}}]},{}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-missing-[0].q-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x[0].q\nalias.extra=1\nreturn 0 }\nlet result=read(([{},{noise:read(([{},{noise:0,p:[{q:{}}]}][0].p)),p:[{q:{}}]}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-several-missing-[0].q-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x[0].q\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:[{q:{}}]},{q:1}][0].p)),p:[{q:{}}]},{q:1}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/projection-several-missing-[0].q-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x[0].q\nalias.extra=1\nreturn 0 }\nlet result=read(([{noise:read(([{noise:0,p:[{q:{}}]},{q:1},{}][0].p)),p:[{q:{}}]},{q:1},{}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "cases/different-at-property",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.q\nalias.extra=1\nreturn 0 }\nlet result=read(({a:{q:{}},b:{q:{}},noise:read(({a:{q:{}},b:{q:{}},noise:0}).a)}).b)\nexit\n",
      },
    ],
  ],
  [
    "cases/different-at-list",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.q\nalias.extra=1\nreturn 0 }\nlet result=read(([{a:{q:{}},b:{q:{}},noise:read(([{a:{q:{}},b:{q:{}},noise:0}][0].a))}][0].b))\nexit\n",
      },
    ],
  ],
  [
    "cases/different-at-different-length",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.q\nalias.extra=1\nreturn 0 }\nlet result=read(([{a:{q:{}},noise:read(({a:{q:{}},noise:0}).a)}][0].a))\nexit\n",
      },
    ],
  ],
  [
    "cases/gather-value-True",
    [
      {
        path: "main.tease",
        source:
          "let shared=[{}, {q:{}}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:shared[0]}),p:shared[0]})\nexit\n",
      },
    ],
  ],
  [
    "cases/gather-value-False",
    [
      {
        path: "main.tease",
        source:
          "let shared=[{}, {q:{}}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({p:shared[0],noise:read({noise:0,p:shared[0]})})\nexit\n",
      },
    ],
  ],
  [
    "cases/gather-get-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{}, {q:{}}].get(0, default:{})}),p:[{}, {q:{}}].get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/gather-get-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({p:[{}, {q:{}}].get(0, default:{}),noise:read({noise:0,p:[{}, {q:{}}].get(0, default:{})})})\nexit\n",
      },
    ],
  ],
  [
    "cases/gather-call-True",
    [
      {
        path: "main.tease",
        source:
          "function take(x:object) { return x }\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:take({q:{}})}),p:take({q:{}})})\nexit\n",
      },
    ],
  ],
  [
    "cases/gather-call-False",
    [
      {
        path: "main.tease",
        source:
          "function take(x:object) { return x }\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({p:take({q:{}}),noise:read({noise:0,p:take({q:{}})})})\nexit\n",
      },
    ],
  ],
  [
    "cases/gather-reference-True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:player}),p:player})\nexit\n",
      },
    ],
  ],
  [
    "cases/gather-reference-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({p:player,noise:read({noise:0,p:player})})\nexit\n",
      },
    ],
  ],
  [
    "cases/list-1-reads-1",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{f0:1.5}]}),p:[{f0:1.5}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/list-1-reads-2",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nlet alias1=x.p[0]\nalias1.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{f0:1.5}]}),p:[{f0:1.5}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/list-2-reads-1",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{f0:1.5},{f0:1.5}]}),p:[{f0:1.5},{f0:1.5}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/list-2-reads-2",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nlet alias1=x.p[0]\nalias1.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{f0:1.5},{f0:1.5}]}),p:[{f0:1.5},{f0:1.5}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/list-3-reads-1",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{f0:1.5},{f0:1.5},{f0:1.5}]}),p:[{f0:1.5},{f0:1.5},{f0:1.5}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/list-3-reads-2",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nlet alias1=x.p[0]\nalias1.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{f0:1.5},{f0:1.5},{f0:1.5}]}),p:[{f0:1.5},{f0:1.5},{f0:1.5}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/list-minimal",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{}]}),p:[{}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/list-deep-empty",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0][0]\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[[]]}),p:[[]]})\nexit\n",
      },
    ],
  ],
  [
    "cases/reference",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p.q\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:/x/}),p:/x/})\nexit\n",
      },
    ],
  ],
  [
    "cases/empty-before-object",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[]}),p:[]})\nexit\n",
      },
    ],
  ],
  [
    "cases/selection-object",
    [
      {
        path: "main.tease",
        source:
          'function read(x:object) { let alias0=askChoice x.p\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{text:"a",value:{f0:1.5}}}),p:{text:"a",value:{f0:1.5}}})\nexit\n',
      },
    ],
  ],
  [
    "cases/selection-list",
    [
      {
        path: "main.tease",
        source:
          'function read(x:object) { let alias0=askChoice x.p\nalias0.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:[{text:"a",value:{f0:1.5}}]}),p:[{text:"a",value:{f0:1.5}}]})\nexit\n',
      },
    ],
  ],
  [
    "cases/first-object-has-step",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read({p:[{extra:1,noise:read({p:[{extra:1,noise:0},{f0:1.5}]})},{f0:1.5}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/deepest-differs-lacking",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0].q\nalias0.extra=1\nreturn 0 }\nlet result=read({p:[{f0:1.5,noise:read({p:[{f0:1.5,noise:0},{q:{f0:1.5}}]})},{q:{f0:1.5}}]})\nexit\n",
      },
    ],
  ],
  [
    "cases/projected-list-({wrap:INNER}).wrap",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read(({wrap:{noise:read(({wrap:{noise:0,p:[{f0:1.5}]}}).wrap),p:[{f0:1.5}]}}).wrap)\nexit\n",
      },
    ],
  ],
  [
    "cases/projected-list-[INNER][0]",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read([{noise:read([{noise:0,p:[{f0:1.5}]}][0]),p:[{f0:1.5}]}][0])\nexit\n",
      },
    ],
  ],
  [
    "cases/projected-list-({wrap:[INNER]}).wrap[0]",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias0=x.p[0]\nalias0.extra=1\nreturn 0 }\nlet result=read(({wrap:[{noise:read(({wrap:[{noise:0,p:[{f0:1.5}]}]}).wrap[0]),p:[{f0:1.5}]}]}).wrap[0])\nexit\n",
      },
    ],
  ],
  [
    "cases/nested-same-callee-p-True-typed",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read({p:{f0:1.5},noise:read({noise:0,p:{f0:1.5}})})\nexit\n",
      },
    ],
  ],
  [
    "cases/nested-same-callee-p-False-typed",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{f0:1.5}}),p:{f0:1.5}})\nexit\n",
      },
    ],
  ],
  [
    "cases/nested-same-callee-p.q-True-typed",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({p:{q:{f0:1.5}},noise:read({noise:0,p:{q:{f0:1.5}}})})\nexit\n",
      },
    ],
  ],
  [
    "cases/nested-same-callee-p.q-False-typed",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{f0:1.5}}}),p:{q:{f0:1.5}}})\nexit\n",
      },
    ],
  ],
  [
    "cases/three-deep-after",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:0,p:{f0:1.5}}),p:{f0:1.5}}),p:{f0:1.5}})\nexit\n",
      },
    ],
  ],
  [
    "cases/three-deep-before",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read({p:{f0:1.5},noise:read({p:{f0:1.5},noise:read({noise:0,p:{f0:1.5}})})})\nexit\n",
      },
    ],
  ],
  [
    "cases/nested-other-callee",
    [
      {
        path: "main.tease",
        source:
          "function look(x:object) { return 0 }\nfunction read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read({noise:look({p:{f0:2.5}}),p:{f0:1.5}})\nlet other=read({noise:0,p:{f0:1.5}})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x/p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x/p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x/p.element.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn x }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x/p.element.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn x }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x/p.p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn x }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x/p.p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn x }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x.p/p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x.p }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x.p/p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x.p }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x.p/p.element.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn x.p }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x.p/p.element.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn x.p }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x.p/p.p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn x.p }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/x.p/p.p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn x.p }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/[x]/p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn [x] }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/[x]/p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn [x] }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/[x]/p.element.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn [x] }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/[x]/p.element.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn [x] }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/[x]/p.p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn [x] }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/cycle-get/[x]/p.p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn [x] }\nlet box=read({p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:0,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cases/layers/1/guardFalse",
    [
      {
        path: "main.tease",
        source:
          "let a={}\nlet b={q:{}}\nlet box={p:a}\nbox={p:b}\nlet layer0={p:box}\nlayer0.p=box\nbox=layer0.p\nlet alias=box.p.q\nalias.extra=1\nexit\n",
      },
    ],
  ],
  [
    "cases/layers/1/guardTrue",
    [
      {
        path: "main.tease",
        source:
          "let a={}\nlet b={q:{}}\nlet box={p:a}\nbox={p:b}\nlet layer0={p:box}\nlayer0.p=box\nbox=layer0.p\nif hostValue != null {\nlet alias=box.p.q\nalias.extra=1\n}\nexit\n",
      },
    ],
  ],
  [
    "cases/layers/2/guardFalse",
    [
      {
        path: "main.tease",
        source:
          "let a={}\nlet b={q:{}}\nlet box={p:a}\nbox={p:b}\nlet layer0={p:box}\nlayer0.p=box\nbox=layer0.p\nlet layer1={p:box}\nlayer1.p=box\nbox=layer1.p\nlet alias=box.p.q\nalias.extra=1\nexit\n",
      },
    ],
  ],
  [
    "cases/layers/2/guardTrue",
    [
      {
        path: "main.tease",
        source:
          "let a={}\nlet b={q:{}}\nlet box={p:a}\nbox={p:b}\nlet layer0={p:box}\nlayer0.p=box\nbox=layer0.p\nlet layer1={p:box}\nlayer1.p=box\nbox=layer1.p\nif hostValue != null {\nlet alias=box.p.q\nalias.extra=1\n}\nexit\n",
      },
    ],
  ],
  [
    "cases/layers/4/guardFalse",
    [
      {
        path: "main.tease",
        source:
          "let a={}\nlet b={q:{}}\nlet box={p:a}\nbox={p:b}\nlet layer0={p:box}\nlayer0.p=box\nbox=layer0.p\nlet layer1={p:box}\nlayer1.p=box\nbox=layer1.p\nlet layer2={p:box}\nlayer2.p=box\nbox=layer2.p\nlet layer3={p:box}\nlayer3.p=box\nbox=layer3.p\nlet alias=box.p.q\nalias.extra=1\nexit\n",
      },
    ],
  ],
  [
    "cases/layers/4/guardTrue",
    [
      {
        path: "main.tease",
        source:
          "let a={}\nlet b={q:{}}\nlet box={p:a}\nbox={p:b}\nlet layer0={p:box}\nlayer0.p=box\nbox=layer0.p\nlet layer1={p:box}\nlayer1.p=box\nbox=layer1.p\nlet layer2={p:box}\nlayer2.p=box\nbox=layer2.p\nlet layer3={p:box}\nlayer3.p=box\nbox=layer3.p\nif hostValue != null {\nlet alias=box.p.q\nalias.extra=1\n}\nexit\n",
      },
    ],
  ],
  [
    "cases/growth/8/False",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nreturn 0 }\nlet r0=read({noise:0,p:shared})\nlet r1=read({noise:1,p:shared})\nlet r2=read({noise:2,p:shared})\nlet r3=read({noise:3,p:shared})\nlet r4=read({noise:4,p:shared})\nlet r5=read({noise:5,p:shared})\nlet r6=read({noise:6,p:shared})\nlet r7=read({noise:7,p:shared})\nexit\n",
      },
    ],
  ],
  [
    "cases/growth/8/True",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nreturn 0 }\nlet r0=read({noise:0,p:{}})\nlet r1=read({noise:1,p:{}})\nlet r2=read({noise:2,p:{}})\nlet r3=read({noise:3,p:{}})\nlet r4=read({noise:4,p:{}})\nlet r5=read({noise:5,p:{}})\nlet r6=read({noise:6,p:{}})\nlet r7=read({noise:7,p:{}})\nexit\n",
      },
    ],
  ],
  [
    "cases/growth/16/False",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nreturn 0 }\nlet r0=read({noise:0,p:shared})\nlet r1=read({noise:1,p:shared})\nlet r2=read({noise:2,p:shared})\nlet r3=read({noise:3,p:shared})\nlet r4=read({noise:4,p:shared})\nlet r5=read({noise:5,p:shared})\nlet r6=read({noise:6,p:shared})\nlet r7=read({noise:7,p:shared})\nlet r8=read({noise:8,p:shared})\nlet r9=read({noise:9,p:shared})\nlet r10=read({noise:10,p:shared})\nlet r11=read({noise:11,p:shared})\nlet r12=read({noise:12,p:shared})\nlet r13=read({noise:13,p:shared})\nlet r14=read({noise:14,p:shared})\nlet r15=read({noise:15,p:shared})\nexit\n",
      },
    ],
  ],
  [
    "cases/growth/16/True",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nreturn 0 }\nlet r0=read({noise:0,p:{}})\nlet r1=read({noise:1,p:{}})\nlet r2=read({noise:2,p:{}})\nlet r3=read({noise:3,p:{}})\nlet r4=read({noise:4,p:{}})\nlet r5=read({noise:5,p:{}})\nlet r6=read({noise:6,p:{}})\nlet r7=read({noise:7,p:{}})\nlet r8=read({noise:8,p:{}})\nlet r9=read({noise:9,p:{}})\nlet r10=read({noise:10,p:{}})\nlet r11=read({noise:11,p:{}})\nlet r12=read({noise:12,p:{}})\nlet r13=read({noise:13,p:{}})\nlet r14=read({noise:14,p:{}})\nlet r15=read({noise:15,p:{}})\nexit\n",
      },
    ],
  ],
  [
    "cases/growth/32/False",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1,f16:1,f17:1,f18:1,f19:1,f20:1,f21:1,f22:1,f23:1,f24:1,f25:1,f26:1,f27:1,f28:1,f29:1,f30:1,f31:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nlet got16=x.p.f16\nlet got17=x.p.f17\nlet got18=x.p.f18\nlet got19=x.p.f19\nlet got20=x.p.f20\nlet got21=x.p.f21\nlet got22=x.p.f22\nlet got23=x.p.f23\nlet got24=x.p.f24\nlet got25=x.p.f25\nlet got26=x.p.f26\nlet got27=x.p.f27\nlet got28=x.p.f28\nlet got29=x.p.f29\nlet got30=x.p.f30\nlet got31=x.p.f31\nreturn 0 }\nlet r0=read({noise:0,p:shared})\nlet r1=read({noise:1,p:shared})\nlet r2=read({noise:2,p:shared})\nlet r3=read({noise:3,p:shared})\nlet r4=read({noise:4,p:shared})\nlet r5=read({noise:5,p:shared})\nlet r6=read({noise:6,p:shared})\nlet r7=read({noise:7,p:shared})\nlet r8=read({noise:8,p:shared})\nlet r9=read({noise:9,p:shared})\nlet r10=read({noise:10,p:shared})\nlet r11=read({noise:11,p:shared})\nlet r12=read({noise:12,p:shared})\nlet r13=read({noise:13,p:shared})\nlet r14=read({noise:14,p:shared})\nlet r15=read({noise:15,p:shared})\nlet r16=read({noise:16,p:shared})\nlet r17=read({noise:17,p:shared})\nlet r18=read({noise:18,p:shared})\nlet r19=read({noise:19,p:shared})\nlet r20=read({noise:20,p:shared})\nlet r21=read({noise:21,p:shared})\nlet r22=read({noise:22,p:shared})\nlet r23=read({noise:23,p:shared})\nlet r24=read({noise:24,p:shared})\nlet r25=read({noise:25,p:shared})\nlet r26=read({noise:26,p:shared})\nlet r27=read({noise:27,p:shared})\nlet r28=read({noise:28,p:shared})\nlet r29=read({noise:29,p:shared})\nlet r30=read({noise:30,p:shared})\nlet r31=read({noise:31,p:shared})\nexit\n",
      },
    ],
  ],
  [
    "cases/growth/32/True",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1,f16:1,f17:1,f18:1,f19:1,f20:1,f21:1,f22:1,f23:1,f24:1,f25:1,f26:1,f27:1,f28:1,f29:1,f30:1,f31:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nlet got16=x.p.f16\nlet got17=x.p.f17\nlet got18=x.p.f18\nlet got19=x.p.f19\nlet got20=x.p.f20\nlet got21=x.p.f21\nlet got22=x.p.f22\nlet got23=x.p.f23\nlet got24=x.p.f24\nlet got25=x.p.f25\nlet got26=x.p.f26\nlet got27=x.p.f27\nlet got28=x.p.f28\nlet got29=x.p.f29\nlet got30=x.p.f30\nlet got31=x.p.f31\nreturn 0 }\nlet r0=read({noise:0,p:{}})\nlet r1=read({noise:1,p:{}})\nlet r2=read({noise:2,p:{}})\nlet r3=read({noise:3,p:{}})\nlet r4=read({noise:4,p:{}})\nlet r5=read({noise:5,p:{}})\nlet r6=read({noise:6,p:{}})\nlet r7=read({noise:7,p:{}})\nlet r8=read({noise:8,p:{}})\nlet r9=read({noise:9,p:{}})\nlet r10=read({noise:10,p:{}})\nlet r11=read({noise:11,p:{}})\nlet r12=read({noise:12,p:{}})\nlet r13=read({noise:13,p:{}})\nlet r14=read({noise:14,p:{}})\nlet r15=read({noise:15,p:{}})\nlet r16=read({noise:16,p:{}})\nlet r17=read({noise:17,p:{}})\nlet r18=read({noise:18,p:{}})\nlet r19=read({noise:19,p:{}})\nlet r20=read({noise:20,p:{}})\nlet r21=read({noise:21,p:{}})\nlet r22=read({noise:22,p:{}})\nlet r23=read({noise:23,p:{}})\nlet r24=read({noise:24,p:{}})\nlet r25=read({noise:25,p:{}})\nlet r26=read({noise:26,p:{}})\nlet r27=read({noise:27,p:{}})\nlet r28=read({noise:28,p:{}})\nlet r29=read({noise:29,p:{}})\nlet r30=read({noise:30,p:{}})\nlet r31=read({noise:31,p:{}})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/1/False/{}",
    [
      {
        path: "main.tease",
        source:
          "let ys0=[]\nlet xs=ys0\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=[{},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/1/False/{q:{}}",
    [
      {
        path: "main.tease",
        source:
          "let ys0=[]\nlet xs=ys0\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=[{q:{}},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/1/True/{}",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet ys0=[]\nlet xs=ys0\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=[{},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/1/True/{q:{}}",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet ys0=[]\nlet xs=ys0\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=[{q:{}},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/2/False/{}",
    [
      {
        path: "main.tease",
        source:
          "let ys0=[]\nlet ys1=[]\nlet xs=ys0\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=[{},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/2/False/{q:{}}",
    [
      {
        path: "main.tease",
        source:
          "let ys0=[]\nlet ys1=[]\nlet xs=ys0\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=[{q:{}},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/2/True/{}",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet ys0=[]\nlet ys1=[]\nlet xs=ys0\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=[{},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/2/True/{q:{}}",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet ys0=[]\nlet ys1=[]\nlet xs=ys0\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=[{q:{}},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/4/False/{}",
    [
      {
        path: "main.tease",
        source:
          "let ys0=[]\nlet ys1=[]\nlet ys2=[]\nlet ys3=[]\nlet xs=ys0\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=ys2\nys2=ys3\nys3=[{},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/4/False/{q:{}}",
    [
      {
        path: "main.tease",
        source:
          "let ys0=[]\nlet ys1=[]\nlet ys2=[]\nlet ys3=[]\nlet xs=ys0\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=ys2\nys2=ys3\nys3=[{q:{}},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/4/True/{}",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet ys0=[]\nlet ys1=[]\nlet ys2=[]\nlet ys3=[]\nlet xs=ys0\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=ys2\nys2=ys3\nys3=[{},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/4/True/{q:{}}",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet ys0=[]\nlet ys1=[]\nlet ys2=[]\nlet ys3=[]\nlet xs=ys0\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=ys2\nys2=ys3\nys3=[{q:{}},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/8/False/{}",
    [
      {
        path: "main.tease",
        source:
          "let ys0=[]\nlet ys1=[]\nlet ys2=[]\nlet ys3=[]\nlet ys4=[]\nlet ys5=[]\nlet ys6=[]\nlet ys7=[]\nlet xs=ys0\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=ys2\nys2=ys3\nys3=ys4\nys4=ys5\nys5=ys6\nys6=ys7\nys7=[{},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/8/False/{q:{}}",
    [
      {
        path: "main.tease",
        source:
          "let ys0=[]\nlet ys1=[]\nlet ys2=[]\nlet ys3=[]\nlet ys4=[]\nlet ys5=[]\nlet ys6=[]\nlet ys7=[]\nlet xs=ys0\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=ys2\nys2=ys3\nys3=ys4\nys4=ys5\nys5=ys6\nys6=ys7\nys7=[{q:{}},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/8/True/{}",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet ys0=[]\nlet ys1=[]\nlet ys2=[]\nlet ys3=[]\nlet ys4=[]\nlet ys5=[]\nlet ys6=[]\nlet ys7=[]\nlet xs=ys0\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=ys2\nys2=ys3\nys3=ys4\nys4=ys5\nys5=ys6\nys6=ys7\nys7=[{},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "cycles/cyclic-chain/8/True/{q:{}}",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet ys0=[]\nlet ys1=[]\nlet ys2=[]\nlet ys3=[]\nlet ys4=[]\nlet ys5=[]\nlet ys6=[]\nlet ys7=[]\nlet xs=ys0\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nys0=ys1\nys1=ys2\nys2=ys3\nys3=ys4\nys4=ys5\nys5=ys6\nys6=ys7\nys7=[{q:{}},box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/2/1/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/2/1/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/2/2/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nalias.extra1=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/2/2/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nalias.extra1=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/2/4/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nalias.extra1=1\nalias.extra2=1\nalias.extra3=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/2/4/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nalias.extra1=1\nalias.extra2=1\nalias.extra3=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/3/1/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/3/1/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/3/2/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nalias.extra1=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/3/2/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nalias.extra1=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/3/4/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nalias.extra1=1\nalias.extra2=1\nalias.extra3=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/3/4/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nalias.extra1=1\nalias.extra2=1\nalias.extra3=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/4/1/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/4/1/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/4/2/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nalias.extra1=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/4/2/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nalias.extra1=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/4/4/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra0=1\nalias.extra1=1\nalias.extra2=1\nalias.extra3=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "root-cases/root-fold/4/4/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra0=1\nalias.extra1=1\nalias.extra2=1\nalias.extra3=1\nreturn 0 }\nlet result=read({noise:read({noise:read({noise:read({noise:read({noise:0,p:{}}),p:{}}),p:{}}),p:{}}),p:{}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-0",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nalias={extra:1}\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-1",
    [
      {
        path: "main.tease",
        source:
          'function read(x:object) { let alias=x.p\nalias.extra=1\nalias.extra="x"\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n',
      },
    ],
  ],
  [
    "decision-cases/decision-2",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nlet checked:integer=alias.extra\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-3",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nalias=hostValue\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-4",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nx.p.extra=hostValue\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-5",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nlet box={p:alias}\nbox.p={extra:1}\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-6",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nalias={extra:1}\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-7",
    [
      {
        path: "main.tease",
        source:
          'function read(x:object) { let alias=x.p.q\nalias.extra=1\nalias.extra="x"\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n',
      },
    ],
  ],
  [
    "decision-cases/decision-8",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nlet checked:integer=alias.extra\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-9",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nalias=hostValue\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-10",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nx.p.extra=hostValue\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "decision-cases/decision-11",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nlet box={p:alias}\nbox.p={extra:1}\nreturn 0 }\nlet result=read({noise:read({noise:0,p:{q:{}}}),p:{q:{}}})\nexit\n",
      },
    ],
  ],
  [
    "stops-cases/formed-boundary",
    [
      {
        path: "main.tease",
        source:
          'let root = {f0: hostValue}\nroot = {f0: hostOther}\nsay "BEFORE"\nrepeat root.f0 {say "ok"}\nsay "AFTER"\nexit\n',
      },
    ],
  ],
  [
    "extra/fresh-growth/8/False",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nreturn 0 }\nlet r0=read({noise:hostValue,p:shared})\nlet r1=read({noise:hostValue,p:shared})\nlet r2=read({noise:hostValue,p:shared})\nlet r3=read({noise:hostValue,p:shared})\nlet r4=read({noise:hostValue,p:shared})\nlet r5=read({noise:hostValue,p:shared})\nlet r6=read({noise:hostValue,p:shared})\nlet r7=read({noise:hostValue,p:shared})\nexit\n",
      },
    ],
  ],
  [
    "extra/fresh-growth/8/True",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nreturn 0 }\nlet r0=read({noise:hostValue,p:{}})\nlet r1=read({noise:hostValue,p:{}})\nlet r2=read({noise:hostValue,p:{}})\nlet r3=read({noise:hostValue,p:{}})\nlet r4=read({noise:hostValue,p:{}})\nlet r5=read({noise:hostValue,p:{}})\nlet r6=read({noise:hostValue,p:{}})\nlet r7=read({noise:hostValue,p:{}})\nexit\n",
      },
    ],
  ],
  [
    "extra/fresh-growth/16/False",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nreturn 0 }\nlet r0=read({noise:hostValue,p:shared})\nlet r1=read({noise:hostValue,p:shared})\nlet r2=read({noise:hostValue,p:shared})\nlet r3=read({noise:hostValue,p:shared})\nlet r4=read({noise:hostValue,p:shared})\nlet r5=read({noise:hostValue,p:shared})\nlet r6=read({noise:hostValue,p:shared})\nlet r7=read({noise:hostValue,p:shared})\nlet r8=read({noise:hostValue,p:shared})\nlet r9=read({noise:hostValue,p:shared})\nlet r10=read({noise:hostValue,p:shared})\nlet r11=read({noise:hostValue,p:shared})\nlet r12=read({noise:hostValue,p:shared})\nlet r13=read({noise:hostValue,p:shared})\nlet r14=read({noise:hostValue,p:shared})\nlet r15=read({noise:hostValue,p:shared})\nexit\n",
      },
    ],
  ],
  [
    "extra/fresh-growth/16/True",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nreturn 0 }\nlet r0=read({noise:hostValue,p:{}})\nlet r1=read({noise:hostValue,p:{}})\nlet r2=read({noise:hostValue,p:{}})\nlet r3=read({noise:hostValue,p:{}})\nlet r4=read({noise:hostValue,p:{}})\nlet r5=read({noise:hostValue,p:{}})\nlet r6=read({noise:hostValue,p:{}})\nlet r7=read({noise:hostValue,p:{}})\nlet r8=read({noise:hostValue,p:{}})\nlet r9=read({noise:hostValue,p:{}})\nlet r10=read({noise:hostValue,p:{}})\nlet r11=read({noise:hostValue,p:{}})\nlet r12=read({noise:hostValue,p:{}})\nlet r13=read({noise:hostValue,p:{}})\nlet r14=read({noise:hostValue,p:{}})\nlet r15=read({noise:hostValue,p:{}})\nexit\n",
      },
    ],
  ],
  [
    "extra/fresh-growth/32/False",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1,f16:1,f17:1,f18:1,f19:1,f20:1,f21:1,f22:1,f23:1,f24:1,f25:1,f26:1,f27:1,f28:1,f29:1,f30:1,f31:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nlet got16=x.p.f16\nlet got17=x.p.f17\nlet got18=x.p.f18\nlet got19=x.p.f19\nlet got20=x.p.f20\nlet got21=x.p.f21\nlet got22=x.p.f22\nlet got23=x.p.f23\nlet got24=x.p.f24\nlet got25=x.p.f25\nlet got26=x.p.f26\nlet got27=x.p.f27\nlet got28=x.p.f28\nlet got29=x.p.f29\nlet got30=x.p.f30\nlet got31=x.p.f31\nreturn 0 }\nlet r0=read({noise:hostValue,p:shared})\nlet r1=read({noise:hostValue,p:shared})\nlet r2=read({noise:hostValue,p:shared})\nlet r3=read({noise:hostValue,p:shared})\nlet r4=read({noise:hostValue,p:shared})\nlet r5=read({noise:hostValue,p:shared})\nlet r6=read({noise:hostValue,p:shared})\nlet r7=read({noise:hostValue,p:shared})\nlet r8=read({noise:hostValue,p:shared})\nlet r9=read({noise:hostValue,p:shared})\nlet r10=read({noise:hostValue,p:shared})\nlet r11=read({noise:hostValue,p:shared})\nlet r12=read({noise:hostValue,p:shared})\nlet r13=read({noise:hostValue,p:shared})\nlet r14=read({noise:hostValue,p:shared})\nlet r15=read({noise:hostValue,p:shared})\nlet r16=read({noise:hostValue,p:shared})\nlet r17=read({noise:hostValue,p:shared})\nlet r18=read({noise:hostValue,p:shared})\nlet r19=read({noise:hostValue,p:shared})\nlet r20=read({noise:hostValue,p:shared})\nlet r21=read({noise:hostValue,p:shared})\nlet r22=read({noise:hostValue,p:shared})\nlet r23=read({noise:hostValue,p:shared})\nlet r24=read({noise:hostValue,p:shared})\nlet r25=read({noise:hostValue,p:shared})\nlet r26=read({noise:hostValue,p:shared})\nlet r27=read({noise:hostValue,p:shared})\nlet r28=read({noise:hostValue,p:shared})\nlet r29=read({noise:hostValue,p:shared})\nlet r30=read({noise:hostValue,p:shared})\nlet r31=read({noise:hostValue,p:shared})\nexit\n",
      },
    ],
  ],
  [
    "extra/fresh-growth/32/True",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1,f16:1,f17:1,f18:1,f19:1,f20:1,f21:1,f22:1,f23:1,f24:1,f25:1,f26:1,f27:1,f28:1,f29:1,f30:1,f31:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nlet got16=x.p.f16\nlet got17=x.p.f17\nlet got18=x.p.f18\nlet got19=x.p.f19\nlet got20=x.p.f20\nlet got21=x.p.f21\nlet got22=x.p.f22\nlet got23=x.p.f23\nlet got24=x.p.f24\nlet got25=x.p.f25\nlet got26=x.p.f26\nlet got27=x.p.f27\nlet got28=x.p.f28\nlet got29=x.p.f29\nlet got30=x.p.f30\nlet got31=x.p.f31\nreturn 0 }\nlet r0=read({noise:hostValue,p:{}})\nlet r1=read({noise:hostValue,p:{}})\nlet r2=read({noise:hostValue,p:{}})\nlet r3=read({noise:hostValue,p:{}})\nlet r4=read({noise:hostValue,p:{}})\nlet r5=read({noise:hostValue,p:{}})\nlet r6=read({noise:hostValue,p:{}})\nlet r7=read({noise:hostValue,p:{}})\nlet r8=read({noise:hostValue,p:{}})\nlet r9=read({noise:hostValue,p:{}})\nlet r10=read({noise:hostValue,p:{}})\nlet r11=read({noise:hostValue,p:{}})\nlet r12=read({noise:hostValue,p:{}})\nlet r13=read({noise:hostValue,p:{}})\nlet r14=read({noise:hostValue,p:{}})\nlet r15=read({noise:hostValue,p:{}})\nlet r16=read({noise:hostValue,p:{}})\nlet r17=read({noise:hostValue,p:{}})\nlet r18=read({noise:hostValue,p:{}})\nlet r19=read({noise:hostValue,p:{}})\nlet r20=read({noise:hostValue,p:{}})\nlet r21=read({noise:hostValue,p:{}})\nlet r22=read({noise:hostValue,p:{}})\nlet r23=read({noise:hostValue,p:{}})\nlet r24=read({noise:hostValue,p:{}})\nlet r25=read({noise:hostValue,p:{}})\nlet r26=read({noise:hostValue,p:{}})\nlet r27=read({noise:hostValue,p:{}})\nlet r28=read({noise:hostValue,p:{}})\nlet r29=read({noise:hostValue,p:{}})\nlet r30=read({noise:hostValue,p:{}})\nlet r31=read({noise:hostValue,p:{}})\nexit\n",
      },
    ],
  ],
  [
    "extra/fresh-growth/64/False",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1,f16:1,f17:1,f18:1,f19:1,f20:1,f21:1,f22:1,f23:1,f24:1,f25:1,f26:1,f27:1,f28:1,f29:1,f30:1,f31:1,f32:1,f33:1,f34:1,f35:1,f36:1,f37:1,f38:1,f39:1,f40:1,f41:1,f42:1,f43:1,f44:1,f45:1,f46:1,f47:1,f48:1,f49:1,f50:1,f51:1,f52:1,f53:1,f54:1,f55:1,f56:1,f57:1,f58:1,f59:1,f60:1,f61:1,f62:1,f63:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nlet got16=x.p.f16\nlet got17=x.p.f17\nlet got18=x.p.f18\nlet got19=x.p.f19\nlet got20=x.p.f20\nlet got21=x.p.f21\nlet got22=x.p.f22\nlet got23=x.p.f23\nlet got24=x.p.f24\nlet got25=x.p.f25\nlet got26=x.p.f26\nlet got27=x.p.f27\nlet got28=x.p.f28\nlet got29=x.p.f29\nlet got30=x.p.f30\nlet got31=x.p.f31\nlet got32=x.p.f32\nlet got33=x.p.f33\nlet got34=x.p.f34\nlet got35=x.p.f35\nlet got36=x.p.f36\nlet got37=x.p.f37\nlet got38=x.p.f38\nlet got39=x.p.f39\nlet got40=x.p.f40\nlet got41=x.p.f41\nlet got42=x.p.f42\nlet got43=x.p.f43\nlet got44=x.p.f44\nlet got45=x.p.f45\nlet got46=x.p.f46\nlet got47=x.p.f47\nlet got48=x.p.f48\nlet got49=x.p.f49\nlet got50=x.p.f50\nlet got51=x.p.f51\nlet got52=x.p.f52\nlet got53=x.p.f53\nlet got54=x.p.f54\nlet got55=x.p.f55\nlet got56=x.p.f56\nlet got57=x.p.f57\nlet got58=x.p.f58\nlet got59=x.p.f59\nlet got60=x.p.f60\nlet got61=x.p.f61\nlet got62=x.p.f62\nlet got63=x.p.f63\nreturn 0 }\nlet r0=read({noise:hostValue,p:shared})\nlet r1=read({noise:hostValue,p:shared})\nlet r2=read({noise:hostValue,p:shared})\nlet r3=read({noise:hostValue,p:shared})\nlet r4=read({noise:hostValue,p:shared})\nlet r5=read({noise:hostValue,p:shared})\nlet r6=read({noise:hostValue,p:shared})\nlet r7=read({noise:hostValue,p:shared})\nlet r8=read({noise:hostValue,p:shared})\nlet r9=read({noise:hostValue,p:shared})\nlet r10=read({noise:hostValue,p:shared})\nlet r11=read({noise:hostValue,p:shared})\nlet r12=read({noise:hostValue,p:shared})\nlet r13=read({noise:hostValue,p:shared})\nlet r14=read({noise:hostValue,p:shared})\nlet r15=read({noise:hostValue,p:shared})\nlet r16=read({noise:hostValue,p:shared})\nlet r17=read({noise:hostValue,p:shared})\nlet r18=read({noise:hostValue,p:shared})\nlet r19=read({noise:hostValue,p:shared})\nlet r20=read({noise:hostValue,p:shared})\nlet r21=read({noise:hostValue,p:shared})\nlet r22=read({noise:hostValue,p:shared})\nlet r23=read({noise:hostValue,p:shared})\nlet r24=read({noise:hostValue,p:shared})\nlet r25=read({noise:hostValue,p:shared})\nlet r26=read({noise:hostValue,p:shared})\nlet r27=read({noise:hostValue,p:shared})\nlet r28=read({noise:hostValue,p:shared})\nlet r29=read({noise:hostValue,p:shared})\nlet r30=read({noise:hostValue,p:shared})\nlet r31=read({noise:hostValue,p:shared})\nlet r32=read({noise:hostValue,p:shared})\nlet r33=read({noise:hostValue,p:shared})\nlet r34=read({noise:hostValue,p:shared})\nlet r35=read({noise:hostValue,p:shared})\nlet r36=read({noise:hostValue,p:shared})\nlet r37=read({noise:hostValue,p:shared})\nlet r38=read({noise:hostValue,p:shared})\nlet r39=read({noise:hostValue,p:shared})\nlet r40=read({noise:hostValue,p:shared})\nlet r41=read({noise:hostValue,p:shared})\nlet r42=read({noise:hostValue,p:shared})\nlet r43=read({noise:hostValue,p:shared})\nlet r44=read({noise:hostValue,p:shared})\nlet r45=read({noise:hostValue,p:shared})\nlet r46=read({noise:hostValue,p:shared})\nlet r47=read({noise:hostValue,p:shared})\nlet r48=read({noise:hostValue,p:shared})\nlet r49=read({noise:hostValue,p:shared})\nlet r50=read({noise:hostValue,p:shared})\nlet r51=read({noise:hostValue,p:shared})\nlet r52=read({noise:hostValue,p:shared})\nlet r53=read({noise:hostValue,p:shared})\nlet r54=read({noise:hostValue,p:shared})\nlet r55=read({noise:hostValue,p:shared})\nlet r56=read({noise:hostValue,p:shared})\nlet r57=read({noise:hostValue,p:shared})\nlet r58=read({noise:hostValue,p:shared})\nlet r59=read({noise:hostValue,p:shared})\nlet r60=read({noise:hostValue,p:shared})\nlet r61=read({noise:hostValue,p:shared})\nlet r62=read({noise:hostValue,p:shared})\nlet r63=read({noise:hostValue,p:shared})\nexit\n",
      },
    ],
  ],
  [
    "extra/fresh-growth/64/True",
    [
      {
        path: "main.tease",
        source:
          "let shared={f0:1,f1:1,f2:1,f3:1,f4:1,f5:1,f6:1,f7:1,f8:1,f9:1,f10:1,f11:1,f12:1,f13:1,f14:1,f15:1,f16:1,f17:1,f18:1,f19:1,f20:1,f21:1,f22:1,f23:1,f24:1,f25:1,f26:1,f27:1,f28:1,f29:1,f30:1,f31:1,f32:1,f33:1,f34:1,f35:1,f36:1,f37:1,f38:1,f39:1,f40:1,f41:1,f42:1,f43:1,f44:1,f45:1,f46:1,f47:1,f48:1,f49:1,f50:1,f51:1,f52:1,f53:1,f54:1,f55:1,f56:1,f57:1,f58:1,f59:1,f60:1,f61:1,f62:1,f63:1}\nfunction read(x:object) {\nlet got0=x.p.f0\nlet got1=x.p.f1\nlet got2=x.p.f2\nlet got3=x.p.f3\nlet got4=x.p.f4\nlet got5=x.p.f5\nlet got6=x.p.f6\nlet got7=x.p.f7\nlet got8=x.p.f8\nlet got9=x.p.f9\nlet got10=x.p.f10\nlet got11=x.p.f11\nlet got12=x.p.f12\nlet got13=x.p.f13\nlet got14=x.p.f14\nlet got15=x.p.f15\nlet got16=x.p.f16\nlet got17=x.p.f17\nlet got18=x.p.f18\nlet got19=x.p.f19\nlet got20=x.p.f20\nlet got21=x.p.f21\nlet got22=x.p.f22\nlet got23=x.p.f23\nlet got24=x.p.f24\nlet got25=x.p.f25\nlet got26=x.p.f26\nlet got27=x.p.f27\nlet got28=x.p.f28\nlet got29=x.p.f29\nlet got30=x.p.f30\nlet got31=x.p.f31\nlet got32=x.p.f32\nlet got33=x.p.f33\nlet got34=x.p.f34\nlet got35=x.p.f35\nlet got36=x.p.f36\nlet got37=x.p.f37\nlet got38=x.p.f38\nlet got39=x.p.f39\nlet got40=x.p.f40\nlet got41=x.p.f41\nlet got42=x.p.f42\nlet got43=x.p.f43\nlet got44=x.p.f44\nlet got45=x.p.f45\nlet got46=x.p.f46\nlet got47=x.p.f47\nlet got48=x.p.f48\nlet got49=x.p.f49\nlet got50=x.p.f50\nlet got51=x.p.f51\nlet got52=x.p.f52\nlet got53=x.p.f53\nlet got54=x.p.f54\nlet got55=x.p.f55\nlet got56=x.p.f56\nlet got57=x.p.f57\nlet got58=x.p.f58\nlet got59=x.p.f59\nlet got60=x.p.f60\nlet got61=x.p.f61\nlet got62=x.p.f62\nlet got63=x.p.f63\nreturn 0 }\nlet r0=read({noise:hostValue,p:{}})\nlet r1=read({noise:hostValue,p:{}})\nlet r2=read({noise:hostValue,p:{}})\nlet r3=read({noise:hostValue,p:{}})\nlet r4=read({noise:hostValue,p:{}})\nlet r5=read({noise:hostValue,p:{}})\nlet r6=read({noise:hostValue,p:{}})\nlet r7=read({noise:hostValue,p:{}})\nlet r8=read({noise:hostValue,p:{}})\nlet r9=read({noise:hostValue,p:{}})\nlet r10=read({noise:hostValue,p:{}})\nlet r11=read({noise:hostValue,p:{}})\nlet r12=read({noise:hostValue,p:{}})\nlet r13=read({noise:hostValue,p:{}})\nlet r14=read({noise:hostValue,p:{}})\nlet r15=read({noise:hostValue,p:{}})\nlet r16=read({noise:hostValue,p:{}})\nlet r17=read({noise:hostValue,p:{}})\nlet r18=read({noise:hostValue,p:{}})\nlet r19=read({noise:hostValue,p:{}})\nlet r20=read({noise:hostValue,p:{}})\nlet r21=read({noise:hostValue,p:{}})\nlet r22=read({noise:hostValue,p:{}})\nlet r23=read({noise:hostValue,p:{}})\nlet r24=read({noise:hostValue,p:{}})\nlet r25=read({noise:hostValue,p:{}})\nlet r26=read({noise:hostValue,p:{}})\nlet r27=read({noise:hostValue,p:{}})\nlet r28=read({noise:hostValue,p:{}})\nlet r29=read({noise:hostValue,p:{}})\nlet r30=read({noise:hostValue,p:{}})\nlet r31=read({noise:hostValue,p:{}})\nlet r32=read({noise:hostValue,p:{}})\nlet r33=read({noise:hostValue,p:{}})\nlet r34=read({noise:hostValue,p:{}})\nlet r35=read({noise:hostValue,p:{}})\nlet r36=read({noise:hostValue,p:{}})\nlet r37=read({noise:hostValue,p:{}})\nlet r38=read({noise:hostValue,p:{}})\nlet r39=read({noise:hostValue,p:{}})\nlet r40=read({noise:hostValue,p:{}})\nlet r41=read({noise:hostValue,p:{}})\nlet r42=read({noise:hostValue,p:{}})\nlet r43=read({noise:hostValue,p:{}})\nlet r44=read({noise:hostValue,p:{}})\nlet r45=read({noise:hostValue,p:{}})\nlet r46=read({noise:hostValue,p:{}})\nlet r47=read({noise:hostValue,p:{}})\nlet r48=read({noise:hostValue,p:{}})\nlet r49=read({noise:hostValue,p:{}})\nlet r50=read({noise:hostValue,p:{}})\nlet r51=read({noise:hostValue,p:{}})\nlet r52=read({noise:hostValue,p:{}})\nlet r53=read({noise:hostValue,p:{}})\nlet r54=read({noise:hostValue,p:{}})\nlet r55=read({noise:hostValue,p:{}})\nlet r56=read({noise:hostValue,p:{}})\nlet r57=read({noise:hostValue,p:{}})\nlet r58=read({noise:hostValue,p:{}})\nlet r59=read({noise:hostValue,p:{}})\nlet r60=read({noise:hostValue,p:{}})\nlet r61=read({noise:hostValue,p:{}})\nlet r62=read({noise:hostValue,p:{}})\nlet r63=read({noise:hostValue,p:{}})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x/p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x/p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x/p.element.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x/p.element.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x/p.p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x/p.p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn x }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x.p/p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x.p }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x.p/p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn x.p }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x.p/p.element.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn x.p }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x.p/p.element.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn x.p }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x.p/p.p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn x.p }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/x.p/p.p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn x.p }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/[x]/p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn [x] }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/[x]/p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn [x] }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/[x]/p.element.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn [x] }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/[x]/p.element.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.element.q\nalias.extra=1\nreturn [x] }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/[x]/p.p.q/False",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{q:{}}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn [x] }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/cycle-fresh/[x]/p.p.q/True",
    [
      {
        path: "main.tease",
        source:
          "let xs=[{}]\nfunction read(x:object) { let alias=x.p.p.q\nalias.extra=1\nreturn [x] }\nlet box=read({noise:hostValue,p:xs.get(0, default:{})})\nxs=[box]\nlet other=read({noise:hostValue,p:xs.get(0, default:{})})\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection//[0]/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}[0]),p:{q:{}}})[0])\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection//[0]/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}[0])})[0])\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection//.first/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}.first),p:{q:{}}}).first)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection//.first/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}.first)}).first)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection//.random/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}.random),p:{q:{}}}).random)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection//.random/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}.random)}).random)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p/[0]/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}[0]),p:{q:{}}})[0])\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p/[0]/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}[0])})[0])\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p/.first/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}.first),p:{q:{}}}).first)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p/.first/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}.first)}).first)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p/.random/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}.random),p:{q:{}}}).random)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p/.random/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}.random)}).random)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p.q/[0]/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}[0]),p:{q:{}}})[0])\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p.q/[0]/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}[0])})[0])\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p.q/.first/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}.first),p:{q:{}}}).first)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p.q/.first/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}.first)}).first)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p.q/.random/False",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read(({noise:read({noise:0,p:{q:{}}}.random),p:{q:{}}}).random)\nexit\n",
      },
    ],
  ],
  [
    "extra/object-selection/p.q/.random/True",
    [
      {
        path: "main.tease",
        source:
          "function read(x:object) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read(({p:{q:{}},noise:read({noise:0,p:{q:{}}}.random)}).random)\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-1",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet b={f0:1.5}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-2",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-3",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet b={f0:1.5}\nlet a={f0:typed}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-4",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet b={f0:1.5}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-5",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet b={f0:typed}\nlet a={f0:1.5}\nlet c={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-6",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet c={f0:1.5}\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-7",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet c={f0:2.5}\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-8",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet c={f0:2}\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-9",
    [
      {
        path: "main.tease",
        source:
          'let typed:integer=17\nlet c={f0:"x"}\nlet b={f0:typed}\nlet a={f0:"y"}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n',
      },
    ],
  ],
  [
    "siblings/sibling-10",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet c={f0:[1]}\nlet b={f0:typed}\nlet a={f0:[2]}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-11",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet c={f0:{g:1}}\nlet b={f0:typed}\nlet a={f0:{g:2}}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-12",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet c={f0:1.5,f1:1}\nlet b={f0:typed}\nlet a={f0:1.5,f1:2}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-13",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet b={f0:typed,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1}\nlet a={f0:1.5,g1:1,g2:1,g3:1,g4:1,g5:1,g6:1,g7:1,g8:1,g9:1}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-14",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet b={f0:typed}\nlet a={f0:1.5}\nlet container=a\ncontainer=b\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-15",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet c={f0:2.5,p:2}\nlet b={f0:typed}\nlet a={f0:1.5,p:1}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nlet alias2=container\nlet got:integer=alias2.p\nlet alias3=container\nalias3.p=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-16",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet c={f0:2.5,p:2}\nlet d={f0:typed,p:typed}\nlet b={f0:typed}\nlet a={f0:1.5,p:1}\nlet container=a\ncontainer=d\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nlet alias2=container\nlet got:integer=alias2.p\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-17",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet a={f0:1.5,k:[{f0:typed}][0]}\nlet container=a.k\ncontainer=a\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-18",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet a={f0:1.5,k:[{f0:typed}].get(0, default: {f0:typed})}\nlet container=a.k\ncontainer=a\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-19",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet a={f0:1.5,k:{f0:typed}}\nlet container=a.k\ncontainer=a\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-20",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet b={f0:typed}\nlet a={f0:1.5,k:[b][0]}\nlet container=a\ncontainer=a.k\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nexit\n",
      },
    ],
  ],
  [
    "siblings/sibling-21",
    [
      {
        path: "main.tease",
        source:
          'let typed:integer=17\nlet c={f0:typed,p:1.5}\nlet b={f0:1.5,p:typed}\nlet a={f0:"x",p:2.5}\nlet container=a\ncontainer=b\ncontainer=c\nlet alias0=container\nalias0.extra0=typed\nlet alias1=container\nalias1.extra1=typed\nlet alias2=container\nlet got:integer=alias2.p\nexit\n',
      },
    ],
  ],
  [
    "untyped-cases/untyped-projection-missing-root-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x) { let alias=x\nalias.extra=1\nreturn 0 }\nlet result=read(([{},{noise:read(([{},{noise:0,p:{}}][0].p)),p:{}}][0].p))\nexit\n",
      },
    ],
  ],
  [
    "untyped-cases/untyped-gather-get-False",
    [
      {
        path: "main.tease",
        source:
          "function read(x) { let alias=x.p.q\nalias.extra=1\nreturn 0 }\nlet result=read({p:[{}, {q:{}}].get(0, default:{}),noise:read({noise:0,p:[{}, {q:{}}].get(0, default:{})})})\nexit\n",
      },
    ],
  ],
  [
    "untyped-cases/untyped-nested-same-callee-p-True-typed",
    [
      {
        path: "main.tease",
        source:
          "function read(x) { let alias=x.p\nalias.extra=1\nreturn 0 }\nlet result=read({p:{f0:1.5},noise:read({noise:0,p:{f0:1.5}})})\nexit\n",
      },
    ],
  ],
  [
    "untyped-cases/issue1323",
    [
      {
        path: "main.tease",
        source:
          "let typed:integer=17\nlet exact={f0:typed}\nlet fraction={f0:1.5}\nlet container=fraction\ncontainer=exact\nlet alias0=container\nalias0.extra0=typed\nexit\n",
      },
    ],
  ],
  [
    "untyped-cases/global-fold",
    [
      {
        path: "main.tease",
        source:
          "let box={noise:hostValue,p:{q:{}}}\nbox={noise:hostValue,p:{q:{}}}\nlet alias=box.p.q\nalias.extra=1\nexit\n",
      },
    ],
  ],
];
export const cases = rows;
export const checks = ["publication"];
export const globals = ["hostValue", "hostInit", "hostOther"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "sx-job submit … --commit base=<main dff711474> --commit head=<#1323's head> --in job.sh --in gen2cases.mjs --in pub2.mjs -- bash job.sh",
      "~/work/evidence/i1323-fold-siblings/dff711474d398ba442470ddf221efbf7c385a7b4/job.sh",
    ],
  ],
  sources: 198,
  sha256: "2b4205e83ba592fbae7fb82acf9a3872942bcbd05c7823bf9c2f06f05e727b21",
};
